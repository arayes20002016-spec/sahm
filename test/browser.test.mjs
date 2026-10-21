import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ID, EXTENSION_ORIGIN, MAX_MESSAGE_BYTES, MessageDecoder, encodeMessage, httpUrl, validateRequest } from '../browser/protocol.mjs';
import { sendToBridge } from '../browser/native-host.mjs';
import { DEFAULT_SETTINGS, captureDecision, handoffDownload } from '../browser/extension/capture-policy.mjs';
import { nativeInstallationMatches, nativeLauncher, preflightDownload, startBrowserBridge } from '../src/browser-bridge.mjs';

function request(overrides = {}) {
  return { v: 1, type: 'enqueue', requestId: 'download:42:2026-10-18T12:00:00.000Z', expiresAt: Date.now() + 8000, source: 'automatic', url: 'https://example.com/file.zip', name: 'file.zip', mime: 'application/zip', totalBytes: 1024, method: 'GET', requestObserved: true, usesCredentials: false, ...overrides };
}

const item = { id: 42, url: 'https://example.com/file.zip', finalUrl: 'https://example.com/file.zip', filename: 'C:\\Downloads\\file.zip', mime: 'application/zip', totalBytes: 1024, state: 'in_progress', danger: 'safe', startTime: '2026-10-18T12:00:00.000Z' };
function observed() { return { method: 'GET', usesCredentials: false, time: Date.now() }; }
const enabled = { ...DEFAULT_SETTINGS, enabled: true };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-browser-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('native framing handles partial headers, Unicode bodies and coalesced messages', () => {
  const values = [];
  const decoder = new MessageDecoder(value => values.push(value));
  const frames = Buffer.concat([encodeMessage({ name: 'سَهم' }), encodeMessage({ v: 1 })]);
  for (let i = 0; i < frames.length; i += 3) decoder.push(frames.subarray(i, i + 3));
  decoder.finish();
  assert.deepEqual(values, [{ name: 'سَهم' }, { v: 1 }]);
});

test('native framing rejects oversized, zero, malformed JSON, invalid UTF-8 and truncated frames', () => {
  for (const length of [0, MAX_MESSAGE_BYTES + 1, 0xffffffff]) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    assert.throws(() => new MessageDecoder(() => {}).push(header));
  }
  const invalidJson = Buffer.from([1, 0, 0, 0, 123]);
  const invalidUtf8 = Buffer.from([1, 0, 0, 0, 255]);
  assert.throws(() => new MessageDecoder(() => {}).push(invalidJson));
  assert.throws(() => new MessageDecoder(() => {}).push(invalidUtf8));
  const decoder = new MessageDecoder(() => {});
  decoder.push(Buffer.from([10, 0]));
  assert.throws(() => decoder.finish());
  assert.throws(() => encodeMessage({ text: 'x'.repeat(MAX_MESSAGE_BYTES) }));
});

test('stable public key produces only the allowed extension origin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../browser/extension/manifest.json', import.meta.url), 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  const id = [...hash].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  assert.equal(id, EXTENSION_ID);
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${id}/`);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'not_allowed');
});

test('upgrade registration requires the current runtime, host launcher and exact extension origin', () => {
  const paths = { runtimePath: resolve('SAHM-0.3/SAHM.exe'), hostPath: resolve('SAHM-0.3/resources/browser/native-host.mjs'), configPath: resolve('data/browser-integration/connection.json'), launcherPath: resolve('data/browser-integration/sahm-native-host.cmd') };
  const manifest = { name: 'com.sahm.downloader', type: 'stdio', path: paths.launcherPath, allowed_origins: [EXTENSION_ORIGIN] };
  const launcher = nativeLauncher(paths.runtimePath, paths.hostPath, paths.configPath);
  assert.equal(nativeInstallationMatches(manifest, launcher, paths), true);
  assert.equal(nativeInstallationMatches(manifest, nativeLauncher(resolve('SAHM-0.2/SAHM.exe'), resolve('SAHM-0.2/resources/browser/native-host.mjs'), paths.configPath), paths), false);
  assert.equal(nativeInstallationMatches({ ...manifest, allowed_origins: [EXTENSION_ORIGIN, 'chrome-extension://other/'] }, launcher, paths), false);
  assert.equal(nativeInstallationMatches({ ...manifest, path: resolve('other.cmd') }, launcher, paths), false);
});

test('request validation rejects credentials, non-HTTP URLs, expired and unsafe automatic requests', () => {
  for (const url of ['file:///c:/secret', 'blob:https://example.com/id', 'data:text/plain,test', 'javascript:alert(1)', 'https://user:pass@example.com/a']) assert.throws(() => httpUrl(url));
  for (const overrides of [{ expiresAt: Date.now() - 1 }, { method: 'POST' }, { usesCredentials: true }, { requestObserved: false }, { source: 'unknown' }, { requestId: '../../bad' }]) assert.throws(() => validateRequest(request(overrides)));
  assert.equal(validateRequest(request()).url, 'https://example.com/file.zip');
});

test('automatic capture keeps disabled, bypassed, unsafe, authenticated, POST and excluded downloads in browser', () => {
  assert.equal(captureDecision(item, DEFAULT_SETTINGS, observed()), 'disabled');
  assert.equal(captureDecision(item, { ...enabled, bypassNext: true }, observed()), 'bypass');
  assert.equal(captureDecision(item, { ...enabled, excludedDomains: ['example.com'] }, observed()), 'excluded-domain');
  for (const changed of [{ danger: 'uncommon' }, { incognito: true }, { byExtensionId: 'another-extension' }]) assert.notEqual(captureDecision({ ...item, ...changed }, enabled, observed()), 'capture');
  for (const change of [{ method: 'POST' }, { usesCredentials: true }, { usesCredentials: null }, { time: Date.now() - 61000 }]) assert.equal(captureDecision(item, enabled, { ...observed(), ...change }), 'unsupported-request');
  assert.equal(captureDecision(item, enabled, undefined), 'unsupported-request');
  assert.equal(captureDecision(item, enabled, observed()), 'capture');
});

test('browser cancellation requires exact request id, durable ACK and queue job id', async () => {
  let cancellations = 0;
  const options = { settings: enabled, observed: observed(), cancel: async () => cancellations++ };
  for (const response of [{ ok: true }, { v: 1, ok: true, durable: false }, { v: 1, ok: true, durable: true, requestId: 'wrong', jobId: 'job' }]) {
    await handoffDownload(item, { ...options, send: async () => response });
    assert.equal(cancellations, 0);
  }
  const result = await handoffDownload(item, { ...options, send: async message => ({ v: 1, ok: true, durable: true, requestId: message.requestId, jobId: 'saved-job' }) });
  assert.equal(cancellations, 1);
  assert.deepEqual(result, { captured: true, jobId: 'saved-job' });
});

test('host and transport errors preserve original browser download', async () => {
  let cancellations = 0;
  const result = await handoffDownload(item, { settings: enabled, observed: observed(), send: async () => { throw new Error('Host disconnected'); }, cancel: async () => cancellations++ });
  assert.equal(cancellations, 0);
  assert.equal(result.captured, false);
  const cancelFailure = await handoffDownload(item, { settings: enabled, observed: observed(), send: async message => ({ v: 1, ok: true, durable: true, requestId: message.requestId, jobId: 'job' }), cancel: async () => { throw new Error('Browser refused'); } });
  assert.equal(cancelFailure.reason, 'browser-kept-original');
});

test('preflight checks real public GET, browser MIME and file length before transfer', async t => {
  const server = createServer((req, response) => {
    if (req.url === '/denied') return response.writeHead(403).end();
    const mime = req.url === '/login' ? 'text/html' : 'application/zip';
    response.writeHead(206, { 'Content-Type': mime, 'Content-Length': '1', 'Content-Range': 'bytes 0-0/1024' });
    response.end('a');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await preflightDownload(request({ url: `${base}/file` }))).size, 1024);
  await assert.rejects(preflightDownload(request({ url: `${base}/denied` })), /server-rejected/);
  await assert.rejects(preflightDownload(request({ url: `${base}/login` })), /content-type-changed/);
  await assert.rejects(preflightDownload(request({ url: `${base}/file`, totalBytes: 2048 })), /file-size-changed/);
});

test('authenticated bridge waits for durable enqueue and deduplicates concurrent and restarted requests', async t => {
  const directory = await temporaryDirectory(t);
  let releaseSave;
  const saveGate = new Promise(resolveSave => { releaseSave = resolveSave; });
  let adds = 0;
  const bridge = await startBrowserBridge({ dataDirectory: directory, preflight: async () => {}, onDownload: async data => {
    adds++;
    await saveGate;
    await writeFile(join(directory, 'durable-queue.json'), JSON.stringify({ id: 'job-42', url: data.url, browserRequestId: data.browserRequestId }));
    return { id: 'job-42' };
  } });
  let activeBridge = bridge;
  t.after(() => activeBridge.close());
  const config = JSON.parse(await readFile(join(directory, 'browser-integration', 'connection.json'), 'utf8'));
  let resolved = false;
  const message = request();
  const first = sendToBridge(config, message).then(value => { resolved = true; return value; });
  const second = sendToBridge(config, message);
  await new Promise(resolveWait => setTimeout(resolveWait, 40));
  assert.equal(resolved, false);
  assert.equal(adds, 1);
  releaseSave();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.durable, true);
  assert.equal(a.jobId, 'job-42');
  assert.equal(b.jobId, a.jobId);
  assert.equal(adds, 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'durable-queue.json'), 'utf8')).id, a.jobId);
  await bridge.close();
  activeBridge = await startBrowserBridge({ dataDirectory: directory, preflight: async () => {}, onDownload: async () => { throw new Error('Should not add duplicate'); } });
  assert.equal((await sendToBridge(config, message)).duplicate, true);
  assert.equal((await sendToBridge(config, { ...message, url: 'https://example.com/different-file.zip' })).ok, false);
});

test('bridge refuses wrong credentials, preflight failures and non-durable enqueue', async t => {
  const directory = await temporaryDirectory(t);
  let adds = 0;
  let refuseProbe = true;
  const bridge = await startBrowserBridge({ dataDirectory: directory, preflight: async () => { if (refuseProbe) throw new Error('Protected file'); }, onDownload: async () => { adds++; throw new Error('Storage is full'); } });
  t.after(() => bridge.close());
  const config = JSON.parse(await readFile(join(directory, 'browser-integration', 'connection.json'), 'utf8'));
  await assert.rejects(sendToBridge({ ...config, token: '0'.repeat(64) }, request()));
  assert.equal((await sendToBridge(config, request())).ok, false);
  assert.equal(adds, 0);
  refuseProbe = false;
  assert.equal((await sendToBridge(config, request())).ok, false);
  assert.equal(adds, 1);
});

test('actual native host process exchanges binary frames with bridge and checks caller origin', async t => {
  const directory = await temporaryDirectory(t);
  const bridge = await startBrowserBridge({ dataDirectory: directory, onDownload: async () => ({ id: 'unused' }) });
  t.after(() => bridge.close());
  async function runHost(origin) {
    const host = spawn(process.execPath, ['browser/native-host.mjs', '--config', join(directory, 'browser-integration', 'connection.json'), origin], { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true });
    const frames = [];
    const decoder = new MessageDecoder(value => frames.push(value));
    host.stdout.on('data', chunk => decoder.push(chunk));
    let stderr = '';
    host.stderr.on('data', chunk => { stderr += chunk; });
    host.stdin.on('error', () => {});
    host.stdin.end(encodeMessage({ v: 1, type: 'ping', requestId: 'ping:test' }));
    const exit = await new Promise((resolveExit, reject) => { host.once('error', reject); host.once('exit', resolveExit); });
    return { exit, frames, stderr };
  }
  const valid = await runHost(EXTENSION_ORIGIN);
  assert.equal(valid.exit, 0, valid.stderr);
  assert.equal(valid.frames[0].app, 'Sahm');
  assert.equal((await bridge.status()).connected, true);
  const invalid = await runHost('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/');
  assert.equal(invalid.exit, 1);
  assert.equal(invalid.frames.length, 0);
  assert.equal(invalid.stderr, '');
});

test('bundled Electron native launcher needs no Node installation and preserves binary stdio', { skip: process.platform !== 'win32' }, async t => {
  const rootDirectory = await temporaryDirectory(t);
  const directory = join(rootDirectory, 'تكامل المتصفح ! 100% &()');
  const bridge = await startBrowserBridge({ dataDirectory: directory, onDownload: async () => ({ id: 'unused' }) });
  t.after(() => bridge.close());
  const launcher = join(directory, 'sahm-native-host.cmd');
  const runtime = createRequire(import.meta.url)('electron');
  const hostPath = fileURLToPath(new URL('../browser/native-host.mjs', import.meta.url));
  await writeFile(launcher, nativeLauncher(runtime, hostPath, join(directory, 'browser-integration', 'connection.json')));
  const host = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${EXTENSION_ORIGIN}"`], { windowsHide: true, windowsVerbatimArguments: true });
  const frames = [];
  const decoder = new MessageDecoder(value => frames.push(value));
  host.stdout.on('data', chunk => decoder.push(chunk));
  let stderr = '';
  host.stderr.on('data', chunk => { stderr += chunk; });
  host.stdin.on('error', () => {});
  host.stdin.end(encodeMessage({ v: 1, type: 'ping', requestId: 'ping:electron-runtime' }));
  const exit = await new Promise((resolveExit, reject) => { host.once('error', reject); host.once('exit', resolveExit); });
  assert.equal(exit, 0, stderr);
  assert.equal(frames[0].requestId, 'ping:electron-runtime');
  assert.equal(frames[0].ok, true);
});

test('MV3 event handlers release filename callback once, transfer public GET and retain authenticated POST', async t => {
  function event() {
    const listeners = [];
    return { listeners, addListener: listener => listeners.push(listener) };
  }
  const state = { ...DEFAULT_SETTINGS, enabled: true };
  const cancelled = [];
  const sent = [];
  const chrome = {
    storage: { local: {
      get: async defaults => ({ ...defaults, ...state }),
      set: async update => Object.assign(state, update),
    } },
    runtime: { onInstalled: event(), onMessage: event(), connectNative: () => {
      const onMessage = event();
      return { onMessage, onDisconnect: event(), disconnect: () => {}, postMessage: message => {
        sent.push(message);
        queueMicrotask(() => onMessage.listeners.forEach(listener => listener({ v: 1, requestId: message.requestId, ok: true, durable: true, jobId: 'saved-job' })));
      } };
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    downloads: { onDeterminingFilename: event(), cancel: async id => cancelled.push(id) },
    webRequest: { onBeforeRequest: event(), onBeforeSendHeaders: event(), onHeadersReceived: event() },
    contextMenus: { onClicked: event() },
  };
  const original = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => { if (original === undefined) delete globalThis.chrome; else globalThis.chrome = original; });
  await import(`../browser/extension/background.mjs?test=${Date.now()}`);
  const beforeRequest = chrome.webRequest.onBeforeRequest.listeners[0];
  const beforeHeaders = chrome.webRequest.onBeforeSendHeaders.listeners[0];
  const determineFilename = chrome.downloads.onDeterminingFilename.listeners[0];
  async function downloadWithHeaders(id, method, requestHeaders) {
    const url = `https://example.com/test-${id}.zip`;
    const details = { url, method, requestId: `web:${id}` };
    beforeRequest(details);
    beforeHeaders({ ...details, requestHeaders });
    let suggestions = 0;
    await new Promise(resolveSuggestion => {
      assert.equal(determineFilename({ ...item, id, url, finalUrl: url }, () => { suggestions++; resolveSuggestion(); }), true);
    });
    assert.equal(suggestions, 1);
  }
  await downloadWithHeaders(1, 'GET', []);
  await downloadWithHeaders(2, 'GET', [{ name: 'Cookie', value: 'private-session-value' }]);
  await downloadWithHeaders(3, 'POST', []);
  state.bypassNext = true;
  await downloadWithHeaders(4, 'GET', []);
  assert.deepEqual(cancelled, [1]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'GET');
  assert.equal(JSON.stringify(sent).includes('private-session-value'), false);
  assert.equal(state.bypassNext, false);
});
