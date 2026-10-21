import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME, MessageDecoder, encodeMessage, httpUrl, validToken, validateRequest } from '../browser/protocol.mjs';
import { prepareDownload } from './download.mjs';
import { normalizeRequestContext, requestDownload } from './request-context.mjs';
import { transportFetch } from './transport.mjs';
import { MEDIA_QUALITIES } from '../browser/extension/media-policy.mjs';
import { publicMediaOptions } from '../browser/extension/media-selection.mjs';
import { TRUSTED_EXTENSION_ORIGINS, storeStatus } from '../browser/distribution.mjs';

const run = promisify(execFile);
const defaultBrowserDirectory = fileURLToPath(new URL('../browser/', import.meta.url));
const registryKeys = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];

async function writeJson(path, value) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

async function restrictDirectory(path) {
  if (process.platform !== 'win32') return chmod(path, 0o700);
  const { stdout } = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('تعذّر التحقق من حساب Windows لتأمين تكامل المتصفح.');
  await run('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
}

export function nativeLauncher(runtimePath, hostPath, configPath) {
  function batchPath(value) {
    if (/["\r\n]/.test(value)) throw new Error('Unsupported installation path');
    return value.replace(/%/g, '%%');
  }
  return `@echo off\r\nchcp 65001 >nul\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "NODE_OPTIONS="\r\n"${batchPath(resolve(runtimePath))}" "${batchPath(hostPath)}" --config "${batchPath(configPath)}" %*\r\n`;
}

export function nativeInstallationMatches(manifest, launcherText, { runtimePath, hostPath, configPath, launcherPath }) {
  return manifest?.name === HOST_NAME && manifest.type === 'stdio'
    && typeof manifest.path === 'string' && resolve(manifest.path).toLowerCase() === resolve(launcherPath).toLowerCase()
    && Array.isArray(manifest.allowed_origins) && manifest.allowed_origins.length === TRUSTED_EXTENSION_ORIGINS.length && manifest.allowed_origins.every((origin, index) => origin === TRUSTED_EXTENSION_ORIGINS[index])
    && launcherText === nativeLauncher(runtimePath, hostPath, configPath);
}

export async function preflightDownload(request, { fetchImpl = transportFetch, signal } = {}) {
  let response;
  try {
    response = await requestDownload(request.url, {
      fetchImpl,
      headers: { Range: 'bytes=0-0' },
      signal: signal || AbortSignal.timeout(5000),
    });
  } catch (error) {
    if (error.status) throw new Error('server-rejected');
    throw error;
  }
  try {
    httpUrl(response.url || request.url);
    if (![200, 206].includes(response.status)) throw new Error('server-rejected');
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const range = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') || '');
    const length = response.headers.get('content-length');
    const size = range ? Number(range[1]) : length === null ? null : Number(length);
    if (request.source === 'automatic') {
      if (request.mime && contentType !== request.mime) throw new Error('content-type-changed');
      if (request.totalBytes > 0 && size !== request.totalBytes) throw new Error('file-size-changed');
      if (response.status === 206 && !range) throw new Error('invalid-range-response');
    }
    return { mime: contentType, size };
  } finally { await response.body?.cancel(); }
}

export async function prepareBrowserDownload(request, { prepare = prepareDownload, signal } = {}) {
  if (request.method === 'POST') throw new Error('post-replay-disabled');
  const response = await prepare(request.url, { requestContext: request.requestContext, signal });
  try {
    httpUrl(response.url || request.url);
    if (response.status !== 200) throw new Error('server-rejected');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (request.mime && mime !== request.mime) throw new Error('content-type-changed');
    const encoding = response.headers.get('content-encoding');
    const length = response.headers.get('content-length');
    if ((!encoding || encoding === 'identity') && request.totalBytes > 0 && length !== null && Number(length) !== request.totalBytes) throw new Error('file-size-changed');
    return response;
  } catch (error) { await response.body?.cancel(); throw error; }
}

export async function prepareMediaDownload(request, { signal } = {}) {
  const response = await prepareDownload(request.url, { requestContext: request.requestContext, signal });
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || !(mime.startsWith('video/') || (mime === 'application/octet-stream' && /\.(?:mp4|webm|m4v|mov|ogv)$/i.test(new URL(request.url).pathname)))) {
    await response.body?.cancel();
    throw new Error('not-a-direct-video');
  }
  return response;
}

export async function startBrowserBridge({ dataDirectory, runtimePath = process.execPath, browserDirectory = import.meta.url.includes('/app.asar/') ? join(dirname(runtimePath), 'resources', 'browser') : defaultBrowserDirectory, onDownload, onBrowserComplete, onMediaInfo, onMediaDownload, canCapture = async () => true, preflight = preflightDownload, prepare = prepareBrowserDownload, prepareMedia = prepareMediaDownload } = {}) {
  if (typeof onDownload !== 'function' || typeof dataDirectory !== 'string') throw new Error('Browser bridge requires dataDirectory and onDownload');
  const directory = join(resolve(dataDirectory), 'browser-integration');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictDirectory(directory);
  const configPath = join(directory, 'connection.json');
  const manifestPath = join(directory, `${HOST_NAME}.json`);
  const receiptsPath = join(directory, 'receipts.json');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config) {
    const token = randomBytes(32).toString('hex');
    const identifier = createHash('sha256').update(directory).digest('hex').slice(0, 12);
    const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\sahm-${identifier}-${token.slice(0, 16)}` : join(directory, 'bridge.sock');
    config = { v: 1, token, pipeName };
    await writeJson(configPath, config);
  }
  if (config.v !== 1 || !/^[a-f0-9]{64}$/.test(config.token) || typeof config.pipeName !== 'string') throw new Error('Invalid browser bridge configuration');
  let receipts = [];
  try { receipts = JSON.parse(await readFile(receiptsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(receipts)) throw new Error('Invalid browser receipt store');
  const acknowledged = new Map(receipts.slice(-1000).map(receipt => [receipt.requestId, receipt]));
  const pending = new Map();
  const sockets = new Set();
  let running = false;
  let acceptedCount = 0;
  let lastContactAt = null;
  let lastCaptureAt = null;
  let lastError = null;
  let receiptWrites = Promise.resolve();
  const inspections = new Map();

  async function enqueue(request) {
    const urlHash = createHash('sha256').update(request.url).digest('hex');
    const identity = [request.url, request.method, request.requestContext || null];
    if (request.type === 'browser-complete') identity.push(request.browserFile);
    if (request.type === 'media-enqueue') {
      identity.push(request.kind, request.quality);
      if (request.container !== 'auto' || request.audioTrack !== 'default') identity.push(request.container, request.audioTrack);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const previous = acknowledged.get(request.requestId);
    if (previous) {
      if (previous.urlHash !== urlHash || (previous.fingerprint && previous.fingerprint !== fingerprint)) throw new Error('request-id-conflict');
      return { v: 1, requestId: request.requestId, ok: true, durable: true, jobId: previous.jobId, duplicate: true };
    }
    if (pending.has(request.requestId)) {
      const existing = pending.get(request.requestId);
      if (existing.fingerprint !== fingerprint) throw new Error('request-id-conflict');
      return existing.task;
    }
    const task = (async () => {
      const remaining = request.expiresAt - Date.now() - 250;
      if (remaining < 250) throw new Error('request-expired');
      if (request.requestContext) request.requestContext = normalizeRequestContext(request.requestContext);
      if (await canCapture(request) !== true) throw new Error('capture-disabled');
      if (Date.now() >= request.expiresAt - 100) throw new Error('request-expired');
      let preparedResponse;
      let transferred = false;
      let job;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(5000, remaining));
      try {
        try {
          if (request.type === 'browser-complete') {
            if (typeof onBrowserComplete !== 'function') throw new Error('browser-import-unavailable');
          } else if (request.type === 'media-enqueue' && request.kind === 'direct') preparedResponse = await prepareMedia(request, { signal: controller.signal });
          else if (request.type === 'media-enqueue' && ['youtube', 'stream'].includes(request.kind)) {
            if (typeof onMediaDownload !== 'function') throw new Error('media-unavailable');
          }
          else if (request.requestContext) preparedResponse = await prepare(request, { signal: controller.signal });
          else await preflight(request, { signal: controller.signal });
        } finally { clearTimeout(timer); }
        if (Date.now() >= request.expiresAt - 100) throw new Error('request-expired');
        // Session GET consumes its retained response. Completed POST uses its existing local file.
        // onDownload must resolve only after its queue entry has reached durable storage.
        if (request.type === 'browser-complete') {
          job = await onBrowserComplete({ url: request.url, browserFile: request.browserFile, browserRequestId: request.requestId, method: 'POST', usesCredentials: request.usesCredentials });
        } else if (request.type === 'media-enqueue' && ['youtube', 'stream'].includes(request.kind)) {
          job = await onMediaDownload({ url: request.url, quality: request.quality, container: request.container, audioTrack: request.audioTrack, title: request.title, browserRequestId: request.requestId, source: request.source });
        } else {
          let name = request.name || undefined;
          if (request.type === 'media-enqueue') {
            const mime = preparedResponse.headers.get('content-type') || '';
            const extension = /webm/i.test(mime) ? 'webm' : /ogg/i.test(mime) ? 'ogv' : /quicktime/i.test(mime) ? 'mov' : 'mp4';
            name = `${(request.title || 'فيديو').slice(0, 150)}.${extension}`;
          }
          job = await onDownload({ url: request.url, name, browserRequestId: request.requestId, source: request.source, requestContext: request.requestContext }, { preparedResponse });
        }
        if (!job || typeof job.id !== 'string' || !job.id) throw new Error('queue-not-acknowledged');
        transferred = true;
      } catch (error) {
        if (!transferred) await preparedResponse?.body?.cancel().catch(() => {});
        throw error;
      } finally { clearTimeout(timer); }
      const receipt = { requestId: request.requestId, jobId: job.id, urlHash, fingerprint, acceptedAt: new Date().toISOString() };
      acknowledged.set(request.requestId, receipt);
      while (acknowledged.size > 1000) acknowledged.delete(acknowledged.keys().next().value);
      receiptWrites = receiptWrites.catch(() => {}).then(() => writeJson(receiptsPath, [...acknowledged.values()]));
      await receiptWrites;
      acceptedCount++;
      lastCaptureAt = receipt.acceptedAt;
      lastError = null;
      return { v: 1, requestId: request.requestId, ok: true, durable: true, jobId: job.id };
    })();
    pending.set(request.requestId, { task, fingerprint });
    try { return await task; } finally { pending.delete(request.requestId); }
  }

  async function inspectMedia(request) {
    if (typeof onMediaInfo !== 'function' || await canCapture(request) !== true || inspections.size >= 2) throw new Error('media-unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 110000);
    const task = Promise.resolve().then(() => onMediaInfo(request, { signal: controller.signal }));
    inspections.set(task, controller);
    try {
      const info = await task;
      const qualities = Array.isArray(info?.qualities) ? info.qualities.filter(value => MEDIA_QUALITIES.includes(value)) : [];
      if (!qualities.length) throw new Error('no-media-formats');
      const mediaOptions = publicMediaOptions(info.mediaOptions);
      return { v: 1, requestId: request.requestId, ok: true, title: typeof info.title === 'string' ? info.title.slice(0, 400) : '', qualities, ...(mediaOptions ? { mediaOptions } : {}) };
    } finally { clearTimeout(timer); inspections.delete(task); }
  }

  const server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(12000, () => socket.destroy());
    let received = false;
    const decoder = new MessageDecoder(message => {
      if (received || !TRUSTED_EXTENSION_ORIGINS.includes(message.origin) || !validToken(message.token, config.token)) throw new Error('Unauthorized bridge request');
      received = true;
      const request = validateRequest(message);
      if (request.type === 'media-info') socket.setTimeout(120000);
      lastContactAt = new Date().toISOString();
      const response = request.type === 'ping'
        ? Promise.resolve({ v: 1, requestId: request.requestId, ok: true, app: 'Sahm', automaticPolicy: 'get-and-completed-browser-post', capabilities: { session: true, post: typeof onBrowserComplete === 'function', sessionStored: false, postReplay: 'never', postImport: 'completed-local-file' } })
        : request.type === 'media-info' ? inspectMedia(request) : enqueue(request);
      response.catch(error => {
        lastError = request.source === 'automatic' ? 'لم يُنقل التنزيل؛ يواصل المتصفح تنزيله.' : 'تعذّر إرسال الرابط إلى قائمة التنزيلات.';
        const mediaErrors = new Set(['unsupported-live', 'unsupported-encrypted', 'unsafe-media-manifest', 'media-auth-required']);
        const code = error.code === 'CAPTURE_DISABLED' || error.message === 'capture-disabled' ? 'capture-disabled'
          : request.type === 'media-info' && mediaErrors.has(error.code) ? error.code : (request.type === 'media-info' ? 'media-unavailable' : 'download-not-accepted');
        return { v: 1, requestId: request.requestId, ok: false, error: code };
      }).then(value => { if (!socket.destroyed) socket.end(encodeMessage(value)); });
    });
    socket.on('data', chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
    socket.on('end', () => { try { decoder.finish(); } catch { socket.destroy(); } });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(config.pipeName, () => { server.removeListener('error', reject); running = true; resolveListen(); });
  });
  server.on('error', () => { lastError = 'تعذّر الاتصال بإضافة المتصفح.'; });

  async function status() {
    const launcherPath = join(directory, 'sahm-native-host.cmd');
    const hostPath = join(browserDirectory, 'native-host.mjs');
    let currentInstallation = false;
    try {
      const [manifestText, launcherText] = await Promise.all([readFile(manifestPath, 'utf8'), readFile(launcherPath, 'utf8')]);
      const manifest = JSON.parse(manifestText);
      currentInstallation = nativeInstallationMatches(manifest, launcherText, { runtimePath, hostPath, configPath, launcherPath });
    } catch { /* A missing or outdated launcher requires explicit registration. */ }
    const registrations = await Promise.all(registryKeys.map(async key => {
      if (process.platform !== 'win32') return false;
      try {
        const { stdout } = await run('reg.exe', ['query', key, '/ve', '/reg:64'], { windowsHide: true });
        return stdout.toLowerCase().includes(manifestPath.toLowerCase());
      } catch { return false; }
    }));
    return {
      running,
      connected: running && lastContactAt !== null && Date.now() - Date.parse(lastContactAt) < 30000,
      lastContactAt,
      registered: currentInstallation && registrations.every(Boolean),
      chromeRegistered: currentInstallation && registrations[0],
      edgeRegistered: currentInstallation && registrations[1],
      needsReregister: registrations.some(Boolean) && !currentInstallation,
      extensionDirectory: join(browserDirectory, 'extension'),
      extensionId: EXTENSION_ID,
      stores: storeStatus(),
      hostName: HOST_NAME,
      acceptedCount,
      lastCaptureAt,
      lastError,
      requiresOpenApp: true,
    };
  }

  async function register() {
    if (process.platform !== 'win32') throw new Error('Browser registration is available on Windows');
    await stat(runtimePath);
    const hostPath = join(browserDirectory, 'native-host.mjs');
    await stat(hostPath);
    const launcherPath = join(directory, 'sahm-native-host.cmd');
    await writeFile(launcherPath, nativeLauncher(runtimePath, hostPath, configPath), 'utf8');
    await writeJson(manifestPath, { name: HOST_NAME, description: 'Sahm browser integration', path: launcherPath, type: 'stdio', allowed_origins: TRUSTED_EXTENSION_ORIGINS });
    for (const key of registryKeys) await run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'], { windowsHide: true });
    return status();
  }

  async function unregister() {
    if (process.platform !== 'win32') return status();
    for (const key of registryKeys) {
      try {
        const { stdout } = await run('reg.exe', ['query', key, '/ve', '/reg:64'], { windowsHide: true });
        if (stdout.toLowerCase().includes(manifestPath.toLowerCase())) await run('reg.exe', ['delete', key, '/f', '/reg:64'], { windowsHide: true });
      } catch (error) { if (error.code !== 1) throw error; }
    }
    return status();
  }

  async function close() {
    running = false;
    for (const controller of inspections.values()) controller.abort();
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...pending.values()].map(entry => entry.task).concat([...inspections.keys()]));
    await receiptWrites.catch(() => {});
    await new Promise(resolveClose => server.close(resolveClose));
  }

  return { status, register, unregister, close, extensionDirectory: join(browserDirectory, 'extension'), helpPath: join(browserDirectory, 'README.md') };
}
