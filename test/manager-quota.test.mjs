import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DownloadManager } from '../src/manager.mjs';
import { QuotaStore } from '../src/quota.mjs';
import { setTransportFetch } from '../src/transport.mjs';
import { requestDownload } from '../src/request-context.mjs';

async function fixture(t, { size = 4 * 1024 ** 2, missing } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-manager-quota-'));
  const payload = Buffer.alloc(size);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
  const requests = [], managers = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, method: request.method, range: request.headers.range });
    for await (const _ of request) { /* Consume the captured POST once. */ }
    if (request.url === '/missing.bin' && missing) {
      await missing(); response.writeHead(404); response.end(); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : payload.length - 1;
    const headers = { 'content-length': end - start + 1, etag: '"quota-manager-v1"', 'accept-ranges': 'bytes' };
    if (match) headers['content-range'] = `bytes ${start}-${end}/${payload.length}`;
    response.writeHead(match ? 206 : 200, headers);
    let position = start;
    const write = () => {
      if (response.destroyed) return;
      if (position > end) { response.end(); return; }
      const next = Math.min(position + 16384, end + 1);
      response.write(payload.subarray(position, next)); position = next;
      timer = setTimeout(write, 1);
    };
    let timer; response.on('close', () => clearTimeout(timer)); write();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { for (const manager of managers) if (!manager.stopped) await manager.close(); }
    finally {
      setTransportFetch(globalThis.fetch);
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory, payload, requests, url: `http://127.0.0.1:${server.address().port}`,
    async manager(quota) {
      const manager = await new DownloadManager(join(directory, 'data'), join(directory, 'downloads'), { quota }).init();
      managers.push(manager); return manager;
    }
  };
}

async function waitFor(manager, id, predicate) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const job = manager.list().find(value => value.id === id);
    if (predicate(job) && !manager.active.has(id)) return job;
    if (job?.status === 'error') assert.fail(job.error);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Quota job did not settle: ${JSON.stringify(manager.list().find(value => value.id === id))}`);
}

test('manager persists exact quota-held HTTP offsets, renews after restart, and leaves manual pauses alone', async t => {
  const f = await fixture(t);
  let now = Date.now();
  const quota = await new QuotaStore(join(f.directory, 'quota'), { now: () => now }).init();
  const limit = 123 * 1024;
  await quota.configure({ enabled: true, limitBytes: limit, periodHours: 1 });
  setTransportFetch(quota.wrapFetch(globalThis.fetch));
  const first = await f.manager(quota);
  const manual = await first.add({ url: f.url + '/manual.bin', startAt: new Date(Date.now() + 3600000).toISOString() });
  await first.action(manual.id, 'pause');
  const job = await first.add({ url: f.url + '/file.bin', connections: 1 });
  const held = await waitFor(first, job.id, value => value.status === 'paused' && value.quotaHeld);
  assert.equal(held.received, limit); assert.equal(quota.snapshot().usedBytes, limit);
  const checkpoint = JSON.parse(await readFile(job.path + '.resume.json', 'utf8'));
  assert.equal(checkpoint.parts.reduce((sum, part) => sum + part.done, 0), limit);
  assert.deepEqual((await readFile(job.path + '.part')).subarray(0, limit), f.payload.subarray(0, limit));
  await first.close();
  const restoredQuota = await new QuotaStore(join(f.directory, 'quota'), { now: () => now }).init();
  setTransportFetch(restoredQuota.wrapFetch(globalThis.fetch));
  const restored = await f.manager(restoredQuota);
  assert.equal(restored.list().find(value => value.id === job.id).quotaHeld, true);
  restored.pump();
  assert.equal(restored.active.size, 0, 'spent persisted allowance blocks restarting the request');
  now = restoredQuota.snapshot().resetAt;
  await restoredQuota.refresh(); restored.pump();
  const heldAgain = await waitFor(restored, job.id, value => value.status === 'paused' && value.quotaHeld && value.received > limit);
  assert.equal(heldAgain.received, limit * 2);
  assert.equal(restoredQuota.snapshot().usedBytes, limit);
  assert.ok(f.requests.some(request => request.range?.startsWith(`bytes=${limit}-`)));
  assert.equal(restored.list().find(value => value.id === manual.id).status, 'paused');
  assert.equal(f.requests.some(request => request.url === '/manual.bin'), false);
  await restoredQuota.configure({ enabled: true, limitBytes: f.payload.length, periodHours: 1 });
  restored.pump();
  const completed = await waitFor(restored, job.id, value => value.status === 'complete');
  assert.deepEqual(await readFile(completed.path), f.payload);
  assert.equal(limit + restoredQuota.snapshot().usedBytes, f.payload.length, 'resuming offsets are not charged again');
});

test('a POST stopped by quota requires browser recapture and is never replayed at renewal', async t => {
  const f = await fixture(t, { size: 512 * 1024 });
  let now = Date.now();
  const quota = await new QuotaStore(join(f.directory, 'quota'), { now: () => now }).init();
  await quota.configure({ enabled: true, limitBytes: 123 * 1024, periodHours: 1 });
  setTransportFetch(quota.wrapFetch(globalThis.fetch));
  const manager = await f.manager(quota);
  const requestContext = { method: 'POST', bodyBase64: Buffer.from('create one export').toString('base64') };
  const preparedResponse = await requestDownload(f.url + '/export', { requestContext });
  const job = await manager.add({ url: f.url + '/export', requestContext }, { preparedResponse });
  const stopped = await waitFor(manager, job.id, value => value.status === 'paused' && value.needsRecapture);
  assert.equal(stopped.quotaHeld, false); assert.equal(stopped.received, 123 * 1024);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  now = quota.snapshot().resetAt;
  await quota.refresh(); manager.pump();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(manager.list()[0].status, 'paused');
  await assert.rejects(manager.action(job.id, 'resume'), /التقاط/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('an actual HTTP 404 remains an error when another transfer spends the quota while it waits', async t => {
  let began, finish;
  const requested = new Promise(resolve => { began = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { missing: async () => { began(); await released; } });
  const quota = await new QuotaStore(join(f.directory, 'quota')).init();
  await quota.configure({ enabled: true, limitBytes: 1000, periodHours: 1 });
  setTransportFetch(quota.wrapFetch(globalThis.fetch));
  const manager = await f.manager(quota);
  const job = await manager.add({ url: f.url + '/missing.bin', connections: 1 });
  let timeout;
  try {
    await Promise.race([requested, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('404 request did not start')), 5000); })]);
    await quota.consume(1000);
  } finally { clearTimeout(timeout); finish(); }
  const failed = await waitFor(manager, job.id, value => value.status === 'error');
  assert.equal(failed.quotaHeld, false);
  assert.match(failed.error, /HTTP 404/);
  assert.equal(f.requests.filter(request => request.url === '/missing.bin').length, 1);
});
