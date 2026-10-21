const { t: __sahmT } = require('./locale.cjs');
const { randomUUID } = require('node:crypto');
const { snapshotDocument } = require('./site-browser-snapshot.cjs');
const { SiteBrowserTransport } = require('./site-browser-transport.cjs');

const MAX_SESSIONS = 8;
const MAX_HTML_BYTES = 16 * 1024 * 1024;
function siteError(message, code = 'SITE_BROWSER_ERROR') { return Object.assign(new Error(message), { code }); }
function address(input) {
  let url;
  try { url = new URL(input); } catch { throw siteError(__sahmT("رابط الموقع غير صالح."), 'SITE_BROWSER_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw siteError(__sahmT("استخدم رابط HTTP أو HTTPS دون بيانات دخول في الرابط."), 'SITE_BROWSER_URL');
  return url;
}
function metadata(record) {
  return { id: record.id, origin: record.origin, url: record.rootUrl, createdAt: record.createdAt, label: new URL(record.origin).host };
}
function withAbort(task, signal) {
  if (!signal) return Promise.resolve(task);
  if (signal.aborted) return Promise.reject(signal.reason || siteError(__sahmT("أُلغيت العملية."), 'ABORT_ERR'));
  return new Promise((resolve, reject) => {
    const aborted = () => { reject(signal.reason || siteError(__sahmT("أُلغيت العملية."), 'ABORT_ERR')); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function boundedOptions(options = {}) {
  return {
    requestTimeout: Math.max(1000, Math.min(120_000, Number(options.requestTimeout) || 30_000)),
    renderWaitMs: options.renderWaitMs === undefined ? 1000 : Math.max(0, Math.min(10_000, Number(options.renderWaitMs) || 0))
  };
}

class SiteBrowserService {
  constructor({ app, BrowserWindow, session, Menu, net, network, parent, onChange = () => {} }) {
    Object.assign(this, { app, BrowserWindow, session, Menu, net: net || require('electron').net, network, parent, onChange });
    this.records = new Map();
    this.nativeRequests = new Map();
    this.closed = false;
    this.authenticationHandler = (event, contents, details, authInfo, callback) => {
      for (const record of this.records.values()) {
        const proxy = record.proxy;
        if (!proxy || !authInfo.isProxy || authInfo.scheme.toLowerCase() !== 'basic' || authInfo.host !== proxy.hostname || Number(authInfo.port) !== Number(proxy.port) || authInfo.realm !== 'SAHM') continue;
        if (contents && !record.contents.has(contents.id)) continue;
        event.preventDefault();
        if (details.firstAuthAttempt === false) callback();
        else callback(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password));
        return;
      }
      if (contents && [...this.records.values()].some(record => record.contents.has(contents.id))) {
        // Configured origin authentication runs through the main-process transport.
        event.preventDefault(); callback();
      }
    };
    app.on('login', this.authenticationHandler);
    this.clientCertificateHandler = (event, contents, url, _, callback) => {
      const ownedWindow = contents && [...this.records.values()].some(record => record.contents.has(contents.id));
      if (ownedWindow || !contents && this.nativeRequests.has(url)) {
        // Configured PFX identities use the scoped transport, not the Windows store.
        event.preventDefault(); callback();
      }
    };
    app.on('select-client-certificate', this.clientCertificateHandler);
  }
  snapshot() { return [...this.records.values()].filter(record => record.approved && !record.temporary && !record.disposed).map(metadata); }
  pendingSnapshot() { return [...this.records.values()].filter(record => !record.approved && !record.disposed && record.resolveLogin).map(metadata); }
  get(id) { const record = this.records.get(id); return record?.approved && !record.temporary && !record.disposed ? metadata(record) : undefined; }
  hasActive() { return [...this.records.values()].some(record => record.runner || record.preparing || record.resolveLogin); }
  async #configureProxy(record) {
    const proxy = new URL(await this.network.externalProxy());
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || !proxy.username || !proxy.password) throw siteError(__sahmT("تعذّر إنشاء اتصال المتصفح عبر إعدادات الشبكة."), 'SITE_BROWSER_PROXY');
    record.proxy = proxy;
    await record.session.setProxy({ mode: 'fixed_servers', proxyRules: `http=${proxy.hostname}:${proxy.port};https=${proxy.hostname}:${proxy.port}`, proxyBypassRules: '<-loopback>' });
    await record.session.closeAllConnections();
  }
  async #createRecord(rootUrl, temporary = false) {
    if (this.closed) throw siteError(__sahmT("خدمة جلسات المواقع مغلقة."), 'SITE_BROWSER_CLOSED');
    if (this.records.size >= MAX_SESSIONS) throw siteError(__sahmT("أغلق جلسة موقع قبل فتح جلسة جديدة."), 'SITE_BROWSER_SESSION_LIMIT');
    const root = address(rootUrl);
    const { isSessionEndingUrl } = await import('../src/site-mirror.mjs');
    const id = randomUUID();
    const ses = this.session.fromPartition(`sahm-site-${id}`, { cache: false });
    const record = { id, origin: root.origin, rootUrl: root.href, createdAt: new Date().toISOString(), session: ses, contents: new Set(), windows: new Set(), approved: false, temporary, disposed: false, rendering: null, runner: null, controller: new AbortController(), sequence: Promise.resolve() };
    record.transport = new SiteBrowserTransport({ network: this.network, record });
    this.records.set(id, record);
    ses.setPermissionRequestHandler((_, __, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.allowNTLMCredentialsForDomains('');
    ses.on('will-download', event => event.preventDefault());
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let url;
      try { url = new URL(details.url); } catch { callback({ cancel: true }); return; }
      const protocolAllowed = ['http:', 'https:', 'data:', 'blob:', 'about:'].includes(url.protocol);
      const render = record.rendering;
      const escapedPage = render && details.resourceType === 'mainFrame' && ['http:', 'https:'].includes(url.protocol) && url.origin !== record.origin;
      const sessionAction = render && !record.temporary && ['http:', 'https:'].includes(url.protocol) && isSessionEndingUrl(url.href);
      if (escapedPage) render.failure = siteError(__sahmT("أُوقف تحويل صفحة النسخ إلى موقع آخر."), 'SITE_BROWSER_ORIGIN_REDIRECT');
      if (render && details.webContentsId === record.renderWindow?.webContents.id && ['http:', 'https:'].includes(url.protocol) && !escapedPage && !sessionAction) render.requests.add(details.id);
      if (render && (!protocolAllowed || sessionAction)) render.policyBlocked.add(details.id);
      callback({ cancel: !protocolAllowed || !!escapedPage || !!sessionAction || record.disposed });
    });
    ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const render = record.rendering;
      if (render && details.resourceType === 'mainFrame' && details.webContentsId === record.renderWindow?.webContents.id) {
        const headers = new Headers();
        for (const [name, values] of Object.entries(details.responseHeaders || {})) for (const value of values) headers.append(name, value);
        render.status = details.statusCode;
        render.headers = headers;
        render.url = details.url;
        const type = headers.get('content-type') || '';
        if (details.statusCode >= 200 && details.statusCode < 300 && type && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type)) {
          render.failure = siteError(__sahmT("الرابط يعيد ملفًا وليس صفحة HTML قابلة للعرض."), 'SITE_BROWSER_NOT_HTML');
          callback({ cancel: true }); return;
        }
      }
      callback({});
    });
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, details => {
      const render = record.rendering;
      if (!render || details.webContentsId !== record.renderWindow?.webContents.id) return;
      render.requests.delete(details.id);
      if (details.resourceType !== 'mainFrame' && details.statusCode >= 400 && new URL(details.url).pathname !== '/favicon.ico') render.warnings.add('resource-http-error');
    });
    ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, details => {
      const render = record.rendering;
      if (!render || details.webContentsId !== record.renderWindow?.webContents.id) return;
      render.requests.delete(details.id);
      if (details.resourceType !== 'mainFrame' && !render.policyBlocked.has(details.id) && details.error !== 'net::ERR_ABORTED' && new URL(details.url).pathname !== '/favicon.ico') render.warnings.add('resource-network-error');
    });
    try {
      await this.#configureProxy(record);
      if (record.disposed || this.closed) throw siteError(__sahmT("خدمة جلسات المواقع مغلقة."), 'SITE_BROWSER_CLOSED');
      record.loginWindow = this.#createWindow(record, true);
      await record.loginWindow.loadURL('about:blank');
      await record.transport.attach(record.loginWindow);
      return record;
    } catch (error) { await this.#dispose(record); throw error; }
  }
  #createWindow(record, main = false, renderer = false) {
    const parent = typeof this.parent === 'function' ? this.parent() : this.parent;
    const window = new this.BrowserWindow({
      width: 1080, height: 780, minWidth: 720, minHeight: 520, show: false,
      paintWhenInitiallyHidden: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      title: __sahmT("تسجيل الدخول — {0}", [record.origin]), backgroundColor: '#ffffff',
      webPreferences: { session: record.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true, navigateOnDragDrop: false, devTools: false, backgroundThrottling: false, ...(renderer ? { offscreen: true } : {}) }
    });
    record.windows.add(window);
    const contentsId = window.webContents.id;
    record.contents.add(contentsId);
    window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    if (renderer) {
      window.setTitle(__sahmT("عرض الموقع — {0}", [record.origin]));
      window.webContents.setFrameRate(20);
      window.webContents.on('paint', () => {});
    }
    if (!main) window.setMenu(null);
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('page-title-updated', event => { event.preventDefault(); });
    window.webContents.on('console-message', details => {
      if (record.rendering && details.level === 'error' && !/^Failed to load resource:/i.test(details.message)) record.rendering.warnings.add('script-error');
    });
    const guard = (event, target) => {
      let valid = false;
      try { valid = ['http:', 'https:'].includes(new URL(target).protocol); } catch {}
      if (!valid) event.preventDefault();
    };
    window.webContents.on('will-navigate', guard);
    window.webContents.on('will-redirect', (event, target) => {
      guard(event, target);
      if (record.rendering) {
        try {
          if (new URL(target).origin !== record.origin) {
            event.preventDefault();
            record.rendering.failure = siteError(__sahmT("أُوقف تحويل صفحة النسخ إلى موقع آخر."), 'SITE_BROWSER_ORIGIN_REDIRECT');
          }
        } catch { event.preventDefault(); }
      }
    });
    window.webContents.setWindowOpenHandler(details => {
      let url;
      try { url = address(details.url); } catch { return { action: 'deny' }; }
      if (record.approved || record.windows.size >= 4) return { action: 'deny' };
      const popup = this.#createWindow(record);
      popup.loadURL('about:blank').then(() => record.transport.attach(popup)).then(() => popup.loadURL(url.href)).catch(() => {});
      popup.show();
      return { action: 'deny' };
    });
    window.webContents.on('did-navigate', () => {
      if (!main) {
        try { window.setTitle(`${renderer ? __sahmT("عرض الموقع") : __sahmT("تسجيل الدخول")} — ${new URL(window.webContents.getURL()).origin}`); } catch {}
      }
      this.#updateMenu(record);
    });
    window.webContents.on('did-navigate-in-page', () => this.#updateMenu(record));
    window.webContents.on('did-finish-load', () => this.#updateMenu(record));
    window.on('closed', () => {
      record.windows.delete(window); record.contents.delete(contentsId);
      if (main && !record.disposed) {
        record.rejectLogin?.(siteError(__sahmT("أُلغيت جلسة تسجيل الدخول."), 'SITE_LOGIN_CANCELLED'));
        this.#dispose(record).catch(() => {});
      }
    });
    if (main) record.menuWindow = window;
    this.#updateMenu(record);
    return window;
  }
  refreshLocale() { for (const record of this.records.values()) this.#updateMenu(record); }
  #updateMenu(record) {
    const window = record.menuWindow;
    if (!window || window.isDestroyed()) return;
    let sameOrigin = false;
    let visibleOrigin = record.origin;
    try { visibleOrigin = new URL(window.webContents.getURL()).origin; sameOrigin = visibleOrigin === record.origin; } catch {}
    const ready = sameOrigin && !window.webContents.isLoadingMainFrame() && !record.approved;
    const menu = this.Menu.buildFromTemplate([
      { label: __sahmT("جلسة الموقع"), submenu: [
        { id: 'sahm-use-site-session', label: __sahmT("استخدام الجلسة لهذا الموقع"), enabled: ready, click: () => { this.approveLogin(record.id).catch(() => {}); } },
        { type: 'separator' },
        { label: __sahmT("رجوع"), enabled: window.webContents.navigationHistory.canGoBack(), click: () => window.webContents.navigationHistory.goBack() },
        { label: __sahmT("إعادة تحميل"), click: () => window.webContents.reload() },
        { type: 'separator' },
        { label: __sahmT("إلغاء"), click: () => window.close() }
      ] }
    ]);
    window.setMenu(menu);
    window.setTitle(`${record.approved ? __sahmT("جلسة الموقع") : __sahmT("تسجيل الدخول")} — ${visibleOrigin === 'null' ? record.origin : visibleOrigin}`);
  }
  async openLogin(rootUrl) {
    const record = await this.#createRecord(rootUrl);
    const pending = new Promise((resolve, reject) => { record.resolveLogin = resolve; record.rejectLogin = reject; });
    record.loginWindow.show();
    record.loginWindow.loadURL(record.rootUrl).catch(() => { this.#updateMenu(record); });
    this.onChange(this.snapshot());
    return pending;
  }
  async approveLogin(id) {
    const record = this.records.get(id);
    if (!record || record.disposed || record.approved || !record.resolveLogin) throw siteError(__sahmT("جلسة تسجيل الدخول غير متاحة."), 'SITE_LOGIN_UNAVAILABLE');
    let current;
    try { current = address(record.loginWindow.webContents.getURL()); } catch { throw siteError(__sahmT("عُد إلى الموقع الأصلي قبل اعتماد الجلسة."), 'SITE_LOGIN_WRONG_ORIGIN'); }
    if (current.origin !== record.origin || record.loginWindow.webContents.isLoadingMainFrame()) throw siteError(__sahmT("عُد إلى الموقع الأصلي وانتظر اكتمال الصفحة قبل اعتماد الجلسة."), 'SITE_LOGIN_WRONG_ORIGIN');
    const storage = await record.loginWindow.webContents.executeJavaScriptInIsolatedWorld(838, [{ code: 'JSON.stringify(Object.entries(sessionStorage))' }]);
    if (Buffer.byteLength(storage, 'utf8') > 2 * 1024 * 1024) throw siteError(__sahmT("بيانات جلسة الموقع أكبر من الحد المتاح للنسخ."), 'SITE_SESSION_STORAGE_LIMIT');
    record.sessionStorage = JSON.parse(storage);
    record.approved = true;
    for (const window of [...record.windows]) if (window !== record.loginWindow) window.destroy();
    record.loginWindow.hide();
    await record.loginWindow.loadURL('about:blank');
    this.#updateMenu(record);
    const resolve = record.resolveLogin;
    record.resolveLogin = null; record.rejectLogin = null;
    resolve(metadata(record));
    this.onChange(this.snapshot());
    return metadata(record);
  }
  async #renderer(record, signal) {
    if (record.renderWindow && !record.renderWindow.isDestroyed()) return record.renderWindow;
    const window = this.#createWindow(record, false, true);
    record.renderWindow = window;
    await withAbort(window.loadURL('about:blank'), signal);
    await withAbort(record.transport.attach(window), signal);
    if (record.sessionStorage?.length) {
      if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
      const source = `if(location.origin===${JSON.stringify(record.origin)}){for(const [key,value] of ${JSON.stringify(record.sessionStorage)})sessionStorage.setItem(key,value);}`;
      await withAbort(window.webContents.debugger.sendCommand('Page.enable'), signal);
      const script = await withAbort(window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }), signal);
      record.storageScript = script.identifier;
    }
    return window;
  }
  async createRunner({ rootUrl, sessionId, options = {}, signal } = {}) {
    const root = address(rootUrl);
    let record = sessionId ? this.records.get(sessionId) : null;
    if (sessionId && (!record?.approved || record.disposed)) throw siteError(__sahmT("انتهت جلسة الموقع. سجّل الدخول من جديد."), 'SITE_SESSION_EXPIRED');
    if (record && record.origin !== root.origin) throw siteError(__sahmT("الجلسة تخص موقعًا آخر."), 'SITE_SESSION_ORIGIN');
    if (record?.runner || record?.preparing) throw siteError(__sahmT("الجلسة مستخدمة في عملية نسخ جارية."), 'SITE_SESSION_BUSY');
    if (!record) { record = await this.#createRecord(root.href, true); record.approved = true; }
    record.preparing = true;
    try { await this.#configureProxy(record); }
    catch (error) { record.preparing = false; if (record.temporary) await this.#dispose(record); throw error; }
    if (record.disposed || this.closed) { record.preparing = false; throw siteError(__sahmT("خدمة جلسات المواقع مغلقة."), 'SITE_BROWSER_CLOSED'); }
    const controller = new AbortController();
    const lifetime = AbortSignal.any([controller.signal, record.controller.signal, ...(signal ? [signal] : [])]);
    const defaults = boundedOptions(options);
    const runner = {
      gatewayQuota: true,
      fetch: async (input, init = {}) => {
        const url = address(typeof input === 'string' || input instanceof URL ? input : input.url);
        const headers = new Headers(init.headers || {});
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'host']) if (headers.has(name)) throw siteError(__sahmT("لا يمكن تمرير بيانات دخول خام إلى جلسة الموقع."), 'SITE_BROWSER_RAW_CREDENTIALS');
        const requestSignal = AbortSignal.any([lifetime, AbortSignal.timeout(defaults.requestTimeout), ...(init.signal ? [init.signal] : [])]);
        await this.network.quota?.assertAvailable({ signal: requestSignal });
        const response = await this.#fetch(record, url, { ...init, headers, signal: requestSignal });
        if (response.status === 502) {
          try { await this.network.quota?.assertAvailable({ signal: requestSignal }); }
          catch (error) { await response.body?.cancel(); throw error; }
        }
        return response;
      },
      render: (url, init = {}) => {
        const operation = () => this.#render(record, address(url), { ...defaults, ...boundedOptions({ ...options, ...init.options }) }, AbortSignal.any([lifetime, ...(init.signal ? [init.signal] : [])]));
        const result = record.sequence.then(operation, operation);
        record.sequence = result.catch(() => {});
        return result;
      },
      close: async () => {
        if (record.runner !== runner) return;
        controller.abort(siteError(__sahmT("أُغلقت جلسة النسخ."), 'ABORT_ERR'));
        await record.sequence;
        if (record.runner !== runner) return;
        try {
          if (record.temporary) await this.#dispose(record);
          else if (record.renderWindow && !record.renderWindow.isDestroyed()) {
            record.renderWindow.webContents.stop();
            await record.session.closeAllConnections();
            await record.renderWindow.loadURL('about:blank').catch(() => {});
          }
        } finally { record.runner = null; this.onChange(this.snapshot()); }
      }
    };
    record.runner = runner;
    record.preparing = false;
    this.onChange(this.snapshot());
    return runner;
  }
  #fetch(record, url, init) {
    init.signal.throwIfAborted();
    const method = String(init.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method) || init.body !== undefined) throw siteError(__sahmT("ناسخ المواقع يقرأ روابط GET وHEAD فقط."), 'SITE_BROWSER_METHOD');
    if (record.transport.enabled(url.href)) return record.transport.fetchResource(url, init);
    return new Promise((resolve, reject) => {
      const request = this.net.request({ url: url.href, method, session: record.session, credentials: url.origin === record.origin ? 'include' : 'omit', redirect: 'manual', headers: Object.fromEntries(init.headers), bypassCustomProtocolHandlers: true });
      this.nativeRequests.set(url.href, (this.nativeRequests.get(url.href) || 0) + 1);
      let resolved = false, ended = false, bodyController;
      let cleaned = false;
      const clean = () => {
        if (cleaned) return;
        cleaned = true;
        init.signal.removeEventListener('abort', aborted);
        const count = this.nativeRequests.get(url.href) || 0;
        if (count <= 1) this.nativeRequests.delete(url.href); else this.nativeRequests.set(url.href, count - 1);
      };
      const fail = error => {
        if (ended) return;
        ended = true; clean();
        Promise.resolve().then(async () => {
          if (!init.signal.aborted) {
            try { await this.network.quota?.assertAvailable({ signal: init.signal }); }
            catch (quotaError) { error = quotaError; }
          }
          if (!resolved) reject(error);
          else bodyController?.error(error);
        });
      };
      const aborted = () => { fail(init.signal.reason || siteError(__sahmT("أُلغيت قراءة المورد."), 'ABORT_ERR')); request.abort(); };
      init.signal.addEventListener('abort', aborted, { once: true });
      const responseFor = (body, status, entries) => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(entries)) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
        const response = new Response(body, { status, headers });
        Object.defineProperty(response, 'url', { value: url.href, configurable: true });
        return response;
      };
      request.on('login', (authInfo, callback) => {
        const proxy = record.proxy;
        if (authInfo.isProxy && authInfo.scheme.toLowerCase() === 'basic' && authInfo.host === proxy.hostname && Number(authInfo.port) === Number(proxy.port) && authInfo.realm === 'SAHM') callback(decodeURIComponent(proxy.username), decodeURIComponent(proxy.password));
        else callback();
      });
      request.on('redirect', (status, _, __, headers) => {
        if (ended) return;
        try { const response = responseFor(null, status, headers); resolved = true; resolve(response); ended = true; clean(); }
        catch (error) { fail(error); }
        // No followRedirect call: Chromium cancels before sending the next request.
      });
      request.on('error', error => fail(error));
      request.on('response', incoming => {
        if (ended) return;
        const noBody = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
        const body = noBody ? null : new ReadableStream({
          start(controller) { bodyController = controller; },
          cancel() { ended = true; clean(); request.abort(); }
        }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength });
        incoming.on('end', () => { if (!ended) { ended = true; clean(); bodyController?.close(); } });
        incoming.on('error', fail);
        incoming.on('aborted', () => fail(siteError(__sahmT("انقطع نقل مورد الموقع."), 'SITE_BROWSER_RESPONSE_ABORTED')));
        incoming.on('data', chunk => {
          if (ended || !bodyController) return;
          if (bodyController.desiredSize < -8 * 1024 * 1024) { fail(siteError(__sahmT("تجاوز المورد سعة القراءة المؤقتة."), 'SITE_BROWSER_RESPONSE_BUFFER')); request.abort(); return; }
          bodyController.enqueue(chunk);
        });
        try { const response = responseFor(body, incoming.statusCode, incoming.headers); resolved = true; resolve(response); }
        catch (error) { fail(error); request.abort(); }
      });
      request.end();
    });
  }
  async #settlePage(record, active, options, deadline) {
    const waitMs = options.renderWaitMs;
    if (!waitMs) return 0;
    const started = Date.now();
    const remaining = () => Math.max(0, waitMs - (Date.now() - started));
    const pause = milliseconds => withAbort(new Promise(resolve => setTimeout(resolve, milliseconds)), deadline);
    const evaluate = code => withAbort(record.renderWindow.webContents.executeJavaScriptInIsolatedWorld(838, [{ code }]), deadline);
    const frame = async () => {
      if (!remaining()) return false;
      try {
        const captureSignal = AbortSignal.any([deadline, AbortSignal.timeout(Math.min(350, remaining()))]);
        await withAbort(record.renderWindow.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: false, stayAwake: false }), captureSignal);
        return true;
      } catch (error) {
        if (deadline.aborted) throw error;
        active.warnings.add('dom-not-settled'); return false;
      }
    };
    // loadURL can finish before the application's first asynchronous API response.
    // Let that response install its observers before moving the viewport.
    const initialWait = Math.min(300, waitMs * 0.35);
    while (Date.now() - started < initialWait || active.requests.size && Date.now() - started < waitMs * 0.55) {
      await pause(Math.min(40, remaining()));
      if (!remaining()) return 0;
    }
    const original = await evaluate('({x:scrollX,y:scrollY})');
    try {
      for (let step = 0; step < 12 && remaining() > 100; step += 1) {
        const position = await evaluate('(()=>{const before=scrollY;scrollBy(0,Math.max(300,innerHeight*0.8));return{before,after:scrollY}})()');
        const painted = await frame();
        // The observer callback is delivered after the compositor frame.
        await pause(Math.min(45, remaining()));
        if (!painted || position.after === position.before) break;
      }
    } finally {
      await evaluate(`scrollTo(${JSON.stringify(original.x)},${JSON.stringify(original.y)})`);
      if (remaining()) await frame();
    }
    return remaining();
  }
  async #render(record, url, options, signal) {
    if (url.origin !== record.origin) throw siteError(__sahmT("عرض صفحات النسخ متاح داخل الموقع الأصلي فقط."), 'SITE_BROWSER_ORIGIN');
    signal.throwIfAborted();
    await this.network.quota?.assertAvailable({ signal });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeout)]);
    const window = await withAbort(this.#renderer(record, deadline), deadline);
    if (window.isDestroyed() || record.disposed) throw siteError(__sahmT("انتهت جلسة الموقع."), 'SITE_SESSION_EXPIRED');
    const active = { status: 200, headers: new Headers(), url: url.href, requestTimeout: options.requestTimeout, failure: null, requests: new Set(), policyBlocked: new Set(), warnings: new Set() };
    record.rendering = active;
    const aborted = () => window.isDestroyed() || window.webContents.stop();
    deadline.addEventListener('abort', aborted, { once: true });
    try {
      window.webContents.startPainting();
      await withAbort(window.loadURL(url.href), deadline);
      if (active.failure) throw active.failure;
      const finalUrl = address(window.webContents.getURL());
      if (finalUrl.origin !== record.origin) throw siteError(__sahmT("أُوقف تحويل صفحة النسخ إلى موقع آخر."), 'SITE_BROWSER_ORIGIN_REDIRECT');
      if (record.storageScript) {
        await withAbort(window.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: record.storageScript }), deadline);
        record.storageScript = null; record.sessionStorage = null;
      }
      const waitMs = await this.#settlePage(record, active, options, deadline);
      const snapshot = await withAbort(window.webContents.executeJavaScriptInIsolatedWorld(838, [{ code: `(${snapshotDocument.toString()})(${JSON.stringify({ waitMs, maximumBytes: MAX_HTML_BYTES })})` }]), deadline);
      if (address(snapshot.url).origin !== record.origin) throw siteError(__sahmT("تغيّر موقع الصفحة أثناء النسخ."), 'SITE_BROWSER_ORIGIN_REDIRECT');
      const { sanitizeRenderedHtml, isLoginDocument } = await import('../src/mirror-document.mjs');
      if (!record.temporary && ([401, 403].includes(active.status) || snapshot.isLoginPage || isLoginDocument(snapshot.html, finalUrl.href))) throw siteError(__sahmT("انتهت جلسة الموقع. سجّل الدخول من جديد."), 'SITE_SESSION_EXPIRED');
      const html = sanitizeRenderedHtml(snapshot.html);
      const storage = await withAbort(window.webContents.executeJavaScriptInIsolatedWorld(838, [{ code: 'JSON.stringify(Object.entries(sessionStorage))' }]), deadline);
      if (Buffer.byteLength(storage, 'utf8') > 2 * 1024 * 1024) throw siteError(__sahmT("بيانات جلسة الموقع أكبر من الحد المتاح للنسخ."), 'SITE_SESSION_STORAGE_LIMIT');
      record.sessionStorage = JSON.parse(storage);
      if (!snapshot.settled) active.warnings.add('dom-not-settled');
      if (active.requests.size) active.warnings.add('pending-resources');
      const responseHeaders = { 'content-type': 'text/html; charset=utf-8', 'x-sahm-rendered': '1' };
      if (active.warnings.size) responseHeaders['x-sahm-render-warning'] = [...active.warnings].join(',');
      const response = new Response(html, { status: active.status >= 200 && active.status <= 599 ? active.status : 200, headers: responseHeaders });
      Object.defineProperty(response, 'url', { value: finalUrl.href, configurable: true });
      return response;
    } catch (error) {
      if (!deadline.aborted) await this.network.quota?.assertAvailable({ signal: deadline });
      if (!record.temporary && [401, 403].includes(active.status)) throw siteError(__sahmT("انتهت جلسة الموقع. سجّل الدخول من جديد."), 'SITE_SESSION_EXPIRED');
      if (active.failure) throw active.failure;
      if (deadline.aborted) throw deadline.reason || siteError(__sahmT("انتهت مهلة عرض الصفحة."), 'SITE_BROWSER_TIMEOUT');
      if (error.code?.startsWith('SITE_')) throw error;
      throw siteError(__sahmT("تعذّر عرض صفحة الموقع داخل جلسة النسخ."), 'SITE_BROWSER_RENDER_FAILED');
    } finally {
      deadline.removeEventListener('abort', aborted);
      if (!window.isDestroyed()) window.webContents.stop();
      record.transport.cancel(window);
      record.rendering = null;
      if (!window.isDestroyed() && !record.disposed) {
        // Stop page timers/background API calls once its inert DOM has been read.
        await withAbort(window.loadURL('about:blank'), AbortSignal.timeout(5000)).catch(() => {});
        window.webContents.stopPainting();
      }
    }
  }
  async #dispose(record) {
    if (record.disposed) return;
    record.disposed = true;
    record.controller.abort(siteError(__sahmT("أُغلقت جلسة الموقع."), 'ABORT_ERR'));
    record.transport.close();
    record.rejectLogin?.(siteError(__sahmT("أُلغيت جلسة تسجيل الدخول."), 'SITE_LOGIN_CANCELLED'));
    record.resolveLogin = null; record.rejectLogin = null;
    for (const window of [...record.windows]) if (!window.isDestroyed()) window.destroy();
    this.records.delete(record.id);
    await Promise.allSettled([record.session.closeAllConnections(), record.session.clearStorageData(), record.session.clearCache(), record.session.clearAuthCache()]);
    this.onChange(this.snapshot());
  }
  async removeSession(id) {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.runner || record.preparing) throw siteError(__sahmT("أوقف نسخ الموقع قبل حذف جلسته."), 'SITE_SESSION_BUSY');
    await this.#dispose(record); return true;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.records.values()].map(record => this.#dispose(record)));
    this.app.removeListener('login', this.authenticationHandler);
    this.app.removeListener('select-client-certificate', this.clientCertificateHandler);
  }
}

module.exports = { SiteBrowserService };

