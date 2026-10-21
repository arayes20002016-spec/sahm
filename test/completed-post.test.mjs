import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRequest } from '../browser/protocol.mjs';
import { sendToBridge } from '../browser/native-host.mjs';
import { completedFileInfo } from '../browser/completed-file.mjs';
import { PostDownloads } from '../browser/extension/post-downloads.mjs';
import { DEFAULT_SETTINGS } from '../browser/extension/capture-policy.mjs';
import { prepareBrowserDownload, startBrowserBridge } from '../src/browser-bridge.mjs';
import { DownloadManager } from '../src/manager.mjs';

const policy = { ...DEFAULT_SETTINGS, enabled: true, allowPost: true, allowSession: true };
const started = '2026-10-20T10:00:00.000Z';
const item = { id: 7, startTime: started, url: 'https://example.com/export?private-url-token=secret', filename: join(tmpdir(), 'export.zip'), state: 'complete', danger: 'safe', fileSize: 4, bytesReceived: 4, exists: true };
const observed = { method: 'POST', attachment: true, usesCredentials: true };
function storageFixture() {
  const data = {};
  return { data, get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
}
async function directory(t) {
  const value = await mkdtemp(join(tmpdir(), 'sahm-completed-post-'));
  return value;
}
function completedRequest(overrides = {}) {
  return { v: 1, type: 'browser-complete', requestId: 'post:profile:7', expiresAt: Date.now() + 8000,
    source: 'automatic', method: 'POST', url: item.url, browserFile: { path: item.filename, bytes: 4 },
    postApproved: true, sessionApproved: true, usesCredentials: true, requestObserved: true, attachment: true,
    state: 'complete', danger: 'safe', ...overrides };
}
test('completed POST wire rejects unsafe, incomplete or secret-bearing imports and every legacy POST replay', () => {
  assert.equal(validateRequest(completedRequest()).type, 'browser-complete');
  for (const change of [{ postApproved: false }, { sessionApproved: false }, { requestObserved: false }, { attachment: false },
    { state: 'in_progress' }, { danger: 'dangerous' }, { incognito: true }, { byExtensionId: 'other' },
    { requestContext: { method: 'POST', bodyBase64: 'AA==' } }, { browserFile: { path: 'relative.zip', bytes: 4 } },
    { browserFile: { path: item.filename, bytes: -1 } }, { browserFile: { path: '\\\\server\\share\\file.zip', bytes: 4 } }]) {
    assert.throws(() => validateRequest(completedRequest(change)));
  }
  assert.throws(() => validateRequest({ ...completedRequest(), type: 'enqueue' }), /POST replay is disabled/);
});
test('POST preflight is refused before invoking any network transport', async () => {
  let dispatched = 0;
  await assert.rejects(prepareBrowserDownload({ method: 'POST', url: item.url }, { prepare: async () => { dispatched++; } }), /post-replay-disabled/);
  assert.equal(dispatched, 0);
});
test('completed POST journal stores identifiers only and waits for browser completion', async () => {
  const storage = storageFixture(), statuses = [], sent = [];
  let current = { ...item, state: 'in_progress' };
  const posts = new PostDownloads({ storage, settings: async () => policy, search: async () => [current],
    status: async value => statuses.push(value), send: async value => { sent.push(value); return { v: 1, requestId: value.requestId, ok: true, durable: true, jobId: 'saved' }; } });
  await posts.track(item, observed); await posts.reconcile();
  assert.equal(sent.length, 0);
  const journal = JSON.stringify(storage.data);
  for (const secret of [item.url, item.filename, 'private-url-token', 'bodyBase64', 'cookie']) assert.ok(!journal.includes(secret));
  current = item; await Promise.all([posts.reconcile(), posts.reconcile()]);
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'browser-complete');
  assert.equal(sent[0].requestContext, undefined); assert.equal(statuses.at(-1).reason, 'browser-completed');
  assert.equal(storage.data.completedPostDownloads.entries.length, 0);
});
test('pending POST survives worker restart, keeps identity on retry and does not import reused or unsafe download ids', async () => {
  const storage = storageFixture(), attempts = [];
  const options = { storage, settings: async () => policy, status: async () => {}, search: async () => [item],
    send: async message => { attempts.push(message); throw new Error('ACK lost'); } };
  const first = new PostDownloads(options); await first.track(item, observed); await first.reconcile();
  const second = new PostDownloads(options); await second.reconcile();
  assert.equal(attempts.length, 2); assert.equal(attempts[0].requestId, attempts[1].requestId);
  for (const change of [{ startTime: '2026-10-20T11:00:00Z' }, { incognito: true }, { danger: 'dangerous' }, { exists: false }]) {
    await new PostDownloads({ ...options, search: async () => [{ ...item, ...change }] }).reconcile();
    assert.equal(attempts.length, 2);
    await second.track(item, observed);
  }
});
test('disabling POST or its session consent discards pending imports and leaves the browser file alone', async () => {
  for (const change of [{ enabled: false }, { allowPost: false }, { allowSession: false }, { excludedDomains: ['example.com'] }]) {
    const storage = storageFixture();
    const posts = new PostDownloads({ storage, settings: async () => ({ ...policy, ...change }), search: async () => [item],
      status: async () => {}, send: async () => { throw new Error('Must not call the app'); } });
    await posts.track(item, observed); await posts.reconcile();
    assert.equal(storage.data.completedPostDownloads.entries.length, 0);
  }
});
test('a completion arriving during another import is reconciled without waiting for the next alarm', async () => {
  const storage = storageFixture(), sent = [];
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const posts = new PostDownloads({ storage, settings: async () => policy, search: async query => [{ ...item, id: query.id }],
    status: async () => {}, send: async message => {
      sent.push(message);
      if (sent.length === 1) { entered(); await blocked; }
      return { v: 1, requestId: message.requestId, ok: true, durable: true, jobId: 'saved-' + sent.length };
    } });
  await posts.track(item, observed); const first = posts.reconcile(); await started;
  await posts.track({ ...item, id: 8 }, observed); const second = posts.reconcile();
  release(); await Promise.all([first, second]);
  assert.equal(sent.length, 2); assert.equal(new Set(sent.map(value => value.requestId)).size, 2);
  assert.equal(storage.data.completedPostDownloads.entries.length, 0);
});
test('completed browser imports use the configured scanner without a new transfer', async t => {
  const root = await directory(t), path = join(root, 'scan.bin');
  await writeFile(path, 'FILE'); let scanned;
  const manager = await new DownloadManager(join(root, 'state'), root, {
    scannerConfig: { enabled: true }, scanner: async target => { scanned = target; return { status: 'attention', code: 'scan-needs-review', exitCode: 2 }; },
  }).init();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const job = await manager.importBrowserCompleted({ url: item.url, browserFile: { path, bytes: 4 }, externalId: 'post:scanned' });
  await Promise.all([...manager.active.values()].map(value => value.promise));
  assert.equal(scanned, path); assert.equal(manager.list().find(value => value.id === job.id).status, 'complete');
  assert.equal(manager.list()[0].scanResult.status, 'attention'); assert.equal(await readFile(path, 'utf8'), 'FILE');
});
test('a completed local file is validated without moving it, and failed queue persistence never acknowledges it', async t => {
  const root = await directory(t), path = join(root, 'original.zip');
  await writeFile(path, 'FILE');
  const manager = await new DownloadManager(join(root, 'state'), join(root, 'sahm')).init();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(completedFileInfo({ path, bytes: 5 }), /changed/);
  await assert.rejects(completedFileInfo({ path: root, bytes: 0 }), /changed/);
  if (process.platform !== 'win32') {
    await symlink(path, join(root, 'link.zip'));
    await assert.rejects(completedFileInfo({ path: join(root, 'link.zip'), bytes: 4 }), /changed/);
  }
  const save = manager.save.bind(manager); manager.save = async () => { throw new Error('ENOSPC'); };
  const input = { url: item.url, browserFile: { path, bytes: 4 }, externalId: 'post:unique' };
  await assert.rejects(manager.importBrowserCompleted(input), /ENOSPC/); assert.equal(manager.list().length, 0);
  manager.save = save;
  const [a, b] = await Promise.all([manager.importBrowserCompleted(input), manager.importBrowserCompleted(input)]);
  assert.equal(a.id, b.id); assert.equal(manager.list().length, 1); assert.equal(a.path, path); assert.equal(a.status, 'complete');
  assert.equal(a.method, 'POST'); assert.equal(a.replayPolicy, 'browser-completed');
  await manager.action(a.id, 'resume'); assert.equal(manager.active.size, 0);
  await manager.action(a.id, 'remove'); assert.equal(await readFile(path, 'utf8'), 'FILE');
});
test('actual browser POST executes once even after lost ACK, bridge restart and duplicate completed-file delivery', async t => {
  const root = await directory(t), path = join(root, 'browser.zip');
  let operations = 0, prepares = 0, bridge, manager;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* The browser is the sole caller. */ }
    assert.equal(request.method, 'POST'); operations++;
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename=browser.zip' }); response.end('FILE');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await bridge?.close(); await manager?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port + '/export';
  await writeFile(path, Buffer.from(await (await fetch(url, { method: 'POST', body: 'csrf=private-body' })).arrayBuffer()));
  const state = join(root, 'state'), storage = storageFixture();
  async function openBridge() {
    manager = await new DownloadManager(state, join(root, 'sahm')).init();
    bridge = await startBrowserBridge({ dataDirectory: state, onDownload: () => { throw new Error('No download replay'); },
      preflight: () => { prepares++; throw new Error('No probe'); }, prepare: () => { prepares++; throw new Error('No prepare'); },
      onBrowserComplete: data => manager.importBrowserCompleted({ ...data, externalId: data.browserRequestId }) });
    return JSON.parse(await readFile(join(state, 'browser-integration/connection.json'), 'utf8'));
  }
  let config = await openBridge(), loseAck = true;
  const postsOptions = { storage, settings: async () => policy, search: async () => [{ ...item, url, filename: path }], status: async () => {},
    send: async message => { const response = await sendToBridge(config, message); if (loseAck) { loseAck = false; throw new Error('ACK lost'); } return response; } };
  const first = new PostDownloads(postsOptions); await first.track(item, observed); await first.reconcile();
  assert.equal(manager.list().length, 1); const id = manager.list()[0].id;
  await bridge.close(); bridge = null; await manager.close(); manager = null; config = await openBridge();
  await new PostDownloads(postsOptions).reconcile();
  assert.equal(manager.list().length, 1); assert.equal(manager.list()[0].id, id); assert.equal(operations, 1); assert.equal(prepares, 0);
  assert.equal(storage.data.completedPostDownloads.entries.length, 0);
  await assert.rejects(sendToBridge(config, { ...completedRequest({ url }), type: 'enqueue' })); assert.equal(operations, 1);
  assert.equal(await readFile(path, 'utf8'), 'FILE');
  const metadata = await readFile(join(state, 'jobs.json'), 'utf8') + await readFile(join(state, 'browser-integration/receipts.json'), 'utf8');
  assert.ok(!metadata.includes('private-body')); assert.ok(!metadata.includes('bodyBase64'));
});
