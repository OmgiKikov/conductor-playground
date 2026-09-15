import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

type StreamSimple = NonNullable<ProviderConfig['streamSimple']>;
export type GigaModel = Parameters<StreamSimple>[0];
export type GigaContext = Parameters<StreamSimple>[1];
export type GigaOptions = NonNullable<Parameters<StreamSimple>[2]>;
export type GigaStream = ReturnType<StreamSimple>;
export type GigaAssistantMessage = Awaited<ReturnType<GigaStream['result']>>;
type GigaMessage = GigaContext['messages'][number];

export interface GigaContentPart {
  text?: string;
  function_call?: { name: string; arguments?: unknown };
  function_result?: { name: string; result: unknown };
}

export interface GigaRequestMessage { role: string; content: GigaContentPart[]; tools_state_id?: string }

export interface GigaRequest {
  model: string;
  messages: GigaRequestMessage[];
  model_options?: Record<string, unknown>;
  tools?: { functions: { specifications: { name: string; description: string; parameters: unknown }[] } }[];
}

export interface GigaResponse {
  model?: string;
  created_at?: number;
  finish_reason?: string;
  messages?: { role?: string; content?: GigaContentPart[]; tool_state_id?: string; tools_state_id?: string }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { prompt_tokens?: number; cached_tokens?: number };
    output_tokens?: number;
    total_tokens?: number;
  };
}

// Достаёт текстовые части content; мысли и тул-коллы — не текст, для них у buildChatRequest
// есть отдельные ветки по роли (assistant с вызовом функции, toolResult с его результатом).
function textOf(content: GigaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('\n');
}

/** Идентификатор вызова собран как `${tools_state_id}#${индекс}`, чтобы состояние читалось обратно из истории. */
function stateOf(toolCallId: string): { tools_state_id?: string } {
  const state = toolCallId.split('#')[0];
  return state ? { tools_state_id: state } : {};
}

export function buildChatRequest(modelId: string, context: GigaContext, options: GigaOptions): GigaRequest {
  const messages: GigaRequestMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: [{ text: context.systemPrompt }] });
  for (const message of context.messages) {
    if (message.role === 'toolResult') {
      messages.push({
        role: 'function',
        content: [{ function_result: { name: message.toolName, result: textOf(message.content) } }],
        ...stateOf(message.toolCallId),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GigaContentPart[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      let state: { tools_state_id?: string } = {};
      for (const item of message.content) {
        if (item.type !== 'toolCall') continue;
        parts.push({ function_call: { name: item.name, arguments: item.arguments ?? {} } });
        state = stateOf(item.id);
      }
      messages.push({ role: 'assistant', content: parts, ...state });
      continue;
    }
    messages.push({ role: message.role, content: [{ text: textOf(message.content) }] });
  }
  const modelOptions: Record<string, unknown> = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxTokens !== undefined) modelOptions.max_tokens = options.maxTokens;
  const request: GigaRequest = { model: modelId, messages };
  if (Object.keys(modelOptions).length) request.model_options = modelOptions;
  if (context.tools?.length) {
    request.tools = [{
      functions: {
        specifications: context.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      },
    }];
  }
  return request;
}

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const KNOWN_FINISH_REASONS = new Set(['stop', 'length', 'function_call']);

// A content-filter block or a gateway-side error also arrives as a completed HTTP response with
// some finish_reason; treating anything unrecognized as a clean stop would grade a censored or
// empty body as if the model had answered normally.
function stopReason(finish: string | undefined, hasToolCall: boolean): GigaAssistantMessage['stopReason'] {
  if (finish !== undefined && !KNOWN_FINISH_REASONS.has(finish)) {
    throw new Error(`Giga gateway reported an unrecognized finish reason: ${finish}`);
  }
  if (hasToolCall) return 'toolUse';
  return finish === 'length' ? 'length' : 'stop';
}

export function parseChatResponse(model: GigaModel, body: GigaResponse): GigaAssistantMessage {
  const answer = body.messages?.find(message => message.role === 'assistant');
  const state = answer?.tools_state_id ?? answer?.tool_state_id ?? '';
  const parts = answer?.content ?? [];
  const text = parts.map(part => part.text ?? '').join('');
  const content: GigaAssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  // Индекс в id считает только вызовы функций, а не позицию в content: гейтвей
  // может прислать текст и вызов в одном сообщении, и текст не должен сдвигать нумерацию.
  let callIndex = 0;
  for (const part of parts) {
    if (!part.function_call) continue;
    content.push({
      type: 'toolCall', id: `${state}#${callIndex}`, name: part.function_call.name,
      arguments: (part.function_call.arguments ?? {}) as Record<string, unknown>,
    });
    callIndex += 1;
  }
  const hasToolCall = content.some(item => item.type === 'toolCall');
  const inputTokens = body.usage?.input_tokens ?? 0;
  // Шлюз изредка присылает cached_tokens больше input_tokens; без зажима это раздуло бы
  // восстановленный в src/pi.ts счётчик входных токенов сверх реально оплаченного.
  const cacheRead = Math.min(body.usage?.input_tokens_details?.cached_tokens ?? 0, inputTokens);
  const input = inputTokens - cacheRead;
  const output = body.usage?.output_tokens ?? 0;
  return {
    role: 'assistant',
    content,
    api: model.api, provider: model.provider, model: model.id,
    ...(body.model ? { responseModel: body.model } : {}),
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: body.usage?.total_tokens ?? input + cacheRead + output, cost: { ...noCost } },
    stopReason: stopReason(body.finish_reason, hasToolCall),
    ...(body.finish_reason ? { rawStopReason: body.finish_reason } : {}),
    timestamp: (body.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

interface CatalogEntry { id?: unknown; type?: unknown }

/*
 * Шлюз раздаёт не только чат: эмбеддинги и служебные модели чат-запрос не
 * обслуживают. Отбор идёт по полю type, без эвристик по именам моделей;
 * шлюз, который его не присылает вовсе, отдаёт весь каталог.
 */
export function parseCatalog(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return (data as CatalogEntry[])
    .filter(entry => typeof entry.id === 'string' && (typeof entry.type !== 'string' || entry.type === 'chat'))
    .map(entry => entry.id as string);
}

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
