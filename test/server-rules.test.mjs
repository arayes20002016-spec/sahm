import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeServerRules, resolveServerRule, ServerConnectionLimits, withServerTransfer } from '../src/server-rules.mjs';
import { NetworkService } from '../src/network.mjs';
import { download } from '../src/download.mjs';
import { setTransportFetch } from '../src/transport.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, rules = {}) {
  const state = { active: 0, peak: 0, files: new Map(), peaks: new Map(), requests: [] };
  const payload = Buffer.alloc(128 * 1024, 42);
  const server = createServer((request, response) => {
    state.requests.push(request.url); state.active++; state.peak = Math.max(state.peak, state.active);
    const file = request.url;
    state.files.set(file, (state.files.get(file) || 0) + 1); state.peaks.set(file, Math.max(state.peaks.get(file) || 0, state.files.get(file)));
    let timer;
    response.once('close', () => { clearInterval(timer); state.active--; state.files.set(file, state.files.get(file) - 1); });
    if (file === '/headers') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('hold'); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: '"rules-fixture"', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) });
    let offset = start;
    timer = setInterval(() => { const next = Math.min(offset + 8192, end + 1); response.write(payload.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); response.end(); } }, 3);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const network = new NetworkService({ serverRules: [{ host: '127.0.0.1', port, connections: 2, fileConnections: 1, ...rules }] });
  await network.configure({ mode: 'direct' });
  setTransportFetch(network.createFetch());
  t.after(async () => { setTransportFetch(fetch); await network.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { state, payload, server, port, origin, network, directory: await mkdtemp(join(tmpdir(), 'sahm-server-rules-')) };
}

test('rules normalize IDN and IPv6, preserve explicit ports and choose exact hosts before wildcard suffixes', () => {
  const rules = normalizeServerRules([{ host: '*.example.com', connections: 2 }, { host: 'a.example.com', connections: 3 }, { host: 'a.example.com', port: 8443, connections: 1 }, { host: 'مثال.إختبار' }, { host: '[::1]' }]);
  assert.equal(resolveServerRule('https://a.example.com/', rules).connections, 3);
  assert.equal(resolveServerRule('https://a.example.com:8443/', rules).connections, 1);
  assert.equal(resolveServerRule('https://deep.a.example.com/', rules).connections, 2);
  for (const url of ['https://example.com/', 'https://badexample.com/', 'https://example.com.attacker.test/']) assert.equal(resolveServerRule(url, rules), null);
  assert.equal(resolveServerRule('https://مثال.إختبار/', rules), rules[3]);
  assert.equal(resolveServerRule('http://[::1]:90/', rules), rules[4]);
});

test('malformed rules, credentials, duplicate host-port pairs and unsafe directories fail before use', () => {
  for (const value of [{ host: 'https://example.com' }, { host: 'example.com:80' }, { host: 'a/b' }, { host: '%65xample.com' }, { host: '*example.com' }, { host: '*.127.0.0.1' }, { host: 'host', port: 0 }, { host: 'host', connections: 33 }, { host: 'host', fileConnections: 17 }, { host: 'host', speedLimit: -1 }, { host: 'host', directory: 'relative' }, { host: 'host', category: 7 }, { host: 'host', cookie: 'secret' }]) assert.throws(() => normalizeServerRules([value]));
  assert.throws(() => normalizeServerRules([{ host: 'EXAMPLE.com' }, { host: 'example.com' }]));
});

test('the per-file gate leaves capacity for another file and queued aborts cannot leak a slot', async () => {
  const limits = new ServerConnectionLimits([{ host: 'example.test', connections: 2, fileConnections: 1 }]);
  let first, queued, aborted;
  await withServerTransfer(async () => {
    first = await limits.acquire('https://example.test/a');
    const controller = new AbortController();
    queued = limits.acquire('https://example.test/b', { signal: controller.signal });
    aborted = assert.rejects(queued, /cancelled/); controller.abort(new Error('cancelled'));
  });
  const other = await withServerTransfer(() => limits.acquire('https://example.test/c'));
  await aborted;
  assert.equal(limits.active, 2); other.release(); first.release();
  assert.equal(limits.active, 0); limits.close();
});

test('two real range downloads obey a shared host cap and a separate per-file cap', async t => {
  const f = await fixture(t);
  await Promise.all(['a', 'b'].map(name => download(`${f.origin}/${name}.bin`, join(f.directory, name + '.bin'), { connections: 4 })));
  for (const name of ['a', 'b']) { assert.deepEqual(await readFile(join(f.directory, name + '.bin')), f.payload); assert.equal(f.state.peaks.get(`/${name}.bin`), 1); }
  assert.ok(f.state.peak <= 2); assert.equal(f.network.serverLimits.active, 0);
});

test('redirects re-evaluate the target host-port and preserve per-file scope', async t => {
  const f = await fixture(t);
  const redirect = createServer((request, response) => { response.writeHead(302, { Location: f.origin + request.url }); response.end(); });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { redirect.closeAllConnections(); redirect.close(resolve); }));
  const url = `http://127.0.0.1:${redirect.address().port}/redirected.bin`;
  await download(url, join(f.directory, 'redirected.bin'), { connections: 8 });
  assert.deepEqual(await readFile(join(f.directory, 'redirected.bin')), f.payload);
  assert.equal(f.state.peaks.get('/redirected.bin'), 1);
});

test('a response holds its slot through body consumption; abort and cancel release it for the next request', async t => {
  const f = await fixture(t, { connections: 1 });
  const first = await f.network.fetch(f.origin + '/headers');
  const controller = new AbortController();
  const queued = f.network.fetch(f.origin + '/waiting', { signal: controller.signal });
  const rejection = assert.rejects(queued, /cancelled/);
  await pause(20); assert.equal(f.state.requests.includes('/waiting'), false);
  controller.abort(new Error('cancelled')); await rejection;
  await first.body.cancel();
  const next = await f.network.fetch(f.origin + '/next'); await next.arrayBuffer();
  assert.equal(f.network.serverLimits.active, 0);
});

test('network close rejects a queued request and cancels the active body', async t => {
  const f = await fixture(t, { connections: 1 });
  const first = await f.network.fetch(f.origin + '/headers');
  const queued = f.network.fetch(f.origin + '/queued'); const rejection = assert.rejects(queued);
  await f.network.close(); await rejection;
  await assert.rejects(first.text());
  assert.equal(f.network.serverLimits.active, 0);
});

test('domain speed applies across all ranges of a file, including a redirected target', async t => {
  const f = await fixture(t, { connections: 4, fileConnections: 4, speedLimit: 128 * 1024 });
  const started = Date.now();
  await download(f.origin + '/rate.bin', join(f.directory, 'rate.bin'), { connections: 4 });
  assert.ok(Date.now() - started >= 900, '128 KiB at 128 KiB/s must not be delivered at four times the limit');
  assert.deepEqual(await readFile(join(f.directory, 'rate.bin')), f.payload);
});

test('the browser gateway preserves decoded gzip framing and both cookies with an active host rule', async t => {
  const source = createServer((request, response) => {
    const encoded = gzipSync('decoded browser body');
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': encoded.length, 'Set-Cookie': ['session=one; HttpOnly', 'preference=two; Expires=Wed, 01 Jan 2031 00:00:00 GMT'] }); response.end(encoded);
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const port = source.address().port, network = new NetworkService({ serverRules: [{ host: '127.0.0.1', port, connections: 1 }] });
  await network.configure({ mode: 'direct' });
  t.after(async () => { await network.close(); source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); });
  const gateway = new URL(await network.externalProxy()), { request } = await import('node:http');
  const result = await new Promise((resolve, reject) => {
    const req = request({ host: gateway.hostname, port: gateway.port, path: `http://127.0.0.1:${port}/`, headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${gateway.username}:${gateway.password}`).toString('base64') } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject); response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
  assert.equal(result.body, 'decoded browser body'); assert.equal(result.headers['content-encoding'], undefined);
  assert.equal(result.headers['set-cookie'].length, 2); assert.equal(network.serverLimits.active, 0);
});
test('opaque CONNECT tunnels share the destination cap and disconnecting a client frees the waiting tunnel', async t => {
  const net = await import('node:net'), clients = new Set(), sockets = new Set(); let active = 0, peak = 0;
  const source = net.createServer(socket => { sockets.add(socket); active++; peak = Math.max(peak, active); socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket); active--; }); socket.on('data', data => socket.write(data)); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const port = source.address().port, network = new NetworkService({ serverRules: [{ host: '127.0.0.1', port, connections: 1 }] });
  await network.configure({ mode: 'direct' }); const gateway = new URL(await network.externalProxy());
  t.after(async () => { for (const client of clients) client.destroy(); await network.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => source.close(resolve)); });
  function connect() {
    const socket = net.connect({ host: gateway.hostname, port: Number(gateway.port) }); clients.add(socket); socket.on('error', () => {});
    const ready = new Promise((resolve, reject) => {
      socket.once('error', reject); socket.once('data', data => { assert.match(data.toString(), /200 Connection Established/); resolve(); });
      socket.once('connect', () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: Basic ${Buffer.from(`${gateway.username}:${gateway.password}`).toString('base64')}\r\n\r\n`));
    }); return { socket, ready };
  }
  const first = connect(); await first.ready;
  const second = connect(); let accepted = false; second.ready.then(() => { accepted = true; });
  await pause(40); assert.equal(accepted, false); assert.equal(active, 1);
  first.socket.destroy();
  let timer; await Promise.race([second.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tunnel did not release its slot')), 3000); })]).finally(() => clearTimeout(timer));
  assert.equal(peak, 1); second.socket.destroy();
});
