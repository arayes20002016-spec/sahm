import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { MAX_CLIENT_CERTIFICATE_BYTES } from './client-certificates.mjs';

const maximumOutput = 12 * 1024 * 1024;
const cache = new Map(), queue = [], children = new Set();
let active = 0, generation = 0, source;
const failure = () => Object.assign(new Error('تعذّر استخراج هوية شهادة العميل في ذاكرة Windows. راجع ملف PFX وعبارة مروره وصلاحية تصدير المفتاح.'), { code: 'CLIENT_CERTIFICATE_EXTRACT' });
const aborted = () => Object.assign(new Error('أُلغي تحميل هوية شهادة العميل.'), { name: 'AbortError', code: 'ABORT_ERR' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validate(identity) {
  if (!object(identity) || Object.keys(identity).some(key => !['pfx', 'passphrase'].includes(key)) || !Buffer.isBuffer(identity.pfx) || !identity.pfx.length || identity.pfx.length > MAX_CLIENT_CERTIFICATE_BYTES || typeof identity.passphrase !== 'string' || identity.passphrase.length > 4096 || /[\x00-\x1f\x7f]/.test(identity.passphrase)) throw failure();
}

function parse(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > maximumOutput) throw failure();
  let result;
  try { result = JSON.parse(output.trim()); } catch { throw failure(); }
  if (!object(result) || result.ok !== true || Object.keys(result).some(key => !['ok', 'certificates', 'jwk'].includes(key)) || !Array.isArray(result.certificates) || !result.certificates.length || result.certificates.length > 64 || !object(result.jwk)) throw failure();
  let total = 0;
  const certificates = result.certificates.map(value => {
    if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw failure();
    const bytes = Buffer.from(value, 'base64'); total += bytes.length;
    if (total > MAX_CLIENT_CERTIFICATE_BYTES || bytes.toString('base64') !== value) throw failure();
    return new X509Certificate(bytes);
  });
  const key = createPrivateKey({ key: result.jwk, format: 'jwk' });
  if (!certificates[0].checkPrivateKey(key)) throw failure();
  // Never forward PFX or CA options: PFX certificate bags can otherwise become
  // server trust anchors in Node. Only the identity chain and matching key leave here.
  return Object.freeze({ cert: certificates.map(certificate => certificate.toString()).join('\n'), key: Buffer.from(key.export({ type: 'pkcs8', format: 'pem' })) });
}

function pump() {
  while (active < 4 && queue.length) {
    const task = queue.shift(); active++;
    task.run().then(task.resolve, task.reject).finally(() => { active--; pump(); });
  }
}

function schedule(run, cleanup) {
  if (queue.length >= 128) { cleanup(); return Promise.reject(failure()); }
  const promise = new Promise((resolve, reject) => queue.push({ run, resolve, reject, cleanup }));
  pump(); return promise;
}

async function nativeExtract(identity, epoch) {
  if (process.platform !== 'win32') throw failure();
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\x00-\x1f\x7f]/.test(systemRoot)) throw failure();
  source ||= readFile(new URL('./native/client-certificate-identity.cs', import.meta.url), 'utf8');
  const code = await source;
  if (epoch !== generation) throw failure();
  const bootstrap = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\n$source=@'\n${code}\n'@\nAdd-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -ErrorAction Stop\n[Sahm.ClientCertificateIdentity]::Run()`;
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')];
  const output = await new Promise((resolve, reject) => {
    const child = execFile(executable, args, { windowsHide: true, shell: false, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: maximumOutput, encoding: 'utf8' }, (error, stdout) => error ? reject(failure()) : resolve(stdout));
    children.add(child); child.once('close', () => children.delete(child));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ pfx: identity.pfx.toString('base64'), passphrase: identity.passphrase }));
  });
  return parse(output);
}

function observe(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

export function clientIdentityTlsOptions(identity, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  try { validate(identity); } catch { return Promise.reject(failure()); }
  const hash = createHash('sha256').update(identity.pfx).update('\0').update(identity.passphrase).digest('hex');
  const existing = cache.get(hash);
  if (existing) { cache.delete(hash); cache.set(hash, existing); return observe(existing, signal); }
  const epoch = generation;
  const snapshot = { pfx: Buffer.from(identity.pfx), passphrase: identity.passphrase };
  const promise = schedule(async () => {
    try {
      if (epoch !== generation) throw failure();
      const options = await nativeExtract(snapshot, epoch);
      if (epoch !== generation) throw failure();
      return options;
    } catch { throw failure(); }
    finally { snapshot.pfx.fill(0); }
  }, () => snapshot.pfx.fill(0));
  cache.set(hash, promise);
  while (cache.size > 32) cache.delete(cache.keys().next().value);
  promise.catch(() => { if (cache.get(hash) === promise) cache.delete(hash); });
  return observe(promise, signal);
}

export function clearClientIdentityCache() {
  generation++; cache.clear();
  for (const task of queue.splice(0)) { task.cleanup(); task.reject(failure()); }
  for (const child of children) child.kill();
}
