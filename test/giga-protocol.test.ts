import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatRequest, parseCatalog } from '../src/giga-protocol.js';

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

test('a catalog without type fields keeps every entry, and malformed input yields nothing', () => {
  assert.deepEqual(parseCatalog({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), ['model-a', 'model-b']);
  assert.deepEqual(parseCatalog({}), []);
  assert.deepEqual(parseCatalog(null), []);
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
  } as never, { temperature: 0, maxTokens: 512 });

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
  const payload = buildChatRequest('Qwen3.6-35b', { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] } as never, {});
  assert.deepEqual(payload, { model: 'Qwen3.6-35b', messages: [{ role: 'user', content: [{ text: 'Hi' }] }] });
});
