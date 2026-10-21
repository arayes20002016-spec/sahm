import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download } from '../src/download.mjs';

const payload = Buffer.alloc(512 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

async function fixture(t, mode = 'range') {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers.range);
    if (mode === 'flaky' && requests.length === 2) { res.statusCode = 503; res.end(); return; }
    const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    res.setHeader('ETag', '"v1"');
    if (mode === 'changed' && requests.length > 1) res.setHeader('ETag', '"v2"');
    let body = payload;
    if (match && mode !== 'plain' && !(mode === 'ignore' && requests.length > 1)) {
      const start = Number(match[1]), end = Number(match[2]);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`);
      body = payload.subarray(start, end + 1);
    }
    res.setHeader('Content-Length', body.length);
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= body.length) { clearInterval(timer); res.end(); return; }
      res.write(body.subarray(offset, offset + 4096)); offset += 4096;
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'rafid-test-'));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { url: `http://127.0.0.1:${server.address().port}/file`, path: join(directory, 'result.bin'), requests };
}

test('parallel ranges reproduce every byte', async t => {
  const f = await fixture(t);
  await download(f.url, f.path);
  assert.deepEqual(await readFile(f.path), payload);
  assert.equal(f.requests.length, 5);
});

test('falls back to one stream when ranges are unsupported', async t => {
  const f = await fixture(t, 'plain');
  await download(f.url, f.path);
  assert.deepEqual(await readFile(f.path), payload);
  assert.equal(f.requests[1], undefined);
});

test('pause persists offsets; resume survives process state loss', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(download(f.url, f.path, { signal: controller.signal, onProgress: p => { if (p.received > 50000) controller.abort(new Error('paused')); } }), /paused/);
  const state = JSON.parse(await readFile(f.path + '.resume.json', 'utf8'));
  assert.ok(state.parts.some(p => p.done > 0));
  const before = f.requests.length;
  await download(f.url, f.path);
  assert.deepEqual(await readFile(f.path), payload);
  assert.ok(f.requests.slice(before + 1).some(r => Number(/bytes=(\d+)/.exec(r)[1]) > 0));
});

test('rejects a server that ignores ranges after probing', async t => {
  const f = await fixture(t, 'ignore');
  await assert.rejects(download(f.url, f.path), /ignored/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('never replaces an existing destination', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'keep');
  await assert.rejects(download(f.url, f.path), { code: 'EEXIST' });
  assert.equal(await readFile(f.path, 'utf8'), 'keep');
});

test('rejects unsupported protocols and invalid connection counts', async () => {
  await assert.rejects(download('file:///etc/passwd', 'unused'), /HTTP/);
  await assert.rejects(download('https://example.com', 'unused', { connections: 0 }), /Connections/);
});

test('retries transient range failures and verifies final bytes', async t => {
  const f = await fixture(t, 'flaky');
  await download(f.url, f.path);
  assert.deepEqual(await readFile(f.path), payload);
  assert.ok(f.requests.length >= 6, 'the failed range is retried while idle connections can take its unwritten tail');
  assert.ok(f.requests.slice(2).some(range => range.startsWith('bytes=0-')), 'retry includes the failed range start');
});

test('rejects content validator changes during ranged transfer', async t => {
  const f = await fixture(t, 'changed');
  await assert.rejects(download(f.url, f.path), /content changed/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('checkpoints progress while running and respects shared per-file speed limit', async t => {
  const f = await fixture(t);
  const started = Date.now();
  const running = download(f.url, f.path, { maxBytesPerSecond: payload.length, checkpointInterval: 50 });
  let checkpoint;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    try { checkpoint = JSON.parse(await readFile(f.path + '.resume.json', 'utf8')); } catch { continue; }
    if (checkpoint.parts.some(p => p.done > 0)) break;
  }
  assert.ok(checkpoint?.parts.some(p => p.done > 0), 'must persist nonzero offsets before completion');
  assert.ok(checkpoint.parts.reduce((n, p) => n + p.done, 0) < payload.length);
  await running;
  assert.ok(Date.now() - started >= 900, 'all connections must share one file budget');
  assert.deepEqual(await readFile(f.path), payload);
});
