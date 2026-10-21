import { readFile, open, stat } from 'node:fs/promises';
import { requestDownload, downloadHttpUrl } from './request-context.mjs';
import { replaceCheckpoint } from './checkpoint.mjs';

export async function inspectReplacement(previousUrl, nextUrl, destination, { signal } = {}) {
  const url = downloadHttpUrl(nextUrl);
  const response = await requestDownload(url, { headers: { Range: 'bytes=0-0' }, signal });
  const range = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') || '');
  const etag = response.headers.get('etag');
  const total = range ? Number(range[1]) : Number(response.headers.get('content-length')) || null;
  const encoding = response.headers.get('content-encoding');
  const html = /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') || '');
  await response.body?.cancel();
  if (html) throw new Error('الرابط الجديد يعرض صفحة ويب؛ أدخل رابط الملف أو أعد التقاطه من المتصفح.');
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(destination + '.resume.json', 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('تعذّر قراءة معلومات الملف الجزئي.'); }
  const previousOrigin = new URL(previousUrl).origin;
  const sameOrigin = previousOrigin === new URL(url).origin && previousOrigin === new URL(response.url || url).origin;
  if (!checkpoint || !sameOrigin || (encoding && encoding !== 'identity') || response.status !== 206 || !range || !etag || etag.startsWith('W/') || checkpoint.validator !== etag || checkpoint.size !== Number(range[1]) || !checkpoint.ranged || checkpoint.url !== previousUrl) return { url, checkpoint: null, preservedBytes: 0, total };
  const parts = checkpoint.parts;
  if (!Array.isArray(parts) || !parts.length || parts.length > 1024) throw new Error('معلومات أجزاء التنزيل غير صالحة.');
  let end = 0, preservedBytes = 0;
  for (const part of parts) {
    if (![part.start, part.end, part.done].every(Number.isSafeInteger) || part.start !== end || part.end < part.start || part.done < 0 || part.done > part.end - part.start + 1) throw new Error('معلومات أجزاء التنزيل غير صالحة.');
    end = part.end + 1; preservedBytes += part.done;
  }
  if (end !== checkpoint.size || (await stat(destination + '.part')).size !== checkpoint.size) throw new Error('حجم الملف الجزئي غير صالح.');
  return { url, checkpoint: { ...checkpoint, url }, preservedBytes, total };
}

export async function publishReplacement(destination, checkpoint) {
  if (!checkpoint) return false;
  const file = destination + '.resume.json';
  const handle = await open(file + '.tmp', 'w');
  try { await handle.writeFile(JSON.stringify(checkpoint)); await handle.sync(); }
  finally { await handle.close(); }
  await replaceCheckpoint(file + '.tmp', file);
  return true;
}
