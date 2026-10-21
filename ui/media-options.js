(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let address = '', generation = 0, picker = null, inspecting = false, catalogue = null;
  const mediaAddress = () => {
    try {
      const url = new URL($('url').value.trim());
      return /^https?:$/.test(url.protocol) && (/\.(m3u8|mpd)$/i.test(url.pathname) || /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(url.hostname)) ? url.href : '';
    } catch { return ''; }
  };
  const update = () => {
    const current = mediaAddress();
    $('media-add-fields').hidden = !current;
    if (current === address) return;
    address = current; generation++; picker = null; inspecting = false;
    $('media-picker').replaceChildren();
    $('media-inspect').disabled = false;
    $('media-inspect-status').textContent = __sahmT("الاختيار الافتراضي: أفضل جودة والصوت الافتراضي. افحص الفيديو لتحديد الصيغة والصوت.");
  };
  $('url').addEventListener('input', update);
  $('add-dialog').addEventListener('close', () => { address = ''; generation++; picker = null; inspecting = false; });
  $('media-inspect').addEventListener('click', async () => {
    const url = address, token = ++generation;
    inspecting = true; $('media-inspect').disabled = true; $('media-inspect-status').textContent = __sahmT("جارٍ فحص الصيغ والمسارات الصوتية…");
    try {
      const info = await window.sahm.inspectMedia(url);
      if (generation !== token || mediaAddress() !== url || !$('add-dialog').open) return;
      $('media-picker').replaceChildren();
      if (!info.mediaOptions?.combinations?.length) throw new Error(__sahmT("لم تتوفر خيارات مفصلة. يمكنك التنزيل بالاختيار الافتراضي أو إعادة الفحص."));
      catalogue = info.mediaOptions; picker = globalThis.sahmMediaOptions.mount($('media-picker'), catalogue);
      $('media-inspect-status').textContent = __sahmT("اختر صيغة الفيديو أو الصوت ومسارًا صوتيًا واحدًا. يوضّح وصف الصيغة أي تحويل للصوت.");
      picker.focus();
    } catch (error) { if (generation === token) $('media-inspect-status').textContent = sahmI18n.formatMessage(error.message); }
    finally { if (generation === token) { inspecting = false; $('media-inspect').disabled = false; } }
  });
  window.sahmMediaAdd = Object.freeze({
    update,
    captureDraft: () => ({ address, catalogue: picker ? catalogue : null, selection: picker?.selection() }),
    restoreDraft(value) {
      update();
      if (value?.address === address && value.catalogue) {
        catalogue = value.catalogue;
        picker = globalThis.sahmMediaOptions.mount($('media-picker'), catalogue, value.selection);
      }
    },
    selection: () => {
      update();
      if (inspecting) throw new Error(__sahmT("انتظر اكتمال فحص الفيديو."));
      return address && picker ? picker.selection() : {};
    },
  });
})();

