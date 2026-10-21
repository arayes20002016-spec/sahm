import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DownloadManager } from '../src/manager.mjs';

const bytes = Buffer.from('test download with exact bytes');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-rules-manager-'));
  let requests = 0;
  const server = createServer((_req, response) => { requests++; response.setHeader('Content-Length', bytes.length); response.end(bytes); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = await new DownloadManager(join(directory, 'data'), join(directory, 'downloads'), options).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, url: `http://127.0.0.1:${server.address().port}/source.zip`, get requests() { return requests; } };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Manager did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('manager uses ordered download rules and an explicit directory overrides the rule directory', async t => {
  const f = await fixture(t), destination = join(f.directory, 'rule-target'), explicit = join(f.directory, 'manual-target');
  f.manager.downloadRules = [{ name: 'مصادر مضغوطة', extensions: ['zip', 'tar.gz'], directory: destination }];
  const future = new Date(Date.now() + 3600000).toISOString();
  const automatic = await f.manager.add({ url: f.url, startAt: future });
  const manual = await f.manager.add({ url: f.url, name: 'test.ZIP', directory: explicit, startAt: future });
  assert.equal(automatic.category, 'مصادر مضغوطة'); assert.ok(automatic.path.startsWith(destination));
  assert.equal(manual.category, 'مصادر مضغوطة'); assert.ok(manual.path.startsWith(explicit));
  assert.equal(f.requests, 0);
  await f.manager.action(automatic.id, 'resume');
  await waitFor(() => f.manager.list().find(job => job.id === automatic.id)?.status === 'complete');
  assert.deepEqual(await readFile(automatic.path), bytes);
});

test('media rules choose the initial destination and classify the actual resulting extension', async t => {
  const media = { download: async (_url, target) => {
    const path = target.replace(/\.mkv$/, '.webm'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    return { path, name: 'Video.webm', bytes: bytes.length };
  } };
  const f = await fixture(t, { mediaService: media });
  const destination = join(f.directory, 'video-target');
  f.manager.downloadRules = [{ name: 'الفيديو المدمج', extensions: ['mkv'], directory: destination }, { name: 'ويب', extensions: ['webm'], directory: join(f.directory, 'unused') }];
  const added = await f.manager.addMedia({ url: 'https://www.youtube.com/watch?v=BaW_jenozKc', title: 'Video' });
  assert.equal(added.category, 'الفيديو المدمج'); assert.ok(added.path.startsWith(destination));
  await waitFor(() => f.manager.list()[0].status === 'complete');
  const completed = f.manager.list()[0]; assert.equal(completed.category, 'ويب'); assert.ok(completed.path.startsWith(destination));
  assert.deepEqual(await readFile(completed.path), bytes);
});

test('disabled scanning never calls the injected scanner and records skipped rather than clean', async t => {
  let calls = 0;
  const f = await fixture(t, { scanner() { calls++; throw new Error('must not run'); } });
  const job = await f.manager.add({ url: f.url });
  await waitFor(() => !f.manager.active.has(job.id));
  assert.equal(calls, 0); assert.equal(f.manager.list()[0].status, 'complete');
  assert.equal(f.manager.list()[0].scanResult.status, 'skipped');
});

test('scanner runs only after publication and sanitized results survive reload', async t => {
  const seen = [];
  const f = await fixture(t, { scannerConfig: { enabled: true }, scanner: async (path, config, { signal }) => {
    seen.push({ content: await readFile(path), config, aborted: signal.aborted });
    return { status: 'clean', code: 'scan-clean', exitCode: 0, output: 'DO-NOT-PERSIST', path: 'private-name', scannedAt: 'private-text' };
  } });
  const job = await f.manager.add({ url: f.url });
  await waitFor(() => !f.manager.active.has(job.id));
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].content, bytes); assert.equal(seen[0].aborted, false);
  const result = f.manager.list()[0]; assert.equal(result.status, 'complete'); assert.equal(result.scanResult.status, 'clean');
  await f.manager.saving;
  const saved = await readFile(join(f.directory, 'data', 'jobs.json'), 'utf8');
  assert.doesNotMatch(saved, /DO-NOT-PERSIST|private-name|private-text/);
  assert.equal(JSON.parse(saved)[0].scanResult.exitCode, 0);
});

test('scanner errors and rejected clean claims never change a completed download to failed or clean', async t => {
  const f = await fixture(t, { scannerConfig: { enabled: true }, scanner: async () => { throw new Error('PRIVATE-PROGRAM-ERROR'); } });
  const job = await f.manager.add({ url: f.url }); await waitFor(() => !f.manager.active.has(job.id));
  assert.equal(f.manager.list()[0].status, 'complete'); assert.equal(f.manager.list()[0].scanResult.status, 'error');
  f.manager.scanner = async () => ({ status: 'clean', code: 'scan-program-unavailable', exitCode: 2 });
  const other = await f.manager.add({ url: f.url }); await waitFor(() => !f.manager.active.has(other.id));
  assert.equal(f.manager.list()[0].status, 'complete'); assert.equal(f.manager.list()[0].scanResult.status, 'error');
  assert.doesNotMatch(JSON.stringify(f.manager.list()), /PRIVATE-PROGRAM-ERROR/);
  assert.deepEqual(await readFile(job.path), bytes);
});

test('close cancels and waits for the scanner while keeping the published download complete', async t => {
  let scanning = false, finished = false;
  const f = await fixture(t, { scannerConfig: { enabled: true }, scanner: async (_path, _config, { signal }) => {
    scanning = true;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 20)); finished = true;
    return { status: 'error', code: 'scan-cancelled' };
  } });
  const job = await f.manager.add({ url: f.url }); await waitFor(() => scanning);
  assert.equal(f.manager.list()[0].status, 'complete'); assert.equal(f.manager.list()[0].scanResult.status, 'running');
  await f.manager.close();
  assert.equal(finished, true); assert.equal(f.manager.list()[0].status, 'complete');
  assert.equal(f.manager.list()[0].scanResult.code, 'scan-cancelled'); assert.deepEqual(await readFile(job.path), bytes);
});

test('networkChanging prevents timer and direct pump calls from starting jobs', async t => {
  const f = await fixture(t); f.manager.networkChanging = true;
  const job = await f.manager.add({ url: f.url }); f.manager.pump();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.manager.active.size, 0); assert.equal(f.requests, 0); assert.equal(f.manager.list()[0].status, 'queued');
  f.manager.networkChanging = false; f.manager.pump();
  await waitFor(() => !f.manager.active.has(job.id));
  assert.equal(f.manager.list()[0].status, 'complete'); assert.deepEqual(await readFile(job.path), bytes);
});

test('media scans the actual published filename once, then records review without raw output', async t => {
  const paths = [], media = { download: async (_url, target) => {
    const path = target.replace(/\.mkv$/, '.webm'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    return { path, name: 'Video.webm', bytes: bytes.length };
  } };
  const f = await fixture(t, { mediaService: media, scannerConfig: { enabled: true }, scanner: async path => {
    paths.push(path); assert.deepEqual(await readFile(path), bytes);
    return { status: 'attention', code: 'scan-needs-review', exitCode: 2, stderr: 'PRIVATE' };
  } });
  const job = await f.manager.addMedia({ url: 'https://www.youtube.com/watch?v=BaW_jenozKc' });
  await waitFor(() => !f.manager.active.has(job.id));
  const completed = f.manager.list()[0]; assert.deepEqual(paths, [completed.path]); assert.ok(paths[0].endsWith('.webm'));
  assert.equal(completed.status, 'complete'); assert.equal(completed.scanResult.status, 'attention'); assert.equal(completed.scanResult.exitCode, 2);
  assert.doesNotMatch(JSON.stringify(completed), /PRIVATE/);
});

test('an interrupted persisted scan restores as completed with an explicit interrupted result', async t => {
  const f = await fixture(t); f.manager.networkChanging = true;
  const job = await f.manager.add({ url: f.url });
  const stored = { ...job, status: 'complete', scanResult: { status: 'running', engine: 'custom', output: 'discard' } };
  await f.manager.close();
  await writeFile(join(f.directory, 'data', 'jobs.json'), JSON.stringify([stored]));
  const restored = await new DownloadManager(join(f.directory, 'data'), join(f.directory, 'downloads')).init();
  try {
    const result = restored.list()[0];
    assert.equal(result.status, 'complete'); assert.equal(result.scanResult.status, 'error'); assert.equal(result.scanResult.code, 'scan-interrupted');
    assert.equal(result.scanResult.engine, 'custom'); assert.doesNotMatch(JSON.stringify(result.scanResult), /discard/);
  } finally { await restored.close(); }
});

test('failed media never invokes the scanner', async t => {
  let scans = 0;
  const f = await fixture(t, { scannerConfig: { enabled: true }, scanner: async () => { scans++; }, mediaService: { download: async () => { throw new Error('download failed'); } } });
  const job = await f.manager.addMedia({ url: 'https://www.youtube.com/watch?v=BaW_jenozKc' });
  await waitFor(() => !f.manager.active.has(job.id));
  assert.equal(f.manager.list()[0].status, 'error'); assert.equal(scans, 0); assert.equal(f.manager.list()[0].scanResult, undefined);
});
