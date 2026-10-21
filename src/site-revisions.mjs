import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSiteMirror } from './site-mirror.mjs';

const indexName = '.sahm-site-index.json';
const versionsName = '.sahm-site-versions';
const conflict = () => Object.assign(new Error('تغيّرت ملفات النسخة محليًا. أُوقف التحديث لحماية التعديلات؛ استعد الملفات الأصلية أو أنشئ مشروعًا جديدًا.'), { code: 'SITE_LOCAL_CONFLICT' });
export function normalizeSiteSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['enabled', 'intervalMinutes'].includes(key)) || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 10080) throw new Error('حدّد تفعيل المزامنة وفاصلًا من دقيقة إلى سبعة أيام.');
  return { enabled: value.enabled, intervalMinutes: value.intervalMinutes };
}
export function validRevision(value) { return value === 'legacy' || typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value); }

async function directory(path, create) {
  if (create) await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict();
  return realpath(path);
}
export async function siteRevisionDirectory(base, revision, { create = false } = {}) {
  if (!validRevision(revision)) throw new Error('معرّف إصدار الموقع غير صالح.');
  const root = await directory(resolve(base), create);
  if (revision === 'legacy') return root;
  // Check each existing component before creating a child; junctions are never followed.
  const parentPath = join(root, versionsName);
  const existing = await lstat(parentPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw conflict();
  const parent = await directory(parentPath, create);
  const childPath = join(parent, revision);
  const childInfo = await lstat(childPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (childInfo && (!childInfo.isDirectory() || childInfo.isSymbolicLink())) throw conflict();
  const child = await directory(childPath, create);
  if (relative(root, child) !== join(versionsName, revision)) throw conflict();
  return child;
}

async function inventory(root, signal) {
  const files = [];
  async function visit(folder, depth = 0) {
    if (depth > 64) throw conflict();
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const path = join(folder, entry.name), local = relative(root, path).split(sep).join('/');
      if (local === indexName || local === versionsName) continue;
      if (entry.isSymbolicLink()) throw conflict();
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile()) {
        if (files.length >= 50000) throw conflict();
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(path, { signal })) { hash.update(chunk); bytes += chunk.length; }
        files.push({ path: local, bytes, sha256: hash.digest('hex') });
      } else throw conflict();
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
const hashText = value => createHash('sha256').update(value).digest('hex');
const visible = files => files.filter(file => !file.path.split('/').some(part => part.startsWith('.')) && file.path !== 'sahm-mirror.json');

export async function captureSiteRevision(root, { signal } = {}) {
  const files = await inventory(root, signal);
  const content = JSON.stringify({ version: 1, files });
  // The durable job record owns this hash. Inventory checks never modify a published copy.
  return { hash: hashText(content), files: visible(files) };
}
export async function verifySiteRevision(root, expected, options) {
  if (!/^[\da-f]{64}$/.test(expected || '')) throw conflict();
  const result = await captureSiteRevision(root, options);
  if (result.hash !== expected) throw conflict();
  return result;
}
export function compareSiteRevisions(previous, next) {
  const before = new Map((previous?.files || []).map(file => [file.path, file.sha256]));
  const after = new Map(next.files.map(file => [file.path, file.sha256]));
  return {
    updated: [...after].filter(([path, hash]) => before.get(path) !== hash).length,
    unchanged: [...after].filter(([path, hash]) => before.get(path) === hash).length,
    removed: [...before.keys()].filter(path => !after.has(path)).length
  };
}
export function canPublishSiteRevision(manifest) {
  if (!manifest.resources.some(resource => resource.url === manifest.rootUrl && resource.state === 'complete' && resource.path === 'index.html')) return false;
  if (manifest.state === 'complete') return true;
  const scopeReasons = new Set(['outside-origin', 'excluded', 'not-included', 'depth-limit', 'session-action-excluded', 'robots-disallowed']);
  return manifest.state === 'partial' && manifest.resources.every(resource => resource.state === 'complete' || resource.state === 'failed' && resource.error === 'robots-disallowed') && manifest.errors.every(error => scopeReasons.has(error.reason));
}

export async function createSiteRevalidator(fetchImpl, previousDirectory) {
  const statistics = { notModified: 0 };
  if (!previousDirectory) return { fetch: fetchImpl, statistics };
  const manifest = await readSiteMirror(previousDirectory);
  const resources = new Map(manifest.resources.filter(item => item.state === 'complete' && item.finalUrl === item.url).map(item => [item.url, item]));
  return { statistics, fetch: async (input, init = {}) => {
    const resource = resources.get(String(input));
    const validHeader = value => typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/.test(value);
    const etag = validHeader(resource?.etag) && !resource.etag.startsWith('W/') ? resource.etag : null;
    const modified = validHeader(resource?.lastModified) ? resource.lastModified : null;
    if (!resource || !etag && !modified || init.method && init.method !== 'GET') return fetchImpl(input, init);
    const headers = new Headers(init.headers);
    headers.set(etag ? 'if-none-match' : 'if-modified-since', etag || modified);
    const response = await fetchImpl(input, { ...init, headers });
    if (response.status !== 304) return response;
    await response.body?.cancel();
    const path = resolve(previousDirectory, resource.rawPath), relation = relative(previousDirectory, path);
    if (isAbsolute(relation) || relation.startsWith('..') || !(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink() || !(await realpath(path)).startsWith(await realpath(previousDirectory) + sep)) throw conflict();
    const data = await readFile(path);
    statistics.notModified++;
    return new Response(data, { headers: { 'content-type': resource.contentType, 'content-length': String(data.length), ...(etag ? { etag } : {}), ...(modified ? { 'last-modified': modified } : {}) } });
  } };
}
