import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join, relative, dirname, extname, isAbsolute, sep } from 'node:path';
import { transformCss, transformHtml, transformModule, transformSvg, sanitizeRenderedHtml, sanitizeRenderedSvg, isLoginDocument } from './mirror-document.mjs';
import { parseRobots, wildcardMatch } from './mirror-robots.mjs';
import { replaceCheckpoint } from './checkpoint.mjs';

const MANIFEST = 'sahm-mirror.json';
const sensitiveParameters = /(?:^|[-_.])(?:token|auth(?:orization)?|api[_-]?key|password|passwd|secret|session(?:id)?|signature|sig|credentials?|cookie|jwt|csrf|xsrf|nonce)(?:$|[-_.])|^(?:phpsessid|jsessionid)$/i;
const defaults = { depth: 3, maxPages: 200, maxResources: 2000, maxBytes: 256 * 1024 ** 2, maxFileBytes: 32 * 1024 ** 2, concurrency: 4, requestTimeout: 30000, renderMode: 'static', renderWaitMs: 1000, hashRoutes: false, respectRobots: true, externalAssets: true, include: [], exclude: [] };
const quotaError = error => ['DOWNLOAD_QUOTA_EXCEEDED', 'DOWNLOAD_QUOTA_STORAGE_ERROR'].includes(error?.code);
const sessionError = error => ['SITE_SESSION_REQUIRED', 'SITE_SESSION_EXPIRED'].includes(error?.code);
const policyError = error => quotaError(error) || sessionError(error);
const expiredSession = () => Object.assign(new Error('انتهت جلسة الموقع. سجّل الدخول مجددًا لمتابعة النسخ.'), { code: 'SITE_SESSION_EXPIRED' });
const renderWarnings = new Set(['resource-http-error', 'resource-network-error', 'script-error', 'dom-not-settled', 'pending-resources']);
const bounds = { depth: [0, 20], maxPages: [1, 5000], maxResources: [1, 20000], maxBytes: [1024, 10 * 1024 ** 3], maxFileBytes: [1024, 1024 ** 3], concurrency: [1, 8], requestTimeout: [1000, 120000], renderWaitMs: [0, 10000] };

export function normalizeMirrorOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('خيارات نسخ الموقع غير صالحة.');
  const options = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (bounds[key]) {
      const [minimum, maximum] = bounds[key];
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`خيار نسخ الموقع خارج الحد: ${key}`);
    } else if (key === 'renderMode') {
      if (!['static', 'browser'].includes(value)) throw new Error('وضع عرض نسخ الموقع غير صالح.');
    } else if (['respectRobots', 'externalAssets', 'hashRoutes'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`خيار نسخ الموقع غير صالح: ${key}`);
    } else if (['include', 'exclude'].includes(key)) {
      if (!Array.isArray(value) || value.length > 50 || value.some(item => typeof item !== 'string' || !item || item.length > 500 || /[\r\n\0]/.test(item))) throw new Error(`مرشحات نسخ الموقع غير صالحة: ${key}`);
    } else throw new Error(`خيار نسخ الموقع غير معروف: ${key}`);
    options[key] = value;
  }
  if (options.hashRoutes && options.renderMode !== 'browser') throw new Error('يتطلب نسخ مسارات hash حفظ لقطة بعد تشغيل JavaScript.');
  return options;
}

function publicUrl(input, base, hashRoutes = false) {
  if (typeof input !== 'string' || input.length > 8192 || /[\r\n\0]/.test(input)) throw new Error('رابط نسخ الموقع غير صالح.');
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => sensitiveParameters.test(key.replace(/([a-z])([A-Z])/g, '$1-$2')))) throw new Error('يتطلب ناسخ المواقع رابط HTTP أو HTTPS عامًا بلا بيانات دخول أو رموز جلسة.');
  if (hashRoutes && /^#!?\//.test(url.hash)) {
    let route;
    try { route = decodeURIComponent(url.hash.slice(1).replace(/^!/, '')); } catch { throw new Error('مسار hash غير صالح.'); }
    if (route.startsWith('//') || /[\x00-\x1f\x7f\\]/.test(route) || route.length > 2048) throw new Error('مسار hash غير صالح.');
    const query = route.indexOf('?');
    if (query >= 0 && [...new URLSearchParams(route.slice(query + 1)).keys()].some(key => sensitiveParameters.test(key.replace(/([a-z])([A-Z])/g, '$1-$2')))) throw new Error('لا يمكن حفظ رموز الدخول في مسار hash.');
  } else url.hash = '';
  return url.href;
}

export function normalizeMirrorUrl(input, { hashRoutes = false } = {}) { return publicUrl(input, undefined, hashRoutes); }

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function glob(pattern, address) {
  const parsed = new URL(address);
  const target = pattern.includes('://') ? address : parsed.pathname + parsed.search + parsed.hash;
  return wildcardMatch(pattern, target);
}
export function isSessionEndingUrl(address) {
  const url = new URL(address);
  if (/^#!?\//.test(url.hash)) {
    try { if (isSessionEndingUrl(new URL(decodeURIComponent(url.hash.slice(1).replace(/^!/, '')), url.origin).href)) return true; } catch {}
  }
  const action = value => /^(?:logout|signout|logoff|signoff)$/i.test(value.replace(/[\s_-]/g, ''));
  if (url.pathname.split('/').some(segment => {
    try { return action(decodeURIComponent(segment).replace(/\.(?:php|aspx?|jsp|cgi|html?)$/i, '')); }
    catch { return false; }
  })) return true;
  return [...url.searchParams].some(([name, value]) => /^(?:action|command|do|event)$/i.test(name) && action(value) || action(name) && /^(?:|1|true)$/i.test(value));
}
function isHtml(type) { return /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type); }
function isCss(type, url) { return /^text\/css(?:;|$)/i.test(type) || /\.css$/i.test(new URL(url).pathname); }
function isJavaScript(type, url) { return /(?:javascript|ecmascript)/i.test(type) || /\.(?:m?js)$/i.test(new URL(url).pathname); }
function isSvg(type) { return /^image\/svg\+xml(?:;|$)/i.test(type); }
function isTextual(resource) { return isHtml(resource.contentType) || isCss(resource.contentType, resource.finalUrl || resource.url) || isJavaScript(resource.contentType, resource.finalUrl || resource.url) || isSvg(resource.contentType); }
function decode(buffer, type) {
  const declared = type.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const embedded = buffer.subarray(0, 2048).toString('ascii').match(/(?:charset\s*=\s*["']?([^\s;"'/>]+)|encoding\s*=\s*["']([^"']+))/i);
  try { return new TextDecoder(declared || embedded?.[1] || embedded?.[2] || 'utf-8').decode(buffer); }
  catch { return buffer.toString('utf8'); }
}
function resourcePath(resource, rootUrl) {
  if (isHtml(resource.contentType)) return resource.url === rootUrl ? 'index.html' : `pages/${resource.id}.html`;
  return `assets/${resource.id}${extension(resource.contentType, resource.finalUrl || resource.url)}`;
}
function extension(type, url) {
  const known = { 'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'font/woff2': '.woff2', 'font/woff': '.woff', 'application/pdf': '.pdf', 'application/json': '.json' };
  const candidate = known[type.split(';')[0].trim().toLowerCase()] || extname(new URL(url).pathname);
  return /^\.[a-z0-9]{1,10}$/i.test(candidate) ? candidate.toLowerCase() : '.bin';
}
function safePath(root, local) {
  if (typeof local !== 'string' || !local || local.includes('\0') || isAbsolute(local)) throw new Error('مسار ملف النسخة غير آمن.');
  const target = resolve(root, local), relation = relative(root, target);
  if (!relation || relation.startsWith('..' + sep) || relation === '..' || isAbsolute(relation)) throw new Error('مسار ملف النسخة خارج المجلد.');
  return target;
}
async function rejectSymlinkParents(root, target) {
  const realRoot = await realpath(root);
  let parent = dirname(target);
  while (parent !== root && parent !== dirname(parent)) {
    try {
      const actual = await realpath(parent), relation = relative(realRoot, actual);
      if (relation.startsWith('..' + sep) || relation === '..' || isAbsolute(relation)) throw new Error('لا يمكن الكتابة عبر رابط مجلد خارج مجلد النسخة.');
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    parent = dirname(parent);
  }
}
async function atomicWrite(root, local, content) {
  const file = safePath(root, local);
  await rejectSymlinkParents(root, file);
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + randomUUID();
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await replaceCheckpoint(temporary, file);
}

export async function readSiteMirror(directory) {
  const root = resolve(directory), manifest = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
  if (manifest.version !== 1 || manifest.entryPath !== 'index.html' || !Array.isArray(manifest.resources) || manifest.resources.length > 20000) throw new Error('ملف النسخة غير صالح.');
  manifest.options = normalizeMirrorOptions(manifest.options);
  manifest.rootUrl = publicUrl(manifest.rootUrl, undefined, manifest.options.hashRoutes);
  manifest.snapshotMode ??= manifest.options.renderMode === 'browser' ? 'frozen' : 'static';
  if (!['static', 'frozen'].includes(manifest.snapshotMode)) throw new Error('وضع مستندات النسخة غير صالح.');
  const ids = new Set();
  for (const resource of manifest.resources) {
    if (!resource || resource.id !== hash(publicUrl(resource.url, undefined, manifest.options.hashRoutes && resource.kind === 'page')) || ids.has(resource.id) || !['page', 'asset'].includes(resource.kind) || !['pending', 'fetching', 'complete', 'failed'].includes(resource.state) || !Number.isInteger(resource.depth) || resource.depth < 0 || resource.depth > 20 || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0) throw new Error('سجل ملفات النسخة غير صالح.');
    ids.add(resource.id);
    if (resource.rawPath !== `.sahm-mirror/raw/${resource.id}.bin`) throw new Error('مسار ملف المصدر غير صالح.');
    safePath(root, resource.rawPath);
    if (resource.path) {
      const valid = resource.url === manifest.rootUrl && resource.path === 'index.html' || resource.path === `pages/${resource.id}.html` || new RegExp(`^assets/${resource.id}\\.[a-z0-9]{1,10}$`).test(resource.path);
      if (!valid) throw new Error('مسار ملف النسخة غير صالح.');
      safePath(root, resource.path);
    }
    if (resource.finalUrl) publicUrl(resource.finalUrl, undefined, manifest.options.hashRoutes && resource.kind === 'page');
  }
  return manifest;
}

/** Networking is injected; browser pages may use an isolated, authenticated DOM renderer. */
export async function runSiteMirror(rootInput, directory, { signal, onProgress = () => {}, fetchImpl = fetch, renderPage, privateSession = false, options: inputOptions = {} } = {}) {
  let policyFailure;
  if (typeof fetchImpl !== 'function' || typeof onProgress !== 'function' || typeof privateSession !== 'boolean') throw new Error('واجهة شبكة ناسخ المواقع غير صالحة.');
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  let manifest;
  try { manifest = await readSiteMirror(root); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(root)).length) throw new Error('اختر مجلدًا فارغًا لنسخة الموقع حتى لا تُستبدل ملفات موجودة.');
  }
  const options = normalizeMirrorOptions(manifest ? { ...manifest.options, ...inputOptions } : inputOptions);
  const rootUrl = publicUrl(rootInput, undefined, options.hashRoutes), rootOrigin = new URL(rootUrl).origin;
  const frozenDocuments = privateSession || options.renderMode === 'browser';
  if (options.renderMode === 'browser' && typeof renderPage !== 'function') throw new Error('يتطلب نسخ المحتوى الديناميكي جلسة عرض في المتصفح.');
  if (manifest && manifest.rootUrl !== rootUrl) throw new Error('المجلد يحتوي نسخة لموقع آخر. اختر مجلدًا جديدًا.');
  if (manifest && manifest.options.renderMode !== options.renderMode) throw new Error('اختر مجلدًا جديدًا لتغيير وضع عرض نسخة الموقع.');
  if (manifest && manifest.options.hashRoutes !== options.hashRoutes) throw new Error('اختر مجلدًا جديدًا لتغيير طريقة حفظ مسارات hash.');
  const snapshotMode = frozenDocuments ? 'frozen' : 'static';
  if (manifest && manifest.snapshotMode !== snapshotMode) throw new Error('اختر مجلدًا جديدًا لتغيير وضع مستندات نسخة الموقع.');
  manifest ||= { version: 1, rootUrl, options, snapshotMode, state: 'running', createdAt: new Date().toISOString(), entryPath: 'index.html', resources: [], errors: [], stats: {} };
  manifest.options = options; manifest.state = 'running'; manifest.errors = [];
  const resources = new Map(manifest.resources.map(resource => [resource.url, resource])), robots = new Map();
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeout)]) : AbortSignal.timeout(options.requestTimeout);
  let reservedBytes = 0, saving = Promise.resolve(), active = 0, stoppedByLimit = false;
  for (const resource of resources.values()) {
    if (resource.state !== 'complete') { resource.state = 'pending'; resource.bytes = 0; continue; }
    try { const file = await lstat(safePath(root, resource.rawPath)); if (!file.isFile() || file.isSymbolicLink() || file.size !== resource.bytes) throw new Error('missing'); }
    catch { resource.state = 'pending'; resource.bytes = 0; }
  }
  const stats = () => {
    const values = { pages: 0, files: 0, pending: 0, failed: 0, bytes: 0, active };
    for (const item of resources.values()) {
      if (item.state === 'complete') { values.files++; values.bytes += item.bytes; if (item.kind === 'page') values.pages++; }
      else if (item.state === 'pending') values.pending++;
      else if (item.state === 'failed') values.failed++;
    }
    return values;
  };
  const progress = current => { manifest.stats = stats(); try { onProgress({ state: manifest.state, rootUrl, directory: root, entryPath: manifest.entryPath, ...manifest.stats, current: current || null, errors: manifest.errors.slice(-20) }); } catch {} };
  const save = () => {
    manifest.updatedAt = new Date().toISOString(); manifest.stats = stats(); manifest.resources = [...resources.values()];
    const serialized = JSON.stringify(manifest, null, 2);
    saving = saving.then(() => atomicWrite(root, MANIFEST, serialized));
    return saving;
  };
  const record = (url, reason) => { if (manifest.errors.length < 2000 && !manifest.errors.some(item => item.url === url && item.reason === reason)) manifest.errors.push({ url, reason }); };
  const allowed = (url, kind, depth) => {
    if (privateSession && isSessionEndingUrl(url)) return 'session-action-excluded';
    if (kind === 'page' && new URL(url).origin !== rootOrigin) return 'outside-origin';
    if (kind === 'asset' && !options.externalAssets && new URL(url).origin !== rootOrigin) return 'outside-origin';
    if (kind === 'page' && depth > options.depth) return 'depth-limit';
    if (options.exclude.some(pattern => glob(pattern, url))) return 'excluded';
    if (kind === 'page' && options.include.length && !options.include.some(pattern => glob(pattern, url)) && url !== rootUrl) return 'not-included';
    return null;
  };
  const enqueue = (url, kind, depth) => {
    if (resources.has(url)) return resources.get(url);
    const rejection = allowed(url, kind, depth);
    if (rejection) { record(url, rejection); return null; }
    if (resources.size >= options.maxResources || (kind === 'page' && [...resources.values()].filter(item => item.kind === 'page').length >= options.maxPages)) { record(url, resources.size >= options.maxResources ? 'resource-limit' : 'page-limit'); stoppedByLimit = true; return null; }
    const id = hash(url), resource = { id, url, kind, depth, state: 'pending', bytes: 0, rawPath: `.sahm-mirror/raw/${id}.bin` };
    resources.set(url, resource); return resource;
  };
  enqueue(rootUrl, 'page', 0);
  const fetchFollowing = async (url, kind, depth, checkRobots = true) => {
    let current = url;
    for (let redirects = 0; redirects <= 10; redirects++) {
      signal?.throwIfAborted();
      const rejection = allowed(current, kind, depth);
      if (rejection) throw new Error(rejection);
      if (checkRobots && options.respectRobots && !(await robotsAllows(current))) throw new Error('robots-disallowed');
      const response = options.renderMode === 'browser' && kind === 'page'
        ? await renderPage(current, { signal: requestSignal(), options: { ...options } })
        : await fetchImpl(current, { method: 'GET', signal: requestSignal(), redirect: 'manual', headers: { 'User-Agent': 'SAHM-SiteMirror/0.6', Accept: kind === 'page' ? 'text/html,application/xhtml+xml,*/*;q=0.5' : '*/*' } });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        let next;
        try { next = publicUrl(response.headers.get('location'), current, options.hashRoutes && kind === 'page'); }
        finally { await response.body?.cancel(); }
        if (redirects === 10) throw new Error('redirect-limit');
        current = next; continue;
      }
      // A custom transport must not silently follow a redirect outside the policy.
      let finalUrl;
      try { finalUrl = response.url ? publicUrl(response.url, undefined, options.hashRoutes && kind === 'page') : current; }
      catch (error) { await response.body?.cancel(); throw error; }
      if (finalUrl !== current) {
        const rejection = allowed(finalUrl, kind, depth);
        if (rejection) { await response.body?.cancel(); throw new Error(rejection); }
        current = finalUrl;
      }
      return { response, url: current };
    }
  };
  const readLimited = async (response, maximum) => {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) { await response.body?.cancel(); throw new Error('file-byte-limit'); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body || []) {
      signal?.throwIfAborted();
      const buffer = Buffer.from(chunk);
      if (length + buffer.length > maximum) throw new Error('file-byte-limit');
      chunks.push(buffer); length += buffer.length;
    }
    return Buffer.concat(chunks);
  };
  const robotsAllows = async url => {
    const origin = new URL(url).origin;
    if (!robots.has(origin)) robots.set(origin, (async () => {
      try {
        // robots is fetched separately: no recursion, and no cross-origin redirect.
        let current = origin + '/robots.txt';
        for (let hops = 0; hops < 6; hops++) {
          signal?.throwIfAborted();
          const response = await fetchImpl(current, { method: 'GET', signal: requestSignal(), redirect: 'manual', headers: { 'User-Agent': 'SAHM-SiteMirror/0.6', Accept: 'text/plain' } });
          if (response.url && new URL(response.url).origin !== origin) { await response.body?.cancel(); return () => false; }
          if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const next = publicUrl(response.headers.get('location'), current); await response.body?.cancel();
            if (new URL(next).origin !== origin) return () => false;
            current = next; continue;
          }
          if (response.status === 401 || response.status === 403 || response.status >= 500) { await response.body?.cancel(); return () => false; }
          if (!response.ok) { await response.body?.cancel(); return () => true; }
          return parseRobots((await readLimited(response, 512 * 1024)).toString('utf8'));
        }
        return () => false;
      } catch (error) { if (signal?.aborted || policyError(error)) throw error; record(origin + '/robots.txt', 'robots-unavailable'); return () => false; }
    })());
    return (await robots.get(origin))(url);
  };
  function transform(content, resource, offline) {
    const sourceUrl = resource.finalUrl || resource.url;
    const resolver = (address, kind, base = sourceUrl) => {
      const trimmed = address.trim();
      const routedFragment = options.hashRoutes && kind === 'page' && /^#!?\//.test(trimmed);
      if (!trimmed || trimmed.startsWith('#') && !routedFragment || /^data:/i.test(trimmed) || (kind === 'page' && /^(?:mailto|tel):/i.test(trimmed))) return address;
      let url, fragment;
      try { const parsed = new URL(trimmed, base); url = publicUrl(parsed.href, undefined, options.hashRoutes && kind === 'page'); fragment = new URL(url).hash ? '' : parsed.hash; }
      catch { return offline ? unavailable(resource) : address; }
      if (!offline) { enqueue(url, kind, kind === 'page' ? resource.depth + 1 : resource.depth); return address; }
      const target = resources.get(url) || [...resources.values()].find(item => item.finalUrl === url);
      if (target?.state !== 'complete' || !target.path) return unavailable(resource);
      const local = relative(dirname(safePath(root, resource.path)), safePath(root, target.path)).split(sep).join('/');
      return (local.startsWith('.') ? local : './' + local) + fragment;
    };
    if (isHtml(resource.contentType)) return transformHtml(content, sourceUrl, resolver, { offline, rendered: frozenDocuments });
    if (isSvg(resource.contentType)) return transformSvg(content, sourceUrl, resolver, { offline });
    if (isCss(resource.contentType, sourceUrl)) return transformCss(content, resolver).replace(/^\s*@charset\s+[^;]+;/i, '@charset "UTF-8";');
    if (isJavaScript(resource.contentType, sourceUrl)) return transformModule(content, resolver);
    return content;
  }
  function unavailable(resource) {
    const local = relative(dirname(safePath(root, resource.path)), safePath(root, '_sahm/unavailable.html')).split(sep).join('/');
    return local.startsWith('.') ? local : './' + local;
  }
  const processResource = async resource => {
    resource.state = 'fetching'; active++; progress(resource.url);
    let received = 0;
    try {
      const { response, url } = await fetchFollowing(resource.url, resource.kind, resource.depth);
      if (privateSession && resource.kind === 'page' && [401, 403].includes(response.status)) { await response.body?.cancel(); throw expiredSession(); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      if (options.renderMode === 'browser' && resource.kind === 'page') {
        for (const warning of (response.headers.get('x-sahm-render-warning') || '').split(',').map(item => item.trim())) if (renderWarnings.has(warning)) record(resource.url, 'render-' + warning);
      }
      resource.contentType = response.headers.get('content-type') || 'application/octet-stream';
      for (const [header, field] of [['etag', 'etag'], ['last-modified', 'lastModified']]) {
        const value = response.headers.get(header);
        if (value && value.length <= 8192) resource[field] = value; else delete resource[field];
      }
      // Account per request directly so simultaneous readers share one total-byte budget.
      const chunks = []; const maximum = Math.min(options.maxFileBytes, options.maxBytes);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maximum) { await response.body?.cancel(); throw new Error('file-byte-limit'); }
      for await (const chunk of response.body || []) {
        signal?.throwIfAborted(); const buffer = Buffer.from(chunk);
        if (received + buffer.length > maximum) throw new Error('file-byte-limit');
        if (stats().bytes + reservedBytes + buffer.length > options.maxBytes) { stoppedByLimit = true; throw new Error('total-byte-limit'); }
        chunks.push(buffer); received += buffer.length; reservedBytes += buffer.length;
      }
      let buffer = Buffer.concat(chunks);
      if (frozenDocuments && (isHtml(resource.contentType) || isSvg(resource.contentType))) {
        const document = decode(buffer, resource.contentType);
        if (isHtml(resource.contentType)) {
          if (privateSession && resource.kind === 'page' && isLoginDocument(document, url)) throw expiredSession();
          buffer = Buffer.from(sanitizeRenderedHtml(document), 'utf8');
          resource.contentType = 'text/html; charset=utf-8';
        } else {
          buffer = Buffer.from(sanitizeRenderedSvg(document), 'utf8');
          resource.contentType = 'image/svg+xml; charset=utf-8';
        }
        if (buffer.length > maximum) throw new Error('file-byte-limit');
        if (stats().bytes + reservedBytes - received + buffer.length > options.maxBytes) { stoppedByLimit = true; throw new Error('total-byte-limit'); }
      }
      resource.finalUrl = url;
      resource.path = resourcePath(resource, rootUrl);
      if (resource.url === rootUrl && !isHtml(resource.contentType)) throw new Error('root-not-html');
      await atomicWrite(root, resource.rawPath, buffer);
      resource.bytes = buffer.length; resource.state = 'complete'; delete resource.error; reservedBytes -= received; received = 0;
      if (isTextual(resource)) transform(decode(buffer, resource.contentType), resource, false);
      await save();
    } catch (error) {
      const blocked = policyError(error);
      if (blocked) policyFailure ||= error;
      resource.state = signal?.aborted || blocked ? 'pending' : 'failed'; resource.bytes = 0;
      if (!signal?.aborted && !blocked) { resource.error = /^HTTP \d+$|^[a-z][a-z-]+$/.test(error.message) ? error.message : 'network-or-file-error'; record(resource.url, resource.error); }
    } finally { reservedBytes -= received; active--; progress(); }
  };
  // Re-discover retained documents when resuming: newly raised limits can expose more
  // resources, and excluded/out-of-scope links remain represented in the report.
  for (const resource of [...resources.values()]) {
    if (resource.state === 'complete' && isTextual(resource)) transform(decode(await readFile(safePath(root, resource.rawPath)), resource.contentType), resource, false);
  }
  await save();
  try {
    while (!signal?.aborted) {
      const pending = [...resources.values()].filter(resource => resource.state === 'pending').slice(0, options.concurrency);
      if (!pending.length) break;
      await Promise.all(pending.map(processResource));
      if (policyFailure) throw policyFailure;
      await save();
    }
    // Rebuild documents from retained originals, including after a partial run resumes.
    for (const resource of resources.values()) {
      if (resource.state !== 'complete') continue;
      const buffer = await readFile(safePath(root, resource.rawPath));
      await atomicWrite(root, resource.path, isTextual(resource) ? transform(decode(buffer, resource.contentType), resource, true) : buffer);
    }
    await atomicWrite(root, '_sahm/unavailable.html', '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>المورد غير محفوظ</title><h1>هذا المورد غير محفوظ في النسخة المحلية</h1><p>قد يكون خارج حدود الموقع أو مستثنى أو تعذّر تنزيله. راجع سجل نسخ الموقع في سَهم.</p></html>');
    manifest.state = signal?.aborted ? 'paused' : manifest.errors.length || stoppedByLimit ? 'partial' : 'complete';
  } catch (error) {
    manifest.state = signal?.aborted || policyError(error) ? 'paused' : 'error';
    if (!signal?.aborted && !policyError(error)) record(rootUrl, 'local-write-error');
    await save(); progress();
    if (!signal?.aborted) throw error;
  }
  await save(); progress();
  return structuredClone(manifest);
}
