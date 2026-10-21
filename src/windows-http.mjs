import { spawn as spawnProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { Readable } from 'node:stream';

const maxBodyBytes = 8 * 1024 * 1024;
const maxHeaderBytes = 32768;
const blockedHeaders = new Set(['host', 'connection', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'content-length']);
const nativeErrors = new Set(['invalid-request', 'unsupported-route', 'certificate-invalid', 'body-too-large', 'headers-timeout', 'request-failed', 'headers-too-large', 'bootstrap-failed']);
const bootstrap = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Net.Http,System.Web.Extensions -ErrorAction Stop
  exit ([Sahm.WindowsHttp]::Run())
} catch {
  [Console]::Out.WriteLine('{"error":"bootstrap-failed"}')
  exit 3
}
`;
let bundledSource;

function failure(code) { return Object.assign(new Error('تعذّر إكمال طلب HTTP باستخدام اتصال Windows الآمن.'), { code: `windows-http-${code}` }); }
function aborted(signal) { return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('أُلغي طلب HTTP.'), { name: 'AbortError', code: 'ABORT_ERR' }); }

function auth(value, allowBasic = false) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || !['ntlm', 'negotiate', ...(allowBasic ? ['basic'] : [])].includes(value.scheme) || typeof value.currentAccount !== 'boolean' || value.scheme === 'basic' && value.currentAccount) throw failure('invalid-auth');
  const checked = { scheme: { ntlm: 'NTLM', negotiate: 'Negotiate', basic: 'Basic' }[value.scheme], currentAccount: value.currentAccount };
  if (value.currentAccount) {
    if (value.credentials != null) throw failure('invalid-auth');
  } else {
    const saved = value.credentials;
    if (!saved || typeof saved.username !== 'string' || !saved.username || saved.username.length > 512 || typeof saved.password !== 'string' || saved.password.length > 4096 || /[\x00-\x1f\x7f]/.test(saved.username + saved.password)) throw failure('invalid-auth');
    checked.credentials = { username: saved.username, password: saved.password };
  }
  return checked;
}

function route(value) {
  if (value == null || value.type === 'direct') return { type: 'direct' };
  if (value.type !== 'http') throw failure('unsupported-route');
  if (typeof value.host !== 'string' || !value.host || value.host.length > 253 || /[\s/@\\\x00-\x1f\x7f]/.test(value.host) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw failure('invalid-route');
  let address;
  try { address = new URL(`http://${value.host.includes(':') && !value.host.startsWith('[') ? `[${value.host}]` : value.host}:${value.port}/`); }
  catch { throw failure('invalid-route'); }
  return { type: 'http', url: address.href };
}

async function bodyBytes(value, signal) {
  if (value == null) return null;
  if (signal?.aborted) throw aborted(signal);
  let bytes;
  if (typeof value === 'string' || value instanceof URLSearchParams) bytes = Buffer.from(String(value));
  else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof Blob) {
    if (value.size > maxBodyBytes) throw failure('body-too-large');
    bytes = Buffer.from(await value.arrayBuffer());
  } else if (value?.[Symbol.asyncIterator]) {
    const chunks = []; let size = 0;
    const stream = Readable.from(value, { signal });
    try {
      for await (const chunk of stream) {
        const part = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength);
        size += part.length;
        if (size > maxBodyBytes) throw failure('body-too-large');
        chunks.push(part);
      }
    } catch (error) { stream.destroy(); throw signal?.aborted ? aborted(signal) : error; }
    bytes = Buffer.concat(chunks, size);
  } else throw failure('unsupported-body');
  if (signal?.aborted) throw aborted(signal);
  if (bytes.length > maxBodyBytes) throw failure('body-too-large');
  return bytes;
}

async function specification(input, init, context, headersTimeoutMs) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input); } catch { throw failure('invalid-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 16384) throw failure('invalid-url');
  url.hash = '';
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!/^[A-Z]{1,20}$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method)) throw failure('invalid-method');
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const originalBody = init.body !== undefined ? init.body : input instanceof Request ? input.body : null;
  if (['GET', 'HEAD'].includes(method) && originalBody != null) throw failure('invalid-body');
  if (init.redirect && !['manual', 'error'].includes(init.redirect)) throw failure('redirect-not-manual');
  let headers;
  try { headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)); }
  catch { throw failure('invalid-headers'); }
  for (const name of blockedHeaders) if (headers.has(name)) headers.delete(name);
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  if (context.serverAuth && headers.has('authorization')) throw failure('conflicting-auth');
  if (Buffer.byteLength(JSON.stringify([...headers]), 'utf8') > maxHeaderBytes) throw failure('headers-too-large');
  const selectedRoute = route(context.route), serverAuth = auth(context.serverAuth), proxyAuth = auth(context.proxyAuth, true);
  if (proxyAuth && selectedRoute.type === 'direct') throw failure('invalid-auth');
  if (context.clientCertificate != null) throw failure('certificate-requires-integrated-transport');
  const body = await bodyBytes(originalBody, signal);
  if (originalBody instanceof URLSearchParams && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
  return { signal, spec: { url: url.href, method, headers: [...headers], body: body === null ? null : body.toString('base64'), route: selectedRoute, serverAuth, proxyAuth, clientCertificate: null, headersTimeoutMs } };
}

class NativePermits {
  constructor(limit, maxPending) { this.limit = limit; this.maxPending = maxPending; this.active = 0; this.pending = []; }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject };
      entry.abort = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        reject(aborted(signal));
      };
      if (this.active < this.limit) this.grant(entry);
      else {
        if (this.pending.length >= this.maxPending) { reject(failure('queue-full')); return; }
        this.pending.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
      }
    });
  }
  grant(entry) {
    entry.signal?.removeEventListener('abort', entry.abort);
    this.active++;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true; this.active--;
      while (this.active < this.limit && this.pending.length) this.grant(this.pending.shift());
    });
  }
}

export function createWindowsHttpFetch({ spawn = spawnProcess, platform = process.platform, systemRoot = process.env.SystemRoot, headersTimeoutMs = 30000, maxConcurrent = 4, maxPending = 128 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8 || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new TypeError('Invalid Windows HTTP concurrency limits.');
  const permits = new NativePermits(maxConcurrent, maxPending);
  const perform = async function(input, init, context, release) {
    if (platform !== 'win32') throw failure('unsupported-platform');
    if (typeof spawn !== 'function' || !Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1 || headersTimeoutMs > 120000) throw new TypeError('Invalid Windows HTTP transport options.');
    if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\x00-\x1f\x7f]/.test(systemRoot)) throw failure('unavailable');
    const { signal, spec } = await specification(input, init, context, headersTimeoutMs);
    if (signal?.aborted) throw aborted(signal);
    bundledSource ||= readFile(new URL('./native/windows-http.cs', import.meta.url)).then(value => value.toString('base64'));
    let source;
    try { source = await bundledSource; } catch { throw failure('unavailable'); }
    if (signal?.aborted) throw aborted(signal);
    const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')];
    let child;
    try { child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw failure('unavailable'); }
    const closed = new Promise(resolve => {
      child.once('close', (code, processSignal) => resolve({ code, signal: processSignal }));
      child.once('error', () => resolve({ code: -1, signal: null }));
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    let interrupted = null, timer, bodyController, finished = false;
    const kill = error => {
      interrupted ||= error;
      clearTimeout(timer);
      child.stdout.destroy(error);
      child.stdin.destroy();
      child.kill('SIGKILL');
      if (bodyController && !finished) { finished = true; bodyController.error(interrupted); release(); }
    };
    const onAbort = () => kill(aborted(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => kill(failure('headers-timeout')), headersTimeoutMs + 10000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    closed.then(cleanup);
    child.stdin.end(`${source}\n${JSON.stringify(spec)}\n`, 'utf8');
    const iterator = child.stdout[Symbol.asyncIterator]();
    let head = Buffer.alloc(0), rest = Buffer.alloc(0), metadata;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) throw interrupted || failure('process-failed');
        const chunk = Buffer.from(next.value), newline = chunk.indexOf(10);
        if (head.length + (newline < 0 ? chunk.length : newline) > maxHeaderBytes) throw failure('headers-too-large');
        head = Buffer.concat([head, newline < 0 ? chunk : chunk.subarray(0, newline)]);
        if (newline < 0) continue;
        try { metadata = JSON.parse(head.toString('utf8')); } catch { throw failure('invalid-response'); }
        rest = chunk.subarray(newline + 1);
        break;
      }
      clearTimeout(timer);
      if (metadata?.error) throw failure(nativeErrors.has(metadata.error) ? metadata.error : 'process-failed');
      if (!metadata || !Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599 || !Array.isArray(metadata.headers)) throw failure('invalid-response');
      if (init.redirect === 'error' && [301, 302, 303, 307, 308].includes(metadata.status)) throw failure('redirect-error');
      const headers = new Headers();
      for (const pair of metadata.headers) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || /[\r\n]/.test(value))) throw failure('invalid-response');
        try { headers.append(pair[0], pair[1]); } catch { throw failure('invalid-response'); }
      }
      const body = new ReadableStream({
        start(controller) { bodyController = controller; },
        async pull(controller) {
          if (finished) return;
          try {
            if (interrupted) throw interrupted;
            if (rest.length) { const chunk = rest; rest = Buffer.alloc(0); controller.enqueue(chunk); return; }
            const next = await iterator.next();
            if (!next.done) { controller.enqueue(new Uint8Array(next.value)); return; }
            const exit = await closed;
            if (interrupted || exit.code !== 0) throw interrupted || failure('process-failed');
            finished = true; cleanup(); release(); controller.close();
          } catch (error) { finished = true; cleanup(); kill(error); release(); controller.error(interrupted || failure('process-failed')); }
        },
        cancel() { finished = true; cleanup(); kill(failure('cancelled')); release(); }
      }, { highWaterMark: 1 });
      if (spec.method === 'HEAD' || [204, 205, 304].includes(metadata.status)) {
        await body.cancel();
        return new Response(null, { status: metadata.status, headers });
      }
      const response = new Response(body, { status: metadata.status, headers });
      Object.defineProperty(response, 'url', { value: spec.url });
      return response;
    } catch (error) {
      cleanup(); kill(error);
      throw interrupted || failure('process-failed');
    }
  };
  return async function windowsFetch(input, init = {}, context = {}) {
    if (platform !== 'win32') throw failure('unsupported-platform');
    const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const release = await permits.acquire(signal);
    try { return await perform(input, init, context, release); }
    catch (error) { release(); throw error; }
  };
}

export const windowsHttpFetch = createWindowsHttpFetch();
