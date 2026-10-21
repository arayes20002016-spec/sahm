import './i18n-data.js';
import './i18n-core.js';
const sahmI18n = globalThis.sahmI18n;
const __sahmT = sahmI18n.t;
import { DEFAULT_SETTINGS, captureDecision, handoffDownload, supportedUrl } from './capture-policy.mjs';
import { POST_ALARM, PostDownloads } from './post-downloads.mjs';
import { RequestObserver } from './request-observer.mjs';
import { directMediaUrl, mediaSenderAllowed, qualityOptions, streamMediaUrl, youtubeUrl, youtubeSenderMatches } from './media-policy.mjs';
import { publicMediaOptions, validateMediaSelection } from './media-selection.mjs';

const HOST_NAME = 'com.sahm.downloader';
const observer = new RequestObserver();
const processed = new Map();
const requestFilter = { urls: ['http://*/*', 'https://*/*'] };
let bypassCheck = Promise.resolve();
let captureSettings = { ...DEFAULT_SETTINGS };

async function settings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
}

settings().then(value => { captureSettings = value; }).catch(() => {});
chrome.storage.local.get({ language: 'ar' }).then(({ language }) => { if (sahmI18n.validLanguage(language)) sahmI18n.setLanguage(language); });
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.language && sahmI18n.validLanguage(changes.language.newValue)) { sahmI18n.setLanguage(changes.language.newValue); chrome.contextMenus.update('sahm-send-link', { title: __sahmT('تنزيل الرابط باستخدام سَهم') }, () => { void chrome.runtime.lastError; }); }
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (changes[key]) captureSettings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
  if (!captureSettings.enabled || changes.allowSession || changes.allowPost) observer.clear();
  if (changes.enabled || changes.allowSession || changes.allowPost || changes.excludedDomains) posts.reconcile().catch(() => {});
});

function nativeRequest(message) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    const timeout = message.type === 'media-info' ? 115000 : message.type === 'media-enqueue' ? 20000 : 8500;
    const timer = setTimeout(() => finish(new Error(__sahmT("لم يستجب تطبيق سَهم."))), timeout);
    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port?.disconnect();
      if (error) reject(error);
      else resolve(response);
    }
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
      port.onMessage.addListener(response => finish(null, response));
      port.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message || __sahmT("التطبيق غير متصل.");
        finish(new Error(message));
      });
      port.postMessage(message);
    } catch (error) { finish(error); }
  });
}

const posts = new PostDownloads({
  storage: chrome.storage.local, settings, send: nativeRequest, status: recordStatus,
  search: query => chrome.downloads.search(query),
  alarm: async pending => {
    if (!chrome.alarms) return;
    if (!pending) await chrome.alarms.clear(POST_ALARM);
    else if (!await chrome.alarms.get(POST_ALARM)) await chrome.alarms.create(POST_ALARM, { periodInMinutes: 1 });
  },
});
chrome.downloads.onChanged?.addListener(() => { posts.reconcile().catch(() => {}); });
chrome.downloads.onErased?.addListener(() => { posts.reconcile().catch(() => {}); });
chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === POST_ALARM) posts.reconcile().catch(() => {}); });
chrome.runtime.onStartup?.addListener(() => { posts.reconcile().catch(() => {}); });
posts.reconcile().catch(() => {});

chrome.webRequest.onBeforeRequest.addListener(details => observer.beforeRequest(details, captureSettings), requestFilter);
chrome.webRequest.onBeforeSendHeaders.addListener(details => observer.beforeHeaders(details, captureSettings), requestFilter, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(details => observer.responseHeaders(details), requestFilter, ['responseHeaders']);
const pruneTimer = setInterval(() => observer.prune(), 10000);
pruneTimer.unref?.();

async function recordStatus(result) {
  await chrome.storage.local.set({ lastResult: { captured: result.captured, reason: result.reason || 'captured', time: new Date().toISOString() } });
  let badge = '';
  let title = __sahmT("سَهم — تكامل المتصفح");
  if (result.captured) {
    badge = '✓';
    title = __sahmT("سَهم — أُضيف التنزيل");
  } else if (result.reason === 'app-unavailable') {
    badge = '!';
    title = __sahmT("سَهم — تعذّر إرسال الرابط؛ افتح التطبيق وتحقق من الاتصال");
  } else if (result.reason === 'browser-completing') {
    badge = '…';
    title = __sahmT("سَهم — سيظهر الملف بعد اكتماله في المتصفح");
  }
  await chrome.action.setBadgeText({ text: badge });
  if (result.captured) await chrome.action.setBadgeBackgroundColor({ color: '#18715b' });
  await chrome.action.setTitle({ title });
}

async function processDownload(item) {
  let currentSettings;
  let bypass = false;
  bypassCheck = bypassCheck.catch(() => {}).then(async () => {
    currentSettings = await settings();
    if (currentSettings.bypassNext) {
      bypass = true;
      await chrome.storage.local.set({ bypassNext: false });
    }
  });
  await bypassCheck;
  if (bypass) return recordStatus({ captured: false, reason: 'bypass' });
  const observed = observer.take(item);
  if (captureDecision(item, currentSettings, observed) === 'browser-complete') {
    await posts.track(item, observed);
    await recordStatus({ captured: false, reason: 'browser-completing' });
    return;
  }
  const result = await handoffDownload(item, { settings: currentSettings, observed, send: nativeRequest, cancel: id => chrome.downloads.cancel(id) });
  await recordStatus(result);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let task = processed.get(item.id);
  if (!task) {
    task = processDownload(item).catch(() => {});
    processed.set(item.id, task);
    if (processed.size > 500) processed.delete(processed.keys().next().value);
  }
  // Keep the browser's filename. Holding this callback prevents a small file
  // completing before the app has durably accepted or rejected its handoff.
  task.finally(() => suggest());
  return true;
});

async function sendMedia(message, sender, current) {
  if (!mediaSenderAllowed(sender, chrome.runtime.id, current)) throw new Error(__sahmT("فعّل الالتقاط وزر الفيديو في إضافة سَهم لهذا الموقع."));
  const kind = message.kind || 'youtube';
  let url;
  if (kind === 'youtube') url = youtubeUrl(message.url);
  else if (kind === 'direct') url = directMediaUrl(message.url);
  else if (kind === 'stream') url = streamMediaUrl(message.url);
  if (!url) throw new Error(__sahmT("لا يتوفر رابط فيديو مدعوم في هذا المشغّل."));
  if (kind === 'youtube' && !await youtubeSenderMatches(url, sender, id => chrome.tabs.get(id))) throw new Error(__sahmT("تغيّر فيديو التبويب. افتح زر التنزيل مجددًا لاختيار جودة الفيديو الحالي."));
  const domain = new URL(url).hostname;
  if (current.excludedDomains.some(value => domain === value || domain.endsWith(`.${value}`))) throw new Error(__sahmT("هذا الموقع مستثنى من سَهم."));
  if (kind === 'stream') {
    const candidate = observer.mediaCandidates(sender, current).find(item => item.url === url && item.kind === 'stream');
    if (!candidate) throw new Error(__sahmT("لم تُرصد قائمة البث في هذا المشغّل. أعد تشغيل الفيديو ثم حدّث الوسائط."));
    if (candidate.requiresSession) throw new Error(__sahmT("تنزيل بث HLS وDASH الذي يتطلب جلسة دخول غير مدعوم حاليًا."));
  }
  const observed = kind === 'direct' ? observer.mediaContext(url, sender) : undefined;
  if (kind === 'direct' && !observed && observer.mediaCandidates(sender, current).some(item => item.url === url && item.requiresSession)) throw new Error(__sahmT("انتهت بيانات جلسة الفيديو. أعد تشغيله ثم أرسله إلى سَهم مجددًا."));
  if (observed?.usesCredentials && !current.allowSession) throw new Error(__sahmT("فعّل تنزيلات الجلسات وأعد تشغيل الفيديو."));
  const inspect = message.type === 'sahm-media-inspect';
  const requestId = `video:${crypto.randomUUID()}`;
  const response = await nativeRequest({
    v: 1, type: inspect ? 'media-info' : 'media-enqueue', requestId, expiresAt: Date.now() + 14000,
    source: 'video-overlay', kind, url, quality: message.quality || 'best', ...validateMediaSelection(message), title: message.title,
    requestContext: observed?.requestContext, sessionApproved: current.allowSession === true,
  });
  if (response?.v !== 1 || response.requestId !== requestId || response.ok !== true) {
    const reasons = {
      'unsupported-live': __sahmT("البث المباشر غير مدعوم حاليًا. اختر فيديو مسجّلًا."),
      'unsupported-encrypted': __sahmT("قائمة البث مشفّرة أو محمية ولا يمكن تنزيلها باستخدام سَهم."),
      'unsafe-media-manifest': __sahmT("قائمة البث غير صالحة أو تحتوي روابط غير مدعومة."),
      'media-auth-required': __sahmT("تنزيل هذا البث يتطلب جلسة دخول غير مدعومة حاليًا."),
    };
    if (response?.v === 1 && response.requestId === requestId && reasons[sahmI18n.formatMessage(response.error)]) throw new Error(reasons[sahmI18n.formatMessage(response.error)]);
    throw new Error(inspect ? __sahmT("تعذّر قراءة جودات الفيديو. افتح سَهم وتحقق من توفر الفيديو.") : __sahmT("تعذّر إضافة الفيديو. افتح سَهم وفعّل تكامل المتصفح."));
  }
  if (inspect) return { ok: true, title: response.title, qualities: qualityOptions(response.qualities || []), mediaOptions: publicMediaOptions(response.mediaOptions) };
  if (response.durable !== true || typeof response.jobId !== 'string' || !response.jobId) throw new Error(__sahmT("لم يؤكد سَهم حفظ المهمة. أعد المحاولة."));
  await recordStatus({ captured: true });
  return { ok: true, durable: true, jobId: response.jobId };
}

async function popupMediaScope(sender, current) {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) throw new Error(__sahmT("طلب وسائط غير صالح."));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const scope = { id: chrome.runtime.id, tab, url: tab?.url, frameId: 0 };
  if (!mediaSenderAllowed(scope, chrome.runtime.id, current)) throw new Error(__sahmT("افتح صفحة الفيديو وفعّل الالتقاط وزر الفيديو لهذا الموقع."));
  return scope;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['sahm-media-settings', 'sahm-media-list', 'sahm-media-inspect', 'sahm-media-download', 'sahm-popup-media-list', 'sahm-popup-media-download'].includes(message?.type)) return;
  const task = async () => {
    const current = await settings();
    if (message.type === 'sahm-media-settings') {
      const validSender = sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && !sender.tab.incognito && supportedUrl(sender.url);
      return { enabled: validSender && current.enabled, showVideoButton: current.showVideoButton, videoPanelMode: current.videoPanelMode, excludedDomains: current.excludedDomains };
    }
    if (message.type.startsWith('sahm-popup-media-')) {
      const scope = await popupMediaScope(sender, current);
      const candidates = observer.mediaCandidates(scope, current, { allFrames: true });
      const youtube = youtubeUrl(scope.url);
      if (youtube) candidates.unshift({ id: 'youtube-current', url: youtube, kind: 'youtube', mime: 'YouTube', bytes: null, frameId: 0, requiresSession: false });
      if (message.type === 'sahm-popup-media-list') return { ok: true, candidates };
      const selected = candidates.find(item => item.id === message.id);
      if (!selected) throw new Error(__sahmT("انتهت صلاحية الوسائط. حدّث القائمة بعد تشغيل الفيديو."));
      return sendMedia({ type: 'sahm-media-download', ...selected, quality: 'best' }, { ...scope, frameId: selected.frameId }, current);
    }
    if (!mediaSenderAllowed(sender, chrome.runtime.id, current)) throw new Error(__sahmT("فعّل الالتقاط وزر الفيديو في إضافة سَهم لهذا الموقع."));
    if (message.type === 'sahm-media-list') return { ok: true, candidates: observer.mediaCandidates(sender, current) };
    return sendMedia(message, sender, current);
  };
  task().then(respond, error => respond({ ok: false, error: sahmI18n.formatMessage(error.message) || __sahmT("تعذّر الاتصال بسَهم.") }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set(await settings());
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sahm-send-link', title: __sahmT("تنزيل الرابط باستخدام سَهم"), contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
  });
});

chrome.contextMenus.onClicked.addListener(async info => {
  if (info.menuItemId !== 'sahm-send-link' || !supportedUrl(info.linkUrl)) return;
  try {
    const requestId = `link:${crypto.randomUUID()}`;
    const response = await nativeRequest({ v: 1, type: 'enqueue', requestId, source: 'context-menu', url: info.linkUrl, expiresAt: Date.now() + 8000 });
    const accepted = response?.ok === true && response.durable === true && response.requestId === requestId;
    await recordStatus({ captured: accepted, reason: accepted ? 'captured' : 'app-unavailable' });
  } catch { await recordStatus({ captured: false, reason: 'app-unavailable' }); }
});

