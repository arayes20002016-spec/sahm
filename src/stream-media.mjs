import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { transportFetch } from './transport.mjs';
import { isTransientNetworkError, retryAfterMilliseconds } from './network-retry.mjs';

const maximumManifestBytes = 2 * 1024 * 1024;
const protectedMessage = 'هذا البث مشفّر أو محمي؛ لا يدعم سَهم تنزيله.';
const unsupportedMessage = 'بيان البث غير مدعوم أو غير آمن. يتاح HLS وDASH المسجّل غير المشفّر فقط.';
const liveMessage = 'البث المباشر أو غير محدد النهاية غير مدعوم؛ اختر فيديو مسجّلًا.';

function classifiedError(error) {
  const codes = new Map([[protectedMessage, 'unsupported-encrypted'], [liveMessage, 'unsupported-live'], [unsupportedMessage, 'unsafe-media-manifest']]);
  if (codes.has(error.message)) error.code = codes.get(error.message);
  return error;
}

export function streamHttpUrl(value, base) {
  if (typeof value !== 'string' || value.length > 32768 || /[\x00-\x20\\]/.test(value)) throw new Error(unsupportedMessage);
  let url;
  try { url = new URL(value, base); } catch { throw new Error(unsupportedMessage); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error(unsupportedMessage);
  return url.href;
}

export function normalizeStreamUrl(value) {
  try {
    const url = streamHttpUrl(value);
    if (!/\.(m3u8|mpd)$/i.test(new URL(url).pathname)) throw new Error(unsupportedMessage);
    return url;
  } catch (error) { throw classifiedError(error); }
}

async function publicFetch(url, { signal, method = 'GET', range } = {}) {
  let address = streamHttpUrl(url);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await transportFetch(address, { signal, method, redirect: 'manual', headers: range ? { Range: range } : {} });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === 5) throw new Error(unsupportedMessage);
      address = streamHttpUrl(location, address);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error('تعذّر الوصول إلى البث العام دون جلسة.'), {
        code: [401, 403].includes(response.status) ? 'media-auth-required' : 'media-unavailable',
        status: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')),
      });
    }
    return { response, url: address };
  }
}

async function manifestText(url, signal) {
  const result = await publicFetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of result.response.body) {
    bytes += chunk.length;
    if (bytes > maximumManifestBytes) throw new Error('بيان البث أكبر من الحد المسموح.');
    chunks.push(chunk);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error(unsupportedMessage); }
  return { url: result.url, text: text.replace(/^\uFEFF/, '') };
}

function hlsAttributes(text) {
  const result = new Map();
  let rest = text;
  while (rest) {
    const match = /^([A-Z0-9-]+)=("[^"\r\n]*"|[^,\r\n]+)(?:,|$)/.exec(rest);
    if (!match || result.has(match[1])) throw new Error(unsupportedMessage);
    if (match[2].includes('"') && (!match[2].startsWith('"') || !match[2].endsWith('"'))) throw new Error(unsupportedMessage);
    result.set(match[1], match[2].startsWith('"') ? match[2].slice(1, -1) : match[2]);
    rest = rest.slice(match[0].length);
  }
  return result;
}

function xmlText(value) {
  const parts = [];
  let position = 0;
  for (;;) {
    const start = value.indexOf('&', position);
    if (start < 0) { parts.push(value.slice(position)); break; }
    const end = value.indexOf(';', start + 1);
    if (end < 0 || end - start > 20) throw new Error(unsupportedMessage);
    parts.push(value.slice(position, start));
    const entity = value.slice(start + 1, end);
    const standard = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(standard, entity)) parts.push(standard[entity]);
    else {
      if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) throw new Error(unsupportedMessage);
      const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isSafeInteger(point) || point < 32 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw new Error(unsupportedMessage);
      parts.push(String.fromCodePoint(point));
    }
    position = end + 1;
  }
  return parts.join('');
}

function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) throw new Error(unsupportedMessage);
  text = text.replace(/^\s*<\?xml\s[^?]*\?>/, '');
  const pieces = [];
  let commentPosition = 0;
  for (;;) {
    const start = text.indexOf('<!--', commentPosition);
    if (start < 0) { pieces.push(text.slice(commentPosition)); break; }
    const end = text.indexOf('-->', start + 4);
    if (end < 0) throw new Error(unsupportedMessage);
    pieces.push(text.slice(commentPosition, start)); commentPosition = end + 3;
  }
  text = pieces.join('');
  const root = { name: '', attributes: {}, children: [] }, stack = [root];
  let position = 0, count = 0;
  while (position < text.length) {
    if (++count > 30000 || stack.length > 32) throw new Error(unsupportedMessage);
    if (text[position] !== '<') {
      const end = text.indexOf('<', position);
      stack.at(-1).children.push(xmlText(text.slice(position, end < 0 ? text.length : end)));
      position = end < 0 ? text.length : end;
      continue;
    }
    const start = position;
    let quote = null;
    while (++position < text.length) {
      const value = text[position];
      if (position - start > 16384) throw new Error(unsupportedMessage);
      if (quote) { if (value === quote) quote = null; }
      else if (value === '"' || value === "'") quote = value;
      else if (value === '>') break;
    }
    if (position >= text.length) throw new Error(unsupportedMessage);
    const tag = text.slice(start, ++position);
    const prefix = /^<\/?([A-Za-z_][\w.:-]*)/.exec(tag);
    if (!prefix) throw new Error(unsupportedMessage);
    const name = prefix[1];
    if (tag.startsWith('</')) {
      if (stack.length === 1 || stack.at(-1).name !== name || !/^<\/[^\s/>]+\s*>$/.test(tag)) throw new Error(unsupportedMessage);
      stack.pop(); continue;
    }
    const node = { name, attributes: {}, children: [] };
    const selfClosing = /\/\s*>$/.test(tag);
    let attributes = tag.slice(prefix[0].length, -1);
    if (selfClosing) attributes = attributes.replace(/\/\s*$/, '');
    while (attributes.trim()) {
      const match = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])/.exec(attributes);
      if (!match || Object.hasOwn(node.attributes, match[1])) throw new Error(unsupportedMessage);
      const end = attributes.indexOf(match[2], match[0].length);
      if (end < 0) throw new Error(unsupportedMessage);
      const value = attributes.slice(match[0].length, end);
      if (value.includes('<')) throw new Error(unsupportedMessage);
      node.attributes[match[1]] = xmlText(value);
      attributes = attributes.slice(end + 1);
    }
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  const elements = root.children.filter(value => typeof value !== 'string');
  if (stack.length !== 1 || elements.length !== 1 || root.children.some(value => typeof value === 'string' && value.trim())) throw new Error(unsupportedMessage);
  return elements[0];
}

const localName = node => node.name.split(':').at(-1);
const children = (node, name) => node.children.filter(value => typeof value !== 'string' && localName(value) === name);
const escapeXml = value => String(value).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]);
function serializeXml(node) {
  if (typeof node === 'string') return escapeXml(node);
  return `<${node.name}${Object.entries(node.attributes).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('')}>${node.children.map(serializeXml).join('')}</${node.name}>`;
}
function seconds(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : null;
}

function assertMediaBytes(bytes) {
  const mp4 = bytes.length >= 8 && ['ftyp', 'styp', 'sidx', 'moof', 'moov', 'mdat'].includes(bytes.toString('ascii', 4, 8));
  const ts = bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47);
  const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || bytes.subarray(0, 4).equals(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  const audio = bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (!mp4 && !ts && !webm && !audio) throw Object.assign(new Error('مقطع البث لا يحتوي بيانات وسائط مدعومة.'), { code: 'unsafe-media-content' });
}

// The engine sees frozen manifests and opaque routes only. Remote playlists never reach a demuxer.
export async function prepareStream(value, { signal, allowSegments = true } = {}) {
  const canonical = normalizeStreamUrl(value);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const resources = new Map(), manifests = new Map(), fingerprints = new Map(), audioCodecs = new Map();
  const token = randomBytes(24).toString('hex');
  let origin, nextId = 0, duration = null, manifestBytes = 0, failure;
  const register = entry => {
    if (resources.size >= 10000) throw new Error(unsupportedMessage);
    const id = String(++nextId); resources.set(id, entry);
    return `/${token}/r/${id}`;
  };
  const bytesUrl = (value, base) => register({ url: streamHttpUrl(value, base) });
  const fetchManifest = async url => {
    if (fingerprints.size >= 64) throw new Error(unsupportedMessage);
    const result = await manifestText(url, combined);
    manifestBytes += Buffer.byteLength(result.text);
    if (manifestBytes > 16 * 1024 * 1024) throw new Error(unsupportedMessage);
    fingerprints.set(result.url, createHash('sha256').update(result.text).digest('hex'));
    return result;
  };
  const hls = async (url, ancestors = []) => {
    if (ancestors.length > 4 || ancestors.includes(url)) throw new Error(unsupportedMessage);
    if (manifests.has(url)) return manifests.get(url);
    const result = await fetchManifest(url);
    if (!/^#EXTM3U(?:\r?\n|$)/.test(result.text)) throw new Error(unsupportedMessage);
    const lines = result.text.split(/\r?\n/).map(line => line.trim());
    if (lines.length > 20000) throw new Error(unsupportedMessage);
    const master = lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'));
    if (!master && (!lines.includes('#EXT-X-ENDLIST') || lines.includes('#EXT-X-PLAYLIST-TYPE:EVENT'))) throw new Error(liveMessage);
    if (lines.some(line => /^#EXT-X-(PART|PRELOAD-HINT|SERVER-CONTROL|SKIP|DEFINE)(:|$)/.test(line))) throw new Error(liveMessage);
    const output = [];
    const groupCodecs = new Map();
    for (const line of lines.filter(value => value.startsWith('#EXT-X-STREAM-INF:'))) {
      const attributes = hlsAttributes(line.slice(line.indexOf(':') + 1));
      const group = attributes.get('AUDIO'), codecs = (attributes.get('CODECS') || '').split(',').filter(value => /^(mp4a|aac|opus|vorbis)(\.|$)/i.test(value));
      if (group && codecs.length === 1) {
        const values = groupCodecs.get(group) || new Set(); values.add(codecs[0]); groupCodecs.set(group, values);
      }
    }
    let variant = false, segments = 0, length = 0;
    for (const line of lines) {
      if (/^#EXT-X-(SESSION-)?KEY:/.test(line)) {
        const attributes = hlsAttributes(line.slice(line.indexOf(':') + 1));
        if (line.startsWith('#EXT-X-SESSION-KEY:') || attributes.get('METHOD') !== 'NONE' || attributes.size !== 1) throw new Error(protectedMessage);
        continue;
      }
      if (line.startsWith('#EXTINF:')) length += Number(line.slice(8).split(',')[0]) || 0;
      if (line.startsWith('#EXT-X-STREAM-INF:')) variant = true;
      if (!line || line.startsWith('#')) {
        if (/\bURI=/.test(line)) {
          const tag = line.slice(0, line.indexOf(':'));
          const attrs = hlsAttributes(line.slice(line.indexOf(':') + 1));
          const uri = attrs.get('URI');
          if (!uri || !/\bURI="/.test(line) || !['#EXT-X-MEDIA', '#EXT-X-MAP', '#EXT-X-I-FRAME-STREAM-INF'].includes(tag)) throw new Error(unsupportedMessage);
          if (tag === '#EXT-X-MEDIA' && attrs.get('TYPE') === 'SUBTITLES') continue;
          if (tag === '#EXT-X-MEDIA' && !['AUDIO', 'VIDEO'].includes(attrs.get('TYPE'))) throw new Error(unsupportedMessage);
          const route = tag === '#EXT-X-MAP' ? bytesUrl(uri, result.url) : await hls(streamHttpUrl(uri, result.url), [...ancestors, url]);
          const codecs = groupCodecs.get(attrs.get('GROUP-ID'));
          if (tag === '#EXT-X-MEDIA' && attrs.get('TYPE') === 'AUDIO' && codecs?.size === 1) audioCodecs.set(route, [...codecs][0]);
          output.push(line.replace(/URI="[^"]*"/, `URI="SAHM_ORIGIN${route}"`));
        } else output.push(line.replace(/,?SUBTITLES="[^"]*"/, ''));
      } else if (variant) {
        output.push(`SAHM_ORIGIN${await hls(streamHttpUrl(line, result.url), [...ancestors, url])}`); variant = false;
      } else { output.push(`SAHM_ORIGIN${bytesUrl(line, result.url)}`); segments++; }
    }
    if (variant || !master && (!segments || !Number.isFinite(length) || length <= 0 || length > 7 * 86400)) throw new Error(unsupportedMessage);
    if (!master) duration = Math.max(duration || 0, length);
    const route = register({ manifest: output.join('\n'), mime: 'application/vnd.apple.mpegurl' });
    manifests.set(url, route); return route;
  };
  const dash = async url => {
    const result = await fetchManifest(url), root = parseXml(result.text);
    if (localName(root) !== 'MPD') throw new Error(unsupportedMessage);
    if (root.attributes.type && root.attributes.type !== 'static') throw new Error(liveMessage);
    if (children(root, 'Period').length !== 1) throw new Error(unsupportedMessage);
    const declaredDuration = seconds(root.attributes.mediaPresentationDuration);
    let representations = 0;
    const check = node => {
      if (typeof node === 'string') return;
      const name = localName(node);
      if (['ContentProtection', 'pssh', 'pro'].includes(name) || Object.keys(node.attributes).some(key => /default_KID/i.test(key))) throw new Error(protectedMessage);
      if (['Location', 'PatchLocation', 'UTCTiming', 'SegmentBase', 'RepresentationIndex', 'BitstreamSwitching'].includes(name) || Object.keys(node.attributes).some(key => /(?:^|:)(href|actuate)$/.test(key) || key === 'xml:base')) throw new Error(unsupportedMessage);
      if (name === 'SegmentTemplate' && node.children.some(child => typeof child !== 'string' && localName(child) !== 'SegmentTimeline')) throw new Error(unsupportedMessage);
      if (name === 'SegmentList' && node.children.some(child => typeof child !== 'string' && !['SegmentTimeline', 'Initialization', 'SegmentURL'].includes(localName(child)))) throw new Error(unsupportedMessage);
      if (name === 'S') {
        const repeat = Number(node.attributes.r || 0), length = Number(node.attributes.d);
        const timestamp = node.attributes.t === undefined ? 0 : Number(node.attributes.t);
        if (repeat < 0) throw new Error(liveMessage);
        if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(repeat) || repeat > 10000 || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(unsupportedMessage);
      }
      for (const child of node.children) check(child);
    };
    check(root);
    const templateUrl = (value, base, attributes) => {
      if (typeof value !== 'string') throw new Error(unsupportedMessage);
      let remote = value.replace(/\$(RepresentationID|Bandwidth)\$/g, (_, key) => {
        const replacement = key === 'RepresentationID' ? attributes.id : attributes.bandwidth;
        if (!/^[\w.-]{1,128}$/.test(replacement || '')) throw new Error(unsupportedMessage);
        return replacement;
      });
      const variables = [];
      remote = remote.replace(/\$(Number|Time)(%0(?:[1-9]|1[0-2])d)?\$/g, match => { variables.push(match); return `SAHM_TEMPLATE_${variables.length - 1}`; });
      if (remote.includes('$') || variables.length > 4) throw new Error(unsupportedMessage);
      remote = streamHttpUrl(remote, base);
      if (!variables.length) return `SAHM_ORIGIN${register({ url: remote })}`;
      const route = register({ template: remote, variables });
      return `SAHM_ORIGIN${route}/${variables.join('/')}`;
    };
    const walk = (node, inheritedBase, inheritedSegments, periodDuration) => {
      if (typeof node === 'string') return;
      const bases = children(node, 'BaseURL');
      if (bases.length > 1) throw new Error(unsupportedMessage);
      const base = bases.length ? streamHttpUrl(bases[0].children.join('').trim(), inheritedBase) : inheritedBase;
      const name = localName(node);
      if (name === 'Period') periodDuration = seconds(node.attributes.duration) ?? declaredDuration;
      const ownSegments = [...children(node, 'SegmentTemplate'), ...children(node, 'SegmentList')];
      if (ownSegments.length > 1) throw new Error(unsupportedMessage);
      let effective = inheritedSegments;
      if (ownSegments.length) {
        const own = ownSegments[0];
        effective = inheritedSegments && inheritedSegments.name === own.name
          ? { name: own.name, attributes: { ...inheritedSegments.attributes, ...own.attributes }, children: own.children.length ? own.children : inheritedSegments.children }
          : own;
      }
      if (name === 'Representation') {
        if (++representations > 128 || !effective) throw new Error(unsupportedMessage);
        const segment = structuredClone(effective);
        if (localName(segment) === 'SegmentTemplate') {
          if (!periodDuration || periodDuration <= 0 || periodDuration > 7 * 86400) throw new Error(liveMessage);
          const timeline = children(segment, 'SegmentTimeline')[0];
          const timescale = Number(segment.attributes.timescale || 1), fragmentDuration = Number(segment.attributes.duration);
          const count = timeline ? children(timeline, 'S').reduce((sum, item) => sum + Number(item.attributes.r || 0) + 1, 0) : Math.ceil(periodDuration * timescale / fragmentDuration);
          if (!Number.isFinite(count) || count <= 0 || count > 10000 || !Number.isSafeInteger(timescale) || timescale <= 0) throw new Error(unsupportedMessage);
          segment.attributes.media = templateUrl(segment.attributes.media, base, node.attributes);
          if (segment.attributes.initialization) segment.attributes.initialization = templateUrl(segment.attributes.initialization, base, node.attributes);
          if (segment.attributes.index) throw new Error(unsupportedMessage);
        } else {
          if (!children(segment, 'SegmentURL').length) throw new Error(unsupportedMessage);
          for (const item of segment.children) {
            if (typeof item === 'string') continue;
            const initializationWithoutUrl = localName(item) === 'Initialization' && !item.attributes.sourceURL;
            const segmentWithoutUrl = localName(item) === 'SegmentURL' && !item.attributes.media;
            if (initializationWithoutUrl || segmentWithoutUrl) throw new Error(unsupportedMessage);
            for (const attr of ['media', 'index', 'sourceURL']) if (item.attributes[attr]) item.attributes[attr] = `SAHM_ORIGIN${bytesUrl(item.attributes[attr], base)}`;
          }
        }
        node.children = node.children.filter(value => typeof value === 'string' || !['BaseURL', 'SegmentTemplate', 'SegmentList'].includes(localName(value)));
        node.children.push(segment); return;
      }
      for (const child of node.children) if (typeof child !== 'string' && !['BaseURL', 'SegmentTemplate', 'SegmentList'].includes(localName(child))) walk(child, base, effective, periodDuration);
      node.children = node.children.filter(value => typeof value === 'string' || !['BaseURL', 'SegmentTemplate', 'SegmentList'].includes(localName(value)));
    };
    walk(root, result.url, null, declaredDuration);
    if (!representations) throw new Error(unsupportedMessage);
    duration = declaredDuration;
    return register({ manifest: serializeXml(root), mime: 'application/dash+xml' });
  };
  let root;
  try { root = /\.mpd$/i.test(new URL(canonical).pathname) ? await dash(canonical) : await hls(canonical); }
  catch (error) { controller.abort(); throw classifiedError(error); }
  const sockets = new Set(), validated = new Set();
  const server = createServer(async (request, response) => {
    const failed = () => { if (!response.headersSent) response.writeHead(502); response.end(); };
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const match = new RegExp(`^/${token}/r/(\\d+)(?:/([0-9/]+))?(?:\\?.*)?$`).exec(request.url || '');
      const entry = match && resources.get(match[1]);
      if (!entry) { response.writeHead(404).end(); return; }
      if (entry.manifest) {
        const body = entry.manifest.replaceAll('SAHM_ORIGIN', origin);
        response.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': Buffer.byteLength(body) });
        response.end(request.method === 'HEAD' ? undefined : body); return;
      }
      if (!allowSegments) { response.writeHead(403).end(); return; }
      let address = entry.url;
      if (entry.template) {
        const values = (match[2] || '').split('/');
        if (values.length !== entry.variables.length || values.some(value => !/^\d{1,24}$/.test(value))) { response.writeHead(404).end(); return; }
        address = entry.template.replace(/SAHM_TEMPLATE_(\d+)/g, (_, index) => values[Number(index)]);
      }
      const range = request.headers.range;
      if (range && !/^bytes=\d+-\d*$/.test(range)) { response.writeHead(416).end(); return; }
      const transfer = new AbortController();
      response.once('close', () => transfer.abort());
      const transferSignal = AbortSignal.any([combined, transfer.signal, AbortSignal.timeout(60000)]);
      if (request.method !== 'HEAD' && range && !/^bytes=0-/.test(range) && !validated.has(address)) {
        const { response: probe } = await publicFetch(address, { signal: transferSignal, range: 'bytes=0-511' });
        const reader = probe.body.getReader(), chunks = [];
        let size = 0;
        try { while (size < 512) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); size += next.value.length; } }
        finally { await reader.cancel(); }
        assertMediaBytes(Buffer.concat(chunks)); validated.add(address);
      }
      const { response: remote } = await publicFetch(address, { signal: transferSignal, method: request.method, range });
      const headers = { 'Content-Type': remote.headers.get('content-type') || 'application/octet-stream' };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (remote.headers.has(name)) headers[name] = remote.headers.get(name);
      if (request.method === 'HEAD') { response.writeHead(remote.status, headers).end(); return; }
      const reader = remote.body.getReader(), initial = [];
      let size = 0;
      while (size < 512) { const next = await reader.read(); if (next.done) break; initial.push(next.value); size += next.value.length; }
      // Nonzero range requests continue a previously validated container, not a new playlist.
      if (!range || /^bytes=0-/.test(range)) { assertMediaBytes(Buffer.concat(initial)); validated.add(address); }
      response.writeHead(remote.status, headers);
      await pipeline(Readable.from((async function* () { for (const chunk of initial) yield chunk; for (;;) { const next = await reader.read(); if (next.done) break; yield next.value; } })()), response, { signal: transferSignal });
    } catch (error) {
      if (!combined.aborted && error.name !== 'AbortError' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE' && (!failure || isTransientNetworkError(failure))) failure = error;
      failed();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = async () => { controller.abort(); for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  try {
    server.listen({ port: 0, host: '127.0.0.1', signal: combined }); await once(server, 'listening', { signal: combined });
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) { await close(); throw error; }
  return {
    url: `${origin}${root}${/\.mpd$/i.test(new URL(canonical).pathname) ? '?ext=.mpd' : '?ext=.m3u8'}`,
    canonical, duration, close, failure: () => failure,
    audioCodec: url => { try { return audioCodecs.get(new URL(url).pathname); } catch { return undefined; } },
    fingerprint: createHash('sha256').update(JSON.stringify([...fingerprints].sort(([a], [b]) => a.localeCompare(b)))).digest('hex'),
  };
}
