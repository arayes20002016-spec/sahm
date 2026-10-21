import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runSiteMirror, readSiteMirror, normalizeMirrorOptions, normalizeMirrorUrl } from './site-mirror.mjs';
import { transportFetch } from './transport.mjs';
import { replaceCheckpoint } from './checkpoint.mjs';
import { normalizeSiteSchedule, validRevision, siteRevisionDirectory, captureSiteRevision, verifySiteRevision, compareSiteRevisions, createSiteRevalidator, canPublishSiteRevision } from './site-revisions.mjs';

export class SiteCopies extends EventEmitter {
  constructor(dataDirectory, downloadDirectory, { fetchImpl = transportFetch, quota, browserService, now = Date.now } = {}) {
    super();
    this.file = join(dataDirectory, 'site-copies.json');
    this.directory = dataDirectory;
    this.downloadDirectory = downloadDirectory;
    this.fetchImpl = fetchImpl;
    this.quota = quota;
    this.browserService = browserService;
    this.now = now;
    this.sessions = new Map();
    this.jobs = [];
    this.active = new Map();
    this.saving = Promise.resolve();
    this.closed = false;
    this.networkChanging = false;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try { this.jobs = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.jobs)) throw new Error('قائمة المواقع المحفوظة غير صالحة.');
    for (const job of this.jobs) {
      if (job.schedule !== undefined) {
        job.schedule = normalizeSiteSchedule(job.schedule);
        for (const field of ['publishedRevision', 'previousRevision', 'stagingRevision']) if (job[field] !== undefined && !validRevision(job[field])) throw new Error('سجل إصدارات الموقع غير صالح.');
        if (job.stagingRevision && (job.stagingRevision === 'legacy' || [job.publishedRevision, job.previousRevision].includes(job.stagingRevision))) throw new Error('لا يمكن استخدام نسخة منشورة كمجلد عمل.');
        if (job.publishedRevision && !/^[\da-f]{64}$/.test(job.revisionHash || '')) throw new Error('بصمة إصدار الموقع غير صالحة.');
        if (job.nextRunAt != null && !Number.isFinite(Date.parse(job.nextRunAt))) throw new Error('موعد تحديث الموقع المحفوظ غير صالح.');
        if (job.schedule.enabled && ['complete', 'partial', 'error'].includes(job.state) && !job.nextRunAt) job.nextRunAt = new Date(this.now()).toISOString();
        if (!job.schedule.enabled) job.nextRunAt = null;
        if (job.state === 'running' && job.schedule.enabled && !job.sessionRequired) job.state = 'queued';
        if (job.resumeOnOpen && job.schedule.enabled && !job.sessionRequired) job.state = 'queued';
        delete job.resumeOnOpen;
      }
      if (job.sessionRequired !== undefined && typeof job.sessionRequired !== 'boolean') throw new Error('بيانات جلسة نسخ الموقع غير صالحة.');
      if (job.state === 'running') job.state = 'paused';
      if (job.sessionRequired && ['queued', 'paused', 'error', 'needs-session'].includes(job.state)) job.state = 'needs-session';
    }
    return this;
  }
  sessionAvailable(job) {
    return !job.sessionRequired || !!this.browserService?.get(this.sessions.get(job.id));
  }
  list() {
    return this.jobs.map(job => ({ ...structuredClone(job), state: this.active.has(job.id) ? 'running' : job.state, sessionAvailable: this.sessionAvailable(job) }));
  }
  checkSession(sessionId, rootUrl) {
    if (typeof sessionId !== 'string' || sessionId.length > 128 || !sessionId) throw new Error('اختر جلسة تسجيل دخول صالحة.');
    const session = this.browserService?.get(sessionId);
    if (!session || session.origin !== new URL(rootUrl).origin) throw new Error('سجّل الدخول إلى أصل الموقع نفسه، بما فيه المنفذ، ثم استخدم جلسته.');
    return sessionId;
  }
  async save() {
    const snapshot = JSON.stringify(this.jobs, null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      const handle = await open(this.file + '.tmp', 'w');
      try { await handle.writeFile(snapshot); await handle.sync(); }
      finally { await handle.close(); }
      await replaceCheckpoint(this.file + '.tmp', this.file);
    });
    await this.saving;
    this.emit('change', this.list());
  }
  async add({ url, options = {}, sessionId, schedule } = {}) {
    if (this.closed) throw new Error('أُغلق ناسخ المواقع.');
    if (this.jobs.length >= 100) throw new Error('الحد الأقصى 100 نسخة موقع في القائمة.');
    const checkedOptions = normalizeMirrorOptions(options);
    const rootUrl = normalizeMirrorUrl(url, checkedOptions);
    if (checkedOptions.renderMode === 'browser' && !this.browserService) throw new Error('تشغيل صفحات JavaScript متاح داخل تطبيق سَهم لسطح المكتب.');
    if (sessionId !== undefined) this.checkSession(sessionId, rootUrl);
    const id = randomUUID();
    const job = { id, rootUrl, options: checkedOptions, directory: resolve(this.downloadDirectory, 'Sites', id.slice(0, 8)), state: 'queued', pages: 0, files: 0, bytes: 0, failed: 0, createdAt: new Date().toISOString() };
    if (schedule !== undefined) { job.schedule = normalizeSiteSchedule(schedule); job.nextRunAt = null; }
    if (sessionId !== undefined) { job.sessionRequired = true; this.sessions.set(id, sessionId); }
    this.jobs.unshift(job);
    try { await this.save(); }
    catch (error) { this.jobs = this.jobs.filter(value => value !== job); this.sessions.delete(id); throw error; }
    this.pump();
    return this.list().find(value => value.id === id);
  }
  start(job) {
    if (this.closed || this.networkChanging || this.active.has(job.id)) return;
    if (this.active.size >= 2) return;
    if (!this.sessionAvailable(job)) {
      job.state = 'needs-session';
      if (job.schedule) job.nextRunAt = null;
      job.error = 'سجّل الدخول من جديد لمتابعة نسخ الموقع.';
      this.save().catch(error => this.emit('storage-error', error.message));
      return;
    }
    const sessionId = this.sessions.get(job.id);
    if (sessionId && [...this.active.values()].some(value => value.sessionId === sessionId)) return;
    const controller = new AbortController();
    const entry = { controller, promise: null, sessionId };
    this.active.set(job.id, entry);
    job.state = 'running'; job.error = null;
    if (job.schedule) { job.lastRunAt = new Date(this.now()).toISOString(); job.nextRunAt = null; }
    let lastNotification = 0;
    entry.promise = (async () => {
      let runner;
      try {
        await this.quota?.assertAvailable({ signal: controller.signal });
        await this.save();
        if (job.options.renderMode === 'browser' || job.sessionRequired) {
          runner = await this.browserService.createRunner({ rootUrl: job.rootUrl, sessionId, options: job.options, signal: controller.signal });
          controller.signal.throwIfAborted();
        }
        let previous, previousDirectory, outputDirectory = job.directory;
        if (job.schedule) {
          if (job.publishedRevision) {
            previousDirectory = await siteRevisionDirectory(job.directory, job.publishedRevision);
            previous = await verifySiteRevision(previousDirectory, job.revisionHash, { signal: controller.signal });
          }
          job.stagingRevision ||= randomUUID();
          outputDirectory = await siteRevisionDirectory(job.directory, job.stagingRevision, { create: true });
          await this.save();
        }
        const revalidation = await createSiteRevalidator(runner ? runner.fetch : this.fetchImpl, previousDirectory);
        const result = await runSiteMirror(job.rootUrl, outputDirectory, {
          options: job.options, signal: controller.signal, fetchImpl: revalidation.fetch,
          renderPage: runner && job.options.renderMode === 'browser' ? runner.render : undefined,
          privateSession: job.sessionRequired === true,
          onProgress: progress => {
            for (const name of ['pages', 'files', 'bytes', 'failed', 'pending', 'active']) if (progress[name] !== undefined) job[name] = progress[name];
            if (Date.now() - lastNotification > 200) { lastNotification = Date.now(); this.emit('change', this.list()); }
          },
        });
        job.state = result.state;
        job.quotaHeld = false;
        job.stats = result.stats;
        if (job.schedule && canPublishSiteRevision(result)) {
          const next = await captureSiteRevision(outputDirectory, { signal: controller.signal });
          if (previous) await verifySiteRevision(previousDirectory, job.revisionHash, { signal: controller.signal });
          controller.signal.throwIfAborted();
          const changes = compareSiteRevisions(previous, next);
          const previousJob = structuredClone(job);
          job.lastCycle = { ...changes, notModified: revalidation.statistics.notModified };
          job.lastSuccessAt = new Date(this.now()).toISOString();
          if (!previous || changes.updated || changes.removed) {
            if (job.publishedRevision) job.previousRevision = job.publishedRevision;
            job.publishedRevision = job.stagingRevision; job.revisionHash = next.hash;
          }
          delete job.stagingRevision;
          job.entryPath = result.entryPath;
          try { await this.save(); }
          catch (error) { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, previousJob); throw error; }
        } else if (job.schedule) job.error = 'لم تُنشر الدورة غير المكتملة؛ تبقى النسخة السابقة متاحة. راجع الحدود أو الموارد المتعذرة.';
        else job.entryPath = result.entryPath;
      } catch (error) {
        const blocked = !controller.signal.aborted && ['DOWNLOAD_QUOTA_EXCEEDED', 'DOWNLOAD_QUOTA_STORAGE_ERROR'].includes(error.code);
        const sessionExpired = !controller.signal.aborted && ['SITE_SESSION_REQUIRED', 'SITE_SESSION_EXPIRED'].includes(error.code);
        if (sessionExpired) this.sessions.delete(job.id);
        job.state = 'error';
        job.quotaHeld = blocked;
        job.error = error.message;
        if (controller.signal.aborted) { job.state = 'paused'; job.error = null; }
        else if (sessionExpired) { job.state = 'needs-session'; job.error = 'انتهت جلسة الدخول. سجّل الدخول مجددًا ثم تابع النسخ.'; }
        else if (blocked) job.state = 'paused';
        else if (error.code === 'SITE_LOCAL_CONFLICT') { job.state = 'conflict'; job.error = error.message; if (job.schedule) job.schedule.enabled = false; }
        else if (job.sessionRequired || job.options.renderMode === 'browser') job.error = 'تعذّر حفظ الموقع بالمتصفح. أعد المحاولة أو جدّد تسجيل الدخول.';
      } finally {
        await runner?.close().catch(() => {});
        this.active.delete(job.id);
        if (job.schedule) job.nextRunAt = job.schedule.enabled && !['paused', 'needs-session', 'conflict'].includes(job.state) ? new Date(this.now() + job.schedule.intervalMinutes * 60000).toISOString() : null;
        await this.save().catch(error => this.emit('storage-error', error.message));
        this.pump();
      }
    })();
  }
  pump() {
    if (this.closed || this.networkChanging) return;
    const budget = this.quota?.snapshot();
    if (budget?.exhausted || budget?.storageError) return;
    for (const job of this.jobs) if (job.quotaHeld && job.state === 'paused') { job.state = 'queued'; job.quotaHeld = false; job.error = null; }
    for (const job of this.jobs) {
      if (job.schedule?.enabled && ['complete', 'partial', 'error'].includes(job.state) && job.nextRunAt && Date.parse(job.nextRunAt) <= this.now()) {
        delete job.stagingRevision; job.state = 'queued';
      }
    }
    for (const job of this.jobs) if (job.state === 'queued' && this.active.size < 2) this.start(job);
  }
  async action(id, action) {
    const job = this.jobs.find(value => value.id === id);
    if (!job) throw new Error('نسخة الموقع غير موجودة.');
    if (action === 'pause' || action === 'remove') {
      if (job.schedule) { job.schedule.enabled = false; job.nextRunAt = null; }
      job.quotaHeld = false;
      job.state = 'paused';
      const entry = this.active.get(id);
      entry?.controller.abort(new Error('Paused'));
      await entry?.promise;
      if (action === 'remove') { this.jobs = this.jobs.filter(value => value !== job); this.sessions.delete(id); }
    } else if (action === 'resume' || action === 'check') {
      if (!this.sessionAvailable(job)) {
        job.state = 'needs-session'; await this.save();
        const error = new Error('سجّل الدخول من جديد قبل استئناف نسخ الموقع.'); error.code = 'SITE_SESSION_REQUIRED'; throw error;
      }
      if (action === 'check' && !job.schedule) throw new Error('فعّل جدول المشروع قبل فحص تحديثاته.');
      if (this.active.has(id)) throw new Error('دورة الموقع تعمل بالفعل.');
      await this.quota?.assertAvailable();
      if (action === 'check') delete job.stagingRevision;
      else if (job.schedule) job.schedule.enabled = true;
      job.quotaHeld = false; job.state = 'queued'; this.pump();
    }
    else throw new Error('إجراء نسخ موقع غير معروف.');
    await this.save();
    return this.list();
  }
  async updateSchedule(id, input) {
    if (this.closed) throw new Error('أُغلق ناسخ المواقع.');
    const job = this.jobs.find(value => value.id === id);
    if (!job) throw new Error('نسخة الموقع غير موجودة.');
    if (this.active.has(id)) throw new Error('أوقف الدورة قبل تعديل جدول الموقع.');
    const schedule = normalizeSiteSchedule(input), previous = structuredClone(job);
    if (!job.schedule && job.entryPath) {
      const root = await siteRevisionDirectory(job.directory, 'legacy');
      const index = await captureSiteRevision(root);
      job.publishedRevision = 'legacy'; job.revisionHash = index.hash;
    }
    if (job.state === 'conflict' && schedule.enabled) await verifySiteRevision(await siteRevisionDirectory(job.directory, job.publishedRevision), job.revisionHash);
    job.schedule = schedule;
    job.nextRunAt = schedule.enabled ? new Date(this.now() + (previous.schedule?.enabled ? schedule.intervalMinutes * 60000 : 0)).toISOString() : null;
    if (schedule.enabled && ['conflict', 'paused', 'needs-session'].includes(job.state)) job.state = job.sessionRequired && !this.sessionAvailable(job) ? 'needs-session' : job.entryPath ? 'complete' : 'queued';
    try { await this.save(); }
    catch (error) { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, previous); throw error; }
    this.pump();
    return this.list();
  }
  async attachSession(id, sessionId) {
    if (this.closed) throw new Error('أُغلق ناسخ المواقع.');
    const job = this.jobs.find(value => value.id === id);
    if (!job) throw new Error('نسخة الموقع غير موجودة.');
    if (this.active.has(id)) throw new Error('أوقف النسخ قبل تغيير جلسة الدخول.');
    if (!job.sessionRequired) throw new Error('أنشئ نسخة جديدة مع جلسة دخول؛ لا يمكن تحويل الملفات العامة المحفوظة إلى نسخة محمية.');
    this.checkSession(sessionId, job.rootUrl);
    const previous = { sessionId: this.sessions.get(id), required: job.sessionRequired, state: job.state, error: job.error, quotaHeld: job.quotaHeld };
    this.sessions.set(id, sessionId); job.sessionRequired = true; job.state = 'queued'; job.error = null; job.quotaHeld = false;
    try { await this.save(); }
    catch (error) {
      if (previous.sessionId) this.sessions.set(id, previous.sessionId); else this.sessions.delete(id);
      if (previous.required === undefined) delete job.sessionRequired; else job.sessionRequired = previous.required;
      job.state = previous.state; job.error = previous.error; job.quotaHeld = previous.quotaHeld;
      throw error;
    }
    this.pump();
    return this.list();
  }
  async detachSession(sessionId) {
    const affected = this.jobs.filter(job => this.sessions.get(job.id) === sessionId);
    const stopping = affected.map(job => this.active.get(job.id)?.promise);
    for (const job of affected) {
      this.sessions.delete(job.id);
      if (job.state !== 'complete' || job.schedule) job.state = 'needs-session';
      this.active.get(job.id)?.controller.abort(new Error('Session closed'));
    }
    await Promise.allSettled(stopping);
    for (const job of affected) {
      this.sessions.delete(job.id);
      if (job.state !== 'complete' || job.schedule) { job.state = 'needs-session'; job.quotaHeld = false; job.nextRunAt = null; job.error = 'أُغلقت الجلسة. سجّل الدخول من جديد للمتابعة.'; }
    }
    await this.save();
  }
  async entry(id, version = 'current') {
    const job = this.jobs.find(value => value.id === id);
    if (!job) throw new Error('نسخة الموقع غير موجودة.');
    if (!['current', 'previous'].includes(version)) throw new Error('إصدار الموقع غير صالح.');
    let directory = job.directory;
    if (job.schedule) {
      const revision = version === 'previous' ? job.previousRevision : job.publishedRevision;
      if (!revision) throw new Error('لا توجد نسخة مكتملة منشورة لهذا الإصدار بعد.');
      directory = await siteRevisionDirectory(job.directory, revision);
    } else if (version !== 'current') throw new Error('لا توجد نسخة سابقة.');
    const manifest = await readSiteMirror(directory);
    const root = manifest?.resources.find(value => value.url === manifest.rootUrl && value.state === 'complete' && value.path === 'index.html');
    if (!root || !(await stat(join(directory, 'index.html')).catch(() => null))?.isFile()) throw new Error('لم تُحفظ الصفحة الأولى بعد.');
    return { directory, entryPath: manifest.entryPath };
  }
  async close() {
    this.closed = true;
    const active = [...this.active.values()];
    for (const job of this.jobs) if (this.active.has(job.id) && job.schedule?.enabled) job.resumeOnOpen = true;
    for (const entry of active) entry.controller.abort(new Error('App closing'));
    await Promise.allSettled(active.map(entry => entry.promise));
    await this.save();
  }
}
