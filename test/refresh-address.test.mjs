import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager } from '../src/manager.mjs';
import { download } from '../src/download.mjs';

const payload = Buffer.from(Array.from({ length: 512 * 1024 }, (_, index) => index % 251));
const changed = Buffer.from(payload).fill(35, 0, 8192);

async function fixture(t, { redirectTarget } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-refresh-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie, range: request.headers.range });
    if (request.url === '/redirect' && redirectTarget) { response.writeHead(302, { Location: redirectTarget }); response.end(); return; }
    if (request.url === '/html') { response.setHeader('Content-Type', 'text/html'); response.end('<html>Login</html>'); return; }
    const bytes = request.url === '/changed' ? changed : payload;
    response.setHeader('ETag', request.url === '/changed' ? '"replacement"' : '"original"');
    response.setHeader('Content-Type', 'application/octet-stream');
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    let start = 0, end = bytes.length - 1;
    if (range) {
      start = Number(range[1]); end = Number(range[2]);
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    }
    response.setHeader('Content-Length', end - start + 1);
    const timer = setInterval(() => {
      const next = Math.min(end + 1, start + 8192);
      response.write(bytes.subarray(start, next)); start = next;
      if (start > end) { clearInterval(timer); response.end(); }
    }, 2);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const manager = await new DownloadManager(directory, join(directory, 'files')).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { manager, base, requests };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Replacement download did not finish');
}

async function partial(manager, base) {
  const cookie = 'previous-session=memory-only';
  const job = await manager.add({ url: base + '/expired', startAt: new Date(Date.now() + 3600000).toISOString(), requestContext: { headers: { cookie } } });
  const controller = new AbortController();
  await assert.rejects(download(job.url, job.path, { connections: 1, signal: controller.signal, requestContext: { headers: { cookie } }, onProgress: progress => { if (progress.received >= 32768) controller.abort(new Error('Pause fixture')); } }), /Pause fixture/);
  const state = JSON.parse(await readFile(job.path + '.resume.json', 'utf8'));
  const actual = manager.jobs.find(value => value.id === job.id);
  actual.status = 'paused'; actual.received = state.parts.reduce((sum, part) => sum + part.done, 0); actual.total = state.size;
  await manager.save();
  return { job, received: actual.received };
}

test('refreshing an expired address resumes a validated partial and drops the previous browser session', async t => {
  const { manager, base, requests } = await fixture(t);
  const { job, received } = await partial(manager, base);
  const result = await manager.refreshAddress(job.id, base + '/renewed');
  assert.equal(result.resumedPartial, true);
  assert.equal(result.preservedBytes, received);
  assert.equal(result.job.status, 'paused');
  assert.equal(result.job.needsSession, false);
  assert.equal(JSON.parse(await readFile(job.path + '.resume.json', 'utf8')).url, base + '/renewed');
  await manager.action(job.id, 'resume');
  await waitFor(() => manager.jobs.find(value => value.id === job.id).status === 'complete');
  assert.deepEqual(await readFile(job.path), payload);
  const renewed = requests.filter(request => request.url === '/renewed');
  assert.ok(renewed.some(request => Number(/^bytes=(\d+)/.exec(request.range)?.[1]) >= received));
  assert.ok(renewed.every(request => !request.cookie));
});

test('a changed validator starts a fresh file and preserves the former partial', async t => {
  const { manager, base } = await fixture(t);
  const { job } = await partial(manager, base);
  const result = await manager.refreshAddress(job.id, base + '/changed');
  assert.equal(result.resumedPartial, false);
  assert.equal(result.job.received, 0);
  await manager.action(job.id, 'resume');
  await waitFor(() => manager.jobs.find(value => value.id === job.id).status === 'complete');
  assert.deepEqual(await readFile(job.path), changed);
  const files = await readdir(join(job.path, '..'));
  assert.ok(files.some(name => name.includes('.part.stale-')));
});

test('a replacement redirected to another origin cannot reuse a partial with a coincidentally equal ETag', async t => {
  const other = createServer((request, response) => {
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes 0-0/${payload.length}`, ETag: '"original"', 'Content-Length': 1 });
    response.end(changed.subarray(0, 1));
  });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => { other.closeAllConnections(); return new Promise(resolve => other.close(resolve)); });
  const { manager, base } = await fixture(t, { redirectTarget: `http://127.0.0.1:${other.address().port}/different` });
  const { job } = await partial(manager, base);
  const checkpoint = await readFile(job.path + '.resume.json', 'utf8');
  const result = await manager.refreshAddress(job.id, base + '/redirect');
  assert.equal(result.resumedPartial, false);
  assert.equal(result.preservedBytes, 0);
  assert.equal(await readFile(job.path + '.resume.json', 'utf8'), checkpoint);
});

test('refresh rejects HTML and unsafe URLs without changing the original job or partial', async t => {
  const { manager, base } = await fixture(t);
  const { job } = await partial(manager, base);
  const before = manager.list();
  const checkpoint = await readFile(job.path + '.resume.json', 'utf8');
  await assert.rejects(manager.refreshAddress(job.id, base + '/html'), /صفحة ويب/);
  await assert.rejects(manager.refreshAddress(job.id, 'file:///C:/secret'), /HTTP/);
  await assert.rejects(manager.refreshAddress(job.id, base.replace('http://', 'http://user:password@')), /credentials|data|login|HTTP|URL|دخول/i);
  assert.deepEqual(manager.list(), before);
  assert.equal(await readFile(job.path + '.resume.json', 'utf8'), checkpoint);
});

test('refresh discards a retained GET response instead of downloading its old body', async t => {
  const { manager, base } = await fixture(t);
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('old-response')); }, cancel() { cancelled = true; } }));
  const job = await manager.addPrepared({ url: base + '/old-retained', startAt: new Date(Date.now() + 3600000).toISOString() }, response);
  await manager.action(job.id, 'pause');
  await manager.refreshAddress(job.id, base + '/renewed');
  assert.equal(cancelled, true);
  await manager.action(job.id, 'resume');
  await waitFor(() => manager.jobs.find(value => value.id === job.id).status === 'complete');
  assert.deepEqual(await readFile(job.path), payload);
});
