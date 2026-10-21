import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompletionActions } from '../src/completion-actions.mjs';
import { Preferences } from '../src/preferences.mjs';
import { normalizeTableLayout } from '../src/table-layout.mjs';

async function fixture({ controller, preferences = {} } = {}) {
  const handlers = new Map(), calls = [], webContents = { mainFrame: {} };
  const statuses = [
    { queueId: 'first-queue', queueName: 'القائمة الأولى', type: 'shutdown', state: 'pending', remainingSeconds: 30 },
    { queueId: 'second-queue', queueName: 'القائمة الثانية', type: 'open-folder', state: 'blocked', remainingSeconds: 30 }
  ];
  const completion = controller === null ? undefined : controller || {
    snapshot() { calls.push(['snapshot']); return structuredClone(statuses); },
    cancel(queueId) {
      calls.push(['cancel', queueId]);
      const status = statuses.find(value => value.queueId === queueId && ['pending', 'blocked'].includes(value.state));
      if (!status) return false;
      Object.assign(status, { state: 'cancelled', remainingSeconds: 0, reason: 'user-cancelled' });
      return true;
    }
  };
  const manager = { active: new Map(), pumps: 0, pump() { this.pumps++; } };
  const electron = {
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    dialog: {}, shell: {}, nativeTheme: {},
    app: { isPackaged: true, setLoginItemSettings() { throw new Error('Column preferences must never change OS startup.'); } }
  };
  const filename = fileURLToPath(new URL('../electron/ipc.cjs', import.meta.url));
  const require = createRequire(filename), module = { exports: {} };
  new vm.Script(await readFile(filename, 'utf8'), { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
    .runInNewContext({ require: name => name === 'electron' ? electron : require(name), module, exports: module.exports, process: { execPath: 'C:\\SAHM-Test\\SAHM.exe' }, console });
  module.exports.wireIpc({ window: { webContents }, manager, completion, preferences, bridge: { status: async () => ({}) }, discoverLinks: async () => ({}) });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { handlers, calls, statuses, manager, webContents, invoke: (channel, ...args) => handlers.get(channel)(event, ...args) };
}

test('completion IPC rejects an unrelated renderer and child frames before reading or cancelling actions', async () => {
  const { handlers, calls, webContents } = await fixture();
  for (const channel of ['completion-status', 'completion-cancel']) {
    const callback = handlers.get(channel);
    assert.equal(typeof callback, 'function');
    assert.throws(() => callback({ sender: {}, senderFrame: webContents.mainFrame }, 'first-queue'), /Untrusted application frame/);
    assert.throws(() => callback({ sender: webContents, senderFrame: {} }, 'first-queue'), /Untrusted application frame/);
    assert.throws(() => callback({ sender: webContents }, 'first-queue'), /Untrusted application frame/);
  }
  assert.deepEqual(calls, []);
});

test('completion status returns snapshots without triggering any action', async () => {
  const { invoke, calls, statuses } = await fixture();
  const result = invoke('completion-status');
  assert.deepEqual(result, statuses);
  result[0].state = 'executing';
  assert.equal(invoke('completion-status')[0].state, 'pending');
  assert.deepEqual(calls, [['snapshot'], ['snapshot']]);
});

test('completion cancellation rejects malformed queue identifiers before delegating', async () => {
  const { invoke, calls } = await fixture();
  for (const id of [undefined, null, false, 0, {}, [], '', 'a'.repeat(201)]) {
    assert.throws(() => invoke('completion-cancel', id), /معرّف القائمة غير صالح/);
  }
  assert.deepEqual(calls, []);
});

test('completion cancellation returns fresh statuses and preserves unrelated pending actions', async () => {
  const { invoke, calls } = await fixture();
  const result = invoke('completion-cancel', 'first-queue');
  assert.equal(result[0].state, 'cancelled');
  assert.equal(result[0].reason, 'user-cancelled');
  assert.equal(result[0].remainingSeconds, 0);
  assert.equal(result[1].state, 'blocked');
  assert.deepEqual(calls, [['cancel', 'first-queue'], ['snapshot']]);
  result[0].state = 'pending';
  assert.equal(invoke('completion-status')[0].state, 'cancelled');
});

test('cancelling an unknown or already cancelled queue is an idempotent snapshot operation', async () => {
  const { invoke } = await fixture();
  const before = invoke('completion-status');
  assert.deepEqual(invoke('completion-cancel', 'missing-queue'), before);
  assert.deepEqual(invoke('completion-cancel', 'a'.repeat(200)), before);
  const cancelled = invoke('completion-cancel', 'second-queue');
  assert.deepEqual(invoke('completion-cancel', 'second-queue'), cancelled);
});

test('completion IPC remains inert when the optional controller is unavailable', async () => {
  const { invoke } = await fixture({ controller: null });
  assert.equal(Array.isArray(invoke('completion-status')), true);
  assert.equal(invoke('completion-status').length, 0);
  assert.equal(invoke('completion-cancel', 'first-queue').length, 0);
  assert.throws(() => invoke('completion-cancel', ''), /معرّف القائمة غير صالح/);
});

test('cancelling a real countdown through IPC prevents execution after its deadline', async () => {
  let timestamp = Date.UTC(2026, 9, 18, 12), executions = 0;
  const queues = [{ id: 'first-queue', name: 'القائمة الأولى', enabled: true, parallel: 1, schedule: null, completionAction: { type: 'shutdown', delaySeconds: 30 } }];
  const jobs = [{ id: 'first-job', queueId: 'first-queue', status: 'downloading' }];
  const controller = new CompletionActions({ queueSnapshot: () => queues, jobsSnapshot: () => jobs, now: () => timestamp, execute: async () => { executions++; } });
  controller.reconcile();
  jobs[0].status = 'complete'; controller.reconcile();
  const { invoke } = await fixture({ controller });
  assert.equal(invoke('completion-status')[0].state, 'pending');
  assert.equal(invoke('completion-cancel', 'first-queue')[0].state, 'cancelled');
  timestamp += 60000;
  controller.reconcile(); await Promise.resolve();
  assert.equal(executions, 0);
  assert.equal(invoke('completion-status')[0].state, 'cancelled');
  controller.close();
});

test('column layout crosses settings IPC and survives a restart without changing OS settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-ipc-columns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = await new Preferences(directory, join(directory, 'files')).init();
  const { invoke, manager } = await fixture({ preferences });
  const tableLayout = normalizeTableLayout({ columns: [{ id: 'url', visible: true, width: 420 }, { id: 'name', width: 280 }], sort: { key: 'url', direction: 'asc' } });
  const result = await invoke('preferences', { tableLayout });
  assert.deepEqual(result.tableLayout, tableLayout);
  assert.deepEqual((await invoke('settings')).tableLayout, tableLayout);
  assert.deepEqual((await new Preferences(directory, join(directory, 'files')).init()).snapshot().tableLayout, tableLayout);
  assert.equal(manager.pumps, 1);
  await assert.rejects(invoke('preferences', { tableLayout: { columns: [{ id: 'name', visible: false }] } }), /اسم الملف/);
  assert.deepEqual((await invoke('settings')).tableLayout, tableLayout);
});

test('preload exposes completion channels and forwards status events without the Electron event object', async () => {
  const invokes = [], listeners = new Map(), exposed = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { exposed.set(name, value); } },
    ipcRenderer: { sendSync: () => "ar",
      invoke(...args) { invokes.push(args); return Promise.resolve('ipc-result'); },
      on(channel, callback) { listeners.set(channel, callback); }
    }
  };
  const filename = fileURLToPath(new URL('../electron/preload.cjs', import.meta.url));
  new vm.Script(await readFile(filename, 'utf8'), { filename }).runInNewContext({ require: name => { assert.equal(name, 'electron'); return electron; } });
  const api = exposed.get('sahm');
  assert.equal(api, exposed.get('rafid'));
  assert.equal(await api.completionStatus(), 'ipc-result');
  assert.equal(await api.cancelCompletion('first-queue'), 'ipc-result');
  let received;
  api.onCompletion(value => { received = value; });
  const statuses = [{ queueId: 'first-queue', state: 'pending' }];
  listeners.get('completion')({ sender: 'private Electron event' }, statuses);
  assert.equal(received, statuses);
  assert.deepEqual(invokes, [['completion-status'], ['completion-cancel', 'first-queue']]);
});
