const locale = require('./locale.cjs');
const { t: __sahmT } = locale;
const { app, BrowserWindow, dialog, Menu, nativeTheme, Tray, nativeImage, clipboard, safeStorage, Notification, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { wireIpc } = require('./ipc.cjs');
const { createCompletionPlatform } = require('./completion-platform.cjs');
const { SiteBrowserService } = require('./site-browser.cjs');
const { createClipboardMonitor } = require('./clipboard-monitor.cjs');
const { createBrowserInstaller } = require('./browser-installer.cjs');
const { createDownloadWindows } = require('./download-windows.cjs');

const { selectDataDirectory } = require('./data-location.cjs');
const currentData = app.getPath('userData');
const selectedData = selectDataDirectory(currentData, app.getPath('appData'));
if (selectedData !== currentData) app.setPath('userData', selectedData);
app.setName('SAHM');
app.setAppUserModelId('com.sahm.downloadmanager');
if (process.env.RAFID_SCREENSHOT || process.env.SAHM_SCREENSHOT) app.disableHardwareAcceleration();
const log = message => {
  const file = process.env.SAHM_DIAGNOSTICS || process.env.RAFID_DIAGNOSTICS;
  if (file) require('node:fs').appendFileSync(file, new Date().toISOString() + ' ' + message + '\n');
};
let manager, bridge, window, tray, closing = false, quitting = false;
let network, connectionSettings, vault, sites, quota, syncs, policyTimer, completion, siteBrowser;
const offlineViews = new Map();
let setupBrowserRequested = process.argv.includes('--setup-browser');
let browserSetupRunning = false;
let browserInstaller;
let downloadWindows;
let clipboardTimer, clipboardMonitor;
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
async function setupBrowser() {
  if (!setupBrowserRequested || browserSetupRunning || !bridge || !window || window.webContents.isLoading()) return;
  setupBrowserRequested = false; browserSetupRunning = true;
  try {
    showWindow();
    window.webContents.send('command', 'browser');
    await browserInstaller.prompt(window);
  } catch (error) { await dialog.showMessageBox(window, { type: 'error', title: __sahmT("تكامل المتصفح"), message: __sahmT("تعذّر إكمال إعداد إضافة المتصفح."), detail: locale.formatMessage(error.message) }); }
  finally { browserSetupRunning = false; }
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_, argv) => { showWindow(); if (argv.includes('--setup-browser')) { setupBrowserRequested = true; setupBrowser(); } });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  const [{ DownloadManager }, { Preferences }, { startBrowserBridge }, { discoverLinks }] = await Promise.all([
    import('../src/manager.mjs'), import('../src/preferences.mjs'), import('../src/browser-bridge.mjs'), import('../src/grabber.mjs')
  ]);
  const { useWindowsSystemTrust } = await import('../src/windows-trust.mjs');
  try { useWindowsSystemTrust(); }
  catch { log('Windows CA roots could not be loaded; existing TLS trust remains active.'); }
  const preferences = await new Preferences(app.getPath('userData'), path.join(app.getPath('downloads'), 'SAHM')).init();
  const values = preferences.snapshot();
  locale.setLanguage(values.language);
  const { STORE_RELEASE } = await import('../browser/distribution.mjs');
  browserInstaller = createBrowserInstaller({ stores: STORE_RELEASE, dialog, registerHost: () => bridge.register() });
  const [{ CredentialVault }, { NetworkService }, { ConnectionSettings }, { SiteCopies }, { setTransportFetch }, { QuotaStore }, { SyncService }, { queueIsOpen }] = await Promise.all([
    import('../src/credential-vault.mjs'), import('../src/network.mjs'), import('../src/connection-settings.mjs'), import('../src/site-copies.mjs'), import('../src/transport.mjs'), import('../src/quota.mjs'), import('../src/synchronization.mjs'), import('../src/queues.mjs')
  ]);
  vault = await new CredentialVault(app.getPath('userData'), safeStorage).init();
  log('credential vault available: ' + vault.available());
  quota = new QuotaStore(app.getPath('userData'));
  try { await quota.init(); }
  catch (error) { log(error.message); }
  network = new NetworkService({
    credentialsProvider: route => connectionSettings?.credentialsFor(route),
    serverCredentialsProvider: origin => connectionSettings?.serverCredentialsFor(origin),
    clientCertificateProvider: origin => connectionSettings?.clientCertificateFor(origin), quota, serverRules: values.serverRules
  });
  connectionSettings = await new ConnectionSettings(network, preferences, vault).init();
  const budgetedFetch = quota.wrapFetch(network.createFetch());
  setTransportFetch(budgetedFetch);
  manager = await new DownloadManager(app.getPath('userData'), values.downloadDirectory, { mediaRuntimeDirectory: app.isPackaged ? path.join(process.resourcesPath, 'media-runtime') : undefined, network, vault, quota }).init();
  siteBrowser = new SiteBrowserService({ app, BrowserWindow, session, Menu, network, parent: () => window, onChange: sessions => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send('site-sessions', sessions);
    if (sites) window.webContents.send('sites', sites.list());
  } });
  sites = await new SiteCopies(app.getPath('userData'), values.downloadDirectory, { quota, browserService: siteBrowser }).init();
  syncs = await new SyncService(app.getPath('userData'), values.downloadDirectory, { quota, fetchImpl: budgetedFetch, canRun: id => {
    const queue = id ? manager.queueStore.get(id) : null;
    return !manager.networkChanging && (!id || !!queue && queueIsOpen(queue));
  } }).init();
  manager.parallel = values.parallel;
  manager.speedLimit = values.speedLimit;
  manager.serverRules = values.serverRules;
  manager.downloadRules = values.downloadRules;
  manager.scannerConfig = values.scanner;
  nativeTheme.themeSource = values.theme;
  const { CompletionActions } = await import('../src/completion-actions.mjs');
  const platform = createCompletionPlatform({ app, Notification, shell, showWindow, getDirectory: () => preferences.snapshot().downloadDirectory });
  const systemActions = new Set(['exit', 'shutdown', 'sleep', 'hibernate']);
  const completionBusy = () => (
    manager.jobs.some(job => job.status !== 'complete' || job.scanResult?.status === 'running') ||
    manager.active.size > 0 || manager.pending.size > 0 || manager.addressRefreshes.size > 0 ||
    sites.active.size > 0 || syncs.active.size > 0 || siteBrowser?.hasActive() ||
    manager.networkChanging || sites.networkChanging || syncs.networkChanging
  );
  let executingSystemAction = false;
  completion = new CompletionActions({
    queueSnapshot: () => manager.queues(), jobsSnapshot: () => manager.jobs,
    activeSnapshot: () => manager.active.keys(), isBusy: completionBusy,
    execute: async status => {
      const systemAction = systemActions.has(status.type);
      // Recheck at the final native boundary, including work added by an event
      // listener while the controller publishes its executing status.
      if (quitting || systemAction && (executingSystemAction || completionBusy())) throw new Error('تعذّر تنفيذ الإجراء لوجود عمل جارٍ.');
      if (!systemAction) return platform.execute(status);
      executingSystemAction = true;
      try {
        for (const other of completion.snapshot()) {
          if (other.queueId !== status.queueId && systemActions.has(other.type)) completion.cancel(other.queueId, 'another-action-started');
        }
        await platform.execute(status);
      } finally { executingSystemAction = false; }
    }
  });
  completion.on('controller-error', error => log('completion controller failed: ' + error.message));
  const announcedCountdowns = new Map();
  completion.on('change', statuses => {
    for (const status of statuses) {
      if (status.state !== 'pending' || status.remainingSeconds <= 0 || announcedCountdowns.get(status.queueId) === status.deadline) continue;
      announcedCountdowns.set(status.queueId, status.deadline);
      try { platform.announce?.(status); } catch { /* The in-app countdown remains available. */ }
    }
  });
  // Establish the baseline before browser capture can enqueue a fast download.
  completion.start();
  for (const [source, event] of [[manager, 'change'], [manager, 'queues'], [sites, 'change'], [syncs, 'change']]) {
    source.on(event, () => completion.reconcile());
  }
  const canCapture = request => {
    if (manager.networkChanging || sites.networkChanging) throw new Error('يجري تحديث الاتصال. أعد المحاولة بعد حفظ إعدادات الوكيل.');
    const policy = preferences.snapshot();
    if (!policy.captureEnabled) throw Object.assign(new Error('الالتقاط معطّل في سَهم.'), { code: 'CAPTURE_DISABLED' });
    const context = request.requestContext;
    const hasSession = request.usesCredentials || Object.keys(context?.headers || {}).some(name => /cookie|authorization|csrf|token/i.test(name));
    if (hasSession && !policy.sessionCaptureEnabled) throw Object.assign(new Error('التقاط تنزيلات الجلسات معطّل.'), { code: 'CAPTURE_DISABLED' });
    if ((context?.method || request.method) === 'POST' && !policy.postCaptureEnabled) throw Object.assign(new Error('التقاط تنزيلات POST معطّل.'), { code: 'CAPTURE_DISABLED' });
    return true;
  };
  bridge = await startBrowserBridge({ dataDirectory: app.getPath('userData'), runtimePath: process.execPath, browserDirectory: app.isPackaged ? path.join(process.resourcesPath, 'browser') : undefined, canCapture,
    onBrowserComplete: data => { canCapture(data); return manager.importBrowserCompleted({ ...data, externalId: data.browserRequestId }); },
    onMediaInfo: (request, options) => manager.inspectMedia(request.url, options),
    onMediaDownload: request => { canCapture(request); return manager.addMedia({ url: request.url, quality: request.quality, container: request.container, audioTrack: request.audioTrack, title: request.title, source: 'browser', externalId: request.browserRequestId }); },
    onDownload: async (data, { preparedResponse } = {}) => {
    canCapture(data);
    const input = { ...data, source: 'browser', externalId: data.browserRequestId };
    return preparedResponse ? manager.addPrepared(input, preparedResponse) : manager.add(input);
  } });
  // Repair a previously approved SAHM registration after an upgrade moves its runtime.
  try {
    const integration = await bridge.status();
    if (integration.needsReregister) await bridge.register();
  } catch (error) { log('browser registration repair failed: ' + error.message); }
  window = new BrowserWindow({ width: 1240, height: 820, minWidth: 820, minHeight: 600, show: !process.argv.includes('--background'), title: __sahmT("سَهم — SAHM Download Manager"), icon: path.join(__dirname, '../assets/sahm.png'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../assets/sahm.ico')));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  window.on('close', event => {
    if (quitting || !tray) return;
    event.preventDefault();
    window.hide();
  });
  const notify = (channel, data) => { if (!window.isDestroyed()) window.webContents.send(channel, data); };
  const command = value => notify('command', value);
  completion.on('change', statuses => notify('completion', statuses));
  manager.on('change', jobs => notify('jobs', jobs));
  manager.on('queues', queues => notify('queues', queues));
  manager.on('storage-error', message => notify('storage-error', message));
  sites.on('change', list => notify('sites', list));
  sites.on('storage-error', message => notify('storage-error', message));
  syncs.on('change', list => notify('syncs', list));
  syncs.on('storage-error', message => notify('storage-error', message));
  let lastQuotaNotice = 0;
  quota.on('change', value => {
    if (Date.now() - lastQuotaNotice >= 250 || value.exhausted || value.usedBytes === 0) {
      lastQuotaNotice = Date.now(); notify('quota', value);
    }
  });
  const openSite = async (id, version = 'current') => {
    const { serveOfflineSite } = await import('../src/offline-site.mjs');
    const entry = await sites.entry(id, version);
    const server = await serveOfflineSite(entry.directory, entry.entryPath);
    const view = new BrowserWindow({ width: 1100, height: 780, title: __sahmT("سَهم — نسخة الموقع دون اتصال"), autoHideMenuBar: true, webPreferences: { partition: `sahm-offline-${require('node:crypto').randomUUID()}`, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    offlineViews.set(view, server);
    const session = view.webContents.session;
    session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    await session.setProxy({ mode: 'direct' });
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith(server.prefix) }));
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(server.prefix)) event.preventDefault(); });
    view.on('closed', () => { offlineViews.delete(view); server.close().catch(() => {}); });
    try { await view.loadURL(server.url); }
    catch (error) { view.destroy(); throw error; }
    return true;
  };
  downloadWindows = createDownloadWindows({ BrowserWindow, ipcMain: require('electron').ipcMain, manager, shell, enabled: () => preferences.snapshot().showDownloadWindows });
  require('./ui-session.cjs').wireUiSession({ window, preferences, downloadWindows });
  wireIpc({ window, manager, preferences, bridge, discoverLinks, vault, connectionSettings, sites, siteBrowser, openSite, quota, syncs, completion, network, browserInstaller, downloadWindows, onLanguageChanged: refreshNativeLanguage });
  function refreshNativeLanguage(language) {
    locale.setLanguage(language);
    window.setTitle(__sahmT("سَهم — SAHM Download Manager"));
    tray.setToolTip(__sahmT("سَهم — مدير التنزيلات"));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: __sahmT("فتح سَهم"), click: showWindow },
      { type: 'separator' },
      { label: __sahmT("خروج"), click: () => app.quit() },
    ]));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: __sahmT("ملف"), submenu: [{ label: __sahmT("تنزيل جديد"), accelerator: 'Ctrl+N', click: () => command('add') }, { label: __sahmT("استيراد روابط…"), click: () => command('import') }, { label: __sahmT("تصدير الروابط…"), click: () => command('export') }, { type: 'separator' }, { label: __sahmT("إخفاء إلى جوار الساعة"), accelerator: 'Alt+F4', click: () => window.close() }, { label: __sahmT("خروج"), accelerator: 'Ctrl+Shift+Q', click: () => app.quit() }] },
      { label: __sahmT("تحرير"), submenu: [{ role: 'undo', label: __sahmT("تراجع") }, { type: 'separator' }, { role: 'cut', label: __sahmT("قص") }, { role: 'copy', label: __sahmT("نسخ") }, { role: 'paste', label: __sahmT("لصق") }, { role: 'selectAll', label: __sahmT("تحديد الكل") }, { type: 'separator' }, { label: __sahmT("البحث في التنزيلات"), accelerator: 'Ctrl+F', click: () => command('search') }] },
      { label: __sahmT("تنزيل"), submenu: [{ label: __sahmT("إيقاف الكل"), click: () => command('pause-all') }, { label: __sahmT("استئناف الكل"), click: () => command('resume-all') }, { type: 'separator' }, { label: __sahmT("روابط صفحة…"), click: () => command('grab') }] },
      { label: __sahmT("أدوات"), submenu: [{ label: __sahmT("المزامنة وحصة التنزيل"), click: () => command('automation') }, { label: __sahmT("القوائم والجدولة"), click: () => command('queues') }, { label: __sahmT("نسخ المواقع"), click: () => command('sites') }, { label: __sahmT("الاتصال والوكيل"), click: () => command('network') }, { label: __sahmT("تكامل المتصفح"), click: () => command('browser') }, { label: __sahmT("الإعدادات"), click: () => command('preferences') }] },
      { label: __sahmT("مساعدة"), submenu: [{ label: __sahmT("استخدام سَهم"), accelerator: 'F1', click: () => command('help') }, { type: 'separator' }, { label: __sahmT("حول سَهم"), click: () => dialog.showMessageBox(window, { type: 'info', title: __sahmT("حول سَهم"), message: __sahmT("سَهم — SAHM"), detail: __sahmT("إصدار ") + app.getVersion() + __sahmT("\nمدير تنزيلات مستقل لـ Windows.\nHTTP/HTTPS • تكامل Chrome وEdge • تنزيلات الجلسات وPOST.") }) }] }
    ]));
    downloadWindows.refreshLocale();
    siteBrowser.refreshLocale();
    for (const view of offlineViews.keys()) view.setTitle(__sahmT("سَهم — نسخة الموقع دون اتصال"));
  }
  refreshNativeLanguage(values.language);
  await window.loadFile(path.join(__dirname, '../ui/index.html'));
  await setupBrowser();
  manager.pump();
  sites.pump();
  syncs.pump();
  let checkingPolicies = false;
  policyTimer = setInterval(async () => {
    if (checkingPolicies || quitting) return;
    checkingPolicies = true;
    try { await quota.refresh(); manager.pump(); sites.pump(); syncs.pump(); }
    catch (error) { notify('quota', quota.snapshot()); log(error.message); }
    finally { checkingPolicies = false; }
  }, 1000);
  policyTimer.unref();
  clipboardMonitor = createClipboardMonitor({
    readText: () => clipboard.readText(),
    isEnabled: () => preferences.snapshot().clipboardMonitorEnabled,
    isReady: () => !quitting && !window.isDestroyed() && !window.webContents.isLoading(),
    onLink: url => { showWindow(); window.webContents.send('clipboard-link', url); }
  });
  clipboardTimer = setInterval(() => { void clipboardMonitor.poll(); }, 1500);
  clipboardTimer.unref();
  log('window loaded');
  const screenshot = process.env.SAHM_SCREENSHOT || process.env.RAFID_SCREENSHOT;
  if (screenshot) {
    try {
      await new Promise(resolve => setTimeout(resolve, 800));
      await fs.mkdir(path.dirname(screenshot), { recursive: true });
      await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    } catch (error) { log('capture failed: ' + error.message); }
    finally { app.quit(); }
  }
}).catch(error => { log(error.stack || error.message); dialog.showErrorBox(__sahmT("تعذّر تشغيل سَهم"), error.message); app.exit(1); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', event => {
  quitting = true;
  clearInterval(clipboardTimer);
  downloadWindows?.close();
  clipboardMonitor?.close();
  clearInterval(policyTimer);
  completion?.close();
  if (closing || !manager) return;
  event.preventDefault(); closing = true;
  Promise.allSettled([bridge?.close(), manager.close(), sites?.close(), syncs?.close()]).finally(async () => {
    await siteBrowser?.close().catch(() => {});
    await quota?.refresh().catch(() => {});
    await Promise.allSettled([...offlineViews.values()].map(server => server.close()));
    await network?.close();
    tray?.destroy(); tray = null; app.quit();
  });
});

