import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NetworkService } from '../src/network.mjs';
import { QuotaStore } from '../src/quota.mjs';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

async function fixture(t, limitBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-network-quota-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const quota = await new QuotaStore(directory).init();
  await quota.configure({ enabled: true, limitBytes, periodHours: 24 });
  const network = new NetworkService({ quota }); await network.configure({ mode: 'direct' });
  t.after(() => network.close());
  return { directory, quota, network };
}

function proxyOptions(address) {
  const proxy = new URL(address);
  return { host: proxy.hostname, port: Number(proxy.port), headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } };
}

function httpThroughProxy(address, url) {
  return new Promise((resolve, reject) => {
    const request = http.get({ ...proxyOptions(address), path: url }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      const finish = error => resolve({ body: Buffer.concat(chunks), complete: response.complete, error, status: response.statusCode });
      response.once('error', finish); response.once('end', () => finish());
    });
    request.once('error', reject);
  });
}

function tunnelThroughProxy(address, port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ ...proxyOptions(address), method: 'CONNECT', path: `127.0.0.1:${port}` });
    request.once('connect', (response, socket, head) => {
      const chunks = [head]; socket.on('data', chunk => chunks.push(chunk)); socket.on('error', () => {});
      socket.once('close', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      socket.resume();
    });
    request.once('error', reject); request.end();
  });
}

test('external HTTP gateway counts only response body once and accepts exact quota EOF', async t => {
  const payload = Buffer.alloc(128 * 1024, 71), { network, quota, directory } = await fixture(t, payload.length);
  const port = await listen(t, http.createServer((request, response) => { response.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream' }); response.end(payload); }));
  const result = await httpThroughProxy(await network.externalProxy(), `http://127.0.0.1:${port}/file`);
  assert.equal(result.status, 200); assert.equal(result.complete, true); assert.deepEqual(result.body, payload);
  assert.equal(quota.snapshot().usedBytes, payload.length); assert.equal(JSON.parse(await readFile(join(directory, 'download-quota.json'), 'utf8')).usedBytes, payload.length);
});

test('external HTTP gateway never completes a truncated chunked response at the quota boundary', async t => {
  const payload = Buffer.alloc(128 * 1024, 72), { network, quota } = await fixture(t, 5000);
  const port = await listen(t, http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.write(payload); response.end(); }));
  const result = await httpThroughProxy(await network.externalProxy(), `http://127.0.0.1:${port}/file`);
  assert.equal(result.complete, false); assert.ok(result.error); assert.ok(result.body.length <= 5000); assert.equal(quota.snapshot().usedBytes, 5000);
});

test('external CONNECT gateway meters incoming tunnel bytes before forwarding, including partial grants', async t => {
  const payload = Buffer.alloc(128 * 1024, 73), { network, quota } = await fixture(t, 5000);
  const port = await listen(t, net.createServer(socket => socket.end(payload)));
  const result = await tunnelThroughProxy(await network.externalProxy(), port);
  assert.equal(result.status, 200); assert.deepEqual(result.body, payload.subarray(0, 5000)); assert.equal(quota.snapshot().usedBytes, 5000);
});

test('external CONNECT exact limit can finish successfully and outgoing tunnel bytes are not counted', async t => {
  const payload = Buffer.alloc(4096, 74), { network, quota } = await fixture(t, payload.length);
  let outgoing = 0;
  const port = await listen(t, net.createServer(socket => { socket.once('data', chunk => { outgoing += chunk.length; socket.end(payload); }); }));
  const address = await network.externalProxy();
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ ...proxyOptions(address), method: 'CONNECT', path: `127.0.0.1:${port}` });
    request.once('connect', (response, socket, head) => {
      const chunks = [head]; socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks))); socket.write('outgoing request data');
    }); request.once('error', reject); request.end();
  });
  assert.equal(outgoing, 21); assert.deepEqual(result, payload); assert.equal(quota.snapshot().usedBytes, payload.length);
});

test('ordinary NetworkService fetch and connect remain unmetered so callers can wrap HTTP and FTP once', async t => {
  const payload = Buffer.alloc(1000, 75), { network, quota } = await fixture(t, 1);
  const httpPort = await listen(t, http.createServer((request, response) => response.end(payload)));
  assert.deepEqual(Buffer.from(await (await network.fetch(`http://127.0.0.1:${httpPort}/`)).arrayBuffer()), payload);
  const tcpPort = await listen(t, net.createServer(socket => socket.end(payload)));
  const socket = await network.connect({ host: '127.0.0.1', port: tcpPort }); const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), payload); assert.equal(quota.snapshot().usedBytes, 0);
});

test('exhausted external gateway starts no HTTP operation or CONNECT target', async t => {
  const { network, quota } = await fixture(t, 1); await quota.consume(1);
  let requests = 0, connections = 0;
  const httpPort = await listen(t, http.createServer((request, response) => { requests++; response.end('unexpected'); }));
  const tcpPort = await listen(t, net.createServer(socket => { connections++; socket.end('unexpected'); }));
  const proxy = await network.externalProxy();
  assert.equal((await httpThroughProxy(proxy, `http://127.0.0.1:${httpPort}/`)).status, 502);
  assert.equal((await tunnelThroughProxy(proxy, tcpPort)).status, 502);
  assert.equal(requests, 0); assert.equal(connections, 0);
});

test('external quota identity is fixed while starting and closing rejects future proxy use', async t => {
  const { network, quota } = await fixture(t, 100);
  const starting = network.externalProxy();
  await assert.rejects(network.externalProxy({ quota: { consume: async size => size } }), /cannot change/);
  const address = await starting; assert.equal(await network.externalProxy({ quota }), address);
  await network.close(); await assert.rejects(network.externalProxy(), /closed/);
});
