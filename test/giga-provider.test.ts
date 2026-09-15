import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGigaConfig, requestOptions } from '../src/giga-transport.js';

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
