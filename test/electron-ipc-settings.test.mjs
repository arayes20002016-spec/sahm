import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Preferences } from '../src/preferences.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-ipc-settings-'));
  const preferences = await new Preferences(directory, join(directory, 'files')).init();
  const handlers = new Map(), calls = [], webContents = { mainFrame: {} };
  const manager = { active: new Map(), networkChanging: false, pumps: 0, pump() { this.pumps++; } };
  const sites = { active: new Map(), networkChanging: false, pumps: 0, pump() { this.pumps++; } };
  const app = {
    isPackaged: true, login: false, failSet: false,
    getAppPath: () => directory,
    getLoginItemSettings() { return { openAtLogin: this.login }; },
    setLoginItemSettings(value) { calls.push('os:' + value.openAtLogin); if (this.failSet) throw new Error('mock OS rejected setting'); this.login = value.openAtLogin; },
  };
  const connectionSettings = { save: async () => ({ saved: true }), snapshot: () => ({ config: { mode: 'direct' } }) };
  const dialogs = { async showOpenDialog() { return { canceled: false, filePaths: [join(directory, 'scanner.exe')] }; } };
  const electron = { ipcMain: { handle(name, callback) { handlers.set(name, callback); } }, dialog: dialogs, shell: {}, nativeTheme: {}, app };
  const filename = fileURLToPath(new URL('../electron/ipc.cjs', import.meta.url));
  const require = createRequire(filename), module = { exports: {} };
  const script = new vm.Script(await readFile(filename, 'utf8'), { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  script.runInNewContext({ require: name => name === 'electron' ? electron : require(name), module, exports: module.exports, process: { execPath: join(directory, 'SAHM.exe') }, console });
  module.exports.wireIpc({ window: { webContents }, manager, preferences, bridge: { status: async () => ({ extensionDirectory: directory }) }, discoverLinks: async () => ({}), vault: { available: () => false }, connectionSettings, sites, openSite: async () => true });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (name, ...args) => handlers.get(name)(event, ...args);
  return { directory, preferences, handlers, manager, sites, app, calls, connectionSettings, invoke };
}

test('network save rejects active jobs and acquires both guards synchronously until the proxy commit finishes', async () => {
  const { manager, sites, connectionSettings, invoke } = await fixture();
  let release, saves = 0;
  connectionSettings.save = async () => { saves++; await new Promise(resolve => { release = resolve; }); return { saved: true }; };
  manager.active.set('download', {});
  await assert.rejects(invoke('network-save', {}), /أوقف التنزيلات/); manager.active.clear();
  sites.active.set('site', {});
  await assert.rejects(invoke('network-save', {}), /أوقف التنزيلات/); sites.active.clear();
  assert.equal(saves, 0);
  const pending = invoke('network-save', {});
  assert.equal(manager.networkChanging, true); assert.equal(sites.networkChanging, true);
  await assert.rejects(invoke('network-save', {}), /بالفعل/);
  release(); assert.equal((await pending).saved, true);
  assert.equal(manager.networkChanging, false); assert.equal(sites.networkChanging, false);
  assert.equal(manager.pumps, 1); assert.equal(sites.pumps, 1);
  connectionSettings.save = async () => { throw new Error('mock commit failure'); };
  await assert.rejects(invoke('network-save', {}), /commit failure/);
  assert.equal(manager.networkChanging, false); assert.equal(sites.networkChanging, false);
  assert.equal(manager.pumps, 2); assert.equal(sites.pumps, 2);
});

test('startup changes call only the mocked OS before persistence, and roll back on failed preference writes', async () => {
  const { preferences, app, calls, invoke } = await fixture(), update = preferences.update.bind(preferences);
  let failPersistence = false;
  preferences.update = async data => { calls.push('persist'); if (failPersistence) throw new Error('mock persistence failure'); return update(data); };
  await invoke('preferences', { startWithWindows: true });
  assert.deepEqual(calls, ['os:true', 'persist']); assert.equal(app.login, true); assert.equal(preferences.snapshot().startWithWindows, true);
  failPersistence = true; calls.length = 0;
  await assert.rejects(invoke('preferences', { startWithWindows: false }), /persistence failure/);
  assert.deepEqual(calls, ['os:false', 'persist', 'os:true']); assert.equal(app.login, true); assert.equal(preferences.snapshot().startWithWindows, true);
  failPersistence = false; app.failSet = true; calls.length = 0;
  await assert.rejects(invoke('preferences', { startWithWindows: false }), /OS rejected/);
  assert.deepEqual(calls, ['os:false']); assert.equal(preferences.snapshot().startWithWindows, true);
});

test('preference IPC parses custom-rule text, updates new-job settings and rejects malformed or conflicting payloads', async () => {
  const { preferences, manager, calls, invoke } = await fixture();
  await invoke('preferences', { downloadRulesText: 'أرشيف خاص|zip,rar|' });
  assert.deepEqual(preferences.snapshot().downloadRules, [{ name: 'أرشيف خاص', extensions: ['zip', 'rar'], directory: '' }]);
  assert.deepEqual(manager.downloadRules, preferences.snapshot().downloadRules); assert.deepEqual(manager.scannerConfig, preferences.snapshot().scanner);
  assert.equal(calls.length, 0, 'unrelated preferences must not touch the OS startup API');
  await assert.rejects(invoke('preferences', { downloadRulesText: 'اسم|*.zip|', startWithWindows: true }), /السطر 1/);
  assert.equal(calls.length, 0); assert.equal(preferences.snapshot().startWithWindows, false);
  await assert.rejects(invoke('preferences', { downloadRulesText: '', downloadRules: [] }), /صيغة واحدة/);
  await assert.rejects(invoke('preferences', { network: { mode: 'direct' } }), /نافذة الاتصال/);
  assert.equal(await invoke('choose-scanner'), join(preferences.directory, 'scanner.exe'));
});

test('settings IPC rejects messages from an unrelated renderer or child frame', async () => {
  const { handlers } = await fixture();
  assert.throws(() => handlers.get('network-save')({ sender: {}, senderFrame: {} }, {}), /Untrusted application frame/);
});
