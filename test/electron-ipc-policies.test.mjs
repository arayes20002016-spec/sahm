import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

async function fixture() {
  const handlers = new Map(), calls = [], webContents = { mainFrame: {} };
  const consumer = () => ({ active: new Map(), networkChanging: false, pumps: 0, pump() { this.pumps++; } });
  const manager = { ...consumer(), queueStore: { get: id => id === 'existing-queue' ? { id } : null }, queueAction(action, data) { calls.push(['queue', action, data]); return 'queue-result'; } };
  const sites = consumer();
  const syncs = {
    ...consumer(), projects: [{ id: 'sync-project', queueId: 'existing-queue', directory: 'C:\\SAHM-Test\\Synchronization\\project' }],
    list() { return structuredClone(this.projects); },
    add(data) { calls.push(['add', data]); return { added: true }; },
    update(id, data) { calls.push(['update', id, data]); return { updated: true }; },
    action(id, action) { calls.push(['action', id, action]); return 'sync-action-result'; },
  };
  const quota = {
    ledger: { usedBytes: 123, resetAt: 98765, storageError: null, config: { enabled: true, limitBytes: 456, periodHours: 1 } },
    async refresh() { calls.push(['refresh']); },
    snapshot() { return structuredClone(this.ledger); },
    async configure(config) { calls.push(['configure', config]); return { saved: true }; },
  };
  const connectionSettings = { async save(data) { calls.push(['network-save', data]); return { saved: true }; } };
  const electron = {
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }, dialog: {}, nativeTheme: {}, app: {},
    shell: { openPath(path) { calls.push(['open', path]); return ''; } },
  };
  const filename = fileURLToPath(new URL('../electron/ipc.cjs', import.meta.url));
  const require = createRequire(filename), module = { exports: {} };
  new vm.Script(await readFile(filename, 'utf8'), { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInNewContext({ require: name => name === 'electron' ? electron : require(name), module, exports: module.exports, process: { execPath: 'C:\\SAHM-Test\\SAHM.exe' }, console });
  module.exports.wireIpc({ window: { webContents }, manager, sites, syncs, quota, connectionSettings, preferences: {}, bridge: {}, discoverLinks: async () => ({}), openSite: async () => true });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { handlers, calls, manager, sites, syncs, quota, connectionSettings, webContents, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('policy IPC accepts only the application main frame for every new quota and synchronization channel', async () => {
  const { handlers, webContents } = await fixture();
  for (const channel of ['quota', 'quota-save', 'syncs', 'sync-add', 'sync-update', 'sync-action', 'sync-folder']) {
    const callback = handlers.get(channel); assert.equal(typeof callback, 'function', channel);
    assert.throws(() => callback({ sender: {}, senderFrame: webContents.mainFrame }, {}), /Untrusted application frame/, channel);
    assert.throws(() => callback({ sender: webContents, senderFrame: {} }, {}), /Untrusted application frame/, channel);
  }
});

test('proxy saves reject active synchronization and acquire all three guards before awaiting, then release on success or failure', async () => {
  const { manager, sites, syncs, connectionSettings, invoke } = await fixture();
  let writes = 0, release;
  connectionSettings.save = async () => { writes++; await new Promise(resolve => { release = resolve; }); return { saved: true }; };
  syncs.active.set('working-sync', {});
  await assert.rejects(invoke('network-save', {}), /أوقف التنزيلات/);
  assert.equal(writes, 0); assert.ok([manager, sites, syncs].every(value => !value.networkChanging));
  syncs.active.clear();
  const saving = invoke('network-save', {});
  assert.ok([manager, sites, syncs].every(value => value.networkChanging));
  await assert.rejects(invoke('network-save', {}), /بالفعل/);
  assert.equal(writes, 1); assert.ok([manager, sites, syncs].every(value => value.pumps === 0));
  release(); assert.equal((await saving).saved, true);
  assert.ok([manager, sites, syncs].every(value => !value.networkChanging && value.pumps === 1));
  connectionSettings.save = async () => { throw new Error('synthetic proxy persistence failure'); };
  await assert.rejects(invoke('network-save', {}), /proxy persistence failure/);
  assert.ok([manager, sites, syncs].every(value => !value.networkChanging && value.pumps === 2));
});

test('a queue referenced by any synchronization project cannot be removed until the link is detached', async () => {
  const { invoke, syncs, calls } = await fixture();
  assert.throws(() => invoke('queue-action', 'remove', { id: 'existing-queue' }), /افصل مشاريع المزامنة/);
  assert.equal(calls.length, 0);
  assert.equal(invoke('queue-action', 'pause', { id: 'existing-queue' }), 'queue-result');
  syncs.projects[0].queueId = null;
  assert.equal(invoke('queue-action', 'remove', { id: 'existing-queue' }), 'queue-result');
  assert.deepEqual(calls.map(call => call[1]), ['pause', 'remove']);
});

test('saving the quota starts all policy consumers only after a successful commit, and failure starts none', async () => {
  const { manager, sites, syncs, quota, invoke } = await fixture();
  quota.configure = async () => { throw new Error('synthetic quota persistence failure'); };
  await assert.rejects(invoke('quota-save', { enabled: true }), /quota persistence failure/);
  assert.ok([manager, sites, syncs].every(value => value.pumps === 0));
  let release;
  quota.configure = async config => { await new Promise(resolve => { release = resolve; }); return { saved: config }; };
  const config = { enabled: true, limitBytes: 1000, periodHours: 1 }, saving = invoke('quota-save', config);
  assert.ok([manager, sites, syncs].every(value => value.pumps === 0));
  release(); const result = await saving;
  assert.equal(result.saved, config); assert.ok([manager, sites, syncs].every(value => value.pumps === 1));
});

test('reading a quota whose refresh failed returns the storage error snapshot and never clears or rewrites the ledger', async () => {
  const { quota, calls, invoke } = await fixture();
  const previous = structuredClone(quota.ledger);
  quota.refresh = async () => { quota.ledger.storageError = 'synthetic ledger write error'; throw new Error(quota.ledger.storageError); };
  const result = await invoke('quota');
  assert.equal(result.storageError, 'synthetic ledger write error');
  assert.equal(result.usedBytes, previous.usedBytes); assert.equal(result.resetAt, previous.resetAt); assert.deepEqual(result.config, previous.config);
  assert.deepEqual(calls, []); assert.equal(quota.ledger.usedBytes, previous.usedBytes);
});

test('creating or changing a synchronization project validates queue references before delegating the mutation', async () => {
  const { calls, invoke } = await fixture();
  assert.throws(() => invoke('sync-add', { queueId: 'missing-queue' }), /قائمة التنزيل غير موجودة/);
  assert.throws(() => invoke('sync-update', 'sync-project', { queueId: 'missing-queue' }), /قائمة التنزيل غير موجودة/);
  assert.equal(calls.length, 0);
  const creation = { queueId: 'existing-queue', urls: ['https://example.com/file'] }, change = { queueId: null, name: 'مشروع مستقل' };
  assert.equal(invoke('sync-add', creation).added, true); assert.equal(invoke('sync-update', 'sync-project', change).updated, true);
  assert.equal(calls[0][1], creation); assert.equal(calls[1][1], 'sync-project'); assert.equal(calls[1][2], change);
});

test('synchronization commands forward the chosen project and opening a missing project never invokes the shell', async () => {
  const { calls, invoke } = await fixture();
  assert.equal(invoke('sync-action', 'sync-project', 'pause'), 'sync-action-result');
  assert.throws(() => invoke('sync-folder', 'missing-project'), /مشروع المزامنة غير موجود/);
  assert.equal(calls.length, 1);
  assert.equal(invoke('sync-folder', 'sync-project'), '');
  assert.deepEqual(calls, [['action', 'sync-project', 'pause'], ['open', 'C:\\SAHM-Test\\Synchronization\\project']]);
});
