const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

clipboard.readText = async () => '';
app.setLoginItemSettings = () => { throw new Error('This test must not change Windows startup.'); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const assertions = [], rendererMessages = [];
const sourceArgument = process.argv.indexOf('--source-root');
const sourceRoot = sourceArgument < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[sourceArgument + 1]);
const captureEnabled = !process.argv.includes('--no-captures');
const captureArgument = process.argv.indexOf('--capture-file');
const captureFile = captureArgument < 0 ? null : process.argv[captureArgument + 1];
const { SiteBrowserService } = require(path.join(sourceRoot, 'electron', 'site-browser.cjs'));
const openLogin = SiteBrowserService.prototype.openLogin;
let browserController;
SiteBrowserService.prototype.openLogin = function (...args) { browserController = this; return openLogin.apply(this, args); };
let profile, directory, fixture, mainWindow, finished = false, stage = 'startup';

async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) console.error(error.stack || error);
  await fixture?.close();
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({
    ok: !error, stage, error: error?.stack, assertions, rendererMessages,
    profile, sourceRoot, electronVersion: process.versions.electron, captureEnabled, operatingSystemSettingsChanged: false, personalBrowserProfilesUsed: false
  }, null, 2));
  console.log('REPORT: ' + directory);
  app.once('will-quit', () => app.exit(error ? 1 : 0));
  app.quit();
}

(async () => {
  directory = path.resolve('artifacts/site-session-ui-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  profile = await fs.mkdtemp(path.resolve('artifacts/site-session-ui-profile-'));
  app.setPath('userData', profile); app.setPath('downloads', profile);
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({
    theme: 'light', downloadDirectory: path.join(profile, 'files'), captureEnabled: false,
    clipboardMonitorEnabled: false, startWithWindows: false
  }));
  const { createSiteSessionFixture } = await import('./site-session-fixture.mjs');
  fixture = await createSiteSessionFixture();
  const watchdog = setTimeout(() => finish(new Error('Site UI timed out at ' + stage)), 150000);
  watchdog.unref();
  app.on('browser-window-created', (_, created) => {
    if (mainWindow) {
      // The trusted harness uses the same controller as the native approval menu.
      (async () => {
        let submitted = false;
        const deadline = Date.now() + 20000;
        try {
          while (!finished && !created.isDestroyed() && Date.now() < deadline) {
            if (!created.webContents.getURL().startsWith(fixture.origin + '/')) { await delay(40); continue; }
            if (!submitted && await created.webContents.executeJavaScript('!!document.querySelector("input[name=password]")').catch(() => false)) {
              submitted = true;
              await created.webContents.executeJavaScript(`document.querySelector('input[name=username]').value=${JSON.stringify(fixture.credentials.username)};document.querySelector('input[name=password]').value=${JSON.stringify(fixture.credentials.password)};document.querySelector('form').requestSubmit()`);
            }
            const ready = await created.webContents.executeJavaScript('document.body?.dataset.fixtureReady==="yes"').catch(() => false);
            const pending = browserController?.pendingSnapshot()[0];
            if (ready && pending && !created.webContents.isLoadingMainFrame()) { await browserController.approveLogin(pending.id); return; }
            await delay(40);
          }
        } catch (error) { await finish(error); }
      })();
      return;
    }
    mainWindow = created;
    created.webContents.on('console-message', details => rendererMessages.push({ level: details.level, message: details.message }));
    created.webContents.once('did-finish-load', async () => {
      const evaluate = source => created.webContents.executeJavaScript(source);
      const wait = async (source, label, milliseconds = 25000) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { if (await evaluate(source)) return; await delay(60); }
        throw new Error('Site UI did not settle: ' + label);
      };
      const field = (id, value) => evaluate(`{const control=document.getElementById(${JSON.stringify(id)});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const capture = async filename => {
        if (!captureEnabled || captureFile && captureFile !== filename) return;
        created.show(); await delay(150);
        await fs.writeFile(path.join(directory, filename), (await created.webContents.capturePage()).toPNG());
      };
      try {
        await wait('!!window.sahmSiteSessions&&!!window.sahm', 'UI startup');
        await evaluate('document.querySelector("[data-view=sites]").click()');
        assert.equal(await evaluate('document.getElementById("site-hash-routes").disabled'), true);
        await field('site-render-mode', 'browser');
        assert.equal(await evaluate('document.getElementById("site-hash-routes").disabled'), false);
        await evaluate('document.getElementById("site-hash-routes").click()');
        await field('site-render-mode', 'static');
        assert.equal(await evaluate('document.getElementById("site-hash-routes").checked'), false);
        await field('site-url', fixture.rootUrl); await field('site-render-mode', 'browser');
        await evaluate('document.getElementById("site-hash-routes").click()');
        assertions.push('The hash-route option is available only for browser snapshots and switching to static capture clears it');
        await field('site-depth', '1'); await field('site-pages', '3');
        assert.equal(await evaluate('document.getElementById("site-render-wait").disabled'), false);
        stage = 'native login from the UI';
        await evaluate('document.getElementById("site-session-login").click()');
        await wait('!!document.getElementById("site-session").value', 'login approval');
        const sessions = await evaluate('window.sahm.siteSessions()');
        assert.equal(sessions.length, 1); assert.equal(sessions[0].origin, fixture.origin);
        assert.ok(fixture.requests.some(request => request.method === 'POST' && request.status === 200));
        assertions.push('The Arabic site form opens an isolated login window, completes a real POST, and selects the session after the real approval controller accepts it');
        stage = 'dynamic copy from UI';
        await evaluate('document.querySelector("#site-form button[type=submit]").click()');
        await wait('window.sahm.sites().then(jobs=>jobs.some(job=>["complete","partial","error","needs-session"].includes(job.state)))', 'site copy', 50000);
        const jobs = await evaluate('window.sahm.sites()');
        assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'complete', jobs[0].error);
        assert.equal(jobs[0].sessionRequired, true); assert.equal(jobs[0].sessionAvailable, true);
        assert.equal(jobs[0].options.hashRoutes, true);
        assert.equal(jobs[0].pages, 3);
        const saved = await fs.readFile(path.join(jobs[0].directory, 'index.html'), 'utf8');
        assert.match(saved, /Authenticated dynamic content/);
        const persisted = await fs.readFile(path.join(profile, 'site-copies.json'), 'utf8');
        assert.ok(!persisted.includes(sessions[0].id));
        for (const secret of fixture.secrets) assert.ok(!persisted.includes(secret));
        assertions.push('The real IPC path starts and completes a three-page authenticated JavaScript copy, with no runtime session ID or credentials in saved job metadata');
        stage = 'UI variants';
        created.setSize(1280, 860); await capture('site-session-light.png');
        await evaluate('window.sahm.preferences({theme:"dark"}).then(()=>applyTheme("dark"))');
        assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'), 'dark');
        await delay(120); await capture('site-session-dark.png');
        created.setSize(900, 680); await delay(120);
        await evaluate('document.getElementById("site-session-login").scrollIntoView({block:"center"})');
        const controls = await evaluate('({width:document.documentElement.clientWidth,body:document.documentElement.scrollWidth,button:document.getElementById("site-session-login").getBoundingClientRect().toJSON(),height:innerHeight})');
        assert.ok(controls.body <= controls.width + 1);
        assert.ok(controls.button.top >= 0 && controls.button.bottom <= controls.height);
        await capture('site-session-narrow.png');
        assertions.push('Light, dark and 900×680 layouts retain the desktop form controls without document overflow');
        stage = 'reload and forget session';
        await created.webContents.reload(); await delay(250);
        await wait('!!window.sahmSiteSessions&&!!window.sahm', 'reload');
        await evaluate('document.querySelector("[data-view=sites]").click()');
        await wait('document.getElementById("site-session").options.length===2', 'live session restored in the current process');
        await field('site-session', sessions[0].id);
        await evaluate('document.getElementById("site-session-remove").click()');
        await wait('window.sahm.siteSessions().then(sessions=>sessions.length===0)', 'session removal');
        const retained = await evaluate('window.sahm.sites()');
        assert.equal(retained[0].sessionAvailable, false); assert.equal(retained[0].state, 'complete');
        assert.equal(await fs.readFile(path.join(jobs[0].directory, 'index.html'), 'utf8'), saved);
        assertions.push('Reload keeps only the current in-memory session; ending it removes access while retaining the completed offline files');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require(path.join(sourceRoot, 'electron', 'main.cjs'));
})().catch(async error => { if (directory) await finish(error); else { console.error(error); app.exit(1); } });
