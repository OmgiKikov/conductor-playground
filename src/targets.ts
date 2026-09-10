import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { scalarSchema, type CallContext, type DialogueMessage, type Target, type TargetSession, type World } from './contracts.js';

/*
 * External targets: the agent under test lives outside this process.
 *
 *   runner ──respond(message)──► adapter ──JSON {sessionId, scenarioId, initialState, messages, message}──► http endpoint | module
 *                                   ▲                                                                              │
 *      trace ◄── tool_call / tool_result events ◄── reply, events?, records? ◄────────────────────────────────────┘
 *
 * `records` returned by the agent's harness replace the trial world before grading. They are reported state,
 * not state observed by trusted code; the runner labels it as such. Secrets come from the environment at request
 * time and never enter the persisted record.
 */
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
export const externalReplySchema = z.union([
  z.string().max(20000),
  z.strictObject({
    reply: z.string().max(20000),
    events: z.array(z.strictObject({ tool: z.string().min(1).max(200), args: z.unknown().optional(), result: z.unknown().optional() })).max(50).default([]),
    records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records').optional(),
  }),
]);
export type ExternalReply = z.infer<typeof externalReplySchema>;
export interface ExternalTargetInput {
  target: Exclude<Target, { kind: 'sandbox' }>; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
  /** Called whenever the agent's harness reports records; the runner uses it to label reported state. */
  onRecords?: () => void;
}
type SessionInput<K extends ExternalTargetInput['target']['kind']> = Omit<ExternalTargetInput, 'target'> & { target: Extract<Target, { kind: K }> };

function applyReply(raw: unknown, state: World, ctx: CallContext, onRecords?: () => void): string {
  const parsed = externalReplySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`External agent reply does not match the contract: ${parsed.error.issues.map(i => i.path.join('.') || 'reply').join(', ')}`);
  if (typeof parsed.data === 'string') return parsed.data;
  const { reply, events, records } = parsed.data;
  if (records) { state.records = structuredClone(records); onRecords?.(); }
  for (const event of events) {
    ctx.onTargetEvent?.({ type: 'tool_call', tool: event.tool, args: event.args });
    ctx.onTargetEvent?.({ type: 'tool_result', tool: event.tool, result: event.result, state });
  }
  return reply;
}

async function httpSession(input: SessionInput<'http'>): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [header, variable] of Object.entries(target.headersEnv)) {
    const value = process.env[variable];
    if (!value) throw new Error(`Environment variable ${variable} for header ${header} is not set`);
    headers[header] = value;
  }
  const initialState = structuredClone(state);
  let closed = false;
  return {
    async respond(message) {
      if (closed) throw new Error('Сессия с внешним агентом закрыта.');
      ctx.signal.throwIfAborted();
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(target.timeoutMs)]);
      let response: Response;
      try {
        response = await fetch(target.url, {
          method: 'POST', headers, signal,
          body: JSON.stringify({ sessionId, scenarioId, initialState, messages: history(), message }),
        });
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (signal.aborted) throw new Error(`External agent request exceeded ${target.timeoutMs} ms`);
        throw new Error(`External agent request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`External agent responded ${response.status}`); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 200000) { await reader.cancel(); throw new Error('Ответ внешнего агента длиннее 200 000 байт.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error('Ответ внешнего агента не является корректным JSON.'); }
      return applyReply(body, state, ctx, input.onRecords);
    },
    async close() { closed = true; },
  };
}

async function moduleSession(input: SessionInput<'module'>): Promise<TargetSession> {
  return commandSession({ ...input, initialize: true, target: {
    kind: 'command', command: process.execPath,
    args: [fileURLToPath(new URL('./module-worker.mjs', import.meta.url)), input.target.path, input.target.exportName],
    timeoutMs: input.target.timeoutMs ?? input.ctx.timeoutMs,
  } });
}

/*
 * Command adapter: one process per dialogue, JSON lines both ways.
 *   stdin  → {"type":"respond", sessionId, scenarioId, initialState, messages, message}
 *   stdout ← "reply"  |  {"reply", "events"?, "records"?}
 *   stdin  → {"type":"close", sessionId}, then stdin ends
 * A reply that misses the deadline kills the process; an early exit surfaces the exit code and the stderr tail.
 */
async function commandSession(input: SessionInput<'command'> & { initialize?: boolean }): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  ctx.signal.throwIfAborted();
  const grouped = process.platform !== 'win32';
  const child = spawn(target.command, target.args, { cwd: target.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: grouped });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
  child.stdin.on('error', () => {});
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const takePending = () => { const waiting = pending; pending = undefined; return waiting; };
  const exited = () => new Error(`External agent process exited${exit ? ` with code ${exit.code ?? exit.signal}` : ''}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  let bytes = 0;
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 200000) { takePending()?.reject(new Error('Ответ внешнего агента превышает 200 000 байт.')); kill(); }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => takePending()?.resolve(line));
  child.on('close', (code, signal) => { exit = { code, signal }; takePending()?.reject(exited()); });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', error => reject(new Error(`Cannot start external agent ${target.command}: ${error.message}`)));
  });
  const initialState = structuredClone(state);
  let closed = false;
  const exchange = async (payload: unknown) => {
    if (closed) throw new Error('Сессия с внешним агентом закрыта.');
    ctx.signal.throwIfAborted();
    if (exit) throw exited();
    if (pending) throw new Error('У сессии уже есть активный запрос.');
    bytes = 0;
    const reply = new Promise<string>((resolve, reject) => { pending = { resolve, reject }; });
    const timer = setTimeout(() => { takePending()?.reject(new Error(`External agent request exceeded ${target.timeoutMs} ms`)); kill(); }, target.timeoutMs);
    const onAbort = () => { takePending()?.reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Диалог остановлен.')); kill(); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const sent = new Promise<void>((resolve, reject) => { child.stdin.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve()); });
      const [, line] = await Promise.all([sent, reply]);
      ctx.signal.throwIfAborted();
      try { return JSON.parse(line) as unknown; }
      catch { throw new Error('Ответ внешнего агента не является корректным JSON.'); }
    } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); }
  };
  const session: TargetSession = {
    async respond(message) {
      const body = await exchange({ type: 'respond', sessionId, scenarioId, initialState, messages: history(), message });
      return applyReply(body, state, ctx, input.onRecords);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!exit) {
        if (ctx.signal.aborted) kill();
        else child.stdin.end(`${JSON.stringify({ type: 'close', sessionId })}\n`);
        await new Promise<void>(resolve => {
          if (exit) { resolve(); return; }
          const timer = setTimeout(() => { kill(); resolve(); }, 2000);
          child.once('close', () => { clearTimeout(timer); resolve(); });
        });
      }
      lines.close();
    },
  };
  if (input.initialize) {
    try { await exchange({ type: 'open', sessionId, scenarioId, initialState }); }
    catch (error) { kill(); await session.close(); throw error; }
  }
  return session;
}

export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession> {
  switch (input.target.kind) {
    case 'http': return httpSession({ ...input, target: input.target });
    case 'module': return moduleSession({ ...input, target: input.target });
    case 'command': return commandSession({ ...input, target: input.target });
  }
}
