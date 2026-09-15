// Diagnostic-only, not part of the test suite. Answers one question: which GigaChat
// chat-completions contract (legacy "v1" choices-based, or primary "v2" messages-based)
// does YOUR internal mTLS endpoint actually speak, and does cert-only auth work at all.
//
// Usage:
//   GIGACHAT_URL=https://<internal-host> \
//   GIGACHAT_CERT_PATH=/path/to/cert.pem \
//   GIGACHAT_KEY_PATH=/path/to/key.pem \
//   [GIGACHAT_CA_PATH=/path/to/ca-chain.pem] \
//   [GIGACHAT_INSECURE=1] \
//   node --import tsx test/live/probe-gigachat-mtls.ts
//
// GIGACHAT_URL is the bare host or host+prefix your gateway actually uses (e.g.
// "https://<internal-gateway-host>" or "https://.../v1") — this script
// does not assume a shape, it tries several plausible ones and reports what responds.
// GIGACHAT_INSECURE=1 skips server-certificate verification, for isolating "wrong CA
// bundle" from "wrong URL/contract" while probing; never use it outside this script.
//
// Never commit real certificate/key files. Point the *_PATH variables at files outside
// the repo, or under a gitignored local directory.
import { readFileSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';

const url = process.env.GIGACHAT_URL;
const certPath = process.env.GIGACHAT_CERT_PATH;
const keyPath = process.env.GIGACHAT_KEY_PATH;
const caPath = process.env.GIGACHAT_CA_PATH;
const insecure = process.env.GIGACHAT_INSECURE === '1';
const model = process.env.GIGACHAT_MODEL || 'GigaChat-2-Max';

if (!url || !certPath || !keyPath) {
  console.error('Usage: GIGACHAT_URL=... GIGACHAT_CERT_PATH=... GIGACHAT_KEY_PATH=... [GIGACHAT_CA_PATH=...] [GIGACHAT_INSECURE=1] node --import tsx test/live/probe-gigachat-mtls.ts');
  process.exit(1);
}

const cert = readFileSync(certPath);
const key = readFileSync(keyPath);
const ca = caPath ? readFileSync(caPath) : undefined;
if (insecure) console.warn('GIGACHAT_INSECURE=1: server certificate verification is OFF. Diagnostic use only.');

const base = url.replace(/\/+$/, '');
const withoutVersionSuffix = base.replace(/\/(v1|v2)$/, '');
const swapVersion = (from: 'v1' | 'v2', to: 'v1' | 'v2') =>
  /\/v[12]$/.test(base) ? base.replace(/\/v[12]$/, `/${to}`) : `${withoutVersionSuffix}/${to}`;

const v1Body = () => JSON.stringify({ model, messages: [{ role: 'user', content: "Say 'Hello' and nothing else" }] });
const v2Body = () => JSON.stringify({ model, messages: [{ role: 'user', content: [{ text: "Say 'Hello' and nothing else" }] }] });

const candidates: { label: string; targetUrl: string; body: string }[] = [
  { label: 'given URL as-is + /chat/completions (v2 body)', targetUrl: `${base}/chat/completions`, body: v2Body() },
  { label: 'given URL as-is + /chat/completions (v1 body)', targetUrl: `${base}/chat/completions`, body: v1Body() },
  { label: `${swapVersion('v1', 'v2')}/chat/completions (v2 body)`, targetUrl: `${swapVersion('v1', 'v2')}/chat/completions`, body: v2Body() },
  { label: `${swapVersion('v2', 'v1')}/chat/completions (v1 body)`, targetUrl: `${swapVersion('v2', 'v1')}/chat/completions`, body: v1Body() },
  { label: `${withoutVersionSuffix}/api/v2/chat/completions (public-style, v2 body)`, targetUrl: `${withoutVersionSuffix}/api/v2/chat/completions`, body: v2Body() },
  { label: `${withoutVersionSuffix}/api/v1/chat/completions (public-style, v1 body)`, targetUrl: `${withoutVersionSuffix}/api/v1/chat/completions`, body: v1Body() },
];
const seen = new Set<string>();
const unique = candidates.filter(c => (seen.has(c.targetUrl + c.body) ? false : (seen.add(c.targetUrl + c.body), true)));

function send(targetUrl: string, body?: string): Promise<{ status: number; text: string } | { error: string }> {
  return new Promise(resolve => {
    const parsed = new URL(targetUrl);
    const options: RequestOptions = {
      hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search,
      method: body === undefined ? 'GET' : 'POST', cert, key, ca, rejectUnauthorized: !insecure, timeout: 15000,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = httpsRequest(options, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', error => resolve({ error: error.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function classify(text: string): string {
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json.messages)) return 'looks like v2 (has "messages")';
    if (Array.isArray(json.choices)) return 'looks like v1 (has "choices")';
    return `parsed JSON, unrecognized shape: keys=${Object.keys(json).join(',')}`;
  } catch { return 'not JSON'; }
}

const report = (label: string, targetUrl: string, result: Awaited<ReturnType<typeof send>>, describe?: (text: string) => string) => {
  if ('error' in result) { console.log(`[FAIL]  ${label}\n        ${targetUrl}\n        error: ${result.error}\n`); return; }
  const preview = result.text.slice(0, 2000).replace(/\n/g, ' ');
  const tag = result.status === 200 ? 'OK  ' : result.status === 404 ? '404 ' : `HTTP${result.status}`;
  console.log(`[${tag}] ${label}\n        ${targetUrl}\n        ${result.status === 200 && describe ? describe(result.text) : ''}\n        body: ${preview}\n`);
};

console.log('--- chat contract ---\n');
for (const { label, targetUrl, body } of unique) {
  report(label, targetUrl, await send(targetUrl, body), classify);
}

// Which models this gateway actually serves: the catalog is not only GigaChat.
console.log('--- model catalog ---\n');
for (const version of ['v1', 'v2'] as const) {
  const targetUrl = `${swapVersion(version === 'v1' ? 'v2' : 'v1', version)}/models`;
  report(`GET ${version}/models`, targetUrl, await send(targetUrl), text => {
    try {
      const json = JSON.parse(text);
      const ids = Array.isArray(json.data) ? json.data.map((m: { id?: string }) => m.id).filter(Boolean) : [];
      return ids.length ? `${ids.length} models: ${ids.join(', ')}` : 'no "data" array in response';
    } catch { return 'not JSON'; }
  });
}
console.log('Done. [OK  ] lines under "chat contract" are the URLs your gateway accepts (v1 vs v2);\nthe "model catalog" section lists every model id you can actually select.');
