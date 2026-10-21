const { contextBridge, ipcRenderer } = require('electron');
const initialLanguage = ipcRenderer.sendSync('ui-language');
const languageListeners = new Set();
let currentLanguage = initialLanguage;
const api = {
  initialLanguage,
  onLanguageChanged: callback => { languageListeners.add(callback); return () => languageListeners.delete(callback); },
  reloadUi: () => ipcRenderer.send('ui-reload'),
  saveUiDraft: value => ipcRenderer.invoke('ui-draft-save', value),
  takeUiDraft: () => ipcRenderer.invoke('ui-draft-take'),
  list: () => ipcRenderer.invoke('list'),
  showDownloadWindow: id => ipcRenderer.invoke('show-download-window', id),
  add: data => ipcRenderer.invoke('add', data),
  inspectMedia: url => ipcRenderer.invoke('media-inspect', url),
  action: (id, action) => ipcRenderer.invoke('action', id, action),
  queues: () => ipcRenderer.invoke('queues'),
  completionStatus: () => ipcRenderer.invoke('completion-status'),
  cancelCompletion: queueId => ipcRenderer.invoke('completion-cancel', queueId),
  onCompletion: callback => ipcRenderer.on('completion', (_, statuses) => callback(statuses)),
  queueAction: (action, data) => ipcRenderer.invoke('queue-action', action, data),
  refreshAddress: (id, url) => ipcRenderer.invoke('refresh-address', id, url),
  ftpCredentials: (id, data) => ipcRenderer.invoke('ftp-credentials', id, data),
  networkSettings: () => ipcRenderer.invoke('network-settings'),
  networkSave: data => ipcRenderer.invoke('network-save', data),
  serverRules: () => ipcRenderer.invoke('server-rules'),
  saveServerRules: rules => ipcRenderer.invoke('server-rules-save', rules),
  chooseServerRuleDirectory: () => ipcRenderer.invoke('server-rule-directory'),
  choosePac: () => ipcRenderer.invoke('choose-pac'),
  chooseClientCertificate: () => ipcRenderer.invoke('choose-client-certificate'),
  chooseScanner: () => ipcRenderer.invoke('choose-scanner'),
  sites: () => ipcRenderer.invoke('sites'),
  siteSchedule: (id, data) => ipcRenderer.invoke('site-schedule', id, data),
  siteSessions: () => ipcRenderer.invoke('site-sessions'),
  openSiteSession: url => ipcRenderer.invoke('site-session-open', url),
  removeSiteSession: id => ipcRenderer.invoke('site-session-remove', id),
  attachSiteSession: (id, sessionId) => ipcRenderer.invoke('site-session-attach', id, sessionId),
  onSiteSessions: callback => ipcRenderer.on('site-sessions', (_, value) => callback(value)),
  quota: () => ipcRenderer.invoke('quota'),
  quotaSave: config => ipcRenderer.invoke('quota-save', config),
  onQuota: callback => ipcRenderer.on('quota', (_, value) => callback(value)),
  syncs: () => ipcRenderer.invoke('syncs'),
  syncAdd: data => ipcRenderer.invoke('sync-add', data),
  syncAction: (id, action) => ipcRenderer.invoke('sync-action', id, action),
  syncUpdate: (id, data) => ipcRenderer.invoke('sync-update', id, data),
  syncFolder: id => ipcRenderer.invoke('sync-folder', id),
  onSyncs: callback => ipcRenderer.on('syncs', (_, value) => callback(value)),
  addSite: data => ipcRenderer.invoke('site-add', data),
  siteAction: (id, action) => ipcRenderer.invoke('site-action', id, action),
  openSite: (id, version) => version === undefined ? ipcRenderer.invoke('site-open', id) : ipcRenderer.invoke('site-open', id, version),
  siteFolder: id => ipcRenderer.invoke('site-folder', id),
  onSites: callback => ipcRenderer.on('sites', (_, value) => callback(value)),
  batchPreview: pattern => ipcRenderer.invoke('batch-preview', pattern),
  batchAdd: data => ipcRenderer.invoke('batch-add', data),
  onQueues: callback => ipcRenderer.on('queues', (_, value) => callback(value)),
  onClipboardLink: callback => ipcRenderer.on('clipboard-link', (_, url) => callback(url)),
  reveal: id => ipcRenderer.invoke('reveal', id),
  export: () => ipcRenderer.invoke('export'),
  import: () => ipcRenderer.invoke('import'),
  settings: () => ipcRenderer.invoke('settings'),
  preferences: async data => {
    const result = await ipcRenderer.invoke('preferences', data);
    if (result.language !== currentLanguage) {
      currentLanguage = result.language;
      setTimeout(() => { for (const listener of languageListeners) listener(result.language); }, 0);
    }
    return result;
  },
  integration: action => ipcRenderer.invoke('integration', action),
  capture: value => ipcRenderer.invoke('capture', value),
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  grab: url => ipcRenderer.invoke('grab', url),
  onCommand: callback => ipcRenderer.on('command', (_, command) => callback(command)),
  onJobs: callback => ipcRenderer.on('jobs', (_, jobs) => callback(jobs)),
  onStorageError: callback => ipcRenderer.on('storage-error', (_, message) => callback(message))
};
contextBridge.exposeInMainWorld('sahm', api);
contextBridge.exposeInMainWorld('rafid', api);
