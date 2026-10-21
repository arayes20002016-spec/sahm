const { t: __sahmT } = require('./locale.cjs');
const path = require('node:path');

function createDownloadWindows({ BrowserWindow, ipcMain, manager, shell, enabled = () => true }) {
  const records = new Map(), previous = new Map(manager.list().map(job => [job.id, job.status]));
  const channels = ['download-window-state', 'download-window-action', 'download-window-folder'];
  const state = id => {
    const job = manager.list().find(value => value.id === id);
    if (!job) throw new Error('التنزيل لم يعد موجودًا.');
    return Object.fromEntries(['id', 'name', 'path', 'status', 'received', 'total', 'speed', 'error', 'needsRecapture', 'needsCredentials', 'method', 'replayPolicy', 'networkRetry'].map(key => [key, job[key]]));
  };
  const owner = event => {
    const entry = [...records.values()].find(value => value.window.webContents === event.sender);
    if (!entry || event.senderFrame !== entry.window.webContents.mainFrame) throw new Error('Untrusted download window');
    return entry;
  };
  ipcMain.handle(channels[0], event => state(owner(event).id));
  ipcMain.handle(channels[1], async (event, action) => {
    const entry = owner(event);
    if (!['pause', 'resume'].includes(action)) throw new Error('إجراء تنزيل غير صالح.');
    await manager.action(entry.id, action); return state(entry.id);
  });
  ipcMain.handle(channels[2], async event => {
    const job = state(owner(event).id);
    const error = await shell.openPath(path.dirname(job.path)); if (error) throw new Error(error);
  });
  const hide = event => {
    let entry;
    try { entry = owner(event); } catch { return; }
    entry.window.close();
  };
  ipcMain.on('download-window-hide', hide);

  function show(id, { automatic = false } = {}) {
    const job = state(id);
    const existing = records.get(id);
    if (existing) { existing.window.show(); existing.window.focus(); return true; }
    if (automatic && records.size >= 8) return false;
    const window = new BrowserWindow({ width: 620, height: 430, minWidth: 520, minHeight: 390, show: false, autoHideMenuBar: true, title: job.name + __sahmT(" — سَهم"), icon: path.join(__dirname, '../assets/sahm.ico'), webPreferences: { preload: path.join(__dirname, 'download-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const entry = { id, window }; records.set(id, entry); window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => { if (automatic) window.showInactive(); else { window.show(); window.focus(); } });
    window.once('closed', () => records.delete(id));
    window.loadFile(path.join(__dirname, '../ui/download.html')).catch(() => window.destroy());
    return true;
  }
  function changed(jobs) {
    const ids = new Set(jobs.map(job => job.id));
    for (const job of jobs) {
      const prior = previous.get(job.id);
      if (enabled() && ((!previous.has(job.id) && !job.startAt) || job.status === 'downloading' && prior !== 'downloading' && !job.networkRetry)) show(job.id, { automatic: true });
      previous.set(job.id, job.status);
      const entry = records.get(job.id);
      if (entry && !entry.window.webContents.isLoading()) {
        entry.window.setTitle(job.name + __sahmT(" — سَهم")); entry.window.webContents.send('download-window-update', state(job.id));
      }
    }
    for (const [id, entry] of records) if (!ids.has(id)) entry.window.destroy();
    for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id);
  }
  manager.on('change', changed);
  return { show, records,
    owns: contents => [...records.values()].some(entry => entry.window.webContents === contents),
    refreshLocale() {
      for (const entry of records.values()) {
        entry.window.setTitle(state(entry.id).name + __sahmT(" — سَهم"));
        if (entry.localePending) continue;
        const reload = () => { entry.localePending = false; if (!entry.window.isDestroyed()) entry.window.webContents.reload(); };
        // A reload during the initial load aborts loadFile and destroys the window.
        if (entry.window.webContents.isLoading()) { entry.localePending = true; entry.window.webContents.once('did-finish-load', reload); }
        else reload();
      }
    },
    close() { manager.off('change', changed); for (const entry of records.values()) entry.window.destroy(); for (const channel of channels) ipcMain.removeHandler(channel); ipcMain.removeListener('download-window-hide', hide); } };
}
module.exports = { createDownloadWindows };

