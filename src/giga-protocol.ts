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

// Гейтвей и наш харнесс работают только с текстом; мысли/тул-коллы в истории сообщений отбрасываются.
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

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function stopReason(finish: string | undefined, hasToolCall: boolean): GigaAssistantMessage['stopReason'] {
  if (hasToolCall) return 'toolUse';
  return finish === 'length' ? 'length' : 'stop';
}

export function parseChatResponse(model: GigaModel, body: GigaResponse): GigaAssistantMessage {
  const answer = body.messages?.find(message => message.role === 'assistant');
  const text = (answer?.content ?? []).map(part => part.text ?? '').join('');
  const inputTokens = body.usage?.input_tokens ?? 0;
  // Шлюз изредка присылает cached_tokens больше input_tokens; без зажима это раздуло бы
  // восстановленный в src/pi.ts счётчик входных токенов сверх реально оплаченного.
  const cacheRead = Math.min(body.usage?.input_tokens_details?.cached_tokens ?? 0, inputTokens);
  const input = inputTokens - cacheRead;
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
