import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const transfers = new AsyncLocalStorage();
const ruleError = () => new Error('قاعدة النطاق غير صالحة. استخدم اسمًا أو *.example.com، ومنفذًا اختياريًا، وحدود اتصالات صحيحة.');
export function normalizeServerRules(input = []) {
  if (!Array.isArray(input) || input.length > 64) throw ruleError();
  const seen = new Set();
  return input.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'port', 'connections', 'fileConnections', 'speedLimit', 'directory', 'category'].includes(key))) throw ruleError();
    if (typeof value.host !== 'string' || !value.host || value.host.length > 253 || /[\s/@\\?#\x00-\x1f]/.test(value.host)) throw ruleError();
    const wildcard = value.host.startsWith('*.');
    const text = wildcard ? value.host.slice(2) : value.host;
    let parsed;
    try { parsed = new URL(`http://${text}/`); } catch { throw ruleError(); }
    if (parsed.port || text.includes('*') || text.includes('%') || parsed.hostname.endsWith('.') || (text.startsWith('[') ? !/^\[[\da-f:.]+\]$/i.test(text) : text.includes(':'))) throw ruleError();
    const host = parsed.hostname.toLowerCase();
    if (!host || wildcard && isIP(host.replace(/^\[|\]$/g, '')) || !host.startsWith('[') && host.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw ruleError();
    const port = value.port ?? null, connections = value.connections ?? 16, fileConnections = value.fileConnections ?? 16, speedLimit = value.speedLimit ?? 0;
    if (port !== null && (!Number.isSafeInteger(port) || port < 1 || port > 65535) || !Number.isInteger(connections) || connections < 1 || connections > 32 || !Number.isInteger(fileConnections) || fileConnections < 1 || fileConnections > 16 || !Number.isSafeInteger(speedLimit) || speedLimit < 0 || speedLimit > 1024 ** 4) throw ruleError();
    const directory = value.directory === '' ? null : value.directory ?? null, category = value.category ?? '';
    if (directory !== null && (typeof directory !== 'string' || !isAbsolute(directory) || /[\0\r\n]/.test(directory)) || typeof category !== 'string' || category.length > 80 || /[\x00-\x1f\x7f]/.test(category)) throw ruleError();
    const pattern = (wildcard ? '*.' : '') + host, key = `${pattern}:${port ?? '*'}`;
    if (seen.has(key)) throw new Error('توجد قاعدتان للنطاق والمنفذ نفسيهما.');
    seen.add(key);
    return { host: pattern, port, connections, fileConnections, speedLimit, directory, category: category.trim() };
  });
}
export function serverAddress(input) {
  const url = new URL(input);
  const port = Number(url.port || ({ 'http:': 80, 'https:': 443, 'ftp:': 21, 'ftps:': 990 })[url.protocol]);
  if (!port) throw ruleError();
  return { host: url.hostname.toLowerCase(), port, key: `${url.hostname.toLowerCase()}:${port}` };
}
export function resolveServerRule(input, rules = []) {
  const { host, port } = serverAddress(input);
  let selected = null, score = -1;
  for (const rule of rules) {
    if (rule.port !== null && rule.port !== port) continue;
    const wildcard = rule.host.startsWith('*.');
    if (wildcard ? !host.endsWith(rule.host.slice(1)) || host === rule.host.slice(2) : host !== rule.host) continue;
    const candidate = (wildcard ? 0 : 10000) + rule.host.length * 2 + (rule.port === null ? 0 : 1);
    if (candidate > score) { selected = rule; score = candidate; }
  }
  return selected;
}
export function limitedRate(...values) { const positive = values.filter(value => Number.isFinite(value) && value > 0); return positive.length ? Math.min(...positive) : 0; }
export function withServerTransfer(callback) { return transfers.run({ id: randomUUID(), speedLimit: 0 }, callback); }
export function transferSpeedLimit() { return transfers.getStore()?.speedLimit || 0; }

export class ServerConnectionLimits {
  constructor(rules = []) { this.rules = normalizeServerRules(rules); this.servers = new Map(); this.closed = false; }
  setRules(rules) { this.rules = normalizeServerRules(rules); for (const state of this.servers.values()) this.drain(state); }
  get active() { return [...this.servers.values()].reduce((sum, state) => sum + state.active + state.waiting.length, 0); }
  acquire(input, { signal = new AbortController().signal } = {}) {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('أُغلقت حدود الاتصالات.'));
    if (!this.rules.length) return Promise.resolve(null);
    const rule = resolveServerRule(input, this.rules), scope = transfers.getStore();
    if (rule && scope) scope.speedLimit = limitedRate(scope.speedLimit, rule.speedLimit);
    if (!rule) return Promise.resolve(null);
    const address = serverAddress(input);
    let state = this.servers.get(address.key);
    if (!state) { state = { key: address.key, active: 0, scopes: new Map(), waiting: [] }; this.servers.set(address.key, state); }
    if (state.waiting.length >= 1024) return Promise.reject(new Error('قائمة انتظار اتصالات الخادم ممتلئة.'));
    return new Promise((resolve, reject) => {
      const entry = { input, signal, scope, resolve, reject };
      entry.abort = () => {
        const position = state.waiting.indexOf(entry);
        if (position >= 0) { state.waiting.splice(position, 1); signal.removeEventListener('abort', entry.abort); reject(signal.reason); this.drain(state); }
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      state.waiting.push(entry); this.drain(state);
    });
  }
  drain(state) {
    for (let index = 0; index < state.waiting.length;) {
      const entry = state.waiting[index], rule = resolveServerRule(entry.input, this.rules);
      if (state.active >= (rule?.connections ?? Infinity) || entry.scope && (state.scopes.get(entry.scope.id) || 0) >= (rule?.fileConnections ?? Infinity)) { index++; continue; }
      state.waiting.splice(index, 1); entry.signal.removeEventListener('abort', entry.abort);
      state.active++;
      if (entry.scope) state.scopes.set(entry.scope.id, (state.scopes.get(entry.scope.id) || 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true; state.active--;
        if (entry.scope) { const count = state.scopes.get(entry.scope.id) - 1; if (count) state.scopes.set(entry.scope.id, count); else state.scopes.delete(entry.scope.id); }
        this.drain(state);
      };
      entry.resolve({ release, rule, scope: entry.scope });
    }
    if (!state.active && !state.waiting.length) this.servers.delete(state.key);
  }
  close() {
    this.closed = true;
    for (const state of this.servers.values()) for (const entry of state.waiting.splice(0)) { entry.signal.removeEventListener('abort', entry.abort); entry.reject(new Error('أُغلقت حدود الاتصالات.')); }
  }
}

export function createFlowThrottle(rate, signal) {
  let next = Date.now();
  return async bytes => {
    if (!rate) return;
    next = Math.max(next, Date.now()) + bytes * 1000 / rate;
    await delay(Math.ceil(Math.max(0, next - Date.now())), undefined, { signal });
  };
}
export function holdServerResponse(response, lease, signal, decorate = response => response) {
  if (!response.body) { lease.release(); return response; }
  let reader, controller, finished = false;
  const cleanup = () => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); lease.release(); };
  const cancel = async reason => { try { if (reader) await reader.cancel(reason); else await response.body.cancel(reason); } catch {} finally { cleanup(); } };
  const abort = () => { controller.error(signal.reason); void cancel(signal.reason); };
  const throttle = createFlowThrottle(lease.scope ? 0 : lease.rule?.speedLimit || 0, signal);
  const body = new ReadableStream({
    start(value) { controller = value; },
    async pull(value) {
      try {
        signal.throwIfAborted(); reader ||= response.body.getReader();
        const chunk = await reader.read();
        if (chunk.done) { cleanup(); value.close(); }
        else { await throttle(chunk.value.byteLength); signal.throwIfAborted(); value.enqueue(chunk.value); }
      } catch (error) { await cancel(error); if (!signal.aborted) value.error(error); }
    }, cancel
  }, { highWaterMark: 0 });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  function metadata(wrapped) {
    for (const name of ['url', 'type', 'redirected']) Object.defineProperty(wrapped, name, { value: response[name], enumerable: true });
    const clone = wrapped.clone.bind(wrapped);
    Object.defineProperty(wrapped, 'clone', { value: () => metadata(clone()) });
    return decorate(wrapped);
  }
  return metadata(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
}
