import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGigaConfig, requestOptions } from '../src/giga-transport.js';
import { createGigaProvider } from '../src/giga-provider.js';
import type { GigaModel } from '../src/giga-protocol.js';

const catalogBody = JSON.stringify({ data: [
  { id: 'GigaChat-3-Pro', type: 'chat' }, { id: 'glm-5.2', type: 'chat' }, { id: 'Embeddings', type: 'embeddings' },
] });

const answerBody = JSON.stringify({
  model: 'GigaChat-3-Pro:3.1.0', created_at: 1789463335, finish_reason: 'stop',
  messages: [{ role: 'assistant', content: [{ text: 'Hello' }] }],
  usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
});

async function providerWith(replies: { status: number; text: string }[]) {
  const sent: { path: string; body?: unknown }[] = [];
  const provider = await createGigaProvider({}, async (path, body) => {
    sent.push({ path, body });
    return replies[sent.length - 1] ?? { status: 500, text: 'no reply configured' };
  });
  return { provider: provider!, sent };
}

async function certDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-'));
  await writeFile(join(directory, 'cert.pem'), 'test-cert');
  await writeFile(join(directory, 'key.pem'), 'test-key');
  await writeFile(join(directory, 'ca.pem'), 'test-ca');
  return directory;
}

test('returns a complete configuration with a normalized url when all required variables are set', async () => {
  const directory = await certDirectory();
  const complete = {
    GIGACHAT_URL: 'https://gateway.example/v1/',
    GIGACHAT_CERT_PATH: join(directory, 'cert.pem'),
    GIGACHAT_KEY_PATH: join(directory, 'key.pem'),
  };
  const config = readGigaConfig(complete);
  assert.equal(config?.baseUrl, 'https://gateway.example');
  assert.equal(config?.cert.toString(), 'test-cert');
  assert.equal(config?.key.toString(), 'test-key');
  assert.equal(config?.ca, undefined);
  assert.equal(config?.rejectUnauthorized, true);

  const urlNormalizationCases: Array<{ label: string; url: string; expected: string }> = [
    { label: 'v1 suffix with trailing slash', url: 'https://gateway.example/v1/', expected: 'https://gateway.example' },
    { label: 'v2 suffix', url: 'https://gateway.example/v2', expected: 'https://gateway.example' },
    { label: 'bare host without a version', url: 'https://gateway.example', expected: 'https://gateway.example' },
    { label: 'host with only a trailing slash', url: 'https://gateway.example/', expected: 'https://gateway.example' },
  ];
  for (const { label, url, expected } of urlNormalizationCases) {
    const cased = readGigaConfig({ ...complete, GIGACHAT_URL: url });
    assert.equal(cased?.baseUrl, expected, label);
  }
});

test('returns undefined when a required variable is missing', async () => {
  const directory = await certDirectory();
  const complete = {
    GIGACHAT_URL: 'https://gateway.example/v1/',
    GIGACHAT_CERT_PATH: join(directory, 'cert.pem'),
    GIGACHAT_KEY_PATH: join(directory, 'key.pem'),
  };
  for (const missing of ['GIGACHAT_URL', 'GIGACHAT_CERT_PATH', 'GIGACHAT_KEY_PATH'] as const) {
    assert.equal(readGigaConfig({ ...complete, [missing]: undefined }), undefined, `${missing} is required`);
  }
});

test('loads an optional CA and disables certificate verification when insecure mode is set', async () => {
  const directory = await certDirectory();
  const complete = {
    GIGACHAT_URL: 'https://gateway.example/v1/',
    GIGACHAT_CERT_PATH: join(directory, 'cert.pem'),
    GIGACHAT_KEY_PATH: join(directory, 'key.pem'),
  };
  const relaxed = readGigaConfig({ ...complete, GIGACHAT_CA_PATH: join(directory, 'ca.pem'), GIGACHAT_INSECURE: '1' });
  assert.equal(relaxed?.ca?.toString(), 'test-ca');
  assert.equal(relaxed?.rejectUnauthorized, false);
});

test('a configured but unreadable certificate path fails loudly', async () => {
  const directory = await certDirectory();
  assert.throws(() => readGigaConfig({
    GIGACHAT_URL: 'https://gateway.example',
    GIGACHAT_CERT_PATH: join(directory, 'absent.pem'),
    GIGACHAT_KEY_PATH: join(directory, 'key.pem'),
  }), /absent\.pem/);
});

test('request options carry the client certificate and honour the verification switch', async () => {
  const directory = await certDirectory();
  const config = readGigaConfig({
    GIGACHAT_URL: 'https://gateway.example/v1',
    GIGACHAT_CERT_PATH: join(directory, 'cert.pem'),
    GIGACHAT_KEY_PATH: join(directory, 'key.pem'),
    GIGACHAT_CA_PATH: join(directory, 'ca.pem'),
  })!;

  const post = requestOptions(config, '/v2/chat/completions', '{"model":"x"}', 60000);
  assert.equal(post.hostname, 'gateway.example');
  assert.equal(post.path, '/v2/chat/completions');
  assert.equal(post.method, 'POST');
  assert.equal(post.rejectUnauthorized, true);
  assert.equal(post.cert?.toString(), 'test-cert');
  assert.equal(post.key?.toString(), 'test-key');
  assert.equal(post.ca?.toString(), 'test-ca');
  assert.equal(post.headers?.['Content-Type'], 'application/json');
  // Транспортная аутентификация: заголовка авторизации быть не должно.
  assert.equal(Object.keys(post.headers ?? {}).some(name => name.toLowerCase() === 'authorization'), false);

  const get = requestOptions(config, '/v1/models', undefined, 60000);
  assert.equal(get.method, 'GET');
  assert.deepEqual(get.headers, {});
});

test('the catalog of the gateway becomes the model list', async () => {
  const paths: string[] = [];
  const provider = await createGigaProvider({}, async path => { paths.push(path); return { status: 200, text: catalogBody }; });
  assert.deepEqual(paths, ['/v1/models']);
  assert.deepEqual(provider?.models?.map(model => model.id), ['GigaChat-3-Pro', 'glm-5.2']);
  // Судья фиксирован на 16384 выходных токенах; меньший лимит молча обрезал бы вердикт.
  assert.ok((provider?.models?.[0]?.maxTokens ?? 0) >= 16384);
  assert.deepEqual(provider?.models?.[0]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('without configuration or with an unusable catalog no provider is produced', async () => {
  assert.equal(await createGigaProvider({}), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 403, text: 'denied' })), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 200, text: 'not json' })), undefined);
  assert.equal(await createGigaProvider({}, async () => ({ status: 200, text: '{"data":[]}' })), undefined);
  assert.equal(await createGigaProvider({}, async () => { throw new Error('network down'); }), undefined);
});

test('a completed answer is delivered as start and done events', async () => {
  const { provider, sent } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: answerBody }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  const stream = provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { temperature: 0 });

  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ['start', 'done']);

  const message = await stream.result();
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }]);
  assert.equal(message.usage.input, 15);
  assert.equal(sent[1]?.path, '/v2/chat/completions');
  assert.deepEqual(sent[1]?.body, { model: 'GigaChat-3-Pro', messages: [{ role: 'user', content: [{ text: 'Hi' }] }], model_options: { temperature: 0 } });
});

test('the judge payload hook is applied and normalized into model options', async () => {
  const { provider, sent } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: answerBody }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  const options = {
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } } } }),
  } as never;
  await provider.streamSimple!(model, { messages: [{ role: 'user', content: 'grade', timestamp: 1 }] }, options).result();

  assert.deepEqual((sent[1]?.body as { model_options?: unknown }).model_options,
    { response_format: { type: 'json_schema', schema: { type: 'object' }, strict: true } });
});

test('a gateway error surfaces as a failed model call, not as a parse error', async () => {
  const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 429, text: '{"status":429,"message":"Too many requests"}' }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;
  await assert.rejects(
    provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {}).result(),
    /429/,
  );
});
