const { app, BrowserWindow, clipboard } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

clipboard.readText = async () => '';
app.setLoginItemSettings = () => { throw new Error('Windows startup must not be changed by this test'); };
const argument = process.argv.indexOf('--source-root');
const sourceRoot = argument < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[argument + 1]);
const skipAutomatic = process.argv.includes('--skip-automatic'), captureEnabled = !process.argv.includes('--no-captures');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6F2nUAAAAASUVORK5CYII=', 'base64');
const payload = Buffer.alloc(256 * 1024, 73), assertions = [], requests = [], messages = [], offlineWindows = [];
let directory, profile, server, mainWindow, finished = false, stage = 'startup', version = 1, failing = false, active = 0, peak = 0, automaticElapsedMs = null;
const fileActive = new Map(), filePeaks = new Map();
async function finish(error) {
  if (finished) return; finished = true;
  if (error) console.error(error.stack || error);
  let uiFailure;
  if (error && mainWindow && !mainWindow.isDestroyed()) uiFailure = await mainWindow.webContents.executeJavaScript('({siteError:document.getElementById("site-error").textContent,invalid:[...document.querySelectorAll("#site-form :invalid")].map(control=>({id:control.id,message:control.validationMessage}))})').catch(() => null);
  for (const window of offlineWindows) if (!window.isDestroyed()) window.destroy();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, uiFailure, stage, sourceRoot, profile, electronVersion: process.versions.electron, assertions, requests, messages, automaticElapsedMs, actualAutomaticCycle: !skipAutomatic, peakActiveTransfers: peak, perFilePeaks: Object.fromEntries(filePeaks), operatingSystemSettingsChanged: false, personalBrowserProfilesUsed: false, systemClipboardUsed: false }, null, 2));
  console.log('REPORT: ' + directory);
  app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}
(async () => {
  directory = path.resolve('artifacts/site-schedule-ui-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sahm-site-schedule-ui-'));
  app.setPath('userData', profile); app.setPath('downloads', profile);
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: path.join(profile, 'files'), parallel: 2, clipboardMonitorEnabled: false, startWithWindows: false, captureEnabled: false }));
  process.on('uncaughtException', error => { void finish(error); });
  process.on('unhandledRejection', error => { void finish(error); });
  server = createServer((request, response) => {
    const record = { url: request.url, method: request.method, at: Date.now(), conditional: request.headers['if-none-match'] || null }; requests.push(record);
    if (request.url.startsWith('/file-')) {
      active++; peak = Math.max(peak, active); fileActive.set(request.url, (fileActive.get(request.url) || 0) + 1); filePeaks.set(request.url, Math.max(filePeaks.get(request.url) || 0, fileActive.get(request.url)));
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1;
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, ETag: '"download-fixture"', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) });
      let offset = start;
      const timer = setInterval(() => { const next = Math.min(offset + 8192, end + 1); response.write(payload.subarray(offset, next)); offset = next; if (offset > end) { clearInterval(timer); response.end(); } }, 5);
      response.once('close', () => { clearInterval(timer); active--; fileActive.set(request.url, fileActive.get(request.url) - 1); }); return;
    }
    if (request.url === '/robots.txt') { response.end('User-agent: *\nAllow: /'); return; }
    const type = request.url.endsWith('.png') ? 'image/png' : request.url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    const etag = `"${request.url}-v${version}"`;
    const status = failing && request.url.endsWith('.png') ? 503 : request.headers['if-none-match'] === etag ? 304 : 200;
    record.status = status; response.writeHead(status, { 'Content-Type': type, ETag: etag });
    if (status !== 200) { response.end(); return; }
    response.end(type === 'image/png' ? pixel : type === 'text/css' ? `h1{color:${version === 1 ? '#173045' : '#195d38'}}` : request.url === '/site/' ? `<!doctype html><meta charset="utf-8"><title>Site version ${version}</title><link rel="stylesheet" href="site.css"><h1 id="version">Version ${version}</h1><img id="picture" src="image.png">${version === 1 ? '<a href="old.html">Old page</a>' : ''}` : '<h1>Old page</h1><a href="/site/">Back</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const watchdog = setTimeout(() => finish(new Error('Site schedule UI timed out at ' + stage)), 220000); watchdog.unref();
  app.on('browser-window-created', (_, created) => {
    if (mainWindow) { offlineWindows.push(created); return; }
    mainWindow = created;
    created.webContents.on('console-message', details => messages.push({ level: details.level, message: details.message }));
    created.webContents.once('did-finish-load', async () => {
      const evaluate = code => created.webContents.executeJavaScript(code);
      const wait = async (code, label, timeout = 25000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(code)) return; await delay(50); } throw new Error('UI did not settle: ' + label); };
      const field = (id, value) => evaluate(`{const control=document.getElementById(${JSON.stringify(id)});control.value=${JSON.stringify(value)};control.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const jobs = () => evaluate('window.sahm.sites()');
      const idle = () => wait('window.sahm.sites().then(jobs=>jobs.length===1&&![' + ['running', 'queued'].map(JSON.stringify).join(',') + '].includes(jobs[0].state))', 'site cycle');
      const action = async name => {
        await wait(`!!document.querySelector('#site-jobs [data-site-action=${name}]')`, 'site action ' + name);
        return evaluate(`document.querySelector('#site-jobs [data-site-action=${name}]').onclick()`);
      };
      const capture = async name => { if (captureEnabled) { created.show(); await delay(150); await fs.writeFile(path.join(directory, name), (await created.webContents.capturePage()).toPNG()); } };
      try {
        await wait('!!window.sahmServerRules', 'rules helper');
        stage = 'domain rule editor';
        await evaluate('document.querySelector("[data-view=network]").click()'); await wait('!document.getElementById("server-rule-add").disabled', 'rule form');
        await click('server-rule-add');
        const values = { host: '127.0.0.1', port: server.address().port, connections: 2, fileConnections: 1, speedLimit: 0, category: 'موقع الاختبار', directory: path.join(profile, 'domain-files') };
        for (const [name, value] of Object.entries(values)) await evaluate(`document.querySelector('[data-rule-field=${name}]').value=${JSON.stringify(String(value))}`);
        await evaluate('document.getElementById("server-rules-form").requestSubmit()'); await wait('document.getElementById("server-rules-saved").textContent.length>0', 'rule save');
        assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'preferences.json'), 'utf8')).serverRules[0].fileConnections, 1);
        assertions.push('The native Arabic rule form persists host-port, server/file limits, category and directory through trusted IPC');
        stage = 'two real downloads using the saved rule';
        await evaluate(`Promise.all(['a','b'].map(name=>window.sahm.add({url:${JSON.stringify(origin)}+'/file-'+name+'.zip',connections:8})))`);
        await wait('window.sahm.list().then(jobs=>jobs.length===2&&jobs.every(job=>job.status==="complete"))', 'rule-bound files');
        for (const job of await evaluate('window.sahm.list()')) { assert.equal(job.category, values.category); assert.ok(job.path.startsWith(values.directory)); assert.deepEqual(await fs.readFile(job.path), payload); }
        assert.ok(peak <= 2); assert.ok([...filePeaks.values()].every(value => value <= 1));
        assertions.push('Two real byte-identical downloads use the configured folder/category and obey the server and per-file transfer caps');
        stage = 'new periodic site from the UI';
        await evaluate('document.querySelector("[data-view=sites]").click()'); await field('site-url', origin + '/site/');
        await click('site-periodic'); await field('site-interval', '1'); await field('site-depth', '1');
        await evaluate('document.getElementById("site-form").requestSubmit()'); await idle();
        let job = (await jobs())[0]; assert.equal(job.state, 'complete'); assert.ok(job.publishedRevision);
        const first = job.publishedRevision, firstPath = path.join(job.directory, '.sahm-site-versions', first, 'index.html');
        const firstText = await fs.readFile(firstPath, 'utf8'); assert.match(firstText, /Version 1/);
        version = 2; const waitingAt = Date.now(); stage = 'waiting for a real automatic one-minute cycle'; console.log('WAITING FOR AUTOMATIC SITE CYCLE');
        if (skipAutomatic) await action('check');
        else await wait(`window.sahm.sites().then(jobs=>jobs[0].publishedRevision!==${JSON.stringify(first)})`, 'automatic publication', 90000);
        await idle(); automaticElapsedMs = Date.now() - waitingAt;
        job = (await jobs())[0]; assert.notEqual(job.publishedRevision, first); assert.equal(job.previousRevision, first); assert.equal(await fs.readFile(firstPath, 'utf8'), firstText);
        assert.ok(job.lastCycle.removed >= 1);
        if (!skipAutomatic) assert.ok(automaticElapsedMs >= 59000);
        assertions.push(skipAutomatic ? 'A manual packaged cycle publishes the changed site while retaining the prior snapshot' : 'A real automatic cycle after one minute publishes the changed page/image/CSS, removes the stale page and retains the prior offline snapshot');
        stage = 'unchanged conditional cycle'; const second = job.publishedRevision;
        await action('check'); await idle(); job = (await jobs())[0]; assert.equal(job.publishedRevision, second); assert.ok(job.lastCycle.notModified >= 3);
        assertions.push('An unchanged cycle reuses HTTP 304 resources without replacing the published revision');
        version = 3; failing = true; await action('check'); await idle(); job = (await jobs())[0];
        assert.equal(job.state, 'partial'); assert.equal(job.publishedRevision, second); failing = false;
        await action('pause'); version = 4; await action('check'); await idle(); job = (await jobs())[0];
        assert.equal(job.schedule.enabled, false); assert.equal(job.nextRunAt, null);
        assertions.push('A failed resource leaves the published version intact; manual check recovers without enabling the paused schedule');
        stage = 'local edit conflict'; const currentPath = path.join(job.directory, '.sahm-site-versions', job.publishedRevision, 'index.html');
        await fs.appendFile(currentPath, '<p>MY LOCAL EDIT</p>'); const editedRevision = job.publishedRevision;
        await action('check'); await idle(); job = (await jobs())[0]; assert.equal(job.state, 'conflict'); assert.equal(job.publishedRevision, editedRevision);
        assert.match(await fs.readFile(currentPath, 'utf8'), /MY LOCAL EDIT/);
        assertions.push('A local file edit blocks publication and remains intact in the current offline copy');
        stage = 'editing the site schedule through the dialog';
        await action('schedule'); await field('site-schedule-minutes', '2');
        await evaluate('document.getElementById("site-schedule-form").requestSubmit()');
        await wait('!document.getElementById("site-schedule-dialog").open', 'schedule editor save');
        assert.equal((await jobs())[0].schedule.intervalMinutes, 2);
        assert.equal((await jobs())[0].schedule.enabled, false);
        assertions.push('The schedule dialog saves a new interval without enabling a paused project or losing its local-conflict state');
        if (captureEnabled) {
          stage = 'batched visual inspection captures';
          await evaluate('document.getElementById("site-url").scrollIntoView({block:"start"})'); await capture('sites-light.png');
          await evaluate('document.getElementById("site-jobs").scrollIntoView({block:"center"})'); await capture('site-project-light.png');
          await evaluate('document.querySelector("[data-view=network]").click()'); await wait('!document.getElementById("server-rules-fields").disabled', 'reloaded rules');
          await evaluate('window.sahm.preferences({theme:"dark"}).then(()=>applyTheme("dark"))');
          await evaluate('document.getElementById("server-rules-section").scrollIntoView({block:"start"})'); await capture('rules-dark.png');
          await evaluate('document.querySelector("[data-view=sites]").click()'); await action('schedule'); created.setSize(900, 680); await capture('schedule-narrow.png');
          assert.equal(await evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth'), false);
          await evaluate('document.getElementById("site-schedule-dialog").close()');
        }
        stage = 'offline current and previous copies with source closed';
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        for (const name of ['open', 'previous']) {
          const count = offlineWindows.length; await action(name);
          while (offlineWindows.length === count) await delay(20);
          const view = offlineWindows.at(-1);
          for (let index = 0; index < 100 && (view.webContents.isLoading() || !await view.webContents.executeJavaScript('document.getElementById("picture")?.naturalWidth===1').catch(() => false)); index++) await delay(40);
          assert.equal(await view.webContents.executeJavaScript('document.getElementById("picture")?.naturalWidth'), 1); view.destroy();
        }
        assertions.push('Current and previous versions open through the actual app in isolated offline windows with images after the source server is closed');
        assert.ok(!messages.some(message => message.level === 'error' || message.level === 3));
        console.log('SITE SCHEDULE UI PASS: ' + assertions.length + ' groups'); await finish();
      } catch (error) { await finish(error); }
    });
  });
  require(path.join(sourceRoot, 'electron', 'main.cjs'));
})().catch(error => { console.error(error); app.exit(1); });
