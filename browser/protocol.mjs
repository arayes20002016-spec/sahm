import { timingSafeEqual } from 'node:crypto';
import { validateBrowserFile } from './completed-file.mjs';
import { directMediaUrl, streamMediaUrl, MEDIA_QUALITIES, youtubeUrl } from './extension/media-policy.mjs';
import { validateMediaSelection } from './extension/media-selection.mjs';

export const HOST_NAME = 'com.sahm.downloader';
export const EXTENSION_ID = 'gcmfkngegmhhnifcffmhggfgmajmmpof';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
// 256 KiB request bytes expand to ~350 KiB in base64; remain below native messaging's 1 MiB response limit.
export const MAX_MESSAGE_BYTES = 512 * 1024;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_HEADER_BYTES = 32 * 1024;
const allowedHeaders = new Set(['cookie', 'authorization', 'content-type', 'referer', 'origin', 'accept', 'accept-language', 'user-agent', 'x-csrf-token', 'x-xsrf-token', 'x-requested-with']);
const sessionHeaders = new Set(['cookie', 'authorization', 'x-csrf-token', 'x-xsrf-token']);

function validateContext(context, method) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.method !== method || !['GET', 'POST'].includes(method)) throw new Error('Invalid request context');
  if (!context.headers || typeof context.headers !== 'object' || Array.isArray(context.headers)) throw new Error('Invalid request headers');
  const headers = {};
  let headerBytes = 0;
  for (const [rawName, value] of Object.entries(context.headers)) {
    const name = rawName.toLowerCase();
    if (!allowedHeaders.has(name) || headers[name] !== undefined || typeof value !== 'string' || value.length > 16384 || /[\0\r\n]/.test(value)) throw new Error('Unsupported request headers');
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > MAX_HEADER_BYTES) throw new Error('Request headers exceed the supported size');
    headers[name] = value;
  }
  const result = { method, headers };
  if (method === 'POST') {
    const body = context.bodyBase64;
    if (typeof body !== 'string' || body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) throw new Error('Invalid request body');
    const bytes = Buffer.from(body, 'base64');
    if (bytes.length > MAX_BODY_BYTES || bytes.toString('base64') !== body || /^multipart\//i.test(headers['content-type'] || '')) throw new Error('Unsupported request body');
    result.bodyBase64 = body;
  } else if (context.bodyBase64 !== undefined) throw new Error('GET request cannot contain a body');
  return result;
}

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > MAX_MESSAGE_BYTES) throw new Error('Message exceeds the supported size');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class MessageDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE_BYTES) throw new Error('Invalid message length');
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Expected a message object');
      this.onMessage(message);
    }
  }

  finish() {
    if (this.buffer.length) throw new Error('Truncated message');
  }
}

export function validToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length === 64 && timingSafeEqual(a, b);
}

export function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid download URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  return url.href;
}

export function validateRequest(message, now = Date.now()) {
  if (message.v !== 1 || !['ping', 'enqueue', 'media-info', 'media-enqueue', 'browser-complete'].includes(message.type)) throw new Error('Unsupported request');
  if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(message.requestId)) throw new Error('Invalid request id');
  if (message.type === 'ping') return { v: 1, type: 'ping', requestId: message.requestId };
  if (!Number.isSafeInteger(message.expiresAt) || message.expiresAt < now || message.expiresAt > now + 15000) throw new Error('Request has expired');
  if (message.type === 'browser-complete') {
    if (message.source !== 'automatic' || message.method !== 'POST' || message.requestObserved !== true
      || message.postApproved !== true || message.attachment !== true || message.state !== 'complete'
      || message.danger !== 'safe' || message.incognito || message.byExtensionId
      || typeof message.usesCredentials !== 'boolean' || (message.usesCredentials && message.sessionApproved !== true)
      || message.requestContext !== undefined) throw new Error('Completed POST requires an approved safe browser download');
    return { v: 1, type: message.type, requestId: message.requestId, expiresAt: message.expiresAt,
      source: 'automatic', method: 'POST', url: httpUrl(message.url), browserFile: validateBrowserFile(message.browserFile),
      usesCredentials: message.usesCredentials, sessionApproved: message.sessionApproved === true, postApproved: true,
      requestObserved: true, attachment: true, state: 'complete', danger: 'safe' };
  }
  if (message.type === 'media-info' || message.type === 'media-enqueue') {
    if (message.source !== 'video-overlay' || !['direct', 'youtube', 'stream'].includes(message.kind)) throw new Error('Unsupported media source');
    let url;
    if (message.kind === 'youtube') url = youtubeUrl(message.url);
    else if (message.kind === 'stream') url = streamMediaUrl(message.url);
    else url = directMediaUrl(message.url);
    if (!url || (message.type === 'media-info' && message.kind === 'direct')) throw new Error('Unsupported media URL');
    const quality = message.quality || 'best';
    if (!MEDIA_QUALITIES.includes(quality)) throw new Error('Unsupported media quality');
    const selection = validateMediaSelection(message);
    if (message.kind === 'direct' && (selection.container !== 'auto' || selection.audioTrack !== 'default')) throw new Error('Direct files cannot select media formats');
    if (message.kind !== 'direct' && message.requestContext !== undefined) throw new Error('Media session transfer is unsupported');
    const requestContext = message.requestContext === undefined ? undefined : validateContext(message.requestContext, 'GET');
    const usesCredentials = Boolean(requestContext && Object.keys(requestContext.headers).some(name => sessionHeaders.has(name)));
    if (usesCredentials && message.sessionApproved !== true) throw new Error('Session transfer requires consent');
    return { v: 1, type: message.type, requestId: message.requestId, expiresAt: message.expiresAt, source: 'video-overlay', kind: message.kind, url, quality, ...selection, title: typeof message.title === 'string' ? message.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 400) : '', method: 'GET', requestContext, usesCredentials, sessionApproved: message.sessionApproved === true };
  }
  if (!['automatic', 'context-menu'].includes(message.source)) throw new Error('Unsupported download source');
  let requestContext;
  if (message.source === 'automatic') {
    if (message.method === 'POST') throw new Error('POST replay is disabled; update the extension to import the original completed download');
    if (!['GET', 'POST'].includes(message.method) || message.requestObserved !== true || typeof message.usesCredentials !== 'boolean') throw new Error('Browser request cannot be safely captured');
    if (message.requestContext !== undefined) requestContext = validateContext(message.requestContext, message.method);
    const carriesSession = requestContext && Object.keys(requestContext.headers).some(name => sessionHeaders.has(name));
    if ((message.usesCredentials || carriesSession) && (message.sessionApproved !== true || !requestContext)) throw new Error('Session transfer requires consent');
    if (message.method === 'POST' && (message.postApproved !== true || message.attachment !== true || !requestContext)) throw new Error('POST transfer requires an observed attachment and consent');
  } else if (message.requestContext !== undefined || (message.method !== undefined && message.method !== 'GET')) throw new Error('Unsupported manual request');
  const url = httpUrl(message.url);
  const name = typeof message.name === 'string' ? message.name.slice(0, 260) : '';
  const mime = typeof message.mime === 'string' ? message.mime.split(';')[0].trim().toLowerCase().slice(0, 128) : '';
  const totalBytes = Number.isSafeInteger(message.totalBytes) && message.totalBytes >= 0 ? message.totalBytes : null;
  return { v: 1, type: 'enqueue', requestId: message.requestId, expiresAt: message.expiresAt, source: message.source, url, name, mime, totalBytes, method: message.method || 'GET', requestObserved: message.requestObserved, usesCredentials: message.usesCredentials, requestContext, attachment: message.attachment, sessionApproved: message.sessionApproved === true, postApproved: message.postApproved === true };
}
