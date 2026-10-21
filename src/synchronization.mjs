import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { requestDownload } from './request-context.mjs';
import { transportFetch } from './transport.mjs';
import { replaceCheckpoint } from './checkpoint.mjs';

const secretParameter = /(?:^|[-_.])(?:token|auth(?:orization)?|api[_-]?key|password|passwd|secret|session(?:id)?|signature|sig|credentials?|cookie|jwt)(?:$|[-_.])|^(?:phpsessid|jsessionid)$/i;
const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const maximumFileBytes = 2 * 1024 ** 3;
const minute = 60000;

export function normalizeSyncUrl(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\x00-\x20\x7f]/.test(input)) throw new Error('رابط المزامنة غير صالح.');
  let url;
  try { url = new URL(input); } catch { throw new Error('رابط المزامنة غير صالح.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(key => secretParameter.test(key))) throw new Error('المزامنة للروابط العامة HTTP وHTTPS، دون حساب أو رمز جلسة في الرابط.');
  url.hash = '';
  return url.href;
}

function filename(input) {
  if (typeof input !== 'string' || !input || input.length > 180 || /[\x00-\x1f<>:"/\\|?*\x7f]/.test(input) || /^[. ]|[. ]$/.test(input) || reservedName.test(input) || input.toLowerCase().startsWith('.sahm-sync')) throw new Error('اسم ملف المزامنة غير صالح في Windows.');
  return input;
}

function suggestedFilename(url, index) {
  let label;
  try { label = decodeURIComponent(basename(new URL(url).pathname)); } catch { label = ''; }
  label = label.replace(/[\x00-\x1f<>:"/\\|?*\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 170);
  if (!label || reservedName.test(label)) label = `file-${index + 1}.bin`;
  return filename(label);
}

export function normalizeSyncEntries(input) {
  const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : null;
  if (!values || !values.length || values.length > 100) throw new Error('أضف بين رابط واحد و100 رابط للمزامنة.');
  const names = new Set(), urls = new Set();
  return values.map((value, index) => {
    const url = normalizeSyncUrl(typeof value === 'string' ? value : value?.url);
    if (urls.has(url)) throw new Error('رابط مكرر في مشروع المزامنة.');
    urls.add(url);
    let name = typeof value === 'object' && value?.filename ? filename(value.filename) : suggestedFilename(url, index);
    if (names.has(name.toLowerCase()) && value?.filename) throw new Error('اسما ملفين في المشروع متطابقان.');
    const original = name;
    for (let suffix = index + 1; names.has(name.toLowerCase()); suffix++) name = `${suffix}-${original}`;
    names.add(name.toLowerCase());
    return { id: randomUUID(), url, filename: name, status: 'pending', sha256: null, size: 0, etag: null, lastModified: null };
  });
}

function configuration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('بيانات مشروع المزامنة غير صالحة.');
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'name' && typeof value === 'string' && value.trim() && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value)) output.name = value.trim();
    else if (key === 'intervalMinutes' && Number.isSafeInteger(value) && value >= 1 && value <= 10080) output.intervalMinutes = value;
    else if (key === 'enabled' && typeof value === 'boolean') output.enabled = value;
    else if (key === 'queueId' && (value === null || typeof value === 'string' && /^[\w-]{1,80}$/.test(value))) output.queueId = value;
    else throw new Error(`إعداد مزامنة غير صالح: ${key}`);
  }
  return output;
}

async function digest(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw conflict('ملف المزامنة المحلي ليس ملفًا عاديًا.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function conflict(message) { return Object.assign(new Error(message), { code: 'SYNC_LOCAL_CONFLICT' }); }
function stopped(message, code) { return Object.assign(new Error(message), { code }); }
function timestamp(value) { return new Date(value).toISOString(); }

export class SyncService extends EventEmitter {
  constructor(dataDirectory, defaultDirectory, { now = Date.now, fetchImpl = transportFetch, canRun = () => true, quota = null } = {}) {
    super();
    this.directory = dataDirectory;
    this.file = join(dataDirectory, 'synchronization.json');
    this.defaultDirectory = defaultDirectory;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.canRun = canRun;
    this.quota = quota;
    this.projects = [];
    this.active = new Map();
    this.manual = new Set();
    this.saving = Promise.resolve();
    this.closed = false;
    this.networkChanging = false;
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    let saved;
    try { saved = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved !== undefined) {
      if (!Array.isArray(saved) || saved.length > 100) throw new Error('سجل المزامنة المحفوظ غير صالح.');
      this.projects = saved.map(project => {
        if (!project || !/^[\da-f-]{36}$/i.test(project.id) || typeof project.directory !== 'string' || !isAbsolute(project.directory) || !Array.isArray(project.entries) || !project.entries.length || project.entries.length > 100) throw new Error('مشروع مزامنة محفوظ غير صالح.');
        const config = configuration({ name: project.name, intervalMinutes: project.intervalMinutes, enabled: project.enabled, queueId: project.queueId ?? null });
        const names = new Set();
        for (const entry of project.entries) {
          normalizeSyncUrl(entry.url); filename(entry.filename);
          if (!/^[\da-f-]{36}$/i.test(entry.id) || entry.sha256 !== null && !/^[\da-f]{64}$/.test(entry.sha256) || names.has(entry.filename.toLowerCase())) throw new Error('ملف مزامنة محفوظ غير صالح.');
          names.add(entry.filename.toLowerCase());
        }
        const restored = { ...project, ...config };
        if (restored.enabled && restored.state === 'running') { restored.state = 'idle'; restored.nextRunAt = timestamp(this.now()); }
        if (!restored.enabled) { restored.state = restored.state === 'conflict' ? 'conflict' : 'paused'; restored.nextRunAt = null; }
        if (restored.enabled && !Number.isFinite(Date.parse(restored.nextRunAt))) restored.nextRunAt = timestamp(this.now());
        return restored;
      });
    }
    return this;
  }

  list() { return structuredClone(this.projects); }

  async save() {
    const snapshot = JSON.stringify(this.projects, null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      const file = await open(this.file + '.tmp', 'w');
      try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
      await replaceCheckpoint(this.file + '.tmp', this.file);
    });
    await this.saving;
    this.emit('change', this.list());
  }

  async add(input) {
    if (this.closed) throw new Error('أُغلقت المزامنة.');
    if (this.projects.length >= 100) throw new Error('الحد الأقصى 100 مشروع مزامنة.');
    const { urls, entries, directory, ...data } = input || {};
    const config = configuration({ name: 'مشروع مزامنة', intervalMinutes: 60, queueId: null, enabled: true, ...data });
    const base = directory || this.defaultDirectory;
    if (typeof base !== 'string' || !isAbsolute(base) || /\0/.test(base)) throw new Error('اختر مجلدًا مطلقًا للمزامنة.');
    const id = randomUUID();
    const project = { id, ...config, directory: resolve(base, 'Synchronization', id), entries: normalizeSyncEntries(entries || urls), state: config.enabled ? 'idle' : 'paused', createdAt: timestamp(this.now()), nextRunAt: config.enabled ? timestamp(this.now()) : null, lastRunAt: null, lastSuccessAt: null, failures: 0, updatedFiles: 0, unchangedFiles: 0, receivedBytes: 0, error: null, errorCode: null };
    this.projects.unshift(project);
    try { await this.save(); } catch (error) { this.projects = this.projects.filter(value => value !== project); throw error; }
    this.pump();
    return structuredClone(project);
  }

  async update(id, input) {
    const project = this.find(id);
    if (this.active.has(id)) throw new Error('أوقف دورة المزامنة قبل تعديل جدولها.');
    const previous = structuredClone(project), changes = configuration(input);
    Object.assign(project, changes);
    if (Object.hasOwn(changes, 'enabled')) {
      project.state = project.enabled ? 'idle' : 'paused';
      project.nextRunAt = project.enabled ? timestamp(this.now()) : null;
    } else if (changes.intervalMinutes && project.enabled) project.nextRunAt = timestamp(this.now() + project.intervalMinutes * minute);
    try { await this.save(); } catch (error) { Object.assign(project, previous); throw error; }
    this.pump();
    return structuredClone(project);
  }

  find(id) {
    const project = this.projects.find(value => value.id === id);
    if (!project) throw new Error('مشروع المزامنة غير موجود.');
    return project;
  }

  async action(id, action) {
    const project = this.find(id);
    if (action === 'pause' || action === 'remove') {
      project.enabled = false; project.state = 'paused'; project.nextRunAt = null;
      this.manual.delete(id);
      this.active.get(id)?.controller.abort(stopped('أوقفت المزامنة.', 'SYNC_USER_PAUSED'));
      await this.active.get(id)?.promise;
      if (action === 'remove') this.projects = this.projects.filter(value => value !== project);
    } else if (action === 'resume') {
      project.enabled = true; project.state = 'idle'; project.nextRunAt = timestamp(this.now());
      project.error = null; project.errorCode = null;
    } else if (action === 'run') {
      if (this.active.has(id)) throw new Error('دورة المزامنة تعمل بالفعل.');
      this.manual.add(id); project.state = 'idle';
    } else throw new Error('إجراء مزامنة غير معروف.');
    await this.save();
    this.pump();
    return this.list();
  }

  pump() {
    if (this.closed || this.networkChanging) return;
    for (const project of this.projects) {
      const allowed = Boolean(this.canRun(project.queueId));
      if (this.active.has(project.id)) {
        if (!allowed) this.active.get(project.id).controller.abort(stopped('أُغلقت نافذة القائمة المرتبطة بالمزامنة.', 'SYNC_QUEUE_CLOSED'));
        continue;
      }
      if (!this.manual.has(project.id) && (!project.enabled || Date.parse(project.nextRunAt) > this.now())) continue;
      if (!allowed) {
        if (project.state !== 'blocked' || project.errorCode !== 'SYNC_QUEUE_CLOSED') {
          project.state = 'blocked'; project.errorCode = 'SYNC_QUEUE_CLOSED'; project.error = 'المزامنة تنتظر فتح القائمة المرتبطة.';
          this.save().catch(error => this.emit('storage-error', error.message));
        }
        continue;
      }
      if (project.quotaHeld) {
        const state = this.quota?.snapshot?.();
        if (!state || state.exhausted || state.storageError) continue;
      }
      if (this.active.size < 2) this.start(project);
    }
  }

  start(project) {
    if (this.closed || this.networkChanging || this.active.has(project.id) || this.active.size >= 2) return;
    const controller = new AbortController(), active = { controller, promise: null };
    this.active.set(project.id, active);
    this.manual.delete(project.id);
    project.state = 'running'; project.lastRunAt = timestamp(this.now()); project.updatedFiles = 0; project.unchangedFiles = 0; project.receivedBytes = 0; project.error = null; project.errorCode = null; project.quotaHeld = false;
    active.promise = this.run(project, controller.signal).finally(async () => {
      this.active.delete(project.id);
      await this.save().catch(error => this.emit('storage-error', error.message));
      this.pump();
    });
  }

  async checkAllowed(project, signal, checkQuota = true) {
    signal.throwIfAborted();
    if (!this.canRun(project.queueId)) throw stopped('أُغلقت نافذة القائمة المرتبطة بالمزامنة.', 'SYNC_QUEUE_CLOSED');
    if (checkQuota) await this.quota?.assertAvailable?.({ signal });
  }

  async ownedDirectory(project) {
    await mkdir(project.directory, { recursive: true });
    if ((await lstat(project.directory)).isSymbolicLink()) throw new Error('مجلد المزامنة رابط رمزي؛ اختر مجلدًا محليًا عاديًا.');
    const root = await realpath(project.directory), metadata = join(root, '.sahm-sync');
    let owner;
    try { owner = JSON.parse(await readFile(join(metadata, 'owner.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await readdir(root)).length) throw new Error('مجلد المزامنة موجود دون سجل ملكية؛ احتُفظ بمحتواه.');
      await mkdir(metadata);
      const file = await open(join(metadata, 'owner.json'), 'wx');
      try { await file.writeFile(JSON.stringify({ version: 1, id: project.id })); await file.sync(); } finally { await file.close(); }
      owner = { id: project.id };
    }
    if (owner.id !== project.id || (await lstat(metadata)).isSymbolicLink()) throw new Error('سجل ملكية مجلد المزامنة غير مطابق.');
    for (const folder of ['staging', 'backups']) {
      const path = join(metadata, folder);
      await mkdir(path, { recursive: true });
      if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('مسار ملفات المزامنة الداخلية غير آمن.');
    }
    return root;
  }

  async conditionalRequest(entry, signal, useValidators) {
    const headers = {};
    if (useValidators && entry.etag && !entry.etag.startsWith('W/')) headers['If-None-Match'] = entry.etag;
    else if (useValidators && entry.lastModified) headers['If-Modified-Since'] = entry.lastModified;
    const notModified = Symbol('not modified');
    let unchanged;
    try {
      return await requestDownload(entry.url, {
        headers, signal,
        fetchImpl: async (url, init) => {
          normalizeSyncUrl(url);
          const response = await this.fetchImpl(url, init);
          if (response.status === 304) { unchanged = response; throw notModified; }
          return response;
        },
      });
    } catch (error) { if (error === notModified) return unchanged; throw error; }
  }

  async transfer(project, entry, root, signal) {
    await this.checkAllowed(project, signal);
    const target = join(root, entry.filename), localHash = await digest(target);
    if (localHash && localHash !== entry.sha256) throw conflict(`تغيّر الملف المحلي «${entry.filename}»؛ احتُفظ بنسختك دون استبدال.`);
    const response = await this.conditionalRequest(entry, signal, Boolean(localHash && entry.sha256));
    if (response.status === 304) {
      await response.body?.cancel();
      if (!localHash || !entry.sha256 || !(entry.etag && !entry.etag.startsWith('W/')) && !entry.lastModified) throw new Error('أعاد الخادم 304 دون نسخة محلية موثقة.');
      if (await digest(target) !== localHash) throw conflict(`تغيّر الملف المحلي «${entry.filename}» أثناء الفحص؛ احتُفظ به.`);
      entry.status = 'unchanged'; entry.lastSyncedAt = timestamp(this.now()); project.unchangedFiles++;
      return;
    }
    if (response.status !== 200 || !response.body || response.headers.get('content-range')) { await response.body?.cancel(); throw new Error('تتطلب المزامنة استجابة ملف HTTP 200 كاملة.'); }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maximumFileBytes) { await response.body.cancel(); throw new Error('يتجاوز الملف حد المزامنة البالغ 2 GiB.'); }
    const temporary = join(root, '.sahm-sync', 'staging', `${entry.id}-${randomUUID()}.download`);
    let output;
    try { output = await open(temporary, 'wx'); }
    catch (error) { await response.body.cancel(); throw error; }
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        await this.checkAllowed(project, signal, false);
        const chunk = await this.readChunk(reader, signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        project.receivedBytes += chunk.value.byteLength;
        if (size > maximumFileBytes) throw new Error('يتجاوز الملف حد المزامنة البالغ 2 GiB.');
        hash.update(chunk.value); await output.writeFile(chunk.value);
      }
      await output.sync();
    } catch (error) {
      await output.close(); await unlink(temporary).catch(() => {}); throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    await output.close();
    const sha256 = hash.digest('hex');
    try {
      await this.checkAllowed(project, signal, false);
      if (await realpath(project.directory) !== root || await digest(target) !== localHash) throw conflict(`تغيّر الملف المحلي «${entry.filename}» أثناء التنزيل؛ احتُفظ به.`);
      if (sha256 === localHash) { await unlink(temporary); entry.status = 'unchanged'; project.unchangedFiles++; }
      else {
        let backup = null;
        if (localHash) {
          backup = join('.sahm-sync', 'backups', `${entry.id}-${this.now()}-${randomUUID()}.previous`);
          await copyFile(target, join(root, backup), constants.COPYFILE_EXCL);
          const file = await open(join(root, backup), 'r+'); try { await file.sync(); } finally { await file.close(); }
          if (await digest(join(root, backup)) !== localHash || await digest(target) !== localHash) throw conflict(`تغيّر الملف المحلي «${entry.filename}» أثناء حفظ نسخته السابقة.`);
        }
        await replaceCheckpoint(temporary, target);
        entry.previousVersion = backup; entry.status = 'updated'; project.updatedFiles++;
      }
      entry.sha256 = sha256; entry.size = size;
      entry.etag = response.headers.get('etag')?.slice(0, 2048) || null;
      entry.lastModified = response.headers.get('last-modified')?.slice(0, 256) || null;
      entry.lastSyncedAt = timestamp(this.now());
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async readChunk(reader, signal) {
    let timeout, aborted;
    try {
      const cancelled = new Promise((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); });
      const stalled = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('توقف الخادم عن إرسال ملف المزامنة.')), 30000); });
      return await Promise.race([reader.read(), cancelled, stalled]);
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', aborted); }
  }

  async run(project, signal) {
    try {
      await this.save();
      const root = await this.ownedDirectory(project);
      for (const entry of project.entries) { await this.transfer(project, entry, root, signal); await this.save(); }
      project.state = project.enabled ? 'idle' : 'paused'; project.lastSuccessAt = timestamp(this.now()); project.failures = 0;
      project.nextRunAt = project.enabled ? timestamp(this.now() + project.intervalMinutes * minute) : null;
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      project.errorCode = reason?.code || 'SYNC_FAILED';
      project.error = reason?.message || 'تعذرت المزامنة.';
      if (project.errorCode === 'SYNC_LOCAL_CONFLICT') { project.state = 'conflict'; project.enabled = false; project.nextRunAt = null; }
      else if (!project.enabled && project.errorCode === 'SYNC_USER_PAUSED') { project.state = 'paused'; project.nextRunAt = null; }
      else if (['SYNC_QUEUE_CLOSED', 'DOWNLOAD_QUOTA_EXCEEDED'].includes(project.errorCode)) { project.state = 'blocked'; project.quotaHeld = project.errorCode === 'DOWNLOAD_QUOTA_EXCEEDED'; project.nextRunAt = project.enabled ? timestamp(this.now()) : null; }
      else if (project.errorCode === 'SYNC_APP_CLOSING') { project.state = project.enabled ? 'idle' : 'paused'; project.nextRunAt = project.enabled ? timestamp(this.now()) : null; project.error = null; project.errorCode = null; }
      else { project.state = 'error'; project.failures = (project.failures || 0) + 1; project.nextRunAt = project.enabled ? timestamp(this.now() + Math.min(24 * 60, project.intervalMinutes * 2 ** Math.min(project.failures, 10)) * minute) : null; }
    }
  }

  async close() {
    this.closed = true;
    const active = [...this.active.values()];
    for (const value of active) value.controller.abort(stopped('أُغلق التطبيق أثناء المزامنة.', 'SYNC_APP_CLOSING'));
    await Promise.allSettled(active.map(value => value.promise));
    await this.save();
  }
}
