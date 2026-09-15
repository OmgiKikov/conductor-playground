import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatRequest, type GigaModel, normalizeResponseFormat, parseCatalog, parseChatResponse } from '../src/giga-protocol.js';

test('catalog keeps chat models and drops embeddings and service entries', () => {
  const ids = parseCatalog({
    object: 'list',
    data: [
      { id: 'GigaChat-3-Pro', object: 'model', owned_by: 'salutedevices', type: 'chat' },
      { id: 'Qwen3.6-35b', object: 'model', owned_by: 'salutedevices', type: 'chat' },
      { id: 'EmbeddingsGigaR', object: 'model', owned_by: 'salutedevices', type: 'embeddings' },
      { id: 'GigaFilter', object: 'model', owned_by: 'salutedevices', type: 'filter' },
    ],
  });
  assert.deepEqual(ids, ['GigaChat-3-Pro', 'Qwen3.6-35b']);
});

test('a catalog without type fields keeps every entry', () => {
  assert.deepEqual(parseCatalog({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), ['model-a', 'model-b']);
});

test('a mixed catalog keeps every chat-capable entry regardless of which entries declare a type', () => {
  const ids = parseCatalog({
    data: [
      { id: 'GigaChat-3-Pro', type: 'chat' },
      { id: 'legacy-model' },
      { id: 'EmbeddingsGigaR', type: 'embeddings' },
    ],
  });
  assert.deepEqual(ids, ['GigaChat-3-Pro', 'legacy-model']);
});

test('a body without a data array yields nothing', () => {
  assert.deepEqual(parseCatalog({}), []);
});

test('a null body yields nothing', () => {
  assert.deepEqual(parseCatalog(null), []);
});

test('entries without a string id are dropped', () => {
  assert.deepEqual(parseCatalog({ data: [{ object: 'model' }] }), []);
});

test('request carries system prompt, roles and content parts', () => {
  const payload = buildChatRequest('GigaChat-3-Pro', {
    systemPrompt: 'You are a tester',
    messages: [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], api: 'giga-v2', provider: 'giga', model: 'GigaChat-3-Pro',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 2 },
      { role: 'user', content: [{ type: 'text', text: 'Again' }], timestamp: 3 },
    ],
  }, { temperature: 0, maxTokens: 512 });

  assert.deepEqual(payload, {
    model: 'GigaChat-3-Pro',
    messages: [
      { role: 'system', content: [{ text: 'You are a tester' }] },
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'Hi' }] },
      { role: 'user', content: [{ text: 'Again' }] },
    ],
    model_options: { temperature: 0, max_tokens: 512 },
  });
});

test('request without sampling options omits model_options', () => {
  const payload = buildChatRequest('Qwen3.6-35b', { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, {});
  assert.deepEqual(payload, { model: 'Qwen3.6-35b', messages: [{ role: 'user', content: [{ text: 'Hi' }] }] });
});

const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as GigaModel;

test('assistant text parts are concatenated into a single string', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'Hello' }, { text: ' world' }] }],
    usage: { input_tokens: 17, input_tokens_details: { prompt_tokens: 17, cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
  });
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello world' }]);
});

test('the response reports the requested model id, not the gateway build string', () => {
  const message = parseChatResponse(model, {
    model: 'GigaChat-3-Pro:3.1.0', finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'Hello' }] }],
    usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
  });
  assert.equal(message.model, 'GigaChat-3-Pro');
});

test('the gateway build string is carried separately as responseModel', () => {
  const message = parseChatResponse(model, {
    model: 'GigaChat-3-Pro:3.1.0', finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'Hello' }] }],
    usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
  });
  assert.equal(message.responseModel, 'GigaChat-3-Pro:3.1.0');
});

test('a normal completion reports the stop reason as stop', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'Hello' }] }],
    usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
  });
  assert.equal(message.stopReason, 'stop');
});

test('a truncated answer reports the length stop reason', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'length', messages: [{ role: 'assistant', content: [{ text: 'cut' }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  });
  assert.equal(message.stopReason, 'length');
});

test('a response with no assistant-role message returns empty content instead of echoing another role', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'stop', messages: [{ role: 'user', content: [{ text: 'echo' }] }],
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });
  assert.deepEqual(message.content, []);
});

test('cached prompt tokens are reported separately so the caller does not count them twice', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'ok' }] }],
    usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
  });
  // src/pi.ts складывает input + cacheRead + cacheWrite, поэтому кэш вычтен из input.
  assert.deepEqual(message.usage, {
    input: 15, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test('the judge schema moves from the OpenAI shape into v2 model options', () => {
  const normalized = normalizeResponseFormat({
    model: 'GigaChat-3-Pro',
    messages: [{ role: 'user', content: [{ text: 'grade this' }] }],
    model_options: { temperature: 0 },
    response_format: { type: 'json_schema', json_schema: { name: 'agent_lab_judgment', strict: true, schema: { type: 'object' } } },
  });
  assert.deepEqual(normalized, {
    model: 'GigaChat-3-Pro',
    messages: [{ role: 'user', content: [{ text: 'grade this' }] }],
    model_options: { temperature: 0, response_format: { type: 'json_schema', schema: { type: 'object' }, strict: true } },
  });
});

test('a payload without response_format is returned unchanged', () => {
  const payload = { model: 'Qwen3.6-35b', messages: [{ role: 'user', content: [{ text: 'hi' }] }] };
  assert.deepEqual(normalizeResponseFormat({ ...payload }), payload);
});
