import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkService } from '../src/network.mjs';

async function origin(t, handler) {
  const requests = [], sockets = new Set();
  const server = http.createServer((request, response) => { requests.push({ path: request.url, headers: request.headers }); handler(request, response); });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function network(t, options = {}, config = { mode: 'direct' }) {
  const service = new NetworkService(options); await service.configure(config);
  t.after(() => service.close());
  return service;
}
function throughGateway(address, target) {
  const proxy = new URL(address);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: proxy.hostname, port: proxy.port, path: target,
      headers: {
        Host: new URL(target).host,
        'Accept-Encoding': 'identity',
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, complete: response.complete, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('Gateway response timed out')));
  });
}

const cookies = [
  'sahm_session=first; Path=/private; HttpOnly; SameSite=Strict',
  'sahm_preference=second; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; SameSite=Lax'
];

test('browser HTTP gateway preserves separate Set-Cookie headers including an Expires comma', async t => {
  const upstream = await origin(t, (request, response) => {
    response.writeHead(200, { 'Set-Cookie': cookies, 'Content-Type': 'text/html' }); response.end('<h1>Login accepted</h1>');
  });
  const service = await network(t), result = await throughGateway(await service.externalProxy(), upstream.url + '/login');
  assert.equal(result.status, 200); assert.equal(result.complete, true); assert.deepEqual(result.headers['set-cookie'], cookies);
  assert.equal(result.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'set-cookie').length, 2);
  assert.equal(upstream.requests[0].headers['proxy-authorization'], undefined);
  assert.equal(result.body.toString(), '<h1>Login accepted</h1>');
});

test('browser HTTP gateway removes stale gzip framing after Undici decoding and charges the delivered payload once', async t => {
  const payload = Buffer.from('Rendered page payload. '.repeat(4096)), compressed = gzipSync(payload);
  let charged = 0, checks = 0;
  const quota = { async assertAvailable() { checks++; }, async consume(bytes) { charged += bytes; return bytes; } };
  const upstream = await origin(t, (request, response) => {
    // Some servers compress even when the browser explicitly asks for identity.
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length, 'Content-Type': 'text/html', 'Set-Cookie': cookies }); response.end(compressed);
  });
  const service = await network(t, { quota }), result = await throughGateway(await service.externalProxy(), upstream.url + '/compressed');
  assert.equal(upstream.requests[0].headers['accept-encoding'], 'identity');
  assert.equal(result.status, 200); assert.equal(result.complete, true); assert.deepEqual(result.body, payload);
  assert.equal(result.headers['content-encoding'], undefined); assert.equal(result.headers['content-length'], undefined);
  assert.deepEqual(result.headers['set-cookie'], cookies); assert.equal(charged, payload.length); assert.equal(checks, 1);
});

test('native Windows transport raw gzip keeps its encoding, byte length and cookie headers at the browser gateway', async t => {
  const payload = Buffer.from('Authenticated native gzip page '.repeat(50)), compressed = gzipSync(payload);
  let nativeCalls = 0;
  const upstream = await origin(t, (request, response) => { response.writeHead(500); response.end('The injected native transport must own the request'); });
  const service = await network(t, {
    windowsFetch: async (url, init, context) => {
      nativeCalls++; assert.equal(url, upstream.url + '/native'); assert.equal(init.redirect, 'manual');
      assert.equal(context.serverAuth.scheme, 'ntlm'); assert.equal(context.serverAuth.currentAccount, true);
      const headers = new Headers({ 'Content-Encoding': 'gzip', 'Content-Length': String(compressed.length), 'Content-Type': 'text/html' });
      for (const cookie of cookies) headers.append('Set-Cookie', cookie);
      return new Response(compressed, { headers });
    }
  }, { mode: 'direct', authentication: { servers: [{ origin: upstream.url, scheme: 'ntlm', currentAccount: true }] } });
  const result = await throughGateway(await service.externalProxy(), upstream.url + '/native');
  assert.equal(nativeCalls, 1); assert.equal(upstream.requests.length, 0);
  assert.equal(result.complete, true); assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(result.headers['content-length'], String(compressed.length)); assert.deepEqual(result.body, compressed);
  assert.deepEqual(gunzipSync(result.body), payload); assert.deepEqual(result.headers['set-cookie'], cookies);
});

test('unknown encodings remain untouched rather than claiming that the browser body was decoded', async t => {
  const payload = Buffer.from('Opaque response encoding fixture');
  const upstream = await origin(t, (request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'x-sahm-fixture', 'Content-Length': payload.length }); response.end(payload);
  });
  const service = await network(t), result = await throughGateway(await service.externalProxy(), upstream.url + '/opaque');
  assert.equal(result.complete, true); assert.deepEqual(result.body, payload);
  assert.equal(result.headers['content-encoding'], 'x-sahm-fixture'); assert.equal(result.headers['content-length'], String(payload.length));
});

test('identity responses preserve their valid Content-Length without changing the browser framing', async t => {
  const payload = Buffer.from('Already identity encoded');
  const upstream = await origin(t, (request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'identity', 'Content-Length': payload.length }); response.end(payload);
  });
  const service = await network(t), result = await throughGateway(await service.externalProxy(), upstream.url + '/identity');
  assert.equal(result.complete, true); assert.deepEqual(result.body, payload);
  assert.equal(result.headers['content-encoding'], 'identity'); assert.equal(result.headers['content-length'], String(payload.length));
});

test('ordered PAC HTTP responses also remove gzip headers after automatic decoding', async t => {
  const payload = Buffer.from('Ordered route decoded response '.repeat(700)), compressed = gzipSync(payload);
  const upstream = await origin(t, (request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); response.end(compressed);
  });
  const directory = await mkdtemp(join(tmpdir(), 'sahm-browser-gateway-pac-')), pacFile = join(directory, 'routes.pac');
  await writeFile(pacFile, 'function FindProxyForURL(url, host) { return "DIRECT; DIRECT"; }');
  const service = await network(t, {}, { mode: 'pac', pacFile });
  assert.equal((await service.routesFor(upstream.url)).length, 2);
  const result = await throughGateway(await service.externalProxy(), upstream.url + '/ordered');
  assert.equal(result.complete, true); assert.deepEqual(result.body, payload);
  assert.equal(result.headers['content-encoding'], undefined); assert.equal(result.headers['content-length'], undefined);
});
