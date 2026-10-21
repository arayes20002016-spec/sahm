// Runs in an isolated Chromium world. No application API is exposed to the page.
async function snapshotDocument(options = {}) {
  const waitMs = Math.max(0, Math.min(10_000, Number(options.waitMs) || 0));
  const maximumBytes = Math.max(1024, Math.min(32 * 1024 * 1024, Number(options.maximumBytes) || 8 * 1024 * 1024));
  const started = performance.now();
  let changed = started;
  const observer = new MutationObserver(() => { changed = performance.now(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  try {
    while (performance.now() - started < waitMs) {
      await pause(Math.min(50, Math.max(0, waitMs - (performance.now() - started))));
    }
  } finally { observer.disconnect(); }

  const clone = document.documentElement.cloneNode(true);
  const loginWords = /(?:\blog[ -]?in\b|\bsign[ -]?in\b|تسجيل\s*الدخول|تسجيل\s*دخول)/i;
  const loginPath = value => { try { return /(?:^|\/)(?:login|logon|signin|sign-in|auth)(?:\/|$)/i.test(new URL(value, location.href).pathname); } catch { return false; } };
  const isLoginPage = [...document.forms].some(form => form.querySelector('input[type="password"]') && (loginPath(location.href) || loginWords.test(document.title) || loginWords.test(form.textContent) || loginPath(form.getAttribute('action') || location.href)));
  const liveNodes = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
  const clonedNodes = [clone, ...clone.querySelectorAll('*')];
  if (liveNodes.length > 100_000) throw new Error('SITE_RENDER_TOO_LARGE');
  let embeddedBytes = 0;
  for (let index = 0; index < liveNodes.length; index += 1) {
    const live = liveNodes[index], copy = clonedNodes[index];
    if (!copy) continue;
    if (live.shadowRoot) {
      const contents = document.createDocumentFragment();
      for (const child of live.shadowRoot.childNodes) contents.append(child.cloneNode(true));
      for (const sheet of live.shadowRoot.adoptedStyleSheets || []) {
        try {
          const style = document.createElement('style');
          style.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
          contents.prepend(style);
        } catch { /* An inaccessible sheet is omitted. */ }
      }
      copy.replaceChildren(contents);
    }
    if (live.tagName === 'CANVAS' && live.width * live.height <= 4_000_000) {
      try {
        const data = live.toDataURL('image/png');
        if (data.length <= 2 * 1024 * 1024 && embeddedBytes + data.length <= maximumBytes / 2) {
          const image = document.createElement('img');
          image.src = data;
          image.width = live.width;
          image.height = live.height;
          image.alt = live.getAttribute('aria-label') || '';
          copy.replaceWith(image);
          embeddedBytes += data.length;
        }
      } catch { /* A tainted canvas cannot be exported. */ }
    }
    if (live.tagName === 'IMG' && live.currentSrc && !live.currentSrc.startsWith('blob:')) {
      copy.setAttribute('src', live.currentSrc);
      copy.removeAttribute('srcset');
      copy.removeAttribute('sizes');
    }
    if (live.tagName === 'IMG' && live.currentSrc?.startsWith('blob:') && embeddedBytes < maximumBytes / 2) {
      try {
        const response = await fetch(live.currentSrc);
        const blob = await response.blob();
        if (blob.size <= 2 * 1024 * 1024 && /^image\/(?:png|jpeg|gif|webp|avif)$/i.test(blob.type)) {
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
          if (embeddedBytes + data.length <= maximumBytes / 2) {
            copy.setAttribute('src', data); copy.removeAttribute('srcset'); copy.removeAttribute('sizes');
            embeddedBytes += data.length;
          }
        }
      } catch { /* Revoked or unsupported blob images are omitted. */ }
    }
    if (live.tagName === 'DETAILS' && live.open) copy.setAttribute('open', '');
  }
  for (const element of clone.querySelectorAll('script,noscript,iframe,object,embed,meta[http-equiv],link[rel="preconnect"],link[rel="dns-prefetch"]')) element.remove();
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'nonce' || /^data-.*(?:token|auth|csrf|session|secret|credential)/i.test(name)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'META' && /token|auth|csrf|session|secret|credential/i.test(element.getAttribute('name') || '')) element.remove();
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) {
      const descriptor = `${element.getAttribute('type') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('id') || ''} ${element.getAttribute('autocomplete') || ''}`;
      if (/password|hidden|token|csrf|secret|credential|one-time-code|username/i.test(descriptor)) { element.remove(); continue; }
      element.removeAttribute('value');
      element.removeAttribute('checked');
      element.removeAttribute('selected');
      if (element.tagName === 'TEXTAREA') element.textContent = '';
    }
    if (element.tagName === 'OPTION') element.removeAttribute('selected');
    if (element.tagName === 'FORM') {
      for (const name of ['action', 'method', 'target', 'enctype']) element.removeAttribute(name);
    }
  }
  const html = '<!doctype html>\n' + clone.outerHTML;
  if (new TextEncoder().encode(html).byteLength > maximumBytes) throw new Error('SITE_RENDER_TOO_LARGE');
  return { html, url: location.href, isLoginPage, settled: waitMs === 0 || performance.now() - changed >= 150 };
}

module.exports = { snapshotDocument };
