import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCatalog } from '../src/giga-protocol.js';

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
