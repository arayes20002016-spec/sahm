import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager } from '../src/manager.mjs';
import { prepareDownload } from '../src/download.mjs';

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-session-manager-'));
  const manager = await new DownloadManager(join(directory, 'data'), join(directory, 'files')).init();
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, url: `http://127.0.0.1:${server.address().port}/export` };
}

async function waitFor(manager, id, predicate) {
  for (let n = 0; n < 100; n++) {
    const job = manager.list().find(job => job.id === id);
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('job did not reach expected state');
}

test('POST acceptance persists only flags and streams the already opened response exactly once', async t => {
  let requests = 0;
  const bodySecret = Buffer.from('unique-body-secret-DO-NOT-STORE');
  const responseBytes = Buffer.alloc(128 * 1024, 107);
  const f = await fixture(t, async (req, res) => {
    requests++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bodySecret);
    assert.equal(req.headers.cookie, 'sid=unique-cookie-secret');
    res.writeHead(200, { 'Content-Length': responseBytes.length, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="export.bin"' });
    res.end(responseBytes);
  });
  const requestContext = { method: 'POST', headers: { Cookie: 'sid=unique-cookie-secret', Authorization: 'Bearer unique-auth-secret', 'Content-Type': 'application/octet-stream' }, bodyBase64: bodySecret.toString('base64') };
  const response = await prepareDownload(f.url, { requestContext });
  const job = await f.manager.addPrepared({ url: f.url, name: 'export.bin', requestContext }, response);
  assert.equal(job.method, 'POST'); assert.equal(job.connections, 1); assert.equal(job.needsSession, true); assert.equal(job.replayPolicy, 'single-response');
  const completed = await waitFor(f.manager, job.id, job => job.status === 'complete');
  assert.deepEqual(await readFile(completed.path), responseBytes);
  assert.equal(requests, 1);
  const serialized = JSON.stringify(f.manager.list()) + await readFile(join(f.directory, 'data', 'jobs.json'), 'utf8');
  for (const secret of ['unique-cookie-secret', 'unique-auth-secret', 'unique-body-secret', bodySecret.toString('base64')]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('requestContext'), false);
});

test('protected session jobs require recapture after restart and cannot silently resume without credentials', async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.end('file'); });
  const job = await f.manager.add({ url: f.url, startAt: new Date(Date.now() + 3600000).toISOString(), requestContext: { headers: { Cookie: 'sid=not-persisted' } } });
  await f.manager.close();
  const restored = await new DownloadManager(join(f.directory, 'data'), join(f.directory, 'files')).init();
  try {
    const protectedJob = restored.list().find(item => item.id === job.id);
    assert.equal(protectedJob.status, 'paused'); assert.equal(protectedJob.needsRecapture, true);
    await assert.rejects(restored.action(job.id, 'resume'), /التقاط جديد/);
    restored.pump();
    assert.equal(requests, 0);
    assert.equal((await readFile(join(f.directory, 'data', 'jobs.json'), 'utf8')).includes('not-persisted'), false);
  } finally { await restored.close(); }
});

test('pausing a POST never issues a replacement request on resume', async t => {
  let requests = 0;
  const payload = Buffer.alloc(256 * 1024, 42);
  const f = await fixture(t, (_req, res) => { requests++; res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); });
  f.manager.speedLimit = 65536;
  const requestContext = { method: 'POST', bodyBase64: 'AA==' };
  const response = await prepareDownload(f.url, { requestContext });
  const job = await f.manager.addPrepared({ url: f.url, requestContext }, response);
  await waitFor(f.manager, job.id, item => item.status === 'downloading');
  await f.manager.action(job.id, 'pause');
  const paused = f.manager.list().find(item => item.id === job.id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.needsRecapture, true);
  await assert.rejects(f.manager.action(job.id, 'resume'), /التقاط جديد/);
  assert.equal(requests, 1);
  const allPaths = await readdir(f.directory, { recursive: true });
  for (const path of allPaths.filter(path => path.endsWith('.json'))) {
    const text = await readFile(join(f.directory, path), 'utf8');
    assert.equal(text.includes('bodyBase64'), false);
    assert.equal(text.includes('requestContext'), false);
  }
});

test('POST queue rejects a missing retained response before acknowledging a job', async t => {
  const f = await fixture(t, (_req, res) => res.end());
  await assert.rejects(f.manager.add({ url: f.url, requestContext: { method: 'POST', bodyBase64: '' } }), /استجابة مؤكدة/);
  assert.equal(f.manager.list().length, 0);
});
