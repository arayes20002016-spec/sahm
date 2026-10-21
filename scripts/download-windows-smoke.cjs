const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const source = path.resolve(argument('--source-root') || path.join(__dirname, '..'));
const directory = path.resolve(argument('--result-directory') || 'E:/SAHM-Releases/download-windows-smoke/' + new Date().toISOString().replace(/[:.]/g, '-'));
const uiDelayMs = Number(argument('--ui-delay-ms') || 0);
const controlToken = argument('--control-token');
assert.ok(Number.isSafeInteger(uiDelayMs) && uiDelayMs >= 0 && uiDelayMs <= 10000);
app.setPath('userData', path.join(directory, 'electron'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'startup', manager, service, fixture;
const wait = async (check, label) => { stage = label; const end = Date.now() + 30000; while (Date.now() < end) { if (await check()) return; await delay(35); } throw new Error('Download window wait expired: ' + label); };
const jobs = () => manager?.list().map(({ id, status, received, total, error }) => ({ id, status, received, total, error }));
app.whenReady().then(async () => {
  const report = { ok: false, source, directory, startedAt: new Date().toISOString(), uiDelayMs, transport: 'explicit-response-barriers', assertions: [], personalProfileUsed: false, operatingSystemSettingsChanged: false };
  await fs.mkdir(directory, { recursive: true });
  const watchdog = setTimeout(() => {
    report.error = 'Download window watchdog: ' + stage; report.jobs = jobs();
    void fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)).finally(() => app.exit(1));
  }, 80000); watchdog.unref();
  try {
    const { DownloadManager } = await import(pathToFileURL(path.join(source, 'src/manager.mjs')));
    const { createDownloadWindows } = require(path.join(source, 'electron/download-windows.cjs'));
    const { gatedDownloadFixture } = await import(pathToFileURL(path.join(__dirname, 'lib/gated-download-fixture.mjs')));
    const data = Buffer.alloc(4 * 1024 * 1024, 'SAHM per-download window fixture\n');
    const digest = value => createHash('sha256').update(value).digest('hex');
    fixture = await gatedDownloadFixture(data);
    manager = await new DownloadManager(path.join(directory, 'profile'), path.join(directory, 'downloads')).init();
    service = createDownloadWindows({ BrowserWindow, ipcMain, manager, shell: { openPath: async target => { assert.ok(target.startsWith(directory)); return ''; } } });
    const origin = fixture.origin;
    const first = await manager.add({ url: origin + '/one', name: 'ملف-أول.bin', connections: 2 });
    const second = await manager.add({ url: origin + '/two', name: 'ملف-ثان.bin', connections: 2 });
    await wait(() => manager.list().every(job => job.status === 'downloading' && job.received > 0) && fixture.held('/one') > 0 && fixture.held('/two') > 0, 'both-transfers-held');
    report.beforeUiDelay = jobs();
    report.heldAt = new Date().toISOString();
    if (controlToken) {
      const ready = path.join(directory, 'held.json');
      await fs.writeFile(ready + '.tmp', JSON.stringify({ token: controlToken, heldAt: report.heldAt }));
      await fs.rename(ready + '.tmp', ready);
      await wait(async () => {
        try { assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'continue.json'), 'utf8')).token, controlToken); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }, 'all-concurrent-workers-held');
      report.parentBarrierApplied = true;
    }
    if (uiDelayMs) { stage = 'delayed-ui-observation'; await delay(uiDelayMs); }
    await wait(() => service.records.size === 2 && [...service.records.values()].every(record => !record.window.webContents.isLoading()), 'both-renderers-loaded');
    const one = service.records.get(first.id).window, two = service.records.get(second.id).window;
    await wait(async () => (await Promise.all([one, two].map(window => window.webContents.executeJavaScript('!!window.downloadWindow && document.getElementById("name").textContent !== "جارٍ قراءة التنزيل…"')))).every(Boolean), 'both-window-apis-ready');
    assert.equal((await one.webContents.executeJavaScript('window.downloadWindow.state()')).id, first.id);
    assert.equal((await two.webContents.executeJavaScript('window.downloadWindow.state()')).id, second.id);
    assert.equal(Object.hasOwn(await one.webContents.executeJavaScript('window.downloadWindow.state()'), 'url'), false);
    assert.equal(service.show(first.id), true); assert.equal(service.records.size, 2);
    report.assertions.push('Each job automatically opens one independent native window with its own ID and path; reopening focuses it without duplication or URL/session exposure');
    assert.ok(manager.list().every(job => job.status === 'downloading' && job.received > 0 && job.received < job.total));
    report.afterUiDelay = jobs();
    report.uiReadyAt = new Date().toISOString();
    report.assertions.push('Real HTTP prefixes remain partial through delayed UI observation until the test releases their response bodies');
    await wait(() => one.webContents.executeJavaScript('!document.getElementById("pause").hidden && !document.getElementById("pause").disabled'), 'pause-button-ready');
    await one.webContents.executeJavaScript('document.getElementById("pause").click();true');
    await wait(() => manager.list().find(job => job.id === first.id).status === 'paused' && !manager.active.has(first.id), 'first-paused');
    await wait(() => one.webContents.executeJavaScript('document.getElementById("status").textContent === "متوقف مؤقتًا" && !document.getElementById("resume").hidden && !document.getElementById("resume").disabled'), 'resume-button-ready');
    assert.equal(manager.list().find(job => job.id === first.id).status, 'paused');
    assert.equal(manager.list().find(job => job.id === second.id).status, 'downloading');
    const checkpoint = JSON.parse(await fs.readFile(first.path + '.resume.json', 'utf8'));
    fixture.release('/two');
    await wait(() => manager.list().find(job => job.id === second.id).status === 'complete', 'peer-completes-while-first-paused');
    assert.equal(manager.list().find(job => job.id === first.id).status, 'paused');
    assert.equal(digest(await fs.readFile(second.path)), digest(data));
    report.peerCompletedWhileFirstPaused = true;
    await fs.writeFile(path.join(directory, 'paused-window.png'), (await one.webContents.capturePage()).toPNG());
    const bounds = await one.webContents.executeJavaScript('({viewport:innerHeight,bottom:document.querySelector("footer").getBoundingClientRect().bottom})');
    report.footerBounds = bounds;
    // Windows scaling can round innerHeight below the fractional layout boundary.
    assert.ok(bounds.bottom <= bounds.viewport + 1, 'Native window footer must fit within one CSS pixel of viewport rounding');
    const beforeResume = fixture.requests.length;
    await one.webContents.executeJavaScript('document.getElementById("resume").click();true');
    await wait(() => fixture.requests.slice(beforeResume).some(request => request.name === '/one' && !request.probe && checkpoint.parts.some(part => part.done > 0 && request.start === part.start + part.done)), 'resume-uses-saved-offset');
    report.resumedFromSavedOffset = true;
    fixture.release('/one');
    await wait(() => manager.list().every(job => job.status === 'complete'), 'both-complete');
    for (const job of manager.list()) assert.equal(digest(await fs.readFile(job.path)), digest(data));
    await two.webContents.executeJavaScript('window.downloadWindow.folder()');
    report.assertions.push('The peer completes while the first remains paused; UI resume requests saved ranges and both files match SHA256');
    await one.webContents.executeJavaScript('setTimeout(()=>window.downloadWindow.hide(),30);true'); await wait(() => service.records.size === 1, 'first-hidden');
    assert.equal(manager.list().find(job => job.id === first.id).status, 'complete');
    await manager.action(second.id, 'remove'); await wait(() => service.records.size === 0, 'removed-window-closed');
    assert.equal(digest(await fs.readFile(second.path)), digest(data));
    report.assertions.push('Hiding a window preserves the job; removing a row closes its window while retaining the file');
    assert.deepEqual(fixture.errors, []); report.ok = true;
  } catch (error) { report.error = error.stack; report.jobs = jobs(); }
  finally {
    report.stage = stage; report.requests = fixture?.requests;
    service?.close(); await manager?.close(); await fixture?.close();
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)); clearTimeout(watchdog);
    console.log('DOWNLOAD WINDOWS ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'result.json')); app.exit(report.ok ? 0 : 1);
  }
});
