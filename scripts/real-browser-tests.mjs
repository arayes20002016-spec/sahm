import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const applicationRoot = resolve(process.env.SAHM_APPLICATION_ROOT || '.');
const browserDirectory = resolve(process.env.SAHM_BROWSER_DIRECTORY || 'browser');
const { startBrowserBridge, nativeLauncher, prepareBrowserDownload } = await import(pathToFileURL(join(applicationRoot,'src/browser-bridge.mjs')));
const { DownloadManager } = await import(pathToFileURL(join(applicationRoot,'src/manager.mjs')));
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from '../browser/protocol.mjs';
import { BrowserCdp } from './real-browser-cdp.mjs';
import { fixtureCookie, formBody, rawFormBody, payload, payloadSha256, startFixture } from './real-browser-fixture.mjs';

const run = promisify(execFile);
const captureEnabled = !process.argv.includes('--no-captures');
const baseline = process.argv.includes('--baseline');
const selected = process.argv.find(value => ['chrome', 'edge'].includes(value));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
const directory = resolve(process.env.SAHM_BROWSER_TEST_DIRECTORY || 'artifacts/real-browser', runId);
const hostAlias = `${HOST_NAME}.e2e.${randomBytes(8).toString('hex')}`;
const vendors = ['Google\\Chrome', 'Microsoft\\Edge'];
const registryKey = (vendor, name) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${name}`;
const aliasKeys = vendors.map(vendor => registryKey(vendor, hostAlias));
await mkdir(directory, { recursive: true });
const summary = { runId, baseline, routing: 'Production extension copy; native host name only changed to unique temporary alias', browsers: [], productionRegistryUnchanged: false, aliasRegistryRemoved: false };
let fixture;

async function registryRead(key) {
  try { return (await run('reg.exe', ['query', key, '/s', '/reg:64'], { windowsHide: true })).stdout; }
  catch (error) { if (error.code === 1) return null; throw error; }
}
const productionBefore = await Promise.all(vendors.map(vendor => registryRead(registryKey(vendor, HOST_NAME))));

async function waitFor(check, message, timeout = 25000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(100);
  }
}

async function makeExtension() {
  const extensionDirectory = join(directory, 'extension');
  await cp(resolve(browserDirectory, 'extension'), extensionDirectory, { recursive: true });
  let replacements = 0;
  for (const file of ['background.mjs', 'popup.mjs']) {
    const path = join(extensionDirectory, file);
    const source = await readFile(path, 'utf8');
    const count = source.split(`'${HOST_NAME}'`).length - 1;
    replacements += count;
    await writeFile(path, source.replaceAll(`'${HOST_NAME}'`, `'${hostAlias}'`));
  }
  assert.equal(replacements, 2, 'Only the background and popup native host routing names are substituted');
  const sourceChecks = [];
  async function compare(relative = '') {
    for (const entry of await readdir(join(extensionDirectory, relative), { withFileTypes: true })) {
      const file = join(relative, entry.name);
      if (entry.isDirectory()) { await compare(file); continue; }
      assert.ok(entry.isFile(), 'Unexpected extension entry');
      const source = await readFile(resolve(browserDirectory, 'extension', file));
      let copy = await readFile(join(extensionDirectory, file));
      if (['background.mjs', 'popup.mjs'].includes(file)) copy = Buffer.from(copy.toString('utf8').replaceAll(`'${hostAlias}'`, `'${HOST_NAME}'`));
      assert.deepEqual(copy, source, `Extension source must match except routing name: ${file}`);
      sourceChecks.push({ file, sha256: createHash('sha256').update(source).digest('hex') });
    }
  }
  await compare();
  summary.extensionSourceChecks = sourceChecks;
  return extensionDirectory;
}

async function aliasRegistration(dataDirectory) {
  for (const key of aliasKeys) assert.equal(await registryRead(key), null, 'Temporary alias must be unused');
  const integrationDirectory = join(dataDirectory, 'browser-integration');
  const launcher = join(integrationDirectory, 'e2e-native-host.cmd');
  const manifest = join(integrationDirectory, `${hostAlias}.json`);
  await writeFile(launcher, nativeLauncher(process.execPath, resolve(browserDirectory, 'native-host.mjs'), join(integrationDirectory, 'connection.json')));
  await writeFile(manifest, JSON.stringify({ name: hostAlias, description: 'SAHM isolated local browser integration test', path: launcher, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }, null, 2));
  for (const key of aliasKeys) await run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f', '/reg:64'], { windowsHide: true });
}

async function removeAlias() {
  for (const key of aliasKeys) {
    if (await registryRead(key)) await run('reg.exe', ['delete', key, '/f', '/reg:64'], { windowsHide: true });
  }
}

async function testBrowser(product, binary, extensionDirectory) {
  const requestStart = fixture.requests.length;
  const productDirectory = join(directory, product);
  const dataDirectory = join(productDirectory, 'app-data');
  const manager = await new DownloadManager(dataDirectory, join(productDirectory, 'sahm-downloads')).init();
  manager.parallel = 1;
  let masterEnabled = true;
  const preparations = [];
  const openBridge = () => startBrowserBridge({
    dataDirectory,
    canCapture: request => new URL(request.url).origin === fixture.origin && masterEnabled,
    prepare: async (request, options) => {
      const entry = { method: request.method, path: new URL(request.url).pathname, headers: Object.keys(request.requestContext?.headers || {}), bodyLength: request.requestContext?.body?.length || 0 };
      preparations.push(entry);
      try { return await prepareBrowserDownload(request, options); }
      catch (error) { entry.error = error.message; throw error; }
    },
    onBrowserComplete: data => manager.importBrowserCompleted({ ...data, externalId: data.browserRequestId }),
    onDownload: (data, options) => {
      assert.equal(new URL(data.url).origin, fixture.origin, 'Never accept downloads outside controlled fixture origin');
      return manager.add({ ...data, externalId: data.browserRequestId }, options);
    },
  });
  let bridge = await openBridge();
  let cdp;
  const report = { product, cases: [], workerExceptions: [], preparations };
  summary.browsers.push(report);
  const screenshot = async (name, sessionId) => {
    if (!captureEnabled || (process.argv.includes('--popup-only') && (name !== 'extension-popup.png' || product !== 'chrome'))) return;
    const entry = { file: name };
    (report.screenshots ??= []).push(entry);
    try {
      // CDP calls are bounded by BrowserCdp's timeout; images are diagnostic evidence.
      await cdp.send('Page.bringToFront', {}, sessionId);
      const { data } = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: false }, sessionId);
      await writeFile(join(productDirectory, name), Buffer.from(data, 'base64'));
      entry.saved = true;
    } catch (error) {
      entry.saved = false;
      entry.error = error.message;
      console.warn(`${product}: optional screenshot ${name}: ${error.message}`);
    }
  };
  try {
    await aliasRegistration(dataDirectory);
    const profileDirectory = join(productDirectory, 'profile');
    await mkdir(join(profileDirectory, 'Default'), { recursive: true });
    await writeFile(join(profileDirectory, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: join(productDirectory, 'browser-downloads'), prompt_for_download: false }, profile: { default_content_setting_values: { automatic_downloads: 1 } } }));
    cdp = await BrowserCdp.launch(binary, profileDirectory);
    report.version = await cdp.send('Browser.getVersion');
    const installed = await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory });
    console.log(`${product}: unpacked extension installed`);
    assert.equal(installed.id, EXTENSION_ID);
    const extensions = (await cdp.send('Extensions.getExtensions')).extensions;
    const extension = extensions.find(value => value.id === EXTENSION_ID);
    assert.equal(extension?.enabled, true);
    report.extension = extension;
    const popup = await cdp.page(`chrome-extension://${EXTENSION_ID}/popup.html`);
    console.log(`${product}: popup tab opened`);
    await waitFor(() => cdp.evaluate(popup.sessionId, 'Boolean(document.getElementById("connection"))'), 'extension popup ready');
    report.worker = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(value => value.type === 'service_worker' && value.url === `chrome-extension://${EXTENSION_ID}/background.mjs`), 'extension service worker active');
    const workerSession = await cdp.attach(report.worker.targetId);
    await cdp.send('Runtime.enable', {}, workerSession);
    await waitFor(() => cdp.evaluate(workerSession, `typeof chrome !== 'undefined' && chrome.runtime?.id === ${JSON.stringify(EXTENSION_ID)}`), 'extension worker execution context ready');
    report.filenameListenerRegistered = await cdp.evaluate(workerSession, 'chrome.downloads.onDeterminingFilename.hasListeners()');
    cdp.on('event', event => {
      if (event.sessionId === workerSession && event.method === 'Runtime.exceptionThrown') report.workerExceptions.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    });
    const ping = await cdp.evaluate(popup.sessionId, `new Promise(resolve => chrome.runtime.sendNativeMessage(${JSON.stringify(hostAlias)}, {v:1,type:'ping',requestId:'real-browser:ping'}, response => resolve({response,error:chrome.runtime.lastError?.message})))`);
    assert.equal(ping.response?.ok, true, JSON.stringify(ping));
    report.nativePing = ping.response.ok;
    const page = await cdp.page(fixture.origin + '/');
    await waitFor(() => cdp.evaluate(page.sessionId, 'Boolean(document.getElementById("download"))'), 'fixture tab ready');
    await screenshot('fixture-tab.png', page.sessionId);
    const setSettings = values => cdp.evaluate(popup.sessionId, `chrome.storage.local.set(${JSON.stringify({ enabled: true, excludedDomains: [], bypassNext: false, bypassUntil: 0, allowSession: false, allowPost: false, lastResult: null, ...values })})`);
    const getResult = () => cdp.evaluate(popup.sessionId, 'chrome.storage.local.get("lastResult").then(value=>value.lastResult?.reason==="browser-completing"?null:value.lastResult)');
    const browserDownloads = () => cdp.evaluate(popup.sessionId, 'chrome.downloads.search({})');

    async function exercise(name, kind, { capture, settings = {}, expectedRequests, appUnavailable = false } = {}) {
      await setSettings(settings);
      const beforeJobs = manager.list().length;
      const path = `/${kind}/${product}-${name}.txt`;
      const url = fixture.origin + path;
      if (['export', 'rawexport', 'multipart'].includes(kind)) {
        const formId = { export: 'post', rawexport: 'raw', multipart: 'multipart' }[kind];
        await cdp.evaluate(page.sessionId, `document.getElementById(${JSON.stringify(formId)}).action=${JSON.stringify(url)};document.getElementById(${JSON.stringify(formId)}).requestSubmit()`);
      } else {
        await cdp.evaluate(page.sessionId, `document.getElementById('download').href=${JSON.stringify(url)};document.getElementById('download').click()`);
      }
      let result;
      try { result = await waitFor(getResult, `capture result ${product}/${name}`); }
      catch (error) {
        report.diagnostics = { requests: fixture.requests.slice(requestStart), downloads: await browserDownloads(), storage: await cdp.evaluate(popup.sessionId, 'chrome.storage.local.get(null)'), workerExceptions: report.workerExceptions };
        console.error(JSON.stringify(report.diagnostics));
        throw error;
      }
      console.log(`${product}/${name}: ${JSON.stringify(result)}`);
      if (result.captured !== capture) {
        report.diagnostics = { requests: fixture.requests.slice(requestStart).filter(value => value.path === path), preparations };
        console.error(JSON.stringify(report.diagnostics));
      }
      assert.equal(result.captured, capture, `${product}/${name}: ${JSON.stringify(result)}`);
      let original;
      try {
        original = await waitFor(async () => (await browserDownloads()).find(value => value.url === url && value.state !== 'in_progress'), `browser completion/cancellation ${name}`, 60000);
      } catch (error) {
        report.diagnostics = { requests: fixture.requests.slice(requestStart).filter(value => value.path === path), downloads: await browserDownloads(), preparations };
        console.error(JSON.stringify(report.diagnostics));
        throw error;
      }
      const entry = { name, capture, result, browser: { state: original.state, error: original.error || null, bytesReceived: original.bytesReceived, totalBytes: original.totalBytes } };
      if (capture) {
        const browserPost = ['export','rawexport','multipart'].includes(kind);
        assert.equal(original.state, browserPost ? 'complete' : 'interrupted');
        if (!browserPost) assert.equal(original.error, 'USER_CANCELED');
        const job = await waitFor(() => manager.list().find(value => value.url === url && ['complete', 'error'].includes(value.status)), `SAHM file ${name}`);
        assert.equal(job.status, 'complete', job.error || 'Download failed');
        assert.deepEqual(await readFile(job.path), payload);
        if (browserPost) { assert.equal(job.path, original.filename); assert.equal(job.replayPolicy, 'browser-completed'); }
        entry.sahm = { status: job.status, bytes: job.received, sha256: payloadSha256, replayPolicy: job.replayPolicy, browserFileReused: browserPost ? job.path === original.filename : undefined };
        assert.equal(manager.list().length, beforeJobs + 1);
      } else {
        assert.equal(original.state, 'complete');
        assert.deepEqual(await readFile(original.filename), payload);
        entry.browser.sha256 = payloadSha256;
        assert.equal(manager.list().length, beforeJobs);
      }
      const requests = fixture.requests.slice(requestStart).filter(value => value.path === path);
      if (expectedRequests !== undefined) assert.equal(requests.length, expectedRequests, `${name} replay count`);
      if (['export', 'rawexport', 'multipart'].includes(kind)) {
        assert.equal(requests.filter(value => value.operationExecuted).length, 1, name + ' must execute exactly one fixture server operation');
        assert.equal(requests.at(-1).operationCount, 1);
        entry.serverOperations = 1;
      }
      if (kind === 'export') {
        assert.ok(requests.every(value => value.method === 'POST' && value.sessionValid && value.authorized));
        assert.ok(requests.every(value => value.formValid && value.bodyLength === Buffer.byteLength(formBody)));
        entry.formBodyByteIdentical = requests.every(value => value.bodySha256 === requests[0].bodySha256);
      }
      if (kind === 'rawexport') {
        const expectedHash = createHash('sha256').update(rawFormBody).digest('hex');
        assert.ok(requests.every(value => value.method === 'POST' && value.sessionValid && value.authorized && value.bodySha256 === expectedHash));
        entry.rawBodyByteIdentical = true;
      }
      if (appUnavailable) assert.ok(['app-unavailable', 'not-acknowledged'].includes(result.reason));
      entry.serverRequests = requests;
      report.cases.push(entry);
      if (name === 'post-raw') {
        await cdp.send('Page.reload', {}, popup.sessionId);
        await waitFor(() => cdp.evaluate(popup.sessionId, 'document.getElementById("connection")?.textContent === "متصل بتطبيق سَهم."'), 'connected extension popup');
        await screenshot('extension-connected.png', popup.sessionId);
      }
    }

    await exercise('public-get', 'public', { capture: true });
    await cdp.send('Page.navigate', { url: fixture.origin + '/login' }, page.sessionId);
    await waitFor(() => cdp.evaluate(page.sessionId, 'Boolean(document.getElementById("post"))'), 'logged-in fixture');
    await exercise('session-opt-out', 'session', { capture: false, expectedRequests: 1 });
    if (!baseline) {
      await exercise('session-get', 'session', { capture: true, settings: { allowSession: true }, expectedRequests: 2 });
      await exercise('post-opt-out', 'export', { capture: false, settings: { allowSession: true }, expectedRequests: 1 });
      await exercise('post-form', 'export', { capture: true, settings: { allowSession: true, allowPost: true }, expectedRequests: 1 });
      await exercise('post-raw', 'rawexport', { capture: true, settings: { allowSession: true, allowPost: true }, expectedRequests: 1 });
      await exercise('multipart-original', 'multipart', { capture: true, settings: { allowSession: true, allowPost: true }, expectedRequests: 1 });
      masterEnabled = false;
      await exercise('app-policy-off', 'session', { capture: false, settings: { allowSession: true, allowPost: true }, expectedRequests: 1 });
      await exercise('post-app-policy-off', 'export', { capture: false, settings: { allowSession: true, allowPost: true }, expectedRequests: 1 });
      masterEnabled = true;
    }
    await bridge.close(); bridge = null;
    if (!baseline) {
      await exercise('post-app-unavailable', 'export', { capture: false, settings: { allowSession: true, allowPost: true }, expectedRequests: 1, appUnavailable: true });
      const pending = await cdp.evaluate(popup.sessionId, 'chrome.storage.local.get("completedPostDownloads")');
      assert.equal(pending.completedPostDownloads.entries.length, 1);
      const beforeRecovery = manager.list().length;
      bridge = await openBridge();
      const oldWorkerId = report.worker.targetId;
      const incarnation = 'sahm-worker-' + product + '-' + Date.now();
      await cdp.evaluate(workerSession, 'globalThis.__sahmTestIncarnation=' + JSON.stringify(incarnation));
      await cdp.send('Target.detachFromTarget', { sessionId: workerSession });
      await cdp.send('ServiceWorker.enable', {}, page.sessionId);
      await cdp.send('ServiceWorker.stopAllWorkers', {}, page.sessionId);
      // An actual extension alarm wakes its stopped worker. Unpacked test scheduling is accelerated.
      await cdp.evaluate(popup.sessionId, 'chrome.alarms.create("sahm-completed-post",{when:Date.now()+1000})');
      const recovered = await waitFor(() => manager.list().find(job => job.url === fixture.origin + '/export/' + product + '-post-app-unavailable.txt'), 'completed POST recovery after worker stop', 45000);
      assert.equal(recovered.status, 'complete'); assert.equal(manager.list().length, beforeRecovery + 1);
      assert.deepEqual(await readFile(recovered.path), payload);
      assert.equal(fixture.requests.slice(requestStart).filter(value => value.path === '/export/' + product + '-post-app-unavailable.txt').length, 1);
      await waitFor(async () => (await cdp.evaluate(popup.sessionId, 'chrome.storage.local.get("completedPostDownloads")')).completedPostDownloads.entries.length === 0, 'durable recovery ACK');
      await waitFor(async () => {
        const status = await getResult();
        return status?.captured === true && status.reason === 'browser-completed';
      }, 'recovery status committed before the next independent download');
      const newWorker = await waitFor(async () => (await cdp.send('Target.getTargets')).targetInfos.find(value => value.type === 'service_worker' && value.url === 'chrome-extension://' + EXTENSION_ID + '/background.mjs'), 'restarted worker');
      const newWorkerSession = await cdp.attach(newWorker.targetId);
      const marker = await cdp.evaluate(newWorkerSession, 'globalThis.__sahmTestIncarnation ?? null');
      assert.equal(marker, null, 'The recovered worker must have a new global context');
      report.postRecovery = { passed: true, workerRestartVerified: true, actualAlarm: true, testAlarmAccelerated: true, workerStopped: true, oldWorkerId, newWorkerId: newWorker.targetId, serverPostCount: 1, sha256: payloadSha256 };
      await bridge.close(); bridge = null;
    }
    await cdp.send('Network.clearBrowserCookies', {}, page.sessionId);
    await exercise('app-unavailable', 'public', { capture: false, expectedRequests: 1, appUnavailable: true });
    const persisted = await readFile(join(dataDirectory, 'jobs.json'), 'utf8');
    const receiptStore = await readFile(join(dataDirectory, 'browser-integration', 'receipts.json'), 'utf8');
    const extensionStorage = await cdp.evaluate(popup.sessionId, 'chrome.storage.local.get(null)');
    for (const text of [persisted, receiptStore, JSON.stringify(extensionStorage)]) {
      assert.ok(!text.includes(fixtureCookie), 'Credentials must not persist in app metadata or extension local settings');
      assert.ok(!text.includes('artificial-local-test-only'), 'Session token must not persist in app metadata or extension local settings');
      assert.ok(!text.includes('artificial-csrf'), 'POST body must not persist in metadata');
      assert.ok(!text.includes(Buffer.from(formBody).toString('base64')), 'Encoded POST body must not persist in metadata');
    }
    report.noCredentialPersistence = true;
    report.requests = fixture.requests.slice(requestStart);
    assert.equal(report.workerExceptions.length, 0, JSON.stringify(report.workerExceptions));
    await cdp.send('Page.reload', {}, popup.sessionId);
    await screenshot('extension-popup.png', popup.sessionId);
    report.passed = true;
    console.log(`PASS ${report.version.product}: ${report.cases.length} actual browser cases`);
  } finally {
    if (cdp) await cdp.close();
    if (bridge) await bridge.close();
    await manager.close();
    await removeAlias();
  }
}

try {
  fixture = await startFixture();
  const extensionDirectory = await makeExtension();
  const browsers = [
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ].filter(([product]) => !selected || product === selected);
  for (const [product, binary] of browsers) await testBrowser(product, binary, extensionDirectory);
} catch (error) {
  summary.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  if (fixture) await fixture.close();
  await removeAlias();
  const productionAfter = await Promise.all(vendors.map(vendor => registryRead(registryKey(vendor, HOST_NAME))));
  summary.productionRegistryUnchanged = JSON.stringify(productionBefore) === JSON.stringify(productionAfter);
  summary.aliasRegistryRemoved = (await Promise.all(aliasKeys.map(registryRead))).every(value => value === null);
  await writeFile(join(directory, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`Evidence: ${join(directory, 'results.json')}`);
  assert.equal(summary.productionRegistryUnchanged, true, 'Production native host registry unchanged');
  assert.equal(summary.aliasRegistryRemoved, true, 'Temporary native host alias removed');
}
