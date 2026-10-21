const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('downloadWindow', {
  initialLanguage: ipcRenderer.sendSync('ui-language'),
  state: () => ipcRenderer.invoke('download-window-state'),
  action: action => ipcRenderer.invoke('download-window-action', action),
  folder: () => ipcRenderer.invoke('download-window-folder'),
  hide: () => ipcRenderer.send('download-window-hide'),
  onUpdate: callback => ipcRenderer.on('download-window-update', (_, job) => callback(job)),
});
