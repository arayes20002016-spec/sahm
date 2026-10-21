import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { tlsChannelBinding } from './proxy-auth.mjs';

const maxBodyBytes = 8 * 1024 * 1024;
const maxChallengeBody = 1024 * 1024;
const forbidden = new Set(['host', 'connection', 'proxy-authorization', 'proxy-connection', 'content-length', 'transfer-encoding', 'upgrade']);
const fail = code => Object.assign(new Error('تعذّر إكمال مصادقة الخادم عبر الاتصال الآمن.'), { code: `integrated-http-${code}` });
const abortError = signal => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('أُلغي اتصال الخادم.'), { name: 'AbortError', code: 'ABORT_ERR' });
let activeHandshakes = 0;
const handshakeQueue = [];
function handshakeSlot(signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const entry = { signal, reject };
    entry.abort = () => { const index = handshakeQueue.indexOf(entry); if (index >= 0) handshakeQueue.splice(index, 1); reject(abortError(signal)); };
    entry.grant = () => {
      signal?.removeEventListener('abort', entry.abort); activeHandshakes++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; activeHandshakes--;
        while (activeHandshakes < 8 && handshakeQueue.length) handshakeQueue.shift().grant();
      });
    };
    if (activeHandshakes < 8) entry.grant();
    else if (handshakeQueue.length >= 128) reject(fail('queue-full'));
    else { handshakeQueue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true }); }
  });
}

async function payload(input, signal) {
  if (input == null) return null;
  let result;
  if (typeof input === 'string' || input instanceof URLSearchParams) result = Buffer.from(String(input));
  else if (input instanceof ArrayBuffer) result = Buffer.from(input);
  else if (ArrayBuffer.isView(input)) result = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else if (input instanceof Blob) {
    if (input.size > maxBodyBytes) throw fail('body-too-large');
    result = Buffer.from(await input.arrayBuffer());
  } else if (input?.[Symbol.asyncIterator]) {
    const chunks = []; let count = 0;
    const source = Readable.from(input, { signal });
    try {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        count += bytes.length;
        if (count > maxBodyBytes) throw fail('body-too-large');
        chunks.push(bytes);
      }
    } catch (error) { source.destroy(); throw signal?.aborted ? abortError(signal) : error; }
    result = Buffer.concat(chunks, count);
  } else throw fail('unsupported-body');
  if (signal?.aborted) throw abortError(signal);
  if (result.length > maxBodyBytes) throw fail('body-too-large');
  return result;
}

function challenge(response, scheme) {
  const value = response.headers['www-authenticate'];
  const match = new RegExp(`(?:^|,)\\s*${scheme}(?:\\s+([A-Za-z0-9+/]+={0,2}))?\\s*(?=,|$)`, 'i').exec(Array.isArray(value) ? value.join(',') : value || '');
  if (!match) throw fail('challenge');
  return match[1] || null;
}

async function discard(response, timeoutMs) {
  const length = response.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxChallengeBody)) throw fail('challenge-body-too-large');
  let count = 0;
  const timer = setTimeout(() => response.destroy(fail('challenge-body-timeout')), timeoutMs);
  try { for await (const chunk of response) { count += chunk.length; if (count > maxChallengeBody) throw fail('challenge-body-too-large'); } }
  finally { clearTimeout(timer); }
  if (!response.complete || /close/i.test(response.headers.connection || '')) throw fail('connection-changed');
}

export function createIntegratedHttpFetch({ tlsConnect = tls.connect, headersTimeoutMs = 30000 } = {}) {
  if (typeof tlsConnect !== 'function' || !Number.isInteger(headersTimeoutMs) || headersTimeoutMs < 1 || headersTimeoutMs > 120000) throw new TypeError('Invalid integrated HTTP options.');
  return async function integratedFetch(input, init = {}, context = {}) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : input); } catch { throw fail('invalid-url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('invalid-url');
    url.hash = '';
    const policy = context.serverAuth;
    let origin;
    try { origin = new URL(policy?.origin); } catch { throw fail('scope'); }
    if (origin.origin !== url.origin || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['ntlm', 'negotiate', 'kerberos'].includes(policy.scheme) || typeof policy.currentAccount !== 'boolean') throw fail('scope');
    if (!context.authService || typeof context.authService.createContext !== 'function' || typeof context.connect !== 'function') throw fail('unavailable');
    if (!policy.currentAccount && (!policy.credentials || typeof policy.credentials.username !== 'string' || !policy.credentials.username || policy.credentials.username.length > 256 || typeof policy.credentials.password !== 'string' || policy.credentials.password.length > 256 || /[\x00-\x1f\x7f]/.test(policy.credentials.username + policy.credentials.password))) throw fail('credentials');
    if (policy.currentAccount && policy.credentials != null) throw fail('credentials');
    const certificate = context.clientCertificate;
    if (certificate != null && (url.protocol !== 'https:' || !Buffer.isBuffer(certificate.pfx) || !certificate.pfx.length || certificate.pfx.length > maxBodyBytes || typeof certificate.passphrase !== 'string' || certificate.passphrase.length > 4096 || /[\0\r\n]/.test(certificate.passphrase))) throw fail('certificate');
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw fail('method');
    if (init.redirect && !['manual', 'error'].includes(init.redirect)) throw fail('redirect-mode');
    const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    if (callerSignal?.aborted) throw abortError(callerSignal);
    let headers;
    try { headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)); } catch { throw fail('headers'); }
    if (headers.has('authorization') || headers.has('proxy-authorization')) throw fail('caller-auth');
    for (const name of forbidden) headers.delete(name);
    headers.set('connection', 'keep-alive');
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
    if (Buffer.byteLength(JSON.stringify([...headers])) > 32768) throw fail('headers');
    const sourceBody = init.body !== undefined ? init.body : input instanceof Request ? input.body : null;
    if (method !== 'POST' && sourceBody != null) throw fail('body');
    const body = await payload(sourceBody, callerSignal);
    if (sourceBody instanceof URLSearchParams && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    const releaseHandshake = await handshakeSlot(callerSignal);
    const lifetime = new AbortController();
    const agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }) : new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    let authContext, firstSocket, connects = 0, closed = false, activeRequest, activeResponse, outputController, bodyFinished = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      releaseHandshake();
      callerSignal?.removeEventListener('abort', onAbort);
      lifetime.abort(fail('closed'));
      activeRequest?.destroy(); activeResponse?.destroy(); agent.destroy();
      authContext?.close().catch(() => {});
    };
    const onAbort = () => { const error = abortError(callerSignal); lifetime.abort(error); if (outputController && !bodyFinished) { bodyFinished = true; outputController.error(error); } activeRequest?.destroy(error); activeResponse?.destroy(error); cleanup(); };
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();
    agent.createConnection = (_options, callback) => {
      if (connects++ > 0) { callback(fail('connection-changed')); return; }
      Promise.resolve().then(async () => {
        let identityOptions;
        if (certificate) {
          try { identityOptions = await (await import('./client-certificate-identity.mjs')).clientIdentityTlsOptions(certificate); }
          catch { throw fail('certificate'); }
        }
        if (closed || lifetime.signal.aborted) throw fail('closed');
        const raw = await context.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), signal: lifetime.signal });
        return { raw, identityOptions };
      }).then(({ raw, identityOptions }) => {
        if (closed || lifetime.signal.aborted) { raw.destroy(); throw fail('closed'); }
        if (url.protocol !== 'https:') { callback(null, raw); return; }
        let secure;
        try {
          const hostname = url.hostname.replace(/^\[|\]$/g, '');
          secure = tlsConnect({ socket: raw, servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, checkServerIdentity: (_name, peer) => tls.checkServerIdentity(hostname, peer), ...(identityOptions ? { cert: identityOptions.cert, key: identityOptions.key } : {}) });
        } catch { raw.destroy(); throw fail('certificate'); }
        const failed = () => { secure.destroy(); callback(fail('tls')); };
        secure.once('error', failed);
        secure.once('secureConnect', () => { secure.removeListener('error', failed); callback(null, secure); });
      }).catch(error => callback(error?.code?.startsWith('integrated-http-') ? error : fail('connect')));
    };
    const request = authorization => new Promise((resolve, reject) => {
      if (closed || callerSignal?.aborted) { reject(abortError(callerSignal)); return; }
      const fields = Object.fromEntries(headers);
      if (authorization) fields.authorization = authorization;
      if (body !== null) fields['content-length'] = String(body.length);
      const protocol = url.protocol === 'https:' ? https : http;
      let settled = false;
      const timer = setTimeout(() => { activeRequest?.destroy(fail('headers-timeout')); }, headersTimeoutMs);
      const done = (error, response) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(response); };
      const req = protocol.request(url, { method, headers: fields, agent, maxHeaderSize: 32768, signal: lifetime.signal }, response => {
        activeResponse = response;
        if (response.socket !== firstSocket) { response.destroy(); done(fail('connection-changed')); return; }
        done(null, response);
      });
      activeRequest = req;
      req.once('socket', socket => {
        if (firstSocket && firstSocket !== socket) { req.destroy(fail('connection-changed')); return; }
        firstSocket = socket;
      });
      req.once('error', error => done(callerSignal?.aborted ? abortError(callerSignal) : error?.code?.startsWith('integrated-http-') ? error : fail('request')));
      req.end(body);
    });
    try {
      // Compile the helper before a server's keep-alive clock starts. NTLM
      // must retain one connection; reopening it could replay a POST.
      await context.authService.prepare?.(lifetime.signal);
      if (callerSignal?.aborted) throw abortError(callerSignal);
      const scheme = policy.scheme === 'ntlm' ? 'NTLM' : 'Negotiate';
      let authorization, lastStep, rounds = 0;
      for (;;) {
        const response = await request(authorization);
        if (response.statusCode === 401) {
          const token = challenge(response, scheme);
          if (rounds++ >= 4 || authorization && !token) throw fail('rounds');
          await discard(response, headersTimeoutMs);
          if (!authContext) authContext = await context.authService.createContext({ scheme: policy.scheme, host: url.hostname.replace(/^\[|\]$/g, ''), currentAccount: policy.currentAccount, credentials: policy.credentials || undefined, allowedHosts: [url.hostname.replace(/^\[|\]$/g, '')], channelBinding: url.protocol === 'https:' ? tlsChannelBinding(firstSocket) : undefined, signal: lifetime.signal });
          lastStep = await authContext.step(token);
          if (!lastStep?.token || !/^[A-Za-z0-9+/]+={0,2}$/.test(lastStep.token) || lastStep.token.length > 174764) throw fail('token');
          authorization = `${scheme} ${lastStep.token}`;
          continue;
        }
        if (response.statusCode >= 200 && response.statusCode < 300 && lastStep && !lastStep.complete) {
          const proof = challenge(response, scheme);
          if (!proof || !(await authContext.step(proof)).complete) throw fail('server-proof');
        }
        if (init.redirect === 'error' && [301, 302, 303, 307, 308].includes(response.statusCode)) throw fail('redirect');
        if (authContext) { await authContext.close(); authContext = null; }
        releaseHandshake();
        const outputHeaders = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) outputHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        response.once('close', cleanup);
        if (method === 'HEAD' || [204, 205, 304].includes(response.statusCode)) { response.resume(); cleanup(); return new Response(null, { status: response.statusCode, headers: outputHeaders }); }
        const reader = Readable.toWeb(response).getReader();
        const stream = new ReadableStream({
          start(controller) { outputController = controller; },
          async pull(controller) {
            if (bodyFinished) return;
            try {
              const chunk = await reader.read();
              if (bodyFinished) return;
              if (chunk.done) { bodyFinished = true; cleanup(); controller.close(); }
              else controller.enqueue(chunk.value);
            } catch { if (!bodyFinished) { bodyFinished = true; cleanup(); controller.error(callerSignal?.aborted ? abortError(callerSignal) : fail('body')); } }
          },
          cancel(reason) { bodyFinished = true; cleanup(); return reader.cancel(reason).catch(() => {}); }
        }, { highWaterMark: 1 });
        const result = new Response(stream, { status: response.statusCode, headers: outputHeaders });
        Object.defineProperty(result, 'url', { value: url.href });
        return result;
      }
    } catch (error) {
      cleanup();
      if (callerSignal?.aborted) throw abortError(callerSignal);
      if (error?.code?.startsWith('integrated-http-')) throw error;
      throw fail('authentication');
    }
  };
}

export const integratedHttpFetch = createIntegratedHttpFetch();
