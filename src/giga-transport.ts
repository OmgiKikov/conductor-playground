import { readFileSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';

export interface GigaConfig {
  baseUrl: string;
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

// GIGACHAT_INSECURE отключает проверку сертификата шлюза без каких-либо других признаков в
// работе провайдера; предупреждение печатается один раз за процесс, чтобы боевой запуск
// с этим флагом не остался незамеченным, но не заспамил лог на каждое обращение к конфигу.
let insecureWarningLogged = false;

/**
 * Возвращает `undefined`, если не задана обязательная переменная; бросает, если заданный путь не читается.
 *
 * Версию пути выбирает вызывающий код (чат живёт на /v2, каталог на /v1),
 * поэтому хвостовой /v1 или /v2 из настроенного адреса срезается.
 */
export function readGigaConfig(env: Record<string, string | undefined> = process.env): GigaConfig | undefined {
  const url = env.GIGACHAT_URL;
  const certPath = env.GIGACHAT_CERT_PATH;
  const keyPath = env.GIGACHAT_KEY_PATH;
  if (!url || !certPath || !keyPath) return undefined;
  const rejectUnauthorized = env.GIGACHAT_INSECURE !== '1';
  if (!rejectUnauthorized && !insecureWarningLogged) {
    insecureWarningLogged = true;
    process.stderr.write('giga: GIGACHAT_INSECURE=1 — проверка сертификата шлюза отключена\n');
  }
  return {
    baseUrl: url.replace(/\/+$/, '').replace(/\/v[12]$/, ''),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: env.GIGACHAT_CA_PATH ? readFileSync(env.GIGACHAT_CA_PATH) : undefined,
    rejectUnauthorized,
  };
}

export type GigaTransport = (path: string, body?: unknown, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

/** Собирает опции для `https.request`: клиентский сертификат аутентифицирует запрос, заголовка Authorization нет. */
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
    // addEventListener('abort', ...) below only fires on a FUTURE abort; a signal that is
    // already aborted would otherwise send the request anyway and wait for a response that never comes.
    if (signal?.aborted) { reject(new Error('Giga request aborted')); return; }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(requestOptions(config, path, payload, timeoutMs), response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      // Without this, a connection cut mid-body (proxy reset, truncated gateway response)
      // leaves the promise pending forever: 'end' never fires and 'req' has already succeeded.
      response.on('error', reject);
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
