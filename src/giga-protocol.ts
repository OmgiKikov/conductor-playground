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
