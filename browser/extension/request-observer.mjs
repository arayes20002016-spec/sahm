import { supportedUrl } from './capture-policy.mjs';
import { directMediaUrl, streamMediaUrl } from './media-policy.mjs';

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_HEADER_BYTES = 32 * 1024;
export const REQUEST_TTL = 60_000;
export const MEDIA_TTL = 10 * 60_000;
const MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const ALLOWED_HEADERS = new Set(['cookie', 'authorization', 'content-type', 'referer', 'origin', 'accept', 'accept-language', 'user-agent', 'x-csrf-token', 'x-xsrf-token', 'x-requested-with']);
const SESSION_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token', 'x-xsrf-token']);
const encoder = new TextEncoder();
const MAX_MEDIA_CANDIDATES = 64;

export class RequestObserver {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.requests = new Map();
    this.media = new Map();
  }

  clear() { this.requests.clear(); this.media.clear(); }

  prune() {
    const now = this.now();
    for (const [id, request] of this.requests) if (now - request.time > REQUEST_TTL) this.requests.delete(id);
    for (const [id, item] of this.media) if (now - item.time > MEDIA_TTL) this.media.delete(id);
    while (this.media.size > MAX_MEDIA_CANDIDATES) this.media.delete(this.media.keys().next().value);
    let bytes = 0;
    for (const request of this.requests.values()) bytes += request.retainedBytes;
    while (this.requests.size > 128 || bytes > MAX_RETAINED_BYTES) {
      const id = this.requests.keys().next().value;
      bytes -= this.requests.get(id).retainedBytes;
      this.requests.delete(id);
    }
  }

  beforeRequest(details, settings) {
    this.prune();
    if (typeof details.requestId === 'string' && !this.requests.has(details.requestId) && ['main_frame', 'sub_frame'].includes(details.type)) {
      const inNavigation = item => item.tabId === details.tabId && (details.type === 'main_frame' || item.frameId === details.frameId);
      for (const [id, item] of this.requests) if (inNavigation(item)) this.requests.delete(id);
      for (const [id, item] of this.media) if (inNavigation(item)) this.media.delete(id);
    }
    if (!settings.enabled || details.incognito || !supportedUrl(details.url) || typeof details.requestId !== 'string') return;
    const domain = new URL(details.url).hostname;
    if (settings.excludedDomains.some(value => domain === value || domain.endsWith(`.${value}`))) return;
    const previous = this.requests.get(details.requestId);
    const urls = new Set(previous?.urls || []);
    urls.add(details.url);
    const metadataBytes = [...urls].reduce((sum, url) => sum + encoder.encode(url).length, 0);
    this.requests.set(details.requestId, {
      requestId: details.requestId, urls, url: details.url, method: details.method,
      tabId: details.tabId, frameId: details.frameId, documentId: details.documentId,
      headers: {}, usesCredentials: null, time: this.now(),
      attachment: false, headersObserved: false, metadataBytes,
      retainedBytes: metadataBytes,
    });
    this.prune();
  }

  beforeHeaders(details, settings) {
    const request = this.requests.get(details.requestId);
    if (!request || request.url !== details.url) return;
    if (request.method === 'POST') {
      request.usesCredentials = (details.requestHeaders || []).some(header => SESSION_HEADERS.has(header.name.toLowerCase()) || header.name.toLowerCase() === 'proxy-authorization');
      request.headersObserved = true;
      request.time = this.now();
      return;
    }
    const headers = {};
    let headerBytes = 0;
    let unsupported = false;
    let usesCredentials = false;
    for (const header of details.requestHeaders || []) {
      const name = header.name.toLowerCase();
      if (SESSION_HEADERS.has(name) || name === 'proxy-authorization') usesCredentials = true;
      if (!ALLOWED_HEADERS.has(name) || (!settings.allowSession && SESSION_HEADERS.has(name))) continue;
      if (!settings.allowSession) continue;
      if (typeof header.value !== 'string' || /[\0\r\n]/.test(header.value) || header.value.length > 16384) { unsupported = true; break; }
      headerBytes += encoder.encode(name).length + encoder.encode(header.value).length;
      if (headerBytes > MAX_HEADER_BYTES) { unsupported = true; break; }
      if (headers[name] !== undefined && name !== 'cookie') { unsupported = true; break; }
      headers[name] = headers[name] === undefined ? header.value : `${headers[name]}; ${header.value}`;
    }
    request.headers = unsupported ? {} : headers;
    request.usesCredentials = usesCredentials;
    request.headersObserved = !unsupported;
    request.retainedBytes = request.metadataBytes + (unsupported ? 0 : headerBytes);
    request.time = this.now();
    this.prune();
  }

  responseHeaders(details) {
    const request = this.requests.get(details.requestId);
    if (!request || request.url !== details.url) return;
    request.attachment = (details.responseHeaders || []).some(header => header.name.toLowerCase() === 'content-disposition' && /^\s*attachment(?:\s*;|\s*$)/i.test(header.value || ''));
    request.responseStatus = details.statusCode;
    if (request.method !== 'GET' || !request.headersObserved || ![200, 206].includes(details.statusCode) || !Number.isInteger(request.tabId) || request.tabId < 0) return;
    const headers = Object.fromEntries((details.responseHeaders || []).filter(header => typeof header.value === 'string').map(header => [header.name.toLowerCase(), header.value]));
    const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase().slice(0, 120);
    const manifest = streamMediaUrl(request.url);
    const direct = mime.startsWith('video/') && !/\.(?:ts|m4s)$/i.test(new URL(request.url).pathname) ? directMediaUrl(request.url) : null;
    if (!manifest && !direct) return;
    const length = Number(/^bytes \d+-\d+\/(\d+)$/i.exec(headers['content-range'] || '')?.[1] || headers['content-length']);
    const key = `${request.tabId}:${request.frameId}:${request.url}`;
    const previous = this.media.get(key);
    this.media.delete(key);
    this.media.set(key, {
      id: previous?.id || request.requestId, url: request.url, kind: manifest ? 'stream' : 'direct',
      mime, bytes: Number.isSafeInteger(length) && length > 0 ? length : null,
      tabId: request.tabId, frameId: request.frameId, documentId: request.documentId, time: this.now(),
      requiresSession: request.usesCredentials === true,
    });
    this.prune();
  }

  take(item) {
    this.prune();
    const finalUrl = item.finalUrl || item.url;
    const candidates = [...this.requests.values()].filter(request => request.url === finalUrl && request.urls.has(item.url));
    // DownloadItem has no webRequest id. An ambiguous URL must stay in the browser.
    if (candidates.length !== 1) return undefined;
    const request = candidates[0];
    this.requests.delete(request.requestId);
    if (!request.headersObserved) return undefined;
    const contextNeeded = request.method === 'GET' && (request.usesCredentials || ['referer', 'origin', 'x-requested-with'].some(name => request.headers[name] !== undefined));
    const requestContext = contextNeeded ? { method: request.method, headers: request.headers } : undefined;
    return {
      method: request.method, usesCredentials: request.usesCredentials, time: request.time,
      attachment: request.attachment, bodyAvailable: false, requestContext,
      responseStatus: request.responseStatus,
    };
  }

  mediaContext(url, sender) {
    this.prune();
    const candidates = [...this.requests.values()].filter(request => request.url === url && request.method === 'GET' && request.headersObserved && request.tabId === sender.tab.id && request.frameId === sender.frameId && (!sender.documentId || !request.documentId || sender.documentId === request.documentId));
    candidates.sort((a, b) => b.time - a.time);
    const request = candidates[0];
    if (!request) return undefined;
    return { usesCredentials: request.usesCredentials, requestContext: { method: 'GET', headers: { ...request.headers } } };
  }

  mediaCandidates(sender, settings, { allFrames = false } = {}) {
    this.prune();
    if (!settings.enabled || !settings.showVideoButton) return [];
    return [...this.media.values()].filter(item => {
      if (item.tabId !== sender.tab.id || (!allFrames && item.frameId !== sender.frameId)) return false;
      if (!allFrames && sender.documentId && item.documentId && sender.documentId !== item.documentId) return false;
      const domain = new URL(item.url).hostname;
      return !settings.excludedDomains.some(value => domain === value || domain.endsWith(`.${value}`));
    }).map(({ id, url, kind, mime, bytes, frameId, requiresSession }) => ({ id, url, kind, mime, bytes, frameId, requiresSession }));
  }
}
