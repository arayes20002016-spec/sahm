const { app, BrowserWindow, clipboard, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const source = path.resolve(argument('--source-root') || path.join(__dirname, '..'));
const directory = path.resolve(argument('--result-directory') || 'artifacts/network-retry-ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash('sha256').update(data).digest('hex');
const report = { ok: false, source, directory, assertions: [], personalProfileUsed: false, installerExecuted: false, virtualMachineUsed: false };
let fixture, main, finished = false, stage = 'startup';
clipboard.readText = async () => '';
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => { throw new Error('Network UI test cannot change login settings'); };
shell.openPath = async () => { throw new Error('Network UI test cannot open external files'); };
const evaluate = code => main.webContents.executeJavaScript(code);
async function wait(check, label) {
  stage = label; const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(35); }
  throw new Error('Network UI timed out: ' + label);
}
async function windowFor(id) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window === main || window.webContents.isLoading()) continue;
    const state = await window.webContents.executeJavaScript('window.downloadWindow ? window.downloadWindow.state() : null');
    if (state?.id === id) return window;
  }
}
async function finish(error) {
  if (finished) return; finished = true;
  if (error) report.error = error.stack;
  report.stage = stage;
  await fixture?.close(); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log('NETWORK RETRY UI ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'result.json'));
  app.once('will-quit', () => app.exit(report.ok ? 0 : 1)); app.quit();
}
(async () => {
  await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory);
  const appData = path.join(directory, 'AppData'), profile = path.join(appData, 'sahm-download-manager');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(path.join(directory, 'files'));
  app.setPath('appData', appData); app.setPath('userData', profile); app.setPath('downloads', path.join(directory, 'files'));
  const { stressDownloadFixture } = await import(pathToFileURL(path.join(__dirname, 'lib/stress-download-fixture.mjs')));
  fixture = await stressDownloadFixture({ bytes: 4 * 1024 * 1024, intervalMs: 1 });
  app.on('browser-window-created', (_, window) => {
    window.webContents.once('did-finish-load', () => { if (/\/ui\/index\.html$/.test(window.webContents.getURL().replaceAll('\\', '/'))) main = window; });
  });
  const watchdog = setTimeout(() => finish(new Error('Network UI watchdog: ' + stage)), 110000); watchdog.unref();
  require(path.join(source, 'electron/main.cjs'));
  await wait(() => main && evaluate('!!window.sahm && !!document.querySelector("#jobs")'), 'main-ready');
  await evaluate('window.sahm.preferences({theme:"light",showDownloadWindows:true})');
  const first = fixture.add(77, 'stable', true);
  const job = await evaluate('window.sahm.add(' + JSON.stringify({ url: first.url, name: 'تجربة-إعادة-الاتصال.bin', connections: 2 }) + ')');
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === job.id)?.received > 0, 'first-partial');
  fixture.interrupt();
  const one = await wait(() => windowFor(job.id), 'native-download-window');
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === job.id)?.networkRetry &&
    await one.webContents.executeJavaScript('document.getElementById("status").textContent === "بانتظار إعادة الاتصال"'), 'waiting-label');
  await wait(() => evaluate('document.querySelector(' + JSON.stringify('tr[data-id="' + job.id + '"]') + ')?.textContent.includes("بانتظار إعادة الاتصال")'), 'table-label');
  await fs.writeFile(path.join(directory, 'waiting-main-light.png'), (await main.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(directory, 'waiting-window-light.png'), (await one.webContents.capturePage()).toPNG());
  await evaluate('window.sahm.preferences({theme:"dark"})'); main.setSize(900, 680); one.setSize(520, 390); await delay(200);
  await fs.writeFile(path.join(directory, 'waiting-main-dark-small.png'), (await main.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(directory, 'waiting-window-dark-small.png'), (await one.webContents.capturePage()).toPNG());
  const bounds = await one.webContents.executeJavaScript('({height:innerHeight,bottom:document.querySelector("footer").getBoundingClientRect().bottom})');
  report.windowBounds = bounds;
  assert.ok(bounds.bottom <= bounds.height + 1, 'Footer must fit, allowing one CSS pixel for fractional display scaling');
  report.assertions.push('Main table and native window show pending network reconnection in light/dark and minimum window sizes');
  await one.webContents.executeJavaScript('document.getElementById("pause").click();true');
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === job.id)?.status === 'paused', 'manual-pause');
  fixture.reconnect(); fixture.release(); const requests = fixture.requests.length; await delay(3500);
  assert.equal(fixture.requests.length, requests);
  assert.equal((await evaluate('window.sahm.list()')).find(value => value.id === job.id).networkRetry, undefined);
  await one.webContents.executeJavaScript('document.getElementById("resume").click();true');
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === job.id)?.status === 'complete', 'manual-resume-after-pause');
  assert.equal(hash(await fs.readFile(job.path)), hash(first.payload));
  report.assertions.push('Pause cancels pending automatic reconnection; restoring the server cannot override it');
  const second = fixture.add(78, 'stable', true);
  const next = await evaluate('window.sahm.add(' + JSON.stringify({ url: second.url, name: 'استئناف-تلقائي.bin', connections: 2 }) + ')');
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === next.id)?.received > 0, 'second-partial');
  const two = await wait(() => windowFor(next.id), 'second-window'); fixture.interrupt();
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === next.id)?.networkRetry, 'second-waiting');
  await two.webContents.executeJavaScript('setTimeout(()=>window.downloadWindow.hide(),30);true');
  await wait(() => two.isDestroyed(), 'hidden'); fixture.reconnect(); fixture.release();
  await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.id === next.id)?.status === 'complete', 'automatic-completion-without-resume');
  assert.equal(hash(await fs.readFile(next.path)), hash(second.payload)); assert.equal(await windowFor(next.id), undefined);
  report.assertions.push('A disconnected download completes automatically without a resume command and cannot reopen its hidden window');
  report.fileHashes = [{ path: job.path, sha256: hash(first.payload) }, { path: next.path, sha256: hash(second.payload) }];
  report.requests = fixture.requests; report.ok = true; await finish();
})().catch(error => { if (stage) void finish(error); else { console.error(error); app.exit(1); } });
