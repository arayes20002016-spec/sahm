import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { win32 } from 'node:path';
import { domainToASCII } from 'node:url';

const schemes = new Set(['ntlm', 'negotiate', 'kerberos']);
const maxTokenBytes = 128 * 1024;
const maxLineBytes = 262144;
const nativeFile = new URL('./native/windows-auth.cs', import.meta.url);
const scriptFile = new URL('./native/windows-auth.ps1', import.meta.url);
const failure = (message, code = 'WINDOWS_AUTH_FAILED', status) => Object.assign(new Error(message), { code, ...(status && /^[a-f0-9]{8}$/.test(status) ? { sspiStatus: status } : {}) });

function normalizeHost(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s/@\\\x00-\x1f]/.test(value)) throw failure('اسم خادم مصادقة Windows غير صالح.', 'WINDOWS_AUTH_HOST');
  const unwrapped = value.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(unwrapped)) return unwrapped;
  const ascii = domainToASCII(unwrapped);
  if (!ascii || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(ascii)) throw failure('اسم خادم مصادقة Windows غير صالح.', 'WINDOWS_AUTH_HOST');
  return ascii.toLowerCase();
}

function normalizeCredentials(input) {
  if (!input || typeof input.username !== 'string' || !input.username || input.username.length > 256 || typeof input.password !== 'string' || input.password.length > 256 || /[\x00-\x1f\x7f]/.test(input.username + input.password)) throw failure('أدخل حساب Windows صالحًا.', 'WINDOWS_AUTH_CREDENTIALS');
  let username = input.username, domain = input.domain || '';
  if (typeof domain !== 'string' || domain.length > 255 || /[\x00-\x1f\x7f\\/@]/.test(domain)) throw failure('نطاق حساب Windows غير صالح.', 'WINDOWS_AUTH_CREDENTIALS');
  if (username.includes('\\')) {
    const pieces = username.split('\\');
    if (pieces.length !== 2 || !pieces[0] || !pieces[1] || domain && domain.toLowerCase() !== pieces[0].toLowerCase()) throw failure('استخدم صيغة النطاق واسم المستخدم أو اسم UPN.', 'WINDOWS_AUTH_CREDENTIALS');
    [domain, username] = pieces;
  }
  return { username, password: input.password, domain };
}

// The current Windows identity is never sent merely because a proxy challenges.
// An exact host allowlist and an explicit opt-in are required at this boundary.
export function authorizeWindowsIdentity({ host, currentAccount = false, allowedHosts = [], credentials } = {}) {
  host = normalizeHost(host);
  if (typeof currentAccount !== 'boolean' || !Array.isArray(allowedHosts) || allowedHosts.length > 128) throw failure('إعدادات حساب Windows غير صالحة.', 'WINDOWS_AUTH_POLICY');
  const hosts = allowedHosts.map(normalizeHost);
  if (currentAccount) {
    if (!hosts.includes(host)) throw failure('أضف اسم الخادم إلى قائمة السماح قبل استخدام حساب Windows الحالي.', 'WINDOWS_AUTH_NOT_ALLOWED');
    if (credentials) throw failure('اختر الحساب الحالي أو حسابًا صريحًا.', 'WINDOWS_AUTH_POLICY');
    return { host, currentAccount: true, credentials: null };
  }
  return { host, currentAccount: false, credentials: normalizeCredentials(credentials) };
}

function tokenValue(value, maximum = maxTokenBytes) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(value)) throw failure('رمز مصادقة Windows غير صالح.', 'WINDOWS_AUTH_TOKEN');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maximum || decoded.toString('base64') !== value) throw failure('رمز مصادقة Windows غير صالح.', 'WINDOWS_AUTH_TOKEN');
  return value;
}

export class WindowsAuthService {
  #child = null;
  #ready = false;
  #startup = null;
  #readyResolve = null;
  #readyReject = null;
  #startupTimer = null;
  #exited = null;
  #pending = new Map();
  #contexts = new Set();
  #sequence = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor({ platform = process.platform, systemRoot = process.env.SystemRoot, spawnImpl = spawn, bootTimeoutMs = 30000, requestTimeoutMs = 30000, nativeSource, helperScript, contextType = 'SahmWindowsAuth.ClientContext' } = {}) {
    if (typeof spawnImpl !== 'function' || !Number.isInteger(bootTimeoutMs) || bootTimeoutMs < 100 || bootTimeoutMs > 120000 || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120000 || !['SahmWindowsAuth.ClientContext', 'SahmWindowsAuth.ServerContext'].includes(contextType)) throw new TypeError('Invalid Windows authentication helper options.');
    Object.assign(this, { platform, systemRoot, spawnImpl, bootTimeoutMs, requestTimeoutMs, nativeSource, helperScript, contextType });
  }

  async #start() {
    if (this.#closed) throw failure('أُغلقت خدمة مصادقة Windows.', 'WINDOWS_AUTH_CLOSED');
    if (this.#startup) return this.#startup;
    if (this.platform !== 'win32' || typeof this.systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(this.systemRoot) || /[\0\r\n]/.test(this.systemRoot)) throw failure('مصادقة Windows متاحة على Windows فقط.', 'WINDOWS_AUTH_UNAVAILABLE');
    const starting = (async () => {
      const [source, originalScript] = await Promise.all([this.nativeSource ?? readFile(nativeFile, 'utf8'), this.helperScript ?? readFile(scriptFile, 'utf8')]);
      if (this.#closed) throw failure('أُغلقت خدمة مصادقة Windows.', 'WINDOWS_AUTH_CLOSED');
      if (typeof source !== 'string' || Buffer.byteLength(source) > 256 * 1024 || typeof originalScript !== 'string') throw failure('ملفات خدمة مصادقة Windows غير صالحة.', 'WINDOWS_AUTH_HELPER');
      const script = originalScript.replaceAll('[SahmWindowsAuth.ClientContext]', `[${this.contextType}]`);
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      const executable = win32.join(this.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await new Promise((resolve, reject) => {
        this.#readyResolve = resolve; this.#readyReject = reject;
        this.#startupTimer = setTimeout(() => this.#fail(failure('انتهت مهلة تهيئة مصادقة Windows.', 'WINDOWS_AUTH_TIMEOUT')), this.bootTimeoutMs);
        let child;
        try { child = this.spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
        catch { this.#fail(failure('تعذّر تشغيل خدمة مصادقة Windows.', 'WINDOWS_AUTH_HELPER')); return; }
        this.#child = child; this.#buffer = Buffer.alloc(0);
        this.#exited = new Promise(done => child.once('exit', done));
        child.stdout.on('data', chunk => { if (this.#child === child) this.#receive(Buffer.from(chunk)); });
        // Native diagnostics can contain identities. Drain them without logging.
        child.stderr.on('data', () => {});
        child.once('error', () => { if (this.#child === child) this.#fail(failure('تعذّر تشغيل خدمة مصادقة Windows.', 'WINDOWS_AUTH_HELPER')); });
        child.once('exit', () => { if (this.#child === child) this.#fail(failure('توقفت خدمة مصادقة Windows.', 'WINDOWS_AUTH_HELPER'), false); });
        child.stdin.on('error', () => { if (this.#child === child) this.#fail(failure('تعذّر الاتصال بخدمة مصادقة Windows.', 'WINDOWS_AUTH_HELPER')); });
        child.stdin.write(JSON.stringify({ source: Buffer.from(source, 'utf8').toString('base64') }) + '\n');
      });
    })();
    this.#startup = starting;
    try { await starting; }
    catch (error) { if (this.#startup === starting) this.#startup = null; throw error; }
  }

  #receive(chunk) {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let end;
    while ((end = this.#buffer.indexOf(10)) !== -1) {
      if (end > maxLineBytes) { this.#fail(failure('رد خدمة مصادقة Windows أكبر من الحد.', 'WINDOWS_AUTH_PROTOCOL')); return; }
      const line = this.#buffer.subarray(0, end).toString('utf8').trim(); this.#buffer = this.#buffer.subarray(end + 1);
      if (!line) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { this.#fail(failure('رد خدمة مصادقة Windows غير صالح.', 'WINDOWS_AUTH_PROTOCOL')); return; }
      if (!this.#ready && typeof reply.ready === 'boolean') {
        if (!reply.ready) { this.#fail(failure('تعذّر تهيئة خدمة مصادقة Windows.', 'WINDOWS_AUTH_HELPER')); return; }
        this.#ready = true; clearTimeout(this.#startupTimer); this.#startupTimer = null;
        this.#readyResolve?.(); this.#readyResolve = null; this.#readyReject = null;
        continue;
      }
      if (!this.#ready || !Number.isSafeInteger(reply.id) || reply.id < 1 || reply.id > this.#sequence) { this.#fail(failure('رد خدمة مصادقة Windows غير صالح.', 'WINDOWS_AUTH_PROTOCOL')); return; }
      const pending = this.#pending.get(reply.id);
      if (!pending) continue;
      this.#pending.delete(reply.id); pending.cleanup();
      if (reply.ok === true) pending.resolve(reply);
      else pending.reject(failure('رفض Windows المصادقة. تحقق من الحساب والخادم وإعدادات النطاق.', 'WINDOWS_AUTH_FAILED', reply.status));
    }
    if (this.#buffer.length > maxLineBytes) this.#fail(failure('رد خدمة مصادقة Windows أكبر من الحد.', 'WINDOWS_AUTH_PROTOCOL'));
  }

  #fail(error, kill = true) {
    clearTimeout(this.#startupTimer); this.#startupTimer = null;
    this.#readyReject?.(error); this.#readyReject = null; this.#readyResolve = null;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
    for (const context of this.#contexts) context.invalidate();
    this.#contexts.clear();
    const child = this.#child; this.#child = null; this.#ready = false; this.#startup = null; this.#buffer = Buffer.alloc(0);
    if (child && kill) child.kill();
  }

  async prepare(signal) {
    signal?.throwIfAborted();
    const starting = this.#start();
    if (signal) await new Promise((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      starting.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    });
    else await starting;
    signal?.throwIfAborted();
    if (!this.#ready || !this.#child) throw failure('مصادقة Windows غير متاحة.', 'WINDOWS_AUTH_HELPER');
  }

  async #request(request, signal) {
    await this.prepare(signal);
    if (this.#pending.size >= 64) throw failure('يوجد عدد كبير من طلبات مصادقة Windows.', 'WINDOWS_AUTH_BUSY');
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const aborted = () => {
        if (!this.#pending.delete(id)) return;
        cleanup();
        reject(signal.reason || failure('أُلغيت مصادقة Windows.', 'WINDOWS_AUTH_ABORTED'));
      };
      const timer = setTimeout(() => this.#fail(failure('انتهت مهلة مصادقة Windows.', 'WINDOWS_AUTH_TIMEOUT')), this.requestTimeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      this.#child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
    });
  }

  async createContext(options = {}) {
    const { scheme } = options;
    if (!schemes.has(scheme)) throw failure('اختر NTLM أو Negotiate أو Kerberos.', 'WINDOWS_AUTH_SCHEME');
    const identity = authorizeWindowsIdentity(options);
    const { signal } = options;
    signal?.throwIfAborted();
    if (this.#closed) throw failure('أُغلقت خدمة مصادقة Windows.', 'WINDOWS_AUTH_CLOSED');
    if (this.#contexts.size >= 32) throw failure('الحد الأقصى 32 اتصال مصادقة متزامنًا.', 'WINDOWS_AUTH_BUSY');
    const binding = options.channelBinding;
    if (binding !== undefined && (!Buffer.isBuffer(binding) || binding.length === 0 || binding.length > 16384)) throw failure('ربط قناة TLS غير صالح.', 'WINDOWS_AUTH_BINDING');
    const id = randomUUID(); let closed = false, stepping = false, steps = 0;
    const context = {
      invalidate() { closed = true; },
      step: async token => {
        if (closed) throw failure('أُغلق سياق مصادقة Windows.', 'WINDOWS_AUTH_CLOSED');
        if (stepping) throw failure('انتظر اكتمال خطوة المصادقة الحالية.', 'WINDOWS_AUTH_BUSY');
        token = tokenValue(token);
        if (++steps > 4) { await context.close(); throw failure('تجاوزت مصادقة Windows عدد المحاولات المسموح.', 'WINDOWS_AUTH_ROUNDS'); }
        stepping = true;
        try {
          const result = await this.#request({ op: 'step', context: id, token }, signal);
          const validPackage = result.package === null || result.package === undefined || ['NTLM', 'Negotiate', 'Kerberos'].includes(result.package);
          if (typeof result.token !== 'string' || typeof result.complete !== 'boolean' || !validPackage) throw failure('رد خدمة مصادقة Windows غير صالح.', 'WINDOWS_AUTH_PROTOCOL');
          if (scheme === 'kerberos' && result.complete && result.package !== 'Kerberos') throw failure('رفض سَهم تغيير Kerberos إلى آلية مصادقة أخرى.', 'WINDOWS_AUTH_PACKAGE');
          return { token: tokenValue(result.token), complete: result.complete, package: result.package || null };
        } catch (error) { await context.close(); throw error; }
        finally { stepping = false; }
      },
      close: async () => {
        if (closed) return;
        closed = true; this.#contexts.delete(context);
        if (this.#ready && !this.#closed) await this.#request({ op: 'close', context: id }).catch(() => {});
      }
    };
    this.#contexts.add(context);
    try {
      await this.#request({ op: 'create', context: id, scheme, host: identity.host, currentAccount: identity.currentAccount, username: identity.credentials?.username || '', password: identity.credentials?.password || '', domain: identity.credentials?.domain || '', channelBinding: binding?.toString('base64') || '' }, signal);
      return context;
    } catch (error) { await context.close(); throw error; }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const error = failure('أُغلقت خدمة مصادقة Windows.', 'WINDOWS_AUTH_CLOSED');
    clearTimeout(this.#startupTimer); this.#startupTimer = null;
    this.#readyReject?.(error); this.#readyReject = null; this.#readyResolve = null;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
    for (const context of this.#contexts) context.invalidate();
    this.#contexts.clear();
    const child = this.#child, exited = this.#exited;
    if (!child) return;
    child.stdin.end();
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); if (this.#child === child) this.#fail(failure('أُغلقت خدمة مصادقة Windows.', 'WINDOWS_AUTH_CLOSED')); }
  }
}
