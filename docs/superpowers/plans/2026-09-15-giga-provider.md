# Giga Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в Agent Lab провайдер `giga` — доступ к внутреннему шлюзу моделей по mTLS-сертификату, с каталогом моделей шлюза, tool calling и строгой схемой судьи.

**Architecture:** Три новых модуля в `src/`: чистый протокольный слой (сборка/разбор JSON контракта v2), тонкий mTLS-транспорт на `node:https` и фабрика провайдера, которая собирает из них `ProviderConfig` для Pi SDK. Регистрация — одной вставкой в `createPiRuntime()`. Сетевого кода в тестах нет: транспорт инжектируется.

**Tech Stack:** TypeScript (ESM, Node >= 22.19), `node:https`, `node:test` + `node:assert/strict`, `tsx`, Pi SDK (`@earendil-works/pi-coding-agent`).

**Спека:** `docs/superpowers/specs/2026-09-15-gigachat-mtls-provider-design.md`

---

## Контекст, который экономит часы

Эти факты установлены исследованием и живым прогоном. Не перепроверяй их с нуля.

- **Аутентификация — только клиентский сертификат.** Никакого OAuth-токена, заголовка `Authorization` нет. Сертификат предъявляется на каждом запросе.
- **Чат — `POST {base}/v2/chat/completions`**, каталог — **`GET {base}/v1/models`** (на `/v2/models` шлюз отвечает 404). Префикса `/api/` нет.
- **Контракт v2 — не OpenAI.** Запрос: `{"model", "messages": [{"role", "content": [{"text"}]}]}`. Ответ: `{"model", "created_at", "messages": [{"role": "assistant", "content": [{"text"}]}], "finish_reason", "usage": {"input_tokens", "input_tokens_details": {"cached_tokens"}, "output_tokens", "total_tokens"}}`. Никаких `choices`.
- **Агент ходит через `provider.streamSimple`.** Проверено: `sdk.js` → `modelRuntime.streamSimple` → `prepared.provider.streamSimple`. Реализовать `stream` отдельно не нужно.
- **Минимальный поток событий — `start` + `done`.** Образец есть в самом репозитории: `test/pi.test.ts:86-93`. Стрим — обычный объект `{ result(), [Symbol.asyncIterator]() }`.
- **Типы pi-ai напрямую не импортируются.** Пакет `@earendil-works/pi-ai` не в зависимостях проекта. Типы выводятся структурно из `ProviderConfig`, как `src/pi.ts:15` уже делает для `Model`.
- **`prepareRequest` не смотрит на `model.api`** — значение этого поля на транспорт не влияет.

## Структура файлов

| Файл | Ответственность |
| --- | --- |
| `src/giga-protocol.ts` (создать) | Чистые функции: сборка запроса v2, разбор ответа, разбор каталога, перенос `response_format`, маппинг инструментов. Ни сети, ни файловой системы. |
| `src/giga-transport.ts` (создать) | Чтение конфигурации из окружения, сборка опций mTLS-запроса, тонкая обёртка над `node:https`. |
| `src/giga-provider.ts` (создать) | Фабрика `createGigaProvider`: каталог → список моделей → `ProviderConfig` со `streamSimple`. |
| `src/pi.ts` (править, ~строка 287) | Регистрация провайдера на `modelRuntime`. |
| `test/giga-protocol.test.ts` (создать) | Тесты протокольного слоя. |
| `test/giga-provider.test.ts` (создать) | Тесты фабрики и `streamSimple` с фиктивным транспортом. |
| `docs/REFERENCE.md` (править) | Переменные окружения провайдера. |

---

### Task 0: Подготовка рабочего дерева

**Files:** нет изменений.

- [ ] **Step 1: Убедиться, что ветка верная**

```bash
git branch --show-current
```

Ожидается: `probe/gigachat-mtls-contract`. Если нет — `git checkout probe/gigachat-mtls-contract`.

- [ ] **Step 2: Установить зависимости**

```bash
npm install
```

- [ ] **Step 3: Прогнать тесты, чтобы знать исходное состояние**

```bash
npm test
```

Ожидается: все тесты проходят. Если что-то падает до наших изменений — остановись и сообщи, не чини попутно.

---

### Task 1: Конфигурация из окружения

**Files:**
- Create: `src/giga-transport.ts`
- Test: `test/giga-provider.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создай `test/giga-provider.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGigaConfig } from '../src/giga-transport.js';

async function certDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-'));
  await writeFile(join(directory, 'cert.pem'), 'test-cert');
  await writeFile(join(directory, 'key.pem'), 'test-key');
  await writeFile(join(directory, 'ca.pem'), 'test-ca');
  return directory;
}

test('configuration requires url, certificate and key, and strips the version suffix', async () => {
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

  for (const missing of ['GIGACHAT_URL', 'GIGACHAT_CERT_PATH', 'GIGACHAT_KEY_PATH'] as const) {
    assert.equal(readGigaConfig({ ...complete, [missing]: undefined }), undefined, `${missing} is required`);
  }

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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: FAIL — модуль `../src/giga-transport.js` не найден.

- [ ] **Step 3: Написать минимальную реализацию**

Создай `src/giga-transport.ts`:

```ts
import { readFileSync } from 'node:fs';

export interface GigaConfig {
  baseUrl: string;
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

/*
 * Версию пути выбирает вызывающий код (чат живёт на /v2, каталог на /v1),
 * поэтому хвостовой /v1 или /v2 из настроенного адреса срезается.
 */
export function readGigaConfig(env: Record<string, string | undefined> = process.env): GigaConfig | undefined {
  const url = env.GIGACHAT_URL;
  const certPath = env.GIGACHAT_CERT_PATH;
  const keyPath = env.GIGACHAT_KEY_PATH;
  if (!url || !certPath || !keyPath) return undefined;
  return {
    baseUrl: url.replace(/\/+$/, '').replace(/\/v[12]$/, ''),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: env.GIGACHAT_CA_PATH ? readFileSync(env.GIGACHAT_CA_PATH) : undefined,
    rejectUnauthorized: env.GIGACHAT_INSECURE !== '1',
  };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: PASS, 2 теста.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-transport.ts test/giga-provider.test.ts
git commit -m "feat(giga): читать mTLS-конфигурацию провайдера из окружения"
```

---

### Task 2: Разбор каталога моделей

**Files:**
- Create: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Создай `test/giga-protocol.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — модуль `../src/giga-protocol.js` не найден.

- [ ] **Step 3: Написать минимальную реализацию**

Создай `src/giga-protocol.ts`:

```ts
interface CatalogEntry { id?: unknown; type?: unknown }

/*
 * Шлюз раздаёт не только чат: эмбеддинги и служебные модели чат-запрос не
 * обслуживают. Отбор идёт по полю type, без эвристик по именам моделей;
 * шлюз, который его не присылает вовсе, отдаёт весь каталог.
 */
export function parseCatalog(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const entries = data as CatalogEntry[];
  const typed = entries.some(entry => typeof entry.type === 'string');
  return entries
    .filter(entry => typeof entry.id === 'string' && (!typed || entry.type === 'chat'))
    .map(entry => entry.id as string);
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 2 теста.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): отбирать чат-модели из каталога шлюза"
```

---

### Task 3: Сборка текстового запроса

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
import { buildChatRequest } from '../src/giga-protocol.js';

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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — `buildChatRequest is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавь в начало `src/giga-protocol.ts` (перед `parseCatalog`):

```ts
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

type StreamSimple = NonNullable<ProviderConfig['streamSimple']>;
export type GigaModel = Parameters<StreamSimple>[0];
export type GigaContext = Parameters<StreamSimple>[1];
export type GigaOptions = NonNullable<Parameters<StreamSimple>[2]>;
export type GigaStream = ReturnType<StreamSimple>;
export type GigaAssistantMessage = Awaited<ReturnType<GigaStream['result']>>;
type GigaMessage = GigaContext['messages'][number];

export interface GigaContentPart { text?: string }
export interface GigaRequestMessage { role: string; content: GigaContentPart[] }
export interface GigaRequest {
  model: string;
  messages: GigaRequestMessage[];
  model_options?: Record<string, unknown>;
}

function textOf(content: GigaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('\n');
}

export function buildChatRequest(modelId: string, context: GigaContext, options: GigaOptions): GigaRequest {
  const messages: GigaRequestMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: [{ text: context.systemPrompt }] });
  for (const message of context.messages) {
    messages.push({ role: message.role, content: [{ text: textOf(message.content) }] });
  }
  const modelOptions: Record<string, unknown> = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxTokens !== undefined) modelOptions.max_tokens = options.maxTokens;
  const request: GigaRequest = { model: modelId, messages };
  if (Object.keys(modelOptions).length) request.model_options = modelOptions;
  return request;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): собирать текстовый запрос контракта v2"
```

---

### Task 4: Разбор ответа и учёт токенов

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
import { parseChatResponse } from '../src/giga-protocol.js';

const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as never;

test('response text, model identity and stop reason are carried over', () => {
  const message = parseChatResponse(model, {
    model: 'GigaChat-3-Pro:3.1.0', created_at: 1789463335, finish_reason: 'stop',
    messages: [{ role: 'assistant', content: [{ text: 'Hello' }, { text: ' world' }] }],
    usage: { input_tokens: 17, input_tokens_details: { prompt_tokens: 17, cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
  });
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello world' }]);
  assert.equal(message.model, 'GigaChat-3-Pro');
  assert.equal(message.responseModel, 'GigaChat-3-Pro:3.1.0');
  assert.equal(message.stopReason, 'stop');
});

test('cached prompt tokens are reported separately so the caller does not count them twice', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'stop', messages: [{ role: 'assistant', content: [{ text: 'ok' }] }],
    usage: { input_tokens: 17, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3, total_tokens: 20 },
  });
  // src/pi.ts складывает input + cacheRead + cacheWrite, поэтому кэш вычтен из input.
  assert.equal(message.usage.input, 15);
  assert.equal(message.usage.cacheRead, 2);
  assert.equal(message.usage.cacheWrite, 0);
  assert.equal(message.usage.output, 3);
  assert.equal(message.usage.totalTokens, 20);
  assert.equal(message.usage.cost.total, 0);
});

test('a truncated answer reports the length stop reason', () => {
  const message = parseChatResponse(model, {
    finish_reason: 'length', messages: [{ role: 'assistant', content: [{ text: 'cut' }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  });
  assert.equal(message.stopReason, 'length');
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — `parseChatResponse is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавь в `src/giga-protocol.ts`:

```ts
export interface GigaResponse {
  model?: string;
  created_at?: number;
  finish_reason?: string;
  messages?: { role?: string; content?: GigaContentPart[]; tool_state_id?: string; tools_state_id?: string }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    total_tokens?: number;
  };
}

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function stopReason(finish: string | undefined, hasToolCall: boolean): GigaAssistantMessage['stopReason'] {
  if (hasToolCall) return 'toolUse';
  return finish === 'length' ? 'length' : 'stop';
}

export function parseChatResponse(model: GigaModel, body: GigaResponse): GigaAssistantMessage {
  const answer = body.messages?.find(message => message.role === 'assistant') ?? body.messages?.[0];
  const text = (answer?.content ?? []).map(part => part.text ?? '').join('');
  const cacheRead = body.usage?.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max((body.usage?.input_tokens ?? 0) - cacheRead, 0);
  const output = body.usage?.output_tokens ?? 0;
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: model.api, provider: model.provider, model: model.id,
    ...(body.model ? { responseModel: body.model } : {}),
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: body.usage?.total_tokens ?? input + cacheRead + output, cost: { ...noCost } },
    stopReason: stopReason(body.finish_reason, false),
    ...(body.finish_reason ? { rawStopReason: body.finish_reason } : {}),
    timestamp: (body.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
  } as GigaAssistantMessage;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 7 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): разбирать ответ v2 с честным учётом кэшированных токенов"
```

---

### Task 5: Строгая схема судьи

Судья в `src/pi.ts:108` добавляет схему хуком `onPayload`, подсовывая **OpenAI-форму** `{type:'json_schema', json_schema:{name, strict, schema}}`. Контракт v2 ждёт её в другом месте и в другой форме: `model_options.response_format = {type:'json_schema', schema, strict}`. Перенос делает провайдер — общий код про особенности шлюза знать не должен.

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
import { normalizeResponseFormat } from '../src/giga-protocol.js';

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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — `normalizeResponseFormat is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавь в `src/giga-protocol.ts`:

```ts
interface OpenAiResponseFormat {
  type?: string;
  json_schema?: { name?: string; strict?: boolean; schema?: unknown };
}

/*
 * Хук onPayload в src/pi.ts кладёт схему судьи в OpenAI-форме на верхний уровень.
 * Контракт v2 ждёт её как model_options.response_format с полем schema.
 */
export function normalizeResponseFormat(payload: Record<string, unknown>): Record<string, unknown> {
  const format = payload.response_format as OpenAiResponseFormat | undefined;
  if (!format) return payload;
  const { response_format: _dropped, ...rest } = payload;
  const modelOptions = { ...(rest.model_options as Record<string, unknown> | undefined) };
  modelOptions.response_format = format.json_schema
    ? { type: format.type ?? 'json_schema', schema: format.json_schema.schema, strict: format.json_schema.strict ?? true }
    : format;
  return { ...rest, model_options: modelOptions };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 9 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): переносить схему судьи в model_options контракта v2"
```

---

### Task 6: Инструменты в запросе

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — `payload.tools` равно `undefined`, а тест ждёт массив спецификаций.

- [ ] **Step 3: Написать минимальную реализацию**

В `src/giga-protocol.ts` расширь интерфейс `GigaRequest` и `buildChatRequest`:

```ts
export interface GigaRequest {
  model: string;
  messages: GigaRequestMessage[];
  model_options?: Record<string, unknown>;
  tools?: { functions: { specifications: { name: string; description: string; parameters: unknown }[] } }[];
}
```

В теле `buildChatRequest`, перед `return request;`, добавь:

```ts
  if (context.tools?.length) {
    request.tools = [{
      functions: {
        specifications: context.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      },
    }];
  }
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 11 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): объявлять инструменты песочницы как function specifications"
```

---

### Task 7: Вызов инструмента в ответе

Шлюз не выдаёт идентификатор вызова: он присылает `tool_state_id` на сообщении и `function_call` внутри части контента. Pi требует `ToolCall.id`. Идентификатор собирается как `` `${tools_state_id}#${индекс}` ``, чтобы на следующем ходу состояние восстанавливалось из самой истории, без состояния внутри провайдера.

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — `stopReason` равен `stop`, а `content` не содержит `toolCall`.

- [ ] **Step 3: Написать минимальную реализацию**

В `src/giga-protocol.ts` расширь `GigaContentPart`:

```ts
export interface GigaContentPart {
  text?: string;
  function_call?: { name: string; arguments?: unknown };
  function_result?: { name: string; result: unknown };
}
```

И замени тело `parseChatResponse` (часть, собирающую `content`) на:

```ts
export function parseChatResponse(model: GigaModel, body: GigaResponse): GigaAssistantMessage {
  const answer = body.messages?.find(message => message.role === 'assistant') ?? body.messages?.[0];
  const state = answer?.tools_state_id ?? answer?.tool_state_id ?? '';
  const parts = answer?.content ?? [];
  const text = parts.map(part => part.text ?? '').join('');
  const content: GigaAssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  parts.forEach((part, index) => {
    if (!part.function_call) return;
    content.push({
      type: 'toolCall', id: `${state}#${index}`, name: part.function_call.name,
      arguments: (part.function_call.arguments ?? {}) as Record<string, unknown>,
    });
  });
  const hasToolCall = content.some(item => item.type === 'toolCall');
  const cacheRead = body.usage?.input_tokens_details?.cached_tokens ?? 0;
  const input = Math.max((body.usage?.input_tokens ?? 0) - cacheRead, 0);
  const output = body.usage?.output_tokens ?? 0;
  return {
    role: 'assistant', content,
    api: model.api, provider: model.provider, model: model.id,
    ...(body.model ? { responseModel: body.model } : {}),
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: body.usage?.total_tokens ?? input + cacheRead + output, cost: { ...noCost } },
    stopReason: stopReason(body.finish_reason, hasToolCall),
    ...(body.finish_reason ? { rawStopReason: body.finish_reason } : {}),
    timestamp: (body.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
  } as GigaAssistantMessage;
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 13 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): читать вызовы функций и сохранять состояние инструментов в id"
```

---

### Task 8: Результат инструмента в следующем запросе

**Files:**
- Modify: `src/giga-protocol.ts`
- Test: `test/giga-protocol.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-protocol.test.ts`:

```ts
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: FAIL — сообщения собраны как текстовые, без `function_call`/`function_result`.

- [ ] **Step 3: Написать минимальную реализацию**

В `src/giga-protocol.ts` расширь тип сообщения запроса и замени цикл сборки сообщений в `buildChatRequest`:

```ts
export interface GigaRequestMessage {
  role: string;
  content: GigaContentPart[];
  tools_state_id?: string;
}
```

```ts
  for (const message of context.messages) {
    if (message.role === 'toolResult') {
      const result = message as unknown as { toolCallId: string; toolName: string; content: { type: string; text?: string }[] };
      messages.push({
        role: 'function',
        content: [{ function_result: { name: result.toolName, result: textOf(result.content as never) } }],
        ...stateOf(result.toolCallId),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GigaContentPart[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      let state: { tools_state_id?: string } = {};
      for (const item of message.content as { type: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (item.type !== 'toolCall') continue;
        parts.push({ function_call: { name: item.name!, arguments: item.arguments ?? {} } });
        state = stateOf(item.id ?? '');
      }
      messages.push({ role: 'assistant', content: parts, ...state });
      continue;
    }
    messages.push({ role: message.role, content: [{ text: textOf(message.content) }] });
  }
```

И добавь рядом с `textOf`:

```ts
/** Идентификатор вызова собран как `${tools_state_id}#${индекс}`, чтобы состояние читалось обратно из истории. */
function stateOf(toolCallId: string): { tools_state_id?: string } {
  const state = toolCallId.split('#')[0];
  return state ? { tools_state_id: state } : {};
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-protocol.test.ts
```

Ожидается: PASS, 14 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-protocol.ts test/giga-protocol.test.ts
git commit -m "feat(giga): возвращать результаты инструментов с исходным состоянием"
```

---

### Task 9: Опции mTLS-запроса

Сам `https.request` — тонкая обёртка и тестируется живым прогоном. Тестируется то, что можно проверить без сети: как из конфигурации собираются опции запроса.

**Files:**
- Modify: `src/giga-transport.ts`
- Test: `test/giga-provider.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-provider.test.ts`:

```ts
import { requestOptions } from '../src/giga-transport.js';

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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: FAIL — `requestOptions is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавь в `src/giga-transport.ts`:

```ts
import { request as httpsRequest, type RequestOptions } from 'node:https';

export type GigaTransport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

export function requestOptions(config: GigaConfig, path: string, payload: string | undefined, timeoutMs: number): RequestOptions {
  const url = new URL(`${config.baseUrl}${path}`);
  return {
    hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
    method: payload === undefined ? 'GET' : 'POST',
    cert: config.cert, key: config.key, ca: config.ca,
    rejectUnauthorized: config.rejectUnauthorized, timeout: timeoutMs,
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
}

export function createGigaTransport(config: GigaConfig, timeoutMs = 120000): GigaTransport {
  return (path, body, signal) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(requestOptions(config, path, payload, timeoutMs), response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    const abort = () => req.destroy(new Error('Giga request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => req.destroy(new Error('Giga request timed out')));
    req.on('error', reject);
    req.on('close', () => signal?.removeEventListener('abort', abort));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: PASS, 3 теста.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-transport.ts test/giga-provider.test.ts
git commit -m "feat(giga): mTLS-транспорт к внутреннему шлюзу"
```

---

### Task 10: Фабрика провайдера и каталог

**Files:**
- Create: `src/giga-provider.ts`
- Test: `test/giga-provider.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-provider.test.ts`:

```ts
import { createGigaProvider } from '../src/giga-provider.js';

const catalogBody = JSON.stringify({ data: [
  { id: 'GigaChat-3-Pro', type: 'chat' }, { id: 'glm-5.2', type: 'chat' }, { id: 'Embeddings', type: 'embeddings' },
] });

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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: FAIL — модуль `../src/giga-provider.js` не найден.

- [ ] **Step 3: Написать минимальную реализацию**

Создай `src/giga-provider.ts`:

```ts
import type { ProviderConfig } from '@earendil-works/pi-coding-agent';
import { parseCatalog } from './giga-protocol.js';
import { createGigaTransport, readGigaConfig, type GigaTransport } from './giga-transport.js';

// Шлюз не сообщает ни окна контекста, ни лимита ответа, ни цен.
// maxTokens не ниже протокола судьи (16384), иначе вердикт молча обрежется.
const MAX_TOKENS = 32768;
const CONTEXT_WINDOW = 128000;

export async function createGigaProvider(
  env: Record<string, string | undefined> = process.env,
  injectedTransport?: GigaTransport,
): Promise<ProviderConfig | undefined> {
  const config = injectedTransport ? undefined : readGigaConfig(env);
  if (!injectedTransport && !config) return undefined;
  const transport = injectedTransport ?? createGigaTransport(config!);

  let ids: string[] = [];
  try {
    const catalog = await transport('/v1/models');
    if (catalog.status === 200) ids = parseCatalog(JSON.parse(catalog.text));
  } catch { return undefined; }
  if (!ids.length) return undefined;

  return {
    name: 'Internal model gateway',
    baseUrl: `${config?.baseUrl ?? ''}/v2`,
    // Аутентификация транспортная (клиентский сертификат). Значение нужно лишь
    // для того, чтобы Pi считал провайдера настроенным; заголовок не шлём.
    apiKey: 'mtls-client-certificate',
    authHeader: false,
    api: 'giga-v2',
    models: ids.map(id => ({
      id, name: id, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    })),
  };
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: PASS, 5 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-provider.ts test/giga-provider.test.ts
git commit -m "feat(giga): собирать провайдера из каталога шлюза"
```

---

### Task 11: Поток ответа модели

**Files:**
- Modify: `src/giga-provider.ts`
- Test: `test/giga-provider.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-provider.test.ts`:

```ts
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

test('a completed answer is delivered as start and done events', async () => {
  const { provider, sent } = await providerWith([{ status: 200, text: catalogBody }, { status: 200, text: answerBody }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as never;
  const stream = provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] } as never, { temperature: 0 } as never);

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
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as never;
  const options = {
    onPayload: (payload: Record<string, unknown>) => ({ ...payload, response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: { type: 'object' } } } }),
  } as never;
  await provider.streamSimple!(model, { messages: [{ role: 'user', content: 'grade', timestamp: 1 }] } as never, options).result();

  assert.deepEqual((sent[1]?.body as { model_options?: unknown }).model_options,
    { response_format: { type: 'json_schema', schema: { type: 'object' }, strict: true } });
});

test('a gateway error surfaces as a failed model call, not as a parse error', async () => {
  const { provider } = await providerWith([{ status: 200, text: catalogBody }, { status: 429, text: '{"status":429,"message":"Too many requests"}' }]);
  const model = { id: 'GigaChat-3-Pro', api: 'giga-v2', provider: 'giga' } as never;
  await assert.rejects(
    provider.streamSimple!(model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] } as never, {} as never).result(),
    /429/,
  );
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: FAIL — `provider.streamSimple` не определён.

- [ ] **Step 3: Написать минимальную реализацию**

В `src/giga-provider.ts` **замени** существующий импорт из `./giga-protocol.js` на расширенный и добавь поле `streamSimple` в возвращаемый объект:

```ts
import { buildChatRequest, normalizeResponseFormat, parseCatalog, parseChatResponse, type GigaAssistantMessage } from './giga-protocol.js';
```

```ts
    streamSimple(model, context, options) {
      const finished = (async (): Promise<GigaAssistantMessage> => {
        const base = buildChatRequest(model.id, context, options ?? {}) as unknown as Record<string, unknown>;
        const hooked = (await options?.onPayload?.(base, model)) ?? base;
        const payload = normalizeResponseFormat(hooked as Record<string, unknown>);
        const response = await transport('/v2/chat/completions', payload, options?.signal);
        if (response.status !== 200) {
          throw new Error(`Giga gateway request failed with HTTP ${response.status}: ${response.text.slice(0, 200)}`);
        }
        return parseChatResponse(model, JSON.parse(response.text));
      })();
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as ReturnType<NonNullable<ProviderConfig['streamSimple']>>;
    },
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: PASS, 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-provider.ts test/giga-provider.test.ts
git commit -m "feat(giga): отдавать ответ модели потоком событий Pi"
```

---

### Task 12: Регистрация провайдера в рантайме

**Files:**
- Modify: `src/pi.ts` (функция `createPiRuntime`, около строки 287)
- Test: `test/giga-provider.test.ts`

- [ ] **Step 1: Написать падающий тест**

Добавь в конец `test/giga-provider.test.ts`:

```ts
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { rm } from 'node:fs/promises';
import { registerGigaProvider } from '../src/giga-provider.js';

test('a registered provider exposes its models through the Pi runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-runtime-'));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  try {
    await registerGigaProvider(runtime, {}, async () => ({ status: 200, text: catalogBody }));
    assert.equal(runtime.getModel('giga', 'GigaChat-3-Pro')?.id, 'GigaChat-3-Pro');
    assert.deepEqual((await runtime.getAvailable('giga')).map(model => model.id), ['GigaChat-3-Pro', 'glm-5.2']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration is silent when the gateway is not configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-giga-empty-'));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  try {
    await registerGigaProvider(runtime, {});
    assert.equal(runtime.getModel('giga', 'GigaChat-3-Pro'), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

```bash
npx tsx --test test/giga-provider.test.ts
```

Ожидается: FAIL — `registerGigaProvider is not a function`.

- [ ] **Step 3: Написать минимальную реализацию**

Добавь тип рантайма к существующему импорту из `@earendil-works/pi-coding-agent` в начале `src/giga-provider.ts`:

```ts
import type { ModelRuntime, ProviderConfig } from '@earendil-works/pi-coding-agent';
```

И добавь в конец `src/giga-provider.ts`:

```ts
export const GIGA_PROVIDER_ID = 'giga';

/** Внутренний шлюз нельзя описать декларативным models.json: там нужен клиентский сертификат. */
export async function registerGigaProvider(
  runtime: ModelRuntime,
  env: Record<string, string | undefined> = process.env,
  injectedTransport?: GigaTransport,
): Promise<void> {
  const provider = await createGigaProvider(env, injectedTransport);
  if (provider) runtime.registerProvider(GIGA_PROVIDER_ID, provider);
}
```

В `src/pi.ts`, внутри `createPiRuntime`, сразу после блока создания `modelRuntime`:

```ts
  try { modelRuntime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch (error) { throw new Error(`Pi SDK недоступен: ${error instanceof Error ? error.message : String(error)}`); }
  if (!injectedRuntime) await registerGigaProvider(modelRuntime);
```

Добавь импорт в начало `src/pi.ts`:

```ts
import { registerGigaProvider } from './giga-provider.js';
```

Точный текст `catch`-блока возьми из файла — он может отличаться; менять его не нужно, добавляется только строка с `registerGigaProvider`.

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

```bash
npx tsx --test test/giga-provider.test.ts && npx tsx --test test/pi.test.ts
```

Ожидается: PASS в обоих файлах. `test/pi.test.ts` использует инжектированный runtime, поэтому сети не касается.

- [ ] **Step 5: Коммит**

```bash
git add src/giga-provider.ts src/pi.ts test/giga-provider.test.ts
git commit -m "feat(giga): регистрировать провайдера при создании рантайма"
```

---

### Task 13: Документация и полный прогон

**Files:**
- Modify: `docs/REFERENCE.md`

- [ ] **Step 1: Найти место для раздела**

```bash
grep -n "^#" docs/REFERENCE.md | head -20
```

- [ ] **Step 2: Добавить раздел о переменных окружения**

Добавь в `docs/REFERENCE.md` (в конец файла, если подходящего раздела нет):

```markdown
## Внутренний шлюз моделей (провайдер `giga`)

Провайдер появляется в выборе моделей, только если заданы все обязательные переменные;
аутентификация — клиентским сертификатом, без токена.

| Переменная | Обязательна | Значение |
| --- | --- | --- |
| `GIGACHAT_URL` | да | Адрес шлюза. Хвостовой `/v1` или `/v2` срезается: версию пути выбирает сам провайдер. |
| `GIGACHAT_CERT_PATH` | да | Файл клиентского сертификата. |
| `GIGACHAT_KEY_PATH` | да | Файл приватного ключа. |
| `GIGACHAT_CA_PATH` | нет | CA-цепочка для проверки сертификата шлюза. Без неё проверка идёт по системному хранилищу. |
| `GIGACHAT_INSECURE` | нет | `1` отключает проверку сертификата шлюза. Только для отладки. |

Список моделей берётся из каталога шлюза (`GET /v1/models`), из него остаются только чат-модели.
Файлы сертификатов в репозиторий не коммитятся.
```

- [ ] **Step 3: Прогнать весь набор тестов и проверку типов**

```bash
npm test && npm run typecheck
```

Ожидается: все тесты проходят, ошибок типов нет.

- [ ] **Step 4: Коммит**

```bash
git add docs/REFERENCE.md
git commit -m "docs: описать переменные окружения провайдера giga"
```

---

### Task 14: Живая проверка на шлюзе

Автоматизации здесь нет: нужны боевые сертификаты и доступ в контур. Выполняет человек, результат фиксируется в отчёте по задаче.

- [ ] **Step 1: Проверить, что провайдер виден и отвечает**

```bash
env GIGACHAT_URL=https://<internal-gateway-host>/v1 GIGACHAT_CERT_PATH=<путь>/cert.pem GIGACHAT_KEY_PATH=<путь>/private.key GIGACHAT_INSECURE=1 node --import tsx test/live/simulator-stop.ts giga GigaChat-3-Pro
```

Ожидается: прогон доходит до конца, симулятор и судья отрабатывают.

- [ ] **Step 2: Повторить на моделях других семейств**

Те же команды с `glm-5.2`, `Qwen3.6-35b`, одной из `DeepSeek-*`. Расхождения между семействами ожидаемы и являются результатом проверки, а не дефектом: зафиксируй, что где сработало.

- [ ] **Step 3: Проверить sandbox-агента с инструментами**

Запусти обычный прогон Agent Lab с `settings.provider = 'giga'` и целью `sandbox`, где агенту нужен инструмент, и убедись, что вызов инструмента происходит и результат возвращается в диалог.

- [ ] **Step 4: Зафиксировать итог**

Собери короткий отчёт: какие модели прошли симулятор, судью и tool call, а какие нет и с какой ошибкой.
