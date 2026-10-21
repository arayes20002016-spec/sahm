import { supportedUrl } from './capture-policy.mjs';

export const POST_ALARM = 'sahm-completed-post';
const STORE = 'completedPostDownloads';
const MAX_PENDING = 128;
const RETENTION = 7 * 24 * 60 * 60 * 1000;

export class PostDownloads {
  constructor({ storage, search, send, settings, status, alarm = async () => {}, now = Date.now }) {
    Object.assign(this, { storage, search, send, settings, status, alarm, now });
    this.writes = Promise.resolve();
    this.syncing = null;
  }

  update(change) {
    const task = this.writes.catch(() => {}).then(async () => {
      const saved = (await this.storage.get(STORE))[STORE];
      const state = {
        profile: typeof saved?.profile === 'string' && /^[a-f0-9-]{36}$/.test(saved.profile) ? saved.profile : crypto.randomUUID(),
        entries: (Array.isArray(saved?.entries) ? saved.entries : []).filter(entry =>
          Number.isSafeInteger(entry.id) && entry.id >= 0 && typeof entry.startTime === 'string'
          && Number.isFinite(Date.parse(entry.startTime)) && typeof entry.usesCredentials === 'boolean'
          && Number.isSafeInteger(entry.createdAt) && entry.createdAt <= this.now() && this.now() - entry.createdAt < RETENTION).slice(-MAX_PENDING),
      };
      const result = await change(state);
      await this.storage.set({ [STORE]: state });
      await this.alarm(state.entries.length > 0);
      return result;
    });
    this.writes = task;
    return task;
  }

  track(item, observed) {
    return this.update(state => {
      if (!Number.isSafeInteger(item.id) || item.id < 0 || !Number.isFinite(Date.parse(item.startTime))
        || observed.method !== 'POST' || observed.attachment !== true) throw new Error('Invalid observed POST download');
      if (state.entries.some(entry => entry.id === item.id && entry.startTime === item.startTime)) return;
      if (state.entries.length >= MAX_PENDING) throw new Error('Too many pending browser downloads');
      // Store identifiers only. URLs, headers, bodies and filesystem paths stay out of this journal.
      state.entries.push({ id: item.id, startTime: item.startTime, usesCredentials: observed.usesCredentials, createdAt: this.now() });
    });
  }

  reconcile() {
    this.reconcileRequested = true;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      do { this.reconcileRequested = false; await this.synchronize(); } while (this.reconcileRequested);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async synchronize() {
    const snapshot = await this.update(state => structuredClone(state));
    for (const entry of snapshot.entries) {
      const remove = () => this.update(state => { state.entries = state.entries.filter(value => value.id !== entry.id || value.startTime !== entry.startTime); });
      const policy = await this.settings();
      if (!policy.enabled || !policy.allowPost || (entry.usesCredentials && !policy.allowSession)) { await remove(); continue; }
      const [item] = await this.search({ id: entry.id });
      if (!item || item.startTime !== entry.startTime || item.exists === false || item.error === 'USER_CANCELED') { await remove(); continue; }
      if (item.state !== 'complete') continue;
      const url = item.finalUrl || item.url;
      if (item.incognito || item.byExtensionId || item.danger !== 'safe' || !supportedUrl(url) || !supportedUrl(item.url)
        || policy.excludedDomains.some(domain => new URL(url).hostname === domain || new URL(url).hostname.endsWith('.' + domain))) {
        await remove(); continue;
      }
      const requestId = 'post:' + snapshot.profile + ':' + entry.id + ':' + Date.parse(entry.startTime);
      let response;
      try {
        response = await this.send({
          v: 1, type: 'browser-complete', requestId, expiresAt: this.now() + 8000,
          source: 'automatic', url, method: 'POST', requestObserved: true, postApproved: true,
          sessionApproved: policy.allowSession === true, usesCredentials: entry.usesCredentials,
          attachment: true, state: 'complete', danger: 'safe',
          browserFile: { path: item.filename, bytes: Number.isSafeInteger(item.fileSize) && item.fileSize >= 0 ? item.fileSize : item.bytesReceived },
        });
      } catch { await this.status({ captured: false, reason: 'app-unavailable' }); break; }
      if (response?.v === 1 && response.requestId === requestId && response.ok === true && response.durable === true && typeof response.jobId === 'string' && response.jobId) {
        await remove();
        await this.status({ captured: true, reason: 'browser-completed', jobId: response.jobId });
      } else if (response?.error === 'capture-disabled') {
        await remove();
        await this.status({ captured: false, reason: 'app-policy-off' });
      } else {
        await this.status({ captured: false, reason: 'app-unavailable' });
        break;
      }
    }
  }
}
