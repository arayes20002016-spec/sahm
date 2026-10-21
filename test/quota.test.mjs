import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaStore, normalizeQuotaConfig } from '../src/quota.mjs';

const HOUR = 3600000;
async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-quota-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await new QuotaStore(directory, options).init() };
}

test('quota is opt-in, validates bounds, and exposes immutable snapshots', async t => {
  const { store } = await fixture(t);
  assert.equal(store.snapshot().config.enabled, false);
  assert.equal(await store.consume(1000), 1000);
  assert.equal(store.snapshot().usedBytes, 0);
  for (const input of [{ enabled: 1 }, { limitBytes: 0 }, { limitBytes: Number.MAX_SAFE_INTEGER + 1 }, { periodHours: 0 }, { periodHours: 8761 }, { periodHours: 1.5 }, { unknown: true }]) assert.throws(() => normalizeQuotaConfig(input));
  const snapshot = store.snapshot(); snapshot.config.limitBytes = 0;
  assert.ok(store.snapshot().config.limitBytes > 0);
  await assert.rejects(store.consume(-1)); await assert.rejects(store.consume(0.2));
});

test('grants are serialized, partial grants never exceed the durable limit, and restart retains usage', async t => {
  const { directory, store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 24 });
  let exhausted = 0;
  store.on('exhausted', () => exhausted++);
  const grants = await Promise.allSettled([store.consume(6), store.consume(6), store.consume(6)]);
  assert.deepEqual(grants.map(result => result.status === 'fulfilled' ? result.value : result.reason.code), [6, 4, 'DOWNLOAD_QUOTA_EXCEEDED']);
  assert.equal(exhausted, 1);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).usedBytes, 10);
  const restored = await new QuotaStore(directory).init();
  assert.equal(restored.snapshot().usedBytes, 10);
  await assert.rejects(restored.consume(1), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
});

test('disable and limit changes preserve usage; disabled transfers do not add usage', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 24 });
  await store.consume(6);
  await store.configure({ enabled: false, limitBytes: 10, periodHours: 24 });
  assert.equal(await store.consume(100), 100);
  assert.equal(store.snapshot().usedBytes, 6);
  await store.configure({ enabled: true, limitBytes: 5, periodHours: 24 });
  assert.equal(store.snapshot().exhausted, true);
  await assert.rejects(store.consume(1), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  await store.configure({ enabled: true, limitBytes: 20, periodHours: 24 });
  assert.equal(store.snapshot().usedBytes, 6);
  assert.equal(await store.consume(20), 14);
});

test('the first duration takes effect immediately, while a spent window keeps its deadline until renewal', async t => {
  let time = 1000;
  const { directory, store } = await fixture(t, { now: () => time });
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 1 });
  const firstReset = store.snapshot().resetAt;
  assert.equal(firstReset, 1000 + HOUR);
  await store.consume(10);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 2 });
  assert.equal(store.snapshot().usedBytes, 10);
  assert.equal(store.snapshot().resetAt, firstReset);
  let renewed = 0; store.on('renewed', () => renewed++);
  time = firstReset - 1; await store.refresh();
  assert.equal(store.snapshot().usedBytes, 10);
  time = firstReset; await store.refresh();
  assert.equal(store.snapshot().usedBytes, 0);
  assert.equal(store.snapshot().resetAt, firstReset + 2 * HOUR);
  assert.equal(renewed, 1);
  await store.consume(3);
  time += 100 * HOUR + 100;
  await store.refresh();
  assert.equal(store.snapshot().windowStart, firstReset + 100 * HOUR);
  assert.equal(renewed, 2);
  const restored = await new QuotaStore(directory, { now: () => time }).init();
  assert.deepEqual(restored.snapshot(), store.snapshot());
});

test('changing an unused duration after clock rollback preserves the forward anchor', async t => {
  let time = 100000;
  const { store } = await fixture(t, { now: () => time });
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 1 });
  assert.equal(store.snapshot().resetAt, 100000 + HOUR);
  time = 100;
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 2 });
  assert.equal(store.snapshot().windowStart, 100000);
  assert.equal(store.snapshot().resetAt, 100000 + 2 * HOUR);
  assert.equal(store.snapshot().usedBytes, 0);
});

test('clock rollback cannot create a fresh quota, including after restart', async t => {
  let time = 100000;
  const { directory, store } = await fixture(t, { now: () => time });
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 1 });
  await store.consume(8);
  time = 100;
  await store.refresh();
  assert.equal(store.snapshot().usedBytes, 8);
  assert.equal(store.snapshot().windowStart, 100000);
  const restored = await new QuotaStore(directory, { now: () => time }).init();
  assert.equal(await restored.consume(5), 2);
  await assert.rejects(restored.consume(1), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
});

test('a failed write delivers no grant, preserves the old checkpoint, and retries safely', async t => {
  const { directory, store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 24 });
  await store.consume(3);
  const write = store.writeState;
  store.writeState = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(store.consume(4), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  assert.equal(store.snapshot().usedBytes, 3);
  assert.equal(store.snapshot().exhausted, true);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).usedBytes, 3);
  await assert.rejects(store.consume(1), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  store.writeState = write;
  await store.refresh();
  assert.equal(store.snapshot().storageError, null);
  assert.equal(await store.consume(7), 7);
  assert.equal((await new QuotaStore(directory).init()).snapshot().usedBytes, 10);
});

test('unreadable or invalid stored ledgers fail closed without replacement', async t => {
  const { directory, store } = await fixture(t);
  const broken = '{"version":1,"usedBytes":0}';
  await writeFile(store.file, broken);
  const restored = new QuotaStore(directory);
  await assert.rejects(restored.init(), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  assert.equal(restored.snapshot().exhausted, true);
  await assert.rejects(restored.consume(1), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  await assert.rejects(restored.configure({ enabled: false }), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  assert.equal(await readFile(store.file, 'utf8'), broken);
});

test('an aborted queued consumer never spends its reservation', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 24 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.consume(5, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.snapshot().usedBytes, 0);
});

test('a real filesystem write failure preserves the last ledger and blocks grants', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 10, periodHours: 24 });
  await store.consume(4);
  const saved = await readFile(store.file, 'utf8');
  await mkdir(store.file + '.tmp');
  await assert.rejects(store.consume(3), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  assert.equal(await readFile(store.file, 'utf8'), saved);
  assert.equal(store.snapshot().usedBytes, 4);
});

test('fetch wrapping preserves metadata, executes POST once, delivers a partial grant, and cancels upstream', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 5, periodHours: 24 });
  let requests = 0, cancelled = 0;
  const fetch = store.wrapFetch(async (_input, init) => {
    requests++; assert.equal(init.method, 'POST'); assert.equal(init.body, 'only once');
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6, 7])); },
      cancel() { cancelled++; }
    }), { status: 206, statusText: 'Partial Content', headers: { 'content-length': '7', 'x-proof': 'kept' } });
    Object.defineProperty(response, 'url', { value: 'https://example.com/final.zip' });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  const response = await fetch('https://example.com/submit', { method: 'POST', body: 'only once' });
  assert.equal(response.url, 'https://example.com/final.zip'); assert.equal(response.status, 206);
  assert.equal(response.redirected, true); assert.equal(response.headers.get('x-proof'), 'kept');
  assert.equal(response.headers.get('content-length'), '7');
  assert.equal(store.snapshot().usedBytes, 0, 'unread payload is not charged');
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([4, 5]));
  await assert.rejects(reader.read(), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  assert.equal(cancelled, 1); assert.equal(requests, 1); assert.equal(store.snapshot().usedBytes, 5);
  await assert.rejects(fetch('https://example.com/new'), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  assert.equal(requests, 1);
});

test('a response ending at exactly the quota succeeds, and body helpers still work', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 5, periodHours: 24 });
  const fetch = store.wrapFetch(async () => new Response('hello'));
  assert.equal(await (await fetch('https://example.com')).text(), 'hello');
  assert.equal(store.snapshot().usedBytes, 5);
});

test('response clones preserve URL metadata and charge the source once', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 5, periodHours: 24 });
  const fetch = store.wrapFetch(async () => {
    const response = new Response('hello');
    Object.defineProperty(response, 'url', { value: 'https://example.com/final' });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  const response = await fetch('https://example.com');
  const clone = response.clone();
  assert.equal(clone.url, 'https://example.com/final'); assert.equal(clone.redirected, true);
  assert.deepEqual(await Promise.all([response.text(), clone.text()]), ['hello', 'hello']);
  assert.equal(store.snapshot().usedBytes, 5);
});

test('simultaneous bodies share one durable allowance', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 5, periodHours: 24 });
  const fetch = store.wrapFetch(async () => new Response(new Uint8Array([1, 2, 3, 4])));
  const responses = await Promise.all([fetch('https://example.com/a'), fetch('https://example.com/b')]);
  let bytes = 0, rejected = 0;
  await Promise.all(responses.map(async response => {
    const reader = response.body.getReader();
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; } }
    catch (error) { assert.equal(error.code, 'DOWNLOAD_QUOTA_EXCEEDED'); rejected++; }
  }));
  assert.equal(bytes, 5); assert.equal(rejected, 1); assert.equal(store.snapshot().usedBytes, 5);
});

test('storage failure cancels the upstream before any unaccounted bytes are delivered', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 20, periodHours: 24 });
  let cancelled = 0;
  const fetch = store.wrapFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel() { cancelled++; }
  })));
  const response = await fetch('https://example.com');
  store.writeState = async () => { throw new Error('cannot write'); };
  await assert.rejects(response.body.getReader().read(), { code: 'DOWNLOAD_QUOTA_STORAGE_ERROR' });
  assert.equal(cancelled, 1); assert.equal(store.snapshot().usedBytes, 0);
});

test('bodyless responses and consumer cancellation remain valid', async t => {
  const { store } = await fixture(t);
  await store.configure({ enabled: true, limitBytes: 20, periodHours: 24 });
  const head = new Response(null, { status: 204 });
  assert.equal(await store.wrapFetch(async () => head)('https://example.com'), head);
  let cancelled = 0;
  const fetch = store.wrapFetch(async () => new Response(new ReadableStream({ cancel() { cancelled++; } })));
  const response = await fetch('https://example.com'); await response.body.cancel();
  assert.equal(cancelled, 1); assert.equal(store.snapshot().usedBytes, 0);
});
