const { app, BrowserWindow, Menu, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const sourceRoot = path.resolve(argument('--source-root') || path.join(__dirname, '..'));
const directory = path.resolve(argument('--result-directory') || path.join(__dirname, '..', 'artifacts', 'site-session-smoke', new Date().toISOString().replace(/[:.]/g, '-')));
app.setPath('userData', path.join(directory, 'profile'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assertions = [], offlineRequests = [], externalRequests = [];
let fixture, network, browser, copies, offline, offlineWindow, quota, stage = 'startup';
const moduleFrom = name => import(pathToFileURL(path.join(sourceRoot, 'src', name)).href);
const wait = async (read, description, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await delay(40); }
  throw new Error('Timed out waiting for ' + description + ' at ' + stage);
};
const allFiles = async root => {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(file)); else if (entry.isFile()) result.push(file);
  }
  return result;
};

async function loginToFixture(browserService) {
  const pending = browserService.openLogin(fixture.rootUrl);
  pending.catch(() => {});
  const loginWindow = await wait(() => BrowserWindow.getAllWindows().find(value => value.getTitle().startsWith('تسجيل الدخول')), 'the real isolated login BrowserWindow');
  await wait(async () => loginWindow.webContents.executeJavaScript('Boolean(document.querySelector("input[name=username]"))').catch(() => false), 'fixture login form');
  await loginWindow.webContents.executeJavaScript(`document.querySelector('input[name=username]').value=${JSON.stringify(fixture.credentials.username)};document.querySelector('input[name=password]').value=${JSON.stringify(fixture.credentials.password)};document.querySelector('form').requestSubmit();`);
  await wait(async () => loginWindow.webContents.executeJavaScript('document.body?.dataset.fixtureReady==="yes"').catch(() => false), 'authenticated JavaScript application');
  const pendingMetadata = browserService.pendingSnapshot();
  const metadata = Array.isArray(pendingMetadata) ? pendingMetadata[0] : pendingMetadata;
  assert.ok(metadata?.id, 'The native login controller exposes only pending metadata');
  await browserService.approveLogin(metadata.id);
  return pending;
}

app.whenReady().then(async () => {
  await fs.mkdir(directory, { recursive: true });
  const report = { ok: false, assertions, directory, sourceRoot, electronVersion: process.versions.electron, operatingSystemSettingsChanged: false, personalBrowserProfilesUsed: false };
  const watchdog = setTimeout(() => {
    report.stage = stage; report.error = 'Timed out at ' + stage; report.requests = fixture?.requests || [];
    console.error('SITE SESSION TIMEOUT at ' + stage);
    fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)).finally(() => app.exit(1));
  }, 180000); watchdog.unref();
  try {
    const [{ createSiteSessionFixture }, { NetworkService }, { SiteCopies }, { QuotaStore }, { runSiteMirror }] = await Promise.all([
      import('./site-session-fixture.mjs'), moduleFrom('network.mjs'), moduleFrom('site-copies.mjs'), moduleFrom('quota.mjs'), moduleFrom('site-mirror.mjs'),
    ]);
    const { SiteBrowserService } = require(path.join(sourceRoot, 'electron', 'site-browser.cjs'));
    fixture = await createSiteSessionFixture();
    quota = await new QuotaStore(path.join(directory, 'ledger')).init();
    const serverRulesEnabled = process.argv.includes('--with-server-rules');
    network = new NetworkService({ quota, serverRules: serverRulesEnabled ? [{ host: '127.0.0.1', connections: 8, fileConnections: 4 }] : [] }); await network.configure({ mode: 'direct' });
    report.serverRulesEnabled = serverRulesEnabled;
    browser = new SiteBrowserService({ app, BrowserWindow, session, Menu, network, parent: () => null, onChange: () => {} });

    stage = 'unauthenticated private copy';
    let unauthenticated;
    try { unauthenticated = await runSiteMirror(fixture.rootUrl, path.join(directory, 'unauthenticated'), { fetchImpl: network.createFetch(), options: { depth: 0 } }); }
    catch { unauthenticated = { state: 'rejected' }; }
    assert.notEqual(unauthenticated.state, 'complete');
    await assert.rejects(fs.readFile(path.join(directory, 'unauthenticated', 'index.html')));
    assertions.push('A private HTTP 401 page cannot become a successful unauthenticated site copy or a saved login page');

    stage = 'real POST login and browser storage';
    const approved = await loginToFixture(browser);
    assert.ok(approved?.id); report.approvedSessionMetadataKeys = Object.keys(approved);
    assert.ok(fixture.requests.some(value => value.url === '/private/login' && value.method === 'POST' && value.status === 200));
    assert.ok(fixture.requests.some(value => value.url === '/private/api' && value.authorized && value.tokenPresent && value.status === 200));
    assert.ok(!JSON.stringify(browser.snapshot()).includes(fixture.credentials.password));
    assertions.push('A real isolated Chromium window posts the local account, receives its HttpOnly cookie, and executes an API request authenticated by both localStorage and sessionStorage before native session approval');

    stage = 'authenticated HTTP and exact-origin credential boundary';
    const staticRunner = await browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: { requestTimeout: 15000, renderWaitMs: 100 }, signal: new AbortController().signal });
    try {
      const response = await staticRunner.fetch(fixture.origin + '/private/static', { redirect: 'manual' });
      assert.equal(response.status, 200); assert.match(await response.text(), /Authenticated static page/);
      const redirect = await staticRunner.fetch(fixture.origin + '/private/cross-asset.png', { redirect: 'manual' });
      assert.equal(redirect.status, 302); await redirect.body?.cancel();
      const external = await staticRunner.fetch(fixture.leakOrigin + '/private/leak.png', { redirect: 'manual' });
      await external.arrayBuffer();
      assert.ok(fixture.leaks.length > 0); assert.ok(fixture.leaks.every(value => !value.cookiePresent && !value.authorizationPresent && !value.tokenPresent));
    } finally { await staticRunner.close(); }
    assertions.push('The approved browser session authenticates static HTTP resources while a same-host different-port origin receives no cookie, Authorization, or application token');

    stage = 'dynamic private site project';
    copies = await new SiteCopies(path.join(directory, 'jobs'), path.join(directory, 'files'), { fetchImpl: network.createFetch(), quota, browserService: browser }).init();
    const created = await copies.add({ url: fixture.rootUrl, sessionId: approved.id, options: { renderMode: 'browser', renderWaitMs: 1000, depth: 2, maxPages: 10, maxResources: 40, requestTimeout: 15000 } });
    let diagnosticTimer, diagnosticBusy = false;
    if (process.argv.includes('--diagnostic-visibility')) {
      report.dynamicVisibilityFrames = [];
      diagnosticTimer = setInterval(async () => {
        if (diagnosticBusy || report.dynamicVisibilityFrames.length >= 30) return;
        const observed = BrowserWindow.getAllWindows().find(value => value.webContents.getURL() === fixture.rootUrl);
        if (!observed) return; diagnosticBusy = true;
        try { report.dynamicVisibilityFrames.push({ visible: observed.isVisible(), ...await observed.webContents.executeJavaScript('({height:innerHeight,width:innerWidth,scroll:scrollY,total:document.documentElement.scrollHeight,visibility:document.visibilityState,lazy:!!document.querySelector("#lazy-link"),targetTop:document.querySelector("#lazy-target")?.getBoundingClientRect().top})') }); }
        catch {} finally { diagnosticBusy = false; }
      }, 80);
    }
    let completed;
    try { completed = await wait(() => { const value = copies.list().find(job => job.id === created.id); if (value?.state === 'error') throw new Error(value.error); return ['complete', 'partial'].includes(value?.state) ? value : false; }, 'rendered private site copy', 90000); }
    finally { clearInterval(diagnosticTimer); }
    assert.equal(completed.state, 'complete');
    const entry = await copies.entry(created.id), savedHtml = await fs.readFile(path.join(entry.directory, 'index.html'), 'utf8');
    assert.match(savedHtml, /Authenticated dynamic content 0\.10/); assert.match(savedHtml, /lazy-link/);
    const files = await allFiles(entry.directory);
    for (const file of files) {
      const body = await fs.readFile(file);
      for (const secret of fixture.secrets) assert.ok(!body.includes(Buffer.from(secret)), 'No cookie, password, or storage token may be saved in ' + path.relative(entry.directory, file));
      if (file.endsWith('.json')) assert.ok(!body.toString('utf8').toLowerCase().includes('set-cookie'));
    }
    const jobData = await fs.readFile(path.join(directory, 'jobs', 'site-copies.json'), 'utf8');
    assert.ok(!jobData.includes(approved.id));
    for (const secret of fixture.secrets) assert.ok(!jobData.includes(secret));
    assert.ok(fixture.requests.some(value => value.url === '/private/lazy' && value.authorized && value.status === 200));
    assert.ok(fixture.requests.filter(value => value.server === 'cdn').every(value => !value.cookiePresent && !value.authorizationPresent && !value.tokenPresent));
    assertions.push('The real SiteCopies project saves authenticated API-generated text, protected images, injected CSS, a second page, and a scroll-created lazy link; raw snapshots and manifests contain no password, cookie, browser-storage token, Set-Cookie, or reusable session ID');
    report.copy = { state: completed.state, pages: completed.pages, files: completed.files, bytes: completed.bytes, directory: entry.directory };

    if (process.argv.includes('--with-site-schedule')) {
      stage = 'versioned dynamic project with an approved browser session';
      await copies.updateSchedule(created.id, { enabled: false, intervalMinutes: 1 });
      fixture.advance();
      await copies.action(created.id, 'check');
      const updated = await wait(() => { const value = copies.list().find(job => job.id === created.id); if (['error', 'conflict'].includes(value?.state)) throw new Error(value.error); return value?.state === 'complete' ? value : false; }, 'versioned authenticated browser copy', 90000);
      const published = await copies.entry(created.id);
      assert.notEqual(published.directory, entry.directory); assert.equal(updated.previousRevision, 'legacy');
      const html = await fs.readFile(path.join(published.directory, 'index.html'), 'utf8');
      assert.match(html, /Authenticated dynamic content 0\.10/); assert.match(html, /lazy-link/);
      assert.match(html, /version 2/);
      for (const file of await allFiles(published.directory)) {
        const body = await fs.readFile(file);
        for (const secret of fixture.secrets) assert.ok(!body.includes(Buffer.from(secret)));
      }
      report.periodicSessionCopy = { directory: published.directory, pages: updated.pages, files: updated.files, previousRevision: updated.previousRevision };
      assertions.push('An approved real Chromium session creates a second versioned JavaScript snapshot, retains the prior offline copy, and keeps fixture authentication secrets out of both versions');
    }

    stage = 'authenticated static site project';
    const staticCreated = await copies.add({ url: fixture.origin + '/private/static', sessionId: approved.id, options: { renderMode: 'static', depth: 1, requestTimeout: 15000 } });
    const staticCompleted = await wait(() => { const value = copies.list().find(job => job.id === staticCreated.id); if (value?.state === 'error') throw new Error(value.error); return ['complete', 'partial'].includes(value?.state) ? value : false; }, 'authenticated static site copy');
    assert.equal(staticCompleted.state, 'complete');
    assert.match(await fs.readFile(path.join(staticCompleted.directory, 'index.html'), 'utf8'), /Authenticated static page/);
    assertions.push('Static capture also uses the approved HttpOnly cookie and saves a complete protected page, image and linked page through the normal site-copy engine');

    stage = 'failed dynamic API';
    await wait(() => copies.active.size === 0, 'project runner cleanup');
    const failureRunner = await browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: { requestTimeout: 15000, renderWaitMs: 100 }, signal: new AbortController().signal });
    try {
      const snapshot = await failureRunner.render(fixture.origin + '/private/failing');
      const html = snapshot.html || await snapshot.text();
      assert.match(html, /Waiting for unavailable API/); assert.ok(!html.includes('Authenticated dynamic content'));
      assert.match(snapshot.headers.get('x-sahm-render-warning') || '', /resource-http-error/);
      assert.ok(fixture.requests.some(value => value.url === '/private/api-failure' && value.status === 503));
    } finally { await failureRunner.close(); }
    const failureCreated = await copies.add({ url: fixture.origin + '/private/failing', sessionId: approved.id, options: { renderMode: 'browser', renderWaitMs: 300, depth: 0, requestTimeout: 15000 } });
    const failureCompleted = await wait(() => { const value = copies.list().find(job => job.id === failureCreated.id); if (value?.state === 'error') throw new Error(value.error); return ['complete', 'partial'].includes(value?.state) ? value : false; }, 'failed API partial project');
    assert.equal(failureCompleted.state, 'partial');
    const failureManifest = JSON.parse(await fs.readFile(path.join(failureCompleted.directory, 'sahm-mirror.json'), 'utf8'));
    assert.ok(failureManifest.errors.some(value => value.reason === 'render-resource-http-error'));
    assertions.push('When a dynamic API returns HTTP 503, the renderer captures the actual unavailable-content state, preserves a warning, and marks the real project partial instead of manufacturing successful API content');

    stage = 'stream cancellation';
    await wait(() => copies.active.size === 0, 'partial project runner cleanup');
    const abort = new AbortController(), cancelRunner = await browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: { requestTimeout: 15000 }, signal: abort.signal });
    try {
      const response = await cancelRunner.fetch(fixture.origin + '/private/slow', { redirect: 'manual', signal: abort.signal }), reader = response.body.getReader();
      assert.ok((await reader.read()).value.byteLength > 0); abort.abort(new Error('Fixture cancellation'));
      await assert.rejects(async () => { while (!(await reader.read()).done) {} });
      await wait(() => fixture.requests.some(value => value.url === '/private/slow' && value.closedAfterBytes > 0 && value.closedAfterBytes < 512 * 1024), 'canceled origin socket');
    } finally { await cancelRunner.close(); }
    assertions.push('Canceling an authenticated streaming response rejects the reader and closes the source before its full body is sent');

    stage = 'durable quota boundary';
    const before = quota.snapshot().usedBytes, limit = before + 65536;
    await quota.configure({ enabled: true, limitBytes: limit, periodHours: 1 });
    const limited = await browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: { requestTimeout: 15000 }, signal: new AbortController().signal });
    let quotaFailure;
    try { const response = await limited.fetch(fixture.origin + '/private/big', { redirect: 'manual' }); await response.arrayBuffer(); }
    catch (error) { quotaFailure = error; }
    finally { await limited.close(); }
    assert.equal(quotaFailure?.code, 'DOWNLOAD_QUOTA_EXCEEDED'); assert.equal(quota.snapshot().usedBytes, limit);
    assert.equal((await new QuotaStore(path.join(directory, 'ledger')).init()).snapshot().usedBytes, limit);
    assertions.push('The Chromium gateway stops a protected transfer at the durable shared quota and a fresh ledger instance reloads exactly that boundary');
    await quota.configure({ enabled: false, limitBytes: 512 * 1024 * 1024, periodHours: 24 });

    stage = 'expired session and restart';
    const expired = await browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: { requestTimeout: 15000 }, signal: new AbortController().signal });
    try {
      const logout = await expired.fetch(fixture.origin + '/private/logout', { redirect: 'manual' }); assert.equal(logout.status, 200); await logout.text();
      const response = await expired.fetch(fixture.origin + '/private/static', { redirect: 'manual' }); assert.equal(response.status, 401); await response.body?.cancel();
    }
    finally { await expired.close(); }
    const expiredCreated = await copies.add({ url: fixture.origin + '/private/static', sessionId: approved.id, options: { renderMode: 'browser', renderWaitMs: 100, requestTimeout: 15000 } });
    const expiredJob = await wait(() => { const value = copies.list().find(job => job.id === expiredCreated.id); if (value?.state === 'error') throw new Error(value.error); return value?.state === 'needs-session' ? value : false; }, 'expired private project needs-session state');
    assert.equal(expiredJob.sessionRequired, true); assert.equal(expiredJob.sessionAvailable, false);
    await copies.close(); copies = null; await browser.close(); browser = null;
    browser = new SiteBrowserService({ app, BrowserWindow, session, Menu, network, parent: () => null, onChange: () => {} });
    copies = await new SiteCopies(path.join(directory, 'jobs'), path.join(directory, 'files'), { fetchImpl: network.createFetch(), quota, browserService: browser }).init();
    const restored = copies.list().find(value => value.id === created.id);
    assert.equal(restored.sessionAvailable, false); assert.equal(restored.sessionRequired, true);
    await assert.rejects(browser.createRunner({ rootUrl: fixture.rootUrl, sessionId: approved.id, options: {}, signal: new AbortController().signal }));
    assertions.push('The real logout response expires the cookie, HTTP 401 moves the private project to needs-session, and reopening saved projects has no reusable session and requires a fresh login');

    stage = 'offline rendered copy with origin and CDN stopped';
    await fixture.close();
    offline = createServer(async (request, response) => {
      offlineRequests.push(request.url);
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname), target = path.resolve(entry.directory, '.' + pathname), relation = path.relative(entry.directory, target);
        if (relation === '..' || relation.startsWith('..' + path.sep) || relation.split(path.sep).some(value => value.startsWith('.')) || relation.endsWith('sahm-mirror.json')) { response.writeHead(403); return response.end(); }
        const body = await fs.readFile(pathname === '/' ? path.join(entry.directory, 'index.html') : target);
        const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type }); response.end(body);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
    const offlineOrigin = `http://127.0.0.1:${offline.address().port}`, offlineSession = session.fromPartition('site-offline-fixture-' + process.pid);
    offlineSession.webRequest.onBeforeRequest((details, callback) => { const remote = /^https?:/.test(details.url) && new URL(details.url).origin !== offlineOrigin; if (remote) externalRequests.push(details.url); callback({ cancel: remote }); });
    offlineWindow = new BrowserWindow({ show: false, webPreferences: { session: offlineSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await offlineWindow.loadURL(offlineOrigin + '/index.html');
    const offlineState = await wait(() => offlineWindow.webContents.executeJavaScript('(()=>{const image=document.querySelector("#protected-image"),cdn=document.querySelector("#cdn-image"),title=document.querySelector("#dynamic-title");return image?.naturalWidth&&cdn?.naturalWidth?{title:title.textContent,color:getComputedStyle(title).color,image:image.naturalWidth,cdn:cdn.naturalWidth,scripts:document.scripts.length,forms:[...document.forms].filter(form=>form.hasAttribute("action")||form.querySelector("input,textarea,select,button")).length,scriptRuns:window.fixtureScriptRuns??null,second:document.querySelector("#second-link").href,lazy:document.querySelector("#lazy-link").href}:false})()'), 'offline images');
    assert.equal(offlineState.title, 'Authenticated dynamic content 0.10'); assert.equal(offlineState.color, 'rgb(21, 63, 95)'); assert.equal(offlineState.image, 1); assert.equal(offlineState.cdn, 1); assert.equal(offlineState.scripts, 0); assert.equal(offlineState.forms, 0); assert.equal(offlineState.scriptRuns, null);
    assert.equal(new URL(offlineState.second).origin, offlineOrigin); assert.equal(new URL(offlineState.lazy).origin, offlineOrigin);
    await offlineWindow.loadURL(offlineState.second); assert.equal(await offlineWindow.webContents.executeJavaScript('document.querySelector("#second-title").textContent'), 'Second authenticated page');
    await offlineWindow.loadURL(offlineState.lazy); assert.equal(await offlineWindow.webContents.executeJavaScript('document.querySelector("#lazy-title").textContent'), 'Lazy authenticated page');
    assert.deepEqual(externalRequests, []); report.offlineState = offlineState;
    assertions.push('After the origin and CDN are closed, a fresh Chromium session displays the copied text, both images, CSS and linked pages with zero external requests and no scripts or active login forms');
    report.ok = true;
  } catch (error) { report.error = error.stack || String(error); console.error('STAGE: ' + stage + '\n' + report.error); }
  finally {
    clearTimeout(watchdog); report.stage = stage; report.requests = fixture?.requests || []; report.leaks = fixture?.leaks || []; report.offlineRequests = offlineRequests; report.externalRequests = externalRequests; report.quota = quota?.snapshot();
    offlineWindow?.destroy(); await copies?.close().catch(() => {}); await browser?.close().catch(() => {}); await network?.close().catch(() => {}); await fixture?.close();
    if (offline) await new Promise(resolve => { offline.closeAllConnections(); offline.close(resolve); });
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log('SITE SESSION ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'result.json')); app.exit(report.ok ? 0 : 1);
  }
}).catch(error => { console.error(error); app.exit(1); });
