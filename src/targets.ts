import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fingerprint, scalarSchema, usageSchema, type CallContext, type DialogueMessage, type Target, type TargetSession, type World } from './contracts.js';
import { targetEntryPath } from './target-version.js';

function httpHeaders(target: Extract<Target, { kind: 'http' }>): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [header, variable] of Object.entries(target.headersEnv)) {
    const value = process.env[variable];
    if (!value) throw new Error(`Не задана переменная окружения ${variable} для заголовка ${header}. Задайте её перед запуском Pi.`);
    headers[header] = value;
  }
  return headers;
}

/** Static readiness only: never imports, starts, or sends a request to the target. Actual execution still handles drift/errors. */
export async function preflightTarget(target: Target): Promise<void> {
  if (target.kind === 'sandbox') return;
  if (target.promptFile) await readPrompt(target.promptFile);
  if (target.kind === 'http') { httpHeaders(target); return; }
  const entry = targetEntryPath(target);
  if (entry) {
    try {
      if (!(await stat(entry)).isFile()) throw new Error(`Вместо файла агента указана папка: ${entry}. Выберите файл адаптера.`);
      await access(entry, constants.R_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Не найден файл агента: ${entry}. Исправьте путь в подключении.`);
      if (code === 'EACCES' || code === 'EPERM') throw new Error(`Нет доступа к файлу агента: ${entry}. Проверьте права чтения.`);
      throw error;
    }
  }
  if (target.kind !== 'command') return;
  const cwd = target.cwd ?? process.cwd();
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Рабочая папка агента не является папкой: ${cwd}. Исправьте cwd в подключении.`);
    await access(cwd, constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Не найдена рабочая папка агента: ${cwd}. Исправьте cwd в подключении.`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Нет доступа к рабочей папке агента: ${cwd}. Проверьте права доступа.`);
    throw error;
  }
  const windows = process.platform === 'win32';
  const hasPath = target.command.includes('/') || windows && target.command.includes('\\');
  const path = windows ? Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : process.env.PATH;
  const directories = hasPath ? [''] : (path ?? (windows ? '' : '/usr/bin:/bin')).split(delimiter);
  const suffixes = windows && !extname(target.command) ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  let denied: string | undefined;
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = resolve(cwd, directory, target.command + suffix);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') denied ??= candidate;
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  if (denied) throw new Error(`Нет права запуска команды агента: ${denied}. Проверьте права или выберите другой исполняемый файл.`);
  throw new Error(`Не найдена команда агента: ${target.command}. Укажите полный путь к исполняемому файлу или добавьте его папку в PATH.`);
}

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
    measurementError: z.string().trim().min(1).max(2000).optional(),
    events: z.array(z.strictObject({ tool: z.string().min(1).max(200), args: z.unknown().optional(), result: z.unknown().optional() })).max(50).default([]),
    records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records').optional(),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    eventScope: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:/-]*\*?$/).max(200)).min(1).max(50).optional(),
    eventsComplete: z.boolean().optional(), resetConfirmed: z.boolean().optional(),
    version: z.string().trim().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(100).optional(), turn: z.number().int().positive().optional(),
    usage: usageSchema.optional(),
  }),
]);
export type ExternalReply = z.infer<typeof externalReplySchema>;
export interface ExternalTargetInput {
  target: Exclude<Target, { kind: 'sandbox' }>; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
  /** Called whenever the agent's harness reports records; the runner uses it to label reported state. */
  onRecords?: () => void;
  onReply?(reply: ExternalReply): void;
  prompt?: string;
}
type SessionInput<K extends ExternalTargetInput['target']['kind']> = Omit<ExternalTargetInput, 'target'> & { target: Extract<Target, { kind: K }> };

function applyReply(raw: unknown, state: World, ctx: CallContext, onRecords?: () => void, onReply?: ExternalTargetInput['onReply']): string {
  const parsed = externalReplySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`External agent reply does not match the contract: ${parsed.error.issues.map(i => i.path.join('.') || 'reply').join(', ')}`);
  onReply?.(parsed.data);
  if (typeof parsed.data === 'string') return parsed.data;
  const { reply, events, records, measurementError } = parsed.data;
  if (records) { state.records = structuredClone(records); onRecords?.(); }
  for (const event of events) {
    ctx.onTargetEvent?.({ type: 'tool_call', tool: event.tool, args: event.args });
    ctx.onTargetEvent?.({ type: 'tool_result', tool: event.tool, result: event.result, state });
  }
  if (measurementError) {
    if (reply.trim()) ctx.onTargetEvent?.({ type: 'assistant', text: reply });
    throw new Error(`Ошибка измерения внешнего агента: ${measurementError}`);
  }
  return reply;
}

async function httpSession(input: SessionInput<'http'>): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  const headers = httpHeaders(target);
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
          body: JSON.stringify({ sessionId, scenarioId, initialState, messages: history(), message, ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) }),
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
      return applyReply(body, state, ctx, input.onRecords, input.onReply);
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
      const body = await exchange({ type: 'respond', sessionId, scenarioId, initialState, messages: history(), message, ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) });
      return applyReply(body, state, ctx, input.onRecords, input.onReply);
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
    try { await exchange({ type: 'open', sessionId, scenarioId, initialState, prompt: input.prompt, promptHash: input.prompt === undefined ? undefined : fingerprint(input.prompt) }); }
    catch (error) { kill(); await session.close(); throw error; }
  }
  return session;
}

export async function readPrompt(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 96000) throw new Error('Промпт должен быть текстовым файлом до 96 КБ.');
  const prompt = await readFile(file, 'utf8');
  if (!prompt.trim() || prompt.includes('\0')) throw new Error('Пустой или бинарный prompt-файл.');
  return prompt;
}
export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession> {
  if (input.target.promptFile) {
    const prompt = await readPrompt(input.target.promptFile);
    const original = input.onReply;
    input = { ...input, prompt, onReply(reply) {
      if (typeof reply === 'string' || reply.promptHash !== fingerprint(prompt)) throw new Error('Адаптер не подтвердил применение выбранного промпта (promptHash).');
      original?.(reply);
    } };
  }
  switch (input.target.kind) {
    case 'http': return httpSession({ ...input, target: input.target });
    case 'module': return moduleSession({ ...input, target: input.target });
    case 'command': return commandSession({ ...input, target: input.target });
  }
}
