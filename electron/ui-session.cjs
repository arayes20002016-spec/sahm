const { ipcMain } = require('electron');

// The draft exists only during a renderer language reload. It can contain
// unsaved credentials, so never persist it or expose it to another window.
function wireUiSession({ window, preferences, downloadWindows }) {
  let draft = null, expiry;
  const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const clear = () => { draft = null; clearTimeout(expiry); };
  const language = event => {
    const ownFrame = event.senderFrame === event.sender.mainFrame;
    event.returnValue = ownFrame && (trusted(event) || downloadWindows.owns(event.sender)) ? preferences.snapshot().language : 'ar';
  };
  ipcMain.on('ui-language', language);
  ipcMain.handle('ui-draft-save', (event, value) => {
    if (!trusted(event)) throw new Error('Untrusted application frame');
    if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 1024 * 1024) throw new Error('مسودة الواجهة غير صالحة.');
    clear(); draft = structuredClone(value); expiry = setTimeout(clear, 30000); expiry.unref(); return true;
  });
  ipcMain.on('ui-reload', event => { if (trusted(event) && draft) window.webContents.reload(); });
  ipcMain.handle('ui-draft-take', event => {
    if (!trusted(event)) throw new Error('Untrusted application frame');
    const value = draft; clear(); return value;
  });
  window.once('closed', () => { clear(); ipcMain.removeListener('ui-language', language); ipcMain.removeAllListeners('ui-reload'); ipcMain.removeHandler('ui-draft-save'); ipcMain.removeHandler('ui-draft-take'); });
}
module.exports = { wireUiSession };
