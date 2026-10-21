import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { windowsAuthServerService, loopbackWindowsIdentity } from './windows-auth-fixture.mjs';

export async function ntlmHttpOrigin(payload, { tls: tlsOptions, respond } = {}) {
  const service = await windowsAuthServerService(), contexts = new Map(), authenticated = new WeakSet(), sockets = new Set(), requests = [], rounds = [];
  const binding = tlsOptions ? Buffer.concat([Buffer.from('tls-server-end-point:'), createHash('sha256').update(new X509Certificate(tlsOptions.cert).raw).digest()]) : undefined;
  const handler = async (request, response) => {
    try {
      if (!authenticated.has(request.socket)) {
        const token = /^NTLM ([a-z0-9+/=]+)$/i.exec(request.headers.authorization || '')?.[1];
        rounds.push(token ? Buffer.from(token, 'base64').readUInt32LE(8) : 0);
        if (!token) { request.resume(); response.writeHead(401, { 'WWW-Authenticate': 'NTLM', 'Content-Length': 0 }); response.end(); return; }
        let context = contexts.get(request.socket);
        if (!context) { context = await service.createContext({ ...loopbackWindowsIdentity, channelBinding: binding }); contexts.set(request.socket, context); }
        const result = await context.step(token);
        if (!result.complete) { request.resume(); response.writeHead(401, { 'WWW-Authenticate': 'NTLM ' + result.token, 'Content-Length': 0 }); response.end(); return; }
        authenticated.add(request.socket); await context.close(); contexts.delete(request.socket);
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), first = range ? Number(range[1]) : 0, last = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      requests.push({ method: request.method, url: request.url, range: request.headers.range || null, submittedBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0), ...(tlsOptions ? { mutualTls: request.socket.authorized === true } : {}) });
      if (respond) { await respond(request, response, Buffer.concat(chunks)); return; }
      if (request.method === 'POST') { const body = Buffer.concat(chunks); response.writeHead(200, { 'Content-Length': body.length }); response.end(body); return; }
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': last - first + 1, ETag: '"enterprise-fixture"', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` } : {}) });
      response.end(request.method === 'HEAD' ? undefined : payload.subarray(first, last + 1));
    } catch { if (!response.headersSent) response.writeHead(500); response.end('Local authentication fixture failed'); }
  };
  const server = tlsOptions ? createHttpsServer(tlsOptions, handler) : createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); contexts.get(socket)?.close().catch(() => {}); contexts.delete(socket); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `${tlsOptions ? 'https' : 'http'}://localhost:${server.address().port}`, requests, rounds, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await service.close();
  } };
}

export async function createEnterprisePfx(directory, passphrase) {
  const openssl = process.env.SAHM_TEST_OPENSSL || (process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');
  const key = join(directory, 'enterprise-client-key.pem'), cert = join(directory, 'enterprise-client-cert.pem'), pfx = join(directory, 'enterprise-client.pfx');
  const execute = (args, secret = '') => new Promise((resolve, reject) => {
    const child = execFile(openssl, args, { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, error => error ? reject(new Error('Local certificate fixture generation failed')) : resolve());
    child.stdin.on('error', () => {}); child.stdin.end(secret + '\n');
  });
  await execute(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=SAHM Enterprise Fixture', '-addext', 'extendedKeyUsage=clientAuth', '-addext', 'basicConstraints=critical,CA:FALSE']);
  await execute(['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', pfx, '-passout', 'stdin'], passphrase);
  return { pfx, key, cert };
}
