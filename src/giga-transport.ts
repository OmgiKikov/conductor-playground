import { readFileSync } from 'node:fs';

export interface GigaConfig {
  baseUrl: string;
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

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
  return {
    baseUrl: url.replace(/\/+$/, '').replace(/\/v[12]$/, ''),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: env.GIGACHAT_CA_PATH ? readFileSync(env.GIGACHAT_CA_PATH) : undefined,
    rejectUnauthorized: env.GIGACHAT_INSECURE !== '1',
  };
}
