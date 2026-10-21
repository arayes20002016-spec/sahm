import { EventEmitter } from 'node:events';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceCheckpoint } from './checkpoint.mjs';

const HOUR = 60 * 60 * 1000;
const DEFAULT_CONFIG = { enabled: false, limitBytes: 10 * 1024 ** 3, periodHours: 24 };

export function normalizeQuotaConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('إعدادات حصة التنزيل غير صالحة.');
  const config = { ...DEFAULT_CONFIG, ...input };
  if (Object.keys(config).some(key => !Object.hasOwn(DEFAULT_CONFIG, key)) || typeof config.enabled !== 'boolean' || !Number.isSafeInteger(config.limitBytes) || config.limitBytes < 1 || !Number.isInteger(config.periodHours) || config.periodHours < 1 || config.periodHours > 8760) throw new Error('يجب أن تكون حصة التنزيل عددًا صحيحًا موجبًا، ومدتها من ساعة إلى 8760 ساعة.');
  return config;
}

export class QuotaExceededError extends Error {
  constructor(resetAt) {
    super('اكتملت حصة التنزيل. يمكن المتابعة عند بدء الفترة التالية أو بعد تعديل الحصة.');
    this.name = 'QuotaExceededError';
    this.code = 'DOWNLOAD_QUOTA_EXCEEDED';
    this.resetAt = resetAt;
  }
}

function storageError(cause) {
  const error = new Error('تعذّر حفظ عداد حصة التنزيل بأمان. أُوقف النقل لحماية العداد المحفوظ.', { cause });
  error.code = 'DOWNLOAD_QUOTA_STORAGE_ERROR';
  return error;
}

async function writeLedger(file, state) {
  const handle = await open(file + '.tmp', 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await replaceCheckpoint(file + '.tmp', file);
}

function validateLedger(saved) {
  if (!saved || saved.version !== 1 || !saved.config || Object.keys(DEFAULT_CONFIG).some(key => !Object.hasOwn(saved.config, key)) || !Number.isSafeInteger(saved.usedBytes) || saved.usedBytes < 0 || !Number.isSafeInteger(saved.windowStart) || saved.windowStart < 0 || !Number.isSafeInteger(saved.resetAt) || saved.resetAt <= saved.windowStart || saved.resetAt - saved.windowStart > 8760 * HOUR) throw new Error('Invalid quota ledger');
  return { version: 1, config: normalizeQuotaConfig(saved.config), usedBytes: saved.usedBytes, windowStart: saved.windowStart, resetAt: saved.resetAt };
}

function preserveResponseMetadata(wrapped, original) {
  for (const key of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, key, { value: original[key], enumerable: true });
  const clone = wrapped.clone.bind(wrapped);
  Object.defineProperty(wrapped, 'clone', { value: () => preserveResponseMetadata(clone(), original) });
  return wrapped;
}

/** A single-process ledger. The application instance lock owns the data directory. */
export class QuotaStore extends EventEmitter {
  constructor(directory, { now = Date.now, writeState = writeLedger } = {}) {
    super();
    this.directory = directory;
    this.file = join(directory, 'download-quota.json');
    this.now = now;
    this.writeState = writeState;
    this.state = { version: 1, config: normalizeQuotaConfig(), usedBytes: 0, windowStart: 0, resetAt: 24 * HOUR };
    this.saving = Promise.resolve();
    this.initialized = false;
    this.failure = null;
  }

  async init() {
    try {
      await mkdir(this.directory, { recursive: true });
      let saved;
      try { saved = validateLedger(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved) this.state = saved;
      else {
        const start = this.#time();
        const initial = { ...this.state, windowStart: start, resetAt: start + this.state.config.periodHours * HOUR };
        await this.writeState(this.file, initial);
        this.state = initial;
      }
      this.initialized = true;
      await this.refresh();
      return this;
    } catch (cause) {
      this.failure = storageError(cause);
      this.initialized = false;
      this.emit('change', this.snapshot());
      throw this.failure;
    }
  }

  snapshot() {
    const { config, usedBytes, windowStart, resetAt } = this.state;
    return {
      config: { ...config }, usedBytes, remainingBytes: Math.max(0, config.limitBytes - usedBytes),
      windowStart, resetAt, exhausted: !!this.failure || (config.enabled && usedBytes >= config.limitBytes),
      storageError: this.failure?.message || null
    };
  }

  #time() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - 8760 * HOUR) throw new Error('Invalid quota clock');
    return time;
  }

  #renew(state) {
    const time = this.#time();
    if (time < state.resetAt) return state;
    const duration = state.config.periodHours * HOUR;
    const windowStart = state.resetAt + Math.floor((time - state.resetAt) / duration) * duration;
    return { ...state, usedBytes: 0, windowStart, resetAt: windowStart + duration };
  }

  #serialize(operation, signal) {
    const result = this.saving.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (!this.initialized) throw this.failure || storageError(new Error('QuotaStore.init() is required'));
      return operation();
    });
    this.saving = result;
    return result;
  }

  async #commit(next, { signal } = {}) {
    if (next === this.state && !this.failure) return;
    signal?.throwIfAborted();
    const previous = this.snapshot();
    const renewed = next.windowStart !== this.state.windowStart;
    try { await this.writeState(this.file, next); }
    catch (cause) {
      this.failure = storageError(cause);
      this.emit('change', this.snapshot());
      throw this.failure;
    }
    this.state = next;
    this.failure = null;
    const current = this.snapshot();
    this.emit('change', current);
    if (renewed) this.emit('renewed', current);
    if (current.exhausted && (!previous.exhausted || renewed)) this.emit('exhausted', current);
    signal?.throwIfAborted();
  }

  refresh({ signal } = {}) {
    return this.#serialize(async () => {
      await this.#commit(this.#renew(this.state), { signal });
      return this.snapshot();
    }, signal);
  }

  configure(input) {
    const config = normalizeQuotaConfig(input);
    return this.#serialize(async () => {
      const current = this.#renew(this.state);
      let next = { ...current, config };
      // Before any usage, make the first chosen duration effective immediately.
      // A spent window keeps its deadline, and a rollback cannot move its anchor back.
      if (current.usedBytes === 0 && config.periodHours !== current.config.periodHours) {
        const windowStart = Math.max(this.#time(), current.windowStart);
        next = { ...next, windowStart, resetAt: windowStart + config.periodHours * HOUR };
      }
      await this.#commit(next);
      return this.snapshot();
    });
  }

  assertAvailable({ signal } = {}) {
    return this.#serialize(async () => {
      await this.#commit(this.#renew(this.state), { signal });
      if (this.snapshot().exhausted) throw new QuotaExceededError(this.state.resetAt);
      return this.snapshot();
    }, signal);
  }

  consume(bytes, { signal } = {}) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new Error('عدد بايتات غير صالح لحصة التنزيل.'));
    return this.#serialize(async () => {
      const current = this.#renew(this.state);
      if (!current.config.enabled || bytes === 0) {
        await this.#commit(current, { signal });
        return bytes;
      }
      const granted = Math.min(bytes, Math.max(0, current.config.limitBytes - current.usedBytes));
      await this.#commit(granted ? { ...current, usedBytes: current.usedBytes + granted } : current, { signal });
      if (!granted) throw new QuotaExceededError(this.state.resetAt);
      return granted;
    }, signal);
  }

  wrapFetch(fetchImpl) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    return async (input, init) => {
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      await this.assertAvailable({ signal });
      const response = await fetchImpl(input, init);
      if (!response.body) return response;
      let reader;
      let limited = false;
      const cancel = async reason => {
        try { if (reader) await reader.cancel(reason); else await response.body.cancel(reason); }
        catch { /* A disconnected upstream must not hide the quota result. */ }
      };
      const body = new ReadableStream({
        pull: async controller => {
          try {
            if (limited) throw new QuotaExceededError(this.state.resetAt);
            reader ||= response.body.getReader();
            const { value, done } = await reader.read();
            // Reading EOF is allowed at the exact limit, so a complete file succeeds.
            if (done) { controller.close(); return; }
            const granted = await this.consume(value.byteLength, { signal });
            if (granted < value.byteLength) {
              limited = true;
              await cancel(new QuotaExceededError(this.state.resetAt));
            }
            controller.enqueue(granted === value.byteLength ? value : value.subarray(0, granted));
          } catch (error) {
            await cancel(error);
            controller.error(error);
          }
        },
        cancel
      }, { highWaterMark: 0 });
      return preserveResponseMetadata(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), response);
    };
  }
}
