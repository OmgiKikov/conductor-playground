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
