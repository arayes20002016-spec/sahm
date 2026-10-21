import { parse, serialize, serializeOuter } from 'parse5';

function nodesOf(document) {
  const nodes = [], pending = [document];
  while (pending.length) {
    const node = pending.pop(); nodes.push(node);
    if (node.childNodes) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]);
    if (node.content) pending.push(node.content);
  }
  return nodes;
}

function cssAddress(value) {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|(.))/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
}

export function transformCss(source, resolve) {
  let result = '';
  const quotedEnd = start => {
    let index = start + 1;
    while (index < source.length) { if (source[index] === '\\') index += 2; else if (source[index++] === source[start]) break; }
    return index;
  };
  const replacement = value => JSON.stringify(resolve(cssAddress(value), 'asset')).replace(/\\n|\\r/g, '');
  for (let index = 0; index < source.length;) {
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2), next = end < 0 ? source.length : end + 2;
      result += source.slice(index, next); index = next; continue;
    }
    const imported = source.slice(index).match(/^@import\s+(["'])/i);
    if (imported) {
      const start = index + imported[0].length - 1, end = quotedEnd(start);
      result += source.slice(index, start) + replacement(source.slice(start + 1, end - 1)); index = end; continue;
    }
    if (["'", '"'].includes(source[index])) { const end = quotedEnd(index); result += source.slice(index, end); index = end; continue; }
    const functionStart = !/[\w-]/.test(source[index - 1] || '') && source.slice(index).match(/^url\s*\(\s*/i);
    if (functionStart) {
      const start = index + functionStart[0].length;
      let end = start, value;
      if (["'", '"'].includes(source[start])) { end = quotedEnd(start); value = source.slice(start + 1, end - 1); while (/\s/.test(source[end] || '') && end < source.length) end++; }
      else { while (end < source.length && source[end] !== ')') { if (source[end] === '\\') end += 2; else end++; } value = source.slice(start, end).trim(); }
      if (source[end] === ')') { result += `url(${replacement(value)})`; index = end + 1; continue; }
    }
    result += source[index++];
  }
  return result;
}

// Static module specifiers are the part of JavaScript that can be mirrored without executing a site.
export function transformModule(source, resolve) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const start = index, char = source[index];
    if (/\s/.test(char)) { index++; continue; }
    if (source.startsWith('//', index)) { const end = source.indexOf('\n', index + 2); index = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', index)) { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue; }
    if (['"', "'", '`'].includes(char)) {
      index++;
      while (index < source.length) { if (source[index] === '\\') index += 2; else if (source[index++] === char) break; }
      tokens.push({ type: char === '`' ? 'template' : 'string', start, end: index, value: source.slice(start + 1, index - 1) });
    } else if (/[\w$]/.test(char)) {
      index++; while (index < source.length && /[\w$]/.test(source[index])) index++;
      tokens.push({ type: 'word', start, end: index, value: source.slice(start, index) });
    } else { index++; tokens.push({ type: char, start, end: index, value: char }); }
  }
  const replacements = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'word' || !['import', 'export'].includes(token.value) || tokens[index - 1]?.type === '.') continue;
    let target;
    if (token.value === 'import' && tokens[index + 1]?.type === 'string') target = tokens[index + 1];
    else if (token.value === 'import' && tokens[index + 1]?.type === '(' && tokens[index + 2]?.type === 'string') target = tokens[index + 2];
    else if (tokens[index + 1]?.type !== '.') {
      for (let next = index + 1; next < tokens.length && ![';', 'template'].includes(tokens[next].type); next++) {
        if (tokens[next].type === 'word' && tokens[next].value === 'from' && tokens[next + 1]?.type === 'string') { target = tokens[next + 1]; break; }
        if (tokens[next].type === 'word' && ['import', 'export', 'function', 'const', 'let', 'var'].includes(tokens[next].value)) break;
      }
    }
    if (target && /^(?:\.{1,2}\/|\/|https?:\/\/)/i.test(target.value)) replacements.push({ ...target, replacement: JSON.stringify(resolve(target.value, 'asset')) });
  }
  let result = source;
  for (const item of replacements.reverse()) result = result.slice(0, item.start) + item.replacement + result.slice(item.end);
  return result;
}

function transformSrcset(source, resolve) {
  // Commas inside a data URL belong to that URL; the descriptor terminates it.
  const candidates = [];
  let position = 0;
  while (position < source.length) {
    while (/[\s,]/.test(source[position] || '') && position < source.length) position++;
    const start = position;
    while (position < source.length && !/\s/.test(source[position])) position++;
    let address = source.slice(start, position), descriptor = '';
    if (!address) break;
    if (address.endsWith(',')) address = address.replace(/,+$/, '');
    else {
      const descriptorStart = position;
      while (position < source.length && source[position] !== ',') position++;
      descriptor = source.slice(descriptorStart, position).trim();
    }
    candidates.push(`${resolve(address, 'asset')}${descriptor ? ` ${descriptor}` : ''}`);
    position++;
  }
  return candidates.join(', ');
}

const assetAttributes = { img: ['src'], script: ['src'], source: ['src'], video: ['src', 'poster'], audio: ['src'], track: ['src'], input: ['src'], embed: ['src'], object: ['data'], image: ['href', 'xlink:href'], use: ['href', 'xlink:href'] };

const secretName = /(?:^|[-_.])(?:token|auth(?:orization)?|api[_-]?key|password|passwd|secret|session(?:id)?|signature|sig|credentials?|cookie|jwt|csrf|xsrf|nonce)(?:$|[-_.])|^(?:phpsessid|jsessionid)$/i;
const renderedUrlAttributes = new Set(['href', 'src', 'poster', 'xlink:href', 'background', 'cite', 'longdesc']);
const secretAttribute = name => secretName.test(name.replace(/([a-z])([A-Z])/g, '$1-$2'));

function snapshotAddress(address) {
  const value = address.trim();
  if (!value || /^data:image\//i.test(value)) return address;
  try {
    const url = new URL(value, 'https://sahm.invalid/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(secretAttribute)) return '';
    const fragment = new URLSearchParams(decodeURIComponent(url.hash.replace(/^#/, '')).split('?').at(-1));
    if ([...fragment.keys()].some(secretAttribute)) return '';
    return address;
  } catch { return ''; }
}

/** A rendered copy is an inert snapshot. Authentication state stays in the browser session. */
export function sanitizeRenderedHtml(source) {
  const document = parse(source);
  const remove = node => {
    const siblings = node.parentNode?.childNodes;
    if (siblings) siblings.splice(siblings.indexOf(node), 1);
  };
  for (const node of nodesOf(document)) {
    if (node.nodeName === '#comment') { remove(node); continue; }
    if (!node.tagName) continue;
    const attribute = name => node.attrs.find(item => item.name === name)?.value || '';
    const hidden = node.attrs.some(item => item.name === 'hidden') || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(attribute('style'));
    const secretControl = ['input', 'textarea', 'select'].includes(node.tagName) && (['hidden', 'password'].includes(attribute('type').toLowerCase()) || secretAttribute(attribute('name')) || secretAttribute(attribute('id')) || /(?:current|new)-password|one-time-code/i.test(attribute('autocomplete')));
    if (hidden || secretControl || ['script', 'noscript', 'template', 'object', 'embed'].includes(node.tagName)) { remove(node); continue; }
    if (node.tagName === 'meta' && !node.attrs.some(item => item.name === 'charset') && !/^viewport$/i.test(attribute('name'))) { remove(node); continue; }
    if (node.tagName === 'link') {
      const rel = attribute('rel').toLowerCase().split(/\s+/);
      if (rel.some(value => ['manifest', 'modulepreload', 'prefetch', 'prerender', 'preconnect', 'dns-prefetch'].includes(value)) || rel.includes('preload') && !['image', 'font', 'style'].includes(attribute('as').toLowerCase())) { remove(node); continue; }
    }
    node.attrs = node.attrs.filter(item => !/^on|^data-/i.test(item.name) && !['nonce', 'integrity', 'crossorigin', 'ping', 'action', 'formaction', 'method', 'formmethod', 'target', 'formtarget', 'srcdoc', 'autofocus', 'autocomplete'].includes(item.name));
    for (const item of node.attrs) {
      if (renderedUrlAttributes.has(item.name)) item.value = snapshotAddress(item.value);
      else if (['srcset', 'imagesrcset'].includes(item.name)) item.value = transformSrcset(item.value, snapshotAddress);
      else if (item.name === 'style') item.value = transformCss(item.value, snapshotAddress);
    }
    if (node.tagName === 'style') for (const child of node.childNodes || []) if (child.nodeName === '#text') child.value = transformCss(child.value, snapshotAddress);
    if (['input', 'textarea', 'select', 'button'].includes(node.tagName) && !node.attrs.some(item => item.name === 'disabled')) node.attrs.push({ name: 'disabled', value: '' });
  }
  return serialize(document);
}

export function sanitizeRenderedSvg(source) {
  const svg = nodesOf(parse(sanitizeRenderedHtml(source))).find(node => node.tagName === 'svg');
  return svg ? serializeOuter(svg) : '';
}

export function isLoginDocument(source, pageUrl) {
  const document = parse(source), nodes = nodesOf(document);
  const loginWords = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|تسجيل\s*الدخول|تسجيل\s*دخول)/i;
  const loginPath = value => {
    try { return /(?:^|\/)(?:login|logon|signin|sign-in|auth|sessions?)(?:\/|$)/i.test(new URL(value, pageUrl).pathname); }
    catch { return false; }
  };
  const text = node => nodesOf(node).filter(item => item.nodeName === '#text').map(item => item.value).join(' ');
  const loginTitle = nodes.some(node => node.tagName === 'title' && loginWords.test(text(node)));
  for (const form of nodes.filter(node => node.tagName === 'form')) {
    const descendants = nodesOf(form);
    if (!descendants.some(node => node.tagName === 'input' && node.attrs.some(item => item.name === 'type' && item.value.toLowerCase() === 'password'))) continue;
    const action = form.attrs.find(item => item.name === 'action')?.value || '';
    if (loginPath(pageUrl) || loginTitle || loginWords.test(text(form)) || action && loginPath(action)) return true;
  }
  return false;
}

export function transformHtml(source, pageUrl, resolve, { offline = false, rendered = false } = {}) {
  const document = parse(source), nodes = nodesOf(document);
  const baseNode = nodes.find(node => node.tagName === 'base');
  let base = pageUrl;
  if (baseNode) {
    try { base = new URL(baseNode.attrs.find(attr => attr.name === 'href')?.value || '', pageUrl).href; } catch {}
  }
  for (const node of nodes) {
    if (!node.tagName) continue;
    const attr = name => node.attrs.find(item => item.name === name);
    const update = (name, kind) => { const item = attr(name); if (item) item.value = resolve(item.value, kind, base); };
    if (['a', 'area', 'iframe', 'frame'].includes(node.tagName)) update(node.tagName === 'iframe' || node.tagName === 'frame' ? 'src' : 'href', 'page');
    for (const name of assetAttributes[node.tagName] || []) update(name, 'asset');
    if (node.namespaceURI === 'http://www.w3.org/2000/svg' && node.tagName !== 'a' && !(assetAttributes[node.tagName] || []).includes('href')) update('href', 'asset');
    if (node.tagName === 'link') {
      const rel = attr('rel')?.value.toLowerCase().split(/\s+/) || [];
      if (rel.some(value => ['stylesheet', 'icon', 'preload', 'modulepreload', 'manifest', 'apple-touch-icon'].includes(value))) update('href', 'asset');
      else if (offline) node.attrs = node.attrs.filter(item => item.name !== 'href');
    }
    for (const name of ['srcset', 'imagesrcset']) { const item = attr(name); if (item) item.value = transformSrcset(item.value, (value, kind) => resolve(value, kind, base)); }
    if (attr('style')) attr('style').value = transformCss(attr('style').value, (value, kind) => resolve(value, kind, base));
    if (node.tagName === 'style') for (const child of node.childNodes || []) if (child.nodeName === '#text') child.value = transformCss(child.value, (value, kind) => resolve(value, kind, base));
    if (node.tagName === 'script' && attr('type')?.value === 'module' && !attr('src')) for (const child of node.childNodes || []) if (child.nodeName === '#text') child.value = transformModule(child.value, (value, kind) => resolve(value, kind, base));
    if (!offline) continue;
    node.attrs = node.attrs.filter(item => !['integrity', 'crossorigin', 'ping', 'nonce'].includes(item.name));
    if (node.tagName === 'meta' && attr('charset')) attr('charset').value = 'utf-8';
    if (node.tagName === 'meta' && /^content-type$/i.test(attr('http-equiv')?.value || '') && attr('content')) attr('content').value = 'text/html; charset=utf-8';
    if (node.tagName === 'form') { node.attrs = node.attrs.filter(item => !['action', 'method', 'target'].includes(item.name)); if (!rendered) node.attrs.push({ name: 'onsubmit', value: 'return false' }); }
    if (node.tagName === 'base' || (node.tagName === 'meta' && /^(?:refresh|content-security-policy)$/i.test(attr('http-equiv')?.value || ''))) {
      const siblings = node.parentNode?.childNodes;
      if (siblings) siblings.splice(siblings.indexOf(node), 1);
    }
  }
  if (offline) {
    const head = nodes.find(node => node.tagName === 'head');
    const policy = rendered
      ? "default-src 'self' data: blob:; connect-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'self' data:;"
      : "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; form-action 'none'; base-uri 'none'; object-src 'self'; frame-src 'self' data:;";
    if (head) head.childNodes.unshift({ nodeName: 'meta', tagName: 'meta', attrs: [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: policy }], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: head });
  }
  return serialize(document);
}

export function transformSvg(source, pageUrl, resolve, options) {
  const document = parse(transformHtml(source, pageUrl, resolve, options));
  const svg = nodesOf(document).find(node => node.tagName === 'svg');
  if (svg && options?.offline) for (const node of nodesOf(svg)) {
    if (node.attrs) node.attrs = node.attrs.filter(attr => !/^on/i.test(attr.name));
    if (node.tagName === 'script') {
      const siblings = node.parentNode?.childNodes;
      if (siblings) siblings.splice(siblings.indexOf(node), 1);
    }
  }
  return svg ? serializeOuter(svg) : source;
}
