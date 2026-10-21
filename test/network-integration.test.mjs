import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkService } from '../src/network.mjs';
import { setTransportFetch } from '../src/transport.mjs';
import { requestDownload } from '../src/request-context.mjs';
import { download } from '../src/download.mjs';
import { preflightDownload, prepareBrowserDownload } from '../src/browser-bridge.mjs';
import { MediaService } from '../src/media.mjs';

async function listen(server, t) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-network-integration-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.alloc(384 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const requests = [], proxyRequests = [], basic = `Basic ${Buffer.from('integration:proxy-secret').toString('base64')}`;
  const origin = http.createServer((request, response) => {
    const record = { method: request.method, url: request.url, headers: request.headers, body: '' }; requests.push(record);
    request.on('data', chunk => { record.body += chunk; });
    request.on('end', () => {
      if (request.headers['x-sahm-test-proxy'] !== 'through-recording-proxy') { response.writeHead(403); response.end('direct access rejected'); return; }
      if (request.url === '/redirect') { response.writeHead(302, { Location: '/file.bin' }); response.end(); return; }
      if (request.url === '/post.bin' && (request.method !== 'POST' || request.headers.cookie !== 'session=private' || record.body !== 'csrf=token&file=1')) { response.writeHead(403); response.end(); return; }
      response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Disposition', 'attachment; filename="file.bin"'); response.setHeader('ETag', '"network-integration"'); response.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''); let start = 0, end = payload.length - 1;
      if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`); }
      response.setHeader('Content-Length', end - start + 1); response.end(payload.subarray(start, end + 1));
    });
  });
  const port = await listen(origin, t);
  const proxy = http.createServer((request, response) => {
    proxyRequests.push({ url: request.url, method: request.method, authorization: request.headers['proxy-authorization'] });
    if (request.headers['proxy-authorization'] !== basic) { response.writeHead(407); response.end(); return; }
    const address = new URL(request.url), headers = { ...request.headers, 'x-sahm-test-proxy': 'through-recording-proxy' }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request(address, { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  const proxyPort = await listen(proxy, t), network = new NetworkService();
  await network.configure({ mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxyPort } }, { credentials: { username: 'integration', password: 'proxy-secret' } });
  setTransportFetch(network.createFetch());
  t.after(async () => { setTransportFetch((input, init) => globalThis.fetch(input, init)); await network.close(); });
  return { directory, payload, requests, proxyRequests, network, basic, url: `http://127.0.0.1:${port}` };
}

test('production requestDownload and segmented downloader use the configured proxy for redirects and every range', async t => {
  const fixtureData = await fixture(t), { directory, payload, requests, proxyRequests, basic, url } = fixtureData;
  const response = await requestDownload(`${url}/redirect`); assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  const result = await download(`${url}/file.bin`, join(directory, 'segmented.bin'), { connections: 4 }); assert.equal(result.bytes, payload.length); assert.deepEqual(await readFile(result.path), payload);
  assert.ok(requests.some(request => request.headers.range === 'bytes=0-0')); assert.ok(requests.length >= 7);
  assert.equal(proxyRequests.length, requests.length); assert.ok(proxyRequests.every(request => request.authorization === basic)); assert.ok(requests.every(request => request.headers['proxy-authorization'] === undefined && request.headers['x-sahm-test-proxy'] === 'through-recording-proxy'));
});

test('browser POST preparation is blocked before reaching the configured proxy or origin', async t => {
  const { requests, proxyRequests, url } = await fixture(t);
  await assert.rejects(prepareBrowserDownload({ url: url+'/post.bin',method:'POST',requestContext:{method:'POST',bodyBase64:'AA=='} }), /post-replay-disabled/);
  assert.equal(requests.length,0);assert.equal(proxyRequests.length,0);
});

test('browser preflight follows redirects through the transport policy and never sends a direct probe', async t => {
  const { payload, requests, proxyRequests, url } = await fixture(t);
  const result = await preflightDownload({ url: `${url}/redirect`, source: 'automatic', mime: 'application/octet-stream', totalBytes: payload.length });
  assert.deepEqual(result, { mime: 'application/octet-stream', size: payload.length }); assert.equal(requests.length, 2); assert.equal(proxyRequests.length, requests.length); assert.ok(requests.every(request => request.headers['x-sahm-test-proxy'] === 'through-recording-proxy'));
});

test('browser preflight, captured POST and HTTP downloader fail closed when the configured proxy is unavailable', async t => {
  const { directory, requests, network, url } = await fixture(t);
  const closed = http.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening'); const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  await network.configure({ mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port } });
  await assert.rejects(preflightDownload({ url: `${url}/file.bin`, source: 'automatic', mime: 'application/octet-stream', totalBytes: 1 }));
  await assert.rejects(prepareBrowserDownload({ url: `${url}/post.bin`, method: 'POST', requestContext: { method: 'POST', bodyBase64: Buffer.from('operation=one').toString('base64') } }));
  await assert.rejects(download(`${url}/file.bin`, join(directory, 'failed.bin'), { connections: 2 }));
  assert.equal(requests.length, 0);
});

test('media abort or close while obtaining its proxy cannot spawn a late child process', async () => {
  for (const close of [false, true]) {
    let releaseProxy, entered, spawns = 0;
    const pending = new Promise(resolve => { releaseProxy = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const controller = new AbortController();
    const media = new MediaService({ verifyRuntime: false, network: { externalProxy: () => { entered(); return pending; } }, spawnProcess: () => { spawns++; throw new Error('Must not spawn'); } });
    const operation = media.inspect('https://www.youtube.com/watch?v=jNQXAC9IVRw', { signal: controller.signal });
    await started;
    const closing = close ? media.close() : null;
    if (!close) controller.abort(new Error('Cancelled before proxy was ready'));
    releaseProxy('http://temporary:token@127.0.0.1:1');
    await assert.rejects(operation, /Cancelled before proxy was ready|أُغلق محرك الفيديو/); assert.equal(spawns, 0);
    await (closing || media.close());
  }
});
