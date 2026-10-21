const { t: __sahmT } = require('./locale.cjs');
const { ipcMain, dialog, shell, nativeTheme, app } = require('electron');
const fs = require('node:fs/promises');

function wireIpc({ window, manager, preferences, bridge, discoverLinks, vault, connectionSettings, sites, siteBrowser, openSite, quota, syncs, completion, network, browserInstaller, downloadWindows, onLanguageChanged = () => {} }) {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted application frame');
    return callback(...args);
  });
  const settings = async () => {
    const values = preferences.snapshot();
    const state = await bridge.status();
    return { ...values, vault: { available: !!vault?.available(), warning: vault?.loadError || null }, browser: { ...state, extensionPath: state.extensionDirectory, enabled: values.captureEnabled } };
  };
  handle('show-download-window', id => {
    if (!downloadWindows) throw new Error('نافذة التنزيل غير متاحة.');
    return downloadWindows.show(id);
  });
  let preferenceChanges = Promise.resolve();
  const applyUpdate = async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('إعدادات غير صالحة.');
    const data = { ...input };
    if (Object.hasOwn(data, 'network')) throw new Error('احفظ إعدادات الوكيل من نافذة الاتصال والوكيل.');
    if (Object.hasOwn(data, 'serverRules')) throw new Error('احفظ قواعد النطاقات من قسمها المخصص.');
    if (Object.hasOwn(data, 'downloadRulesText')) {
      if (Object.hasOwn(data, 'downloadRules')) throw new Error('اختر صيغة واحدة لقواعد تصنيف التنزيلات.');
      const { parseDownloadRules } = await import('../src/download-rules.mjs');
      data.downloadRules = parseDownloadRules(data.downloadRulesText);
      delete data.downloadRulesText;
    }
    const checked = preferences.validate(data), previous = preferences.snapshot();
    const startupChanged = Object.hasOwn(checked, 'startWithWindows') && checked.startWithWindows !== previous.startWithWindows;
    const loginArguments = { path: process.execPath, args: app.isPackaged ? ['--background'] : [app.getAppPath(), '--background'] };
    const previousLogin = startupChanged ? app.getLoginItemSettings(loginArguments).openAtLogin : null;
    let startupApplied = false, values;
    try {
      if (startupChanged) { app.setLoginItemSettings({ ...loginArguments, openAtLogin: checked.startWithWindows }); startupApplied = true; }
      values = await preferences.update(checked);
    } catch (error) {
      if (startupApplied) {
        try { app.setLoginItemSettings({ ...loginArguments, openAtLogin: previousLogin }); }
        catch { throw new Error('تعذّر حفظ الإعدادات واستعادة إعداد بدء التشغيل السابق. راجع بدء التشغيل في إعدادات Windows.'); }
      }
      throw error;
    }
    manager.parallel = values.parallel;
    manager.speedLimit = values.speedLimit;
    manager.downloadDirectory = values.downloadDirectory;
    manager.downloadRules = values.downloadRules;
    manager.scannerConfig = values.scanner;
    if (sites) sites.downloadDirectory = values.downloadDirectory;
    if (syncs) syncs.defaultDirectory = values.downloadDirectory;
    nativeTheme.themeSource = values.theme;
    manager.pump();
    if (values.language !== previous.language) onLanguageChanged(values.language);
    return settings();
  };
  const update = data => {
    preferenceChanges = preferenceChanges.catch(() => {}).then(() => applyUpdate(data));
    return preferenceChanges;
  };
  const addDownload = async data => {
    const { youtubeUrl, streamMediaUrl } = await import('../browser/extension/media-policy.mjs');
    const mediaUrl = youtubeUrl(data.url) || streamMediaUrl(data.url);
    if (mediaUrl) return manager.addMedia({ url: mediaUrl, title: data.name, quality: data.quality, container: data.container, audioTrack: data.audioTrack, source: 'manual', startAt: data.startAt, queueId: data.queueId });
    return manager.add({ url: data.url, name: data.name, connections: data.connections, startAt: data.startAt, queueId: data.queueId, credentials: data.credentials, rememberCredentials: data.rememberCredentials === true, ftpTLS: data.ftpTLS });
  };
  handle('list', () => manager.list());
  handle('add', addDownload);
  handle('media-inspect', url => manager.inspectMedia(url));
  handle('action', (id, action) => manager.action(id, action));
  handle('queues', () => manager.queues());
  handle('completion-status', () => completion?.snapshot() || []);
  handle('completion-cancel', queueId => {
    if (typeof queueId !== 'string' || !queueId || queueId.length > 200) throw new Error('معرّف القائمة غير صالح.');
    completion?.cancel(queueId);
    return completion?.snapshot() || [];
  });
  handle('queue-action', (action, data) => {
    if (action === 'remove' && syncs?.list().some(project => project.queueId === data.id)) throw new Error('افصل مشاريع المزامنة المرتبطة بهذه القائمة قبل إزالتها.');
    return manager.queueAction(action, data);
  });
  handle('refresh-address', (id, url) => manager.refreshAddress(id, url));
  handle('ftp-credentials', (id, data) => manager.updateFtpCredentials(id, data.credentials, data.remember === true));
  handle('network-settings', () => connectionSettings.snapshot());
  handle('server-rules', () => preferences.snapshot().serverRules || []);
  handle('server-rules-save', async input => {
    const { normalizeServerRules } = await import('../src/server-rules.mjs');
    const rules = normalizeServerRules(input), consumers = [manager, sites, syncs].filter(Boolean);
    if (consumers.some(value => value.networkChanging)) throw new Error('يجري حفظ الاتصال. انتظر اكتماله.');
    if (consumers.some(value => value.active.size) || manager.pending?.size || manager.addressRefreshes?.size || manager.mediaInspections || siteBrowser?.hasActive() || network?.serverLimits?.active) throw new Error('أوقف التنزيلات ونسخ المواقع والمزامنة وفحص الفيديو قبل تغيير قواعد الاتصال.');
    if (!network) throw new Error('خدمة الشبكة غير متاحة.');
    const previous = preferences.snapshot().serverRules || [];
    for (const value of consumers) value.networkChanging = true;
    try {
      await preferences.update({ serverRules: rules });
      try { network.setServerRules(rules); manager.serverRules = rules; }
      catch (error) {
        try { await preferences.update({ serverRules: previous }); network.setServerRules(previous); manager.serverRules = previous; }
        catch { throw new Error('تعذّر تطبيق القواعد واستعادة إعدادها السابق. راجع قواعد الاتصال قبل المتابعة.'); }
        throw error;
      }
      return rules;
    } finally { for (const value of consumers) { value.networkChanging = false; value.pump(); } }
  });
  handle('server-rule-directory', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('network-save', async data => {
    const consumers = [manager, sites, syncs].filter(Boolean);
    if (consumers.some(value => value.networkChanging)) throw new Error('يجري تحديث الاتصال بالفعل. انتظر اكتمال الحفظ.');
    if (consumers.some(value => value.active.size) || siteBrowser?.hasActive()) throw new Error('أوقف التنزيلات ونسخ المواقع والمزامنة وأغلق نافذة تسجيل الدخول قبل تغيير إعدادات الوكيل.');
    for (const value of consumers) value.networkChanging = true;
    try { return await connectionSettings.save(data); }
    finally { for (const value of consumers) { value.networkChanging = false; value.pump(); } }
  });
  handle('quota', async () => { await quota.refresh().catch(() => {}); return quota.snapshot(); });
  handle('quota-save', async config => {
    const result = await quota.configure(config);
    manager.pump(); sites.pump(); syncs.pump();
    return result;
  });
  handle('syncs', () => syncs.list());
  handle('sync-add', data => {
    if (data.queueId && !manager.queueStore.get(data.queueId)) throw new Error('قائمة التنزيل غير موجودة.');
    return syncs.add(data);
  });
  handle('sync-action', (id, action) => syncs.action(id, action));
  handle('sync-update', (id, data) => {
    if (data.queueId && !manager.queueStore.get(data.queueId)) throw new Error('قائمة التنزيل غير موجودة.');
    return syncs.update(id, data);
  });
  handle('sync-folder', id => {
    const project = syncs.list().find(value => value.id === id);
    if (!project) throw new Error('مشروع المزامنة غير موجود.');
    return shell.openPath(project.directory);
  });
  handle('choose-pac', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'PAC', extensions: ['pac', 'js'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('choose-client-certificate', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: __sahmT("شهادة عميل PKCS#12"), extensions: ['pfx', 'p12'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('choose-scanner', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: __sahmT("برنامج فحص الملفات"), extensions: ['exe'] }] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('sites', () => sites.list());
  handle('site-sessions', () => siteBrowser?.snapshot() || []);
  handle('site-session-open', async url => {
    if (!siteBrowser) throw new Error('تسجيل دخول المواقع غير متاح.');
    if ([manager, sites, syncs].some(value => value?.networkChanging)) throw new Error('انتظر اكتمال تغيير إعدادات الاتصال قبل تسجيل الدخول.');
    const { normalizeMirrorUrl } = await import('../src/site-mirror.mjs');
    return siteBrowser.openLogin(normalizeMirrorUrl(url));
  });
  handle('site-session-remove', async id => {
    if (!siteBrowser?.get(id)) throw new Error('جلسة الموقع غير موجودة.');
    try { await sites.detachSession(id); }
    finally { await siteBrowser.removeSession(id); }
    return siteBrowser.snapshot();
  });
  handle('site-session-attach', (id, sessionId) => sites.attachSession(id, sessionId));
  handle('site-add', data => sites.add(data));
  handle('site-action', (id, action) => sites.action(id, action));
  handle('site-schedule', (id, data) => sites.updateSchedule(id, data));
  handle('site-open', (id, version = 'current') => { if (!['current', 'previous'].includes(version)) throw new Error('إصدار الموقع غير صالح.'); return openSite(id, version); });
  handle('site-folder', id => {
    const job = sites.jobs.find(value => value.id === id);
    if (job) return shell.openPath(job.directory);
  });
  handle('batch-preview', async pattern => {
    const { expandBatch } = await import('../src/batch.mjs');
    return expandBatch(pattern);
  });
  handle('batch-add', async data => {
    const { expandBatch } = await import('../src/batch.mjs');
    const urls = expandBatch(data.pattern);
    if (!manager.queueStore.get(data.queueId || 'default')) throw new Error('قائمة التنزيل غير موجودة.');
    let added = 0, rejected = 0;
    for (const url of urls) {
      try { await addDownload({ url, connections: 4, queueId: data.queueId }); added++; }
      catch { rejected++; }
    }
    return { added, rejected };
  });
  handle('reveal', id => {
    const job = manager.jobs.find(j => j.id === id);
    if (job?.status === 'complete') shell.showItemInFolder(job.path);
  });
  handle('settings', settings);
  handle('preferences', update);
  handle('capture', value => {
    if (typeof value !== 'boolean') throw new Error('قيمة الالتقاط غير صالحة.');
    return update({ captureEnabled: value });
  });
  handle('integration', async action => {
    if (action === 'register') await bridge.register();
    else if (action === 'unregister') await bridge.unregister();
    else if (action === 'open-extension') {
      const error = await shell.openPath(bridge.extensionDirectory);
      if (error) throw new Error(error);
    } else if (action === 'install-chrome' || action === 'install-edge') {
      if (!browserInstaller) throw new Error('تثبيت الإضافة غير متاح.');
      await browserInstaller.open(action.slice(8));
    } else throw new Error('إجراء ربط غير معروف.');
    return settings();
  });
  handle('choose-directory', async () => {
    const choice = await dialog.showOpenDialog(window, { defaultPath: preferences.snapshot().downloadDirectory, properties: ['openDirectory', 'createDirectory'] });
    if (!choice.canceled) return update({ downloadDirectory: choice.filePaths[0] });
    return settings();
  });
  handle('grab', url => discoverLinks(url));
  handle('export', async () => {
    const result = await dialog.showSaveDialog(window, { defaultPath: 'sahm-links.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (!result.canceled) await fs.writeFile(result.filePath, manager.jobs.map(j => j.url).join('\r\n'));
    return !result.canceled;
  });
  handle('import', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (result.canceled) return { added: 0, rejected: 0 };
    const stat = await fs.stat(result.filePaths[0]);
    if (stat.size > 1024 * 1024) throw new Error('اختر ملفًا أقل من 1 ميجابايت.');
    const lines = (await fs.readFile(result.filePaths[0], 'utf8')).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length > 500) throw new Error('الحد الأقصى 500 رابط في المرة.');
    let added = 0, rejected = 0;
    for (const url of lines) { try { await addDownload({ url }); added++; } catch { rejected++; } }
    return { added, rejected };
  });
}

module.exports = { wireIpc };

