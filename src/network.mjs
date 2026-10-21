import net from 'node:net';
import tls from 'node:tls';
import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent, Client, ProxyAgent, fetch as undiciFetch } from 'undici';
import { normalizeAuthentication, serverAuthentication, proxyAuthentication } from './enterprise-auth.mjs';
import { discoverWindowsPac } from './windows-wpad.mjs';
import { normalizeClientCertificates } from './client-certificates.mjs';
import { clientIdentityTlsOptions, clearClientIdentityCache } from './client-certificate-identity.mjs';
import { readWindowsSystemProxy } from './windows-system-proxy.mjs';
import { authenticateProxyTunnel } from './proxy-auth.mjs';
import { ServerConnectionLimits, holdServerResponse, createFlowThrottle } from './server-rules.mjs';

const types = new Set(['http', 'https', 'socks4', 'socks5']);
const maxPacBytes = 256 * 1024;
const direct = Object.freeze({ type: 'direct' });
const hopHeaders = new Set(['proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const decodedResponses = new WeakSet();
function rememberDecodedResponse(response) {
  const encoding = response.headers.get('content-encoding');
  if (response.body && encoding && encoding.toLowerCase().split(',').every(value => ['gzip', 'x-gzip', 'deflate', 'br', 'zstd'].includes(value.trim()))) decodedResponses.add(response);
  return response;
}
function externalResponseHeaders(response) {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !hopHeaders.has(name) && name !== 'set-cookie'));
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  if (decodedResponses.has(response)) { delete headers['content-encoding']; delete headers['content-length']; }
  return headers;
}

function networkError(message, code = 'network-proxy-error') { return Object.assign(new Error(message), { code }); }
function externalFailureStatus(error) {
  let status;
  for (let depth = 0; error && depth <= 3; depth++, error = error.cause) {
    if ([401, 403, 407].includes(error.status) || /^(?:windows-(?:proxy-)?auth-|WINDOWS_AUTH_)/.test(error.code || '')) return 403;
    if (/CERT|ERR_TLS_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/i.test(error.code || '')) return 526;
    if (status === undefined && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) status = error.status;
  }
  return status || 502;
}
function waitFor(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function forwardExternalBody(source, destination, quota, { httpResponse = false, throttle } = {}) {
  if (!quota && !throttle) return pipeline(source, destination);
  for await (const chunk of source) {
    await throttle?.(chunk.length);
    const allowed = quota ? await quota.consume(chunk.length) : chunk.length;
    if (!Number.isSafeInteger(allowed) || allowed < 0 || allowed > chunk.length) throw networkError('Invalid quota allowance');
    if (allowed) await new Promise((resolve, reject) => destination.write(chunk.subarray(0, allowed), error => error ? reject(error) : resolve()));
    if (allowed < chunk.length) {
      source.destroy();
      // Flush bytes already admitted by the quota, then close this response.
      // Reaching the limit exactly is successful when the source ends here.
      if (httpResponse) destination.destroy(networkError('Download quota exceeded', 'DOWNLOAD_QUOTA_EXCEEDED'));
      else destination.end();
      return;
    }
  }
  destination.end();
}
function proxyUri(route) { return `${route.type}://${net.isIPv6(route.host) ? `[${route.host}]` : route.host}:${route.port}`; }
function basicAuthorization(auth) { return auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` : undefined; }
function hostName(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s/@\\\x00-\x1f]/.test(value)) throw networkError('Invalid proxy host');
  const host = value.replace(/^\[|\]$/g, '');
  if (!net.isIP(host) && !/^[a-z0-9_.-]+$/i.test(host)) throw networkError('Invalid proxy host');
  return host.toLowerCase();
}
function proxy(value) {
  if (!value || !types.has(value.type)) throw networkError('Unsupported proxy type');
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw networkError('Invalid proxy port');
  return Object.freeze({ type: value.type, host: hostName(value.host), port });
}
function urlAddress(input, protocols = ['http:', 'https:', 'ftp:', 'ftps:']) {
  const url = new URL(input);
  if (!protocols.includes(url.protocol) || url.username || url.password) throw networkError('Invalid network address');
  url.hash = '';
  return url;
}
function credentials(value) {
  if (!value) return null;
  if (typeof value.username !== 'string' || typeof value.password !== 'string' || value.username.includes(':') || /[\x00-\x1f\x7f]/.test(value.username + value.password) || Buffer.byteLength(value.username + value.password) > 1024) throw networkError('Invalid proxy credentials');
  return Object.freeze({ username: value.username, password: value.password });
}
export function normalizeNetworkConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['direct', 'manual', 'system', 'pac', 'wpad'].includes(input.mode || 'direct')) throw networkError('Invalid proxy mode');
  const mode = input.mode || 'direct';
  const bypass = input.bypass || [];
  if (!Array.isArray(bypass) || bypass.length > 128 || bypass.some(value => typeof value !== 'string' || !value || value.length > 256 || /[\s/@\\\x00-\x1f]/.test(value))) throw networkError('Invalid proxy bypass list');
  const config = { mode, bypass: [...new Set(bypass.map(value => value.toLowerCase()))] };
  if (input.authentication !== undefined) config.authentication = normalizeAuthentication(input.authentication);
  if (input.clientCertificates !== undefined) config.clientCertificates = normalizeClientCertificates(input.clientCertificates);
  if (mode === 'manual') config.proxy = proxy(input.proxy);
  if (mode === 'pac') {
    if (Boolean(input.pacUrl) === Boolean(input.pacFile)) throw networkError('Choose one PAC source');
    if (input.pacUrl) config.pacUrl = urlAddress(input.pacUrl, ['http:', 'https:']).href;
    else {
      if (typeof input.pacFile !== 'string' || !isAbsolute(input.pacFile) || input.pacFile.length > 4096 || /[\x00-\x1f]/.test(input.pacFile)) throw networkError('Choose an absolute PAC file path');
      config.pacFile = input.pacFile;
    }
  }
  return Object.freeze(config);
}
export function bypassesProxy(host, patterns) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  return patterns.some(pattern => {
    if (pattern === '<local>') return !host.includes('.') && !host.includes(':');
    if (pattern.startsWith('.')) return host === pattern.slice(1) || host.endsWith(pattern);
    const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${expression}$`, 'i').test(host);
  });
}
export function parsePacResult(value) {
  if (typeof value !== 'string' || value.length > 4096) throw networkError('Invalid PAC result');
  const routes = [];
  for (const entry of value.split(';').map(item => item.trim()).filter(Boolean)) {
    if (entry === 'DIRECT') routes.push(direct);
    else {
      const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\[[0-9a-f:]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(entry);
      if (!match) throw networkError('Unsupported PAC route');
      const type = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks5', SOCKS4: 'socks4', SOCKS5: 'socks5' }[match[1].toUpperCase()];
      routes.push(proxy({ type, host: match[2], port: match[3] }));
    }
    if (routes.length > 16) throw networkError('Too many PAC routes');
  }
  if (!routes.length) throw networkError('PAC returned no route');
  return routes;
}
export async function readWindowsProxySettings() {
  return readWindowsSystemProxy();
}
function systemProxy(value, scheme) {
  const entries = String(value || '').split(';').filter(Boolean);
  const mapped = entries.some(entry => entry.includes('='));
  const item = mapped ? entries.find(entry => entry.toLowerCase().startsWith(`${scheme}=`))?.split('=').slice(1).join('=') || entries.find(entry => entry.toLowerCase().startsWith('socks='))?.split('=').slice(1).join('=') : entries[0];
  if (!item) return null;
  const socks = mapped && !entries.some(entry => entry.toLowerCase().startsWith(`${scheme}=`));
  const match = /^(?:(http|https|socks4|socks5):\/\/)?(\[[0-9a-f:]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(item.trim());
  if (!match) throw networkError('Unsupported Windows proxy setting');
  return proxy({ type: match[1]?.toLowerCase() || (socks ? 'socks5' : 'http'), host: match[2], port: match[3] });
}
async function pacSource(config, signal) {
  if (config.pacFile) {
    const file = await import('node:fs/promises').then(fs => fs.open(config.pacFile, 'r'));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxPacBytes) throw networkError('PAC source must be a regular file of at most 256 KiB');
      const buffer = Buffer.alloc(maxPacBytes + 1); let size = 0;
      while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
      if (size > maxPacBytes) throw networkError('PAC file is too large');
      return buffer.subarray(0, size).toString('utf8');
    } finally { await file.close(); }
  }
  let address = config.pacUrl;
  for (let hop = 0; hop <= 3; hop++) {
    // Fetching the explicitly selected PAC itself is bootstrap traffic, without proxy credentials.
    const response = await undiciFetch(address, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hop === 3) throw networkError('PAC redirect failed');
      address = urlAddress(new URL(location, address).href, ['http:', 'https:']).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw networkError('PAC fetch failed'); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxPacBytes) throw networkError('PAC file is too large');
        chunks.push(chunk);
      }
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return Buffer.concat(chunks).toString('utf8');
  }
}
function evaluatePac(source, url, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./network-pac-worker.mjs', import.meta.url), { execArgv: [], workerData: { source, url: url.href, host: url.hostname }, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener('abort', aborted); worker.terminate().catch(() => {});
      error ? reject(error) : resolve(result);
    };
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(networkError('PAC evaluation timed out')), 3000);
    worker.once('message', value => finish(value.error ? networkError(value.error) : null, value.result));
    worker.once('error', () => finish(networkError('PAC evaluation failed')));
    worker.once('exit', code => { if (!done) finish(networkError(`PAC worker stopped (${code})`)); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function socketReady(socket, secure, signal) {
  return new Promise((resolve, reject) => {
    const event = secure ? 'secureConnect' : 'connect';
    const done = error => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); socket.off(event, ready); socket.off('error', fail);
      if (error) { socket.destroy(); reject(error); } else resolve(socket);
    };
    const ready = () => done(); const fail = () => done(networkError('Proxy connection failed')); const abort = () => done(signal.reason);
    const timer = setTimeout(() => done(networkError('Proxy connection timed out')), 10000);
    socket.once(event, ready); socket.once('error', fail); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function readSocket(socket, count, signal, delimiter = null) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const finish = error => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); socket.off('data', receive); socket.off('error', fail); socket.off('end', fail);
      if (error) { socket.destroy(); reject(error); return; }
      const length = delimiter ? data.indexOf(delimiter) + delimiter.length : count;
      socket.pause(); if (data.length > length) socket.unshift(data.subarray(length)); resolve(data.subarray(0, length));
    };
    const receive = chunk => { data = Buffer.concat([data, chunk]); if (data.length > 32768) return finish(networkError('Proxy response is too large')); if (delimiter ? data.includes(delimiter) : data.length >= count) finish(); };
    const fail = () => finish(networkError('Proxy handshake failed')); const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(networkError('Proxy handshake timed out')), 10000);
    socket.on('data', receive); socket.once('error', fail); socket.once('end', fail); signal.addEventListener('abort', abort, { once: true }); socket.resume();
    if (signal.aborted) abort();
  });
}
async function connectRoute(route, host, port, auth, signal, policy, authService) {
  const socket = route.type === 'https' ? tls.connect({ host: route.host, port: route.port, servername: net.isIP(route.host) ? undefined : route.host }) : net.connect({ host: route.type === 'direct' ? host : route.host, port: route.type === 'direct' ? port : route.port });
  await socketReady(socket, route.type === 'https', signal);
  try {
    if (route.type === 'direct') return socket;
    if (['http', 'https'].includes(route.type)) {
      const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
      if (policy) return await authenticateProxyTunnel(socket, { authority, route, policy, credentials: auth, service: authService, signal });
      const authorization = auth ? `Proxy-Authorization: ${basicAuthorization(auth)}\r\n` : '';
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);
      const header = (await readSocket(socket, 0, signal, Buffer.from('\r\n\r\n'))).toString('latin1');
      const status = /^HTTP\/1\.[01] (\d{3})\b/.exec(header)?.[1];
      if (status !== '200') throw Object.assign(networkError('Proxy CONNECT was refused'), { status: status ? Number(status) : undefined });
    } else if (route.type === 'socks5') {
      socket.write(Buffer.from(auth ? [5, 1, 2] : [5, 1, 0]));
      const reply = await readSocket(socket, 2, signal);
      if (reply[0] !== 5 || reply[1] !== (auth ? 2 : 0)) throw networkError('SOCKS5 authentication method was refused');
      if (auth) {
        const name = Buffer.from(auth.username), password = Buffer.from(auth.password);
        if (name.length > 255 || password.length > 255) throw networkError('SOCKS5 credentials are too long');
        socket.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([password.length]), password]));
        const accepted = await readSocket(socket, 2, signal);
        if (accepted[0] !== 1 || accepted[1] !== 0) throw networkError('SOCKS5 authentication was refused');
      }
      const domain = Buffer.from(host); if (domain.length > 255) throw networkError('SOCKS target is too long');
      const end = Buffer.alloc(2); end.writeUInt16BE(port);
      // Domain form deliberately delegates DNS to the proxy, including numeric hosts.
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, end]));
      const replyHead = await readSocket(socket, 4, signal);
      if (replyHead[0] !== 5 || replyHead[1] !== 0 || replyHead[2] !== 0) throw networkError('SOCKS5 connection was refused');
      if (replyHead[3] === 1) await readSocket(socket, 6, signal);
      else if (replyHead[3] === 4) await readSocket(socket, 18, signal);
      else if (replyHead[3] === 3) { const size = await readSocket(socket, 1, signal); await readSocket(socket, size[0] + 2, signal); }
      else throw networkError('Invalid SOCKS5 reply');
    } else {
      if (auth?.password) throw networkError('SOCKS4 does not support password authentication');
      const end = Buffer.alloc(2); end.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([4, 1]), end, Buffer.from([0, 0, 0, 1]), Buffer.from(auth?.username || ''), Buffer.from([0]), Buffer.from(host), Buffer.from([0])]));
      const reply = await readSocket(socket, 8, signal);
      if (reply[0] !== 0 || reply[1] !== 90) throw networkError('SOCKS4 connection was refused');
    }
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

export class NetworkService {
  #config = normalizeNetworkConfig();
  #credentials = null;
  #system = {};
  #pac = null;
  #pacLoaded = 0;
  #pacLoading = null;
  #pacEvaluations = new Map();
  #wpad = null;
  #wpadLoaded = 0;
  #wpadLoading = null;
  #agents = new Map();
  #transientAgents = new Set();
  #external = null;
  #externalPromise = null;
  #externalQuota;
  #routeGateways = new Set();
  #routeGatewayPromises = new Map();
  #closed = false;
  #generation = 0;
  #authService = null;
  #authServiceLoading = null;
  #lifetime = new AbortController();
  constructor({ systemSettings = readWindowsProxySettings, credentialsProvider, serverCredentialsProvider, clientCertificateProvider, discoverPac = discoverWindowsPac, windowsFetch, windowsAuth, quota, serverRules = [] } = {}) {
    Object.assign(this, { systemSettings, credentialsProvider, serverCredentialsProvider, clientCertificateProvider, discoverPac, windowsFetch, windowsAuth, quota });
    this.serverLimits = new ServerConnectionLimits(serverRules);
  }
  setServerRules(rules) { this.serverLimits.setRules(rules); }
  acquireServerSlot(url, { signal = new AbortController().signal } = {}) { return this.serverLimits.acquire(url, { signal: AbortSignal.any([signal, this.#lifetime.signal]) }); }
  snapshot() { return structuredClone(this.#config); }
  requiresBrowserTransport(input) {
    const url = urlAddress(input, ['http:', 'https:']);
    return !!serverAuthentication(url, this.#config) || url.protocol === 'https:' && this.#config.clientCertificates.some(profile => profile.enabled && profile.origin === url.origin);
  }
  async browserFetch(input, init = {}) {
    const response = await this.fetch(input, init);
    const headers = externalResponseHeaders(response);
    let body = response.body;
    if (body && headers['content-encoding']) {
      try {
        for (const encoding of headers['content-encoding'].toLowerCase().split(',').reverse()) {
          if (encoding.trim() === 'identity') continue;
          const format = { gzip: 'gzip', 'x-gzip': 'gzip', deflate: 'deflate', br: 'brotli', zstd: 'zstd' }[encoding.trim()];
          if (!format) throw networkError('Unsupported browser content encoding');
          body = body.pipeThrough(new DecompressionStream(format));
        }
      } catch (error) { await body.cancel().catch(() => {}); throw error; }
      delete headers['content-encoding']; delete headers['content-length'];
    }
    const outputHeaders = new Headers();
    for (const [name, values] of Object.entries(headers)) for (const value of Array.isArray(values) ? values : [values]) outputHeaders.append(name, value);
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: outputHeaders });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    return wrapped;
  }
  async configure(value, { credentials: auth } = {}) {
    if (this.#closed) throw networkError('Network service is closed');
    const config = normalizeNetworkConfig(value), nextAuth = credentials(auth);
    const system = config.mode === 'system' ? await this.systemSettings() : {};
    if (this.#closed) throw networkError('Network service is closed');
    this.#lifetime.abort(networkError('Network settings changed'));
    this.#lifetime = new AbortController();
    await this.#authServiceLoading?.catch(() => {});
    await this.#authService?.close();
    this.#authService = null; this.#authServiceLoading = null;
    clearClientIdentityCache();
    await this.#closeRouteGateways();
    if (this.#external) for (const socket of this.#external.sockets) socket.destroy();
    await Promise.allSettled([...this.#agents.values(), ...this.#transientAgents].map(agent => agent.destroy())); this.#agents.clear(); this.#transientAgents.clear();
    this.#generation++; this.#config = config; this.#credentials = nextAuth; this.#system = system; this.#pac = null; this.#pacLoaded = 0; this.#pacLoading = null; this.#pacEvaluations.clear();
    this.#wpad = null; this.#wpadLoaded = 0; this.#wpadLoading = null;
    return this.snapshot();
  }
  async credentialsFor(route) {
    if (this.credentialsProvider) return credentials(await this.credentialsProvider(route));
    const configured = this.#config.proxy;
    return this.#config.mode === 'manual' && configured.type === route.type && configured.host === route.host && configured.port === route.port ? this.#credentials : null;
  }
  async routesFor(input, { signal = new AbortController().signal } = {}) {
    if (this.#closed) throw networkError('Network service is closed');
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    const url = urlAddress(input), config = this.#config, generation = this.#generation;
    let bypass = config.bypass;
    if (config.mode === 'system') bypass = [...bypass, ...String(this.#system.ProxyOverride || '').toLowerCase().split(';').filter(Boolean)];
    if (bypassesProxy(url.hostname, bypass) || config.mode === 'direct') return [direct];
    if (config.mode === 'manual') return [config.proxy];
    let pac = config.mode === 'pac' ? config : null;
    if (config.mode === 'system') {
      if (this.#system.AutoConfigURL) pac = { pacUrl: urlAddress(this.#system.AutoConfigURL, ['http:', 'https:']).href };
      else if (Number(this.#system.ProxyEnable)) {
        const route = systemProxy(this.#system.ProxyServer, url.protocol.slice(0, -1));
        return route ? [route] : [direct];
      } else if (Number(this.#system.AutoDetect)) pac = await this.#discoverPac(generation, signal);
      else return [direct];
    }
    if (config.mode === 'wpad') pac = await this.#discoverPac(generation, signal);
    if (!this.#pac || Date.now() - this.#pacLoaded > 60000) {
      if (!this.#pacLoading) {
        const loading = pacSource(pac, AbortSignal.any([AbortSignal.timeout(10000), this.#lifetime.signal]));
        this.#pacLoading = loading;
        loading.finally(() => { if (this.#pacLoading === loading) this.#pacLoading = null; }).catch(() => {});
      }
      const source = await waitFor(this.#pacLoading, signal);
      if (generation !== this.#generation || this.#closed) throw networkError('Network settings changed');
      this.#pac = source; this.#pacLoaded = Date.now();
    }
    let evaluation = this.#pacEvaluations.get(url.href);
    if (!evaluation) {
      if (this.#pacEvaluations.size >= 32) throw networkError('Too many pending PAC requests');
      evaluation = evaluatePac(this.#pac, url, AbortSignal.timeout(4000));
      this.#pacEvaluations.set(url.href, evaluation);
      evaluation.finally(() => { if (this.#pacEvaluations.get(url.href) === evaluation) this.#pacEvaluations.delete(url.href); }).catch(() => {});
    }
    const result = await waitFor(evaluation, signal);
    signal.throwIfAborted();
    if (generation !== this.#generation || this.#closed) throw networkError('Network settings changed');
    return parsePacResult(result);
  }
  async #discoverPac(generation, signal) {
    if (!this.#wpad || Date.now() - this.#wpadLoaded > 60000) {
      if (!this.#wpadLoading) {
        const loading = this.discoverPac({ signal: AbortSignal.any([AbortSignal.timeout(16000), this.#lifetime.signal]) });
        this.#wpadLoading = loading;
        loading.finally(() => { if (this.#wpadLoading === loading) this.#wpadLoading = null; }).catch(() => {});
      }
      const found = await waitFor(this.#wpadLoading, signal);
      signal.throwIfAborted();
      if (generation !== this.#generation || this.#closed) throw networkError('Network settings changed');
      if (!found) throw networkError('تعذّر العثور على إعداد الوكيل التلقائي WPAD. حدّد عنوان PAC أو الوكيل يدويًا.', 'wpad-not-found');
      this.#wpad = { pacUrl: urlAddress(found, ['http:', 'https:']).href }; this.#wpadLoaded = Date.now();
    }
    return this.#wpad;
  }
  async #authenticationService() {
    if (!this.#authServiceLoading) this.#authServiceLoading = this.windowsAuth ? Promise.resolve(this.windowsAuth) : import('./windows-auth.mjs').then(module => {
      if (this.#closed) throw networkError('Network service is closed');
      return new module.WindowsAuthService();
    });
    this.#authService = await this.#authServiceLoading;
    return this.#authService;
  }
  async #connectRoutes(routes, host, port, signal) {
    let failure;
    for (const route of routes) {
      signal.throwIfAborted();
      try {
        const policy = proxyAuthentication(route, this.#config);
        if (policy) await (await this.#authenticationService()).prepare?.(signal);
        return await connectRoute(route, host, port, route.type === 'direct' || policy?.currentAccount ? null : await this.credentialsFor(route), signal, policy, this.#authService);
      }
      catch (error) { if (signal.aborted) throw error; failure = error; }
    }
    throw Object.assign(networkError('All configured proxy routes failed'), { cause: failure });
  }
  async connect({ host, port, url, signal = new AbortController().signal }) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    host = hostName(host); port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw networkError('Invalid target port');
    const routes = await this.routesFor(url || `https://${net.isIPv6(host) ? `[${host}]` : host}:${port}/`, { signal });
    return this.#connectRoutes(routes, host, port, signal);
  }
  async #selectNativeRoute(routes, url, signal) {
    for (const route of routes) {
      signal.throwIfAborted();
      let socket;
      try {
        // Reachability selection ends before any authenticated HTTP request.
        // A 401/407 or failure after dispatch never tries another PAC route.
        proxyAuthentication(route, this.#config);
        const host = route.type === 'direct' ? url.hostname.replace(/^\[|\]$/g, '') : route.host;
        const port = route.type === 'direct' ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : route.port;
        socket = route.type === 'https' ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
        await socketReady(socket, route.type === 'https', signal);
        socket.destroy(); return route;
      } catch (error) { socket?.destroy(); if (signal.aborted) throw error; }
    }
    throw networkError('All configured proxy routes failed');
  }
  async fetch(input, init = {}) {
    const url = urlAddress(typeof input === 'string' || input instanceof URL ? input : input.url, ['http:', 'https:']);
    const signal = AbortSignal.any([init.signal || input.signal || new AbortController().signal, this.#lifetime.signal]);
    const lease = await this.acquireServerSlot(url, { signal });
    try {
      const response = await this.#fetch(input, { ...init, signal });
      if (!lease) return response;
      const decoded = decodedResponses.has(response);
      return holdServerResponse(response, lease, signal, wrapped => { if (decoded) decodedResponses.add(wrapped); return wrapped; });
    } catch (error) { lease?.release(); throw error; }
  }
  async #fetch(input, init = {}) {
    if (input instanceof Request) init = { method: input.method, body: input.body || undefined, headers: input.headers, signal: input.signal, ...(input.body ? { duplex: 'half' } : {}), ...init };
    const url = urlAddress(typeof input === 'string' || input instanceof URL ? input : input.url, ['http:', 'https:']);
    const signal = AbortSignal.any([init.signal || new AbortController().signal, this.#lifetime.signal]);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    if (headers.has('proxy-authorization')) throw networkError('Proxy credentials belong in proxy settings');
    // Resolve each destination before dispatch; redirects are manual so no redirected request can bypass policy.
    if (init.redirect && init.redirect !== 'manual' && init.redirect !== 'error') throw networkError('Network redirects must be followed explicitly');
    let routes = await this.routesFor(url.href, { signal });
    const certificate = url.protocol === 'https:' ? await this.clientCertificateProvider?.(url.origin) : null;
    const serverPolicy = serverAuthentication(url, this.#config);
    const integratedProxy = this.#config.authentication?.proxy.scheme && this.#config.authentication.proxy.scheme !== 'basic' && routes.some(route => ['http', 'https'].includes(route.type));
    if (routes.length > 1 && (serverPolicy || integratedProxy)) routes = [await this.#selectNativeRoute(routes, url, signal)];
    const proxyPolicy = routes.length === 1 ? proxyAuthentication(routes[0], this.#config) : null;
    if (serverPolicy || proxyPolicy && routes[0].type === 'http' && !certificate) {
      const route = routes[0];
      if (serverPolicy && headers.has('authorization')) throw networkError('أزل ترويسة التفويض اليدوية قبل استخدام مصادقة Windows لهذا الخادم.');
      const serverCredentials = serverPolicy && !serverPolicy.currentAccount ? await this.serverCredentialsProvider?.(url.origin) : null;
      if (serverPolicy && !serverPolicy.currentAccount && !serverCredentials) throw networkError('أدخل بيانات حساب الخادم قبل بدء التنزيل.', 'windows-auth-missing-credentials');
      const proxyCredentials = route.type === 'direct' || proxyPolicy?.currentAccount ? null : await this.credentialsFor(route);
      if (proxyPolicy && !proxyPolicy.currentAccount && !proxyCredentials) throw networkError('أدخل بيانات حساب الوكيل قبل بدء التنزيل.', 'windows-auth-missing-credentials');
      const nativeFetch = this.windowsFetch || (await import('./windows-http.mjs')).windowsHttpFetch;
      const context = {
        route, serverAuth: serverPolicy && { ...serverPolicy, credentials: serverCredentials },
        proxyAuth: proxyPolicy ? { ...proxyPolicy, credentials: proxyCredentials } : proxyCredentials ? { scheme: 'basic', currentAccount: false, credentials: proxyCredentials } : null,
        clientCertificate: certificate
      };
      if (serverPolicy && (certificate || !['direct', 'http'].includes(route.type))) {
        const { integratedHttpFetch } = await import('./integrated-http.mjs');
        return integratedHttpFetch(url.href, { ...init, headers, signal, redirect: init.redirect || 'manual' }, {
          serverAuth: context.serverAuth, clientCertificate: certificate, authService: await this.#authenticationService(),
          connect: ({ host, port, signal }) => this.#connectRoutes(routes, host, port, signal)
        });
      }
      return nativeFetch(url.href, { ...init, headers, signal, redirect: init.redirect || 'manual' }, context);
    }
    if (url.protocol === 'http:' && routes.length > 1) return this.#fetchOrderedHttp(url, { ...init, headers, signal }, routes);
    const tlsIdentity = certificate ? await clientIdentityTlsOptions(certificate, { signal }) : null;
    const forward = routes.length === 1 && ['http', 'https'].includes(routes[0].type) && !proxyPolicy && !certificate;
    const auth = forward ? await this.credentialsFor(routes[0]) : null;
    const authKey = auth ? createHash('sha256').update(`${auth.username}:${auth.password}`).digest('hex') : '';
    const identityKey = certificate ? `${url.origin}:${createHash('sha256').update(certificate.pfx).update(certificate.passphrase || '').digest('hex')}` : '';
    const key = `${forward ? 'forward:' : ''}${JSON.stringify(routes)}:${authKey}:${identityKey}`;
    let agent = this.#agents.get(key);
    if (!agent) {
      if (this.#agents.size >= 64) throw networkError('Too many distinct proxy routes');
      if (forward) {
        const route = routes[0];
        agent = new ProxyAgent({ uri: proxyUri(route), token: basicAuthorization(auth), connectTimeout: 10000, connections: 16, pipelining: 1 });
      } else agent = new Agent({ connect: (options, callback) => {
        const connectionSignal = AbortSignal.any([AbortSignal.timeout(20000), this.#lifetime.signal]);
        this.#connectRoutes(routes, options.hostname.replace(/^\[|\]$/g, ''), Number(options.port || (options.protocol === 'https:' ? 443 : 80)), connectionSignal).then(async socket => {
          const host = options.hostname.replace(/^\[|\]$/g, '');
          if (options.protocol === 'https:') {
            const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ...tlsIdentity });
            socket = await socketReady(secure, true, connectionSignal);
          }
          callback(null, socket);
        }).catch(error => callback(error));
      }, connections: 16, pipelining: 1 });
      this.#agents.set(key, agent);
    }
    return rememberDecodedResponse(await undiciFetch(url, { ...init, headers, redirect: init.redirect || 'manual', dispatcher: agent }));
  }
  async #fetchOrderedHttp(url, init, routes) {
    if (this.#transientAgents.size >= 256) throw networkError('Too many pending proxy connections');
    const signal = AbortSignal.any([init.signal, AbortSignal.timeout(20000)]);
    let connected, selected, auth;
    for (const route of routes) {
      signal.throwIfAborted();
      try {
        auth = route.type === 'direct' ? null : await this.credentialsFor(route);
        if (['http', 'https'].includes(route.type)) {
          const socket = route.type === 'https' ? tls.connect({ host: route.host, port: route.port, servername: net.isIP(route.host) ? undefined : route.host, ALPNProtocols: ['http/1.1'] }) : net.connect({ host: route.host, port: route.port });
          connected = await socketReady(socket, route.type === 'https', signal);
        } else connected = await connectRoute(route, url.hostname, Number(url.port || 80), auth, signal);
        selected = route; break;
      } catch (error) { if (signal.aborted) throw error; }
    }
    if (!connected) throw networkError('All configured proxy routes failed');
    // Failover ends before the request is dispatched. A POST is never replayed after a 407 or socket failure.
    let used = false;
    const connect = (options, callback) => {
      if (used) { queueMicrotask(() => callback(networkError('A dispatched HTTP request cannot be replayed'))); return; }
      used = true; queueMicrotask(() => callback(null, connected));
    };
    const agent = ['http', 'https'].includes(selected.type)
      ? new ProxyAgent({ uri: proxyUri(selected), token: basicAuthorization(auth), factory: (origin, options) => new Client(origin, { ...options, connect, pipelining: 1 }) })
      : new Agent({ connect, connections: 1, pipelining: 1 });
    this.#transientAgents.add(agent);
    try {
      const response = await undiciFetch(url, { ...init, redirect: init.redirect || 'manual', dispatcher: agent });
      agent.close().catch(() => {}).finally(() => this.#transientAgents.delete(agent));
      return rememberDecodedResponse(response);
    } catch (error) {
      connected.destroy(); await agent.destroy(); this.#transientAgents.delete(agent); throw error;
    }
  }
  createFetch() { return this.fetch.bind(this); }
  async externalProxy({ quota = this.quota, route } = {}) {
    if (this.#closed) throw networkError('Network service is closed');
    if (route !== undefined) {
      const checked = proxy(route);
      if (quota !== null || !['http', 'https'].includes(checked.type)) throw networkError('Invalid route-bound proxy gateway');
      const key = JSON.stringify(checked);
      if (!this.#routeGatewayPromises.has(key)) {
        const promise = this.#startExternalProxy(null, checked);
        this.#routeGatewayPromises.set(key, promise);
        promise.catch(() => { if (this.#routeGatewayPromises.get(key) === promise) this.#routeGatewayPromises.delete(key); });
      }
      return this.#routeGatewayPromises.get(key);
    }
    if (quota !== undefined && (!quota || typeof quota.consume !== 'function')) throw networkError('Invalid external download quota');
    if (this.#externalPromise && this.#externalQuota !== quota) throw networkError('External download quota cannot change while the proxy is running');
    if (this.#external) return this.#external.url;
    if (!this.#externalPromise) { this.#externalQuota = quota; this.#externalPromise = this.#startExternalProxy(quota); }
    try { return await this.#externalPromise; }
    catch (error) { this.#externalPromise = null; throw error; }
  }
  async #closeRouteGateways() {
    await Promise.allSettled(this.#routeGatewayPromises.values());
    this.#routeGatewayPromises.clear();
    await Promise.allSettled([...this.#routeGateways].map(async gateway => {
      for (const socket of gateway.sockets) socket.destroy();
      await new Promise(resolve => gateway.server.close(resolve));
    }));
    this.#routeGateways.clear();
  }
  async #startExternalProxy(quota, fixedRoute = null) {
    const token = randomBytes(32).toString('hex'), sockets = new Set();
    const authorization = `Basic ${Buffer.from(`sahm:${token}`).toString('base64')}`;
    const server = createServer(async (request, response) => {
      if (request.headers['proxy-authorization'] !== authorization) { response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="SAHM"' }); response.end(); return; }
      if (fixedRoute) { response.writeHead(405); response.end(); return; }
      try {
        await quota?.assertAvailable?.();
        const url = urlAddress(request.url, ['http:', 'https:']);
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopHeaders.has(name)));
        const controller = new AbortController(); request.once('aborted', () => controller.abort());
        response.once('close', () => { if (!response.writableFinished) controller.abort(); });
        const result = await this.fetch(url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : Readable.toWeb(request), duplex: 'half', signal: controller.signal });
        response.writeHead(result.status, externalResponseHeaders(result));
        if (result.body) await forwardExternalBody(Readable.fromWeb(result.body), response, quota, { httpResponse: true }); else response.end();
      } catch (error) { if (response.headersSent) response.destroy(error); else { response.writeHead(externalFailureStatus(error)); response.end(); } }
    });
    server.on('connect', async (request, socket, head) => {
      if (request.headers['proxy-authorization'] !== authorization) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      let remote, established = false, lease;
      const controller = new AbortController(); socket.once('close', () => { controller.abort(); remote?.destroy(); });
      try {
        await quota?.assertAvailable?.();
        const url = urlAddress(`https://${request.url}/`, ['https:']);
        if (url.pathname !== '/' || !/^\[?[a-z0-9_.:-]+\]?:\d+$/i.test(request.url)) throw networkError('Invalid CONNECT target');
        if (!fixedRoute) lease = await this.acquireServerSlot(url.href, { signal: controller.signal });
        remote = fixedRoute
          ? await this.#connectRoutes([fixedRoute], url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 443), AbortSignal.any([controller.signal, this.#lifetime.signal]))
          : await this.connect({ host: url.hostname, port: Number(url.port || 443), url: url.href, signal: controller.signal });
        sockets.add(remote); remote.once('close', () => sockets.delete(remote));
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
        established = true;
        if (head.length) remote.write(head); socket.pipe(remote);
        await forwardExternalBody(remote, socket, quota, { throttle: lease?.rule?.speedLimit ? createFlowThrottle(lease.rule.speedLimit, controller.signal) : undefined });
      } catch (error) { remote?.destroy(); socket.end(established ? undefined : `HTTP/1.1 ${externalFailureStatus(error)} Gateway Connection Failed\r\n\r\n`); }
      finally { lease?.release(); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://sahm:${token}@127.0.0.1:${server.address().port}`;
    if (fixedRoute) this.#routeGateways.add({ server, sockets, url });
    else this.#external = { server, sockets, url, quota };
    return url;
  }
  async close() {
    this.#closed = true;
    this.serverLimits.close();
    this.#lifetime.abort(networkError('Network service is closed'));
    clearClientIdentityCache();
    await this.#closeRouteGateways();
    await this.#authServiceLoading?.catch(() => {});
    await this.#authService?.close(); this.#authService = null;
    await this.#externalPromise?.catch(() => {});
    if (this.#external) { for (const socket of this.#external.sockets) socket.destroy(); await new Promise(resolve => this.#external.server.close(resolve)); this.#external = null; }
    await Promise.allSettled([...this.#agents.values(), ...this.#transientAgents].map(agent => agent.destroy())); this.#agents.clear(); this.#transientAgents.clear(); this.#credentials = null;
  }
}
