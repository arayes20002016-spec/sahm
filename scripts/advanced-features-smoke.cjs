const { app, BrowserWindow, clipboard, safeStorage } = require('electron');
const { createServer, request: httpRequest } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

// The app must exercise its startup handler without modifying Windows startup.
const startupCalls = [];
const recordStartup = options => { startupCalls.push(structuredClone(options)); };
app.setLoginItemSettings = recordStartup;
assert.equal(app.setLoginItemSettings, recordStartup);
clipboard.readText = () => '';
app.disableHardwareAcceleration();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assertions = [], requests = [], proxyRequests = [], cleanup = [];
const proxyLogin = { username: 'ui-proxy-user', password: 'ui-proxy-secret-for-test' };
const proxyBasic = `Basic ${Buffer.from(`${proxyLogin.username}:${proxyLogin.password}`).toString('base64')}`;
const payload = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 251));
const visualConfirm = process.argv.includes('--visual-confirm');
let profile, reportDirectory, server, proxy, ftp, mainWindow, offlineWindow, finished = false, stage = 'startup';

async function finish(error) {
  if (finished) return; finished = true;
  if (error) console.error(error.stack || error);
  for (const window of BrowserWindow.getAllWindows()) if (window !== mainWindow) window.destroy();
  for (const close of cleanup.reverse()) await close().catch(() => {});
  for (const value of [proxy, server]) if (value?.listening) { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); }
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, profile, assertions, requests, proxyRequests, startup: { syntheticOnly: true, calls: startupCalls }, encryptionAvailable: safeStorage.isEncryptionAvailable() }, null, 2));
  console.log('REPORT: ' + reportDirectory);
  app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}

(async () => {
  await fs.mkdir(path.resolve('artifacts'), { recursive: true });
  profile = await fs.mkdtemp(path.resolve('artifacts', 'advanced-ui-profile-'));
  reportDirectory = path.resolve('artifacts', 'advanced-features-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  app.setPath('userData', profile); app.setPath('downloads', profile);
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: path.join(profile, 'files'), captureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false }));
  server = createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, viaProxy: request.headers['x-sahm-ui-proxy'] === 'yes' });
    if (request.url === '/file.bin') {
      if (request.headers['x-sahm-ui-proxy'] !== 'yes') { response.writeHead(403); response.end(); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', ETag: '"advanced-ui-file"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) }); response.end(payload.subarray(start, end + 1)); return;
    }
    const resources = {
      '/robots.txt': ['text/plain', 'User-agent: *\nDisallow: /forbidden\n'],
      '/site/': ['text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Offline source fixture</title><link rel="stylesheet" href="main.css"><h1 id="fixture-title">نسخة الموقع للاختبار</h1><a id="next" href="second.html">الصفحة الثانية</a><img id="picture" src="picture.svg"><script src="main.js"></script>'],
      '/site/second.html': ['text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Offline second page</title><h1 id="second-title">الصفحة الثانية المحفوظة</h1><a href="./">الرئيسية</a>'],
      '/site/main.css': ['text/css', 'body{font-family:Arial;background:#eef3f8;color:#173045}img{width:60px;height:40px}'],
      '/site/main.js': ['text/javascript', 'window.fixtureScriptLoaded=true;'],
      '/site/picture.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#147d68"/></svg>'],
    };
    const resource = resources[request.url]; if (!resource) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': resource[0] }); response.end(resource[1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  proxy = createServer((request, response) => {
    const authorized = request.headers['proxy-authorization'] === proxyBasic;
    proxyRequests.push({ method: request.method, url: request.url, authorized });
    if (!authorized) { response.writeHead(407); response.end(); return; }
    const headers = { ...request.headers, 'x-sahm-ui-proxy': 'yes' }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = httpRequest(new URL(request.url), { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const { ftpFixture } = await import('../test/helpers/ftp-fixture.mjs');
  ftp = await ftpFixture({ after: callback => cleanup.push(callback) }, { requireLogin: true });
  const watchdog = setTimeout(() => finish(new Error('Advanced UI smoke timed out after 150 seconds at ' + stage)), 150000); watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    if (mainWindow) { offlineWindow = window; return; }
    mainWindow = window;
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timer;
        try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer timeout at ' + stage + ': ' + source)), 12000); })]); }
        finally { clearTimeout(timer); }
      };
      const wait = async (source, label = source) => { for (let index = 0; index < 300; index++) { if (await evaluate(source)) return; await delay(50); } throw new Error('Advanced UI did not settle: ' + label); };
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const field = (id, value) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const check = (id, checked) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)});if(input.checked!==${checked})input.click();}`);
      const submit = id => evaluate(`{const form=document.getElementById(${JSON.stringify(id)});form.requestSubmit(form.querySelector('[type=submit]'));}`);
      const view = name => evaluate(`document.querySelector('[data-view=${name}]').click()`);
      const capture = async filename => {
        window.show(); window.focus(); await delay(180);
        let timer;
        try {
          const picture = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timed out: ' + filename)), 10000); })]);
          await fs.writeFile(path.join(reportDirectory, filename), picture.toPNG());
        } finally { clearTimeout(timer); }
      };
      const savedNetwork = () => wait("!document.querySelector('#network-form button[type=submit]').disabled && document.getElementById('network-saved').textContent.length>0");
      const addUrl = async (url, name) => { await click('toggle-add'); await wait("document.getElementById('add-dialog').open"); await field('url', url); await field('name', name); await field('connections', '1'); };
      try {
        stage = 'preferences startup and classification';
        await wait("!!window.sahm && document.getElementById('network-mode') && document.getElementById('start-with-windows')");
        await view('preferences');
        await wait(`document.getElementById('download-directory').value===${JSON.stringify(path.join(profile, 'files'))}`);
        const classificationDirectory = path.join(profile, 'classified');
        await field('download-rules', `ملفات الاختبار|bin|${classificationDirectory}`);
        await check('start-with-windows', true); await check('scan-enabled', true); await submit('preferences-form');
        await wait("document.getElementById('preferences-saved').textContent.length>0 && !document.querySelector('#preferences-form button[type=submit]').disabled");
        let prefs = JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8'));
        assert.equal(prefs.startWithWindows, true); assert.equal(prefs.scanner.enabled, true); assert.equal(prefs.downloadRules[0].directory, classificationDirectory); assert.equal(startupCalls.at(-1).openAtLogin, true);
        await check('start-with-windows', false); await check('scan-enabled', false); await submit('preferences-form');
        await wait("!document.querySelector('#preferences-form button[type=submit]').disabled");
        prefs = JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')); assert.equal(prefs.startWithWindows, false); assert.equal(prefs.scanner.enabled, false); assert.equal(startupCalls.at(-1).openAtLogin, false);
        assertions.push('Preferences persist classification and scanner configuration; startup enable/disable reaches only the stub, and scanning is disabled before downloads');

        stage = 'manual proxy settings and encrypted persistence';
        await view('network'); await wait("!document.getElementById('network-view').hidden && !document.querySelector('#network-form button[type=submit]').disabled");
        await field('network-mode', 'manual'); await field('proxy-type', 'http'); await field('proxy-host', '127.0.0.1'); await field('proxy-port', String(proxyPort));
        await field('proxy-username', proxyLogin.username); await field('proxy-password', proxyLogin.password); await check('proxy-remember', safeStorage.isEncryptionAvailable());
        await submit('network-form'); await savedNetwork();
        const snapshot = await evaluate('window.sahm.networkSettings()');
        assert.equal(snapshot.config.mode, 'manual'); assert.equal(snapshot.config.proxy.port, proxyPort); assert.equal(snapshot.hasPassword, true);
        prefs = JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')); assert.equal(JSON.stringify(prefs).includes(proxyLogin.password), false); assert.equal(JSON.stringify(prefs).includes(proxyLogin.username), false);
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = await fs.readFile(path.join(profile, 'credentials.dat'));
          assert.equal(encrypted.includes(Buffer.from(proxyLogin.password)), false);
          const values = JSON.parse(safeStorage.decryptString(encrypted)).values;
          const { proxyCredentialKey, ConnectionSettings } = await import('../src/connection-settings.mjs');
          const storedLogin = values[proxyCredentialKey(snapshot.config)];
          assert.ok(storedLogin?.username === proxyLogin.username && storedLogin?.password === proxyLogin.password, 'encrypted proxy credential round trip');
          assert.equal(values[proxyCredentialKey({ ...snapshot.config.proxy, port: proxyPort + 1 })], undefined);
          const { CredentialVault } = await import('../src/credential-vault.mjs');
          const reopenedVault = await new CredentialVault(profile, safeStorage).init();
          const reopenedSettings = await new ConnectionSettings({ configure: async () => {} }, { snapshot: () => prefs }, reopenedVault).init();
          const reloaded = reopenedSettings.credentialsFor(snapshot.config.proxy);
          assert.ok(reloaded?.username === proxyLogin.username && reloaded?.password === proxyLogin.password, 'a fresh vault and settings instance reloads the scoped login');
          assert.equal(reopenedSettings.credentialsFor({ ...snapshot.config.proxy, port: proxyPort + 1 }), null);
          assertions.push('Proxy credentials persist through real Windows safeStorage encryption, scoped to proxy type, host and port; plain preferences contain no login fields');
        } else assertions.push('This Electron context cannot encrypt persistent credentials; the UI retains proxy login for the session only');
        await capture('network-light.png');
        if (visualConfirm) {
          const tops = await evaluate("({username:document.getElementById('proxy-username').getBoundingClientRect().top,password:document.getElementById('proxy-password').getBoundingClientRect().top})");
          assert.ok(Math.abs(tops.username - tops.password) <= 1, 'proxy username and password inputs must share a row');
          assertions.push('Visual confirmation: proxy username and password input tops align within one pixel');
          console.log('VISUAL CONFIRM PASS: aligned proxy inputs; no downloads started.');
          await finish(); return;
        }
        await addUrl(base + '/file.bin', 'proxy-transfer.bin'); await submit('add-form'); await wait("!document.getElementById('add-dialog').open");
        await wait("window.sahm.list().then(jobs=>jobs.some(job=>job.name==='proxy-transfer.bin'&&job.status==='complete'))");
        const httpJob = await evaluate("window.sahm.list().then(jobs=>jobs.find(job=>job.name==='proxy-transfer.bin'))"); assert.deepEqual(await fs.readFile(httpJob.path), payload); assert.equal(httpJob.category, 'ملفات الاختبار'); assert.ok(httpJob.path.startsWith(classificationDirectory + path.sep));
        assert.ok(proxyRequests.length > 0); assert.ok(proxyRequests.every(request => request.authorized)); assert.ok(requests.filter(request => request.url === '/file.bin').every(request => request.viaProxy));
        assertions.push('Network form configures an authenticated proxy used by the actual downloader; the exact file is published under the custom category directory');
        await view('network'); await field('network-mode', 'direct'); await submit('network-form'); await savedNetwork();

        stage = 'website copy through the real form';
        await view('sites'); await wait("!document.getElementById('sites-view').hidden");
        await field('site-url', base + '/site/'); await field('site-depth', '2'); await field('site-pages', '10'); await field('site-megabytes', '4'); await submit('site-form');
        await wait("window.sahm.sites().then(jobs=>jobs.length===1&&jobs[0].state==='complete')");
        const site = (await evaluate('window.sahm.sites()'))[0];
        assert.ok((await fs.readFile(path.join(site.directory, 'index.html'), 'utf8')).includes('نسخة الموقع للاختبار'));
        const manifest = JSON.parse(await fs.readFile(path.join(site.directory, 'sahm-mirror.json'), 'utf8')); assert.ok(manifest.resources.some(resource => resource.url.endsWith('second.html') && resource.state === 'complete')); assert.ok(manifest.resources.some(resource => resource.url.endsWith('main.css') && resource.state === 'complete'));
        await view('preferences'); await wait("!document.querySelector('#preferences-form button[type=submit]').disabled");
        await field('theme', 'dark'); await submit('preferences-form'); await wait("!document.querySelector('#preferences-form button[type=submit]').disabled && document.documentElement.dataset.theme==='dark'");
        await view('sites'); await capture('sites-dark.png');
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); const requestsBeforeOffline = requests.length;
        await evaluate(`document.querySelector('[data-site-id=${JSON.stringify(site.id)}] [data-site-action=open]').click()`);
        for (let index = 0; index < 200 && (!offlineWindow || offlineWindow.webContents.isLoading()); index++) await delay(50);
        assert.ok(offlineWindow && !offlineWindow.isDestroyed());
        assert.equal(await offlineWindow.webContents.executeJavaScript("document.getElementById('fixture-title')?.textContent"), 'نسخة الموقع للاختبار');
        assert.equal(await offlineWindow.webContents.executeJavaScript("document.getElementById('picture').complete && document.getElementById('picture').naturalWidth>0"), true);
        assert.equal(await offlineWindow.webContents.executeJavaScript("typeof window.sahm"), 'undefined');
        await offlineWindow.webContents.executeJavaScript("document.getElementById('next').click()");
        for (let index = 0; index < 100; index++) { if (!offlineWindow.webContents.isLoading() && await offlineWindow.webContents.executeJavaScript("!!document.getElementById('second-title')")) break; await delay(50); }
        assert.equal(await offlineWindow.webContents.executeJavaScript("document.getElementById('second-title')?.textContent"), 'الصفحة الثانية المحفوظة'); assert.equal(requests.length, requestsBeforeOffline); offlineWindow.destroy(); offlineWindow = null;
        assertions.push('Site form saves pages, CSS, script and image; its isolated offline window displays the image and follows a saved page link with the original server stopped');

        stage = 'FTP credential form and exact transfer';
        window.setSize(820, 650); await addUrl(ftp.url, 'ftp-wire-file.bin');
        await field('ftp-username', 'test-user'); await field('ftp-password', 'secret-ftp-password'); await field('ftp-tls', 'auto'); await check('ftp-remember', safeStorage.isEncryptionAvailable());
        await capture('ftp-narrow.png'); await submit('add-form'); await wait("!document.getElementById('add-dialog').open");
        await wait("window.sahm.list().then(jobs=>jobs.some(job=>job.name==='ftp-wire-file.bin'&&job.status==='complete'))");
        const ftpJob = await evaluate("window.sahm.list().then(jobs=>jobs.find(job=>job.name==='ftp-wire-file.bin'))"); assert.deepEqual(await fs.readFile(ftpJob.path), ftp.original); assert.equal(ftp.retrievals, 1); assert.equal(ftpJob.kind, 'ftp');
        const savedJobs = await fs.readFile(path.join(profile, 'jobs.json'), 'utf8'); assert.equal(savedJobs.includes('secret-ftp-password'), false); assert.equal(savedJobs.includes(proxyLogin.password), false);
        assertions.push('FTP form accepts separate authenticated credentials and TLS mode, transfers the exact file once, and persists job metadata without passwords');
        console.log('ADVANCED FEATURES SMOKE PASS: ' + assertions.length + ' scenarios; real Electron renderer, IPC, proxy, site copy, offline preview and FTP.');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(error => { console.error(error); app.exit(1); });
