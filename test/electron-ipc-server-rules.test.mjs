import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { normalizeServerRules } from '../src/server-rules.mjs';

async function fixture({ failSave = false, failNetwork = false, pending } = {}) {
  const handlers = new Map(), calls = [], webContents = { mainFrame: {} };
  const consumer = () => ({ active: new Map(), networkChanging: false, pump() { calls.push('pump'); } });
  const manager = consumer(), sites = consumer(), syncs = consumer();
  let saved = normalizeServerRules([{ host: 'old.example.test' }]);
  const preferences = {
    snapshot: () => ({ serverRules: structuredClone(saved) }),
    async update(value) { calls.push('save'); assert.ok([manager, sites, syncs].every(item => item.networkChanging)); if (pending) await pending; if (failSave) throw new Error('storage failure'); saved = structuredClone(value.serverRules); }
  };
  const network = { serverLimits: { active: 0 }, setServerRules(value) { calls.push('apply'); if (failNetwork) { failNetwork = false; throw new Error('network failure'); } this.rules = value; } };
  const siteBrowser = { hasActive: () => false };
  const electron = { ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, dialog: {}, shell: {}, nativeTheme: {}, app: {} };
  const filename = fileURLToPath(new URL('../electron/ipc.cjs', import.meta.url)), require = createRequire(filename), module = { exports: {} };
  new vm.Script(await readFile(filename, 'utf8'), { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).runInNewContext({ require: name => name === 'electron' ? electron : require(name), module, exports: module.exports, process, console });
  sites.updateSchedule = (id, data) => { calls.push(['schedule', id, data]); return ['updated']; };
  const openSite = (...args) => { calls.push(['open', ...args]); return true; };
  module.exports.wireIpc({ window: { webContents }, manager, sites, syncs, preferences, network, siteBrowser, openSite });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { handlers, calls, manager, sites, syncs, siteBrowser, preferences, network, webContents, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('new rule and site schedule channels reject another renderer or child frame before side effects', async () => {
  const f = await fixture();
  for (const channel of ['server-rules', 'server-rules-save', 'server-rule-directory', 'site-schedule', 'site-open']) {
    for (const event of [{ sender: {}, senderFrame: f.webContents.mainFrame }, { sender: f.webContents, senderFrame: {} }]) assert.throws(() => f.handlers.get(channel)(event, []), /Untrusted/);
  }
  assert.deepEqual(f.calls, []);
});
test('saving validated rules serializes persistence before application and releases every scheduling guard', async () => {
  const f = await fixture(), input = [{ host: 'EXAMPLE.test', connections: 2, fileConnections: 1 }];
  const result = await f.invoke('server-rules-save', input);
  assert.equal(result[0].host, 'example.test'); assert.deepEqual(f.calls.slice(0, 2), ['save', 'apply']);
  assert.deepEqual(f.preferences.snapshot().serverRules, result); assert.deepEqual(f.manager.serverRules, result);
  assert.ok([f.manager, f.sites, f.syncs].every(value => !value.networkChanging));
});
test('active consumers, login, media inspection and held transfer slots prevent changing rules', async () => {
  for (const kind of ['download', 'site', 'sync', 'login', 'inspection', 'slot', 'pending']) {
    const f = await fixture();
    if (kind === 'download') f.manager.active.set('job', {});
    if (kind === 'site') f.sites.active.set('job', {});
    if (kind === 'sync') f.syncs.active.set('job', {});
    if (kind === 'login') f.siteBrowser.hasActive = () => true;
    if (kind === 'inspection') f.manager.mediaInspections = 1;
    if (kind === 'slot') f.network.serverLimits.active = 1;
    if (kind === 'pending') f.manager.pending = new Set(['job']);
    await assert.rejects(f.invoke('server-rules-save', []), /أوقف/); assert.deepEqual(f.calls, []);
  }
});
test('invalid rules and failed persistence never replace the current runtime policy', async () => {
  const f = await fixture({ failSave: true });
  await assert.rejects(f.invoke('server-rules-save', [{ host: '*.bad/host' }])); assert.deepEqual(f.calls, []);
  await assert.rejects(f.invoke('server-rules-save', []), /storage failure/);
  assert.equal(f.preferences.snapshot().serverRules[0].host, 'old.example.test');
  assert.equal(f.calls.includes('apply'), false);
  assert.ok([f.manager, f.sites, f.syncs].every(value => !value.networkChanging));
});
test('runtime application failure restores the previous saved rules and runtime policy', async () => {
  const f = await fixture({ failNetwork: true });
  await assert.rejects(f.invoke('server-rules-save', []), /network failure/);
  assert.equal(f.preferences.snapshot().serverRules[0].host, 'old.example.test');
  assert.equal(f.network.rules[0].host, 'old.example.test');
});
test('a concurrent rule save is rejected while the first persists without losing its guards', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ pending }), first = f.invoke('server-rules-save', []);
  while (!f.manager.networkChanging) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.invoke('server-rules-save', []), /انتظر/); release(); await first;
});
test('site scheduling and previous-version opening retain the trusted IPC boundary and reject unknown versions', async () => {
  const f = await fixture();
  assert.deepEqual(f.invoke('site-schedule', 'site-one', { enabled: true, intervalMinutes: 1 }), ['updated']);
  assert.equal(f.invoke('site-open', 'site-one', 'previous'), true);
  assert.deepEqual(f.calls[1], ['open', 'site-one', 'previous']);
  assert.throws(() => f.invoke('site-open', 'site-one', '../../outside'), /غير صالح/);
});
