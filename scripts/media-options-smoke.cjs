const { app, BrowserWindow, clipboard, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const source = path.resolve(argument('--source-root') || path.join(__dirname, '..'));
const directory = path.resolve(argument('--result-directory') || 'artifacts/media-options-ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const report = { ok: false, source, assertions: [], personalProfileUsed: false, virtualMachineUsed: false, installerExecuted: false };
let main, fixture, finished = false, stage = 'startup';
clipboard.readText = async () => ''; app.disableHardwareAcceleration();
app.setLoginItemSettings = () => { throw new Error('Media smoke cannot change login settings'); };
shell.openPath = async () => { throw new Error('Media smoke cannot open external files'); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => main.webContents.executeJavaScript(code);
async function wait(check, label, timeout = 110000) {
  stage = label; const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error('Media UI timed out: ' + label);
}
async function capture(name) {
  main.showInactive(); await wait(() => main.isVisible(), 'visible-window');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(directory, name + '.png'), (await main.webContents.capturePage({ stayAwake: true })).toPNG());
  const bounds = await evaluate('(()=>{const d=document.getElementById("add-dialog"),f=d.querySelector(".dialog-footer"),r=f.getBoundingClientRect();return {bottom:r.bottom,height:innerHeight,width:d.clientWidth,scrollWidth:d.scrollWidth}})()');
  assert.ok(bounds.bottom <= bounds.height + 1, 'Start/cancel buttons must remain visible');
  assert.ok(bounds.scrollWidth <= bounds.width + 1, 'Dialog must not scroll horizontally'); return bounds;
}
async function finish(error) {
  if (finished) return; finished = true;
  if (error) report.error = error.stack;
  report.stage = stage; await fixture?.close();
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log('MEDIA OPTIONS UI ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + path.join(directory, 'result.json'));
  app.once('will-quit', () => app.exit(report.ok ? 0 : 1)); app.quit();
}
(async () => {
  await fs.mkdir(directory, { recursive: true });
  const appData = path.join(directory, 'AppData'), profile = path.join(appData, 'sahm-download-manager');
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(path.join(directory, 'files'));
  app.setPath('appData', appData); app.setPath('userData', profile); app.setPath('downloads', path.join(directory, 'files'));
  const { generateMultiaudioFixture } = await import(pathToFileURL(path.join(__dirname, '../test/helpers/multiaudio-fixture.mjs')));
  const { startMediaFixture } = await import(pathToFileURL(path.join(__dirname, 'media-browser-fixture.mjs')));
  const fixtureDirectory = path.join(directory, 'fixtures');
  await generateMultiaudioFixture(fixtureDirectory, argument('--media-runtime') || path.resolve('artifacts/media-runtime'));
  fixture = await startMediaFixture({ streamDirectory: fixtureDirectory });
  app.on('browser-window-created', (_, window) => window.webContents.once('did-finish-load', () => {
    if (/\/ui\/index\.html$/.test(window.webContents.getURL().replaceAll('\\', '/'))) main = window;
  }));
  const watchdog = setTimeout(() => finish(new Error('Media UI watchdog: ' + stage)), 240000); watchdog.unref();
  require(path.join(source, 'electron/main.cjs'));
  await wait(() => main && evaluate('!!window.sahmMediaAdd'), 'main-ready');
  await evaluate('window.sahm.preferences({theme:"light",showDownloadWindows:false})');
  main.setSize(1100, 800);
  const url = fixture.origin + '/stream/multi.m3u8';
  await evaluate('document.getElementById("toggle-add").click();document.getElementById("url").value=' + JSON.stringify(url) + ';document.getElementById("url").dispatchEvent(new Event("input"));document.getElementById("media-inspect").click();true');
  await wait(() => evaluate('!!document.querySelector("#media-picker select")'), 'actual-media-inspection');
  const selected = await evaluate('(()=>{const set=(name,value,prefix=false)=>{const s=document.querySelector(`[data-media-option="${name}"]`);s.value=Array.from(s.options).find(o=>prefix?o.textContent.startsWith(value):o.value===value).value;s.dispatchEvent(new Event("change"));return s.value};set("container","mp3");return set("audioTrack","ar",true)})()');
  assert.equal(await evaluate('document.querySelector("#media-picker [data-media-option=quality]").parentElement.hidden'), true);
  report.bounds = [await capture('media-options-light')];
  await evaluate('window.sahm.preferences({theme:"dark"})'); main.setSize(900, 680);
  report.bounds.push(await capture('media-options-dark-small'));
  assert.equal(await evaluate('document.querySelector("#media-picker [data-media-option=container]").getAttribute("aria-label")'), 'صيغة الحفظ');
  await evaluate('document.getElementById("name").value="اختيار الصوت العربي";document.getElementById("add-form").requestSubmit();true');
  const job = await wait(async () => (await evaluate('window.sahm.list()')).find(value => value.url === url && ['complete', 'error'].includes(value.status)), 'actual-media-complete');
  assert.equal(job.status, 'complete', job.error); assert.equal(job.mediaContainer, 'mp3'); assert.equal(job.mediaAudioTrack, selected); assert.equal(job.mediaQuality, 'best'); assert.ok(job.path.endsWith('.mp3'));
  report.job = { id: job.id, status: job.status, container: job.mediaContainer, audioTrack: job.mediaAudioTrack, quality: job.mediaQuality, bytes: job.received };
  report.assertions.push('Real main-process inspection populates native selects; selected MP3/Arabic reaches worker and completes; video resolution is hidden');
  report.assertions.push('Light/dark and 900x680 preserve start/cancel visibility and no horizontal dialog overflow');
  await evaluate('document.getElementById("toggle-add").click();document.getElementById("url").value="https://example.com/archive.zip";document.getElementById("url").dispatchEvent(new Event("input"));true');
  assert.equal(await evaluate('document.getElementById("media-add-fields").hidden'), true);
  assert.deepEqual(await evaluate('window.sahmMediaAdd.selection()'), {});
  report.assertions.push('Changing to a normal file clears stale media selections');
  report.ok = true; await finish();
})().catch(finish);
