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

test('declared tools become function specifications', () => {
  const payload = buildChatRequest('GigaChat-3-Pro', {
    messages: [{ role: 'user', content: 'Check A-1024', timestamp: 1 }],
    tools: [{ name: 'lookup_record', description: 'Read a record', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
  } as never, {});

  assert.deepEqual(payload.tools, [{
    functions: {
      specifications: [{ name: 'lookup_record', description: 'Read a record', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    },
  }]);
});

test('a request without tools omits the tools field', () => {
  const payload = buildChatRequest('GigaChat-3-Pro', { messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [] } as never, {});
  assert.equal('tools' in payload, false);
});

test('tool call and its result travel back with the original tool state', () => {
  const payload = buildChatRequest('GigaChat-3-Pro', {
    messages: [
      { role: 'user', content: 'Check A-1024', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'state-7#0', name: 'lookup_record', arguments: { id: 'A-1024' } }],
        api: 'giga-v2', provider: 'giga', model: 'GigaChat-3-Pro',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: 2 },
      { role: 'toolResult', toolCallId: 'state-7#0', toolName: 'lookup_record', isError: false,
        content: [{ type: 'text', text: '{"status":"packed"}' }] },
    ],
  } as never, {});

  assert.deepEqual(payload.messages.slice(1), [
    { role: 'assistant', content: [{ function_call: { name: 'lookup_record', arguments: { id: 'A-1024' } } }], tools_state_id: 'state-7' },
    { role: 'function', content: [{ function_result: { name: 'lookup_record', result: '{"status":"packed"}' } }], tools_state_id: 'state-7' },
  ]);
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

test('an unrecognized finish reason fails the model call instead of being reported as a clean stop', () => {
  assert.throws(() => parseChatResponse(model, {
    finish_reason: 'content_filter', messages: [{ role: 'assistant', content: [{ text: '' }] }],
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  }), /content_filter/);
});

test('a function call in the content wins over an unfamiliar finish reason label', () => {
  // За шлюзом стоят и сторонние модели: их метка остановки для вызова инструмента может
  // отличаться от function_call, а сам вызов в контенте — более надёжный признак.
  const message = parseChatResponse(model, {
    finish_reason: 'tool_calls',
    messages: [{ role: 'assistant', tools_state_id: 'state-5',
      content: [{ function_call: { name: 'lookup_record', arguments: { id: 'A-1024' } } }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  assert.equal(message.stopReason, 'toolUse');
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

test('a function call becomes a tool call whose id carries the tool state', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'function_call',
    messages: [{
      role: 'assistant', tool_state_id: '019e8373-dc9a-7883-af60-ebb20b79e1e1',
      content: [{ function_call: { name: 'lookup_record', arguments: { id: 'A-1024' } } }],
    }],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  } as never);

  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(message.content, [{
    type: 'toolCall', id: '019e8373-dc9a-7883-af60-ebb20b79e1e1#0', name: 'lookup_record', arguments: { id: 'A-1024' },
  }]);
});

test('a function call whose arguments arrive as a JSON string is parsed into an object', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'function_call',
    messages: [{ role: 'assistant', tools_state_id: 'state-9',
      content: [{ function_call: { name: 'lookup_record', arguments: '{"id":"A-1024"}' } }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  } as never);
  assert.deepEqual(message.content, [{ type: 'toolCall', id: 'state-9#0', name: 'lookup_record', arguments: { id: 'A-1024' } }]);
});

test('a function call whose arguments are an unparseable string falls back to no arguments', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'function_call',
    messages: [{ role: 'assistant', tools_state_id: 'state-9',
      content: [{ function_call: { name: 'lookup_record', arguments: 'not json' } }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  } as never);
  assert.deepEqual(message.content, [{ type: 'toolCall', id: 'state-9#0', name: 'lookup_record', arguments: {} }]);
});

test('text alongside a function call is preserved', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'function_call',
    messages: [{
      role: 'assistant', tools_state_id: 'state-2',
      content: [{ text: 'Looking it up' }, { function_call: { name: 'lookup_record', arguments: {} } }],
    }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  } as never);

  assert.deepEqual(message.content, [
    { type: 'text', text: 'Looking it up' },
    { type: 'toolCall', id: 'state-2#0', name: 'lookup_record', arguments: {} },
  ]);
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
