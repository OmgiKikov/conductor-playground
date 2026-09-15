import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGigaTransport, type GigaConfig } from '../src/giga-transport.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Self-signed, test-only, loopback-only: never a real gateway certificate.
const serverCert = readFileSync(join(fixtures, 'tls-loopback-cert.pem'));
const serverKey = readFileSync(join(fixtures, 'tls-loopback-key.pem'));

function startTlsServer(onConnection: (socket: TLSSocket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createTlsServer({ cert: serverCert, key: serverKey }, onConnection);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function testConfig(port: number): GigaConfig {
  // Verification is off, like a real deployment would set with GIGACHAT_INSECURE, so the
  // self-signed loopback fixture is accepted without a matching CA.
  return { baseUrl: `https://127.0.0.1:${port}`, cert: serverCert, key: serverKey, rejectUnauthorized: false };
}

test('a response cut off mid-body rejects instead of hanging forever', { timeout: 3000 }, async () => {
  // A raw socket, not a real http.Server: promises a 100-byte body, writes far fewer bytes,
  // then closes cleanly (FIN, not RST) — exactly what a proxy/gateway does mid-stream.
  const { port, close } = await startTlsServer(socket => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"data":[');
      socket.end();
    });
  });
  try {
    const transport = createGigaTransport(testConfig(port));
    await assert.rejects(transport('/v1/models'));
  } finally { await close(); }
});

test('an already aborted signal rejects immediately instead of waiting for a response', { timeout: 3000 }, async () => {
  const { port, close } = await startTlsServer(() => { /* deliberately never responds */ });
  try {
    const transport = createGigaTransport(testConfig(port));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport('/v1/models', undefined, controller.signal));
  } finally { await close(); }
});
