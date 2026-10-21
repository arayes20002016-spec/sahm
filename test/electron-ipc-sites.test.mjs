import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

async function fixture({ browser = true, detachFailure, saveFailure, pendingSave } = {}) {
  const handlers = new Map(), calls = [], webContents = { mainFrame: {} };
  const consumer = () => ({ active: new Map(), networkChanging: false, pumps: 0, pump() { this.pumps++; } });
  const manager = consumer(), sites = consumer(), syncs = consumer();
  const records = new Map([['session-one', { id: 'session-one', origin: 'https://example.test', label: 'example.test' }]]);
  Object.assign(sites, {
    list() { calls.push(['sites-list']); return []; },
    async detachSession(id) { calls.push(['detach', id]); if (detachFailure) throw detachFailure; },
    async attachSession(id, sessionId) { calls.push(['attach', id, sessionId]); return ['attached']; }
  });
  const siteBrowser = browser ? {
    active: false,
    get(id) { calls.push(['session-get', id]); return records.get(id); },
    hasActive() { calls.push(['has-active']); return this.active; },
    snapshot() { calls.push(['session-snapshot']); return [...records.values()].map(value => ({ ...value })); },
    async openLogin(url) { calls.push(['open-login', url]); return { id: 'new-session', origin: new URL(url).origin }; },
    async removeSession(id) { calls.push(['remove-session', id]); records.delete(id); }
  } : undefined;
  const connectionSettings = {
    async save(data) {
      calls.push(['network-save', data]);
      assert.ok([manager, sites, syncs].every(value => value.networkChanging));
      if (pendingSave) await pendingSave;
      if (saveFailure) throw saveFailure;
      return { saved: true };
    }
  };
  const electron = { ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }, dialog: {}, shell: {}, nativeTheme: {}, app: { isPackaged: true } };
  const filename = fileURLToPath(new URL('../electron/ipc.cjs', import.meta.url));
  const require = createRequire(filename), module = { exports: {} };
  new vm.Script(await readFile(filename, 'utf8'), { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
    .runInNewContext({ require: name => name === 'electron' ? electron : require(name), module, exports: module.exports, process: { execPath: 'C:\\SAHM-Test\\SAHM.exe' }, console });
  module.exports.wireIpc({ window: { webContents }, manager, sites, syncs, siteBrowser, connectionSettings, preferences: {}, bridge: {}, discoverLinks: async () => ({}) });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { handlers, calls, webContents, manager, sites, syncs, siteBrowser, records, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('every site-session IPC channel rejects other renderers and child frames before accessing login state', async () => {
  const { handlers, calls, webContents } = await fixture();
  for (const channel of ['site-sessions', 'site-session-open', 'site-session-remove', 'site-session-attach']) {
    const callback = handlers.get(channel); assert.equal(typeof callback, 'function');
    for (const event of [{ sender: {}, senderFrame: webContents.mainFrame }, { sender: webContents, senderFrame: {} }, { sender: webContents }]) {
      assert.throws(() => callback(event, 'https://example.test', 'session-one'), /Untrusted application frame/);
    }
  }
  assert.deepEqual(calls, []);
});

test('listing sessions returns only service metadata and remains inert when the browser service is unavailable', async () => {
  const { invoke, calls } = await fixture();
  assert.deepEqual(invoke('site-sessions'), [{ id: 'session-one', origin: 'https://example.test', label: 'example.test' }]);
  assert.deepEqual(calls, [['session-snapshot']]);
  const unavailable = await fixture({ browser: false });
  assert.equal(unavailable.invoke('site-sessions').length, 0);
  await assert.rejects(unavailable.invoke('site-session-open', 'https://example.test/'), /غير متاح/);
  assert.deepEqual(unavailable.calls, []);
});

test('login URLs are normalized and credential-bearing or token-bearing URLs fail before opening a browser', async () => {
  const { invoke, calls } = await fixture();
  for (const url of [undefined, null, {}, '', 'file:///C:/secret.txt', 'javascript:alert(1)', 'https://user:password@example.test/', 'https://example.test/?token=URL_SECRET', 'https://example.test/?authToken=URL_SECRET', 'https://example.test/?csrfToken=URL_SECRET']) {
    await assert.rejects(invoke('site-session-open', url));
  }
  assert.ok(!calls.some(call => call[0] === 'open-login'));
  const result = await invoke('site-session-open', 'https://example.test/private#section');
  assert.equal(result.origin, 'https://example.test');
  assert.deepEqual(calls.filter(call => call[0] === 'open-login'), [['open-login', 'https://example.test/private']]);
});

test('opening a login window is blocked during any consumer network reconfiguration', async () => {
  for (const name of ['manager', 'sites', 'syncs']) {
    const f = await fixture(); f[name].networkChanging = true;
    await assert.rejects(f.invoke('site-session-open', 'https://example.test/'), /تغيير إعدادات الاتصال/);
    assert.ok(!f.calls.some(call => call[0] === 'open-login'));
  }
});

test('forgetting a session always removes its browser state even when detaching jobs cannot save', async () => {
  const failure = new Error('Storage unavailable');
  const f = await fixture({ detachFailure: failure });
  await assert.rejects(f.invoke('site-session-remove', 'session-one'), error => error === failure);
  assert.equal(f.records.has('session-one'), false);
  assert.deepEqual(f.calls, [['session-get', 'session-one'], ['detach', 'session-one'], ['remove-session', 'session-one']]);
  await assert.rejects(f.invoke('site-session-remove', 'session-one'), /غير موجودة/);
  assert.equal(f.calls.filter(call => call[0] === 'remove-session').length, 1);
});

test('session removal detaches jobs before deleting browser state and returns a fresh metadata list', async () => {
  const f = await fixture();
  assert.equal((await f.invoke('site-session-remove', 'session-one')).length, 0);
  assert.deepEqual(f.calls, [['session-get', 'session-one'], ['detach', 'session-one'], ['remove-session', 'session-one'], ['session-snapshot']]);
});

test('attaching a session delegates origin and lifecycle checks to the site-copy manager with both identifiers', async () => {
  const { invoke, calls } = await fixture();
  assert.deepEqual(await invoke('site-session-attach', 'job-one', 'session-one'), ['attached']);
  assert.deepEqual(calls, [['attach', 'job-one', 'session-one']]);
});

test('network changes reject active login windows and active browser runners before modifying settings', async () => {
  const f = await fixture(); f.siteBrowser.active = true;
  await assert.rejects(f.invoke('network-save', { mode: 'direct' }), /أغلق نافذة تسجيل الدخول/);
  assert.ok(!f.calls.some(call => call[0] === 'network-save'));
  assert.ok([f.manager, f.sites, f.syncs].every(value => !value.networkChanging && value.pumps === 0));
  for (const name of ['manager', 'sites', 'syncs']) {
    const active = await fixture(); active[name].active.set('active-work', {});
    await assert.rejects(active.invoke('network-save', { mode: 'direct' }), /أوقف التنزيلات/);
    assert.ok(!active.calls.some(call => call[0] === 'network-save'));
  }
});

test('network-save guards concurrent login and network changes, then releases every consumer after success', async () => {
  let release; const pendingSave = new Promise(resolve => { release = resolve; });
  const f = await fixture({ pendingSave });
  const saving = f.invoke('network-save', { mode: 'direct' });
  assert.ok([f.manager, f.sites, f.syncs].every(value => value.networkChanging));
  await assert.rejects(f.invoke('site-session-open', 'https://example.test/'), /تغيير إعدادات الاتصال/);
  await assert.rejects(f.invoke('network-save', { mode: 'system' }), /يجري تحديث الاتصال/);
  release(); assert.deepEqual(await saving, { saved: true });
  assert.ok([f.manager, f.sites, f.syncs].every(value => !value.networkChanging && value.pumps === 1));
  assert.equal(f.calls.filter(call => call[0] === 'network-save').length, 1);
});

test('network-save releases every consumer and resumes scheduling when saving fails', async () => {
  const failure = new Error('Cannot save network settings'), f = await fixture({ saveFailure: failure });
  await assert.rejects(f.invoke('network-save', { mode: 'direct' }), error => error === failure);
  assert.ok([f.manager, f.sites, f.syncs].every(value => !value.networkChanging && value.pumps === 1));
});

test('preload forwards session operations and exposes session metadata events without Electron event objects', async () => {
  const invokes = [], listeners = new Map(), exposed = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value); } },
    ipcRenderer: { sendSync: () => "ar", invoke(...args) { invokes.push(args); return Promise.resolve('ipc-result'); }, on(channel, callback) { listeners.set(channel, callback); } }
  };
  const filename = fileURLToPath(new URL('../electron/preload.cjs', import.meta.url));
  new vm.Script(await readFile(filename, 'utf8'), { filename }).runInNewContext({ require: name => { assert.equal(name, 'electron'); return electron; } });
  const api = exposed.get('sahm');
  assert.equal(await api.siteSessions(), 'ipc-result');
  assert.equal(await api.openSiteSession('https://example.test/'), 'ipc-result');
  assert.equal(await api.removeSiteSession('session-one'), 'ipc-result');
  assert.equal(await api.attachSiteSession('job-one', 'session-one'), 'ipc-result');
  assert.deepEqual(invokes, [['site-sessions'], ['site-session-open', 'https://example.test/'], ['site-session-remove', 'session-one'], ['site-session-attach', 'job-one', 'session-one']]);
  let received; api.onSiteSessions(value => { received = value; });
  const metadata = [{ id: 'session-one', origin: 'https://example.test' }];
  listeners.get('site-sessions')({ sender: 'private Electron event' }, metadata);
  assert.equal(received, metadata);
});
