import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import tls from 'node:tls';

export const MAX_CLIENT_CERTIFICATE_BYTES = 8 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const error = (message, code) => Object.assign(new Error(message), { code });

export function normalizeClientCertificateOrigin(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\]/.test(input) || !/^https:\/\/[^/?#]+\/?$/i.test(input)) throw error('حدّد أصل HTTPS فقط لشهادة العميل، دون مسار أو بيانات حساب.', 'CLIENT_CERTIFICATE_ORIGIN');
  let url;
  try { url = new URL(input); } catch { throw error('أصل شهادة العميل غير صالح.', 'CLIENT_CERTIFICATE_ORIGIN'); }
  if (url.protocol !== 'https:' || !url.hostname || url.hostname.includes('*') || url.username || url.password || input.includes('@') || url.pathname !== '/' || url.search || url.hash) throw error('أصل شهادة العميل غير صالح.', 'CLIENT_CERTIFICATE_ORIGIN');
  return url.origin;
}

function normalizeProfile(input) {
  if (!object(input) || Object.keys(input).some(key => !['origin', 'pfxFile', 'enabled'].includes(key))) throw error('إعدادات شهادة العميل غير صالحة.', 'CLIENT_CERTIFICATE_CONFIG');
  const origin = normalizeClientCertificateOrigin(input.origin);
  if (typeof input.pfxFile !== 'string' || !isAbsolute(input.pfxFile) || input.pfxFile.length > 4096 || /[\x00-\x1f\x7f]/.test(input.pfxFile) || /^\\\\[.?]\\/.test(input.pfxFile)) throw error('اختر مسارًا مطلقًا لملف PFX أو P12 عادي.', 'CLIENT_CERTIFICATE_CONFIG');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw error('حالة شهادة العميل غير صالحة.', 'CLIENT_CERTIFICATE_CONFIG');
  return { origin, pfxFile: input.pfxFile, enabled: input.enabled ?? true };
}

export function normalizeClientCertificates(input = []) {
  if (!Array.isArray(input) || input.length > 32) throw error('الحد الأقصى 32 أصلًا لشهادات العميل.', 'CLIENT_CERTIFICATE_CONFIG');
  const origins = new Set();
  return input.map(value => {
    const profile = normalizeProfile(value);
    if (origins.has(profile.origin)) throw error('يوجد إعداد مكرر لشهادة العميل لهذا الأصل.', 'CLIENT_CERTIFICATE_CONFIG');
    origins.add(profile.origin);
    return profile;
  });
}

export function clientCertificateKey(origin) {
  return 'client-cert:' + createHash('sha256').update(normalizeClientCertificateOrigin(origin)).digest('hex');
}

function sameFile(first, second) { return first.dev === second.dev && first.ino === second.ino; }
function regularFile(stat) { return stat.isFile() && stat.size > 0n && stat.size <= BigInt(MAX_CLIENT_CERTIFICATE_BYTES); }

async function readPfx(file) {
  let handle;
  try {
    const before = await lstat(file, { bigint: true });
    if (!regularFile(before) || before.isSymbolicLink()) throw new Error();
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat({ bigint: true });
    if (!regularFile(opened) || !sameFile(before, opened)) throw new Error();
    const chunks = []; let bytes = 0;
    while (bytes <= MAX_CLIENT_CERTIFICATE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_CLIENT_CERTIFICATE_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (bytes > MAX_CLIENT_CERTIFICATE_BYTES || BigInt(bytes) !== opened.size || !regularFile(named) || named.isSymbolicLink() || !sameFile(opened, named) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new Error();
    return Buffer.concat(chunks, bytes);
  } catch {
    // Native filesystem errors can contain the private file path. Do not expose them.
    throw error('تعذّر قراءة ملف شهادة العميل. اختر ملفًا عاديًا ثابتًا حجمه من بايت واحد إلى 8 ميجابايت.', 'CLIENT_CERTIFICATE_FILE');
  } finally { await handle?.close().catch(() => {}); }
}

function checkPfx(options) {
  let probe;
  let secureContext;
  try {
    secureContext = tls.createSecureContext(options);
    probe = new tls.TLSSocket(undefined, { secureContext });
    const certificate = probe.getX509Certificate();
    if (!certificate) throw new Error();
    const now = Date.now();
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) throw error('شهادة العميل غير سارية حاليًا. اختر شهادة ضمن فترة صلاحيتها.', 'CLIENT_CERTIFICATE_VALIDITY');
    if (certificate.keyUsage?.length && !certificate.keyUsage.some(usage => ['1.3.6.1.5.5.7.3.2', '2.5.29.37.0'].includes(usage))) throw error('الشهادة المختارة لا تسمح بمصادقة عميل TLS.', 'CLIENT_CERTIFICATE_PURPOSE');
  } catch (failure) {
    if (['CLIENT_CERTIFICATE_VALIDITY', 'CLIENT_CERTIFICATE_PURPOSE'].includes(failure.code)) throw failure;
    // OpenSSL error text may contain provider details; the passphrase is never echoed.
    throw error('تعذّر فتح شهادة العميل أو مطابقة مفتاحها. راجع ملف PFX وعبارة مروره.', 'CLIENT_CERTIFICATE_INVALID');
  } finally { probe?.destroy(); }
  return secureContext;
}

export async function loadClientCertificate(inputOrigin, inputProfile, secret = '') {
  const origin = normalizeClientCertificateOrigin(inputOrigin), profile = normalizeProfile(inputProfile);
  if (!profile.enabled || profile.origin !== origin) return null;
  if (typeof secret !== 'string' || secret.length > 4096 || /[\x00-\x1f\x7f]/.test(secret)) throw error('عبارة مرور شهادة العميل غير صالحة.', 'CLIENT_CERTIFICATE_SECRET');
  const options = { pfx: await readPfx(profile.pfxFile), passphrase: secret };
  checkPfx(options);
  // Only client identity options are returned. Server trust and hostname checking stay enabled.
  return options;
}
