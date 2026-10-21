import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteCopies } from '../src/site-copies.mjs';
import { QuotaStore } from '../src/quota.mjs';
import { normalizeSiteSchedule } from '../src/site-revisions.mjs';

async function waitFor(predicate) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Site schedule did not settle');
}
async function fixture(t, { quota = false, privateSession = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-site-schedule-'));
  const state = { version: 1, failing: false, expired: false, now: 2000000000000, requests: [], holding: false, release: null, overlaps: 0, active: 0, peak: 0 };
  const server = createServer(async (request, response) => {
    state.active++; state.peak = Math.max(state.active, state.peak);
    response.once('close', () => { state.active--; });
    if (state.holding && request.url === '/') { state.overlaps++; await new Promise(resolve => { state.release = resolve; }); }
    if (state.expired) { response.writeHead(401); response.end('login'); return; }
    const image = request.url === '/image.png';
    const etag = `"${image ? 'image' : request.url}-v${state.version}"`;
    const status = state.failing && image ? 503 : request.headers['if-none-match'] === etag ? 304 : 200;
    state.requests.push({ path: request.url, status, conditional: request.headers['if-none-match'] || null });
    response.writeHead(status, { 'Content-Type': image ? 'image/png' : 'text/html', ETag: etag });
    if (status !== 200) { response.end(); return; }
    response.end(image ? Buffer.alloc(2048, state.version) : request.url === '/' ? `<h1>Version ${state.version}</h1><img src="/image.png">${state.extraLink || ''}${state.version === 1 ? '<a href="/old.html">Old page</a>' : ''}` : '<h1>Old page</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const ledger = quota ? await new QuotaStore(join(directory, 'quota')).init() : null;
  const browserService = privateSession ? {
    get(id) { return id === 'runtime-session' ? { origin: new URL(url).origin } : null; },
    async createRunner() { return { fetch, async close() {} }; }
  } : undefined;
  const service = await new SiteCopies(directory, directory, { now: () => state.now, quota: ledger, fetchImpl: ledger ? ledger.wrapFetch(fetch) : fetch, browserService }).init();
  t.after(async () => { state.release?.(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const add = schedule => service.add({ url, options: { respectRobots: false }, ...(privateSession ? { sessionId: 'runtime-session' } : {}), ...(schedule === null ? {} : { schedule: schedule || { enabled: true, intervalMinutes: 1 } }) });
  const idle = async id => waitFor(() => !service.active.has(id) && service.jobs.find(job => job.id === id)?.state !== 'queued');
  return { directory, state, server, service, ledger, url, add, idle };
}

test('site schedule validates intervals and rejects unknown or malformed fields', () => {
  for (const value of [null, [], {}, { enabled: 'yes', intervalMinutes: 1 }, { enabled: true, intervalMinutes: 0 }, { enabled: true, intervalMinutes: 10081 }, { enabled: true, intervalMinutes: 1, cookie: 'secret' }]) assert.throws(() => normalizeSiteSchedule(value));
  assert.deepEqual(normalizeSiteSchedule({ enabled: true, intervalMinutes: 10080 }), { enabled: true, intervalMinutes: 10080 });
});

test('a periodic crawl publishes changed pages and images atomically, removes stale links and retains the prior offline snapshot', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id), initial = await readFile(join(first.directory, 'index.html'), 'utf8');
  assert.match(initial, /Version 1/);
  f.state.version = 2; f.state.now += 60000; f.service.pump(); await f.idle(job.id);
  const current = await f.service.entry(job.id), previous = await f.service.entry(job.id, 'previous');
  assert.notEqual(current.directory, first.directory); assert.equal(previous.directory, first.directory);
  assert.match(await readFile(join(current.directory, 'index.html'), 'utf8'), /Version 2/);
  assert.doesNotMatch(await readFile(join(current.directory, 'index.html'), 'utf8'), /Old page/);
  assert.equal(await readFile(join(previous.directory, 'index.html'), 'utf8'), initial);
  assert.ok(f.service.jobs[0].lastCycle.updated >= 2); assert.equal(f.service.jobs[0].lastCycle.removed, 1);
  const revision = f.service.jobs[0].publishedRevision;
  f.state.now += 60000; f.service.pump(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].publishedRevision, revision);
  assert.equal(f.service.jobs[0].lastCycle.notModified, 2);
  assert.equal(f.service.jobs[0].lastCycle.updated, 0);
});

test('a failed resource never replaces the published snapshot, and a later complete cycle recovers', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id);
  f.state.version = 2; f.state.failing = true;
  await f.service.action(job.id, 'check'); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'partial');
  assert.equal((await f.service.entry(job.id)).directory, first.directory);
  f.state.failing = false; f.state.now += 60000; f.service.pump(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'complete');
  assert.notEqual((await f.service.entry(job.id)).directory, first.directory);
});
test('intentional scope exclusions keep their partial report but do not prevent publishing a valid in-scope snapshot', async t => {
  const f = await fixture(t); f.state.extraLink = '<a href="https://outside.example.test/">External site</a>';
  const job = await f.add(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'partial');
  assert.ok(f.service.jobs[0].publishedRevision);
  assert.match(await readFile(join((await f.service.entry(job.id)).directory, 'index.html'), 'utf8'), /Version 1/);
});

test('local edits stop periodic publication and remain intact', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id), file = join(first.directory, 'index.html');
  const original = await readFile(file, 'utf8'); await writeFile(file, original + '<p>My local edit</p>');
  f.state.version = 2; f.state.now += 60000; f.service.pump(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'conflict'); assert.equal(f.service.jobs[0].schedule.enabled, false);
  assert.match(await readFile(file, 'utf8'), /My local edit/);
  assert.equal((await f.service.entry(job.id)).directory, first.directory);
  await assert.rejects(f.service.updateSchedule(job.id, { enabled: true, intervalMinutes: 1 }), /محليًا/);
  await writeFile(file, original);
  await f.service.updateSchedule(job.id, { enabled: true, intervalMinutes: 1 }); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'complete');
});

test('an edit made while the next cycle downloads also blocks the final publication', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id), file = join(first.directory, 'index.html');
  f.state.version = 2; f.state.holding = true;
  await f.service.action(job.id, 'check'); await waitFor(() => f.state.release);
  await writeFile(file, '<h1>Edited during crawl</h1>'); f.state.holding = false; f.state.release();
  await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'conflict');
  assert.equal((await f.service.entry(job.id)).directory, first.directory);
  assert.match(await readFile(file, 'utf8'), /Edited during crawl/);
});

test('quota interruption preserves the old snapshot and resumes the staged cycle without publishing partial data', async t => {
  const f = await fixture(t, { quota: true }), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id), before = f.ledger.snapshot().usedBytes;
  await f.ledger.configure({ enabled: true, limitBytes: before + 256, periodHours: 24 });
  f.state.version = 2;
  await f.service.action(job.id, 'check'); await f.idle(job.id);
  assert.equal(f.service.jobs[0].quotaHeld, true); assert.equal(f.service.jobs[0].state, 'paused');
  assert.equal((await f.service.entry(job.id)).directory, first.directory);
  await f.ledger.configure({ enabled: false, limitBytes: before + 256, periodHours: 24 });
  f.service.pump(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'complete');
  assert.notEqual((await f.service.entry(job.id)).directory, first.directory);
});

test('manual check does not enable a paused schedule and a manual pause cannot be undone by the clock', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  await f.service.action(job.id, 'pause');
  const requests = f.state.requests.length;
  f.state.now += 600000; f.service.pump(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.requests.length, requests);
  await f.service.action(job.id, 'check'); await f.idle(job.id);
  assert.equal(f.service.jobs[0].schedule.enabled, false); assert.equal(f.service.jobs[0].nextRunAt, null);
});

test('missed intervals start only one cycle and repeated ticks cannot overlap it', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  f.state.version = 2; f.state.holding = true; f.state.now += 10 * 60000;
  f.service.pump(); await waitFor(() => f.state.release);
  for (let index = 0; index < 10; index++) f.service.pump();
  assert.equal(f.state.overlaps, 1); assert.equal(f.service.active.size, 1);
  await assert.rejects(f.service.updateSchedule(job.id, { enabled: true, intervalMinutes: 2 }), /أوقف/);
  f.state.holding = false; f.state.release(); await f.idle(job.id);
  assert.equal(Date.parse(f.service.jobs[0].nextRunAt), f.state.now + 60000);
});

test('a legacy completed copy can adopt a schedule without altering its original files', async t => {
  const f = await fixture(t), job = await f.add(null); await f.idle(job.id);
  const original = await readFile(join(job.directory, 'index.html'), 'utf8');
  f.state.version = 2;
  await f.service.updateSchedule(job.id, { enabled: true, intervalMinutes: 1 }); await f.idle(job.id);
  assert.equal(f.service.jobs[0].previousRevision, 'legacy');
  assert.equal(await readFile(join(job.directory, 'index.html'), 'utf8'), original);
  assert.match(await readFile(join((await f.service.entry(job.id)).directory, 'index.html'), 'utf8'), /Version 2/);
});

test('session expiration keeps the published private copy and restart stores no reusable session', async t => {
  const f = await fixture(t, { privateSession: true }), job = await f.add(); await f.idle(job.id);
  const first = await f.service.entry(job.id);
  f.state.expired = true; await f.service.action(job.id, 'check'); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'needs-session');
  assert.equal((await f.service.entry(job.id)).directory, first.directory);
  await f.service.close();
  const restored = await new SiteCopies(f.directory, f.directory, { now: () => f.state.now, browserService: f.service.browserService }).init();
  t.after(() => restored.close());
  assert.equal(restored.list()[0].sessionAvailable, false);
  assert.doesNotMatch(await readFile(join(f.directory, 'site-copies.json'), 'utf8'), /runtime-session/);
  f.state.expired = false;
});

test('publication storage failure rolls back the current revision pointer', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id);
  const old = f.service.jobs[0].publishedRevision, save = f.service.save.bind(f.service); let fail = true;
  f.service.save = async () => { if (fail && f.service.jobs[0].publishedRevision !== old) { fail = false; throw new Error('disk write failed'); } return save(); };
  f.state.version = 2; await f.service.action(job.id, 'check'); await f.idle(job.id);
  assert.equal(f.service.jobs[0].publishedRevision, old); assert.equal(f.service.jobs[0].state, 'error');
  assert.equal(JSON.parse(await readFile(join(f.directory, 'site-copies.json'), 'utf8'))[0].publishedRevision, old);
});

test('a junction in the revision parent is rejected before anything is written outside the project', async t => {
  const f = await fixture(t); f.service.networkChanging = true;
  const job = await f.add(), outside = join(f.directory, 'outside');
  await mkdir(job.directory, { recursive: true }); await mkdir(outside);
  await symlink(outside, join(job.directory, '.sahm-site-versions'), process.platform === 'win32' ? 'junction' : 'dir');
  f.service.networkChanging = false; f.service.pump(); await f.idle(job.id);
  assert.equal(f.service.jobs[0].state, 'conflict'); assert.deepEqual(await readdir(outside), []);
});
test('a completed public schedule survives restart and repairs a missing next-run pointer', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id); await f.service.close();
  const file = join(f.directory, 'site-copies.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  saved[0].nextRunAt = null; await writeFile(file, JSON.stringify(saved));
  const restored = await new SiteCopies(f.directory, f.directory, { now: () => f.state.now, fetchImpl: fetch }).init();
  t.after(() => restored.close());
  assert.equal(Date.parse(restored.jobs[0].nextRunAt), f.state.now);
  f.state.version = 2; restored.pump(); await waitFor(() => !restored.active.size && restored.jobs[0].state === 'complete');
  assert.match(await readFile(join((await restored.entry(job.id)).directory, 'index.html'), 'utf8'), /Version 2/);
});
test('a forged staging directory cannot point at the legacy or current published snapshot', async t => {
  const f = await fixture(t), job = await f.add(); await f.idle(job.id); await f.service.close();
  const file = join(f.directory, 'site-copies.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  for (const staging of ['legacy', saved[0].publishedRevision, '../../outside']) {
    saved[0].stagingRevision = staging; await writeFile(file, JSON.stringify(saved));
    await assert.rejects(new SiteCopies(f.directory, f.directory).init());
  }
});
