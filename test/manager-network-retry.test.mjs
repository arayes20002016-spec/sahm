import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DownloadManager } from '../src/manager.mjs';
import { prepareDownload } from '../src/download.mjs';
import { stressDownloadFixture } from '../scripts/lib/stress-download-fixture.mjs';

const retryPolicy = { baseDelayMs: 50, maxDelayMs: 100, jitterMs: 0, maxAttempts: 8, maxElapsedMs: 20000 };
async function waitFor(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(15); }
  throw new Error('Network retry test timed out: ' + description);
}
async function fixture(t, options = {}) {
  const server = await stressDownloadFixture({ bytes: 256 * 1024, intervalMs: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'sahm-automatic-reconnect-')), managers = [];
  const create = async (overrides = {}) => {
    const manager = await new DownloadManager(join(directory, 'profile'), join(directory, 'downloads'), { retryPolicy, ...options, ...overrides }).init();
    manager.speedLimit = 256 * 1024; managers.push(manager); return manager;
  };
  const manager = await create();
  t.after(async () => {
    try { for (const item of managers) if (!item.stopped) await item.close(); }
    finally { await server.close(); assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); }
  });
  return { ...server, directory, manager, create };
}
async function waiting(manager, id) {
  return waitFor(() => { const job = manager.list().find(job => job.id === id); assert.notEqual(job.status, 'error', job.error); return job.networkRetry && job.status === 'queued' && !manager.active.has(id) ? job : null; }, 'automatic waiting');
}
async function complete(manager, id) {
  return waitFor(() => { const job = manager.list().find(job => job.id === id); assert.notEqual(job.status, 'error', job.error); return job.status === 'complete' && !manager.active.has(id) ? job : null; }, 'automatic completion');
}

for (const mode of ['stable', 'plain']) {
  test(`a disconnected ${mode === 'plain' ? 'non-range stream restarts' : 'ranged download resumes'} automatically without any resume action`, async t => {
    const f = await fixture(t), source = f.add(1, mode, true);
    const added = await f.manager.add({ url: source.url, connections: 1 });
    await waitFor(() => f.manager.jobs[0].received >= 65536, 'real partial bytes');
    f.interrupt(); const held = await waiting(f.manager, added.id);
    assert.equal(f.manager.active.size, 0);
    const checkpoint = JSON.parse(await readFile(added.path + '.resume.json', 'utf8'));
    assert.ok(checkpoint.parts.some(part => part.done > 0));
    const requestIndex = f.requests.length;
    f.reconnect(); f.release();
    const result = await complete(f.manager, added.id);
    assert.equal(result.networkRetry, undefined); assert.deepEqual(await readFile(result.path), source.payload);
    if (mode !== 'plain') assert.ok(f.requests.slice(requestIndex).some(request => !request.probe && request.start === checkpoint.parts[0].done));
    else assert.ok(f.requests.slice(requestIndex).some(request => !request.probe && request.start === 0));
    assert.equal(held.networkRetry.attempt, 1);
  });
}

test('manual pause cancels a pending reconnect until the user resumes', async t => {
  const f = await fixture(t), source = f.add(2, 'stable', true);
  const job = await f.manager.add({ url: source.url, connections: 1 });
  await waitFor(() => f.manager.jobs[0].received > 0, 'partial'); f.interrupt(); await waiting(f.manager, job.id);
  await f.manager.action(job.id, 'pause'); const requests = f.requests.length;
  f.reconnect(); f.release(); await delay(1200);
  assert.equal(f.requests.length, requests); assert.equal(f.manager.jobs[0].status, 'paused'); assert.equal(f.manager.jobs[0].networkRetry, undefined);
  assert.equal(f.manager.jobs[0].error, null);
  await f.manager.action(job.id, 'resume'); await complete(f.manager, job.id);
});

test('queue disable and download quota each prevent a due reconnect from starting', async t => {
  let exhausted = false;
  const quota = { snapshot: () => ({ exhausted }), assertAvailable: async () => {} };
  const f = await fixture(t, { quota }), source = f.add(3, 'stable', true);
  const job = await f.manager.add({ url: source.url, connections: 1 });
  await waitFor(() => f.manager.jobs[0].received > 0, 'partial'); f.interrupt(); await waiting(f.manager, job.id);
  await f.manager.queueAction('update', { id: 'default', settings: { enabled: false } });
  f.reconnect(); f.release(); const requests = f.requests.length; await delay(1200);
  assert.equal(f.requests.length, requests);
  exhausted = true; await f.manager.queueAction('update', { id: 'default', settings: { enabled: true } }); await delay(1200);
  assert.equal(f.requests.length, requests);
  exhausted = false; await complete(f.manager, job.id);
});

test('closing the app while awaiting connection persists a manual pause across restart', async t => {
  const f = await fixture(t), source = f.add(4, 'stable', true);
  const job = await f.manager.add({ url: source.url, connections: 1 });
  await waitFor(() => f.manager.jobs[0].received > 0, 'partial'); f.interrupt(); await waiting(f.manager, job.id);
  await f.manager.close(); f.reconnect(); f.release();
  const restored = await f.create(), requests = f.requests.length; await delay(1200);
  assert.equal(restored.jobs[0].status, 'paused'); assert.equal(restored.jobs[0].networkRetry, undefined); assert.equal(f.requests.length, requests);
  await restored.action(job.id, 'resume'); await complete(restored, job.id);
});

test('a waiting connection releases the only download slot for another server', async t => {
  const f = await fixture(t); f.manager.parallel = 1; f.interrupt();
  const offline = f.add(5, 'stable'); const first = await f.manager.add({ url: offline.url }); await waiting(f.manager, first.id);
  const healthy = await stressDownloadFixture({ bytes: 64 * 1024, intervalMs: 1 }); t.after(() => healthy.close());
  const source = healthy.add(6, 'stable'), second = await f.manager.add({ url: source.url });
  await complete(f.manager, second.id); assert.notEqual(f.manager.jobs.find(job => job.id === first.id).status, 'complete');
  f.reconnect(); await complete(f.manager, first.id);
});

test('reconnect attempt exhaustion is bounded and an explicit resume starts a new budget', async t => {
  const f = await fixture(t, { retryPolicy: { ...retryPolicy, maxAttempts: 2 } }), source = f.add(7, 'stable'); f.interrupt();
  const job = await f.manager.add({ url: source.url });
  await waitFor(() => f.manager.jobs[0].status === 'error' && !f.manager.active.size, 'bounded exhaustion');
  assert.equal(f.manager.jobs[0].networkRetry, undefined); assert.match(f.manager.jobs[0].error, /حد المحاولات/);
  const requests = f.requests.length; await delay(1200); assert.equal(f.requests.length, requests);
  f.reconnect(); await f.manager.action(job.id, 'resume'); await complete(f.manager, job.id);
});

test('a captured POST interrupted during its response is never retried automatically', async t => {
  const f = await fixture(t), source = f.add(8, 'stable', true);
  const context = { method: 'POST', bodyBase64: Buffer.from('single server operation').toString('base64') };
  const response = await prepareDownload(source.url, { requestContext: context });
  const job = await f.manager.addPrepared({ url: source.url, requestContext: context }, response);
  await waitFor(() => f.manager.jobs[0].received > 0, 'POST response bytes'); f.interrupt();
  await waitFor(() => f.manager.jobs[0].status === 'error' && !f.manager.active.size, 'POST failure');
  assert.equal(f.manager.jobs[0].networkRetry, undefined); assert.equal(f.manager.jobs[0].needsRecapture, true);
  f.reconnect(); f.release(); await delay(1200); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'POST');
  await assert.rejects(f.manager.action(job.id, 'resume'), /التقاط جديد/);
});

test('permanent HTTP failures stay errors, and Retry-After schedules without holding a slot', async t => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url); response.writeHead(request.url === '/missing' ? 404 : 429, request.url === '/rate' ? { 'Retry-After': '60' } : {}); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t, { retryPolicy: { ...retryPolicy, maxElapsedMs: 120000 } }), origin = 'http://127.0.0.1:' + server.address().port;
  const missing = await f.manager.add({ url: origin + '/missing' });
  await waitFor(() => f.manager.jobs.find(job => job.id === missing.id).status === 'error', '404');
  assert.equal(f.manager.jobs.find(job => job.id === missing.id).networkRetry, undefined);
  const began = Date.now(), rate = await f.manager.add({ url: origin + '/rate' }), pending = await waiting(f.manager, rate.id);
  assert.ok(pending.networkRetry.nextAt >= began + 60000); assert.equal(f.manager.active.size, 0);
  assert.deepEqual(calls, ['/missing', '/rate']);
});

test('removing a job awaiting reconnection cannot start an orphaned download later', async t => {
  const f = await fixture(t), source = f.add(9, 'stable'); f.interrupt();
  const job = await f.manager.add({ url: source.url }); await waiting(f.manager, job.id);
  await f.manager.action(job.id, 'remove'); const requests = f.requests.length;
  f.reconnect(); await delay(1200);
  assert.equal(f.manager.jobs.length, 0); assert.equal(f.manager.active.size, 0); assert.equal(f.requests.length, requests);
});

test('failure to persist reconnection stops automatic work and reports storage failure', async t => {
  const f = await fixture(t), source = f.add(10, 'stable', true), errors = [];
  f.manager.on('storage-error', message => errors.push(message));
  const job = await f.manager.add({ url: source.url, connections: 1 });
  await waitFor(() => f.manager.jobs[0].received > 0, 'partial');
  const save = f.manager.save;
  f.manager.save = async function () {
    if (this.jobs.some(job => job.networkRetry)) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return save.call(this);
  };
  f.interrupt(); await waitFor(() => f.manager.jobs[0].status === 'error' && !f.manager.active.size, 'storage failure');
  assert.equal(f.manager.jobs[0].networkRetry, undefined); assert.equal(errors.length, 1);
  f.manager.save = save; f.reconnect(); f.release(); const requests = f.requests.length; await delay(1200);
  assert.equal(f.requests.length, requests); assert.match(f.manager.jobs[0].error, /حفظ انتظار/);
  await f.manager.action(job.id, 'resume'); await complete(f.manager, job.id);
});

test('a due reconnect cannot outrun a slow checkpoint that later fails', async t => {
  const f = await fixture(t), source = f.add(12, 'stable', true), errors = [];
  f.manager.on('storage-error', message => errors.push(message));
  const job = await f.manager.add({ url: source.url, connections: 1 });
  await waitFor(() => f.manager.jobs[0].received > 0, 'partial');
  const save = f.manager.save;
  let rejectCheckpoint, intercepted = false;
  const checkpoint = new Promise((_, reject) => { rejectCheckpoint = reject; });
  f.manager.save = function () {
    if (!intercepted && this.jobs.some(job => job.networkRetry)) {
      intercepted = true;
      this.saving = this.saving.catch(() => {}).then(() => checkpoint);
      return this.saving;
    }
    return save.call(this);
  };
  try {
    f.interrupt(); await waiting(f.manager, job.id);
    f.reconnect(); f.release(); const requests = f.requests.length;
    await delay(150); f.manager.pump();
    const startedBeforeCommit = f.manager.active.has(job.id);
    rejectCheckpoint(Object.assign(new Error('fixture slow disk full'), { code: 'ENOSPC' }));
    await waitFor(() => errors.length > 0, 'delayed storage failure');
    await delay(1200);
    assert.equal(startedBeforeCommit, false, 'A pending checkpoint must block a due automatic attempt');
    assert.equal(f.requests.length, requests); assert.equal(f.manager.jobs[0].status, 'error');
    assert.equal(f.manager.jobs[0].networkRetry, undefined); assert.equal(errors.length, 1);
    f.manager.save = save;
    await f.manager.action(job.id, 'resume'); await complete(f.manager, job.id);
  } finally { f.manager.save = save; rejectCheckpoint(new Error('fixture cleanup')); }
});

test('a retry whose elapsed budget expired during suspension cannot open another connection', async t => {
  const f = await fixture(t), source = f.add(11, 'stable'); f.manager.stopped = true;
  const added = await f.manager.add({ url: source.url, startAt: new Date(Date.now() + 3600000).toISOString() });
  const job = f.manager.jobs.find(job => job.id === added.id), now = Date.now();
  job.networkRetry = { attempt: 1, startedAt: now - retryPolicy.maxElapsedMs - 100, nextAt: now - 50 };
  f.manager.stopped = false; f.manager.pump(); await f.manager.saving;
  assert.equal(job.status, 'error'); assert.equal(job.networkRetry, undefined); assert.match(job.error, /مهلة إعادة الاتصال/);
  assert.equal(f.requests.length, 0);
});
