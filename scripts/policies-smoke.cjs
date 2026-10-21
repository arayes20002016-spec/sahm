const { app, BrowserWindow, clipboard } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

app.disableHardwareAcceleration();
// Test profiles and startup stubs keep the user's browser, clipboard and
// Windows startup entries outside this test's scope.
clipboard.readText = () => '';
app.setLoginItemSettings = () => {};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const payload = Buffer.alloc(4 * 1024 * 1024);
for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const assertions = [], requests = [], cycleTimes = [];
const schedulerTransitions = [];
const quick = process.argv.includes('--visual-confirm');
const automaticOnly = process.argv.includes('--automatic-only');
const noScreenshots = automaticOnly || process.argv.includes('--no-screenshots');
let profile, reportDirectory, server, mainWindow, finished = false, stage = 'startup', sourceVersion = 1;

async function finish(error) {
  if (finished) return; finished = true;
  if (error) console.error(error.stack || error);
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(reportDirectory, 'result.json'), JSON.stringify({ ok: !error, error: error?.stack, stage, profile, assertions, requests, cycleTimes, schedulerTransitions, actualPeriodicWait: !quick }, null, 2));
  console.log('REPORT: ' + reportDirectory);
  app.once('will-quit', () => app.exit(error ? 1 : 0)); app.quit();
}

(async () => {
  await fs.mkdir(path.resolve('artifacts'), { recursive: true });
  profile = await fs.mkdtemp(path.resolve('artifacts', 'policies-ui-profile-'));
  reportDirectory = path.resolve('artifacts', 'policies-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(reportDirectory, { recursive: true });
  app.setPath('userData', profile); app.setPath('downloads', profile);
  const { SyncService } = await import('../src/synchronization.mjs');
  const startSynchronization = SyncService.prototype.start;
  SyncService.prototype.start = function(project) {
    schedulerTransitions.push({ id: project.id, nextRunAt: project.nextRunAt, manual: this.manual.has(project.id), serviceNow: this.now(), wallClock: Date.now(), monotonic: performance.now() });
    return startSynchronization.call(this, project);
  };
  await fs.writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ theme: 'light', downloadDirectory: path.join(profile, 'files'), captureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false }));
  server = createServer((request, response) => {
    requests.push({ time: new Date().toISOString(), url: request.url, method: request.method, range: request.headers.range || null, ifNoneMatch: request.headers['if-none-match'] || null, version: sourceVersion });
    if (request.url === '/sync/file.txt') {
      const etag = `"synchronization-${sourceVersion}"`;
      if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag }); response.end(); return; }
      const body = Buffer.from(`Synchronized source version ${sourceVersion}\n`, 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ETag: etag }); response.end(body); return;
    }
    if (request.url !== '/quota.bin') { response.writeHead(404); response.end(); return; }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', ETag: '"quota-ui-file"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) });
    if (request.method === 'HEAD') { response.end(); return; }
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(offset + 16384, end + 1); response.write(payload.subarray(offset, next)); offset = next;
      if (offset > end) { clearInterval(timer); response.end(); }
    }, 2);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const watchdog = setTimeout(() => finish(new Error('Policy UI smoke timed out at ' + stage)), 180000); watchdog.unref();
  app.on('browser-window-created', (_, window) => {
    if (mainWindow) return; mainWindow = window;
    window.webContents.once('did-finish-load', async () => {
      const evaluate = async source => {
        let timer;
        try { return await Promise.race([window.webContents.executeJavaScript(source), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer timeout at ' + stage + ': ' + source)), 10000); })]); }
        finally { clearTimeout(timer); }
      };
      const wait = async (source, label = source, milliseconds = 20000) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { if (await evaluate(source)) return; await delay(50); }
        throw new Error('Policy UI did not settle: ' + label);
      };
      const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      const field = (id, value) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}`);
      const check = (id, checked) => evaluate(`{const input=document.getElementById(${JSON.stringify(id)});if(input.checked!==${checked})input.click();}`);
      const submit = id => evaluate(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
      const savedQuota = () => wait("!document.querySelector('#quota-form button[type=submit]').disabled && document.getElementById('quota-saved').textContent.length>0");
      const theme = async value => {
        await evaluate("document.querySelector('[data-view=preferences]').click()");
        await wait("!document.getElementById('preferences-view').hidden && !document.querySelector('#preferences-form button[type=submit]').disabled");
        await field('theme', value); await submit('preferences-form');
        await wait(`!document.querySelector('#preferences-form button[type=submit]').disabled && document.documentElement.dataset.theme===${JSON.stringify(value)}`);
        await evaluate("document.querySelector('[data-view=automation]').click()");
      };
      const capture = async filename => {
        if (noScreenshots) return;
        window.show(); window.focus(); await delay(180);
        let timer;
        try {
          const picture = await Promise.race([window.webContents.capturePage(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timed out: ' + filename)), 10000); })]);
          await fs.writeFile(path.join(reportDirectory, filename), picture.toPNG());
        } finally { clearTimeout(timer); }
      };
      const project = id => evaluate(`window.sahm.syncs().then(items=>items.find(item=>item.id===${JSON.stringify(id)}))`);
      const waitCycle = (id, previous, milliseconds = 20000) => wait(`window.sahm.syncs().then(items=>{const item=items.find(value=>value.id===${JSON.stringify(id)});return item&&item.lastSuccessAt&&item.lastSuccessAt!==${JSON.stringify(previous)}&&item.state==='idle';})`, 'successful synchronization cycle', milliseconds);
      try {
        stage = 'quota controls and durable pause';
        await wait("!!window.sahm && document.getElementById('quota-megabytes') && document.querySelector('[data-view=automation]')");
        await evaluate("document.querySelector('[data-view=automation]').click()");
        await wait("!document.getElementById('automation-view').hidden && !document.querySelector('#quota-form button[type=submit]').disabled");
        if (automaticOnly) {
          stage = 'isolated real automatic synchronization';
          await field('sync-name', 'اختبار الموعد الدوري الفعلي'); await field('sync-urls', base + '/sync/file.txt'); await field('sync-minutes', '1'); await check('sync-enabled', true); await submit('sync-form');
          await wait("window.sahm.syncs().then(items=>items.length===1&&items[0].state==='idle'&&items[0].lastSuccessAt)");
          let sync = (await evaluate('window.sahm.syncs()'))[0];
          const started = performance.now(); sourceVersion = 2;
          cycleTimes.push({ state: 'before automatic cycle', wallClock: Date.now(), lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt });
          console.log('WAIT: isolated one-minute automatic cycle; no screenshots or quota download');
          await waitCycle(sync.id, sync.lastSuccessAt, 75000); sync = await project(sync.id);
          cycleTimes.push({ state: 'after automatic cycle', wallClock: Date.now(), lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt, elapsedMilliseconds: Math.round(performance.now() - started) });
          assert.equal(await fs.readFile(path.join(sync.directory, sync.entries[0].filename), 'utf8'), 'Synchronized source version 2\n');
          const transition = schedulerTransitions.at(-1);
          assert.equal(transition.manual, false); assert.ok(transition.serviceNow >= Date.parse(transition.nextRunAt));
          assertions.push('An automatic one-minute project reaches the recorded deadline without a manual action and publishes the changed source');
          await finish(); return;
        }
        await check('quota-enabled', true); await field('quota-megabytes', '1'); await field('quota-period-hours', '1'); await submit('quota-form'); await savedQuota();
        const config = await evaluate('window.sahm.quota()'); assert.equal(config.config.enabled, true); assert.equal(config.config.limitBytes, 1024 ** 2); assert.equal(config.config.periodHours, 1);
        const job = await evaluate(`window.sahm.add({url:${JSON.stringify(base + '/quota.bin')},name:'حصة الاختبار.bin',connections:4})`);
        await wait(`window.sahm.list().then(items=>{const item=items.find(value=>value.id===${JSON.stringify(job.id)});return item?.status==='paused'&&item.quotaHeld;})`, 'GET pauses under quota');
        const ledger = JSON.parse(await fs.readFile(path.join(profile, 'download-quota.json'), 'utf8'));
        const checkpoint = JSON.parse(await fs.readFile(job.path + '.resume.json', 'utf8'));
        assert.equal(ledger.usedBytes, 1024 ** 2); assert.ok(checkpoint.parts.reduce((sum, part) => sum + part.done, 0) <= ledger.usedBytes);
        assert.ok(await evaluate("document.getElementById('quota-usage').textContent.length>0 && document.getElementById('quota-renewal').textContent.length>0"));
        assertions.push('Arabic quota controls persist the limit; four HTTP ranges pause with durable payload bytes at or below one MiB, and the UI shows consumption and renewal');
        await capture('quota-light.png');

        stage = 'quota increase and resumed bytes';
        await field('quota-megabytes', '8'); await submit('quota-form'); await savedQuota();
        await wait(`window.sahm.list().then(items=>items.find(value=>value.id===${JSON.stringify(job.id)})?.status==='complete')`, 'GET resumes when quota is increased');
        assert.deepEqual(await fs.readFile(job.path), payload);
        assert.ok(requests.some(item => item.url === '/quota.bin' && /^bytes=[1-9]\d*-/.test(item.range || '')));
        assert.ok((await evaluate('window.sahm.quota()')).usedBytes >= ledger.usedBytes);
        assertions.push('Increasing the limit preserves existing usage and resumes GET ranges to a byte-identical complete file');

        stage = 'initial synchronization through the form';
        await field('sync-name', 'نسخ ملف دوري للاختبار'); await field('sync-urls', base + '/sync/file.txt'); await field('sync-minutes', '1'); await check('sync-enabled', true); await submit('sync-form');
        await wait("window.sahm.syncs().then(items=>items.length===1&&items[0].state==='idle'&&items[0].lastSuccessAt)", 'first synchronization');
        let sync = (await evaluate('window.sahm.syncs()'))[0]; const id = sync.id, local = path.join(sync.directory, sync.entries[0].filename);
        assert.equal((await fs.readFile(local, 'utf8')), 'Synchronized source version 1\n'); assert.equal(sync.updatedFiles, 1);
        await wait(`!!document.querySelector('[data-sync-id="${id}"] [data-sync-action="run"]')`, 'synchronization row finishes its running state');
        const previous = sync.lastSuccessAt;
        await evaluate(`document.querySelector('[data-sync-id="${id}"] [data-sync-action="run"]').click()`); await waitCycle(id, previous);
        sync = await project(id); assert.equal(sync.unchangedFiles, 1); assert.equal(sync.receivedBytes, 0);
        assert.ok(requests.some(item => item.url === '/sync/file.txt' && item.ifNoneMatch === '"synchronization-1"'));
        assertions.push('Creating a synchronization project downloads the file; its table action sends a conditional request and a 304 cycle receives no body');

        stage = 'changed source and preserved earlier version';
        sourceVersion = 2; await evaluate(`window.sahm.syncAction(${JSON.stringify(id)},'run')`); await waitCycle(id, sync.lastSuccessAt);
        sync = await project(id); assert.equal(await fs.readFile(local, 'utf8'), 'Synchronized source version 2\n');
        assert.equal(await fs.readFile(path.join(sync.directory, sync.entries[0].previousVersion), 'utf8'), 'Synchronized source version 1\n');
        cycleTimes.push({ state: 'before automatic cycle', lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt });
        assertions.push('A changed ETag publishes the new bytes and keeps the previous file version');

        stage = 'real one minute automatic synchronization';
        const automaticStarted = performance.now();
        sourceVersion = 3;
        if (quick) await evaluate(`window.sahm.syncAction(${JSON.stringify(id)},'run')`);
        else console.log('WAIT: exercising one real automatic one-minute cycle');
        await waitCycle(id, sync.lastSuccessAt, quick ? 20000 : 75000); sync = await project(id);
        assert.equal(await fs.readFile(local, 'utf8'), 'Synchronized source version 3\n');
        cycleTimes.push({ state: 'after automatic cycle', lastRunAt: sync.lastRunAt, nextRunAt: sync.nextRunAt, elapsedMilliseconds: Math.round(performance.now() - automaticStarted) });
        assertions.push(quick ? 'A repeated visual confirmation publishes source version 3 through the run action' : 'The next one-minute cycle runs automatically in the actual desktop process and publishes source version 3 without a run action');
        await theme('dark');
        await capture('synchronization-dark.png');

        stage = 'local edits remain intact';
        await fs.writeFile(local, 'Local user edit that must remain\n'); sourceVersion = 4;
        await evaluate(`window.sahm.syncAction(${JSON.stringify(id)},'run')`);
        await wait(`window.sahm.syncs().then(items=>items.find(value=>value.id===${JSON.stringify(id)})?.state==='conflict')`, 'local edit conflict');
        assert.equal(await fs.readFile(local, 'utf8'), 'Local user edit that must remain\n');
        assertions.push('An edited local file is preserved and the synchronization project reports a conflict');
        await theme('light'); window.setSize(900, 680); await delay(150);
        await wait(`!!document.querySelector('[data-sync-id="${id}"] [data-sync-action="edit"]')`, 'project settings action after conflict');
        await evaluate(`document.querySelector('[data-sync-id="${id}"] [data-sync-action="edit"]').click()`);
        await wait("document.getElementById('sync-edit-dialog').open");
        await field('sync-edit-name', 'مشروع جرى تعديل اسمه'); await field('sync-edit-minutes', '2');
        await capture('automation-narrow.png');
        await submit('sync-edit-form'); await wait("!document.getElementById('sync-edit-dialog').open");
        const edited = await project(id);
        assert.equal(edited.name, 'مشروع جرى تعديل اسمه'); assert.equal(edited.intervalMinutes, 2); assert.equal(edited.directory, sync.directory); assert.equal(edited.state, 'conflict');
        assertions.push('The narrow edit dialog updates scheduling and name while retaining file paths and the outstanding local edit conflict');
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.cjs');
})().catch(async error => { console.error(error); if (reportDirectory) await finish(error); else app.exit(1); });
