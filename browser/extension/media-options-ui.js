(() => {
  'use strict';
  function mount(root, catalogue, initial = {}) {
    const combinations = catalogue.combinations;
    const controls = {};
    for (const [key, text] of [['container', __sahmT("صيغة الحفظ")], ['quality', __sahmT("دقة الفيديو")], ['audioTrack', __sahmT("المسار الصوتي")]]) {
      const label = document.createElement('label'), select = document.createElement('select');
      label.textContent = text; select.setAttribute('aria-label', text); select.dataset.mediaOption = key;
      label.append(select); root.append(label); controls[key] = select;
    }
    const estimate = document.createElement('p'); estimate.className = 'hint media-estimate'; estimate.setAttribute('role', 'status'); root.append(estimate);
    const fill = (select, values) => {
      const previous = select.value;
      select.replaceChildren(...values.map(({ id, label }) => { const option = document.createElement('option'); option.value = id; option.textContent = sahmI18n.mediaLabel(label); return option; }));
      if (values.some(value => value.id === previous)) select.value = previous;
      select.disabled = values.length < 2;
    };
    fill(controls.container, catalogue.containers);
    const selection = () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value]));
    const update = () => {
      const available = combinations.filter(item => item.container === controls.container.value);
      const audioOnly = ['mp3', 'm4a'].includes(controls.container.value);
      controls.quality.parentElement.hidden = audioOnly;
      const qualities = [...new Set(available.map(item => item.quality))];
      fill(controls.quality, qualities.map(id => ({ id, label: id === 'best' ? __sahmT("أفضل جودة") : __sahmT("حتى {0}p", [id]) })));
      fill(controls.audioTrack, catalogue.audioTracks.filter(track => available.some(item => item.quality === controls.quality.value && item.audioTrack === track.id)));
      const value = selection(), match = combinations.find(item => Object.keys(value).every(key => item[key] === value[key]));
      const size = match?.estimatedBytes;
      const conversion = audioOnly ? (value.container === 'mp3' ? __sahmT("يُحوّل الصوت إلى MP3 بمعدل مستهدف 192 kb/s.") : __sahmT("يُحفظ AAC دون تحويل، وتُحوّل الترميزات الأخرى إلى AAC بمعدل مستهدف 192 kb/s.")) : '';
      const fallback = match?.requiresVideoDownload ? __sahmT(" المصدر يدمج الصوت والفيديو؛ يلزم تنزيل الملف المدمج لاستخراج الصوت.") : '';
      const sizeText = size ? __sahmT("حجم بيانات المصدر {0}: {1} MB. قد يختلف حجم الملف النهائي.", [match.approximate ? __sahmT("التقديري") : '', sahmI18n.number(size / 1048576, { maximumFractionDigits: 1 })]) : __sahmT("الحجم غير متاح من المصدر. يظهر الحجم الفعلي أثناء التنزيل.");
      estimate.textContent = [conversion + fallback, sizeText].filter(Boolean).join(' ');
    };
    for (const control of Object.values(controls)) control.addEventListener('change', update);
    update();
    for (const key of ['container', 'quality', 'audioTrack']) {
      if ([...controls[key].options].some(option => option.value === initial[key])) { controls[key].value = initial[key]; update(); }
    }
    return { selection, focus: () => controls.container.focus() };
  }
  globalThis.sahmMediaOptions = Object.freeze({ mount });
})();

