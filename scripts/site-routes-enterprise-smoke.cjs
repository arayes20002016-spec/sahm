const { app, BrowserWindow, Menu, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const tls = require('node:tls');
const { pathToFileURL } = require('node:url');
const { gzipSync } = require('node:zlib');
const { createServer: createHttpsServer } = require('node:https');

app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const sourceRoot = path.resolve(argument('--source-root') || path.join(__dirname, '..'));
const coldStartDelayMs = Number(argument('--cold-start-delay-ms') || 0);
if (!Number.isInteger(coldStartDelayMs) || coldStartDelayMs < 0 || coldStartDelayMs > 10000) throw new Error('Invalid cold start delay');
const directory = path.resolve(argument('--result-directory') || path.join(__dirname, '..', 'artifacts', 'site-routes-enterprise-smoke', new Date().toISOString().replace(/[:.]/g, '-')));
app.setPath('userData', path.join(directory, 'profile'));
const moduleFrom = name => import(pathToFileURL(path.join(sourceRoot, 'src', name)).href);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assertions = [], apiRequests = [], windows = [];
const auxiliaries = [], externalRequests = [];
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6F2nUAAAAASUVORK5CYII=', 'base64');
let origin, network, browser, copies, offline, quota, stage = 'startup';
const wait = async (read, description, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(40); }
  throw new Error('Timed out at ' + stage + ': ' + description);
};
app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  const report = { ok: false, assertions, sourceRoot, directory, electronVersion: process.versions.electron, operatingSystemSettingsChanged: false, personalBrowserProfilesUsed: false, dedicatedKerberosKdcTested: false, fixtureCertificateTrustOnly: true };
  const watchdog = setTimeout(() => { report.stage = stage; report.error = 'Watchdog timeout'; fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)).finally(() => app.exit(1)); }, 180000); watchdog.unref();
  try {
    const [{ NetworkService }, { SiteCopies }, { QuotaStore }, { serveOfflineSite }, { readSiteMirror }, { loadClientCertificate }] = await Promise.all(['network.mjs', 'site-copies.mjs', 'quota.mjs', 'offline-site.mjs', 'site-mirror.mjs', 'client-certificates.mjs'].map(moduleFrom));
    const { SiteBrowserService } = require(path.join(sourceRoot, 'electron', 'site-browser.cjs'));
    const { ntlmHttpOrigin, createEnterprisePfx } = await import('../test/helpers/enterprise-origin-fixture.mjs');
    const serverCert = await fs.readFile(path.join(__dirname, '..', 'test', 'fixtures', 'ftp', 'server-cert.pem'));
    const serverKey = await fs.readFile(path.join(__dirname, '..', 'test', 'fixtures', 'ftp', 'server-key.pem'));
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), serverCert.toString()]);
    const passphrase = 'site-routes-pfx-fixture-secret';
    const identity = await createEnterprisePfx(directory, passphrase);
    const rootHtml = '<!doctype html><title>Protected SPA</title><link rel="stylesheet" href="/style.css"><body><h1 id="content">Loading</h1><img src="/image.png"><nav><a href="#/one">one</a><a href="#!/two">two</a><a href="#section">anchor</a><a href="#/logout">logout</a><a href="#/secret?access_token=fixture-secret">secret</a></nav><div id="section">Anchor</div><script>sessionStorage.setItem("fixture-state","ready");fetch("/api",{method:"POST",headers:{"Content-Type":"text/plain"},body:location.hash||"root"}).then(r=>r.json()).then(x=>{document.getElementById("content").textContent=x.title;document.body.dataset.ready="yes"})</script>';
    stage = 'native mutual TLS and NTLM fixture';
    origin = await ntlmHttpOrigin(Buffer.alloc(0), { tls: { cert: serverCert, key: serverKey, ca: await fs.readFile(identity.cert), requestCert: true, rejectUnauthorized: true }, respond: async (request, response, body) => {
      if (request.url === '/api') {
        const cookiePresent = /(?:^|; )fixture-session=protected/.test(request.headers.cookie || '');
        apiRequests.push({ method: request.method, route: body.toString(), cookiePresent, mutualTls: request.socket.authorized });
        const data = gzipSync(JSON.stringify({ title: 'Protected route ' + body.toString() }));
        response.writeHead(cookiePresent ? 200 : 403, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': data.length }); response.end(data); return;
      }
      if (request.url === '/image.png') { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': pixel.length }); response.end(pixel); return; }
      if (request.url === '/style.css') { response.writeHead(200, { 'Content-Type': 'text/css' }); response.end('h1 { color: rgb(9,95,167) }'); return; }
      if (request.url === '/robots.txt') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('User-agent: *\nAllow: /'); return; }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['fixture-session=protected; Path=/; Secure; HttpOnly; SameSite=Strict', 'fixture-visible=yes; Path=/; Secure; SameSite=Strict'] }); response.end(rootHtml);
    } });
    quota = await new QuotaStore(path.join(directory, 'quota')).init();
    let windowsAuth;
    if (coldStartDelayMs) {
      const { WindowsAuthService } = await moduleFrom('windows-auth.mjs');
      const helperScript = await fs.readFile(path.join(sourceRoot, 'src', 'native', 'windows-auth.ps1'), 'utf8');
      windowsAuth = new WindowsAuthService({ helperScript: `Start-Sleep -Milliseconds ${coldStartDelayMs}\n${helperScript}` });
    }
    report.coldStartDelayMs = coldStartDelayMs;
    network = new NetworkService({ quota, windowsAuth, clientCertificateProvider: url => url === origin.origin ? loadClientCertificate(url, { origin: url, pfxFile: identity.pfx, enabled: true }, passphrase) : null, serverRules: [{ host: 'localhost', connections: 4, fileConnections: 2 }] });
    report.transportTrace = [];
    const browserFetch = network.browserFetch.bind(network);
    network.browserFetch = async (url, options) => {
      try {
        const response = await browserFetch(url, options);
        report.transportTrace.push({ path: new URL(url).pathname, method: options?.method || 'GET', status: response.status });
        return response;
      } catch (error) {
        report.transportTrace.push({ path: new URL(url).pathname, method: options?.method || 'GET', code: error.code, error: String(error.message).slice(0, 300) });
        throw error;
      }
    };
    await network.configure({ authentication: { servers: [{ origin: origin.origin, scheme: 'ntlm', currentAccount: true }] }, clientCertificates: [{ origin: origin.origin, pfxFile: identity.pfx, enabled: true }] });
    browser = new SiteBrowserService({ app, BrowserWindow, Menu, session, network });
    stage = 'real protected login window';
    const login = browser.openLogin(origin.origin + '/#/one'); login.catch(() => {});
    const loginWindow = await wait(() => BrowserWindow.getAllWindows().find(window => window.getTitle().startsWith('تسجيل الدخول')), 'login window');
    await wait(() => loginWindow.webContents.executeJavaScript('document.body?.dataset.ready==="yes"').catch(() => false), 'NTLM/PFX authenticated API text');
    assert.equal(await loginWindow.webContents.executeJavaScript('document.getElementById("content").textContent'), 'Protected route #/one');
    assert.equal(await loginWindow.webContents.executeJavaScript('document.cookie.includes("fixture-session")'), false);
    assert.equal(await loginWindow.webContents.executeJavaScript('document.cookie.includes("fixture-visible=yes")'), true);
    assert.ok(apiRequests.every(request => request.cookiePresent && request.mutualTls && request.method === 'POST'));
    assertions.push('An actual isolated login BrowserWindow loads HTTPS, image, CSS and a gzip POST API through PFX mutual TLS plus native NTLM on the same TLS connection; Chromium keeps HttpOnly cookies private');
    const omitted = await loginWindow.webContents.executeJavaScript('fetch("/api",{method:"POST",credentials:"omit",body:"omitted-cookie"}).then(response=>response.status)');
    assert.equal(omitted, 403); assert.equal(apiRequests.at(-1).cookiePresent, false);
    const record = browser.records.get(browser.pendingSnapshot()[0].id);
    const crossWindow = new BrowserWindow({ show: false, webPreferences: { session: record.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(crossWindow); await crossWindow.loadURL('about:blank'); await record.transport.attach(crossWindow);
    await crossWindow.loadURL('data:text/html,<title>Cross origin fixture</title>');
    const cross = await crossWindow.webContents.executeJavaScript(`fetch(${JSON.stringify(origin.origin + '/api')}).then(response=>response.text()).then(()=>false,()=>true)`);
    assert.equal(cross, true); crossWindow.destroy();
    assertions.push('Chromium omits the HttpOnly cookie for credentials:omit and blocks a cross-origin page from reading the intercepted protected API response');
    const sessionId = browser.pendingSnapshot()[0].id;
    await browser.approveLogin(sessionId); const approved = await login;
    stage = 'protected static resource transport';
    const runner = await browser.createRunner({ rootUrl: origin.origin + '/', sessionId: approved.id, options: { requestTimeout: 30000 } });
    try {
      const response = await runner.fetch(origin.origin + '/image.png');
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixel);
    } finally { await runner.close(); }
    assertions.push('The approved session downloads a byte-identical protected static image through the same exact-origin PFX/NTLM transport');
    stage = 'hash route website project';
    copies = await new SiteCopies(path.join(directory, 'jobs'), path.join(directory, 'files'), { fetchImpl: network.createFetch(), quota, browserService: browser }).init();
    const job = await copies.add({ url: origin.origin + '/#/one', sessionId: approved.id, schedule: { enabled: false, intervalMinutes: 1 }, options: { renderMode: 'browser', hashRoutes: true, renderWaitMs: 1200, maxPages: 6, maxResources: 20, depth: 3, requestTimeout: 30000 } });
    await wait(() => !copies.active.has(job.id) && ['complete', 'partial', 'error'].includes(copies.list()[0].state), 'copied SPA routes', 70000);
    const result = copies.list()[0]; report.project = result;
    assert.ok(result.publishedRevision, JSON.stringify(result));
    const saved = await copies.entry(job.id), entry = path.join(saved.directory, saved.entryPath), mirror = await readSiteMirror(saved.directory);
    report.routes = mirror.resources.filter(resource => resource.kind === 'page').map(resource => ({ url: resource.url, path: resource.path, state: resource.state }));
    assert.equal(report.routes.length, 2); assert.ok(report.routes.every(route => route.state === 'complete'));
    assert.ok(report.routes.some(route => route.url.endsWith('#/one'))); assert.ok(report.routes.some(route => route.url.endsWith('#!/two')));
    assert.ok(!JSON.stringify(mirror).includes('fixture-secret')); assert.ok(!report.routes.some(route => route.url.includes('logout')));
    const one = await fs.readFile(entry, 'utf8');
    const second = mirror.resources.find(resource => resource.url.endsWith('#!/two'));
    const two = await fs.readFile(path.join(path.dirname(entry), second.path), 'utf8');
    assert.match(one, /Protected route #\/one/); assert.match(two, /Protected route #!\/two/);
    assert.match(one, new RegExp(second.path.replaceAll('/', '\\/'))); assert.match(one, /href="#section"/);
    assert.ok(!one.includes('fixture-session') && !two.includes('fixture-session') && !one.includes('<script'));
    assertions.push('Two hash routes sharing one HTTP URL become different inert snapshots with local links; anchors stay local, logout routes are excluded and fixture tokens are absent');
    stage = 'offline SPA snapshots';
    report.nativeSspiRounds = origin.rounds; await origin.close(); origin = null;
    offline = await serveOfflineSite(path.dirname(entry));
    for (const [file, text] of [[entry, 'Protected route #/one'], [path.join(path.dirname(entry), second.path), 'Protected route #!/two']]) {
      const route = offline.prefix + path.relative(path.dirname(entry), file).replaceAll('\\', '/');
      const win = new BrowserWindow({ show: false, webPreferences: { partition: 'sahm-routes-offline-' + windows.length, sandbox: true, contextIsolation: true, nodeIntegration: false } }); windows.push(win);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^https?:/.test(details.url) && new URL(details.url).origin !== new URL(offline.url).origin;
        if (remote) externalRequests.push(details.url); callback({ cancel: remote });
      });
      await win.loadURL(route);
      await wait(() => win.webContents.executeJavaScript('document.querySelector("img")?.naturalWidth===1'), 'offline image');
      assert.match(await win.webContents.executeJavaScript('document.body.textContent'), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assertions.push('After shutting down the protected origin, both route snapshots open with their own API-generated text and image in fresh sandboxed windows');
    assert.deepEqual(externalRequests, []);
    stage = 'standalone HTTP NTLM window';
    const httpOrigin = await ntlmHttpOrigin(Buffer.alloc(0), { respond: (request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Standalone NTLM browser page</h1>'); } });
    auxiliaries.push(httpOrigin);
    const httpNetwork = new NetworkService(); auxiliaries.push(httpNetwork);
    await httpNetwork.configure({ authentication: { servers: [{ origin: httpOrigin.origin, scheme: 'ntlm', currentAccount: true }] } });
    const httpBrowser = new SiteBrowserService({ app, BrowserWindow, Menu, session, network: httpNetwork }); auxiliaries.push(httpBrowser);
    const httpRunner = await httpBrowser.createRunner({ rootUrl: httpOrigin.origin + '/', options: { renderWaitMs: 100 } });
    try { assert.match(await (await httpRunner.render(httpOrigin.origin + '/')).text(), /Standalone NTLM browser page/); }
    finally { await httpRunner.close(); }
    assert.ok(httpOrigin.rounds.includes(1) && httpOrigin.rounds.includes(3));
    assertions.push('A separate HTTP rendering window authenticates with native NTLM without requiring a PFX profile');
    stage = 'standalone PFX window and exact-port boundary';
    const tlsRequests = [];
    const createTlsFixture = async (cert, key) => {
      const sockets = new Set();
      const server = createHttpsServer({ cert, key, ca: await fs.readFile(identity.cert), requestCert: true, rejectUnauthorized: true }, (request, response) => {
        tlsRequests.push({ port: server.address().port, authorized: request.socket.authorized, cookiePresent: !!request.headers.cookie });
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Standalone client certificate page</h1>');
      });
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const fixture = { origin: 'https://localhost:' + server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } }; auxiliaries.push(fixture); return fixture;
    };
    const certificateOrigin = await createTlsFixture(serverCert, serverKey);
    const certificateNetwork = new NetworkService({ clientCertificateProvider: url => url === certificateOrigin.origin ? loadClientCertificate(url, { origin: url, pfxFile: identity.pfx }, passphrase) : null }); auxiliaries.push(certificateNetwork);
    await certificateNetwork.configure({ clientCertificates: [{ origin: certificateOrigin.origin, pfxFile: identity.pfx }] });
    const certificateBrowser = new SiteBrowserService({ app, BrowserWindow, Menu, session, network: certificateNetwork }); auxiliaries.push(certificateBrowser);
    const certificateRunner = await certificateBrowser.createRunner({ rootUrl: certificateOrigin.origin + '/', options: { renderWaitMs: 100 } });
    try { assert.match(await (await certificateRunner.render(certificateOrigin.origin + '/')).text(), /Standalone client certificate page/); }
    finally { await certificateRunner.close(); }
    assert.ok(tlsRequests.some(request => request.authorized));
    assertions.push('A separate HTTPS rendering window supplies only its configured PFX identity without requiring NTLM');
    const otherPort = await createTlsFixture(serverCert, serverKey);
    assert.equal(certificateNetwork.requiresBrowserTransport(otherPort.origin), false);
    await assert.rejects(certificateNetwork.browserFetch(otherPort.origin + '/'));
    assert.ok(!tlsRequests.some(request => request.port === Number(new URL(otherPort.origin).port)));
    assertions.push('The actual HTTPS transport does not send the configured client identity to the same host on an unconfigured port');
    stage = 'untrusted server rejection in a protected window';
    const untrusted = await createTlsFixture(await fs.readFile(identity.cert), await fs.readFile(identity.key));
    const untrustedNetwork = new NetworkService({ clientCertificateProvider: url => loadClientCertificate(url, { origin: url, pfxFile: identity.pfx }, passphrase) }); auxiliaries.push(untrustedNetwork);
    await untrustedNetwork.configure({ clientCertificates: [{ origin: untrusted.origin, pfxFile: identity.pfx }] });
    const untrustedBrowser = new SiteBrowserService({ app, BrowserWindow, Menu, session, network: untrustedNetwork }); auxiliaries.push(untrustedBrowser);
    const untrustedRunner = await untrustedBrowser.createRunner({ rootUrl: untrusted.origin + '/', options: { renderWaitMs: 100, requestTimeout: 5000 } });
    try { await assert.rejects(untrustedRunner.render(untrusted.origin + '/'), { code: 'SITE_BROWSER_AUTH_TRANSPORT' }); }
    finally { await untrustedRunner.close(); }
    assert.ok(!tlsRequests.some(request => request.port === Number(new URL(untrusted.origin).port)));
    assertions.push('A configured PFX does not bypass server trust: the actual protected BrowserWindow rejects an untrusted server before an HTTP request succeeds');
    report.tlsRequests = tlsRequests;
    report.ok = true;
  } catch (error) {
    report.error = error.stack || String(error); console.error(report.error);
    const current = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    if (current) report.failedDocument = await current.webContents.executeJavaScript('({url:location.href,body:document.body?.textContent})').catch(() => null);
  }
  finally {
    report.stage = stage; report.apiRequests = apiRequests; report.externalRequests = externalRequests; report.nativeSspiRounds ||= origin?.rounds;
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    await copies?.close(); await browser?.close(); await network?.close(); await offline?.close(); await origin?.close();
    for (const item of auxiliaries.reverse()) await item.close().catch(() => {});
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log('REPORT: ' + directory); clearTimeout(watchdog); app.exit(report.ok ? 0 : 1);
  }
});
