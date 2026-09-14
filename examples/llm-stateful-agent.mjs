/** External LLM agent with a fresh SQLite database and SDK conversation per session.
 * Uses the configured Pi credentials. No deterministic answer fallback. Node >=22.19.
 * AGENT_LAB_PROVIDER / AGENT_LAB_MODEL select the target model independently of the judge.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPiRuntime } from '../dist/pi.js';
import { emptyUsage, fingerprint, settingsSchema, worldSchema } from '../dist/contracts.js';
import { sandbox } from '../dist/sandbox.js';

export async function createSession({ initialState, sessionId, prompt, promptHash }, runtime) {
  const state = worldSchema.parse(initialState);
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('A session ID is required');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 96000 || fingerprint(prompt) !== promptHash) throw new Error('A verified promptFile is required');
  const settings = settingsSchema.parse({ provider: process.env.AGENT_LAB_PROVIDER ?? 'openrouter',
    model: process.env.AGENT_LAB_MODEL ?? 'anthropic/claude-haiku-4.5', timeoutMs: 60000 });
  const code = await Promise.all(['llm-stateful-agent.mjs', '../dist/pi.js', '../dist/prompts.js', '../dist/sandbox.js', '../dist/contracts.js', '../package.json']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  const version = `sqlite-llm-${fingerprint({ code, provider: settings.provider, model: settings.model }).slice(0, 40)}`;
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-llm-'));
  const database = new DatabaseSync(join(directory, 'state.sqlite'));
  let session;
  let closed = false;
  let turn = 0;
  let totalCalls = 0;
  let usage = emptyUsage();
  let events = [];
  const controller = new AbortController();
  const snapshot = () => Object.fromEntries(database.prepare('SELECT id, fields FROM records ORDER BY id').all().map(row => [row.id, JSON.parse(row.fields)]));
  const save = () => {
    for (const [id, fields] of Object.entries(state.records)) database.prepare('INSERT OR REPLACE INTO records VALUES (?, ?)').run(id, JSON.stringify(fields));
  };
  const close = async () => {
    if (closed) return;
    closed = true; controller.abort();
    try { await session?.close(); }
    finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  };
  try {
    database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, fields TEXT NOT NULL)');
    database.exec('BEGIN'); save(); database.exec('COMMIT');
    if (fingerprint(snapshot()) !== fingerprint(state.records)) throw new Error('Reset verification failed');
    const ctx = { signal: controller.signal, timeoutMs: settings.timeoutMs,
      beforeCall() { controller.signal.throwIfAborted(); if (usage.calls >= 12 || totalCalls >= 48) throw new Error('Target model call budget exhausted'); usage.calls++; totalCalls++; },
      addUsage(value) {
        usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens;
        usage.costUsd = value.costUsd === null || usage.costUsd === null ? null : usage.costUsd + value.costUsd;
      },
      onTargetEvent(event) { events.push(structuredClone(event)); },
    };
    // Reuse the validated tool semantics; every tool reads SQLite and commits before returning to the model.
    const tools = sandbox(state, [], ctx.onTargetEvent, ctx).filter(t => t.name !== 'search_materials').map(tool => ({ ...tool,
      async execute(args) {
        database.exec('BEGIN IMMEDIATE');
        try { state.records = snapshot(); const result = await tool.execute(args); save(); database.exec('COMMIT'); return result; }
        catch (error) { database.exec('ROLLBACK'); state.records = snapshot(); throw error; }
      },
    }));
    runtime ??= await createPiRuntime(settings);
    session = await runtime.openTarget({ name: 'SQLite LLM agent', instructions: prompt, tools: tools.map(t => t.name) }, [], tools, ctx);
    return {
      async respond(message) {
        if (closed) throw new Error('Session closed');
        if (typeof message !== 'string' || !message.trim() || message.length > 20000) throw new Error('Invalid message');
        usage = emptyUsage(); events = [];
        const reply = await session.respond(message);
        const pairs = [];
        let pending;
        for (const event of events) {
          if (event.type === 'tool_call') { if (pending) throw new Error('Unpaired tool call'); pending = event; }
          if (event.type === 'tool_result') {
            if (!pending || pending.tool !== event.tool) throw new Error('Unpaired tool result');
            pairs.push({ tool: event.tool, args: pending.args, result: event.result }); pending = undefined;
          }
        }
        if (pending) throw new Error('Incomplete tool trace');
        return { reply, events: pairs, records: snapshot(), eventsComplete: true, eventScope: tools.map(t => t.name),
          resetConfirmed: true, version, sessionId, turn: ++turn, promptHash, usage: structuredClone(usage) };
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
