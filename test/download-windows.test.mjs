import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const { createDownloadWindows } = createRequire(import.meta.url)('../electron/download-windows.cjs');

function fixture(enabled = () => true) {
  const ipcMain = new EventEmitter(); ipcMain.handlers = new Map();
  ipcMain.handle = (key, handler) => ipcMain.handlers.set(key, handler);
  ipcMain.removeHandler = key => ipcMain.handlers.delete(key);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: {}, setWindowOpenHandler: handler => { this.popups = handler; }, isLoading: () => false, send: (_key, data) => { this.update = data; } });
    }
    removeMenu() {} setTitle() {} show() {} showInactive() {} focus() {}
    loadFile() { return Promise.resolve(); }
    close() { this.destroy(); }
    destroy() { this.emit('closed'); }
  }
  const manager = new EventEmitter(); let jobs = [];
  manager.list = () => structuredClone(jobs); manager.calls = [];
  manager.action = async (id, action) => manager.calls.push({ id, action });
  const folders = [], service = createDownloadWindows({ BrowserWindow: Window, ipcMain, manager, shell: { openPath: async value => { folders.push(value); return ''; } }, enabled });
  const add = (count = 1) => { for (let i = 0; i < count; i++) jobs.push({ id: 'id-' + jobs.length, name: 'file.bin', path: '/downloads/' + jobs.length + '/file.bin', status: 'downloading', url: 'https://private.invalid/?token=secret', requestContext: { cookie: 'secret' } }); manager.emit('change', manager.list()); };
  const event = id => { const window = service.records.get(id).window; return { sender: window.webContents, senderFrame: window.webContents.mainFrame }; };
  return { ipcMain, manager, service, folders, add, event, invoke: (channel, event, ...args) => ipcMain.handlers.get(channel)(event, ...args) };
}

test('download windows bind actions to their own job and reject foreign frames', async () => {
  const f = fixture(); f.add(2);
  try {
    const event = f.event('id-0'), state = f.invoke('download-window-state', event);
    assert.equal(state.id, 'id-0'); assert.equal(Object.hasOwn(state, 'url'), false); assert.equal(Object.hasOwn(state, 'requestContext'), false);
    await f.invoke('download-window-action', event, 'pause', 'id-1');
    assert.deepEqual(f.manager.calls, [{ id: 'id-0', action: 'pause' }]);
    await f.invoke('download-window-folder', event); assert.deepEqual(f.folders, [dirname(state.path)]);
    const frame = { ...event, senderFrame: {} };
    assert.throws(() => f.invoke('download-window-state', frame), /Untrusted/);
    await assert.rejects(f.invoke('download-window-action', frame, 'resume'), /Untrusted/);
    await assert.rejects(f.invoke('download-window-action', event, 'remove'), /غير صالح/);
    assert.doesNotThrow(() => f.ipcMain.emit('download-window-hide', frame)); assert.equal(f.service.records.size, 2);
    const window = f.service.records.get('id-0').window;
    assert.equal(window.options.webPreferences.sandbox, true); assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(window.popups(), { action: 'deny' });
    let prevented = false; window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    f.ipcMain.emit('download-window-hide', event); assert.equal(f.service.records.size, 1); assert.equal(f.manager.list().length, 2);
  } finally { f.service.close(); }
  assert.equal(f.manager.listenerCount('change'), 0); assert.equal(f.ipcMain.handlers.size, 0); assert.equal(f.ipcMain.listenerCount('download-window-hide'), 0);
});

test('automatic download windows honor the preference and limit; manual access stays available', () => {
  const f = fixture(); f.add(10);
  try {
    assert.equal(f.service.records.size, 8); f.service.show('id-9'); assert.equal(f.service.records.size, 9);
    f.service.show('id-9'); assert.equal(f.service.records.size, 9);
  } finally { f.service.close(); }
  const disabled = fixture(() => false); disabled.add();
  try { assert.equal(disabled.service.records.size, 0); disabled.service.show('id-0'); assert.equal(disabled.service.records.size, 1); }
  finally { disabled.service.close(); }
});

test('automatic network reconnection updates existing windows without reopening one the user hid', () => {
  const f = fixture(); f.add();
  const job = f.manager.list()[0], retry = { attempt: 1, startedAt: Date.now(), nextAt: Date.now() + 2000 };
  try {
    f.manager.list = () => [{ ...job, status: 'queued', networkRetry: retry }];
    f.manager.emit('change', f.manager.list());
    assert.deepEqual(f.invoke('download-window-state', f.event(job.id)).networkRetry, retry);
    f.ipcMain.emit('download-window-hide', f.event(job.id));
    f.manager.list = () => [{ ...job, status: 'downloading', networkRetry: retry }];
    f.manager.emit('change', f.manager.list());
    assert.equal(f.service.records.size, 0);
    f.service.show(job.id); assert.equal(f.service.records.size, 1);
  } finally { f.service.close(); }
});

test('changing language waits for an initial download-window load and coalesces repeated refreshes', () => {
 const f = fixture(); f.add(); const window = f.service.records.get('id-0').window;
 let loading = true, reloads = 0; window.isDestroyed = () => false;
 window.webContents.isLoading = () => loading; window.webContents.reload = () => { reloads++; };
 try {
   f.service.refreshLocale(); f.service.refreshLocale(); assert.equal(reloads, 0);
   loading = false; window.webContents.emit('did-finish-load'); assert.equal(reloads, 1);
   f.service.refreshLocale(); assert.equal(reloads, 2);
 } finally { f.service.close(); }
});
