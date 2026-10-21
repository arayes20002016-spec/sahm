import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tlsChannelBinding } from '../src/proxy-auth.mjs';
import { windowsAuthServerService, loopbackWindowsIdentity } from './helpers/windows-auth-fixture.mjs';
import { WindowsAuthService } from '../src/windows-auth.mjs';

const { createIntegratedHttpFetch, integratedHttpFetch } = await import(process.env.SAHM_INTEGRATED_HTTP_TEST_MODULE || '../src/integrated-http.mjs');

const code = value => error => error.code === `integrated-http-${value}`;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function connect({ host, port, signal }) {
  const socket = net.connect({ host, port, signal }); socket.on('error', () => {});
  await once(socket, 'connect'); return socket;
}
function identity(url) { return { origin: new URL(url).origin, scheme: 'ntlm', currentAccount: true }; }
function service({ complete = true } = {}) {
  const state = { creates: 0, steps: 0, closes: 0 };
  return {
    state,
    async createContext(options) { state.creates++; state.options = options; return { async step() { state.steps++; return { token: 'AA==', complete }; }, async close() { state.closes++; } }; }
  };
}
async function listen(t, handler, tlsOptions) {
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `${tlsOptions ? 'https' : 'http'}://localhost:${server.address().port}` };
}

test('integrated HTTP validates exact origin, credential opt-in, headers and body limits before connecting', async () => {
  let connects = 0;
  const url = 'https://origin.example.test/file', authService = service();
  const context = { serverAuth: identity(url), authService, connect: async () => { connects++; throw Error('not reached'); } };
  await assert.rejects(integratedHttpFetch(url, {}, { ...context, serverAuth: { ...context.serverAuth, origin: 'https://other.example.test' } }), code('scope'));
  await assert.rejects(integratedHttpFetch(url, { headers: { authorization: 'private' } }, context), code('caller-auth'));
  await assert.rejects(integratedHttpFetch(url, { headers: { 'proxy-authorization': 'private' } }, context), code('caller-auth'));
  await assert.rejects(integratedHttpFetch(url, { method: 'POST', body: Buffer.alloc(8 * 1024 * 1024 + 1) }, context), code('body-too-large'));
  await assert.rejects(integratedHttpFetch(url, {}, { ...context, serverAuth: { ...identity(url), currentAccount: false } }), code('credentials'));
  await assert.rejects(integratedHttpFetch(url, {}, { ...context, serverAuth: { ...identity(url), currentAccount: false, credentials: { username: 'bad\nuser', password: 'hidden' } } }), code('credentials'));
  assert.equal(connects, 0); assert.equal(authService.state.creates, 0);
});

test('a 401 handshake keeps the same socket and replays a bounded POST only for authentication', async t => {
  const seen = [], sockets = new Set(), authService = service();
  const { url } = await listen(t, async (req, res) => {
    sockets.add(req.socket); const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks), method: req.method });
    if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }); res.end(); }
    else res.end(Buffer.concat(chunks));
  });
  const bytes = Buffer.from([0, 255, 13, 10, 8]);
  const response = await integratedHttpFetch(url, { method: 'POST', body: bytes }, { serverAuth: identity(url), authService, connect });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); await nextTurn();
  assert.equal(seen.length, 2); assert.equal(seen.every(value => value.method === 'POST' && value.body.equals(bytes)), true);
  assert.equal(sockets.size, 1); assert.equal(authService.state.creates, 1); assert.equal(authService.state.closes, 1);
  assert.equal(seen[0].authorization, undefined); assert.equal(seen[1].authorization, 'NTLM AA==');
});

test('closed or replaced connections do not receive a subsequent authentication token', async t => {
  const authService = service(), seen = [];
  const { url } = await listen(t, (req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(401, { 'www-authenticate': 'NTLM', 'connection': 'close', 'content-length': '0' }); res.end(); });
  let connects = 0;
  await assert.rejects(integratedHttpFetch(url, {}, { serverAuth: identity(url), authService, connect: async options => { connects++; return connect(options); } }), code('connection-changed'));
  assert.deepEqual(seen, [undefined]); assert.equal(connects, 1); assert.equal(authService.state.steps, 0);
});

test('failed or cancelled helper preparation opens no connection and releases handshake slots', async () => {
  let connections = 0;
  const connect = async () => { connections++; throw new Error('Unexpected connection'); };
  const url = 'http://localhost:1/never-sent';
  await Promise.all(Array.from({ length: 16 }, async () => {
    await assert.rejects(integratedHttpFetch(url, {}, { serverAuth: identity(url), connect, authService: { prepare: async () => { throw new Error('Synthetic boot failure'); }, createContext() {} } }), code('authentication'));
  }));
  const controller = new AbortController();
  const authService = { createContext() {}, prepare: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort(new Error('Caller cancelled preparation'));
  }) };
  await assert.rejects(integratedHttpFetch(url, { signal: controller.signal }, { serverAuth: identity(url), connect, authService }), /Caller cancelled preparation/);
  assert.equal(connections, 0);
});

test('cold authentication startup finishes before short-lived connections open, including concurrent POSTs', async t => {
  const sockets = new Set(), accepted = [];
  let preparations = 0, ready = false, startup;
  const authService = service();
  authService.prepare = async signal => {
    signal?.throwIfAborted(); preparations++;
    await (startup ||= new Promise(resolve => setTimeout(() => { ready = true; resolve(); }, 1200)));
    signal?.throwIfAborted();
  };
  const createContext = authService.createContext.bind(authService);
  authService.createContext = async options => { if (!ready) await authService.prepare(options.signal); return createContext(options); };
  const { url, server } = await listen(t, async (req, res) => {
    sockets.add(req.socket);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0', 'keep-alive': 'timeout=10' }); res.end(); return; }
    accepted.push(Buffer.concat(chunks).toString()); res.end('accepted');
  });
  server.keepAliveTimeout = 300; server.keepAliveTimeoutBuffer = 0;
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const response = await integratedHttpFetch(url, { method: 'POST', body: `operation-${index}` }, { serverAuth: identity(url), authService, connect });
    assert.equal(await response.text(), 'accepted');
  }));
  assert.equal(preparations, 8); assert.equal(sockets.size, 8);
  assert.deepEqual(accepted.sort(), Array.from({ length: 8 }, (_, index) => `operation-${index}`));
});

test('missing server proof, incompatible challenges and overlarge challenge bodies cannot succeed', async t => {
  for (const kind of ['proof', 'basic', 'large']) {
    const authService = service({ complete: false });
    const { url } = await listen(t, (req, res) => {
      req.resume();
      if (kind === 'proof' && req.headers.authorization) { res.end('unauthenticated success'); return; }
      res.writeHead(401, { 'www-authenticate': kind === 'basic' ? 'Basic realm="synthetic"' : 'NTLM', 'content-length': kind === 'large' ? String(1024 * 1024 + 1) : '0' }); res.end();
    });
    await assert.rejects(integratedHttpFetch(url, {}, { serverAuth: identity(url), authService, connect }), error => error.code.startsWith('integrated-http-'));
    if (kind !== 'proof') assert.equal(authService.state.steps, 0);
  }
});

test('403 and redirects are returned without retry or cross-origin credential reuse', async t => {
  const authService = service(), requests = [];
  const { url } = await listen(t, (req, res) => { req.resume(); requests.push(req.url); res.writeHead(req.url === '/redirect' ? 302 : 403, { location: 'https://must-not-connect.example.invalid/' }); res.end('status bytes'); });
  const context = { serverAuth: identity(url), authService, connect };
  const forbidden = await integratedHttpFetch(url + '/forbidden', {}, context); assert.equal(forbidden.status, 403); await forbidden.text();
  const redirect = await integratedHttpFetch(url + '/redirect', {}, context); assert.equal(redirect.status, 302); await redirect.body.cancel();
  await assert.rejects(integratedHttpFetch(url + '/redirect', { redirect: 'error' }, context), code('redirect'));
  assert.deepEqual(requests, ['/forbidden', '/redirect', '/redirect']); assert.equal(authService.state.steps, 0);
});

test('aborting and cancelling the response tear down the socket and authentication context', async t => {
  const authService = service();
  const { url } = await listen(t, (req, res) => { req.resume(); if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }); res.end(); } else { res.writeHead(200); res.write('stream bytes'); } });
  const context = { serverAuth: identity(url), authService, connect };
  const controller = new AbortController(), response = await integratedHttpFetch(url, { signal: controller.signal }, context);
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await assert.rejects(reader.read(), error => error.name === 'AbortError'); await nextTurn();
  assert.equal(authService.state.closes, 1);
  const next = await integratedHttpFetch(url, {}, context); await next.body.cancel(); await nextTurn(); assert.equal(authService.state.closes, 2);
});

test('401 body drains have a deadline rather than leaving a session open forever', async t => {
  const { url } = await listen(t, (req, res) => { req.resume(); res.writeHead(401, { 'www-authenticate': 'NTLM' }); res.write('pending'); });
  const authService = service(), transport = createIntegratedHttpFetch({ headersTimeoutMs: 100 });
  await assert.rejects(transport(url, {}, { serverAuth: identity(url), authService, connect }), error => error.code.startsWith('integrated-http-'));
  assert.equal(authService.state.steps, 0);
});

test('HTTP origin authentication never binds to the TLS certificate of an encrypted proxy hop', async t => {
  const [cert, key] = await Promise.all([readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url))]);
  const { url } = await listen(t, (req, res) => {
    req.resume();
    if (!req.headers.authorization) { res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }); res.end(); }
    else res.end('HTTP origin over encrypted transport');
  }, { cert, key });
  const origin = url.replace('https:', 'http:'), authService = service();
  const throughEncryptedHop = async ({ host, port, signal }) => {
    const socket = tls.connect({ host, port, servername: host, ca: cert, rejectUnauthorized: true, signal });
    socket.on('error', () => {}); await once(socket, 'secureConnect'); return socket;
  };
  const response = await integratedHttpFetch(origin, {}, { serverAuth: identity(origin), authService, connect: throughEncryptedHop });
  assert.equal(await response.text(), 'HTTP origin over encrypted transport');
  assert.equal(authService.state.options.channelBinding, undefined);
});

test('actual mTLS and NTLM authenticate the same TLS connection without writing a Windows certificate store', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-integrated-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const openssl = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
  const run = (args, phrase = '') => new Promise((resolve, reject) => {
    const child = execFile(openssl, args, { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, error => error ? reject(new Error('PFX fixture creation failed')) : resolve());
    child.stdin.on('error', () => {}); child.stdin.end(phrase + '\n');
  });
  const key = join(directory, 'client.key'), cert = join(directory, 'client.pem'), pfxFile = join(directory, 'client.pfx'), bagFile = join(directory, 'client-with-untrusted-ca.pfx');
  await run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=SAHM Integrated Client', '-addext', 'extendedKeyUsage=clientAuth', '-addext', 'basicConstraints=critical,CA:FALSE']);
  await run(['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', pfxFile, '-passout', 'stdin'], 'synthetic-phrase');
  await run(['pkcs12', '-export', '-in', cert, '-inkey', key, '-certfile', fileURLToPath(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), '-out', bagFile, '-passout', 'stdin'], 'synthetic-phrase');
  const [pfx, clientCert, serverCert, serverKey] = await Promise.all([readFile(pfxFile), readFile(cert), readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url))]);
  const service = await windowsAuthServerService(), client = new WindowsAuthService(); t.after(() => service.close()); t.after(() => client.close());
  const binding = tlsChannelBinding({ encrypted: true, getPeerCertificate: () => ({ raw: new X509Certificate(serverCert).raw }) });
  const contexts = new Map(), sockets = new Set(), authorized = [];
  const { url } = await listen(t, async (req, res) => {
    try {
      assert.equal(req.socket.authorized, true); assert.equal(req.socket.getPeerCertificate().subject.CN, 'SAHM Integrated Client');
      sockets.add(req.socket);
      const token = /^NTLM ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '')?.[1];
      if (!token) { req.resume(); res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }); res.end(); return; }
      let context = contexts.get(req.socket);
      if (!context) { context = await service.createContext({ ...loopbackWindowsIdentity, channelBinding: binding }); contexts.set(req.socket, context); }
      const result = await context.step(token);
      if (!result.complete) { req.resume(); res.writeHead(401, { 'www-authenticate': `NTLM ${result.token}`, 'content-length': '0' }); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      authorized.push({ socket: req.socket, method: req.method, body: Buffer.concat(chunks) });
      res.end(req.method === 'POST' ? Buffer.concat(chunks) : Buffer.from([0, 10, 255, 13, 1]));
    } catch { res.writeHead(500); res.end('fixture failure'); }
  }, { key: serverKey, cert: serverCert, ca: clientCert, requestCert: true, rejectUnauthorized: true });
  const context = { serverAuth: identity(url), clientCertificate: { pfx, passphrase: 'synthetic-phrase' }, authService: client, connect };
  await assert.rejects(integratedHttpFetch(url, {}, context), error => error.code.startsWith('integrated-http-'));
  const bundledPfx = await readFile(bagFile);
  await assert.rejects(integratedHttpFetch(url, {}, { ...context, clientCertificate: { pfx: bundledPfx, passphrase: 'synthetic-phrase' } }), code('tls'));
  const transport = createIntegratedHttpFetch({ tlsConnect: options => {
    assert.equal(options.pfx, undefined); assert.equal(options.passphrase, undefined); assert.ok(options.cert); assert.ok(options.key);
    return tls.connect({ ...options, ca: serverCert });
  } });
  const result = await transport(url + '/get', {}, context);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([0, 10, 255, 13, 1]));
  const bytes = Buffer.from('one authorized POST through mTLS and native SSPI');
  assert.deepEqual(Buffer.from(await (await transport(url + '/post', { method: 'POST', body: bytes }, context)).arrayBuffer()), bytes);
  assert.deepEqual(authorized.map(value => value.method), ['GET', 'POST']); assert.equal(sockets.size, 2);
  assert.deepEqual(authorized[1].body, bytes);
});
