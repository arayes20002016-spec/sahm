import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { spawn as spawnProcess } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWindowsHttpFetch, windowsHttpFetch } from '../src/windows-http.mjs';
import { windowsAuthServerService, loopbackWindowsIdentity } from './helpers/windows-auth-fixture.mjs';

const win = { platform: 'win32', systemRoot: 'C:\\Windows' };
const code = expected => error => error.code === `windows-http-${expected}`;
function fakeSpawn(respond, capture = {}) {
  return (executable, args, options) => {
    Object.assign(capture, { executable, args, options });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    capture.child = child; child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    const input = [];
    child.stdin.on('data', chunk => input.push(chunk));
    child.stdin.on('finish', () => {
      const lines = Buffer.concat(input).toString('utf8').trim().split('\n');
      capture.source = Buffer.from(lines[0], 'base64').toString('utf8');
      capture.spec = JSON.parse(lines[1]);
      queueMicrotask(() => respond(child));
    });
    return child;
  };
}
function success(child, body = Buffer.from('native bytes'), headers = []) {
  child.stdout.end(Buffer.concat([Buffer.from(JSON.stringify({ status: 200, headers }) + '\n'), body]));
  queueMicrotask(() => child.emit('close', 0, null));
}

test('native HTTP sends secrets and C# source through stdin only with scoped authentication and no trust bypass', async () => {
  const capture = {}, transport = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(success, capture) });
  const response = await transport('https://origin.example.test/private', { method: 'POST', body: 'one body', redirect: 'manual', headers: { Cookie: 'synthetic-cookie', 'Content-Length': '999', 'Proxy-Authorization': 'must-drop' } }, {
    route: { type: 'http', host: 'proxy.example.test', port: 8080 },
    serverAuth: { scheme: 'ntlm', currentAccount: false, credentials: { username: 'EXAMPLE\\user', password: 'private-password' } },
    proxyAuth: { scheme: 'negotiate', currentAccount: true }
  });
  assert.equal(await response.text(), 'native bytes');
  assert.equal(capture.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(capture.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const argumentsText = JSON.stringify(capture.args); for (const secret of ['origin.example.test', 'proxy.example.test', 'private-password', 'private-passphrase', 'synthetic-cookie']) assert.equal(argumentsText.includes(secret), false);
  assert.equal(capture.options.shell, false); assert.equal(capture.options.windowsHide, true); assert.equal(capture.options.env, undefined);
  assert.equal(Buffer.from(capture.spec.body, 'base64').toString(), 'one body');
  assert.equal(capture.spec.serverAuth.scheme, 'NTLM'); assert.equal(capture.spec.proxyAuth.scheme, 'Negotiate');
  assert.equal(capture.spec.route.url, 'http://proxy.example.test:8080/');
  assert.deepEqual(capture.spec.headers, [['accept-encoding', 'identity'], ['cookie', 'synthetic-cookie']]);
  assert.match(capture.source, /AllowAutoRedirect = false/); assert.match(capture.source, /UseProxy = false/); assert.match(capture.source, /UseDefaultCredentials = false/);
  assert.match(capture.source, /certificate-requires-integrated-transport/); assert.match(capture.source, /CredentialCache/);
  for (const forbidden of ['ServerCertificateCustomValidationCallback', 'ServerCertificateValidationCallback', 'X509Store', 'ServicePointManager.ServerCertificate']) assert.equal(capture.source.includes(forbidden), false);
});

test('native HTTP rejects unsupported routes and unsafe scopes before spawning', async () => {
  let calls = 0;
  const transport = createWindowsHttpFetch({ ...win, spawn: () => { calls++; throw Error('should not spawn'); } });
  for (const type of ['https', 'socks4', 'socks5', 'unknown']) await assert.rejects(transport('https://origin.example.test/', {}, { route: { type, host: 'proxy.example.test', port: 8080 } }), code('unsupported-route'));
  await assert.rejects(transport('http://user:password@origin.example.test/'), code('invalid-url'));
  await assert.rejects(transport('file:///C:/private'), code('invalid-url'));
  await assert.rejects(transport('https://origin.example.test/', { redirect: 'follow' }), code('redirect-not-manual'));
  await assert.rejects(transport('https://origin.example.test/', { method: 'CONNECT' }), code('invalid-method'));
  await assert.rejects(transport('https://origin.example.test/', {}, { proxyAuth: { scheme: 'ntlm', currentAccount: true } }), code('invalid-auth'));
  await assert.rejects(transport('https://origin.example.test/', {}, { serverAuth: { scheme: 'ntlm', currentAccount: false } }), code('invalid-auth'));
  await assert.rejects(transport('https://origin.example.test/', {}, { serverAuth: { scheme: 'basic', currentAccount: false, credentials: { username: 'user', password: 'private' } } }), code('invalid-auth'));
  await assert.rejects(transport('http://origin.example.test/', {}, { clientCertificate: { pfx: Buffer.from('x'), passphrase: '' } }), code('certificate-requires-integrated-transport'));
  await assert.rejects(transport('https://origin.example.test/', { headers: { authorization: 'Basic hidden' } }, { serverAuth: { scheme: 'ntlm', currentAccount: true } }), code('conflicting-auth'));
  assert.equal(calls, 0);
});

test('request body limits apply before native dispatch including streamed POST bodies', async () => {
  let calls = 0;
  const transport = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(child => { calls++; success(child); }) });
  await assert.rejects(transport('https://origin.example.test/', { method: 'POST', body: Buffer.alloc(8 * 1024 * 1024 + 1) }), code('body-too-large'));
  async function* large() { yield Buffer.alloc(4 * 1024 * 1024); yield Buffer.alloc(4 * 1024 * 1024 + 1); }
  await assert.rejects(transport('https://origin.example.test/', { method: 'POST', body: large() }), code('body-too-large'));
  const capture = {}, withBody = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(success, capture) });
  await (await withBody('https://origin.example.test/', { method: 'POST', body: ReadableStream.from([new Uint8Array([0, 1, 2, 255])]) })).arrayBuffer();
  assert.deepEqual(Buffer.from(capture.spec.body, 'base64'), Buffer.from([0, 1, 2, 255]));
  assert.equal(calls, 0);
});

test('partial headers, binary body boundaries and nonzero helper exit are handled without truncation success', async () => {
  const bytes = Buffer.from([0, 10, 255, 100]);
  const transport = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(child => {
    child.stdout.write('{"status":200,"headers":');
    child.stdout.write('[["content-type","application/octet-stream"]]}\n');
    child.stdout.end(bytes); queueMicrotask(() => child.emit('close', 0, null));
  }) });
  assert.deepEqual(Buffer.from(await (await transport('https://origin.example.test/')).arrayBuffer()), bytes);
  const broken = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(child => { child.stdout.end('{"status":200,"headers":[]}\npartial'); queueMicrotask(() => child.emit('close', 2, null)); }) });
  await assert.rejects((await broken('https://origin.example.test/')).arrayBuffer(), code('process-failed'));
});

test('aborting after response headers kills the helper and errors the response body', async () => {
  const capture = {}, controller = new AbortController();
  const transport = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(child => child.stdout.write('{"status":200,"headers":[]}\n'), capture) });
  const response = await transport('https://origin.example.test/', { signal: controller.signal });
  controller.abort();
  await assert.rejects(response.arrayBuffer(), error => error.name === 'AbortError');
  assert.equal(capture.child.killed, true);
});

test('native metadata and process errors are bounded and redacted', async () => {
  for (const data of ['not JSON\n', '{"status":99,"headers":[]}\n', 'x'.repeat(32769), '{"error":"certificate-invalid"}\n', '{"error":"private-password"}\n', '{"status":200,"headers":[["x-private","private-password\\n"]]}\n']) {
    const transport = createWindowsHttpFetch({ ...win, spawn: fakeSpawn(child => { child.stdout.end(data); queueMicrotask(() => child.emit('close', 2, null)); }) });
    await assert.rejects(transport('https://origin.example.test/'), error => error.code.startsWith('windows-http-') && !error.message.includes('private-password'));
  }
});

test('native HTTP refuses excessive request headers and PFX input before dispatch', async () => {
  const transport = createWindowsHttpFetch({ ...win, spawn: () => { throw Error('must not spawn'); } });
  await assert.rejects(transport('https://origin.example.test/', { headers: { 'x-big': 'x'.repeat(32768) } }), code('headers-too-large'));
  await assert.rejects(transport('https://origin.example.test/', { headers: [['bad\nname', 'private-secret']] }), error => error.code === 'windows-http-invalid-headers' && !error.message.includes('private-secret'));
  await assert.rejects(transport('https://origin.example.test/', {}, { clientCertificate: { pfx: Buffer.alloc(8 * 1024 * 1024 + 1), passphrase: '' } }), code('certificate-requires-integrated-transport'));
});

test('native process concurrency stays bounded until body completion and queued cancellation releases no permit', async () => {
  let starts = 0;
  const transport = createWindowsHttpFetch({ ...win, maxConcurrent: 1, maxPending: 1, spawn: fakeSpawn(child => { starts++; success(child); }) });
  const first = await transport('https://origin.example.test/1');
  const controller = new AbortController(), cancelled = transport('https://origin.example.test/2', { signal: controller.signal });
  const rejected = assert.rejects(cancelled, error => error.name === 'AbortError'); controller.abort(); await rejected;
  const next = transport('https://origin.example.test/3');
  await assert.rejects(transport('https://origin.example.test/full'), code('queue-full'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1);
  await first.text(); const second = await next; assert.equal(starts, 2);
  const third = transport('https://origin.example.test/4');
  await second.body.cancel(); assert.equal(await (await third).text(), 'native bytes'); assert.equal(starts, 3);
});

test('aborting an unconsumed body frees its native slot without waiting for a reader', async () => {
  let starts = 0;
  const transport = createWindowsHttpFetch({ ...win, maxConcurrent: 1, spawn: fakeSpawn(child => { starts++; child.stdout.write('{"status":200,"headers":[]}\npending bytes'); }) });
  const controller = new AbortController(), response = await transport('https://origin.example.test/1', { signal: controller.signal });
  const waiting = transport('https://origin.example.test/2');
  controller.abort(); await assert.rejects(response.arrayBuffer(), error => error.name === 'AbortError');
  const next = await waiting; assert.equal(starts, 2); await next.body.cancel();
});

async function server(t, handler, tlsOptions) {
  const instance = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  const sockets = new Set(); instance.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => instance.close(resolve)); });
  return `${tlsOptions ? 'https' : 'http'}://127.0.0.1:${instance.address().port}`;
}

test('Windows HttpClient transfers actual binary GET and POST bytes and returns redirects without following', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  const bytes = Buffer.from([0, 1, 255, 10, 13, 128]), requests = [];
  const url = await server(t, (req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    if (req.method === 'POST') { req.pipe(res); return; }
    res.setHeader('Content-Length', bytes.length); res.end(bytes);
  });
  assert.deepEqual(Buffer.from(await (await windowsHttpFetch(url + '/get')).arrayBuffer()), bytes);
  assert.deepEqual(Buffer.from(await (await windowsHttpFetch(url + '/post', { method: 'POST', body: bytes })).arrayBuffer()), bytes);
  const redirect = await windowsHttpFetch(url + '/redirect'); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/final'); await redirect.body.cancel();
  await assert.rejects(windowsHttpFetch(url + '/redirect', { redirect: 'error' }), code('redirect-error'));
  assert.deepEqual(requests.map(value => value.url), ['/get', '/post', '/redirect', '/redirect']);
});

test('Windows HttpClient aborts an actual streaming response and keeps server TLS validation enabled', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const url = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(32768)); });
  const controller = new AbortController(), response = await windowsHttpFetch(url, { signal: controller.signal });
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); controller.abort();
  await assert.rejects(reader.read(), error => error.name === 'AbortError');
  const tlsUrl = await server(t, (_req, res) => res.end('untrusted'), {
    key: await readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url)), cert: await readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url))
  });
  await assert.rejects(windowsHttpFetch(tlsUrl), code('request-failed'));
});

test('Windows HttpClient uses the exact HTTP proxy without origin DNS or a direct fallback', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const seen = [];
  const proxyUrl = await server(t, (req, res) => { seen.push({ url: req.url, auth: req.headers['proxy-authorization'] }); res.end('proxy-only'); });
  const proxy = new URL(proxyUrl);
  const response = await windowsHttpFetch('http://must-not-resolve.example.invalid/private', {}, { route: { type: 'http', host: proxy.hostname, port: Number(proxy.port) } });
  assert.equal(await response.text(), 'proxy-only');
  assert.deepEqual(seen, [{ url: 'http://must-not-resolve.example.invalid/private', auth: undefined }]);
});

test('Windows HttpClient header deadlines and truncated responses report errors without retry', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  let requests = 0;
  const slow = await server(t, () => { requests++; });
  const short = createWindowsHttpFetch({ headersTimeoutMs: 100 });
  await assert.rejects(short(slow), code('headers-timeout'));
  assert.ok(requests === 0 || requests === 1, 'A deadline may expire before dispatch, but must never retry');
  let truncatedRequests = 0;
  const truncated = await server(t, (_req, res) => { truncatedRequests++; res.writeHead(200, { 'content-length': '100' }); res.write('short'); setTimeout(() => res.destroy(), 50); });
  const response = await windowsHttpFetch(truncated);
  await assert.rejects(response.arrayBuffer(), code('process-failed'));
  assert.equal(truncatedRequests, 1);
});

test('Windows HttpClient authenticates an exact HTTP Basic proxy without sending its password to the origin', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const seen = [], expected = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
  const proxyUrl = await server(t, (req, res) => {
    seen.push({ target: req.url, authorization: req.headers.authorization, proxyAuthorization: req.headers['proxy-authorization'] });
    if (req.headers['proxy-authorization'] !== expected) { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="SAHM synthetic"', 'content-length': '0' }); res.end(); }
    else res.end('basic-proxy-ok');
  });
  const proxy = new URL(proxyUrl);
  const response = await windowsHttpFetch('http://must-not-resolve.example.invalid/data', {}, {
    route: { type: 'http', host: proxy.hostname, port: Number(proxy.port) },
    proxyAuth: { scheme: 'basic', currentAccount: false, credentials: { username: 'fixture-user', password: 'fixture-password' } }
  });
  assert.equal(await response.text(), 'basic-proxy-ok'); assert.equal(seen.length, 2);
  assert.equal(seen[0].proxyAuthorization, undefined); assert.equal(seen[1].proxyAuthorization, expected);
  assert.equal(seen.every(value => value.authorization === undefined), true);
});

test('Windows HttpClient completes actual NTLM 401 authentication for GET and one authorized POST', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const service = await windowsAuthServerService(), contexts = new Map(), rounds = [], authorized = [];
  t.after(() => service.close());
  const base = await server(t, async (req, res) => {
    try {
      const token = /^NTLM ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '')?.[1];
      rounds.push(token ? Buffer.from(token, 'base64').readUInt32LE(8) : 0);
      if (!token) { req.resume(); res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }); res.end(); return; }
      let context = contexts.get(req.socket);
      if (!context) { context = await service.createContext(loopbackWindowsIdentity); contexts.set(req.socket, context); }
      const result = await context.step(token);
      if (!result.complete) { req.resume(); res.writeHead(401, { 'www-authenticate': `NTLM ${result.token}`, 'content-length': '0' }); res.end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      authorized.push({ method: req.method, body: Buffer.concat(chunks) });
      res.end(req.method === 'POST' ? Buffer.concat(chunks) : Buffer.from([0, 9, 255, 10]));
    } catch { res.writeHead(500); res.end('fixture error'); }
  });
  const url = base.replace('127.0.0.1', 'localhost');
  const context = { serverAuth: { scheme: 'ntlm', currentAccount: true } };
  assert.deepEqual(Buffer.from(await (await windowsHttpFetch(url + '/get', {}, context)).arrayBuffer()), Buffer.from([0, 9, 255, 10]));
  const bytes = Buffer.from('one authorized synthetic operation');
  assert.deepEqual(Buffer.from(await (await windowsHttpFetch(url + '/post', { method: 'POST', body: bytes }, context)).arrayBuffer()), bytes);
  assert.deepEqual(authorized.map(value => value.method), ['GET', 'POST']); assert.deepEqual(authorized[1].body, bytes);
  assert.equal(rounds.filter(value => value === 3).length, 2);
});

test('Windows HttpClient negotiates TLS using OS protocols while a fixture-only callback pins the server', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const [serverCert, serverKey] = await Promise.all([readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url))]);
  const fingerprint = new X509Certificate(serverCert).fingerprint.replaceAll(':', '');
  const spawn = (...args) => {
    const child = spawnProcess(...args), end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (data, ...rest) => {
      const lines = data.split('\n'), source = Buffer.from(lines[0], 'base64').toString();
      const marker = 'handler.AllowAutoRedirect = false;';
      assert.equal(source.split(marker).length, 2);
      const pin = `ServicePointManager.ServerCertificateValidationCallback = delegate(object sender, System.Security.Cryptography.X509Certificates.X509Certificate cert, System.Security.Cryptography.X509Certificates.X509Chain chain, System.Net.Security.SslPolicyErrors errors) { return cert != null && cert.GetCertHashString() == "${fingerprint}"; };`;
      lines[0] = Buffer.from(source.replace(marker, pin + marker)).toString('base64');
      return end(lines.join('\n'), ...rest);
    };
    return child;
  };
  const fixtureTransport = createWindowsHttpFetch({ spawn });
  const tlsCheck = await server(t, (_req, res) => res.end('tls-ok'), { key: serverKey, cert: serverCert });
  assert.equal(await (await fixtureTransport(tlsCheck)).text(), 'tls-ok');
});
