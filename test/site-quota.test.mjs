import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaStore } from '../src/quota.mjs';
import { SiteCopies } from '../src/site-copies.mjs';
import { readSiteMirror, runSiteMirror } from '../src/site-mirror.mjs';

async function fixture(t, { robots = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-site-quota-'));
  const html = Buffer.from('<!doctype html><html><img src="/image.png"><p>offline</p></html>');
  const image = Buffer.alloc(32 * 1024, 42);
  const requests = [], managers = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/robots.txt') {
      response.writeHead(robots === null ? 404 : 200, { 'content-type': 'text/plain' });
      response.end(robots || ''); return;
    }
    const body = request.url === '/image.png' ? image : html;
    response.writeHead(200, { 'content-type': request.url === '/image.png' ? 'image/png' : 'text/html', 'content-length': body.length });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { for (const manager of managers) if (!manager.closed) await manager.close(); }
    finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory, html, image, requests, url: `http://127.0.0.1:${server.address().port}`,
    async copies(quota) {
      const copies = await new SiteCopies(join(directory, 'state'), join(directory, 'downloads'), { quota, fetchImpl: quota.wrapFetch(globalThis.fetch) }).init();
      managers.push(copies); return copies;
    }
  };
}

async function settled(copies, id, predicate) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const job = copies.list().find(value => value.id === id);
    if (predicate(job) && !copies.active.has(id)) return job;
    if (job?.state === 'error') assert.fail(job.error);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Site quota did not settle: ${JSON.stringify(copies.list())}`);
}

test('site copy charges each body once, keeps quota-interrupted assets pending, and completes after durable renewal', async t => {
  const f = await fixture(t);
  let now = Date.now();
  const quotaDirectory = join(f.directory, 'quota');
  const quota = await new QuotaStore(quotaDirectory, { now: () => now }).init();
  const limit = f.html.length + 7;
  await quota.configure({ enabled: true, limitBytes: limit, periodHours: 1 });
  const copies = await f.copies(quota);
  const job = await copies.add({ url: f.url, options: { concurrency: 1 } });
  const paused = await settled(copies, job.id, value => value.state === 'paused' && value.quotaHeld);
  const manifest = await readSiteMirror(job.directory);
  assert.equal(paused.failed, 0); assert.equal(manifest.state, 'paused');
  assert.equal(manifest.resources.find(resource => resource.url.endsWith('/image.png')).state, 'pending');
  assert.equal(manifest.resources.filter(resource => resource.state === 'failed').length, 0);
  assert.equal(quota.snapshot().usedBytes, limit, 'quota is not charged again by SiteCopies');
  assert.equal(manifest.stats.bytes, f.html.length);
  await copies.close();
  const restoredQuota = await new QuotaStore(quotaDirectory, { now: () => now }).init();
  const restored = await f.copies(restoredQuota);
  restored.pump(); assert.equal(restored.active.size, 0);
  const count = f.requests.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.requests.length, count);
  now = restoredQuota.snapshot().resetAt;
  await restoredQuota.refresh();
  await restoredQuota.configure({ enabled: true, limitBytes: 128 * 1024, periodHours: 1 });
  restored.pump();
  const completed = await settled(restored, job.id, value => value.state === 'complete');
  assert.equal(completed.quotaHeld, false); assert.equal(completed.failed, 0);
  assert.equal(f.requests.filter(path => path === '/').length, 1, 'completed root is reused at renewal');
  assert.equal(f.requests.filter(path => path === '/image.png').length, 2);
  assert.equal(restoredQuota.snapshot().usedBytes, f.image.length);
  const final = await readSiteMirror(job.directory);
  const asset = final.resources.find(resource => resource.url.endsWith('/image.png'));
  assert.deepEqual(await readFile(join(job.directory, asset.path)), f.image);
  assert.match(await readFile(join(job.directory, 'index.html'), 'utf8'), /offline/);
  assert.equal(final.stats.bytes, f.html.length + f.image.length);
});

test('quota errors while reading robots are propagated without a false robots rejection or failed resource', async t => {
  const f = await fixture(t, { robots: 'User-agent: *\nAllow: /\n' });
  const quota = await new QuotaStore(join(f.directory, 'quota')).init();
  await quota.configure({ enabled: true, limitBytes: 9, periodHours: 1 });
  const target = join(f.directory, 'robots-copy');
  await assert.rejects(runSiteMirror(f.url, target, { fetchImpl: quota.wrapFetch(globalThis.fetch), options: { concurrency: 1 } }), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  const manifest = await readSiteMirror(target);
  assert.equal(manifest.state, 'paused'); assert.equal(manifest.resources[0].state, 'pending');
  assert.equal(manifest.stats.failed, 0); assert.equal(manifest.errors.length, 0);
  assert.deepEqual(f.requests, ['/robots.txt']);
  assert.equal(quota.snapshot().usedBytes, 9);
});

test('a user pause clears a site quota hold and prevents automatic renewal from resuming it', async t => {
  const f = await fixture(t);
  let now = Date.now();
  const quota = await new QuotaStore(join(f.directory, 'quota'), { now: () => now }).init();
  await quota.configure({ enabled: true, limitBytes: 5, periodHours: 1 });
  const copies = await f.copies(quota);
  const job = await copies.add({ url: f.url, options: { concurrency: 1 } });
  await settled(copies, job.id, value => value.state === 'paused' && value.quotaHeld);
  await copies.action(job.id, 'pause');
  assert.equal(copies.list()[0].quotaHeld, false);
  const count = f.requests.length;
  now = quota.snapshot().resetAt;
  await quota.refresh(); await quota.configure({ enabled: true, limitBytes: 128 * 1024, periodHours: 1 });
  copies.pump(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(copies.list()[0].state, 'paused'); assert.equal(copies.active.size, 0);
  assert.equal(f.requests.length, count);
});
