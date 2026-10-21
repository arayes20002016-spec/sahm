import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncService, normalizeSyncEntries, normalizeSyncUrl } from '../src/synchronization.mjs';
import { QuotaStore } from '../src/quota.mjs';

const initialTime = Date.UTC(2026, 9, 18, 12);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, message = 'synchronization state') {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(10); }
  throw new Error(`Timed out: ${message}`);
}
async function fixture(t, handler) {
  const requests = [], server = createServer((req, res) => { requests.push({ url: req.url, headers: req.headers }); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function service(t, options = {}) {
  const directory = options.root || await mkdtemp(join(tmpdir(), 'sahm-sync-'));
  const sync = await new SyncService(join(directory, 'state'), join(directory, 'downloads'), { now: () => initialTime, ...options }).init();
  const close = sync.close.bind(sync); let closing;
  sync.close = () => closing ||= close();
  t.after(() => sync.close());
  return { sync, directory };
}
async function settle(sync) { await waitFor(() => sync.active.size === 0); await sync.saving; return sync.list()[0]; }
async function run(sync, id) { await sync.action(id, 'run'); return settle(sync); }
async function fileContents(project, index = 0) { return readFile(join(project.directory, project.entries[index].filename), 'utf8'); }

test('synchronization validates public URLs, file names, collisions, and bounded project configuration', async t => {
  for (const url of ['ftp://example.com/a', 'http://user:pass@example.com/a', 'https://example.com/a?token=x', 'https://example.com/a?X-Amz-Signature=x', 'https://example.com/a?api_key=x', 'https://example.com/a?sessionid=x', 'not a url']) assert.throws(() => normalizeSyncUrl(url));
  assert.equal(normalizeSyncUrl('https://example.com/a?version=2#part'), 'https://example.com/a?version=2');
  for (const name of ['../x', 'CON.zip', 'a:b', '.sahm-sync', 'a.', 'a\\b']) assert.throws(() => normalizeSyncEntries([{ url: 'https://example.com/a', filename: name }]));
  const names = normalizeSyncEntries(['https://example.com/a/file.zip', 'https://example.com/b/file.zip']);
  assert.equal(names[0].filename, 'file.zip'); assert.equal(names[1].filename, '2-file.zip');
  const collisions = normalizeSyncEntries(['https://example.com/3-file', 'https://example.com/a/file', 'https://example.com/b/file']);
  assert.equal(new Set(collisions.map(entry => entry.filename.toLowerCase())).size, 3);
  assert.throws(() => normalizeSyncEntries(['https://example.com/a', 'https://example.com/a']));
  const { sync } = await service(t);
  for (const input of [{ intervalMinutes: 0 }, { intervalMinutes: 10081 }, { method: 'POST' }, { name: '' }, { enabled: 1 }, { queueId: '../x' }]) await assert.rejects(sync.add({ urls: ['https://example.com/file'], enabled: false, ...input }));
});

test('initial download, ETag 304, changed content, and previous-version backup preserve exact bytes', async t => {
  let body = 'version one', etag = '"one"';
  const f = await fixture(t, (req, res) => {
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { ETag: etag, 'Content-Type': 'application/octet-stream' }); res.end(body);
  });
  const { sync } = await service(t);
  let project = await sync.add({ urls: f.url + '/file.bin', enabled: false });
  project = await run(sync, project.id);
  assert.equal(project.updatedFiles, 1); assert.equal(await fileContents(project), 'version one');
  project = await run(sync, project.id);
  assert.equal(project.unchangedFiles, 1); assert.equal(project.receivedBytes, 0); assert.equal(f.requests[1].headers['if-none-match'], '"one"');
  body = 'version two changed'; etag = '"two"';
  project = await run(sync, project.id);
  assert.equal(project.updatedFiles, 1); assert.equal(await fileContents(project), body);
  assert.equal(await readFile(join(project.directory, project.entries[0].previousVersion), 'utf8'), 'version one');
  assert.equal((await readdir(join(project.directory, '.sahm-sync', 'staging'))).length, 0);
});

test('missing and weak validators download and hash the body instead of trusting weak byte identity', async t => {
  let weak = false, body = 'same content';
  const f = await fixture(t, (req, res) => { if (weak) res.setHeader('ETag', 'W/"weak"'); res.end(body); });
  const { sync } = await service(t);
  let project = await sync.add({ urls: [f.url + '/file.bin'], enabled: false });
  project = await run(sync, project.id); project = await run(sync, project.id);
  assert.equal(project.unchangedFiles, 1); assert.equal(project.receivedBytes, Buffer.byteLength(body));
  weak = true;
  project = await run(sync, project.id); body = 'different bytes, same weak validator'; project = await run(sync, project.id);
  assert.equal(project.updatedFiles, 1); assert.equal(await fileContents(project), body);
  assert.ok(f.requests.every(request => request.headers['if-none-match'] === undefined));
});

test('Last-Modified is used when a strong ETag is unavailable', async t => {
  const modified = 'Sun, 18 Oct 2026 11:00:00 GMT';
  const f = await fixture(t, (req, res) => {
    if (req.headers['if-modified-since'] === modified) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Last-Modified': modified, ETag: 'W/"weak"' }); res.end('modified fixture');
  });
  const { sync } = await service(t);
  const added = await sync.add({ urls: [f.url + '/file.bin'], enabled: false });
  await run(sync, added.id); const project = await run(sync, added.id);
  assert.equal(project.unchangedFiles, 1); assert.equal(f.requests[1].headers['if-modified-since'], modified);
});

test('local edits and unrelated existing files stop synchronization without any silent overwrite', async t => {
  const f = await fixture(t, (req, res) => res.end('remote bytes'));
  const { sync } = await service(t);
  let project = await sync.add({ urls: [f.url + '/file.bin'], enabled: false });
  project = await run(sync, project.id);
  await writeFile(join(project.directory, 'file.bin'), 'my local edit');
  const count = f.requests.length; project = await run(sync, project.id);
  assert.equal(project.state, 'conflict'); assert.equal(project.errorCode, 'SYNC_LOCAL_CONFLICT'); assert.equal(project.enabled, false);
  assert.equal(await fileContents(project), 'my local edit'); assert.equal(f.requests.length, count);
});

test('a local edit made while the server checks 304 is detected immediately', async t => {
  let checking;
  const f = await fixture(t, (req, res) => {
    if (req.headers['if-none-match']) { checking = () => { res.writeHead(304); res.end(); }; return; }
    res.writeHead(200, { ETag: '"one"' }); res.end('original');
  });
  const { sync } = await service(t);
  let project = await sync.add({ urls: [f.url + '/file.bin'], enabled: false }); project = await run(sync, project.id);
  await sync.action(project.id, 'run'); await waitFor(() => checking);
  await writeFile(join(project.directory, 'file.bin'), 'local during request'); checking(); project = await settle(sync);
  assert.equal(project.state, 'conflict'); assert.equal(await fileContents(project), 'local during request');
});

test('a failed or truncated replacement leaves the prior complete file and no active partial', async t => {
  let fail = false;
  const f = await fixture(t, (req, res) => {
    if (fail) { res.writeHead(200, { 'Content-Length': 100 }); res.write('incomplete'); setTimeout(() => res.destroy(), 30); }
    else res.end('complete first version');
  });
  const { sync } = await service(t);
  let project = await sync.add({ urls: [f.url + '/file.bin'], enabled: false }); project = await run(sync, project.id);
  fail = true; project = await run(sync, project.id);
  assert.equal(project.state, 'error'); assert.equal(await fileContents(project), 'complete first version');
  assert.equal((await readdir(join(project.directory, '.sahm-sync', 'staging'))).length, 0);
});

test('scheduled projects persist, run once when overdue, and calculate the next cycle after completion', async t => {
  let now = initialTime;
  const f = await fixture(t, (req, res) => res.end('scheduled'));
  const first = await service(t, { now: () => now });
  let project = await first.sync.add({ name: 'دوري', urls: [f.url + '/daily.bin'], intervalMinutes: 5 });
  project = await settle(first.sync);
  assert.equal(Date.parse(project.nextRunAt), now + 5 * 60000); assert.equal(f.requests.length, 1);
  await first.sync.close(); now += 5 * 86400000;
  const restored = await service(t, { root: first.directory, now: () => now });
  assert.equal(restored.sync.active.size, 0); restored.sync.pump(); project = await settle(restored.sync);
  assert.equal(f.requests.length, 2); assert.equal(Date.parse(project.nextRunAt), now + 5 * 60000);
  restored.sync.pump(); await sleep(30); assert.equal(f.requests.length, 2);
});

test('manual pause survives application restart and a manual one-off run does not enable periodic execution', async t => {
  let now = initialTime;
  const f = await fixture(t, (req, res) => res.end('one off'));
  const first = await service(t, { now: () => now });
  let project = await first.sync.add({ urls: [f.url + '/a'], intervalMinutes: 1 }); await settle(first.sync);
  await first.sync.action(project.id, 'pause'); await first.sync.close(); now += 86400000;
  const restored = await service(t, { root: first.directory, now: () => now });
  restored.sync.pump(); await sleep(30); assert.equal(f.requests.length, 1);
  project = await run(restored.sync, project.id); assert.equal(project.enabled, false); assert.equal(project.state, 'paused'); assert.equal(project.nextRunAt, null);
  now += 86400000; restored.sync.pump(); await sleep(30); assert.equal(f.requests.length, 2);
});

test('queue schedules block starts and stop an active transfer safely until the queue opens', async t => {
  let allowed = false, slow = false, release;
  const f = await fixture(t, (req, res) => {
    if (slow) { res.write('partial'); release = () => res.end(' more'); }
    else res.end('first');
  });
  const { sync } = await service(t, { canRun: queueId => { assert.equal(queueId, 'test-queue'); return allowed; } });
  let project = await sync.add({ urls: [f.url + '/a'], queueId: 'test-queue' });
  assert.equal(sync.list()[0].state, 'blocked'); assert.equal(f.requests.length, 0);
  allowed = true; sync.pump(); project = await settle(sync); assert.equal(await fileContents(project), 'first');
  slow = true; await sync.action(project.id, 'run'); await waitFor(() => release);
  allowed = false; sync.pump(); project = await settle(sync);
  assert.equal(project.state, 'blocked'); assert.equal(project.errorCode, 'SYNC_QUEUE_CLOSED'); assert.equal(await fileContents(project), 'first');
  release(); slow = false; allowed = true; sync.pump(); project = await settle(sync); assert.equal(project.state, 'idle');
});

test('global concurrency is two, no project overlaps, and elapsed intervals do not cause a catch-up storm', async t => {
  let now = initialTime;
  const blocked = new Map();
  const f = await fixture(t, (req, res) => { res.write('start'); blocked.set(req.url, () => res.end('end')); });
  const { sync } = await service(t, { now: () => now });
  const a = await sync.add({ urls: [f.url + '/a'], intervalMinutes: 1 });
  await sync.add({ urls: [f.url + '/b'], intervalMinutes: 1 }); await sync.add({ urls: [f.url + '/c'], intervalMinutes: 1 });
  await waitFor(() => blocked.size === 2); assert.equal(sync.active.size, 2);
  now += 10 * 60000; for (let n = 0; n < 10; n++) sync.pump(); assert.equal(f.requests.length, 2);
  await assert.rejects(sync.action(a.id, 'run'), /بالفعل/);
  blocked.get('/a')(); await waitFor(() => blocked.has('/c')); blocked.get('/b')(); blocked.get('/c')();
  await settle(sync); assert.equal(f.requests.length, 3);
  sync.pump(); await sleep(30); assert.equal(f.requests.length, 3);
});

test('quota-backed fetch charges each byte once, preserves an old file at exhaustion, and retries after renewal', async t => {
  let now = initialTime, body = 'old';
  const f = await fixture(t, (req, res) => res.end(body));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-sync-quota-'));
  const quota = await new QuotaStore(join(directory, 'quota'), { now: () => now }).init();
  await quota.configure({ enabled: true, limitBytes: 8, periodHours: 1 });
  const { sync } = await service(t, { root: directory, now: () => now, quota, fetchImpl: quota.wrapFetch(fetch) });
  let project = await sync.add({ urls: [f.url + '/a'], intervalMinutes: 1 }); project = await settle(sync);
  assert.equal(quota.snapshot().usedBytes, 3); assert.equal(await fileContents(project), 'old');
  body = 'new version with more bytes'; await sync.action(project.id, 'run'); project = await settle(sync);
  assert.equal(project.state, 'blocked'); assert.equal(project.quotaHeld, true); assert.equal(quota.snapshot().usedBytes, 8); assert.equal(await fileContents(project), 'old');
  const count = f.requests.length; for (let i = 0; i < 5; i++) sync.pump(); await sleep(30); assert.equal(f.requests.length, count);
  now = quota.snapshot().resetAt; await quota.refresh(); await quota.configure({ enabled: true, limitBytes: 100, periodHours: 1 });
  sync.pump(); project = await settle(sync); assert.equal(await fileContents(project), body); assert.equal(quota.snapshot().usedBytes, Buffer.byteLength(body));
});

test('a file that ends exactly at its quota is promoted successfully without a second charge', async t => {
  const f = await fixture(t, (req, res) => res.end('12345678'));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-sync-exact-quota-'));
  const quota = await new QuotaStore(join(directory, 'quota'), { now: () => initialTime }).init();
  await quota.configure({ enabled: true, limitBytes: 8, periodHours: 1 });
  const { sync } = await service(t, { root: directory, quota, fetchImpl: quota.wrapFetch(fetch) });
  let project = await sync.add({ urls: [f.url + '/a'] }); project = await settle(sync);
  assert.equal(project.state, 'idle'); assert.equal(await fileContents(project), '12345678'); assert.equal(quota.snapshot().usedBytes, 8);
});

test('HTTP errors back off with a bound and updating schedules validates without altering project files', async t => {
  let now = initialTime;
  const f = await fixture(t, (req, res) => { res.writeHead(503); res.end(); });
  const { sync } = await service(t, { now: () => now });
  let project = await sync.add({ urls: [f.url + '/a'], intervalMinutes: 1 }); project = await settle(sync);
  assert.equal(project.state, 'error'); assert.equal(Date.parse(project.nextRunAt), now + 2 * 60000);
  sync.pump(); await sleep(30); assert.equal(f.requests.length, 1);
  now = Date.parse(project.nextRunAt); sync.pump(); project = await settle(sync);
  assert.equal(Date.parse(project.nextRunAt), now + 4 * 60000);
  const original = project.entries;
  await sync.update(project.id, { name: 'جدول جديد', intervalMinutes: 60 }); assert.deepEqual(sync.list()[0].entries, original);
  await assert.rejects(sync.update(project.id, { urls: [f.url + '/other'] }));
  await assert.rejects(sync.update(project.id, { intervalMinutes: -1 }));
});

test('redirects use the supplied transport, strip cross-origin validators, and refuse secret URLs before dispatch', async t => {
  const target = await fixture(t, (req, res) => res.end('redirect destination'));
  const f = await fixture(t, (req, res) => { res.writeHead(302, { Location: target.url + '/a?token=do-not-follow' }); res.end(); });
  let calls = 0;
  const { sync } = await service(t, { fetchImpl: (url, init) => { calls++; assert.equal(init.redirect, 'manual'); return fetch(url, init); } });
  let project = await sync.add({ urls: [f.url + '/a'], enabled: false }); project = await run(sync, project.id);
  assert.equal(project.state, 'error'); assert.equal(calls, 1); assert.equal(target.requests.length, 0);
});

test('removing a project keeps every downloaded file and restarting an interrupted enabled project schedules only one retry', async t => {
  let slow = false;
  const f = await fixture(t, (req, res) => { if (slow) res.write('partial'); else res.end('saved'); });
  const first = await service(t);
  let project = await first.sync.add({ urls: [f.url + '/a'] }); project = await settle(first.sync);
  slow = true; await first.sync.action(project.id, 'run'); await waitFor(() => f.requests.length === 2);
  await first.sync.close(); assert.equal(first.sync.list()[0].enabled, true);
  slow = false; const restored = await service(t, { root: first.directory }); restored.sync.pump(); project = await settle(restored.sync);
  assert.equal(f.requests.length, 3); assert.equal(project.state, 'idle');
  await restored.sync.action(project.id, 'remove'); assert.deepEqual(restored.sync.list(), []); assert.equal(await fileContents(project), 'saved');
});

test('a folder with unowned content is preserved and invalid durable records fail closed', async t => {
  const { sync, directory } = await service(t);
  let project = await sync.add({ urls: ['https://example.com/a'], enabled: false });
  await mkdir(project.directory, { recursive: true }); await writeFile(join(project.directory, 'a'), 'unrelated');
  project = await run(sync, project.id); assert.equal(project.state, 'error'); assert.equal(await fileContents(project), 'unrelated');
  await sync.close(); const records = JSON.parse(await readFile(join(directory, 'state', 'synchronization.json'), 'utf8'));
  records[0].entries[0].filename = '../escape'; await writeFile(join(directory, 'state', 'synchronization.json'), JSON.stringify(records));
  await assert.rejects(new SyncService(join(directory, 'state'), join(directory, 'downloads')).init());
});

test('cross-origin redirects discard cached validators and still compare the final bytes', async t => {
  const destination = await fixture(t, (req, res) => { res.writeHead(200, { ETag: '"destination"' }); res.end('redirected bytes'); });
  const source = await fixture(t, (req, res) => { res.writeHead(302, { Location: destination.url + '/file.bin' }); res.end(); });
  const { sync } = await service(t);
  const added = await sync.add({ urls: [source.url + '/file.bin'], enabled: false });
  await run(sync, added.id); const project = await run(sync, added.id);
  assert.equal(project.unchangedFiles, 1); assert.equal(source.requests[1].headers['if-none-match'], '"destination"');
  assert.ok(destination.requests.every(request => request.headers['if-none-match'] === undefined));
});

test('a missing local file is downloaded without validators and an unsolicited 304 fails closed', async t => {
  let invalid = true;
  const f = await fixture(t, (req, res) => {
    if (invalid) { res.writeHead(304); res.end(); }
    else { res.writeHead(200, { ETag: '"one"' }); res.end('valid'); }
  });
  const { sync } = await service(t);
  let project = await sync.add({ urls: [f.url + '/a'], enabled: false }); project = await run(sync, project.id);
  assert.equal(project.state, 'error'); assert.equal(project.entries[0].sha256, null);
  invalid = false; project = await run(sync, project.id); assert.equal(await fileContents(project), 'valid');
  assert.ok(f.requests.every(request => request.headers['if-none-match'] === undefined));
});

test('failed durable additions never start network work and a failed schedule change rolls back in memory', async t => {
  const f = await fixture(t, (req, res) => res.end('stored'));
  const { sync } = await service(t);
  const save = sync.save.bind(sync);
  sync.save = async () => { throw new Error('synthetic checkpoint failure'); };
  await assert.rejects(sync.add({ urls: [f.url + '/a'] }), /checkpoint failure/);
  assert.deepEqual(sync.list(), []); assert.equal(f.requests.length, 0);
  sync.save = save;
  const project = await sync.add({ urls: [f.url + '/a'], enabled: false });
  sync.save = async () => { throw new Error('synthetic checkpoint failure'); };
  await assert.rejects(sync.update(project.id, { intervalMinutes: 10, name: 'changed' }), /checkpoint failure/);
  assert.equal(sync.list()[0].name, project.name); assert.equal(sync.list()[0].intervalMinutes, project.intervalMinutes);
  sync.save = save;
});

test('pausing a quota-held project prevents automatic renewal from restarting it', async t => {
  let now = initialTime;
  const f = await fixture(t, (req, res) => res.end('larger than quota'));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-sync-paused-quota-'));
  const quota = await new QuotaStore(join(directory, 'quota'), { now: () => now }).init();
  await quota.configure({ enabled: true, limitBytes: 2, periodHours: 1 });
  const { sync } = await service(t, { root: directory, now: () => now, quota, fetchImpl: quota.wrapFetch(fetch) });
  const project = await sync.add({ urls: [f.url + '/a'] }); await settle(sync);
  assert.equal(sync.list()[0].state, 'blocked'); await sync.action(project.id, 'pause');
  now = quota.snapshot().resetAt; await quota.refresh(); sync.pump(); await sleep(30);
  assert.equal(f.requests.length, 1); assert.equal(sync.list()[0].enabled, false); assert.equal(sync.list()[0].state, 'paused');
});
