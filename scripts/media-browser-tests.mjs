import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startBrowserBridge, nativeLauncher } from '../src/browser-bridge.mjs';
import { DownloadManager } from '../src/manager.mjs';
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from '../browser/protocol.mjs';
import { BrowserCdp } from './real-browser-cdp.mjs';
import { startMediaFixture } from './media-browser-fixture.mjs';
import { generateMultiaudioFixture } from '../test/helpers/multiaudio-fixture.mjs';

const run = promisify(execFile);
const selected = process.argv.find(value => ['chrome', 'edge'].includes(value));
const subset = process.argv.find(value => value.startsWith('--case='))?.slice(7);
const audioEnabled = subset === 'audio';
const formatsEnabled = subset === 'formats' || audioEnabled;
const manifestOnly = process.argv.find(value => value.startsWith('--manifest='))?.slice(11);
const youtubeSpaFixture = subset === 'youtube-spa';
const youtubeEnabled = process.argv.includes('--youtube') || subset === 'youtube' || youtubeSpaFixture;
const captureEnabled = !process.argv.includes('--no-captures');
const streamEnabled = process.argv.includes('--streams') || subset === 'streams' || formatsEnabled;
const youtubeTestUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
const directory = process.env.SAHM_MEDIA_BROWSER_RESULT_DIRECTORY ? resolve(process.env.SAHM_MEDIA_BROWSER_RESULT_DIRECTORY) : resolve('artifacts', 'media-browser', runId);
const hostAlias = `${HOST_NAME}.e2e.${randomBytes(8).toString('hex')}`;
const vendors = ['Google\\Chrome', 'Microsoft\\Edge'];
const registryKey = (vendor, host) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${host}`;
const aliasKeys = vendors.map(vendor => registryKey(vendor, hostAlias));
const summary = { runId, routing: 'Production extension copy; native host routing name only changed to isolated temporary alias', browsers: [] };
await mkdir(directory, { recursive: true });
const samplePath = resolve('artifacts', 'media-browser', 'fixtures', 'flower.mp4');
const sampleUrl = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const sampleSha256 = '0cd83d944a6ca7822b4a8306cecc60a36e859b041f6702c6a1ad9ead78924451';
let media;
try { media = await readFile(samplePath); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(sampleUrl, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true);
  media = Buffer.from(await response.arrayBuffer());
  await mkdir(resolve('artifacts', 'media-browser', 'fixtures'), { recursive: true });
  await writeFile(samplePath, media);
}
assert.equal(createHash('sha256').update(media).digest('hex'), sampleSha256);
summary.sample = { url: sampleUrl, documentation: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video', sha256: sampleSha256, bytes: media.length };

async function registryRead(key) {
  try { return (await run('reg.exe', ['query', key, '/s', '/reg:64'], { windowsHide: true })).stdout; }
  catch (error) { if (error.code === 1) return null; throw error; }
}
const productionBefore = await Promise.all(vendors.map(vendor => registryRead(registryKey(vendor, HOST_NAME))));

async function waitFor(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await delay(100);
  }
}

async function makeExtension() {
  const extensionDirectory = join(directory, 'extension');
  await cp(resolve('browser', 'extension'), extensionDirectory, { recursive: true });
  let replacements = 0;
  for (const file of ['background.mjs', 'popup.mjs']) {
    const path = join(extensionDirectory, file);
    const source = await readFile(path, 'utf8');
    replacements += source.split(`'${HOST_NAME}'`).length - 1;
    await writeFile(path, source.replaceAll(`'${HOST_NAME}'`, `'${hostAlias}'`));
  }
  assert.equal(replacements, 2);
  summary.extensionSourceChecks = [];
  for (const file of (await readdir(extensionDirectory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name)) {
    const source = await readFile(resolve('browser', 'extension', file));
    const copy = (await readFile(join(extensionDirectory, file), 'utf8')).replaceAll(`'${hostAlias}'`, `'${HOST_NAME}'`);
    assert.equal(copy, source.toString(), `Production extension must only differ in host routing: ${file}`);
    summary.extensionSourceChecks.push({ file, sha256: createHash('sha256').update(source).digest('hex') });
  }
  return extensionDirectory;
}

async function registerAlias(dataDirectory) {
  for (const key of aliasKeys) assert.equal(await registryRead(key), null);
  const integrationDirectory = join(dataDirectory, 'browser-integration');
  const launcher = join(integrationDirectory, 'media-e2e-native-host.cmd');
  const manifest = join(integrationDirectory, `${hostAlias}.json`);
  await writeFile(launcher, nativeLauncher(process.execPath, resolve('browser', 'native-host.mjs'), join(integrationDirectory, 'connection.json')));
  await writeFile(manifest, JSON.stringify({ name: hostAlias, description: 'SAHM isolated media integration test', path: launcher, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }, null, 2));
  for (const key of aliasKeys) await run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f', '/reg:64'], { windowsHide: true });
}

async function removeAlias() {
  for (const key of aliasKeys) if (await registryRead(key)) await run('reg.exe', ['delete', key, '/f', '/reg:64'], { windowsHide: true });
}

function descendants(node) {
  if (!node) return [];
  return [node, ...(node.children || []).flatMap(descendants), ...(node.shadowRoots || []).flatMap(descendants), ...(node.contentDocument ? descendants(node.contentDocument) : [])];
}

async function dom(cdp, sessionId) {
  await cdp.send('DOM.enable', {}, sessionId);
  return descendants((await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId)).root);
}

function attributes(node) {
  const values = {};
  for (let index = 0; index < (node.attributes || []).length; index += 2) values[node.attributes[index]] = node.attributes[index + 1];
  return values;
}

async function clickNode(cdp, sessionId, node) {
  await cdp.evaluate(sessionId, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, sessionId);
  const x = (model.content[0] + model.content[2]) / 2;
  const y = (model.content[1] + model.content[5]) / 2;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
}

async function overlayHosts(cdp, sessionId) {
  return (await dom(cdp, sessionId)).filter(node => Object.hasOwn(attributes(node), 'data-sahm-media-overlay'));
}

async function triggerVisible(cdp, sessionId) {
  const host = (await overlayHosts(cdp, sessionId))[0];
  if (!host || Object.hasOwn(attributes(host), 'hidden')) return false;
  const anchor = descendants(host).find(node => (attributes(node).class || '').split(' ').includes('anchor'));
  if (!anchor) return false;
  await cdp.send('CSS.enable', {}, sessionId);
  const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId: anchor.nodeId }, sessionId);
  const css = Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
  return css.opacity === '1' && css.display !== 'none' && css.visibility !== 'hidden';
}

async function overlayAckReady(cdp, sessionId, hostIndex = 0) {
  const host = (await overlayHosts(cdp, sessionId))[hostIndex];
  if (!host) return false;
  const status = descendants(host).find(node => (attributes(node).class || '').split(' ').includes('status') && !Object.hasOwn(attributes(node), 'hidden'));
  return Boolean(status && !Object.hasOwn(attributes(overlayButton(host)), 'disabled') && overlayText(status).includes('أُضيف إلى سَهم'));
}

function overlayButton(host) { return descendants(host).find(node => node.nodeName === 'BUTTON'); }

function overlayText(host) { return descendants(host).filter(node => node.nodeType === 3).map(node => node.nodeValue).join(' '); }

async function selectMediaOption(cdp, sessionId, name, value, prefix = false) {
          const node = descendants((await overlayHosts(cdp, sessionId))[0]).find(item => attributes(item)['data-media-option'] === name);
          const object = (await cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, sessionId)).object;
          const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(value,prefix){const option=Array.from(this.options).find(item=>prefix?item.textContent.startsWith(value):item.value===value);if(!option)throw new Error("Missing media option "+value);this.value=option.value;this.dispatchEvent(new Event("change",{bubbles:true}));return this.value}', arguments: [{ value }, { value: prefix }], returnByValue: true, userGesture: true }, sessionId);
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
          await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sessionId); return result.result.value;
}

async function testBrowser(product, binary, extensionDirectory, fixture) {
  const productDirectory = join(directory, product);
  const dataDirectory = join(productDirectory, 'app-data');
  const manager = await new DownloadManager(dataDirectory, join(productDirectory, 'sahm-downloads')).init();
  manager.parallel = 1;
  const bridge = await startBrowserBridge({
    dataDirectory,
    canCapture: request => new URL(request.url).origin === fixture.origin || (youtubeEnabled && request.url === youtubeTestUrl),
    onDownload: (data, options) => {
      assert.equal(new URL(data.url).origin, fixture.origin);
      return manager.add({ ...data, externalId: data.browserRequestId }, options);
    },
    onMediaInfo: (request, options) => {
      assert.ok(request.url === youtubeTestUrl || (streamEnabled && request.url.startsWith(fixture.origin + '/stream/')));
      return manager.inspectMedia(request.url, options);
    },
    onMediaDownload: request => {
      assert.ok(request.url === youtubeTestUrl || (streamEnabled && request.url.startsWith(fixture.origin + '/stream/')));
      return manager.addMedia({ url: request.url, title: request.title, quality: request.quality, container: request.container, audioTrack: request.audioTrack, source: request.source, externalId: request.browserRequestId });
    },
  });
  let cdp;
  const report = { product, cases: [], workerExceptions: [] };
  summary.browsers.push(report);
  try {
    await registerAlias(dataDirectory);
    cdp = await BrowserCdp.launch(binary, join(productDirectory, 'profile'));
    report.version = await cdp.send('Browser.getVersion');
    report.media = fixture.setPayload(media);
    assert.equal((await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory })).id, EXTENSION_ID);
    const popup = await cdp.page(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await waitFor(() => cdp.evaluate(popup.sessionId, 'Boolean(document.getElementById("connection"))'), 'popup ready');
    await cdp.evaluate(popup.sessionId, 'chrome.storage.local.set({enabled:true,showVideoButton:true,allowSession:true,allowPost:true,excludedDomains:[]})');
    const worker = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(value => value.type === 'service_worker' && value.url === `chrome-extension://${EXTENSION_ID}/background.mjs`), 'service worker');
    const workerSession = await cdp.attach(worker.targetId);
    await cdp.send('Runtime.enable', {}, workerSession);
    cdp.on('event', event => {
      if (event.sessionId === workerSession && event.method === 'Runtime.exceptionThrown') report.workerExceptions.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    });
    const ping = await cdp.evaluate(popup.sessionId, `new Promise(resolve=>chrome.runtime.sendNativeMessage(${JSON.stringify(hostAlias)},{v:1,type:'ping',requestId:'media-browser:ping'},response=>resolve({response,error:chrome.runtime.lastError?.message})))`);
    assert.equal(ping.response?.ok, true, JSON.stringify(ping));
    const page = await cdp.page(fixture.origin + '/');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await waitFor(() => cdp.evaluate(page.sessionId, 'document.getElementById("video")?.readyState>=1'), 'valid video metadata');
    report.mediaPlayable = await cdp.evaluate(page.sessionId, '({width:video.videoWidth,height:video.videoHeight,duration:video.duration})');
    assert.ok(report.mediaPlayable.width > 0 && report.mediaPlayable.height > 0);

    async function capture(name, expectedPath, hostIndex = 0, keyboard = false) {
      await cdp.evaluate(page.sessionId, `document.querySelectorAll('video')[${hostIndex}].scrollIntoView({block:'center'})`);
      const hosts = await waitFor(async () => {
        const hosts = await overlayHosts(cdp, page.sessionId);
        return hosts.length > hostIndex && !Object.hasOwn(attributes(hosts[hostIndex]), 'hidden') ? hosts : false;
      }, `${name} overlay host`);
      const button = overlayButton(hosts[hostIndex]);
      assert.ok(button, `${name} overlay button`);
      if (keyboard) {
        await cdp.send('DOM.focus', { nodeId: button.nodeId }, page.sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, page.sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.sessionId);
      } else await clickNode(cdp, page.sessionId, button);
      let job;
      try {
        await waitFor(() => manager.list().find(value => value.url === fixture.origin + expectedPath), `${name} new durable queue job`, 25000);
        await waitFor(() => overlayAckReady(cdp, page.sessionId, hostIndex), `${name} durable ACK visible in extension`, 25000);
        job = await waitFor(() => manager.list().find(value => value.url === fixture.origin + expectedPath && ['complete', 'error'].includes(value.status)), `${name} complete download`);
      }
      catch (error) {
        report.diagnostics = { overlay: overlayText((await overlayHosts(cdp, page.sessionId))[hostIndex]), requests: fixture.requests.slice(-10), jobs: manager.list(), workerExceptions: report.workerExceptions };
        throw error;
      }
      assert.equal(job.status, 'complete', job.error || 'Media download failed');
      assert.deepEqual(await readFile(job.path), media);
      report.cases.push({ name, status: job.status, bytes: job.received, sha256: report.media.sha256, source: job.source });
      console.log(`PASS ${product}/${name}: ${job.received} exact media bytes`);
    }

    if (subset === 'fullscreen') {
      await cdp.evaluate(page.sessionId, 'video.src="/media/fullscreen.mp4"');
      await waitFor(() => cdp.evaluate(page.sessionId, 'video.currentSrc.endsWith("/media/fullscreen.mp4")&&video.readyState>=1'), 'fullscreen media metadata');
      const button = (await dom(cdp, page.sessionId)).find(node => attributes(node).id === 'fullscreen');
      await clickNode(cdp, page.sessionId, button);
      await waitFor(() => cdp.evaluate(page.sessionId, 'Boolean(document.fullscreenElement?.querySelector("[data-sahm-media-overlay]"))'), 'fullscreen overlay layout');
      await capture('fullscreen-video', '/media/fullscreen.mp4');
      await writeFile(join(productDirectory, 'fullscreen-overlay.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
      report.passed = true;
      return;
    }

    if (!['streams', 'formats', 'audio', 'youtube', 'youtube-spa'].includes(subset)) {
    await capture('direct-video', '/media/direct.mp4');
    await writeFile(join(productDirectory, 'direct-overlay.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
    await cdp.evaluate(page.sessionId, 'document.getElementById("dynamic").click()');
    await waitFor(() => cdp.evaluate(page.sessionId, 'document.getElementById("dynamic-video")?.readyState>=1'), 'dynamic source video metadata');
    await capture('dynamic-source-video', '/media/dynamic.mp4', 1);
    await cdp.evaluate(page.sessionId, 'document.getElementById("video").src="/media/changed.mp4"');
    await waitFor(() => cdp.evaluate(page.sessionId, 'video.currentSrc.endsWith("/media/changed.mp4")&&video.readyState>=1'), 'changed video metadata');
    await capture('source-change', '/media/changed.mp4');
    await cdp.evaluate(page.sessionId, 'document.getElementById("video").src="/media/fullscreen.mp4"');
    await waitFor(() => cdp.evaluate(page.sessionId, 'video.currentSrc.endsWith("/media/fullscreen.mp4")&&video.readyState>=1'), 'fullscreen media metadata');
    const fullscreen = (await dom(cdp, page.sessionId)).find(node => attributes(node).id === 'fullscreen');
    await clickNode(cdp, page.sessionId, fullscreen);
    await waitFor(() => cdp.evaluate(page.sessionId, 'Boolean(document.fullscreenElement?.querySelector("[data-sahm-media-overlay]"))'), 'fullscreen overlay layout');
    await capture('fullscreen-video', '/media/fullscreen.mp4');
    await writeFile(join(productDirectory, 'fullscreen-overlay.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
    await cdp.evaluate(page.sessionId, 'document.exitFullscreen()');

    // A custom player's transparent controls intercept pointerenter on <video>.
    // The download control must remain discoverable while that video is playing.
    await cdp.send('Page.reload', {}, page.sessionId);
    await waitFor(() => cdp.evaluate(page.sessionId, 'video.readyState>=1'), 'reloaded video');
    await cdp.evaluate(page.sessionId, 'video.muted=true;video.loop=true;video.play()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 990 }, page.sessionId);
    const videoNode = (await dom(cdp, page.sessionId)).find(node => attributes(node).id === 'video');
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: videoNode.nodeId }, page.sessionId);
    await cdp.evaluate(page.sessionId, 'document.getElementById("controls-layer").style.display="block"');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: model.content[0] + 40, y: model.content[1] + 40 }, page.sessionId);
    report.playerLayer = await cdp.evaluate(page.sessionId, `({paused:video.paused, pointerTarget:document.elementFromPoint(${model.content[0] + 40},${model.content[1] + 40})?.id})`);
    assert.equal(report.playerLayer.paused, false);
    assert.equal(report.playerLayer.pointerTarget, 'controls-layer');
    try {
      await waitFor(() => triggerVisible(cdp, page.sessionId), 'playing custom player exposes download without a video pointerenter', 5000);
    } catch (error) {
      await writeFile(join(productDirectory, 'playing-controls-layer-regression.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
      throw error;
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1200, y: 990 }, page.sessionId);
    assert.equal(await triggerVisible(cdp, page.sessionId), true, 'Control remains visible when the mouse leaves the player');
    await writeFile(join(productDirectory, 'playing-controls-layer.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
    report.cases.push({ name: 'playing-controls-layer-and-unhovered-visibility', passed: true });
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await cdp.evaluate(popup.sessionId, 'document.getElementById("checkVideo").click()');
    await waitFor(() => cdp.evaluate(popup.sessionId, 'document.getElementById("videoStatus").textContent.includes("ظاهر فوق الفيديو")'), 'popup reports current tab overlay visibility');
    assert.equal(await cdp.evaluate(popup.sessionId, 'document.getElementById("version").textContent'), JSON.parse(await readFile(join(extensionDirectory, 'manifest.json'), 'utf8')).version);
    report.cases.push({ name: 'popup-version-and-current-tab-diagnostic', passed: true });
    await cdp.evaluate(popup.sessionId, 'document.getElementById("videoPanelMode").value="mini";document.getElementById("videoPanelMode").dispatchEvent(new Event("change"))');
    await waitFor(async () => (attributes(overlayButton((await overlayHosts(cdp, page.sessionId))[0])).class || '').includes('compact'), 'mini video panel');
    await cdp.evaluate(popup.sessionId, 'document.getElementById("videoPanelMode").value="full";document.getElementById("videoPanelMode").dispatchEvent(new Event("change"))');
    await waitFor(async () => !(attributes(overlayButton((await overlayHosts(cdp, page.sessionId))[0])).class || '').includes('compact'), 'full video panel');
    report.cases.push({ name: 'full-mini-panel-preference', passed: true });
    await cdp.evaluate(page.sessionId, 'document.getElementById("controls-layer").style.display="none"');
    await cdp.evaluate(page.sessionId, 'video.pause();video.src="/media/keyboard.mp4"');
    await waitFor(() => cdp.evaluate(page.sessionId, 'video.currentSrc.endsWith("/media/keyboard.mp4")&&video.readyState>=1'), 'keyboard media metadata');
    await capture('keyboard-enter-download', '/media/keyboard.mp4', 0, true);

    async function refuses(name, expression, expectedText) {
      const count = manager.list().length;
      await cdp.evaluate(page.sessionId, expression);
      await waitFor(() => cdp.evaluate(page.sessionId, 'video.readyState>=1'), `${name} video metadata`);
      const host = await waitFor(async () => {
        const host = (await overlayHosts(cdp, page.sessionId))[0];
        return host && !Object.hasOwn(attributes(host), 'hidden') ? host : false;
      }, `${name} visible overlay`);
      const beforeRequests = fixture.requests.length;
      await clickNode(cdp, page.sessionId, overlayButton(host));
      await waitFor(async () => overlayText((await overlayHosts(cdp, page.sessionId))[0]).includes(expectedText), `${name} refusal message`);
      assert.equal(manager.list().length, count);
      assert.equal(fixture.requests.length, beforeRequests, 'Refusal must not send a replay request');
      report.cases.push({ name, passed: true, queued: false, replayed: false });
    }
    const beforeBlobSelection = manager.list().length;
    await cdp.evaluate(page.sessionId, '(async()=>{video.src=URL.createObjectURL(await fetch("/media/blob.mp4").then(response=>response.blob()))})()');
    await waitFor(() => cdp.evaluate(page.sessionId, 'video.readyState>=1'), 'blob media metadata');
    report.blobDiscovery = await cdp.evaluate(popup.sessionId, 'chrome.runtime.sendMessage({type:"sahm-popup-media-list"})');
    await clickNode(cdp, page.sessionId, overlayButton((await overlayHosts(cdp, page.sessionId))[0]));
    let blobChoice;
    try {
      blobChoice = await waitFor(async () => descendants((await overlayHosts(cdp, page.sessionId))[0]).find(node => attributes(node).role === 'menuitem' && overlayText(node).includes('blob.mp4')), 'observed blob source is an explicit choice');
    } catch (error) {
      report.blobOverlay = overlayText((await overlayHosts(cdp, page.sessionId))[0]);
      await writeFile(join(productDirectory, 'blob-discovery-failure.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
      throw error;
    }
    assert.equal(manager.list().length, beforeBlobSelection, 'Network discovery must not choose a request automatically');
    await clickNode(cdp, page.sessionId, blobChoice);
    const blobJob = await waitFor(() => manager.list().find(value => value.url === fixture.origin + '/media/blob.mp4' && ['complete', 'error'].includes(value.status)), 'selected observed media download');
    assert.equal(blobJob.status, 'complete', blobJob.error);
    assert.deepEqual(await readFile(blobJob.path), media);
    await waitFor(async () => !Object.hasOwn(attributes(overlayButton((await overlayHosts(cdp, page.sessionId))[0])), 'disabled'), 'blob download durable ACK received');
    report.cases.push({ name: 'blob-network-discovery-explicit-download', status: blobJob.status, bytes: blobJob.received, source: blobJob.source });
    await cdp.evaluate(popup.sessionId, 'chrome.storage.local.set({enabled:false})');
    await delay(200);
    await cdp.evaluate(popup.sessionId, 'chrome.storage.local.set({enabled:true})');
    await waitFor(() => triggerVisible(cdp, page.sessionId), 're-enabled blob overlay');
    await refuses('unobserved-blob-refusal', 'video.pause()', 'غير مدعوم');
    await refuses('encrypted-event-refusal', '(async()=>{video.src="/media/encrypted.mp4";await new Promise(resolve=>video.onloadedmetadata=resolve);video.dispatchEvent(new MediaEncryptedEvent("encrypted",{initDataType:"cenc",initData:new Uint8Array([1,2,3]).buffer}))})()', 'محمي');
    report.encryptedEventIsSynthetic = true;

    for (const settings of [{ showVideoButton: false }, { showVideoButton: true, enabled: false }, { enabled: true, excludedDomains: ['127.0.0.1'] }]) {
      await cdp.evaluate(popup.sessionId, `chrome.storage.local.set(${JSON.stringify(settings)})`);
      await waitFor(async () => {
        const hosts = await overlayHosts(cdp, page.sessionId);
        return hosts.every(host => Object.hasOwn(attributes(host), 'hidden'));
      }, 'disabled or excluded page hides overlays');
    }
    report.cases.push({ name: 'settings-and-domain-exclusion', passed: true });
    await cdp.evaluate(popup.sessionId, 'chrome.storage.local.set({enabled:true,showVideoButton:true,excludedDomains:[]})');
    await waitFor(async () => (await overlayHosts(cdp, page.sessionId)).some(host => !Object.hasOwn(attributes(host), 'hidden')), 're-enabled overlay');
    await cdp.evaluate(page.sessionId, 'video.remove()');
    await waitFor(async () => (await overlayHosts(cdp, page.sessionId)).length === 0, 'removed video overlay cleaned up');
    report.cases.push({ name: 'removed-video-cleanup', passed: true });
    await cdp.evaluate(page.sessionId, 'fetch("/media/popup.mp4").then(response=>response.arrayBuffer())');
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await cdp.evaluate(popup.sessionId, 'document.getElementById("listMedia").click()');
    await waitFor(() => cdp.evaluate(popup.sessionId, 'Array.from(document.querySelectorAll("#pageMedia button")).some(button=>button.textContent.includes("popup.mp4"))'), 'popup lists observed media without a DOM video');
    await cdp.evaluate(popup.sessionId, 'Array.from(document.querySelectorAll("#pageMedia button")).find(button=>button.textContent.includes("popup.mp4")).click()');
    const popupJob = await waitFor(() => manager.list().find(value => value.url === fixture.origin + '/media/popup.mp4' && ['complete', 'error'].includes(value.status)), 'popup selected media complete');
    assert.equal(popupJob.status, 'complete', popupJob.error);
    assert.deepEqual(await readFile(popupJob.path), media);
    await waitFor(() => cdp.evaluate(popup.sessionId, 'document.getElementById("result").textContent.includes("أُضيف الفيديو")'), 'popup fallback durable ACK shown');
    report.cases.push({ name: 'popup-network-media-without-dom-video', status: popupJob.status, bytes: popupJob.received, source: popupJob.source });
    try {
      await cdp.send('Target.activateTarget', { targetId: popup.targetId });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: false }, popup.sessionId);
      await cdp.evaluate(popup.sessionId, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const popupHeight = await cdp.evaluate(popup.sessionId, 'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
      await writeFile(join(productDirectory, 'popup-media-diagnostics.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 320, height: Math.min(1600, Math.max(600, popupHeight)), scale: 1 } }, popup.sessionId)).data, 'base64'));
    } catch (error) { report.visualWarnings = [`Popup screenshot unavailable: ${error.message}`]; }
    finally { await cdp.send('Target.activateTarget', { targetId: page.targetId }); }
    }

    if (streamEnabled) {
      await cdp.evaluate(page.sessionId, 'document.querySelectorAll("video").forEach(element=>element.remove())');
      await waitFor(async () => (await overlayHosts(cdp, page.sessionId)).length === 0, 'old video overlays removed before stream preview');
      await cdp.evaluate(page.sessionId, '(async()=>{const element=document.createElement("video");element.id="video";element.controls=true;element.src=URL.createObjectURL(await fetch("/media/stream-preview.mp4").then(response=>response.blob()));document.getElementById("player").prepend(element)})()');
      await waitFor(() => cdp.evaluate(page.sessionId, 'document.getElementById("video")?.readyState>=1'), 'stream discovery preview video');
      await waitFor(async () => {
        const host = (await overlayHosts(cdp, page.sessionId))[0];
        return host && !Object.hasOwn(attributes(host), 'hidden') && overlayButton(host);
      }, 'stream preview download button ready');
      for (const manifest of (formatsEnabled ? ['multi.m3u8', 'multi.mpd', 'webm.mpd'] : ['master.m3u8', 'vod.mpd']).filter(value => !manifestOnly || value === manifestOnly)) {
        const manifestUrl = `${fixture.origin}/stream/${manifest}`;
        await cdp.evaluate(page.sessionId, `fetch(${JSON.stringify('/stream/' + manifest)}).then(response=>response.text())`);
        await clickNode(cdp, page.sessionId, overlayButton((await overlayHosts(cdp, page.sessionId))[0]));
        const choice = await waitFor(async () => descendants((await overlayHosts(cdp, page.sessionId))[0]).find(node => attributes(node).role === 'menuitem' && overlayText(node).includes(manifest)), `${manifest} appears as an explicit network choice`);
        const before = manager.list().length;
        await clickNode(cdp, page.sessionId, choice);
        const quality = await waitFor(async () => descendants((await overlayHosts(cdp, page.sessionId))[0]).find(node => attributes(node)['data-media-option'] === 'quality'), `${manifest} actual format picker`, 110000);

        const container = audioEnabled ? (manifest === 'multi.m3u8' ? 'mp3' : 'm4a') : formatsEnabled ? manifest === 'webm.mpd' ? 'webm' : manifest.endsWith('.mpd') ? 'mkv' : 'mp4' : 'auto';
        await selectMediaOption(cdp, page.sessionId, 'container', container); await selectMediaOption(cdp, page.sessionId, 'quality', audioEnabled ? 'best' : '240');
        const audioTrack = formatsEnabled ? await selectMediaOption(cdp, page.sessionId, 'audioTrack', manifest === 'multi.m3u8' ? 'ar' : manifest === 'multi.mpd' ? 'en' : 'ar', true) : 'default';
        assert.equal(manager.list().length, before, 'Inspecting a manifest must not enqueue it');
        await writeFile(join(productDirectory, `${manifest}-quality-menu.png`), Buffer.from((await cdp.send('Page.captureScreenshot', {}, page.sessionId)).data, 'base64'));
        const start = descendants((await overlayHosts(cdp, page.sessionId))[0]).find(node => node.nodeName === 'BUTTON' && overlayText(node) === 'تنزيل باستخدام سَهم');
        assert.ok(start); await clickNode(cdp, page.sessionId, start);
        await waitFor(() => manager.list().find(value => value.url === manifestUrl), `${manifest} new durable queue job`, 25000);
        await waitFor(() => overlayAckReady(cdp, page.sessionId), `${manifest} durable ACK visible in extension`, 25000);
        const job = await waitFor(() => manager.list().find(value => value.url === manifestUrl && ['complete', 'error'].includes(value.status)), `${manifest} complete video/audio mux`, 180000);
        assert.equal(job.status, 'complete', job.error);
        assert.equal(job.mediaContainer, container); assert.equal(job.mediaAudioTrack, audioTrack); assert.equal(job.mediaQuality, audioEnabled ? 'best' : '240');
        const { stdout } = await run(resolve('artifacts', 'media-runtime', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', job.path], { windowsHide: true });
        const probe = JSON.parse(stdout);
        if (audioEnabled) { assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_name, container === 'mp3' ? 'mp3' : 'aac'); }
        else assert.ok(probe.streams.some(item => item.codec_type === 'video' && item.height === 240));
        assert.ok(probe.streams.some(item => item.codec_type === 'audio'));
        report.cases.push({ name: `${manifest}-network-discovery-download`, status: job.status, bytes: job.received, source: job.source, quality: job.mediaQuality, container: job.mediaContainer, audioTrack: job.mediaAudioTrack, streams: probe.streams });
        console.log(`PASS ${product}/${manifest}: ${job.received} video/audio bytes`);
      }
    }

    if (youtubeEnabled && (product === 'chrome' || youtubeSpaFixture)) {
      report.youtube = { attempted: true, url: youtubeTestUrl, usesRealInspectionAndDownloader: true, controlledSpaPage: youtubeSpaFixture };
      let youtube;
      try {
        if (youtubeSpaFixture) {
          youtube = await cdp.page('about:blank');
          cdp.on('event', event => {
            if (event.sessionId !== youtube.sessionId || event.method !== 'Fetch.requestPaused') return;
            const html = '<!doctype html><title>SAHM isolated YouTube SPA fixture</title><video style="width:640px;height:360px" controls></video>';
            void cdp.send('Fetch.fulfillRequest', { requestId: event.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from(html).toString('base64') }, youtube.sessionId).catch(() => {});
          });
          await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.youtube.com/', requestStage: 'Request' }] }, youtube.sessionId);
          await cdp.send('Page.navigate', { url: 'https://www.youtube.com/' }, youtube.sessionId);
          await waitFor(async () => (await overlayHosts(cdp, youtube.sessionId)).length > 0, 'extension injected into controlled YouTube home document');
          await cdp.evaluate(youtube.sessionId, `history.pushState({},'',${JSON.stringify(youtubeTestUrl)})`);
          await delay(250);
        } else youtube = await cdp.page(youtubeTestUrl);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, youtube.sessionId);
        const host = await waitFor(async () => (await overlayHosts(cdp, youtube.sessionId)).find(host => !Object.hasOwn(attributes(host), 'hidden')), 'actual YouTube video and overlay', 50000);
        await cdp.evaluate(youtube.sessionId, 'document.querySelector("video")?.pause()');
        report.youtube.beforeClick = await cdp.evaluate(youtube.sessionId, '({url:location.href,title:document.title,paused:document.querySelector("video")?.paused})');
        assert.equal(new URL(report.youtube.beforeClick.url).searchParams.get('v'), 'jNQXAC9IVRw');
        assert.equal(await triggerVisible(cdp, youtube.sessionId), true, 'YouTube download control is visibly rendered');
        const currentHost = await waitFor(async () => (await overlayHosts(cdp, youtube.sessionId)).find(value => !Object.hasOwn(attributes(value), 'hidden') && overlayButton(value)), 'current YouTube download trigger');
        await clickNode(cdp, youtube.sessionId, overlayButton(currentHost));
        const quality = await waitFor(async () => {
          const hosts = await overlayHosts(cdp, youtube.sessionId);
          return hosts.flatMap(descendants).find(node => attributes(node)['data-media-option'] === 'quality');
        }, 'actual YouTube inspection quality menu', 110000);
        if (captureEnabled) await writeFile(join(productDirectory, 'youtube-quality-menu.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, youtube.sessionId)).data, 'base64'));
        await selectMediaOption(cdp, youtube.sessionId, 'quality', '240');
        const start = descendants((await overlayHosts(cdp, youtube.sessionId))[0]).find(node => node.nodeName === 'BUTTON' && overlayText(node) === 'تنزيل باستخدام سَهم');
        assert.ok(start); await clickNode(cdp, youtube.sessionId, start);
        await waitFor(() => manager.list().find(value => value.url === youtubeTestUrl), 'YouTube new durable queue job', 25000);
        await waitFor(() => overlayAckReady(cdp, youtube.sessionId), 'YouTube durable ACK visible in extension', 25000);
        const job = await waitFor(() => manager.list().find(value => value.url === youtubeTestUrl && ['complete', 'error'].includes(value.status)), 'actual YouTube download and audio/video mux', 240000);
        assert.equal(job.status, 'complete', job.error);
        const { stdout } = await run(resolve('artifacts', 'media-runtime', 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', job.path], { windowsHide: true });
        const probe = JSON.parse(stdout);
        assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.height === 240));
        assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
        report.youtube = { ...report.youtube, passed: true, status: job.status, bytes: job.received, quality: job.mediaQuality, file: job.path, streams: probe.streams, sha256: createHash('sha256').update(await readFile(job.path)).digest('hex') };
        console.log(`PASS ${product}/${youtubeSpaFixture ? 'controlled-spa-real-youtube-download' : 'actual-youtube-overlay'}: ${job.received} muxed audio/video bytes`);
      } catch (error) {
        report.youtube = { ...report.youtube, passed: false, error: error.message };
        if (youtube) {
          report.youtube.page = await cdp.evaluate(youtube.sessionId, '({url:location.href,title:document.title,videoCount:document.querySelectorAll("video").length,text:document.body.innerText.slice(0,1200)})').catch(() => null);
          report.youtube.overlay = overlayText((await overlayHosts(cdp, youtube.sessionId))[0]);
          if (captureEnabled) await writeFile(join(productDirectory, 'youtube-limited.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {}, youtube.sessionId)).data, 'base64')).catch(() => {});
        }
        console.error(`LIMIT chrome/actual-youtube-overlay: ${error.message}`);
        process.exitCode = 1;
      }
    }
    assert.equal(report.workerExceptions.length, 0, JSON.stringify(report.workerExceptions));
    report.passed = report.youtube?.passed !== false;
  } finally {
    if (cdp) await cdp.close();
    await bridge.close();
    await manager.close();
    await removeAlias();
  }
}

const streamDirectory = formatsEnabled ? join(directory, 'fixtures') : resolve('artifacts', 'public-stream-fixture');
if (formatsEnabled) await generateMultiaudioFixture(streamDirectory);
const fixture = await startMediaFixture({ streamDirectory: streamEnabled ? streamDirectory : undefined });
try {
  const extensionDirectory = await makeExtension();
  const browsers = [
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ].filter(([product]) => !selected || product === selected);
  for (const [product, binary] of browsers) await testBrowser(product, binary, extensionDirectory, fixture);
} catch (error) {
  summary.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.close();
  await removeAlias();
  const productionAfter = await Promise.all(vendors.map(vendor => registryRead(registryKey(vendor, HOST_NAME))));
  summary.productionRegistryUnchanged = JSON.stringify(productionBefore) === JSON.stringify(productionAfter);
  summary.aliasRegistryRemoved = (await Promise.all(aliasKeys.map(registryRead))).every(value => value === null);
  await writeFile(join(directory, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`Evidence: ${join(directory, 'results.json')}`);
  assert.equal(summary.productionRegistryUnchanged, true);
  assert.equal(summary.aliasRegistryRemoved, true);
}

