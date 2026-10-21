const api = window.downloadWindow, $ = id => document.getElementById(id);
const states = { queued: __sahmT("في قائمة الانتظار"), downloading: __sahmT("جارٍ التنزيل"), paused: __sahmT("متوقف مؤقتًا"), complete: __sahmT("اكتمل التنزيل"), error: __sahmT("تعذّر التنزيل") };
let job, busy = false;
function bytes(value) {
  if (!Number.isFinite(value)) return __sahmT("غير معروف");
  const units = ['B', 'KB', 'MB', 'GB', 'TB']; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return new Intl.NumberFormat(sahmI18n.locale(), { maximumFractionDigits: index ? 1 : 0 }).format(value) + ' ' + units[index];
}
function render(value) {
  job = value; $('name').textContent = job.name; $('name').title = job.name; $('path').value = job.path;
  $('status').textContent = job.status === 'queued' && job.networkRetry ? __sahmT("بانتظار إعادة الاتصال") : states[job.status] || job.status;
  const total = job.total, received = job.received || 0, percent = total > 0 ? Math.min(100, received / total * 100) : job.status === 'complete' ? 100 : null;
  if (percent === null) $('progress').removeAttribute('value'); else $('progress').value = percent;
  $('percent').textContent = percent === null ? __sahmT("الحجم غير معروف") : new Intl.NumberFormat(sahmI18n.locale(), { maximumFractionDigits: 1 }).format(percent) + __sahmT("٪");
  $('received').textContent = bytes(received) + ' / ' + bytes(total);
  $('speed').textContent = job.status === 'downloading' ? bytes(job.speed || 0) + __sahmT("/ث") : '—';
  const seconds = total > received && job.speed > 0 && job.status === 'downloading' ? Math.ceil((total - received) / job.speed) : null;
  $('remaining').textContent = seconds === null ? '—' : seconds < 60 ? seconds + __sahmT(" ثانية") : Math.ceil(seconds / 60) + __sahmT(" دقيقة");
  $('pause').hidden = !['downloading', 'queued'].includes(job.status); $('resume').hidden = !['paused', 'error'].includes(job.status) && !(job.status === 'queued' && job.networkRetry);
  $('pause').disabled = busy; $('resume').disabled = busy || !!job.needsRecapture || !!job.needsCredentials;
  $('error').hidden = !sahmI18n.formatMessage(job.error); $('error').textContent = sahmI18n.formatMessage(job.error) || '';
  $('error').setAttribute('role', job.status === 'queued' && job.networkRetry ? 'status' : 'alert');
}
async function perform(action) {
  if (busy) return; busy = true; if (job) render(job);
  try { const next = await action(); if (next?.id) render(next); }
  catch (error) { $('error').textContent = sahmI18n.formatMessage(error.message); $('error').hidden = false; }
  finally { busy = false; if (job) { $('pause').disabled = false; $('resume').disabled = !!job.needsRecapture || !!job.needsCredentials; } }
}
$('pause').onclick = () => perform(() => api.action('pause')); $('resume').onclick = () => perform(() => api.action('resume'));
$('folder').onclick = () => perform(() => api.folder()); $('hide').onclick = () => api.hide();
api.onUpdate(render); perform(async () => render(await api.state()));

