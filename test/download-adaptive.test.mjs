import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download } from '../src/download.mjs';

const payload = Buffer.alloc(2 * 1024 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const initialPartLength = payload.length / 4;

async function fixture(t, { mode = 'range', credentials } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    if (credentials && req.headers.cookie !== credentials.Cookie) { res.writeHead(403).end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : payload.length - 1;
    const request = { start, end, sent: 0, closed: false, range: req.headers.range };
    requests.push(request);
    res.setHeader('ETag', '"adaptive-v1"');
    let body = payload;
    if (range && mode !== 'plain') {
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
      body = payload.subarray(start, end + 1);
    }
    res.setHeader('Content-Length', body.length);
    // Only the first original connection is slow. Fresh connections to its
    // unwritten tail can finish while that original response is still open.
    if (start === 0 && end === initialPartLength - 1 && mode !== 'plain') {
      const timer = setInterval(() => {
        const chunk = body.subarray(request.sent, request.sent + 4096);
        res.write(chunk); request.sent += chunk.length;
        if (request.sent === body.length) { clearInterval(timer); res.end(); }
      }, 8);
      res.on('close', () => { clearInterval(timer); request.closed = true; });
    } else {
      request.sent = body.length;
      res.end(body);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-adaptive-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}/file`, path: join(directory, 'file.bin'), requests };
}

function assertRangesCoverFile(state) {
  let next = 0;
  for (const part of state.parts) {
    assert.equal(part.start, next, 'checkpoint ranges must be contiguous without gaps or overlaps');
    assert.ok(part.done >= 0 && part.done <= part.end - part.start + 1);
    next = part.end + 1;
  }
  assert.equal(next, payload.length);
}

test('idle connections split a slow active range and cancel its unneeded response tail', async t => {
  const f = await fixture(t);
  let maximumConnections = 0;
  await download(f.url, f.path, { connections: 4, onProgress: progress => { maximumConnections = Math.max(maximumConnections, progress.connections); } });
  assert.deepEqual(await readFile(f.path), payload);
  const original = f.requests.find(request => request.start === 0 && request.end === initialPartLength - 1);
  const reassigned = f.requests.filter(request => request.start > 0 && request.start < initialPartLength);
  assert.ok(reassigned.length > 0, 'a finished connection must take part of the slow original range');
  assert.ok(original.sent < initialPartLength, 'the original response must stop after its shortened range finishes');
  assert.ok(maximumConnections <= 4, 'work reassignment must honor the configured connection limit');
});

test('adaptive checkpoints resume after process state loss with exact session GET bytes', async t => {
  const credentials = { Cookie: 'sid=adaptive-secret' };
  const f = await fixture(t, { credentials });
  const controller = new AbortController();
  await assert.rejects(download(f.url, f.path, {
    connections: 4,
    signal: controller.signal,
    requestContext: { headers: credentials },
    checkpointInterval: 50,
    onProgress: () => {
      if (f.requests.some(request => request.start > 0 && request.start < initialPartLength)) controller.abort(new Error('restart adaptive transfer'));
    }
  }), /restart adaptive transfer/);
  const state = JSON.parse(await readFile(f.path + '.resume.json', 'utf8'));
  assert.ok(state.parts.length > 4, 'checkpoint must contain the reassigned range boundaries');
  assertRangesCoverFile(state);
  assert.equal(JSON.stringify(state).includes('adaptive-secret'), false);
  const resumedAt = f.requests.length;
  await download(f.url, f.path, { connections: 2, requestContext: { headers: credentials } });
  assert.deepEqual(await readFile(f.path), payload);
  assert.ok(f.requests.slice(resumedAt + 1).every(request => request.range), 'resumed requests must verify and use byte ranges');
});

test('reassignment preserves the shared speed budget while buffered writes are reserved', async t => {
  const f = await fixture(t);
  const started = Date.now();
  await download(f.url, f.path, { connections: 4, maxBytesPerSecond: payload.length });
  assert.deepEqual(await readFile(f.path), payload);
  assert.ok(Date.now() - started >= 900, 'reassigned connections must share the same file speed budget');
  assert.ok(f.requests.some(request => request.start > 0 && request.start < initialPartLength), 'must exercise splitting during throttled writes');
});

test('dynamic checkpoints accept more than sixteen contiguous parts and older fixed checkpoints', async t => {
  const f = await fixture(t);
  for (const count of [4, 20]) {
    const path = f.path + `-${count}`;
    const parts = Array.from({ length: count }, (_, index) => {
      const start = Math.floor(index * payload.length / count);
      const end = Math.floor((index + 1) * payload.length / count) - 1;
      return { start, end, done: Math.floor((end - start + 1) / 2) };
    });
    const partial = Buffer.alloc(payload.length);
    for (const part of parts) payload.copy(partial, part.start, part.start, part.start + part.done);
    await writeFile(path + '.part', partial);
    await writeFile(path + '.resume.json', JSON.stringify({ url: f.url, validator: '"adaptive-v1"', size: payload.length, ranged: true, parts }));
    await download(f.url, path, { connections: 2 });
    assert.deepEqual(await readFile(path), payload);
  }
});

test('adaptive workers retain one-stream fallback when the probe has no range support', async t => {
  const f = await fixture(t, { mode: 'plain' });
  await download(f.url, f.path, { connections: 16 });
  assert.deepEqual(await readFile(f.path), payload);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].range, undefined);
});
