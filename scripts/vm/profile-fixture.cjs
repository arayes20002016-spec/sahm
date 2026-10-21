const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
assert.equal(process.env.USERNAME, 'SAHMTest');
assert.equal(fsSync.readFileSync('C:/SahmLab/owned-vm.txt', 'utf8').trim(), 'SAHM-QA-OWNED-VM');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const installedRuntime = process.env.SAHM_VM_INSTALLED_RUNTIME;
assert.ok(installedRuntime && path.isAbsolute(installedRuntime));
const root = path.join(path.dirname(installedRuntime), 'resources/app.asar');
const profile = path.join(process.env.APPDATA, 'sahm-download-manager'), files = 'C:/SahmLab/downloads';
const expectedFile = 'C:/SahmLab/expected.json';
const load = name => import(pathToFileURL(path.join(root, 'src', name)));
const hash = data => createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async check => { const end = Date.now() + 120000; while (Date.now() < end) { if (await check()) return; await delay(50); } throw new Error('VM fixture timeout'); };
const phase = process.argv[2];
fsSync.mkdirSync(profile, { recursive: true });
app.setName('SAHM'); app.setAppUserModelId('com.sahm.downloadmanager');
app.setPath('userData', profile); app.setPath('sessionData', profile);
assert.equal(app.commandLine.getSwitchValue('user-data-dir'), profile);
const encryptionKeyHash = async () => {
  try {
    const key = JSON.parse(await fs.readFile(path.join(profile, 'Local State'), 'utf8')).os_crypt?.encrypted_key;
    return typeof key === 'string' && key ? hash(key) : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
let manager, bridge, sites, sync;
app.whenReady().then(async () => {
  try {
    if (phase === 'preserved') {
      const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8'));
      assert.equal(await encryptionKeyHash(), expected.encryptionKeyHash);
      const values = JSON.parse(safeStorage.decryptString(await fs.readFile(path.join(profile, 'credentials.dat')))).values;
      const secret = { username: 'synthetic-vm-only', password: 'Synthetic-VM-test-only' };
      assert.deepEqual(values['vm:fixture'], secret); assert.deepEqual(values['ftp:' + expected.ftp.id], secret);
      console.log(JSON.stringify({ ok: true, phase, realWindowsSafeStorage: true, profileKeyRetained: true })); app.exit(0); return;
    }
    const [{ DownloadManager }, { Preferences }, { CredentialVault }, { QuotaStore }, { SiteCopies }, { SyncService }, { startBrowserBridge }, { download }] = await Promise.all(['manager.mjs', 'preferences.mjs', 'credential-vault.mjs', 'quota.mjs', 'site-copies.mjs', 'synchronization.mjs', 'browser-bridge.mjs', 'download.mjs'].map(load));
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    const preferences = await new Preferences(profile, files).init();
    const vault = await new CredentialVault(profile, safeStorage).init();
    manager = await new DownloadManager(profile, files, { vault }).init();
    const secret = { username: 'synthetic-vm-only', password: 'Synthetic-VM-test-only' };
    if (phase === 'seed') {
      assert.equal(manager.list().length, 0);
      await preferences.update({ theme: 'dark', parallel: 3, startWithWindows: true, captureEnabled: true, sessionCaptureEnabled: true, postCaptureEnabled: true, tableLayout: { columns: [{ id: 'path', visible: true, width: 380 }, { id: 'name', width: 180 }], sort: { key: 'path', direction: 'asc' } } });
      app.setLoginItemSettings({ path: installedRuntime, args: ['--background'], openAtLogin: true });
      await vault.set('vm:fixture', secret);
      const complete = await manager.add({ url: 'http://127.0.0.1:18080/complete', name: 'مكتمل-قديم.bin' });
      await wait(() => manager.list().find(job => job.id === complete.id)?.status === 'complete');
      const future = new Date(Date.now() + 86400000).toISOString();
      const partial = await manager.add({ url: 'http://127.0.0.1:18080/partial', name: 'partial.bin', startAt: future }); await manager.action(partial.id, 'pause');
      const controller = new AbortController();
      await assert.rejects(download(partial.url, partial.path, { signal: controller.signal, onProgress: value => { if (value.received >= 262144) controller.abort(new Error('VM checkpoint')); } }), /VM checkpoint/);
      const resume = JSON.parse(await fs.readFile(partial.path + '.resume.json', 'utf8')); assert.ok(resume.parts.some(part => part.done > 0));
      const postPath = path.join(files, 'original-browser-post.bin'); await fs.writeFile(postPath, 'original-browser-response');
      const post = await manager.importBrowserCompleted({ url: 'http://127.0.0.1:18080/export', browserFile: { path: postPath, bytes: Buffer.byteLength('original-browser-response') }, externalId: 'vm:browser-completed' });
      const queue = (await manager.queueAction('create', { name: 'قائمة اختبار VM', enabled: false, parallel: 1 })).queue;
      const ftp = await manager.add({ url: 'ftp://127.0.0.1:1/file.bin', startAt: future, queueId: queue.id, credentials: secret, rememberCredentials: true }); await manager.action(ftp.id, 'pause');
      const quota = await new QuotaStore(profile).init(); await quota.configure({ enabled: true, limitBytes: 16 * 1024 * 1024, periodHours: 24 }); await quota.consume(12345);
      sync = await new SyncService(profile, files).init(); const syncJob = await sync.add({ name: 'VM sync', enabled: false, intervalMinutes: 120, urls: ['http://127.0.0.1:18080/sync'] });
      sites = await new SiteCopies(profile, files).init(); const site = await sites.add({ url: 'http://127.0.0.1:18080/site' }); await wait(() => sites.list().find(job => job.id === site.id)?.state === 'complete'); await wait(() => sites.active.size === 0); await sites.updateSchedule(site.id, { enabled: false, intervalMinutes: 120 });
      const entry = await sites.entry(site.id);
      bridge = await startBrowserBridge({ dataDirectory: profile, runtimePath: installedRuntime, browserDirectory: path.join(path.dirname(installedRuntime), 'resources/browser'), preflight: async () => {}, onDownload: async () => complete }); await bridge.register();
      const expected = { previousVersion: version, profile, files, complete, partial, post, ftp, queueId: queue.id, syncId: syncJob.id, siteId: site.id, sitePath: path.join(entry.directory, entry.entryPath), preferences: preferences.snapshot(), quota: quota.snapshot(), completedHash: hash(await fs.readFile(complete.path)), vaultHash: hash(await fs.readFile(path.join(profile, 'credentials.dat'))), bridgeHash: hash(await fs.readFile(path.join(profile, 'browser-integration/connection.json'))) };
      await wait(async () => !!(await encryptionKeyHash())); expected.encryptionKeyHash = await encryptionKeyHash();
      await fs.writeFile(expectedFile, JSON.stringify(expected, null, 2));
    } else if (phase === 'verify') {
      const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8')); const jobs = manager.list();
      assert.equal(jobs.length, 4); assert.equal(jobs.find(job => job.id === expected.partial.id).status, 'paused');
      assert.equal(jobs.find(job => job.id === expected.post.id).status, 'complete'); assert.equal(jobs.find(job => job.id === expected.post.id).path, expected.post.path);
      assert.equal(await fs.readFile(expected.post.path, 'utf8'), 'original-browser-response');
      for (const [key, value] of Object.entries(expected.preferences)) assert.deepEqual(preferences.snapshot()[key], value, key);
      assert.deepEqual(vault.get('vm:fixture'), secret); assert.deepEqual(vault.get('ftp:' + expected.ftp.id), secret);
      assert.equal(jobs.find(job => job.id === expected.ftp.id).needsCredentials, false);
      assert.equal(await encryptionKeyHash(), expected.encryptionKeyHash);
      assert.equal(hash(await fs.readFile(path.join(profile, 'credentials.dat'))), expected.vaultHash); assert.equal(hash(await fs.readFile(path.join(profile, 'browser-integration/connection.json'))), expected.bridgeHash);
      const quota = await new QuotaStore(profile).init(); assert.equal(quota.snapshot().usedBytes, 12345);
      sites = await new SiteCopies(profile, files).init(); sync = await new SyncService(profile, files).init();
      assert.equal(sites.list().find(job => job.id === expected.siteId).schedule.enabled, false); assert.equal(sync.list().find(job => job.id === expected.syncId).enabled, false); await fs.access(expected.sitePath);
      await manager.action(expected.partial.id, 'resume'); await wait(() => manager.list().find(job => job.id === expected.partial.id)?.status === 'complete');
      assert.equal(hash(await fs.readFile(expected.partial.path)), expected.completedHash); assert.equal(hash(await fs.readFile(expected.complete.path)), expected.completedHash);
      await fs.writeFile('C:/SahmLab/verified.json', JSON.stringify({ ok: true, previousVersion: expected.previousVersion, version, realWindowsSafeStorage: true, restoredJobs: jobs.length, partialCompletedSha256: expected.completedHash, originalPostRetained: true, settingsRetained: true, quotaAndSchedulesRetained: true, bridgeIdentityRetained: true }, null, 2));
    } else throw new Error('Unknown fixture phase');
    await bridge?.close(); await sites?.close(); await sync?.close(); await manager.close(); console.log(JSON.stringify({ ok: true, phase, version })); app.exit(0);
  } catch (error) { console.error(error.stack); await fs.writeFile('C:/SahmLab/fixture-error.txt', error.stack).catch(() => {}); app.exit(1); }
});
