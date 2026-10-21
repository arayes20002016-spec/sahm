import { transportFetch } from './transport.mjs';
import { retryAfterMilliseconds } from './network-retry.mjs';

// Browser credentials and request bodies are deliberately kept outside job records.
const allowedHeaders = new Set(['accept', 'accept-language', 'user-agent', 'cookie', 'authorization', 'content-type', 'referer', 'origin', 'x-csrf-token', 'x-xsrf-token', 'x-requested-with']);
const publicRedirectHeaders = new Set(['accept', 'accept-language', 'user-agent']);
const normalizedContexts = new WeakSet();
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_REQUEST_HEADERS_BYTES = 32 * 1024;

export function normalizeRequestContext(input = {}) {
  if (input && typeof input === 'object' && normalizedContexts.has(input)) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid request context');
  const method = input.method || 'GET';
  if (!['GET', 'POST'].includes(method)) throw new Error('Only GET and POST downloads are supported');
  const headers = {};
  let headerBytes = 0;
  const entries = Array.isArray(input.headers)
    ? input.headers.map(header => [header.name, header.value])
    : Object.entries(input.headers || {});
  for (const [rawName, value] of entries) {
    const name = String(rawName).toLowerCase();
    if (!allowedHeaders.has(name)) throw new Error('Unsupported captured request header');
    if (typeof value !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(value) || Object.hasOwn(headers, name)) throw new Error('Invalid captured request header');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > MAX_REQUEST_HEADERS_BYTES) throw new Error('Captured request headers are too large');
    headers[name] = value;
  }
  const encoded = input.bodyBase64;
  if (encoded !== undefined && (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_REQUEST_BODY_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))) throw new Error('Invalid captured request body');
  if (method === 'GET' && encoded !== undefined) throw new Error('GET downloads cannot contain a request body');
  const body = method === 'POST' ? Buffer.from(encoded || '', 'base64') : null;
  if (body && body.length > MAX_REQUEST_BODY_BYTES) throw new Error('Captured request body is too large');
  const context = Object.freeze({ method, headers: Object.freeze(headers), body, needsSession: method === 'POST' || Object.keys(headers).some(name => !publicRedirectHeaders.has(name)) });
  normalizedContexts.add(context);
  return context;
}

export function headersForRedirect(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => publicRedirectHeaders.has(name.toLowerCase())));
}

export function downloadHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS URLs without embedded credentials are supported');
  return url.href;
}

export async function requestDownload(url, { requestContext, headers = {}, signal = new AbortController().signal, fetchImpl = transportFetch } = {}) {
  const context = normalizeRequestContext(requestContext);
  let current = downloadHttpUrl(url);
  let method = context.method;
  let body = context.body;
  let requestHeaders = { ...context.headers, 'accept-encoding': 'identity', ...headers };
  for (let redirects = 0; redirects <= 10; redirects++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 30000);
    let response;
    try {
      response = await fetchImpl(current, { method, body: method === 'POST' ? body : undefined, headers: requestHeaders, redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([signal, controller.signal]) });
    } finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      await response.body?.cancel();
      if (redirects === 10) throw new Error('Too many download redirects');
      // Reissuing a POST could trigger the server operation twice.
      if (method === 'POST' && [307, 308].includes(response.status)) throw new Error('POST redirect requires browser recapture');
      const next = downloadHttpUrl(new URL(response.headers.get('location'), current));
      if (new URL(next).origin !== new URL(current).origin) requestHeaders = { ...headersForRedirect(requestHeaders), 'accept-encoding': 'identity', ...Object.fromEntries(Object.entries(headers).filter(([name]) => ['Range', 'If-Range'].includes(name))) };
      if (method === 'POST') {
        method = 'GET'; body = null;
        delete requestHeaders['content-type'];
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      error.retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'));
      throw error;
    }
    return response;
  }
}
