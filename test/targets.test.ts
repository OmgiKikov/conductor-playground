import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openExternalTarget, preflightTarget } from '../src/targets.js';
import { type CallContext, type TraceEvent, type World } from '../src/contracts.js';

function context(signal = new AbortController().signal) {
  const events: Omit<TraceEvent, 'seq'>[] = [];
  const ctx: CallContext = { signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onTargetEvent: e => events.push(structuredClone(e)) };
  return { ctx, events };
}
const world = (): World => ({ records: { A101: { time: '09:00', owner: 'Sample' } }, writableFields: ['time'], transientFailures: 0 });
type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => unknown;

async function server(handler: Handler) {
  const requests: Record<string, unknown>[] = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ ...body, headers: req.headers });
      const out = handler(body, req, res);
      if (out !== undefined) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); }
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/agent`, requests, close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

test('preflight checks files, cwd, PATH and header variables without executing an agent or making a request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const bin = join(directory, 'bin'); await mkdir(bin);
  const marker = join(directory, 'was-executed');
  const adapter = join(directory, 'adapter.mjs');
  await writeFile(adapter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  await preflightTarget({ kind: 'sandbox' });
  await preflightTarget({ kind: 'module', path: adapter, exportName: 'createSession' });
  await preflightTarget({ kind: 'command', command: process.execPath, args: ['adapter.mjs'], cwd: directory, timeoutMs: 1000 });
  await assert.rejects(preflightTarget({ kind: 'module', path: join(directory, 'missing.mjs'), exportName: 'createSession' }), /Не найден файл агента/);
  await assert.rejects(preflightTarget({ kind: 'module', path: directory, exportName: 'createSession' }), /Вместо файла агента указана папка/);
  await assert.rejects(preflightTarget({ kind: 'command', command: process.execPath, args: [], cwd: adapter, timeoutMs: 1000 }), /не является папкой/);
  await assert.rejects(preflightTarget({ kind: 'command', command: process.execPath, args: [], cwd: join(directory, 'missing'), timeoutMs: 1000 }), /Не найдена рабочая папка/);
  const command = join(bin, 'agent-lab-preflight-fixture');
  await writeFile(command, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = bin;
  await preflightTarget({ kind: 'command', command: 'agent-lab-preflight-fixture', args: [], timeoutMs: 1000 });
  await preflightTarget({ kind: 'command', command: './bin/agent-lab-preflight-fixture', args: [], cwd: directory, timeoutMs: 1000 });
  await assert.rejects(preflightTarget({ kind: 'command', command: 'missing-agent', args: [], timeoutMs: 1000 }), /Не найдена команда агента.*missing-agent/);
  if (process.platform !== 'win32') {
    await chmod(command, 0o644);
    await assert.rejects(preflightTarget({ kind: 'command', command, args: [], timeoutMs: 1000 }), /Нет права запуска команды/);
  }
  await assert.rejects(access(marker), /ENOENT/, 'module loading and command execution must not happen during preparation');
  const api = await server(() => 'must not run'); t.after(api.close);
  const variable = 'AGENT_LAB_PREFLIGHT_TEST_TOKEN';
  const previousToken = process.env[variable];
  t.after(() => { if (previousToken === undefined) delete process.env[variable]; else process.env[variable] = previousToken; });
  const target = { kind: 'http' as const, url: api.url, headersEnv: { Authorization: variable }, timeoutMs: 1000 };
  delete process.env[variable];
  await assert.rejects(preflightTarget(target), /AGENT_LAB_PREFLIGHT_TEST_TOKEN/);
  process.env[variable] = 'private fixture value';
  await preflightTarget(target);
  assert.equal(api.requests.length, 0);
});

test('http adapter sends the contract body with env headers and applies reported events and records', async t => {
  const api = await server(() => ({
    reply: 'Moved A101 to 14:00.',
    events: [{ tool: 'update_record', args: { recordId: 'A101', changes: { time: '14:00' } }, result: { ok: true, recordId: 'A101' } }],
    records: { A101: { time: '14:00', owner: 'Sample' } },
  }));
  t.after(api.close);
  process.env.AGENT_LAB_TEST_TOKEN = 'secret-token';
  t.after(() => { delete process.env.AGENT_LAB_TEST_TOKEN; });
  const state = world();
  const { ctx, events } = context();
  const history = [{ role: 'user' as const, content: 'earlier' }];
  const session = await openExternalTarget({
    target: { kind: 'http', url: api.url, headersEnv: { Authorization: 'AGENT_LAB_TEST_TOKEN' }, timeoutMs: 5000 },
    sessionId: 'trial-1', scenarioId: 'card-1', state, history: () => history, ctx,
  });
  const reply = await session.respond('Please move A101 to 14:00');
  assert.equal(reply, 'Moved A101 to 14:00.');
  const request = api.requests[0]!;
  assert.equal(request.sessionId, 'trial-1');
  assert.equal(request.scenarioId, 'card-1');
  assert.equal(request.message, 'Please move A101 to 14:00');
  assert.deepEqual(request.messages, history);
  assert.deepEqual((request.initialState as World).records, world().records);
  assert.equal((request.headers as Record<string, string>).authorization, 'secret-token');
  assert.equal(state.records.A101!.time, '14:00');
  assert.deepEqual(events.map(e => e.type), ['tool_call', 'tool_result']);
  assert.equal(events[0]!.tool, 'update_record');
  assert.deepEqual((events[1]!.state as World).records.A101, { time: '14:00', owner: 'Sample' });
  assert.equal(JSON.stringify(state).includes('secret-token'), false);
  await session.close();
});

test('http adapter rejects non-2xx, malformed and oversized replies, and accepts a plain string reply', async t => {
  let mode: 'error' | 'garbage' | 'string' = 'error';
  const api = await server((_body, _req, res) => {
    if (mode === 'error') { res.statusCode = 500; res.end('boom'); return; }
    if (mode === 'garbage') return { nope: 1 };
    return 'just text';
  });
  t.after(api.close);
  const state = world();
  const { ctx, events } = context();
  const session = await openExternalTarget({ target: { kind: 'http', url: api.url, headersEnv: {}, timeoutMs: 5000 }, sessionId: 't', scenarioId: 's', state, history: () => [], ctx });
  await assert.rejects(session.respond('hi'), /500/);
  mode = 'garbage';
  await assert.rejects(session.respond('hi'), /reply|schema|invalid/i);
  mode = 'string';
  assert.equal(await session.respond('hi'), 'just text');
  assert.equal(state.records.A101!.time, '09:00');
  assert.equal(events.length, 0);
});

test('http adapter enforces its own deadline and the trial abort signal', async t => {
  const api = await server(() => undefined);
  t.after(api.close);
  const slow = { kind: 'http' as const, url: api.url, headersEnv: {}, timeoutMs: 1000 };
  const state = world();
  const started = performance.now();
  const timed = await openExternalTarget({ target: slow, sessionId: 't', scenarioId: 's', state, history: () => [], ctx: context().ctx });
  await assert.rejects(timed.respond('hi'), /exceeded|timeout/i);
  assert.ok(performance.now() - started < 4000);
  const controller = new AbortController();
  const aborted = await openExternalTarget({ target: { ...slow, timeoutMs: 30000 }, sessionId: 't', scenarioId: 's', state, history: () => [], ctx: context(controller.signal).ctx });
  const pending = aborted.respond('hi');
  setTimeout(() => controller.abort(new Error('stop now')), 50);
  await assert.rejects(pending, /stop now/);
});

test('http adapter refuses to start when a header environment variable is missing', async t => {
  const api = await server(() => 'unreachable');
  t.after(api.close);
  delete process.env.AGENT_LAB_MISSING_TOKEN;
  await assert.rejects(
    openExternalTarget({ target: { kind: 'http', url: api.url, headersEnv: { Authorization: 'AGENT_LAB_MISSING_TOKEN' }, timeoutMs: 1000 }, sessionId: 't', scenarioId: 's', state: world(), history: () => [], ctx: context().ctx }),
    /AGENT_LAB_MISSING_TOKEN/,
  );
  assert.equal(api.requests.length, 0);
});

test('module adapter loads the reference example, applies its records and closes', async () => {
  const state = world();
  const { ctx, events } = context();
  const session = await openExternalTarget({
    target: { kind: 'module', path: resolve('examples/echo-agent.mjs'), exportName: 'createSession' },
    sessionId: 't', scenarioId: 's', state, history: () => [], ctx,
  });
  assert.equal(await session.respond('Move A101 to 14:00 please'), 'Moved A101 to 14:00.');
  assert.equal(state.records.A101!.time, '14:00');
  assert.deepEqual(events.filter(e => e.type === 'tool_call').map(e => e.tool), ['lookup_record', 'update_record']);
  assert.equal(await session.respond('thanks'), 'You said: thanks');
  await session.close();
});

test('module adapter rejects a missing export and normalizes plain string replies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-targets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plain = join(directory, 'plain.mjs');
  await writeFile(plain, 'export function createSession() { return { async respond(message) { return `echo:${message}`; } }; }\n');
  const state = world();
  const { ctx, events } = context();
  await assert.rejects(
    openExternalTarget({ target: { kind: 'module', path: plain, exportName: 'missingFactory' }, sessionId: 't', scenarioId: 's', state, history: () => [], ctx }),
    /missingFactory/,
  );
  const session = await openExternalTarget({ target: { kind: 'module', path: plain, exportName: 'createSession' }, sessionId: 't', scenarioId: 's', state, history: () => [], ctx });
  assert.equal(await session.respond('hi'), 'echo:hi');
  assert.equal(state.records.A101!.time, '09:00');
  assert.equal(events.length, 0);
  await session.close();
});

const stdioFixture = resolve('test/fixtures/stdio-agent.mjs');

test('command adapter speaks JSON lines to a local process, applies reported records and closes it', async () => {
  const state = world();
  const { ctx, events } = context();
  const session = await openExternalTarget({
    target: { kind: 'command', command: process.execPath, args: [stdioFixture], timeoutMs: 5000 },
    sessionId: 'trial-cmd', scenarioId: 'card-1', state, history: () => [{ role: 'user', content: 'earlier' }], ctx,
  });
  assert.equal(await session.respond('Please move A101 to 14:00'), 'Moved A101 to 14:00.');
  assert.equal(state.records.A101!.time, '14:00');
  assert.deepEqual(events.map(e => e.type), ['tool_call', 'tool_result']);
  assert.equal(await session.respond('thanks'), 'You said: thanks (1 earlier)');
  await session.close();
  await session.close();
});

test('command adapter reports a crashed process with its stderr and kills a hanging one at the deadline', async () => {
  const crashed = await openExternalTarget({ target: { kind: 'command', command: process.execPath, args: [stdioFixture, 'crash'], timeoutMs: 5000 }, sessionId: 't', scenarioId: 's', state: world(), history: () => [], ctx: context().ctx });
  await assert.rejects(crashed.respond('hi'), /exited.*3.*crashed on purpose/s);
  const started = performance.now();
  const hanging = await openExternalTarget({ target: { kind: 'command', command: process.execPath, args: [stdioFixture, 'hang'], timeoutMs: 1000 }, sessionId: 't', scenarioId: 's', state: world(), history: () => [], ctx: context().ctx });
  await assert.rejects(hanging.respond('hi'), /exceeded/);
  assert.ok(performance.now() - started < 4000);
  await hanging.close();
  await assert.rejects(hanging.respond('again'), /закрыта/);
});

test('command adapter refuses a missing executable before any dialogue', async () => {
  await assert.rejects(
    openExternalTarget({ target: { kind: 'command', command: '/definitely/missing/agent', args: [], timeoutMs: 1000 }, sessionId: 't', scenarioId: 's', state: world(), history: () => [], ctx: context().ctx }),
    /missing\/agent/,
  );
});

test('the reference Python adapter answers through the command target when python3 is available', async t => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('python3', ['--version']).status !== 0) { t.skip('python3 not installed'); return; }
  const state = world();
  const session = await openExternalTarget({
    target: { kind: 'command', command: 'python3', args: [resolve('examples/echo-agent.py')], timeoutMs: 10000 },
    sessionId: 't', scenarioId: 's', state, history: () => [], ctx: context().ctx,
  });
  assert.equal(await session.respond('Move A101 to 15:45'), 'Moved A101 to 15:45.');
  assert.equal(state.records.A101!.time, '15:45');
  await session.close();
});

test('module sessions isolate state, bound initialization and synchronous hangs, and cancel promptly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent.mjs');
  const open = (signal = new AbortController().signal) => openExternalTarget({ target: { kind: 'module', path, exportName: 'createSession', timeoutMs: 1000 }, sessionId: 't', scenarioId: 's', state: world(), history: () => [], ctx: context(signal).ctx });
  await writeFile(path, 'let n = 0; export function createSession() { return { respond() { console.log("debug"); return String(++n); } }; }');
  for (let i = 0; i < 2; i++) { const session = await open(); assert.equal(await session.respond('hi'), '1'); await session.close(); }
  await writeFile(path, 'export function createSession() { while (true) {} }');
  await assert.rejects(open(), /exceeded/);
  await writeFile(path, 'export function createSession() { return { respond() { while (true) {} } }; }');
  const session = await open();
  await assert.rejects(session.respond('hi'), /exceeded/); await session.close();
  const controller = new AbortController();
  const cancelled = await open(controller.signal);
  const pending = cancelled.respond('hi');
  controller.abort(new Error('operator stopped'));
  await assert.rejects(pending, /operator stopped/); await cancelled.close();
  await writeFile(path, 'export function createSession() { return { respond() { return "ok"; }, close() { while (true) {} } }; }');
  const closing = await open();
  const start = performance.now(); await closing.close(); assert.ok(performance.now() - start < 4000);
});
