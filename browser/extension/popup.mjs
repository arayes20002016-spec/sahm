import './i18n-data.js';
import './i18n-core.js';
const sahmI18n = globalThis.sahmI18n;
const __sahmT = sahmI18n.t;
import { DEFAULT_SETTINGS } from './capture-policy.mjs';

const languageSettings = await chrome.storage.local.get({ language: 'ar' });
sahmI18n.setLanguage(sahmI18n.validLanguage(languageSettings.language) ? languageSettings.language : 'ar');
sahmI18n.applyDocument();
const element = id => document.getElementById(id);
element('language').value = sahmI18n.getLanguage();
element('language').addEventListener('change', async event => {
  // Save any edited exclusions before reloading the popup.
  await chrome.storage.session.set({ sahmPopupDraft: element('excludedDomains').value });
  await chrome.storage.local.set({ language: event.target.value });
  location.reload();
});
const version = chrome.runtime.getManifest().version;
element('version').textContent = version;
let videoTabId;

async function checkVideo() {
  element('checkVideo').disabled = true;
  element('reloadPage').hidden = true;
  videoTabId = undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id) || !/^https?:\/\//.test(tab.url || '')) {
      element('videoStatus').textContent = __sahmT("افتح صفحة فيديو عادية. إذا كانت مفتوحة، امنح الإضافة حق الوصول إلى هذا الموقع من قائمة المتصفح.");
      return;
    }
    videoTabId = tab.id;
    let status;
    try { status = await chrome.tabs.sendMessage(tab.id, { type: 'sahm-media-status' }, { frameId: 0 }); }
    catch { /* An existing tab needs a reload after installing or updating the extension. */ }
    if (!status || status.version !== version) {
      element('videoStatus').textContent = __sahmT("زر الفيديو غير متصل بهذه الصفحة. حدّث الصفحة وتحقق من السماح للإضافة بهذا الموقع. بعد تحديث سَهم، أعد تحميل الإضافة من صفحة الإضافات أيضًا.");
      element('reloadPage').hidden = false;
    } else if (!status.enabled) {
      element('videoStatus').textContent = __sahmT("فعّل «التقاط التنزيلات تلقائيًا» لإظهار زر الفيديو.");
    } else if (!status.showVideoButton) {
      element('videoStatus').textContent = __sahmT("فعّل «إظهار زر التنزيل على الفيديو».");
    } else if (status.excluded) {
      element('videoStatus').textContent = __sahmT("هذا الموقع ضمن الاستثناءات. أزله من القائمة لإظهار الزر.");
    } else if (status.visibleOverlayCount > 0) {
      element('videoStatus').textContent = __sahmT("زر التنزيل ظاهر فوق الفيديو في الصفحة الحالية.");
    } else if (status.videoCount > 0) {
      element('videoStatus').textContent = __sahmT("المشغّل متصل. أظهر الفيديو داخل الصفحة؛ يختفي الزر أثناء الإعلان أو عند إخفاء المشغّل.");
    } else {
      element('videoStatus').textContent = status.frameCount > 0 ? __sahmT("الصفحة متصلة. شغّل الفيديو داخل الإطار وتحقق من السماح للإضافة بمواقع المشغّل أيضًا.") : __sahmT("الصفحة متصلة ولم يظهر فيديو بعد. شغّل الفيديو ثم افحص الزر مجددًا.");
    }
  } catch {
    element('videoStatus').textContent = __sahmT("تعذّر فحص الصفحة. افتح تبويب الفيديو وافتح إضافة سَهم مجددًا.");
  } finally { element('checkVideo').disabled = false; }
}

element('checkVideo').addEventListener('click', checkVideo);
element('listMedia').addEventListener('click', async () => {
  const container = element('pageMedia');
  element('listMedia').disabled = true;
  container.hidden = true;
  container.replaceChildren();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sahm-popup-media-list' });
    if (response?.ok !== true) throw new Error(sahmI18n.formatMessage(response?.error) || __sahmT("تعذّر قراءة وسائط الصفحة."));
    if (!response.candidates?.length) {
      element('result').textContent = __sahmT("لم تُرصد وسائط بعد. شغّل الفيديو ثم حدّث القائمة.");
      return;
    }
    for (const candidate of response.candidates.slice(0, 64)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = globalThis.sahmMediaTargets.mediaTargetLabel(candidate);
      button.disabled = candidate.kind === 'stream' && candidate.requiresSession;
      if (button.disabled) button.title = __sahmT("بث HLS وDASH الذي يتطلب جلسة غير مدعوم حاليًا.");
      button.addEventListener('click', async () => {
        button.disabled = true;
        element('result').textContent = __sahmT("جارٍ الإرسال إلى سَهم…");
        try {
          const result = await chrome.runtime.sendMessage({ type: 'sahm-popup-media-download', id: candidate.id });
          if (result?.ok !== true || !result.jobId) throw new Error(sahmI18n.formatMessage(result?.error) || __sahmT("لم يؤكد سَهم حفظ المهمة."));
          element('result').textContent = __sahmT("أُضيف الفيديو إلى سَهم بأفضل جودة.");
        } catch (error) { element('result').textContent = sahmI18n.formatMessage(error.message); }
        finally { button.disabled = false; }
      });
      container.append(button);
    }
    container.hidden = false;
    element('result').textContent = __sahmT("اختر الفيديو المطلوب من الوسائط المرصودة.");
  } catch (error) { element('result').textContent = sahmI18n.formatMessage(error.message) || __sahmT("تعذّر الاتصال بالإضافة. أعد فتحها."); }
  finally { element('listMedia').disabled = false; }
});
element('reloadPage').addEventListener('click', async () => {
  if (!Number.isInteger(videoTabId)) return;
  try {
    await chrome.tabs.reload(videoTabId);
    element('videoStatus').textContent = __sahmT("جارٍ تحديث صفحة الفيديو. بعد ظهور المشغّل، اضغط «فحص زر الفيديو».");
    element('reloadPage').hidden = true;
  } catch { element('videoStatus').textContent = __sahmT("تعذّر تحديث الصفحة. حدّثها من المتصفح ثم افحص الزر مجددًا."); }
});
const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
const { lastResult } = await chrome.storage.local.get('lastResult');
element('enabled').checked = current.enabled;
element('allowSession').checked = current.allowSession;
element('allowPost').checked = current.allowPost;
element('showVideoButton').checked = current.showVideoButton;
element('videoPanelMode').value = current.videoPanelMode === 'mini' ? 'mini' : 'full';
element('excludedDomains').value = current.excludedDomains.join('\n');
const { sahmPopupDraft } = await chrome.storage.session.get('sahmPopupDraft');
if (typeof sahmPopupDraft === 'string') { element('excludedDomains').value = sahmPopupDraft; await chrome.storage.session.remove('sahmPopupDraft'); }
if (current.bypassNext) element('result').textContent = __sahmT("سيبقى التنزيل التالي في المتصفح.");
else if (lastResult?.captured) element('result').textContent = __sahmT("أُرسل آخر تنزيل إلى سَهم.");
else if (lastResult?.reason === 'browser-completing') element('result').textContent = __sahmT("سيظهر ملف POST في سَهم بعد اكتماله في المتصفح.");
else if (lastResult?.reason === 'app-unavailable') element('result').textContent = __sahmT("تعذّر إرسال الرابط الأخير. تحقق من اتصال التطبيق.");

element('enabled').addEventListener('change', async event => {
  await chrome.storage.local.set({ enabled: event.target.checked });
  element('result').textContent = event.target.checked ? __sahmT("الالتقاط التلقائي مفعّل.") : __sahmT("الالتقاط التلقائي متوقف.");
  await checkVideo();
});
for (const key of ['allowSession', 'allowPost', 'showVideoButton']) element(key).addEventListener('change', async event => {
  await chrome.storage.local.set({ [key]: event.target.checked });
  element('result').textContent = key === 'showVideoButton' ? __sahmT("حُفظ إعداد زر الفيديو.") : __sahmT("حُفظ الخيار. فعّله داخل سَهم أيضًا لالتقاط هذا النوع من التنزيلات.");
  if (key === 'showVideoButton') await checkVideo();
});
element('videoPanelMode').addEventListener('change', async event => {
  await chrome.storage.local.set({ videoPanelMode: event.target.value === 'mini' ? 'mini' : 'full' });
  element('result').textContent = __sahmT("حُفظ حجم زر الفيديو.");
});
element('bypass').addEventListener('click', async () => {
  await chrome.storage.local.set({ bypassNext: true });
  element('result').textContent = __sahmT("سيبقى التنزيل التالي في المتصفح.");
});
element('save').addEventListener('click', async () => {
  const values = element('excludedDomains').value.split(/\r?\n/).map(value => value.trim().toLowerCase()).filter(Boolean);
  try {
    if (values.length > 100) throw new Error(__sahmT("الحد الأقصى 100 موقع."));
    const excludedDomains = [...new Set(values.map(value => {
      if (value.includes('/') || value.includes(':') || value.includes('@') || value.includes('*')) throw new Error(__sahmT("اكتب اسم النطاق فقط، مثل example.com."));
      const hostname = new URL(`https://${value}`).hostname;
      if (hostname !== value || !hostname) throw new Error(__sahmT("أحد النطاقات غير صالح."));
      return hostname;
    }))];
    await chrome.storage.local.set({ excludedDomains });
    element('result').textContent = __sahmT("حُفظت الاستثناءات.");
    await checkVideo();
  } catch (error) { element('result').textContent = sahmI18n.formatMessage(error.message); }
});

await checkVideo();

chrome.runtime.sendNativeMessage('com.sahm.downloader', { v: 1, type: 'ping', requestId: `ping:${crypto.randomUUID()}` }, response => {
  if (chrome.runtime.lastError || response?.ok !== true) {
    element('connection').textContent = __sahmT("التطبيق غير متصل. افتح سَهم وفعّل التكامل من الإعدادات.");
  } else { element('connection').textContent = __sahmT("متصل بتطبيق سَهم."); }
});

