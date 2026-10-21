(() => {
  'use strict';

  const { excludedPage, mediaTarget, mediaTargetLabel } = globalThis.sahmMediaTargets;
  const overlays = new Map();
  const maxVideos = 32;
  const abort = new AbortController();
  let preferences = { enabled: false, showVideoButton: true, videoPanelMode: 'full', excludedDomains: [] };
  let scanTimer;
  let frame;
  let lastPageUrl = location.href;
  let activeOverlay;

  const styleText = `
    :host { all: initial; position: fixed; z-index: 2147483646; display: block; direction: var(--sahm-direction, rtl); width: max-content; max-width: min(320px, calc(100vw - 16px)); pointer-events: none; color-scheme: light; font: 13px/1.5 "Segoe UI Variable", "Segoe UI", Tahoma, sans-serif; color: #202020; }
    :host([hidden]) { display: none !important; }
    * { box-sizing: border-box; direction: var(--sahm-direction, rtl); }
    .anchor { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
    button { pointer-events: auto; font: inherit; cursor: pointer; touch-action: manipulation; }
    .trigger { display: flex; align-items: center; gap: 6px; min-height: 32px; border: 1px solid #3882bd; border-radius: 16px; padding: 4px 11px; color: #fff; background: #095fa7; white-space: nowrap; }
    .trigger.compact { min-width: 32px; padding: 7px; }
    .trigger.compact span { display: none; }
    .trigger:hover { background: #034e8d; }
    .trigger:active { background: #003b70; }
    .trigger:disabled { cursor: wait; color: #fff; background: #405f79; border-color: #70879b; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 4px #005fb8; }
    svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .panel { pointer-events: auto; width: max-content; max-width: 100%; max-height: calc(100vh - 56px); overflow-y: auto; overscroll-behavior: contain; padding: 5px; background: #fff; border: 1px solid #b7b7b7; border-radius: 6px; }
    .panel[hidden], .status[hidden] { display: none; }
    .panel-heading { margin: 3px 7px 6px; color: #606060; font-size: 12px; }
    .quality { display: block; width: 100%; min-height: 32px; text-align: start; overflow-wrap: anywhere; padding: 5px 9px; border: 0; border-radius: 3px; background: #fff; color: #202020; }
    .quality:hover, .quality:focus-visible { background: #e7f0fa; outline-color: #005fb8; outline-offset: -2px; box-shadow: none; }
    .quality:disabled { color: #606060; cursor: default; background: #fff; }
    .media-options { width: 290px; max-width: 100%; padding: 4px 7px; }
    .media-options label { display: grid; gap: 4px; margin-bottom: 9px; }
    .media-options [hidden] { display: none; }
    .media-options select { width: 100%; min-width: 0; max-width: 100%; min-height: 30px; font: inherit; background: #fff; color: #202020; border: 1px solid #b7b7b7; border-radius: 3px; pointer-events: auto; }
    .media-options select:disabled { color: #606060; }
    .media-options select:focus-visible { outline: 2px solid #005fb8; outline-offset: 1px; }
    .media-estimate { margin: 7px 0; color: #606060; font-size: 12px; }
    .status { pointer-events: auto; max-width: 300px; padding: 6px 10px; border: 1px solid #b7b7b7; border-radius: 4px; background: #fff; color: #202020; overflow-wrap: anywhere; }
    .status.error { color: #8b211f; }
    ::selection { background: #c4dff5; color: #202020; }
    @media (pointer: coarse) { .trigger, .quality { min-height: 44px; } }
    @media (forced-colors: active) { .trigger, .panel, .status { border: 1px solid ButtonText; } }
  `;

  async function message(payload) {
    try { return await chrome.runtime.sendMessage(payload); }
    catch { return { ok: false, error: __sahmT("تعذّر الاتصال بسَهم. أعد تحميل الصفحة وتحقق من تشغيل التطبيق.") }; }
  }

  function allowed() {
    return preferences.enabled && preferences.showVideoButton && !excludedPage(location.href, preferences.excludedDomains);
  }

  async function loadPreferences() {
    const response = await message({ type: 'sahm-media-settings' });
    const { language } = await chrome.storage.local.get({ language: 'ar' });
    if (sahmI18n.validLanguage(language) && language !== sahmI18n.getLanguage()) {
      sahmI18n.setLanguage(language);
      for (const overlay of overlays.values()) { overlay.abort.abort(); overlay.host.remove(); }
      overlays.clear(); activeOverlay = null;
    }
    preferences = {
      enabled: response?.enabled === true,
      showVideoButton: response?.showVideoButton !== false,
      videoPanelMode: response?.videoPanelMode === 'mini' ? 'mini' : 'full',
      excludedDomains: Array.isArray(response?.excludedDomains) ? response.excludedDomains : []
    };
    scheduleScan();
  }

  function targetFor(video) {
    return mediaTarget({
      pageUrl: location.href,
      sources: [video.currentSrc, video.getAttribute('src'), ...Array.from(video.querySelectorAll('source[src]'), source => source.getAttribute('src'))],
      encrypted: Boolean(video.mediaKeys || overlays.get(video)?.encrypted)
    });
  }

  function closePanel(overlay, restoreFocus = false) {
    overlay.panel.hidden = true;
    overlay.trigger.setAttribute('aria-expanded', 'false');
    if (activeOverlay === overlay) activeOverlay = null;
    if (restoreFocus) overlay.trigger.focus({ preventScroll: true });
  }

  function showStatus(overlay, text, error = false) {
    overlay.status.textContent = text;
    overlay.status.hidden = false;
    overlay.status.classList.toggle('error', error);
    clearTimeout(overlay.statusTimer);
    overlay.statusTimer = setTimeout(() => {
      overlay.status.hidden = true;
      scheduleLayout();
    }, error ? 9000 : 4500);
  }

  async function download(overlay, target, quality = 'best', selection = {}) {
    closePanel(overlay);
    overlay.busy = true;
    overlay.trigger.disabled = true;
    showStatus(overlay, __sahmT("جارٍ الإرسال إلى سَهم…"));
    const response = await message({ type: 'sahm-media-download', url: target.url, kind: target.kind, quality, ...selection, title: document.title.slice(0, 240) });
    overlay.busy = false;
    overlay.trigger.disabled = false;
    showStatus(overlay, response?.ok === true && response.jobId ? __sahmT("أُضيف إلى سَهم") : sahmI18n.formatMessage(response?.error) || __sahmT("تعذّر إرسال الفيديو. تحقق من تشغيل سَهم واتصاله بالإضافة."), response?.ok !== true || !response.jobId);
  }

  function menu(overlay, title) {
    if (activeOverlay) closePanel(activeOverlay);
    overlay.panel.replaceChildren();
    overlay.panel.setAttribute('role', 'menu');
    overlay.panel.setAttribute('aria-label', title);
    const heading = document.createElement('p');
    heading.className = 'panel-heading';
    heading.textContent = title;
    overlay.panel.append(heading);
  }

  function openMenu(overlay) {
    overlay.panel.hidden = false;
    overlay.trigger.setAttribute('aria-expanded', 'true');
    activeOverlay = overlay;
    overlay.panel.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    scheduleLayout();
  }

  async function chooseQuality(overlay, target) {
    const pageUrl = location.href;
    overlay.busy = true;
    overlay.trigger.disabled = true;
    showStatus(overlay, __sahmT("جارٍ قراءة جودات الفيديو…"));
    const response = await message({ type: 'sahm-media-inspect', url: target.url, kind: target.kind });
    overlay.busy = false;
    overlay.trigger.disabled = false;
    if (!overlay.video.isConnected || location.href !== pageUrl || (target.kind === 'youtube' && targetFor(overlay.video).url !== target.url)) return;
    if (response?.ok !== true || !Array.isArray(response.qualities) || !response.qualities.length) {
      return showStatus(overlay, sahmI18n.formatMessage(response?.error) || __sahmT("تعذّر قراءة الفيديو. جرّب مجددًا أو تحقق من اتصال سَهم."), true);
    }
    overlay.status.hidden = true;
    if (response.mediaOptions?.combinations?.length && globalThis.sahmMediaOptions) {
      menu(overlay, __sahmT("خيارات الفيديو والصوت"));
      overlay.panel.setAttribute('role', 'group');
      overlay.trigger.setAttribute('aria-haspopup', 'true');
      const fields = document.createElement('div'); fields.className = 'media-options';
      const picker = globalThis.sahmMediaOptions.mount(fields, response.mediaOptions);
      const start = document.createElement('button'); start.type = 'button'; start.className = 'quality'; start.textContent = __sahmT("تنزيل باستخدام سَهم");
      start.addEventListener('click', () => {
        if (location.href !== pageUrl || (target.kind === 'youtube' && targetFor(overlay.video).url !== target.url)) return closePanel(overlay, true);
        const selection = picker.selection(); download(overlay, target, selection.quality, selection);
      });
      overlay.panel.append(fields, start); openMenu(overlay); picker.focus(); return;
    }
    menu(overlay, __sahmT("اختر جودة التنزيل"));
    for (const quality of response.qualities.slice(0, 12)) {
      if (typeof quality?.id !== 'string' || typeof quality?.label !== 'string') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality';
      button.setAttribute('role', 'menuitem');
      button.textContent = sahmI18n.formatMessage(quality.label).slice(0, 80);
      button.addEventListener('click', () => {
        // A SPA may have moved to another video while the menu was open.
        if (location.href !== pageUrl || (target.kind === 'youtube' && targetFor(overlay.video).url !== target.url)) return closePanel(overlay, true);
        download(overlay, target, quality.id);
      });
      overlay.panel.append(button);
    }
    if (!overlay.panel.querySelector('button')) return showStatus(overlay, __sahmT("لا تتوفر جودة قابلة للتنزيل لهذا الفيديو."), true);
    openMenu(overlay);
  }

  async function discoveredMedia(overlay) {
    const pageUrl = location.href;
    const response = await message({ type: 'sahm-media-list' });
    if (!overlay.video.isConnected || location.href !== pageUrl) return;
    if (response?.ok !== true) return showStatus(overlay, sahmI18n.formatMessage(response?.error) || __sahmT("تعذّر قراءة وسائط المشغّل. حدّث الصفحة ثم أعد المحاولة."), true);
    if (!Array.isArray(response.candidates) || !response.candidates.length) return showStatus(overlay, __sahmT("لم يُرصد رابط قابل للتنزيل. شغّل الفيديو ثم أعد المحاولة؛ قد يكون نوع البث غير مدعوم حاليًا."), true);
    menu(overlay, __sahmT("اختر من الوسائط المرصودة في هذا المشغّل"));
    for (const candidate of response.candidates.slice(0, 32)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quality';
      button.setAttribute('role', 'menuitem');
      button.textContent = mediaTargetLabel(candidate);
      button.disabled = candidate.kind === 'stream' && candidate.requiresSession;
      if (button.disabled) button.title = __sahmT("بث HLS وDASH الذي يتطلب جلسة غير مدعوم حاليًا.");
      button.addEventListener('click', () => {
        closePanel(overlay);
        if (candidate.kind === 'stream') chooseQuality(overlay, candidate);
        else download(overlay, candidate);
      });
      overlay.panel.append(button);
    }
    openMenu(overlay);
  }

  async function activate(overlay) {
    if (overlay.busy) return;
    if (!overlay.panel.hidden) return closePanel(overlay);
    const target = targetFor(overlay.video);
    if (target.kind === 'unsupported') {
      if (target.reasonCode === 'encrypted') return showStatus(overlay, target.reason, true);
      return discoveredMedia(overlay);
    }
    if (target.kind === 'direct') return download(overlay, target);
    return chooseQuality(overlay, target);
  }

  function createOverlay(video) {
    const host = document.createElement('div');
    host.setAttribute('data-sahm-media-overlay', '');
    host.hidden = true;
    host.lang = sahmI18n.getLanguage(); host.dir = sahmI18n.direction();
    host.style.setProperty('--sahm-direction', sahmI18n.direction());
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = styleText;
    const anchor = document.createElement('div');
    anchor.className = 'anchor';
    const trigger = document.createElement('button');
    trigger.className = 'trigger';
    trigger.type = 'button';
    trigger.title = __sahmT("تنزيل الفيديو باستخدام سَهم");
    trigger.setAttribute('aria-label', __sahmT("تنزيل الفيديو باستخدام سَهم"));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4');
    icon.append(path);
    const label = document.createElement('span');
    label.textContent = __sahmT("تنزيل الفيديو");
    trigger.append(icon, label);
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', __sahmT("جودة الفيديو"));
    const status = document.createElement('div');
    status.className = 'status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    anchor.append(trigger, panel, status);
    shadow.append(style, anchor);
    const overlay = { video, host, trigger, panel, status, abort: new AbortController(), busy: false, encrypted: false };
    const listen = (element, type, handler) => element.addEventListener(type, handler, { signal: overlay.abort.signal });
    listen(trigger, 'click', () => activate(overlay));
    for (const type of ['loadedmetadata', 'play', 'pause', 'timeupdate']) listen(video, type, scheduleLayout);
    listen(video, 'emptied', () => {
      overlay.encrypted = Boolean(video.mediaKeys);
      closePanel(overlay);
      status.hidden = true;
      scheduleLayout();
    });
    listen(video, 'encrypted', () => { overlay.encrypted = true; closePanel(overlay); scheduleLayout(); });
    listen(shadow, 'keydown', event => {
      if (event.key === 'Escape') {
        closePanel(overlay, true);
        status.hidden = true;
        event.preventDefault();
        event.stopPropagation();
      }
      if (!panel.hidden && panel.getAttribute('role') === 'menu' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = Array.from(panel.querySelectorAll('button'));
        const current = items.indexOf(shadow.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
        event.preventDefault();
      }
    });
    overlays.set(video, overlay);
    resize.observe(video);
    intersection.observe(video);
    (document.body || document.documentElement).append(host);
    return overlay;
  }

  function destroyOverlay(overlay) {
    closePanel(overlay);
    clearTimeout(overlay.statusTimer);
    overlay.abort.abort();
    resize.unobserve(overlay.video);
    intersection.unobserve(overlay.video);
    overlay.host.remove();
    overlays.delete(overlay.video);
  }

  function layout() {
    frame = null;
    if (location.href !== lastPageUrl) {
      lastPageUrl = location.href;
      for (const overlay of overlays.values()) {
        closePanel(overlay);
        overlay.status.hidden = true;
        overlay.encrypted = Boolean(overlay.video.mediaKeys);
      }
    }
    const fullscreen = document.fullscreenElement;
    const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
    for (const overlay of overlays.values()) {
      const { video, host } = overlay;
      if (!video.isConnected) { destroyOverlay(overlay); continue; }
      const rect = video.getBoundingClientRect();
      const css = getComputedStyle(video);
      const advert = video.closest('.ad-showing, .ad-interrupting, [data-ad-status="filled"], [data-ad-slot]');
      const parent = fullscreen && fullscreen.contains(video) && fullscreen !== video ? fullscreen : document.body || document.documentElement;
      if (host.parentElement !== parent) parent.append(host);
      host.hidden = !allowed() || rect.width < 180 || rect.height < 100 || rect.bottom < 48 || rect.right < 48 || rect.top > innerHeight - 48 || rect.left > innerWidth - 48 || css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0 || Boolean(advert) || Boolean(activeShort && !activeShort.contains(video)) || Boolean(fullscreen && (fullscreen === video || !fullscreen.contains(video)));
      if (host.hidden) { closePanel(overlay); continue; }
      overlay.trigger.classList.toggle('compact', preferences.videoPanelMode === 'mini');
      if (targetFor(video).kind !== 'direct') {
        overlay.trigger.setAttribute('aria-haspopup', 'menu');
        overlay.trigger.setAttribute('aria-expanded', String(!overlay.panel.hidden));
      } else {
        overlay.trigger.removeAttribute('aria-haspopup');
        overlay.trigger.removeAttribute('aria-expanded');
      }
      const right = Math.min(innerWidth - 8, rect.right - 8);
      const top = Math.max(8, rect.top + 8);
      const width = Math.min(320, Math.max(160, right - Math.max(8, rect.left + 8)));
      host.style.maxWidth = `${width}px`;
      host.style.right = `${Math.max(8, innerWidth - right)}px`;
      host.style.top = `${top}px`;
      host.style.bottom = 'auto';
      if (!overlay.panel.hidden || !overlay.status.hidden) host.style.top = `${Math.max(8, Math.min(top, innerHeight - host.getBoundingClientRect().height - 8))}px`;
    }
  }

  function scheduleLayout() {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function scan() {
    scanTimer = null;
    for (const overlay of overlays.values()) if (!overlay.video.isConnected) destroyOverlay(overlay);
    if (allowed()) {
      for (const video of document.querySelectorAll('video')) {
        if (overlays.size >= maxVideos) break;
        if (!overlays.has(video)) createOverlay(video);
      }
    }
    scheduleLayout();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 120);
  }

  const resize = new ResizeObserver(scheduleLayout);
  const intersection = new IntersectionObserver(scheduleLayout);
  const mutation = new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' || Array.from(record.addedNodes).some(node => node.nodeType === Node.ELEMENT_NODE && !node.hasAttribute('data-sahm-media-overlay')) || Array.from(record.removedNodes).some(node => node.nodeType === Node.ELEMENT_NODE && !node.hasAttribute('data-sahm-media-overlay')))) scheduleScan();
  });
  mutation.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  for (const type of ['resize', 'scroll', 'fullscreenchange', 'popstate', 'hashchange', 'yt-navigate-finish']) {
    addEventListener(type, scheduleLayout, { passive: true, capture: true, signal: abort.signal });
  }
  addEventListener('pointerdown', event => {
    if (activeOverlay && !event.composedPath().includes(activeOverlay.host)) closePanel(activeOverlay);
  }, { capture: true, signal: abort.signal });
  const onSettingsChanged = (changes, area) => {
    if (area === 'local' && ['language', 'enabled', 'showVideoButton', 'videoPanelMode', 'excludedDomains'].some(key => changes[key])) loadPreferences();
  };
  const onMessage = (request, sender, respond) => {
    if (request?.type !== 'sahm-media-status' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
    loadPreferences().then(() => {
      scan();
      layout();
      respond({
        version: chrome.runtime.getManifest().version,
        enabled: preferences.enabled,
        showVideoButton: preferences.showVideoButton,
        excluded: excludedPage(location.href, preferences.excludedDomains),
        videoCount: document.querySelectorAll('video').length,
        frameCount: document.querySelectorAll('iframe').length,
        visibleOverlayCount: [...overlays.values()].filter(overlay => !overlay.host.hidden).length,
      });
    });
    return true;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    abort.abort();
    mutation.disconnect();
    resize.disconnect();
    intersection.disconnect();
    chrome.storage.onChanged.removeListener(onSettingsChanged);
    chrome.runtime.onMessage.removeListener(onMessage);
    clearTimeout(scanTimer);
    if (frame) cancelAnimationFrame(frame);
    for (const overlay of overlays.values()) destroyOverlay(overlay);
  }, { once: true });
  loadPreferences();
})();

