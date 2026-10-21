import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sevenZip from '7zip-bin';
import { BrowserCdp } from './real-browser-cdp.mjs';
import { startMediaFixture } from './media-browser-fixture.mjs';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const archive = resolve(process.argv[2] || `dist/${version}/extension/SAHM-Extension-${version}-store.zip`);
const output = resolve(process.env.SAHM_STORE_PACKAGE_RESULT || `dist/${version}/validation/store-package`);
const parent = resolve(process.env.SAHM_QA_ROOT || output);
await mkdir(output, { recursive: true }); await mkdir(parent, { recursive: true });
const workspace = await mkdtemp(join(parent, 'sahm-store-package-'));
const extensionPath = join(workspace, 'extension');
const report = { ok: false, version, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), browsers: [], storeInstallationTested: false, personalProfilesUsed: false, registryWrites: false, filesModifiedAfterExtraction: false, workspace };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const descendants = node => [node, ...(node.children || []).flatMap(descendants), ...(node.shadowRoots || []).flatMap(descendants)];
const attributes = node => Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, i) => [node.attributes[2 * i], node.attributes[2 * i + 1]]));
async function wait(check) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await delay(100); }
  throw new Error('Store package popup did not become ready');
}
let fixture;
try {
  await run(sevenZip.path7za, ['x', '-y', '-o' + extensionPath, archive], { windowsHide: true });
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.key, undefined); assert.equal(manifest.version, version);
  const sample = await readFile(resolve('artifacts/media-browser/fixtures/flower.mp4'));
  assert.equal(createHash('sha256').update(sample).digest('hex'), '0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451');
  fixture = await startMediaFixture(); fixture.setPayload(sample);
  report.sample = { source: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', license: 'CC0', syntheticLocalPage: true };
  for (const [name, binary] of [['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'], ['edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
    const browser = await BrowserCdp.launch(binary, join(workspace, name));
    try {
      const installed = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
      assert.match(installed.id, /^[a-p]{32}$/);
      const popup = await browser.page('chrome-extension://' + installed.id + '/popup.html');
      await wait(() => browser.evaluate(popup.sessionId, '!!document.getElementById("connection") && document.getElementById("connection").textContent !== sahmI18n.t("جارٍ فحص اتصال التطبيق…")'));
      const metadata = await browser.evaluate(popup.sessionId, '({name:chrome.runtime.getManifest().name,description:chrome.runtime.getManifest().description,version:chrome.runtime.getManifest().version,message:chrome.i18n.getMessage("extensionName"),capture:document.getElementById("enabled").checked,session:document.getElementById("allowSession").checked,post:document.getElementById("allowPost").checked})');
      assert.ok(['سَهم — تكامل المتصفح', 'SAHM — Browser Integration'].includes(metadata.name));
      assert.equal(metadata.name, metadata.message); assert.equal(metadata.version, version);
      assert.equal(metadata.capture, false); assert.equal(metadata.session, false); assert.equal(metadata.post, false);
      await browser.evaluate(popup.sessionId, 'chrome.storage.local.set({enabled:true,showVideoButton:true})');
      const page = await browser.page(fixture.origin + '/');
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page.sessionId);
      await wait(() => browser.evaluate(page.sessionId, 'document.getElementById("video")?.readyState>=1'));
      await browser.evaluate(page.sessionId, 'document.getElementById("video").currentTime=2;true');
      await browser.send('DOM.enable', {}, page.sessionId);
      const cases = [];
      for (const language of ['en', 'ar']) {
        await browser.evaluate(popup.sessionId, 'document.getElementById("language").value=' + JSON.stringify(language) + ';document.getElementById("language").dispatchEvent(new Event("change"));true');
        await wait(() => browser.evaluate(popup.sessionId, 'document.documentElement.lang===' + JSON.stringify(language) + '&&document.getElementById("language").value===' + JSON.stringify(language)));
        const direction = await browser.evaluate(popup.sessionId, 'getComputedStyle(document.getElementById("excludedDomains")).direction');
        assert.equal(direction, language === 'ar' ? 'rtl' : 'ltr');
        await wait(async () => descendants((await browser.send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId)).root).find(node => Object.hasOwn(attributes(node), 'data-sahm-media-overlay') && attributes(node).dir === direction));
        const screenshot = name + '-' + language + '-video.png';
        await browser.send('Target.activateTarget', { targetId: page.targetId });
        const capture = await browser.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
        await writeFile(join(output, screenshot), Buffer.from(capture.data, 'base64'));
        cases.push({ language, direction, overlay: true, screenshot, width: 1280, height: 800 });
      }
      report.browsers.push({ name, version: await browser.send('Browser.getVersion'), extensionId: installed.id, metadata, cases, passed: true });
    } finally { await browser.close(); }
  }
  report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { if (fixture) await fixture.close(); }
await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ok: report.ok, output, error: report.error }));
