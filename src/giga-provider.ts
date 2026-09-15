import type { ProviderConfig } from '@earendil-works/pi-coding-agent';
import { buildChatRequest, normalizeResponseFormat, parseCatalog, parseChatResponse, type GigaAssistantMessage } from './giga-protocol.js';
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
      // AssistantMessageEventStream — класс с приватными полями из pi-ai, который сюда нельзя
      // импортировать напрямую; объект ниже реализует его публичный контракт (result +
      // асинхронный итератор), поэтому приводится через unknown, а не напрямую.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as unknown as ReturnType<NonNullable<ProviderConfig['streamSimple']>>;
    },
  };
}
