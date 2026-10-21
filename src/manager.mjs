import { EventEmitter } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { writeCheckpoint } from './checkpoint.mjs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { download } from './download.mjs';
import { normalizeRequestContext } from './request-context.mjs';
import { MediaService, normalizeDownloadMediaUrl, getMediaSource, validateMediaQuality } from './media.mjs';
import { validateMediaSelection } from './media-selection.mjs';
import { DEFAULT_QUEUE_ID, QueueStore, queueIsOpen } from './queues.mjs';
import { inspectReplacement, publishReplacement } from './refresh-address.mjs';
import { downloadFtp, parseFtpInput, normalizeFtpCredentials } from './ftp.mjs';
import { defaultDownloadCategory, normalizeDownloadRules, resolveDownloadRule } from './download-rules.mjs';
import { normalizeScannerConfig, scanDownloadedFile } from './file-scanner.mjs';
import { resolveServerRule, limitedRate } from './server-rules.mjs';
import { completedFileInfo } from '../browser/completed-file.mjs';
import { isTransientNetworkError, networkRetryPolicy, nextNetworkRetry, supportsNetworkRetry, validNetworkRetry } from './network-retry.mjs';

const recaptureMessage = 'يحتاج هذا التنزيل إلى التقاط جديد من المتصفح لاستعادة الجلسة أو طلب POST.';

export function safeName(value) {
  const clean = basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean)) return `download-${randomUUID().slice(0, 8)}`;
  return clean;
}

export function category(name) {
  return defaultDownloadCategory(name);
}

const scanErrorCodes = new Set(['scan-cancelled', 'scan-invalid-file', 'scan-file-unavailable', 'scan-program-unavailable', 'scan-arguments-too-long', 'scan-timeout', 'scan-process-stopped', 'scan-failed']);

function scanResult(value, mode, started) {
  const result = { status: 'error', code: 'scan-failed', engine: mode, exitCode: null, scannedAt: new Date().toISOString(), durationMs: Date.now() - started };
  if (value?.status === 'clean' && value.code === 'scan-clean' && value.exitCode === 0) return { ...result, status: 'clean', code: 'scan-clean', exitCode: 0 };
  if (value?.status === 'attention' && value.code === 'scan-needs-review' && Number.isInteger(value.exitCode) && value.exitCode >= -(2 ** 31) && value.exitCode <= 2 ** 32 - 1 && value.exitCode !== 0) return { ...result, status: 'attention', code: 'scan-needs-review', exitCode: value.exitCode };
  if (value?.status === 'error' && scanErrorCodes.has(value.code)) result.code = value.code;
  return result;
}

export class DownloadManager extends EventEmitter {
  #requestContexts = new Map();
  #preparedResponses = new Map();
  #ftpCredentials = new Map();
  constructor(dataDirectory, downloadDirectory, { mediaRuntimeDirectory, mediaService, network, vault, quota, scanner = scanDownloadedFile, scannerConfig, downloadRules = [], retryPolicy } = {}) {
    super();
    this.directory = dataDirectory;
    this.downloadDirectory = downloadDirectory;
    this.jobs = [];
    this.active = new Map();
    this.parallel = 2;
    this.saving = Promise.resolve();
    this.stopped = false;
    this.initialized = false;
    this.pending = new Set();
    this.speedLimit = 0;
    this.serverRules = [];
    this.network = network;
    this.retryPolicy = networkRetryPolicy(retryPolicy);
    this.vault = vault;
    this.quota = quota;
    this.scanner = scanner;
    this.scannerConfig = normalizeScannerConfig(scannerConfig);
    this.downloadRules = normalizeDownloadRules(downloadRules);
    this.networkChanging = false;
    this.media = mediaService || new MediaService({ runtimeDirectory: mediaRuntimeDirectory, network });
    this.queueStore = new QueueStore(dataDirectory);
    this.queueCursor = 0;
    this.queueOperations = Promise.resolve();
    this.removingQueues = new Set();
    this.addressRefreshes = new Map();
    this.browserImports = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    await this.queueStore.init();
    try { this.jobs = JSON.parse(await readFile(join(this.directory, 'jobs.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [index, job] of this.jobs.entries()) {
      if (!this.queueStore.get(job.queueId)) job.queueId = DEFAULT_QUEUE_ID;
      if (!Number.isSafeInteger(job.queuePosition)) job.queuePosition = this.jobs.length - index;
      if (job.status === 'complete') {
        delete job.networkRetry;
        if (job.scanResult?.status === 'running') job.scanResult = { status: 'error', code: 'scan-interrupted', engine: job.scanResult.engine === 'custom' ? 'custom' : 'defender', exitCode: null, scannedAt: new Date().toISOString(), durationMs: 0 };
        continue;
      }
      if (job.kind === 'ftp' && job.ftpAuthenticated && !this.vault?.get(job.credentialRef)) {
        job.status = 'paused'; job.needsCredentials = true; job.error = 'أدخل بيانات دخول FTP لاستئناف الملف.';
      }
      if (job.needsSession || job.method === 'POST') {
        job.status = 'paused'; job.needsRecapture = true; job.error = recaptureMessage;
      } else if (job.status === 'downloading') job.status = 'paused';
      if (job.networkRetry && (job.status !== 'queued' || !supportsNetworkRetry(job) || !validNetworkRetry(job.networkRetry, this.retryPolicy))) {
        delete job.networkRetry;
        if (job.status === 'queued') { job.status = 'paused'; job.error = 'انتهت مهلة إعادة الاتصال؛ اضغط استئناف للمحاولة مجددًا.'; }
      }
    }
    this.initialized = true;
    this.timer = setInterval(() => this.pump(), 1000);
    return this;
  }
  list() { return structuredClone(this.jobs); }
  queues() {
    return this.queueStore.list().map(queue => ({ ...queue, open: queueIsOpen(queue), count: this.jobs.filter(job => job.queueId === queue.id).length, active: this.jobs.filter(job => job.queueId === queue.id && this.active.has(job.id)).length }));
  }
  queuePosition(queueId) {
    if (!this.queueStore.get(queueId)) throw new Error('قائمة التنزيل غير موجودة.');
    if (this.removingQueues.has(queueId)) throw new Error('القائمة قيد الإزالة؛ اختر قائمة أخرى.');
    return Math.max(0, ...this.jobs.filter(job => job.queueId === queueId).map(job => job.queuePosition || 0)) + 1;
  }
  queueAction(action, data) {
    this.queueOperations = this.queueOperations.catch(() => {}).then(() => this.changeQueue(action, data));
    return this.queueOperations;
  }
  async changeQueue(action, data) {
    let result;
    if (action === 'create') result = await this.queueStore.create(data);
    else if (action === 'update') result = await this.queueStore.update(data.id, data.settings);
    else if (action === 'remove') {
      if (this.jobs.some(job => job.queueId === data.id)) throw new Error('انقل تنزيلات القائمة قبل إزالتها.');
      this.removingQueues.add(data.id);
      try { result = await this.queueStore.remove(data.id); }
      finally { this.removingQueues.delete(data.id); }
    } else if (action === 'assign') {
      if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 500 || !this.queueStore.get(data.queueId)) throw new Error('تحديد القائمة أو التنزيلات غير صالح.');
      const targets = [...new Set(data.ids)].map(id => this.jobs.find(job => job.id === id));
      if (targets.some(job => !job || this.active.has(job.id) || this.addressRefreshes.has(job.id))) throw new Error('أوقف التنزيلات المحددة وانتظر تحديث الروابط قبل نقلها.');
      const previous = targets.map(job => [job, job.queueId, job.queuePosition, job.queueHeld]);
      let position = this.queuePosition(data.queueId);
      for (const job of targets) { job.queueId = data.queueId; job.queuePosition = position++; job.queueHeld = false; }
      try { await this.save(); }
      catch (error) { for (const [job, id, order, held] of previous) { job.queueId = id; job.queuePosition = order; job.queueHeld = held; } throw error; }
    } else if (action === 'reorder') {
      if (!['up', 'down'].includes(data.direction)) throw new Error('اتجاه ترتيب غير صالح.');
      const job = this.jobs.find(value => value.id === data.id);
      if (!job || this.active.has(job.id) || this.addressRefreshes.has(job.id)) throw new Error('أوقف التنزيل وانتظر تحديث رابطه قبل تغيير ترتيبه.');
      const pending = this.jobs.filter(value => value.queueId === job.queueId && value.status !== 'complete' && !this.active.has(value.id) && !this.addressRefreshes.has(value.id)).sort((a, b) => a.queuePosition - b.queuePosition);
      const index = pending.indexOf(job);
      const other = pending[index + (data.direction === 'up' ? -1 : 1)];
      if (index !== -1 && other) {
        [job.queuePosition, other.queuePosition] = [other.queuePosition, job.queuePosition];
        try { await this.save(); }
        catch (error) { [job.queuePosition, other.queuePosition] = [other.queuePosition, job.queuePosition]; throw error; }
      }
    } else throw new Error('إجراء قائمة غير معروف.');
    this.pump();
    this.emit('queues', this.queues());
    return { queue: result, queues: this.queues() };
  }
  async save() {
    const snapshot = JSON.stringify(this.jobs, (key, value) => key === 'transferParts' ? undefined : value, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await writeCheckpoint(join(this.directory, 'jobs.json'), snapshot);
    });
    await this.saving;
    this.emit('change', this.list());
  }
  addPrepared(input, response) { return this.add(input, { preparedResponse: response }); }
  importBrowserCompleted(input) {
    const task = this.browserImports.catch(() => {}).then(() => this.#acceptBrowserCompleted(input));
    this.browserImports = task;
    return task;
  }
  async #acceptBrowserCompleted({ url, browserFile, externalId }) {
    if (this.stopped) throw new Error('سَهم قيد الإغلاق.');
    if (typeof externalId !== 'string' || !/^[a-zA-Z0-9:._-]{1,160}$/.test(externalId)) throw new Error('معرّف تنزيل المتصفح غير صالح.');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('رابط تنزيل المتصفح غير صالح.');
    const existing = this.jobs.find(job => job.externalId === externalId);
    if (existing) {
      if (existing.url !== parsed.href || existing.replayPolicy !== 'browser-completed' || existing.path !== browserFile.path || existing.total !== browserFile.bytes) throw new Error('تعارض معرّف تنزيل المتصفح.');
      return structuredClone(existing);
    }
    const file = await completedFileInfo(browserFile);
    if (this.stopped) throw new Error('سَهم قيد الإغلاق.');
    const id = randomUUID(), controller = new AbortController();
    const scan = normalizeScannerConfig(this.scannerConfig);
    const job = {
      id, url: parsed.href, name: file.name, category: this.destinationRule(parsed.href, file.name).category,
      path: file.path, connections: 1, startAt: null, source: 'browser', externalId,
      method: 'POST', needsSession: false, needsRecapture: false, replayPolicy: 'browser-completed',
      status: 'complete', received: file.bytes, total: file.bytes, speed: 0, error: null,
      createdAt: new Date().toISOString(), queueId: DEFAULT_QUEUE_ID, queuePosition: this.queuePosition(DEFAULT_QUEUE_ID),
      scanResult: { status: scan.enabled ? 'running' : 'skipped', code: scan.enabled ? 'scan-running' : 'scan-disabled', engine: scan.mode, exitCode: null, scannedAt: new Date().toISOString(), durationMs: 0 },
    };
    this.jobs.unshift(job);
    try { await this.save(); }
    catch (error) { this.jobs = this.jobs.filter(value => value.id !== id); throw error; }
    if (scan.enabled) {
      const entry = { controller, promise: null };
      this.active.set(id, entry);
      entry.promise = this.scanCompleted(job, controller.signal).finally(async () => {
        this.active.delete(id);
        await this.save().catch(error => this.emit('storage-error', error.message));
      });
    }
    return structuredClone(job);
  }
  refreshAddress(id, url) {
    const job = this.jobs.find(value => value.id === id);
    if (!job || this.active.has(id) || this.addressRefreshes.has(id) || ['media', 'ftp'].includes(job.kind) || job.method === 'POST' || !['paused', 'error'].includes(job.status)) throw new Error('تحديث الرابط متاح لتنزيل HTTP GET متوقف أو متعذّر فقط.');
    const controller = new AbortController();
    const entry = { controller, promise: null };
    this.addressRefreshes.set(id, entry);
    entry.promise = (async () => {
      try {
        await this.queueOperations.catch(() => {});
        const result = await inspectReplacement(job.url, url, job.path, { signal: controller.signal });
        const previous = { ...job };
        Object.assign(job, { url: result.url, status: 'paused', needsSession: false, needsRecapture: false, error: null, received: result.preservedBytes, total: result.total, queueHeld: false });
        try { await this.save(); }
        catch (error) { Object.assign(job, previous); throw error; }
        this.#requestContexts.delete(id);
        const prepared = this.#preparedResponses.get(id);
        this.#preparedResponses.delete(id);
        await prepared?.body?.cancel().catch(() => {});
        let resumedPartial = false;
        try { resumedPartial = await publishReplacement(job.path, result.checkpoint); }
        catch { job.received = 0; await this.save(); }
        return { job: structuredClone(job), resumedPartial, preservedBytes: resumedPartial ? result.preservedBytes : 0 };
      } finally { this.addressRefreshes.delete(id); }
    })();
    return entry.promise;
  }
  async inspectMedia(url, options) {
    if (this.networkChanging) throw new Error('انتظر اكتمال حفظ إعداد الاتصال قبل فحص الفيديو.');
    if (this.mediaInspections >= 2) throw new Error('يجري فحص فيديوهين. انتظر اكتمال أحدهما.');
    this.mediaInspections = (this.mediaInspections || 0) + 1;
    try { return await this.media.inspect(normalizeDownloadMediaUrl(url), options); }
    finally { this.mediaInspections--; }
  }
  destinationRule(url, filename) {
    const extension = resolveDownloadRule(filename, this.downloadRules, this.downloadDirectory);
    const server = resolveServerRule(url, this.serverRules);
    return { directory: server?.directory || extension.directory, category: server?.category || extension.category };
  }
  async addMedia({ url, quality = 'best', container = 'auto', audioTrack = 'default', title, directory, source = 'browser', externalId = null, startAt = null, queueId = DEFAULT_QUEUE_ID }) {
    const canonical = normalizeDownloadMediaUrl(url);
    validateMediaQuality(quality);
    validateMediaSelection({ container, audioTrack, quality });
    if (startAt && !Number.isFinite(Date.parse(startAt))) throw new Error('موعد البداية غير صالح.');
    if (externalId) {
      const existing = this.jobs.find(job => job.externalId === externalId);
      if (existing) { if (this.pending.has(existing.id)) await this.saving; return structuredClone(existing); }
    }
    const id = randomUUID();
    const mediaSource = getMediaSource(canonical);
    const filename = safeName(title || (mediaSource === 'youtube' ? `YouTube-${new URL(canonical).searchParams.get('v')}` : 'فيديو البث')).replace(/\.(mkv|mp4|webm|mp3|m4a)$/i, '') + '.' + (container === 'auto' ? 'mkv' : container);
    const rule = this.destinationRule(canonical, filename);
    const destination = directory === undefined ? rule.directory : directory;
    const job = { id, kind: 'media', mediaQuality: quality, url: canonical, name: filename, category: rule.category, path: join(destination, id.slice(0, 8), filename), connections: 1, startAt, source, externalId, method: 'GET', needsSession: false, needsRecapture: false, replayPolicy: 'resumable-media', status: 'queued', received: 0, total: null, speed: 0, error: null, createdAt: new Date().toISOString() };
    job.queuePosition = this.queuePosition(queueId);
    job.queueId = queueId;
    job.mediaSource = mediaSource;
    job.mediaContainer = container;
    job.mediaAudioTrack = audioTrack;
    this.pending.add(id);
    this.jobs.unshift(job);
    try { await this.save(); }
    catch (error) { this.jobs = this.jobs.filter(value => value.id !== id); throw error; }
    finally { this.pending.delete(id); }
    this.pump();
    return structuredClone(job);
  }
  async add({ url, name, directory, connections = 4, startAt = null, source = 'manual', externalId = null, requestContext, queueId = DEFAULT_QUEUE_ID, credentials, rememberCredentials = false, ftpTLS = 'auto' }, { preparedResponse } = {}) {
    if (externalId) {
      const existing = this.jobs.find(job => job.externalId === externalId);
      if (existing) { await preparedResponse?.body?.cancel().catch(() => {}); if (this.pending.has(existing.id)) await this.saving; return structuredClone(existing); }
    }
    const context = normalizeRequestContext(requestContext);
    if (context.method === 'POST' && !preparedResponse) throw new Error('يحتاج طلب POST إلى استجابة مؤكدة من المتصفح.');
    if (preparedResponse && (!preparedResponse.ok || !preparedResponse.body || preparedResponse.bodyUsed)) throw new Error('استجابة التنزيل غير متاحة.');
    const isFtp = /^ftps?:/i.test(url);
    const ftp = isFtp ? parseFtpInput(url) : null;
    const parsed = new URL(ftp ? ftp.url : url);
    if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('أدخل رابط HTTP أو HTTPS أو FTP صالحًا.');
    if (isFtp && (context.method !== 'GET' || preparedResponse || !['auto', 'explicit'].includes(ftpTLS))) throw new Error('خيارات تنزيل FTP غير صالحة.');
    if (!Number.isInteger(connections) || connections < 1 || connections > 16) throw new Error('عدد الاتصالات من 1 إلى 16.');
    if (startAt && !Number.isFinite(Date.parse(startAt))) throw new Error('موعد البداية غير صالح.');
    const filename = safeName(name || decodeURIComponent(parsed.pathname.split('/').pop() || 'download'));
    const rule = this.destinationRule(parsed.href, filename);
    const destination = directory === undefined ? rule.directory : directory;
    const id = randomUUID();
    // Each job owns a directory, so equal filenames never share partial files.
    const job = { id, url: parsed.href, name: filename, category: rule.category, path: join(destination, id.slice(0, 8), filename), connections: context.method === 'POST' ? 1 : connections, startAt, source, externalId, method: context.method, needsSession: context.needsSession, replayPolicy: context.method === 'POST' ? 'single-response' : 'resumable-get', needsRecapture: false, status: 'queued', received: 0, total: null, speed: 0, error: null, createdAt: new Date().toISOString() };
    job.queuePosition = this.queuePosition(queueId);
    job.queueId = queueId;
    if (isFtp) {
      job.kind = 'ftp'; job.connections = 1; job.ftpTLS = ftpTLS;
      const login = credentials?.username ? credentials : ftp.credentials;
      if (login) await this.setFtpCredentials(job, login, rememberCredentials);
    }
    this.#requestContexts.set(id, context);
    if (preparedResponse) this.#preparedResponses.set(id, preparedResponse);
    this.pending.add(id);
    this.jobs.unshift(job);
    try { await this.save(); }
    catch (error) {
      this.jobs = this.jobs.filter(j => j.id !== id);
      this.#requestContexts.delete(id); this.#preparedResponses.delete(id); this.#ftpCredentials.delete(id);
      if (job.credentialRef) await this.vault?.set(job.credentialRef, null).catch(() => {});
      await preparedResponse?.body?.cancel().catch(() => {});
      throw error;
    }
    finally { this.pending.delete(id); }
    this.pump();
    return structuredClone(job);
  }
  pump() {
    if (this.stopped || this.networkChanging) return;
    const now = Date.now();
    const budget = this.quota?.snapshot();
    const quotaBlocked = budget?.exhausted || budget?.storageError;
    let expiredRetry = false;
    for (const job of this.jobs) if (job.status === 'queued' && job.networkRetry && !validNetworkRetry(job.networkRetry, this.retryPolicy, now)) {
      delete job.networkRetry; job.status = 'error';
      job.error = 'انتهت مهلة إعادة الاتصال؛ اضغط استئناف للمحاولة مجددًا.'; expiredRetry = true;
    }
    if (expiredRetry) void this.save().catch(error => this.emit('storage-error', error.message));
    if (!quotaBlocked) for (const job of this.jobs) {
      if (job.quotaHeld && job.status === 'paused' && !job.needsRecapture && !job.needsCredentials) {
        job.quotaHeld = false; job.status = 'queued'; job.error = null;
      }
    }
    const queues = this.queueStore.list();
    const open = new Set(queues.filter(queue => queueIsOpen(queue)).map(queue => queue.id));
    for (const job of this.jobs) {
      if (job.status !== 'complete' && this.active.has(job.id) && !open.has(job.queueId) && !this.active.get(job.id).controller.signal.aborted) {
        job.queueHeld = true;
        this.active.get(job.id).controller.abort(new Error('Queue paused'));
      } else if (open.has(job.queueId) && job.queueHeld && job.status === 'paused' && !job.needsRecapture && !this.addressRefreshes.has(job.id)) {
        job.queueHeld = false; job.status = 'queued';
      }
    }
    while (!quotaBlocked && this.active.size < this.parallel) {
      let job;
      for (let offset = 0; offset < queues.length; offset++) {
        const index = (this.queueCursor + offset) % queues.length;
        const queue = queues[index];
        if (!open.has(queue.id) || this.jobs.filter(value => value.queueId === queue.id && this.active.has(value.id)).length >= queue.parallel) continue;
        job = this.jobs.filter(value => value.queueId === queue.id && !this.active.has(value.id) && !this.pending.has(value.id) && !this.addressRefreshes.has(value.id) && !value.needsRecapture && !value.needsCredentials && value.status === 'queued' && (!value.startAt || Date.parse(value.startAt) <= now) && (!value.networkRetry || value.networkRetry.nextAt <= now)).sort((a, b) => a.queuePosition - b.queuePosition)[0];
        if (job) { this.queueCursor = (index + 1) % queues.length; break; }
      }
      if (!job) break;
      const controller = new AbortController();
      job.status = 'downloading';
      job.queueHeld = false;
      const entry = { controller, promise: null };
      this.active.set(job.id, entry);
      entry.promise = this.run(job, controller);
    }
  }
  async run(job, controller) {
    let lastTime = Date.now(), lastBytes = job.received;
    const transferStartedAt = lastTime, initialBytes = job.received;
    const context = this.#requestContexts.get(job.id);
    const preparedResponse = this.#preparedResponses.get(job.id);
    this.#preparedResponses.delete(job.id);
    try {
      await this.quota?.assertAvailable({ signal: controller.signal });
      if ((job.needsSession && !context) || (job.method === 'POST' && !preparedResponse)) throw new Error(recaptureMessage);
      job.error = null;
      await this.save();
      const onProgress = progress => {
        job.received = progress.received;
        job.total = progress.total;
        if (progress.parts) job.transferParts = progress.parts;
        const now = Date.now();
        if (job.networkRetry && now - transferStartedAt >= 60000 && progress.received > initialBytes + 65536) delete job.networkRetry;
        if (now - lastTime >= 250) {
          job.speed = Math.max(0, (progress.received - lastBytes) * 1000 / (now - lastTime));
          lastBytes = progress.received; lastTime = now;
          this.emit('change', this.list());
        }
      };
      let result;
      if (job.kind === 'media') result = await this.media.download(job.url, job.path, { quality: job.mediaQuality, container: job.mediaContainer, audioTrack: job.mediaAudioTrack, signal: controller.signal, onProgress, maxBytesPerSecond: limitedRate(this.speedLimit, resolveServerRule(job.url, this.serverRules)?.speedLimit) });
      else if (job.kind === 'ftp') result = await downloadFtp(job.url, job.path, { signal: controller.signal, onProgress, maxBytesPerSecond: () => this.speedLimit, credentials: this.#ftpCredentials.get(job.id) || this.vault?.get(job.credentialRef), credentialScope: job.ftpCredentialScope, tlsMode: job.ftpTLS, network: this.network, quota: this.quota });
      else result = await download(job.url, job.path, { connections: Math.min(job.connections, resolveServerRule(job.url, this.serverRules)?.fileConnections || 16), signal: controller.signal, requestContext: context, preparedResponse, maxBytesPerSecond: () => this.speedLimit, onProgress });
      if (job.kind === 'media') { job.path = result.path; job.name = result.name; job.category = this.destinationRule(job.url, job.name).category; }
      job.received = result.bytes;
      job.total = result.bytes;
      job.status = 'complete';
      delete job.networkRetry;
      job.quotaHeld = false;
      job.queueHeld = false;
      this.#requestContexts.delete(job.id);
      this.#ftpCredentials.delete(job.id);
      await this.scanCompleted(job, controller.signal);
    } catch (error) {
      const blocked = !controller.signal.aborted && (['DOWNLOAD_QUOTA_EXCEEDED', 'DOWNLOAD_QUOTA_STORAGE_ERROR'].includes(error.code) || job.kind === 'media' && this.quota?.snapshot().exhausted);
      job.status = controller.signal.aborted || blocked ? 'paused' : 'error';
      job.quotaHeld = !!blocked && job.method !== 'POST';
      if (job.method === 'POST' || (job.needsSession && [401, 403].includes(error.status))) {
        job.needsRecapture = true;
        this.#requestContexts.delete(job.id);
      }
      const retryable = !controller.signal.aborted && !this.stopped && !blocked && supportsNetworkRetry(job) && isTransientNetworkError(error);
      const retry = retryable ? nextNetworkRetry(job.networkRetry, job.id, error, this.retryPolicy) : null;
      if (retry) {
        job.status = 'queued'; job.networkRetry = retry;
        job.error = 'انقطع الاتصال؛ سيعيد سَهم المحاولة تلقائيًا.';
      } else {
        delete job.networkRetry;
        if (job.needsRecapture) job.error = recaptureMessage;
        else if (blocked) job.error = error.code === 'DOWNLOAD_QUOTA_STORAGE_ERROR' ? error.message : 'انتهت حصة التنزيل؛ سيُستأنف الملف عند تجددها إذا كانت قائمته مفعّلة.';
        else if (controller.signal.aborted) job.error = null;
        else if (retryable) job.error = 'انتهت مهلة إعادة الاتصال أو حد المحاولات؛ اضغط استئناف للمحاولة مجددًا.';
        else job.error = job.needsSession ? 'تعذّر تنزيل الملف باستخدام جلسة المتصفح.' : error.message;
      }
    } finally {
      delete job.transferParts;
      await preparedResponse?.body?.cancel().catch(() => {});
      job.speed = 0;
      this.pending.add(job.id);
      this.active.delete(job.id);
      try {
        await this.save().catch(error => {
          if (job.networkRetry) { delete job.networkRetry; job.status = 'error'; job.error = 'تعذّر حفظ انتظار إعادة الاتصال؛ تحقق من مساحة التخزين ثم اضغط استئناف.'; }
          this.emit('storage-error', error.message);
        });
      } finally { this.pending.delete(job.id); }
      this.pump();
    }
  }
  async scanCompleted(job, signal) {
    const started = Date.now();
    try {
      const config = normalizeScannerConfig(this.scannerConfig);
      if (!config.enabled) {
        job.scanResult = { status: 'skipped', code: 'scan-disabled', engine: config.mode, exitCode: null, scannedAt: new Date().toISOString(), durationMs: 0 };
        return;
      }
      job.scanResult = { status: 'running', code: 'scan-running', engine: config.mode, exitCode: null, scannedAt: new Date().toISOString(), durationMs: 0 };
      await this.save().catch(error => this.emit('storage-error', error.message));
      try { job.scanResult = scanResult(await this.scanner(job.path, config, { signal }), config.mode, started); }
      catch { job.scanResult = scanResult({ status: 'error', code: signal.aborted ? 'scan-cancelled' : 'scan-failed' }, config.mode, started); }
    } catch { job.scanResult = scanResult(null, 'defender', started); }
  }
  async setFtpCredentials(job, credentials, remember = false) {
    const checked = normalizeFtpCredentials(credentials);
    if (remember) {
      if (!this.vault) throw new Error('مخزن كلمات المرور غير متاح.');
      const ref = `ftp:${job.id}`;
      await this.vault.set(ref, checked);
      job.credentialRef = ref;
    } else if (job.credentialRef) {
      await this.vault?.set(job.credentialRef, null);
      delete job.credentialRef;
    }
    this.#ftpCredentials.set(job.id, checked);
    job.ftpAuthenticated = true;
    job.ftpCredentialScope = randomUUID();
    job.needsCredentials = false;
  }
  async updateFtpCredentials(id, credentials, remember = false) {
    const job = this.jobs.find(value => value.id === id);
    if (!job || job.kind !== 'ftp' || this.active.has(id)) throw new Error('أوقف تنزيل FTP قبل تغيير بيانات الدخول.');
    await this.setFtpCredentials(job, credentials, remember);
    job.error = null;
    await this.save();
    return structuredClone(job);
  }
  async action(id, action) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) throw new Error('التنزيل غير موجود.');
    if (this.addressRefreshes.has(id)) throw new Error('انتظر انتهاء تحديث رابط التنزيل.');
    const active = this.active.get(id);
    if (action === 'pause') {
      if (job.networkRetry) { delete job.networkRetry; job.error = null; }
      job.quotaHeld = false;
      job.queueHeld = false;
      if (active) { active.controller.abort(new Error('Paused')); await active.promise; }
      else if (job.status !== 'complete') {
        job.status = 'paused';
        if (job.method === 'POST') {
          const prepared = this.#preparedResponses.get(id);
          this.#preparedResponses.delete(id);
          this.#requestContexts.delete(id);
          await prepared?.body?.cancel().catch(() => {});
          job.needsRecapture = true; job.error = recaptureMessage;
        }
      }
    } else if (action === 'resume') {
      if (job.needsRecapture) throw new Error(recaptureMessage);
      if (job.needsCredentials) throw new Error('أدخل بيانات دخول FTP أولًا.');
      await this.quota?.assertAvailable();
      delete job.networkRetry;
      job.quotaHeld = false;
      job.queueHeld = false;
      if (!active && job.status !== 'complete') { job.status = 'queued'; job.startAt = null; }
    } else if (action === 'remove') {
      delete job.networkRetry;
      job.queueHeld = false;
      if (active) { active.controller.abort(new Error('Removed')); await active.promise; }
      this.#requestContexts.delete(id);
      this.#ftpCredentials.delete(id);
      if (job.credentialRef) await this.vault?.set(job.credentialRef, null);
      const prepared = this.#preparedResponses.get(id);
      this.#preparedResponses.delete(id);
      await prepared?.body?.cancel().catch(() => {});
      this.jobs = this.jobs.filter(j => j.id !== id);
    } else throw new Error('إجراء غير معروف.');
    await this.save();
    this.pump();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const job of this.jobs) if (job.networkRetry) {
      delete job.networkRetry;
      if (job.status === 'queued') { job.status = 'paused'; job.error = null; }
    }
    await this.browserImports.catch(() => {});
    const refreshes = [...this.addressRefreshes.values()];
    for (const entry of refreshes) entry.controller.abort(new Error('App closing'));
    await Promise.allSettled(refreshes.map(entry => entry.promise));
    await this.queueOperations.catch(() => {});
    const active = [...this.active.values()];
    active.forEach(e => e.controller.abort(new Error('App closing')));
    await Promise.allSettled([...active.map(e => e.promise), this.media.close?.()]);
    await Promise.allSettled([...this.#preparedResponses.values()].map(response => response.body?.cancel()));
    this.#preparedResponses.clear();
    this.#requestContexts.clear();
    this.#ftpCredentials.clear();
    if (this.initialized) await this.save();
  }
}
