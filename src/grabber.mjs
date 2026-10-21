import { parse } from 'parse5';
import { transportFetch } from './transport.mjs';
import { requestDownload } from './request-context.mjs';

function webUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function extractLinks(html, pageUrl, limit = 200) {
  const document = parse(html);
  const nodes = [], pending = [document];
  while (pending.length) {
    const node = pending.pop(); nodes.push(node);
    if (node.childNodes) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  let base = pageUrl;
  const baseNode = nodes.find(node => node.tagName === 'base');
  if (baseNode) base = webUrl(baseNode.attrs.find(a => a.name === 'href')?.value, pageUrl) || base;
  const found = new Map();
  let truncated = false;
  for (const node of nodes) {
    if (!['a', 'source', 'video', 'audio', 'img'].includes(node.tagName)) continue;
    const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
    const address = node.tagName === 'a' ? attrs.href : attrs.src;
    if (!address || address.startsWith('#')) continue;
    const url = webUrl(address, base);
    if (!url || url === pageUrl || found.has(url)) continue;
    if (found.size >= limit) { truncated = true; break; }
    let filename;
    try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download'); }
    catch { filename = 'download'; }
    found.set(url, { url, name: attrs.download || filename });
  }
  return { url: pageUrl, links: [...found.values()], truncated };
}

export async function discoverLinks(input, { signal = AbortSignal.timeout(20000), limit = 200, fetchImpl = transportFetch } = {}) {
  const url = webUrl(input);
  if (!url) throw new Error('أدخل رابط صفحة HTTP أو HTTPS صالحًا.');
  const response = await requestDownload(url, { signal, fetchImpl, requestContext: { headers: { accept: 'text/html,application/xhtml+xml' } } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); throw new Error('الرابط لا يُرجع صفحة HTML. استخدم «إضافة رابط» لتنزيل ملف مباشر.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error('الصفحة أكبر من الحد المسموح: 2 ميجابايت.');
    chunks.push(chunk);
  }
  return extractLinks(Buffer.concat(chunks).toString('utf8'), response.url, limit);
}
