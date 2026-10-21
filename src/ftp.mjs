import { spawn } from 'node:child_process';
import { open, readFile, mkdir, rename, link, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { replaceCheckpoint } from './checkpoint.mjs';
import { proxyAuthentication } from './enterprise-auth.mjs';
import { withServerTransfer, limitedRate, transferSpeedLimit } from './server-rules.mjs';

const invalidControl = /[\x00-\x1f\x7f]/;
const curlExecutable = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';
const curlErrors = new Map([
  [5, 'FTP proxy could not be resolved'], [6, 'FTP server could not be resolved'],
  [7, 'FTP connection failed'], [9, 'FTP access denied'],
  [18, 'FTP server returned an incomplete file'], [19, 'FTP file is unavailable'],
  [28, 'FTP connection timed out'], [31, 'FTP server refused resume'],
  [33, 'FTP server refused resume'], [35, 'FTPS TLS handshake failed'],
  [60, 'FTPS certificate verification failed'], [67, 'FTP login failed'],
  [78, 'FTP file was not found'], [97, 'FTP proxy connection failed'],
]);
const transientCurlCodes = new Set([5, 6, 7, 18, 28, 52, 55, 56]);
const transientFtpStatuses = new Set([421, 425, 426, 450, 451]);
const transientProxyStatuses = new Set([408, 500, 502, 503, 504]);

function checkedText(value, label, maximum) {
  if (typeof value !== 'string' || value.length > maximum || invalidControl.test(value)) throw new Error(`Invalid FTP ${label}`);
  return value;
}

export function normalizeFtpCredentials(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid FTP credentials');
  const username = checkedText(value.username ?? 'anonymous', 'username', 1024);
  const password = checkedText(value.password ?? 'sahm@example.invalid', 'password', 4096);
  if (!username || username.includes(':')) throw new Error('Invalid FTP username');
  return { username, password };
}

export function parseFtpInput(input) {
  checkedText(input, 'URL', 8192);
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid FTP URL'); }
  if (!['ftp:', 'ftps:'].includes(url.protocol) || !url.hostname) throw new Error('Only FTP and FTPS URLs are supported');
  let path, username, password;
  try { path = decodeURIComponent(url.pathname); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error('Invalid FTP URL encoding'); }
  if (invalidControl.test(path) || !path || path.endsWith('/') || /;type=/i.test(path) || url.search || url.hash) throw new Error('FTP URL must identify a binary file');
  const credentials = username || password ? normalizeFtpCredentials({ username, password }) : undefined;
  url.username = ''; url.password = '';
  return { url: url.href, credentials };
}

export function normalizeFtpUrl(input) {
  const parsed = parseFtpInput(input);
  if (parsed.credentials) throw new Error('FTP credentials must be supplied separately');
  return parsed.url;
}

// Config is fed on stdin: authentication never appears in process arguments or
// temporary config files. Disable curlrc and ambient proxy variables explicitly.
function option(name, value) {
  return value === undefined ? name : `${name} = "${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function proxyOptions(network) {
  if (!network || network.mode === 'direct') return [option('proxy', ''), option('noproxy', '*')];
  if (!['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(network.mode)) throw new Error('Unsupported FTP proxy mode');
  const host = checkedText(network.host, 'proxy host', 253);
  if (!host || /[\s/@?#\\]/.test(host) || !Number.isInteger(network.port) || network.port < 1 || network.port > 65535) throw new Error('Invalid FTP proxy');
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const result = [option('proxy', `${network.mode}://${authority}:${network.port}`), option('noproxy', '')];
  if (['http', 'https'].includes(network.mode)) result.push('proxytunnel', 'suppress-connect-headers');
  if (network.username || network.password) {
    const username = checkedText(network.username || '', 'proxy username', 1024);
    const password = checkedText(network.password || '', 'proxy password', 4096);
    if (username.includes(':')) throw new Error('Invalid FTP proxy username');
    result.push(option('proxy-user', `${username}:${password}`));
    if (['http', 'https'].includes(network.mode)) result.push('proxy-basic');
  }
  return result;
}

async function routedOptions(url, options, signal) {
  if (!options.network) return { options, before: await metadata(url, options, signal) };
  if (typeof options.network.routesFor !== 'function' || typeof options.network.credentialsFor !== 'function') throw new Error('Invalid FTP network configuration');
  const routes = await options.network.routesFor(url);
  if (!Array.isArray(routes) || !routes.length || routes.length > 16) throw new Error('No FTP proxy route is available');
  let failure;
  for (const route of routes) {
    signal.throwIfAborted();
    const policy = options.network.snapshot ? proxyAuthentication(route, options.network.snapshot()) : null;
    if (policy) {
      if (typeof options.network.externalProxy !== 'function') throw new Error('Windows FTP proxy authentication is unavailable');
      // curl's SSPI support does not guarantee that NTLM is compiled in. Use
      // the same pinned-route SSPI CONNECT path as the other download engines.
      // FTP accounts for payload itself; its local gateway must stay unmetered.
      const gateway = new URL(await options.network.externalProxy({ quota: null, route }));
      if (gateway.protocol !== 'http:' || gateway.hostname !== '127.0.0.1' || !gateway.port || !gateway.username || !gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) throw new Error('Invalid local FTP proxy gateway');
      const routed = { ...options, network: { mode: 'http', host: gateway.hostname, port: Number(gateway.port), username: decodeURIComponent(gateway.username), password: decodeURIComponent(gateway.password) } };
      // Once Windows authentication has been attempted, do not turn an auth
      // rejection into an implicit attempt through another PAC route.
      return { options: routed, before: await metadata(url, routed, signal) };
    }
    const credentials = route.type === 'direct' ? {} : await options.network.credentialsFor(route);
    const mode = route.type === 'socks4' ? 'socks4a' : route.type === 'socks5' ? 'socks5h' : route.type;
    const routed = { ...options, network: { ...route, ...credentials, mode } };
    try { return { options: routed, before: await metadata(url, routed, signal) }; }
    catch (error) { if (signal.aborted) throw error; failure = error; }
  }
  throw failure;
}

function transferConfig(url, { credentials, network, tlsMode = 'auto', caFile }, extra = []) {
  if (!['auto', 'none', 'explicit', 'implicit'].includes(tlsMode)) throw new Error('Invalid FTP TLS mode');
  if (tlsMode === 'implicit' && !url.startsWith('ftps:')) throw new Error('Implicit FTPS requires an ftps:// URL');
  if (url.startsWith('ftps:') && !['auto', 'implicit'].includes(tlsMode)) throw new Error('An ftps:// URL requires implicit TLS');
  const login = normalizeFtpCredentials(credentials);
  const config = [
    'silent', 'globoff', option('proto', '=ftp,ftps'), option('proto-redir', '=ftp,ftps'),
    option('url', url), option('user', `${login.username}:${login.password}`),
    'ftp-skip-pasv-ip', 'ftp-pasv', option('ftp-method', 'nocwd'), option('connect-timeout', '20'),
    option('speed-limit', '1'), option('speed-time', '30'), ...proxyOptions(network),
    option('write-out', '%{stderr}SAHM_FTP_STATUS:%{response_code}:%{http_connect}'),
  ];
  if (tlsMode === 'explicit' || url.startsWith('ftps:')) config.push('ssl-reqd', option('tlsv1.2'));
  if (caFile !== undefined) config.push(option('cacert', checkedText(caFile, 'CA path', 8192)));
  return [...config, ...extra, ''].join('\n');
}

function curlError(code, diagnostic) {
  const error = new Error(curlErrors.get(code) || `FTP transfer failed (curl ${code})`);
  error.code = 'ftp-transfer-failed';
  error.curlCode = code;
  const status = /SAHM_FTP_STATUS:(\d{3}):(\d{3})\s*$/.exec(diagnostic);
  error.ftpStatus = Number(status?.[1] || 0);
  error.proxyStatus = Number(status?.[2] || 0);
  if (code === 67) error.code = 'ftp-auth-required';
  if (code === 60) error.code = 'ftp-certificate-invalid';
  const deniedFtp = error.ftpStatus >= 400 && !transientFtpStatuses.has(error.ftpStatus);
  const deniedProxy = error.proxyStatus >= 400 && !transientProxyStatuses.has(error.proxyStatus);
  if (error.code === 'ftp-transfer-failed' && !deniedFtp && !deniedProxy
    && (transientCurlCodes.has(code) || transientFtpStatuses.has(error.ftpStatus) || transientProxyStatuses.has(error.proxyStatus))) {
    error.cause = Object.assign(new Error('FTP network connection interrupted'), { code: 'ftp-network-error' });
  }
  return error;
}

function runCurl(config, signal) {
  signal.throwIfAborted();
  const child = spawn(curlExecutable, ['--disable', '--config', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CURL_HOME: '', CURL_CA_BUNDLE: '', SSL_CERT_FILE: '', SSL_CERT_DIR: '' } });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  // Only the fixed numeric completion marker is exposed. Keep a bounded tail
  // internally; server-controlled stderr never reaches logs or the renderer.
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-128); });
  child.stdin.on('error', () => {});
  child.stdin.end(config);
  const done = new Promise((resolveDone, reject) => {
    child.once('error', () => reject(new Error('Windows curl with FTP support is unavailable')));
    child.once('close', code => { if (signal.aborted) reject(signal.reason); else if (code !== 0) reject(curlError(code, diagnostic)); else resolveDone(); });
  }).finally(() => signal.removeEventListener('abort', abort));
  done.catch(() => {});
  return { body: child.stdout, done, stop: abort };
}

async function metadata(url, options, signal) {
  const transfer = runCurl(transferConfig(url, options, ['head', option('max-time', 30)]), signal);
  let output = '';
  try {
    for await (const chunk of transfer.body) {
      output += chunk.toString('utf8');
      if (output.length > 64 * 1024) throw new Error('Invalid FTP metadata');
    }
    await transfer.done;
  } catch (error) { transfer.stop(); await transfer.done.catch(() => {}); throw error; }
  const length = /^Content-Length:\s*(\d+)\s*$/im.exec(output);
  const modified = /^Last-Modified:\s*(.+)\s*$/im.exec(output)?.[1].trim() || null;
  const size = length ? Number(length[1]) : null;
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new Error('Invalid FTP file size');
  return { size, modified, ranged: /^Accept-ranges:\s*bytes\s*$/im.test(output) };
}

async function readState(manifest) {
  try { return JSON.parse(await readFile(manifest, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read FTP resume state'); }
}

async function preservePartial(partial, manifest) {
  const suffix = `.stale-${Date.now()}`;
  await rename(manifest, manifest + suffix);
  await rename(partial, partial + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

function canResume(saved, url, tls, scope, current) {
  return saved && saved.protocol === 'ftp' && saved.url === url && saved.tls === tls
    && saved.credentialScope === scope && current.ranged && current.modified && current.size !== null
    && saved.modified === current.modified && saved.size === current.size
    && Number.isSafeInteger(saved.received) && saved.received >= 0 && saved.received <= current.size;
}

async function openResumePartial(partial, received, size) {
  const file = await open(partial, 'r+');
  try {
    const actual = await file.stat();
    if (actual.size < received || actual.size > size) throw new Error('FTP partial file size changed');
    // A crash may leave writes after the last durable checkpoint. Re-fetch them.
    await file.truncate(received);
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function downloadFtp(input, destination, options = {}) {
  return withServerTransfer(async () => {
    const lease = await options.network?.acquireServerSlot?.(parseFtpInput(input).url, { signal: options.signal });
    try { return await downloadFtpFile(input, destination, options); }
    finally { lease?.release(); }
  });
}
async function downloadFtpFile(input, destination, {
  signal = new AbortController().signal, onProgress = () => {}, maxBytesPerSecond = 0,
  checkpointInterval = 1000, credentials, credentialScope, network, quota, tlsMode = 'auto', caFile,
} = {}) {
  const parsed = parseFtpInput(input);
  const url = parsed.url;
  await quota?.assertAvailable({ signal });
  let options = { credentials: credentials || parsed.credentials, network, tlsMode, caFile };
  if (credentialScope !== undefined && (typeof credentialScope !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(credentialScope))) throw new Error('Invalid FTP credential scope');
  // A random, non-secret ID belongs to the caller's credential record. Changing
  // accounts must not reuse a partial merely because SIZE and MDTM happen to match.
  const scope = options.credentials ? credentialScope || randomUUID() : 'anonymous';
  if (typeof maxBytesPerSecond !== 'function' && (!Number.isFinite(maxBytesPerSecond) || maxBytesPerSecond < 0)) throw new Error('Invalid speed limit');
  if (!Number.isFinite(checkpointInterval) || checkpointInterval < 50) throw new Error('Checkpoint interval must be at least 50ms');
  const target = resolve(destination), partial = target + '.part', manifest = target + '.ftp-resume.json';
  await mkdir(dirname(target), { recursive: true });
  const routed = await routedOptions(url, options, signal);
  options = routed.options;
  const before = routed.before;
  const saved = await readState(manifest);
  const tls = url.startsWith('ftps:') ? 'implicit' : tlsMode === 'explicit' ? 'explicit' : 'none';
  let file, state;
  if (canResume(saved, url, tls, scope, before)) {
    file = await openResumePartial(partial, saved.received, before.size);
    state = saved;
  } else {
    if (saved) await preservePartial(partial, manifest);
    file = await open(partial, 'wx+');
    state = { version: 1, protocol: 'ftp', url, tls, credentialScope: scope, size: before.size, modified: before.modified, received: 0 };
  }
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let saving = Promise.resolve(), failure, timer, transfer, nextSlot = Date.now();
  const persist = () => {
    const snapshot = JSON.stringify(state);
    saving = saving.then(async () => {
      await file.sync();
      const temporary = await open(manifest + '.tmp', 'w');
      try { await temporary.writeFile(snapshot); await temporary.sync(); } finally { await temporary.close(); }
      await replaceCheckpoint(manifest + '.tmp', manifest);
    });
    return saving;
  };
  try {
    await persist();
    timer = setInterval(() => { persist().catch(error => { failure ||= error; controller.abort(error); }); }, checkpointInterval);
    onProgress({ received: state.received, total: state.size, connections: 1 });
    if (state.size === null || state.received < state.size) {
      const extra = state.received ? [option('continue-at', state.received)] : [];
      transfer = runCurl(transferConfig(url, options, extra), combined);
      for await (const chunk of transfer.body) {
        combined.throwIfAborted();
        if (state.size !== null && state.received + chunk.length > state.size) throw new Error('FTP server sent excess bytes');
        const rate = limitedRate(typeof maxBytesPerSecond === 'function' ? maxBytesPerSecond() : maxBytesPerSecond, transferSpeedLimit());
        if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid speed limit');
        if (rate) { nextSlot = Math.max(nextSlot, Date.now()) + chunk.length * 1000 / rate; await delay(Math.ceil(nextSlot - Date.now()), undefined, { signal: combined }); }
        else nextSlot = Date.now();
        const allowed = quota ? await quota.consume(chunk.length, { signal: combined }) : chunk.length;
        let written = 0;
        while (written < allowed) {
          const result = await file.write(chunk, written, allowed - written, state.received);
          if (!result.bytesWritten) throw new Error('FTP file write made no progress');
          written += result.bytesWritten; state.received += result.bytesWritten;
        }
        onProgress({ received: state.received, total: state.size, connections: 1 });
        if (allowed < chunk.length) throw Object.assign(new Error('انتهت حصة التنزيل لهذه الفترة.'), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
      }
      await transfer.done;
    }
    combined.throwIfAborted();
    if (state.size !== null && state.received !== state.size) throw new Error('FTP server returned an incomplete file', {
      cause: Object.assign(new Error('FTP network connection interrupted'), { code: 'ftp-network-error' }),
    });
    const after = await metadata(url, options, combined);
    if (after.size !== before.size || after.modified !== before.modified) throw new Error('FTP file changed during transfer');
  } catch (error) { failure ||= error; controller.abort(error); transfer?.stop(); }
  finally {
    clearInterval(timer);
    if (transfer) await transfer.done.catch(() => {});
    await persist().catch(error => { failure ||= error; });
    await file.close();
  }
  if (failure) throw failure;
  // Exclusive hard-link promotion never replaces a user's existing file.
  await link(partial, target);
  await unlink(partial);
  await unlink(manifest);
  return { path: target, bytes: state.received };
}
