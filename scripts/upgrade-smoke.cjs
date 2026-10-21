const { app, BrowserWindow, clipboard, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : path.resolve(process.argv[index + 1]);
};
const current = argument('--source-root', path.resolve(__dirname, '..'));
const previous = argument('--old-root', path.resolve('dist/0.12.0/SAHM-win32-x64/resources/app.asar'));
const captures = process.argv.includes('--capture');
if (captures) app.disableHardwareAcceleration();
const report = { ok: false, sourceRoot: current, previousRoot: previous, assertions: [], installerExecuted: false,
  virtualMachineUsed: false, personalProfileUsed: false, windowsStartupChanged: false, registryChanged: false,
  realWindowsSafeStorage: true, nativeHostRegistryMigrationTested: false };
let directory, profile, server, oldManager, oldSites, oldSync, oldBridge, mainWindow, finished = false;
let stage = 'legacy-fixture';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = (root, file) => import(pathToFileURL(path.join(root, file)));
clipboard.readText = async () => '';
app.setLoginItemSettings = () => { throw new Error('Upgrade test cannot change Windows startup'); };
shell.openPath = async () => { throw new Error('Upgrade test cannot open external files'); };
shell.openExternal = async () => { throw new Error('Upgrade test cannot open external URLs'); };

async function wait(check, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error('Upgrade timed out: ' + label);
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) { report.error = error.stack; console.error(error.stack); }
  report.stage = stage;
  await oldBridge?.close(); await oldSites?.close(); await oldSync?.close(); await oldManager?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log('UPGRADE ' + (error ? 'FAIL' : 'PASS') + ': ' + path.join(directory, 'result.json'));
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  app.quit();
}

(async () => {
  directory = path.resolve('artifacts/upgrade-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  profile = path.join(directory, 'profile');
  const files = path.join(directory, 'files');
  await fs.mkdir(profile); await fs.mkdir(files);
  app.setPath('userData', profile); app.setPath('downloads', files);
  await app.whenReady();
  const watchdog = setTimeout(() => finish(new Error('Upgrade watchdog: ' + stage)), 130000); watchdog.unref();
  const previousVersion = JSON.parse(await fs.readFile(path.join(previous, 'package.json'), 'utf8')).version;
  assert.ok(['0.12.0', '0.13.0'].includes(previousVersion)); report.previousVersion = previousVersion;
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  report.previousAsarSha256 = hash(await require('node:util').promisify(require('original-fs').readFile)(previous));
  const [{ DownloadManager }, { Preferences }, { CredentialVault }, { QuotaStore }, { SyncService }, { SiteCopies }, oldDownload, oldBrowser] = await Promise.all([
    load(previous, 'src/manager.mjs'), load(previous, 'src/preferences.mjs'), load(previous, 'src/credential-vault.mjs'),
    load(previous, 'src/quota.mjs'), load(previous, 'src/synchronization.mjs'), load(previous, 'src/site-copies.mjs'),
    load(previous, 'src/download.mjs'), load(previous, 'src/browser-bridge.mjs'),
  ]);
  const payload = Buffer.alloc(2 * 1024 * 1024, 'SAHM actual 0.12 upgrade fixture\n');
  const requests = [];
  server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, range: request.headers.range || null });
    if (request.url === '/robots.txt') { response.writeHead(404); response.end(); return; }
    if (request.url === '/site') {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Legacy snapshot</title><p>Saved by SAHM 0.12</p>'); return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, ETag: '"upgrade-v1"', 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
      ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + payload.length } : {}) });
    for (let offset = start; offset <= end && !response.destroyed; offset += 16384) { response.write(payload.subarray(offset, Math.min(offset + 16384, end + 1))); await delay(3); }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const preferences = await new Preferences(profile, files).init();
  await preferences.update({ theme: 'dark', parallel: 3, captureEnabled: true, sessionCaptureEnabled: true, postCaptureEnabled: true,
    tableLayout: { columns: [{ id: 'path', visible: true, width: 400 }, { id: 'name', width: 180 }], sort: { key: 'path', direction: 'asc' } } });
  const expectedPreferences = preferences.snapshot();
  const vault = await new CredentialVault(profile, safeStorage).init();
  const secret = { username: 'upgrade-fixture', password: 'artificial-upgrade-only-password' };
  await vault.set('test:upgrade', secret);
  oldManager = await new DownloadManager(profile, files, { vault }).init();
  const complete = await oldManager.add({ url: origin + '/complete', name: 'مكتمل-قديم.bin' });
  await wait(() => oldManager.list().find(job => job.id === complete.id)?.status === 'complete', 'old complete file');
  const future = new Date(Date.now() + 86400000).toISOString();
  const partial = await oldManager.add({ url: origin + '/partial', name: 'partial.bin', startAt: future });
  await oldManager.action(partial.id, 'pause');
  const controller = new AbortController();
  await assert.rejects(oldDownload.download(partial.url, partial.path, { signal: controller.signal, onProgress: value => { if (value.received >= 262144) controller.abort(new Error('Old version paused')); } }), /Old version paused/);
  const resume = JSON.parse(await fs.readFile(partial.path + '.resume.json', 'utf8'));
  const retained = resume.parts.reduce((sum, part) => sum + part.done, 0);
  assert.ok(retained > 0 && retained < payload.length);
  let legacyPost;
  if (previousVersion === '0.12.0') {
    legacyPost = await oldManager.addPrepared({ url: origin + '/legacy-post', startAt: future,
      requestContext: { method: 'POST', bodyBase64: Buffer.from('artificial-sensitive-post').toString('base64'), headers: { cookie: 'artificial-cookie' } } }, new Response('retained'));
    await oldManager.action(legacyPost.id, 'pause');
  } else {
    const browserPath = path.join(files, 'browser-original-post.bin');
    await fs.writeFile(browserPath, 'original-browser-response');
    legacyPost = await oldManager.importBrowserCompleted({ url: origin + '/legacy-post', externalId: 'upgrade:browser-completed', browserFile: { path: browserPath, bytes: Buffer.byteLength('original-browser-response') } });
  }
  const queue = (await oldManager.queueAction('create', { name: 'قائمة قديمة', parallel: 1, enabled: false })).queue;
  const ftp = await oldManager.add({ url: 'ftp://127.0.0.1:1/fixture.bin', startAt: future, queueId: queue.id, credentials: secret, rememberCredentials: true });
  await oldManager.action(ftp.id, 'pause');
  const quota = await new QuotaStore(profile).init();
  await quota.configure({ enabled: true, limitBytes: 16 * 1024 * 1024, periodHours: 24 }); await quota.consume(12345);
  const expectedQuota = quota.snapshot();
  oldSync = await new SyncService(profile, files).init();
  const sync = await oldSync.add({ name: 'مزامنة قديمة', enabled: false, intervalMinutes: 120, urls: [origin + '/sync'] });
  oldSites = await new SiteCopies(profile, files).init();
  const site = await oldSites.add({ url: origin + '/site' });
  await wait(() => oldSites.list().find(value => value.id === site.id)?.state === 'complete', 'old offline site');
  await wait(() => oldSites.active.size === 0, 'old site storage');
  await oldSites.updateSchedule(site.id, { enabled: false, intervalMinutes: 120 });
  const oldEntry = await oldSites.entry(site.id);
  const offlineBytes = await fs.readFile(path.join(oldEntry.directory, oldEntry.entryPath));
  oldBridge = await oldBrowser.startBrowserBridge({ dataDirectory: profile, preflight: async () => {}, onDownload: async () => complete });
  const connection = JSON.parse(await fs.readFile(path.join(profile, 'browser-integration/connection.json'), 'utf8'));
  const { sendToBridge } = await load(previous, 'browser/native-host.mjs');
  const originalRequest = { v: 1, type: 'enqueue', requestId: 'upgrade:old-download', expiresAt: Date.now() + 8000, source: 'context-menu', url: complete.url };
  assert.equal((await sendToBridge(connection, originalRequest)).jobId, complete.id);
  await oldBridge.close(); oldBridge = null; await oldSites.close(); oldSites = null; await oldSync.close(); oldSync = null; await oldManager.close(); oldManager = null;
  const vaultBytes = await fs.readFile(path.join(profile, 'credentials.dat'));
  const connectionBytes = await fs.readFile(path.join(profile, 'browser-integration/connection.json'));
  const receiptBytes = await fs.readFile(path.join(profile, 'browser-integration/receipts.json'));
  report.assertions.push(previousVersion + ' code created completed and partial downloads, POST, FTP credentials, queues, quota, sync and an offline site');
  report.oldPartialBytes = retained;
  stage = 'new-application-startup';
  app.on('browser-window-created', (_, created) => {
    if (mainWindow) return;
    mainWindow = created;
    created.webContents.once('did-finish-load', async () => {
      try {
        const evaluate = source => created.webContents.executeJavaScript(source);
        await wait(() => evaluate('window.sahm && document.querySelectorAll("#jobs tr").length >= 4'), 'new UI and IPC');
        const jobs = await evaluate('window.sahm.list()');
        assert.equal(jobs.length, 4); assert.equal(jobs.find(job => job.id === complete.id).status, 'complete');
        assert.equal(jobs.find(job => job.id === partial.id).status, 'paused');
        const post = jobs.find(job => job.id === legacyPost.id);
        if (previousVersion === '0.12.0') assert.equal(post.needsRecapture, true);
        else {
          assert.equal(post.status, 'complete'); assert.equal(post.needsRecapture, false);
          assert.equal(post.path, legacyPost.path); assert.equal(post.replayPolicy, 'browser-completed');
          assert.equal(await fs.readFile(post.path, 'utf8'), 'original-browser-response');
        }
        const currentPreferences = await evaluate('window.sahm.settings()');
        assert.equal(await evaluate('document.querySelector("#post-capture-enabled").closest(".setting-row").textContent.includes("الاستجابة الأصلية")'), true);
        assert.deepEqual(Object.fromEntries(Object.keys(expectedPreferences).map(key => [key, currentPreferences[key]])), expectedPreferences);
        assert.equal(currentPreferences.vault.available, true);
        assert.equal(currentPreferences.browser.running, true);
        assert.equal((await evaluate('window.sahm.queues()')).find(value => value.id === queue.id).enabled, false);
        const currentQuota = await evaluate('window.sahm.quota()');
        assert.equal(currentQuota.usedBytes, expectedQuota.usedBytes); assert.equal(currentQuota.resetAt, expectedQuota.resetAt);
        assert.equal((await evaluate('window.sahm.syncs()')).find(value => value.id === sync.id).enabled, false);
        assert.equal((await evaluate('window.sahm.sites()')).find(value => value.id === site.id).schedule.enabled, false);
        assert.deepEqual(await fs.readFile(path.join(oldEntry.directory, oldEntry.entryPath)), offlineBytes);
        const { CredentialVault: NewVault } = await load(current, 'src/credential-vault.mjs');
        const newVault = await new NewVault(profile, safeStorage).init();
        assert.deepEqual(newVault.get('test:upgrade'), secret); assert.deepEqual(newVault.get('ftp:' + ftp.id), secret);
        assert.deepEqual(await fs.readFile(path.join(profile, 'credentials.dat')), vaultBytes);
        assert.deepEqual(await fs.readFile(path.join(profile, 'browser-integration/connection.json')), connectionBytes);
        assert.deepEqual(await fs.readFile(path.join(profile, 'browser-integration/receipts.json')), receiptBytes);
        report.assertions.push('New main process and IPC retain IDs, paths, columns, settings, queues, spent quota, sync and offline snapshots');
        report.assertions.push('Actual Windows safeStorage decrypts old secrets; encrypted vault, bridge identity and receipts are byte-identical');
        const { sendToBridge: newSend } = await load(current, 'browser/native-host.mjs');
        const replayStart = requests.length;
        assert.equal((await newSend(connection, { ...originalRequest, expiresAt: Date.now() + 8000 })).jobId, complete.id);
        assert.equal(requests.length, replayStart);
        const rejection = await evaluate('window.sahm.action(' + JSON.stringify(legacyPost.id) + ',"resume").then(()=>false,()=>true)');
        assert.equal(rejection, previousVersion === '0.12.0'); assert.ok(!requests.some(value => value.method === 'POST'));
        if (previousVersion === '0.13.0') {
          const preserved = (await evaluate('window.sahm.list()')).find(job => job.id === legacyPost.id);
          assert.equal(preserved.status, 'complete'); assert.equal(preserved.id, legacyPost.id);
          assert.equal(await fs.readFile(preserved.path, 'utf8'), 'original-browser-response');
        }
        report.assertions.push('Old receipt retries return the original job without a request; legacy POST cannot replay after upgrade');
        stage = 'resume-old-partial';
        await evaluate('window.sahm.action(' + JSON.stringify(partial.id) + ',"resume")');
        await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === partial.id).status === 'complete', 'new version completes old parts');
        assert.equal(hash(await fs.readFile(partial.path)), hash(payload));
        assert.equal(hash(await fs.readFile(complete.path)), hash(payload));
        assert.ok(requests.slice(replayStart).some(value => value.url === '/partial' && resume.parts.some(part => part.done > 0 && value.range?.startsWith('bytes=' + (part.start + part.done) + '-'))));
        report.assertions.push('The current version resumes persisted ' + previousVersion + ' offsets to matching SHA256 without changing the old completed file');
        stage = 'failed-settings-write';
        const preferencePath = path.join(profile, 'preferences.json'), before = await fs.readFile(preferencePath);
        await fs.mkdir(preferencePath + '.tmp');
        try {
          assert.equal(await evaluate('window.sahm.preferences({parallel:2}).then(()=>false,()=>true)'), true);
          assert.deepEqual(await fs.readFile(preferencePath), before);
          assert.equal((await evaluate('window.sahm.settings()')).parallel, expectedPreferences.parallel);
        } finally { await fs.rmdir(preferencePath + '.tmp'); }
        report.assertions.push('A real filesystem write failure preserves the previous settings bytes and in-memory preferences');
        if (captures) {
          created.show();
          await evaluate('document.querySelector("[data-view=browser]").click()'); await delay(150);
          await fs.writeFile(path.join(directory, 'browser-settings.png'), (await created.webContents.capturePage()).toPNG());
        }
        report.ok = true; report.completedSha256 = hash(payload); report.finalVersion = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8')).version;
        stage = 'complete'; await finish();
      } catch (error) { await finish(error); }
    });
  });
  require(path.join(current, 'electron/main.cjs'));
})().catch(error => { if (directory) finish(error); else { console.error(error); app.exit(1); } });
