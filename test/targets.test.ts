import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openExternalTarget } from '../src/targets.js';
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
