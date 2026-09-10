import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
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
      if (!response.ok) throw new Error(`External agent responded ${response.status}`);
      const text = await response.text();
      if (text.length > 200000) throw new Error('Ответ внешнего агента длиннее 200 000 символов.');
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error('Ответ внешнего агента не является корректным JSON.'); }
      return applyReply(body, state, ctx, input.onRecords);
    },
    async close() { closed = true; },
  };
}

async function moduleSession(input: SessionInput<'module'>): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  let mod: Record<string, unknown>;
  try { mod = await import(pathToFileURL(target.path).href) as Record<string, unknown>; }
  catch (error) { throw new Error(`Cannot load module adapter ${target.path}: ${error instanceof Error ? error.message : String(error)}`); }
  const factory = mod[target.exportName];
  if (typeof factory !== 'function') throw new Error(`Module adapter ${target.path} has no function export named ${target.exportName}`);
  const created: unknown = await factory({ sessionId, scenarioId, initialState: structuredClone(state) });
  if (!created || typeof created !== 'object' || typeof (created as { respond?: unknown }).respond !== 'function') {
    throw new Error('Адаптер-модуль должен вернуть сессию с методом respond(message, messages).');
  }
  const session = created as { respond(message: string, messages: DialogueMessage[]): unknown; close?(): unknown };
  let closed = false;
  return {
    async respond(message) {
      if (closed) throw new Error('Сессия с внешним агентом закрыта.');
      ctx.signal.throwIfAborted();
      const raw = await session.respond(message, history());
      ctx.signal.throwIfAborted();
      return applyReply(raw, state, ctx, input.onRecords);
    },
    async close() { if (closed) return; closed = true; await session.close?.(); },
  };
}

/*
 * Command adapter: one process per dialogue, JSON lines both ways.
 *   stdin  → {"type":"respond", sessionId, scenarioId, initialState, messages, message}
 *   stdout ← "reply"  |  {"reply", "events"?, "records"?}
 *   stdin  → {"type":"close", sessionId}, then stdin ends
 * A reply that misses the deadline kills the process; an early exit surfaces the exit code and the stderr tail.
 */
async function commandSession(input: SessionInput<'command'>): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  const child = spawn(target.command, target.args, { cwd: target.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
  child.stdin.on('error', () => {});
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const takePending = () => { const waiting = pending; pending = undefined; return waiting; };
  const exited = () => new Error(`External agent process exited${exit ? ` with code ${exit.code ?? exit.signal}` : ''}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => takePending()?.resolve(line));
  child.on('close', (code, signal) => { exit = { code, signal }; takePending()?.reject(exited()); });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', error => reject(new Error(`Cannot start external agent ${target.command}: ${error.message}`)));
  });
  const initialState = structuredClone(state);
  const send = (payload: unknown) => new Promise<void>((resolve, reject) => { child.stdin.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve()); });
  let closed = false;
  return {
    async respond(message) {
      if (closed) throw new Error('Сессия с внешним агентом закрыта.');
      ctx.signal.throwIfAborted();
      if (exit) throw exited();
      const reply = new Promise<string>((resolve, reject) => { pending = { resolve, reject }; });
      const timer = setTimeout(() => { takePending()?.reject(new Error(`External agent request exceeded ${target.timeoutMs} ms`)); child.kill('SIGKILL'); }, target.timeoutMs);
      const onAbort = () => { takePending()?.reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error(String(ctx.signal.reason))); child.kill('SIGKILL'); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await send({ type: 'respond', sessionId, scenarioId, initialState, messages: history(), message }).catch(error => { throw exit ? exited() : new Error(`Cannot write to external agent: ${error instanceof Error ? error.message : String(error)}`); });
        const line = await reply;
        let body: unknown;
        try { body = JSON.parse(line); } catch { throw new Error('Ответ внешнего агента не является корректным JSON.'); }
        return applyReply(body, state, ctx, input.onRecords);
      } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!exit) {
        await send({ type: 'close', sessionId }).catch(() => {});
        child.stdin.end();
        await new Promise<void>(resolve => {
          if (exit) { resolve(); return; }
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
          child.once('close', () => { clearTimeout(timer); resolve(); });
        });
      }
      lines.close();
    },
  };
}

export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession> {
  switch (input.target.kind) {
    case 'http': return httpSession({ ...input, target: input.target });
    case 'module': return moduleSession({ ...input, target: input.target });
    case 'command': return commandSession({ ...input, target: input.target });
  }
}
