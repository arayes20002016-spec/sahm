import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DownloadManager } from '../src/manager.mjs';
import { ftpFixture } from './helpers/ftp-fixture.mjs';

const retryPolicy = { baseDelayMs: 50, maxDelayMs: 100, jitterMs: 0, maxAttempts: 5, maxElapsedMs: 20000 };
const video = 'https://www.youtube.com/watch?v=BaW_jenozKc';
async function waitFor(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(15); }
  throw new Error('Protocol recovery timed out: ' + label);
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-protocol-retry-')), managers = [];
  const create = async () => {
    const manager = await new DownloadManager(join(directory, 'profile'), join(directory, 'downloads'), { retryPolicy, ...options }).init();
    managers.push(manager); return manager;
  };
  const manager = await create();
  t.after(async () => {
    for (const value of managers) if (!value.stopped) await value.close();
    assert.equal(dirname(await realpath(directory)), await realpath(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, manager, create };
}
function state(manager, id) { return manager.list().find(job => job.id === id); }
async function pending(manager, id) {
  return waitFor(() => {
    const job = state(manager, id); assert.notEqual(job.status, 'error', job.error);
    return job.status === 'queued' && job.networkRetry && !manager.active.has(id) && !manager.pending.has(id) ? job : null;
  }, 'automatic wait');
}
async function complete(manager, id) {
  return waitFor(() => {
    const job = state(manager, id); assert.notEqual(job.status, 'error', job.error);
    return job.status === 'complete' && !manager.active.has(id) ? job : null;
  }, 'automatic completion');
}
function mediaFixture() {
  let online = false, attempts = 0;
  const payload = Buffer.from('completed media fixture');
  return {
    get attempts() { return attempts; }, payload,
    reconnect() { online = true; },
    service: { download: async (_url, path, { signal, onProgress }) => {
      signal.throwIfAborted(); attempts++;
      if (!online) throw Object.assign(new Error('temporary connection failure'), { code: 'media-network-error' });
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, payload);
      onProgress({ received: payload.length, total: payload.length });
      return { path, name: 'media.mkv', bytes: payload.length };
    } },
  };
}

for (const rest of [true, false]) test(`FTP ${rest ? 'authenticated REST resume' : 'non-REST restart'} completes automatically after a real socket interruption`, async t => {
  const cleanup = [], f = await ftpFixture({ after: close => cleanup.push(close) }, { rest, requireLogin: rest, chunkDelay: 10 });
  t.after(async () => { for (const close of cleanup) await close(); });
  const { manager } = await setup(t); manager.speedLimit = 128 * 1024;
  const login = { username: 'test-user', password: 'secret-ftp-password' };
  const job = await manager.add({ url: f.url, ...(rest ? { credentials: login } : {}) });
  await waitFor(() => state(manager, job.id).received >= 32768, 'FTP partial');
  f.interrupt(); await pending(manager, job.id);
  const checkpoint = JSON.parse(await readFile(job.path + '.ftp-resume.json', 'utf8'));
  assert.ok(checkpoint.received > 0); assert.equal(checkpoint.credentialScope, rest ? job.ftpCredentialScope : 'anonymous');
  f.reconnect(); const finished = await complete(manager, job.id);
  assert.deepEqual(await readFile(finished.path), f.original); assert.equal(finished.networkRetry, undefined);
  assert.equal(f.requests.some(request => request.command === 'REST' && Number(request.value) === checkpoint.received), rest);
  assert.doesNotMatch(await readFile(join(manager.directory, 'jobs.json'), 'utf8'), /secret-ftp-password|test-user/);
});

test('FTP authentication and invalid FTPS certificates stop without a reconnect budget', async t => {
  const { manager } = await setup(t);
  for (const mode of ['plain', 'explicit']) {
    const f = await ftpFixture(t, { mode, requireLogin: true });
    const job = await manager.add({ url: f.url, credentials: { username: 'test-user', password: 'wrong' }, ftpTLS: mode === 'plain' ? 'auto' : 'explicit' });
    await waitFor(() => state(manager, job.id).status === 'error' && !manager.active.has(job.id), 'terminal FTP failure');
    assert.equal(state(manager, job.id).networkRetry, undefined);
    const requests = f.requests.length; await delay(1200); assert.equal(f.requests.length, requests);
  }
});

test('FTP manual pause cancels automatic reconnection until explicitly resumed', async t => {
  const cleanup = [], f = await ftpFixture({ after: close => cleanup.push(close) }, { chunkDelay: 10 });
  t.after(async () => { for (const close of cleanup) await close(); });
  const { manager } = await setup(t); manager.speedLimit = 128 * 1024;
  const job = await manager.add({ url: f.url });
  await waitFor(() => state(manager, job.id).received > 0, 'partial FTP bytes');
  f.interrupt(); await pending(manager, job.id); await manager.action(job.id, 'pause');
  f.reconnect(); const requests = f.requests.length; await delay(1200);
  assert.equal(f.requests.length, requests); assert.equal(state(manager, job.id).status, 'paused');
  await manager.action(job.id, 'resume'); await complete(manager, job.id);
});

test('media reconnection completes without a resume command and respects queue and quota gates', async t => {
  const media = mediaFixture(); let exhausted = false;
  const { manager } = await setup(t, { mediaService: media.service, quota: { snapshot: () => ({ exhausted }), assertAvailable: async () => {} } });
  const job = await manager.addMedia({ url: video }); await pending(manager, job.id);
  await manager.queueAction('update', { id: 'default', settings: { enabled: false } });
  media.reconnect(); const attempts = media.attempts; await delay(1200); assert.equal(media.attempts, attempts);
  exhausted = true; await manager.queueAction('update', { id: 'default', settings: { enabled: true } });
  await delay(1200); assert.equal(media.attempts, attempts);
  exhausted = false; const finished = await complete(manager, job.id);
  assert.deepEqual(await readFile(finished.path), media.payload); assert.equal(finished.networkRetry, undefined);
});

test('media pause and remove cancel pending automatic attempts', async t => {
  const media = mediaFixture(), { manager } = await setup(t, { mediaService: media.service });
  const first = await manager.addMedia({ url: video }); await pending(manager, first.id);
  await manager.action(first.id, 'pause'); media.reconnect(); const attempts = media.attempts;
  await delay(1200); assert.equal(media.attempts, attempts); assert.equal(state(manager, first.id).status, 'paused');
  await manager.action(first.id, 'resume'); await complete(manager, first.id);
  const offline = mediaFixture(); manager.media = offline.service;
  const second = await manager.addMedia({ url: video }); await pending(manager, second.id);
  await manager.action(second.id, 'remove'); offline.reconnect(); const count = offline.attempts;
  await delay(1200); assert.equal(offline.attempts, count); assert.equal(state(manager, second.id), undefined);
});

test('media errors outside the recognized transport set are never retried', async t => {
  let attempts = 0;
  const { manager } = await setup(t, { mediaService: { download: async () => { attempts++; throw Object.assign(new Error('output disk full'), { code: 'ENOSPC' }); } } });
  const job = await manager.addMedia({ url: video });
  await waitFor(() => state(manager, job.id).status === 'error' && !manager.active.has(job.id), 'media terminal failure');
  await delay(1200); assert.equal(attempts, 1); assert.equal(state(manager, job.id).networkRetry, undefined);
});

test('a persisted media retry survives process loss but explicit exit keeps it paused', async t => {
  const media = mediaFixture(), f = await setup(t, { mediaService: media.service });
  const job = await f.manager.addMedia({ url: video }); await pending(f.manager, job.id);
  await f.manager.saving; clearInterval(f.manager.timer); f.manager.stopped = true;
  const restored = await f.create(); assert.ok(state(restored, job.id).networkRetry);
  await restored.close(); media.reconnect(); const again = await f.create(), attempts = media.attempts;
  await delay(1200); assert.equal(media.attempts, attempts); assert.equal(state(again, job.id).status, 'paused');
  await again.action(job.id, 'resume'); await complete(again, job.id);
});

for (const kind of ['ftp', 'media']) test(`${kind} automatic retry exhausts its budget and explicit resume starts a new one`, async t => {
  const media = mediaFixture(), options = { retryPolicy: { ...retryPolicy, maxAttempts: 2 }, ...(kind === 'media' ? { mediaService: media.service } : {}) };
  const { manager } = await setup(t, options);
  const ftp = kind === 'ftp' ? await ftpFixture(t) : null; ftp?.interrupt();
  const job = kind === 'ftp' ? await manager.add({ url: ftp.url }) : await manager.addMedia({ url: video });
  await waitFor(() => state(manager, job.id).status === 'error' && !manager.active.has(job.id), 'retry exhaustion');
  assert.equal(state(manager, job.id).networkRetry, undefined); assert.match(state(manager, job.id).error, /حد المحاولات/);
  if (kind === 'media') assert.equal(media.attempts, 3);
  ftp?.reconnect(); media.reconnect(); await delay(1200); assert.equal(state(manager, job.id).status, 'error');
  await manager.action(job.id, 'resume'); const result = await complete(manager, job.id);
  assert.deepEqual(await readFile(result.path), ftp ? ftp.original : media.payload);
});
