const { t: __sahmT } = require('./locale.cjs');
const { getSetCookies } = require('undici');

const MAX_BODY = 4 * 1024 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
const transportError = (message, code = 'SITE_BROWSER_TRANSPORT') => Object.assign(new Error(message), { code });

function requestBody(request) {
  let body;
  if (request.postDataEntries?.length) {
    if (request.postDataEntries.some(entry => typeof entry.bytes !== 'string' || entry.bytes.length > Math.ceil(MAX_BODY / 3) * 4)) throw transportError(__sahmT("رفع الملفات غير متاح في نافذة المصادقة المؤسسية."), 'SITE_BROWSER_UPLOAD');
    const chunks = []; let size = 0;
    for (const entry of request.postDataEntries) {
      const chunk = Buffer.from(entry.bytes, 'base64'); size += chunk.length;
      if (size > MAX_BODY) throw transportError(__sahmT("طلب الصفحة أكبر من 4 ميجابايت."), 'SITE_BROWSER_UPLOAD');
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks, size);
  } else if (typeof request.postData === 'string') {
    if (Buffer.byteLength(request.postData) > MAX_BODY) throw transportError(__sahmT("طلب الصفحة أكبر من 4 ميجابايت."), 'SITE_BROWSER_UPLOAD');
    body = Buffer.from(request.postData);
  }
  else if (request.hasPostData) throw transportError(__sahmT("تعذّرت قراءة جسم طلب الصفحة."), 'SITE_BROWSER_UPLOAD');
  if (body?.length > MAX_BODY) throw transportError(__sahmT("طلب الصفحة أكبر من 4 ميجابايت."), 'SITE_BROWSER_UPLOAD');
  return body;
}

async function responseBody(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE) { await response.body?.cancel(); throw transportError(__sahmT("مورد العرض أكبر من 32 ميجابايت."), 'SITE_BROWSER_RESOURCE_LIMIT'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    signal.throwIfAborted(); size += chunk.byteLength;
    if (size > MAX_RESPONSE) throw transportError(__sahmT("مورد العرض أكبر من 32 ميجابايت."), 'SITE_BROWSER_RESOURCE_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class SiteBrowserTransport {
  constructor({ network, record }) {
    this.network = network; this.record = record; this.windows = new Map();
    const fetch = (input, init) => network.browserFetch(input, init);
    this.fetch = network.quota ? network.quota.wrapFetch(fetch) : fetch;
  }
  enabled(url) { return new URL(url).origin === this.record.origin && this.network.requiresBrowserTransport?.(url) === true; }
  async attach(window) {
    if (!this.enabled(this.record.rootUrl) || this.windows.has(window)) return;
    const debug = window.webContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    const pending = new Map();
    const state = { debug, pending, mainFrame: null };
    const command = async (method, params) => {
      let timer;
      try { return await Promise.race([debug.sendCommand(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(transportError(__sahmT("انتهت مهلة تجهيز اتصال نافذة الموقع."))), 10000); })]); }
      finally { clearTimeout(timer); }
    };
    const message = (_, method, params) => {
      if (method === 'Network.loadingFailed') {
        for (const item of pending.values()) if (item.networkId === params.requestId) item.controller.abort(transportError(__sahmT("أُلغي طلب الصفحة."), 'ABORT_ERR'));
      }
      if (method === 'Fetch.requestPaused') void this.#dispatch(state, params).catch(() => {});
    };
    state.message = message;
    this.windows.set(window, state);
    debug.on('message', message);
    window.once('closed', () => this.detach(window));
    try {
      await command('Page.enable');
      state.mainFrame = (await command('Page.getFrameTree')).frameTree.frame.id;
      await command('Network.enable');
      await command('Network.setBypassServiceWorker', { bypass: true });
      await command('Fetch.enable', { patterns: [{ urlPattern: this.record.origin + '/*', requestStage: 'Request' }] });
    } catch (error) { this.detach(window); throw error; }
  }
  async #dispatch(state, params) {
    const { requestId, request } = params;
    if (!this.enabled(request.url)) { await state.debug.sendCommand('Fetch.continueRequest', { requestId }); return; }
    const controller = new AbortController();
    const item = { controller, networkId: params.networkId };
    state.pending.set(requestId, item);
    const signal = AbortSignal.any([controller.signal, this.record.controller.signal, AbortSignal.timeout(this.record.rendering?.requestTimeout || 30000)]);
    let response;
    try {
      const headers = new Headers(request.headers);
      for (const name of ['host', 'connection', 'content-length', 'proxy-authorization', 'proxy-connection', 'transfer-encoding']) headers.delete(name);
      response = await this.fetch(request.url, { method: request.method, headers, body: requestBody(request), redirect: 'manual', signal });
      const body = await responseBody(response, signal);
      signal.throwIfAborted();
      const responseHeaders = [...response.headers].filter(([name]) => name !== 'set-cookie' && name !== 'content-length').map(([name, value]) => ({ name, value }));
      for (const value of response.headers.getSetCookie()) responseHeaders.push({ name: 'Set-Cookie', value });
      if (request.method !== 'HEAD' && ![204, 205, 304].includes(response.status)) responseHeaders.push({ name: 'Content-Length', value: String(body.length) });
      const active = this.record.rendering;
      if (active && params.resourceType === 'Document' && params.frameId === state.mainFrame) {
        active.status = response.status; active.headers = new Headers(response.headers); active.url = request.url;
      }
      await state.debug.sendCommand('Fetch.fulfillRequest', { requestId, responseCode: response.status, responseHeaders, body: body.toString('base64') });
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      const active = this.record.rendering;
      if (active && params.resourceType === 'Document' && params.frameId === state.mainFrame) active.failure = transportError(__sahmT("تعذّر توثيق اتصال عرض الموقع. راجع حساب الأصل وشهادة العميل وإعدادات الشبكة."), error.code?.startsWith('DOWNLOAD_QUOTA_') ? error.code : 'SITE_BROWSER_AUTH_TRANSPORT');
      await state.debug.sendCommand('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    } finally { state.pending.delete(requestId); }
  }
  cancel(window) {
    for (const item of this.windows.get(window)?.pending.values() || []) item.controller.abort(transportError(__sahmT("أُلغي عرض الصفحة."), 'ABORT_ERR'));
  }
  detach(window) {
    const state = this.windows.get(window);
    if (!state) return;
    this.cancel(window); this.windows.delete(window);
    state.debug.removeListener('message', state.message);
  }
  async fetchResource(url, init) {
    const headers = new Headers(init.headers);
    const cookies = await this.record.session.cookies.get({ url: url.href });
    init.signal.throwIfAborted();
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    if (Buffer.byteLength(cookie) > 32768) throw transportError(__sahmT("تجاوزت ملفات ارتباط الموقع الحد المتاح."));
    if (cookie) headers.set('cookie', cookie);
    const response = await this.fetch(url.href, { ...init, headers, redirect: 'manual' });
    try {
      for (const item of getSetCookies(response.headers).slice(0, 64)) {
        init.signal.throwIfAborted();
        const options = { url: url.href, name: item.name, value: item.value, secure: !!item.secure, httpOnly: !!item.httpOnly };
        if (item.domain) {
          const domain = item.domain.replace(/^\./, '').toLowerCase();
          if (url.hostname !== domain && !url.hostname.endsWith('.' + domain)) continue;
          options.domain = item.domain;
        }
        if (item.path) options.path = item.path;
        if (item.sameSite) options.sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[item.sameSite];
        if (Number.isFinite(item.maxAge)) options.expirationDate = Date.now() / 1000 + item.maxAge;
        else if (item.expires instanceof Date) options.expirationDate = item.expires.getTime() / 1000;
        // Chromium ignores malformed Set-Cookie fields; mirror that for resource GETs.
        await this.record.session.cookies.set(options).catch(() => {});
      }
      return response;
    } catch (error) { await response.body?.cancel(); throw error; }
  }
  close() { for (const window of this.windows.keys()) this.detach(window); }
}

module.exports = { SiteBrowserTransport, requestBody, responseBody };

