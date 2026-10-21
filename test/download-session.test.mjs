import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, prepareDownload } from '../src/download.mjs';

const payload = Buffer.alloc(256 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
const credentials = { Cookie: 'sid=session-secret', Authorization: 'Bearer auth-secret', 'X-CSRF-Token': 'csrf-secret', Referer: 'https://account.example/export', Origin: 'https://account.example' };

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function output(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'file.bin');
}

function sendRanges(req, res) {
  let body = payload;
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  res.setHeader('ETag', '"session-v1"');
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const [start, end] = range.slice(1).map(Number);
    body = payload.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
  }
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

test('session GET preserves credentials for range probes, parallel transfer and resume', async t => {
  const requests = [];
  const url = await serverFixture(t, (req, res) => {
    requests.push(req.headers);
    if (req.headers.cookie !== credentials.Cookie || req.headers.authorization !== credentials.Authorization || req.headers['x-csrf-token'] !== credentials['X-CSRF-Token']) { res.writeHead(403).end(); return; }
    sendRanges(req, res);
  });
  const path = await output(t), controller = new AbortController();
  const requestContext = { method: 'GET', headers: credentials };
  await assert.rejects(download(url, path, { requestContext, signal: controller.signal, maxBytesPerSecond: payload.length, onProgress: p => { if (p.received > 20000) controller.abort(new Error('paused')); } }), /paused/);
  const state = JSON.parse(await readFile(path + '.resume.json', 'utf8'));
  assert.ok(state.parts.some(part => part.done > 0));
  assert.equal(JSON.stringify(state).includes('secret'), false);
  await download(url, path, { requestContext });
  assert.deepEqual(await readFile(path), payload);
  assert.ok(requests.length > 5);
  assert.ok(requests.every(headers => headers.cookie === credentials.Cookie));
});

test('accepted GET response is used once and its paused offsets resume with a verified range', async t => {
  const requests = [];
  const url = await serverFixture(t, (req, res) => { requests.push(req.headers.range); sendRanges(req, res); });
  const path = await output(t), controller = new AbortController();
  const preparedResponse = await prepareDownload(url);
  await assert.rejects(download(url, path, { preparedResponse, signal: controller.signal, maxBytesPerSecond: payload.length, onProgress: p => { if (p.received > 20000) controller.abort(new Error('paused')); } }), /paused/);
  assert.equal(requests.length, 1, 'accepted response must not trigger a second GET');
  const state = JSON.parse(await readFile(path + '.resume.json', 'utf8'));
  assert.equal(state.ranged, true);
  assert.ok(state.parts[0].done > 0);
  await download(url, path, { connections: 1 });
  assert.deepEqual(await readFile(path), payload);
  assert.equal(requests.length, 3);
  assert.equal(requests[2], `bytes=${state.parts[0].done}-${payload.length - 1}`);
});

test('cookie and CSRF protected binary POST uses the retained response with exactly one request', async t => {
  const body = Buffer.from([0, 128, 255, 13, 10, 65, 0, 254]);
  const requests = [];
  const url = await serverFixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.headers.cookie !== credentials.Cookie || req.headers['x-csrf-token'] !== credentials['X-CSRF-Token']) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="export.bin"', 'Content-Length': payload.length });
    res.end(payload);
  });
  const path = await output(t);
  const requestContext = { method: 'POST', headers: { ...credentials, 'Content-Type': 'application/octet-stream' }, bodyBase64: body.toString('base64') };
  const preparedResponse = await prepareDownload(url, { requestContext });
  await download(url, path, { requestContext, preparedResponse, connections: 16, maxRetries: 5 });
  assert.deepEqual(await readFile(path), payload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.range, undefined);
  assert.equal(requests[0].headers['content-type'], 'application/octet-stream');
  assert.deepEqual(requests[0].body, body);
});

test('POST failure is never automatically retried or range-probed', async t => {
  let count = 0;
  const url = await serverFixture(t, (_req, res) => { count++; res.writeHead(503).end(); });
  await assert.rejects(download(url, await output(t), { requestContext: { method: 'POST', bodyBase64: 'AA==' }, maxRetries: 5 }), /503/);
  assert.equal(count, 1);
});

test('interrupted POST response fails without issuing another request', async t => {
  let count = 0;
  const url = await serverFixture(t, (_req, res) => {
    count++;
    res.writeHead(200, { 'Content-Length': payload.length });
    res.write(payload.subarray(0, 4096));
    setTimeout(() => res.destroy(), 15);
  });
  const path = await output(t);
  await assert.rejects(download(url, path, { requestContext: { method: 'POST', bodyBase64: '' }, maxRetries: 5 }));
  assert.equal(count, 1);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('cross-origin redirects strip cookies, auth, CSRF and page context on every range request', async t => {
  const received = [];
  const target = await serverFixture(t, (req, res) => { received.push(req.headers); sendRanges(req, res); });
  const source = await serverFixture(t, (req, res) => {
    assert.equal(req.headers.cookie, credentials.Cookie);
    res.writeHead(302, { Location: target + '/file' }).end();
  });
  const path = await output(t);
  await download(source + '/redirect', path, { requestContext: { headers: credentials } });
  assert.deepEqual(await readFile(path), payload);
  assert.equal(received.length, 5);
  for (const headers of received) for (const name of ['cookie', 'authorization', 'x-csrf-token', 'referer', 'origin']) assert.equal(headers[name], undefined, name);
});

test('POST 307 redirect is refused instead of replaying a second POST', async t => {
  let posted = 0, redirected = 0;
  const target = await serverFixture(t, (_req, res) => { redirected++; res.end(payload); });
  const source = await serverFixture(t, (_req, res) => { posted++; res.writeHead(307, { Location: target + '/target' }).end(); });
  await assert.rejects(prepareDownload(source, { requestContext: { method: 'POST', bodyBase64: 'AA==' } }), /recapture/);
  assert.equal(posted, 1); assert.equal(redirected, 0);
});

test('POST 303 export redirect changes to GET and retains same-origin session credentials', async t => {
  const received = [];
  const url = await serverFixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/export') { res.writeHead(303, { Location: '/result' }).end(); return; }
    res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload);
  });
  const path = await output(t);
  await download(url + '/export', path, { requestContext: { method: 'POST', headers: { ...credentials, 'Content-Type': 'application/octet-stream' }, bodyBase64: 'AP8=' } });
  assert.deepEqual(await readFile(path), payload);
  assert.deepEqual(received.map(item => item.method), ['POST', 'GET']);
  assert.equal(received[1].headers.cookie, credentials.Cookie);
  assert.equal(received[1].headers['content-type'], undefined);
  assert.equal(received[1].body.length, 0);
});
