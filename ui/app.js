const $ = id => document.getElementById(id);
const api = window.sahm || window.rafid;
const statuses = { queued: __sahmT("في الانتظار"), downloading: __sahmT("قيد التنزيل"), paused: __sahmT("متوقف مؤقتًا"), complete: __sahmT("مكتمل"), error: __sahmT("تعذّر التنزيل") };
const statusIcons = { queued: 'clock', downloading: 'download', paused: 'pause', complete: 'check', error: 'alert' };
const filterTitles = { all: __sahmT("كل التنزيلات"), downloading: __sahmT("قيد التنزيل"), queued: __sahmT("قائمة الانتظار"), paused: __sahmT("متوقفة مؤقتًا"), complete: __sahmT("مكتملة"), error: __sahmT("تعذّر تنزيلها") };
const dateFormatter = new Intl.DateTimeFormat(sahmI18n.locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const scheduleFormatter = new Intl.DateTimeFormat(sahmI18n.locale(), { dateStyle: 'short', timeStyle: 'short' });
let jobs = [];
let filter = 'all';
let selectedId = null;
const selectedIds = new Set();
let actionRunning = false;
let currentView = 'downloads';
let sortKey = 'createdAt';
let sortDirection = -1;
let settings = null;
let settingsLoading = 0;
let discoveredLinks = [];
let queues = [];
let queueFilter = 'all';
let queueSaving = false;
let queueJobsSignature = '';
let refreshingAddressId = null;
let siteJobs = [];
let networkLoading = 0;
let ftpCredentialsId = null;

function element(tag, value = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function bytes(value) {
  if (value == null || !Number.isFinite(value)) return __sahmT("غير معروف");
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function remaining(job) {
  if (job.status !== 'downloading' || !job.total || !job.speed) return '—';
  const seconds = Math.ceil(Math.max(0, job.total - job.received) / job.speed);
  if (seconds < 60) return __sahmT("{0} ث", [seconds]);
  if (seconds < 3600) return __sahmT("{0} د", [Math.ceil(seconds / 60)]);
  return __sahmT("{0} س {1} د", [Math.floor(seconds / 3600), Math.ceil((seconds % 3600) / 60)]);
}

function downloadMethod(job) {
  if (job.kind === 'ftp') return job.ftpTLS === 'explicit' || job.url.startsWith('ftps:') ? 'FTPS' : 'FTP';
  if (job.kind === 'media') return `${job.mediaContainer && job.mediaContainer !== 'auto' ? job.mediaContainer.toUpperCase() + ' · ' : ''}${job.mediaSource === 'stream' ? 'HLS/DASH' : 'YouTube'} · ${['mp3', 'm4a'].includes(job.mediaContainer) ? __sahmT("صوت فقط") : job.mediaQuality === 'best' ? __sahmT("أفضل جودة") : __sahmT("حتى ") + job.mediaQuality + 'p'}`;
  return `${job.method || 'GET'}${job.needsSession ? __sahmT(" · جلسة") : ''}`;
}

function queueName(job) { return sahmI18n.queueLabel(queues.find(queue => queue.id === job.queueId)) || (job.queueId === 'default' ? __sahmT("القائمة الرئيسية") : '—'); }

function columnSortValue(job, key) {
  if (key === 'progress') return job.total ? (job.received || 0) / job.total : 0;
  if (key === 'remaining') return job.status === 'downloading' && job.total && job.speed ? Math.max(0, job.total - (job.received || 0)) / job.speed : Number.MAX_SAFE_INTEGER;
  if (key === 'queue') return queueName(job);
  if (key === 'method') return downloadMethod(job);
  if (key === 'speed') return job.status === 'downloading' ? job.speed || 0 : 0;
  return job[key] ?? '';
}

function notice(message) {
  $('notice-text').textContent = message;
  $('notice').hidden = !message;
}

async function perform(operation) {
  try { return await operation(); }
  catch (error) { notice(sahmI18n.formatMessage(error.message) || __sahmT("تعذّر إتمام الإجراء. أعد المحاولة.")); }
}

async function busy(button, operation) {
  button.disabled = true;
  try { return await operation(); }
  finally { button.disabled = false; }
}

function visibleJobs() {
  const query = $('search').value.trim().toLocaleLowerCase();
  return jobs.filter(job => (queueFilter === 'all' || job.queueId === queueFilter) && (filter === 'all' || job.status === filter) && `${job.name} ${job.url}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const left = columnSortValue(a, sortKey), right = columnSortValue(b, sortKey);
      if (typeof left === 'string') return sortDirection * left.localeCompare(right || '', 'ar');
      return sortDirection * ((left || 0) - (right || 0));
    });
}

function selectedJobs() { return jobs.filter(job => selectedIds.has(job.id)); }

function selectedJob() { return jobs.find(job => job.id === selectedId && selectedIds.has(job.id)); }

function canApply(job, action) {
  if (action === 'resume') return !job.needsRecapture && !job.needsCredentials && !(job.quotaHeld && window.sahmPolicies?.blocked()) && (['paused', 'error'].includes(job.status) || job.status === 'queued' && !!job.networkRetry);
  if (action === 'pause') return job.quotaHeld || ['downloading', 'queued'].includes(job.status);
  return action === 'remove';
}

function clearSelection() {
  selectedIds.clear();
  selectedId = null;
}

function syncSelection(visible = visibleJobs()) {
  for (const row of $('jobs').rows) {
    row.setAttribute('aria-selected', String(selectedIds.has(row.dataset.id)));
    const check = row.querySelector('.job-select');
    check.checked = selectedIds.has(row.dataset.id);
    check.disabled = actionRunning;
  }
  const count = visible.filter(job => selectedIds.has(job.id)).length;
  $('select-all').checked = visible.length > 0 && count === visible.length;
  $('select-all').indeterminate = count > 0 && count < visible.length;
  $('select-all').disabled = actionRunning || !visible.length;
  $('clear-selection').hidden = !selectedIds.size;
  $('clear-selection').disabled = actionRunning;
  document.querySelector('.table-region').setAttribute('aria-busy', String(actionRunning));
  renderDetails();
}

function selectAll(checked) {
  if (actionRunning) return;
  clearSelection();
  if (checked) {
    for (const job of visibleJobs()) selectedIds.add(job.id);
    selectedId = selectedIds.values().next().value || null;
  }
  syncSelection();
}

function statusText(job) {
  if (job.needsCredentials) return __sahmT("أدخل حساب FTP للاستئناف");
  if (job.needsRecapture) return __sahmT("أعد إرساله من المتصفح");
  if (job.quotaHeld || job.status === 'queued' && window.sahmPolicies?.blocked()) return __sahmT("بانتظار تجدد الحصة");
  if (job.status === 'queued' && job.networkRetry) return __sahmT("بانتظار إعادة الاتصال");
  return statuses[job.status] || job.status;
}

function renderRow(job) {
  const row = element('tr');
  row.dataset.id = job.id;
  row.ondblclick = () => perform(() => api.showDownloadWindow(job.id));
  row.title = __sahmT("انقر مرتين لفتح نافذة هذا التنزيل");
  row.setAttribute('aria-selected', String(selectedIds.has(job.id)));
  row.setAttribute('aria-label', __sahmT("{0}، {1}", [job.name, statusText(job)]));
  const selectionCell = element('td', '', 'selection-cell');
  const label = element('label', '', 'table-check');
  const check = element('input', '', 'job-select');
  check.type = 'checkbox';
  check.dataset.id = job.id;
  check.checked = selectedIds.has(job.id);
  check.disabled = actionRunning;
  check.setAttribute('aria-label', __sahmT("تحديد {0}", [job.name]));
  label.onclick = event => event.stopPropagation();
  label.ondblclick = event => event.stopPropagation();
  check.onchange = () => selectJob(job.id, { toggle: true, focus: false });
  label.append(check);
  selectionCell.append(label);
  const fileCell = element('td');
  const file = element('div', '', 'file-cell');
  const name = element('span', job.name, 'filename');
  name.title = job.name;
  file.append(icon('file'), name);
  fileCell.append(file);
  const stateCell = element('td');
  const state = element('div', '', `status-cell ${job.status}`);
  state.append(icon(statusIcons[job.status] || 'file'), element('span', statusText(job)));
  stateCell.title = sahmI18n.formatMessage(job.error) || (job.startAt ? __sahmT("موعد البداية: {0}", [scheduleFormatter.format(new Date(job.startAt))]) : statuses[job.status]);
  stateCell.append(state);
  const progressCell = element('td');
  const progressGroup = element('div', '', 'progress-cell');
  const progress = element('progress');
  progress.max = job.total || 1;
  progress.value = job.received || 0;
  if (!job.total && job.status === 'downloading') progress.removeAttribute('value');
  progress.setAttribute('aria-label', __sahmT("تقدم تنزيل {0}", [job.name]));
  const percent = job.total ? `${Math.min(100, Math.floor((job.received || 0) * 100 / job.total))}%` : '—';
  progressGroup.append(progress, element('span', percent, 'progress-label'));
  progressCell.append(progressGroup);
  const cells = [fileCell, stateCell, progressCell, element('td', bytes(job.total), 'numeric'), element('td', job.status === 'downloading' ? `${bytes(job.speed || 0)}/s` : '—', 'numeric'), element('td', remaining(job)), element('td', job.createdAt ? dateFormatter.format(new Date(job.createdAt)) : '—', 'numeric')];
  const columns = ['name', 'status', 'progress', 'total', 'speed', 'remaining', 'createdAt'];
  cells.forEach((cell, index) => { cell.dataset.column = columns[index]; });
  const extras = { category: sahmI18n.categoryLabel(job.category), queue: queueName(job), url: job.url, path: job.path, connections: job.connections, method: downloadMethod(job) };
  for (const [id, value] of Object.entries(extras)) {
    const cell = element('td', String(value ?? '—'));
    cell.dataset.column = id; cell.title = String(value ?? ''); cell.hidden = true;
    if (['url', 'path'].includes(id)) { cell.dir = sahmI18n.direction(); cell.className = 'path-value'; }
    if (id === 'connections') cell.className = 'numeric';
    cells.push(cell);
  }
  row.append(selectionCell, ...cells);
  row.onclick = event => selectJob(job.id, { toggle: event.ctrlKey || event.metaKey });
  row.ondblclick = () => perform(() => activateSelected());
  return row;
}

function selectJob(id, { toggle = false, focus = true } = {}) {
  if (actionRunning) return;
  if (!toggle) selectedIds.clear();
  if (toggle && selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  selectedId = selectedIds.has(id) ? id : (selectedIds.values().next().value || null);
  if (focus) document.querySelector('.table-region').focus({ preventScroll: true });
  syncSelection();
}

function renderDetails() {
  const job = selectedJob();
  const selected = selectedJobs();
  const inDownloads = currentView === 'downloads';
  const labels = { resume: __sahmT("استئناف"), pause: __sahmT("إيقاف مؤقت"), remove: __sahmT("إزالة من القائمة مع إبقاء الملفات على القرص") };
  for (const action of ['resume', 'pause', 'remove']) {
    const count = selected.filter(value => canApply(value, action)).length;
    $(action).disabled = actionRunning || !inDownloads || !count;
    $(action).title = `${labels[action]}${selected.length ? __sahmT(" · {0} من {1} محدد", [count, selected.length]) : ''}`;
  }
  $('reveal').disabled = actionRunning || !inDownloads || selected.length !== 1 || job?.status !== 'complete';
  $('move-selected').disabled = actionRunning || !inDownloads || !selected.length || selected.some(value => value.status === 'downloading');
  $('refresh-address').disabled = actionRunning || !inDownloads || selected.length !== 1 || !job || ['media', 'ftp'].includes(job.kind) || job.method === 'POST' || !['paused', 'error'].includes(job.status);
  $('ftp-credentials').disabled = actionRunning || !inDownloads || selected.length !== 1 || job?.kind !== 'ftp' || ['downloading', 'complete'].includes(job?.status);
  renderParts(job);
  $('details-empty').hidden = !!job;
  $('details-data').hidden = !job;
  $('detail-state').textContent = job ? statusText(job) : __sahmT("لم يُحدّد ملف");
  let summary = __sahmT("جاهز");
  if (actionRunning) summary = __sahmT("جارٍ تنفيذ الإجراء…");
  else if (selected.length && inDownloads) summary = __sahmT("المحدد: {0} من {1}", [selected.length, visibleJobs().length]);
  $('selected-summary').textContent = summary;
  if (!job) return;
  const method = downloadMethod(job);
  const details = { url: job.url, path: job.path, category: sahmI18n.categoryLabel(job.category), method, connections: job.connections, received: `${bytes(job.received || 0)} / ${bytes(job.total)}`, schedule: job.startAt ? scheduleFormatter.format(new Date(job.startAt)) : __sahmT("فور الإضافة") };
  for (const [key, value] of Object.entries(details)) {
    $(`detail-${key}`).textContent = String(value ?? '—');
    $(`detail-${key}`).title = String(value ?? '');
  }
  $('detail-error').hidden = !sahmI18n.formatMessage(job.error);
  $('detail-error-label').hidden = !sahmI18n.formatMessage(job.error);
  $('detail-error').textContent = sahmI18n.formatMessage(job.error) || '';
  const scanLabels = { running: __sahmT("جارٍ الفحص…"), clean: __sahmT("اكتمل الفحص بنجاح"), attention: __sahmT("تحتاج نتيجة الفحص إلى مراجعة"), error: __sahmT("تعذّر إكمال الفحص"), skipped: __sahmT("الفحص غير مفعّل") };
  $('detail-scan').textContent = job.scanResult ? `${scanLabels[job.scanResult.status] || '—'}${job.scanResult.exitCode != null ? __sahmT(" · رمز الخروج {0}", [job.scanResult.exitCode]) : ''}` : '—';
}

function render() {
  const visible = visibleJobs();
  const visibleIds = new Set(visible.map(job => job.id));
  for (const id of selectedIds) if (!visibleIds.has(id)) selectedIds.delete(id);
  if (!selectedIds.has(selectedId)) selectedId = selectedIds.values().next().value || null;
  const focusedCheckbox = document.activeElement.matches('.job-select') ? document.activeElement.dataset.id : null;
  $('jobs').replaceChildren(...visible.map(renderRow));
  window.sahmTable.onRendered();
  if (focusedCheckbox) $('jobs').querySelector(`.job-select[data-id="${focusedCheckbox}"]`)?.focus({ preventScroll: true });
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h2').textContent = jobs.length ? __sahmT("لا توجد ملفات في هذا العرض") : __sahmT("قائمة التنزيلات فارغة");
  $('empty').querySelector('p').textContent = jobs.length ? __sahmT("غيّر التصفية أو امسح البحث لعرض التنزيلات.") : __sahmT("أضف رابط ملف، أو أرسل التنزيل من المتصفح.");
  $('view-title').textContent = filterTitles[filter];
  $('view-count').textContent = __sahmT("{0} ملف", [visible.length]);
  $('status-count').textContent = __sahmT("{0} ملف", [jobs.length]);
  $('all-count').textContent = jobs.length;
  document.querySelectorAll('[data-count]').forEach(node => { node.textContent = jobs.filter(job => job.status === node.dataset.count).length; });
  const active = jobs.filter(job => job.status === 'downloading');
  $('summary').textContent = active.length ? __sahmT("{0} تنزيل نشط · {1}/s", [active.length, bytes(active.reduce((sum, job) => sum + (job.speed || 0), 0))]) : __sahmT("لا توجد تنزيلات نشطة");
  syncSelection(visible);
  renderQueueJobs();
}

function showView(view) {
  currentView = view;
  for (const name of ['downloads', 'browser', 'preferences', 'queues', 'network', 'sites', 'automation']) $(`${name}-view`).hidden = name !== view;
  document.querySelectorAll('.navigation [aria-current]').forEach(node => node.removeAttribute('aria-current'));
  if (view === 'downloads') document.querySelector(`[data-filter="${filter}"]`).setAttribute('aria-current', 'page');
  else document.querySelector(`.navigation [data-view="${view}"]`)?.setAttribute('aria-current', 'page');
  renderDetails();
  let loading = Promise.resolve();
  if (['browser', 'preferences', 'queues'].includes(view)) loading = perform(refreshSettings);
  if (view === 'queues') loading = loading.then(() => perform(() => refreshQueues(true)));
  if (view === 'network') loading = perform(async () => { await loadNetwork(); await window.sahmServerRules.load(); });
  if (view === 'sites') loading = perform(async () => { siteJobs = await api.sites(); await window.sahmSiteSessions.load(); renderSites(); });
  if (view === 'automation') loading = perform(() => window.sahmPolicies.load());
  return loading;
}

function openDialog(id, focusId) {
  if (document.querySelector('dialog[open]')) return;
  $(id).showModal();
  if (focusId) $(focusId).focus();
}

function openAdd() {
  $('add-error').hidden = true;
  updateFtpFields();
  window.sahmMediaAdd.update();
  if (queueFilter !== 'all') $('add-queue').value = queueFilter;
  openDialog('add-dialog', 'url');
}

async function activateSelected() {
  if (actionRunning) return;
  const job = selectedJob();
  if (!job) return;
  if (selectedIds.size > 1) return selectedAction('resume');
  if (job.needsRecapture) { notice(__sahmT("أعد إرسال هذا التنزيل من المتصفح لتجديد بيانات الجلسة.")); return; }
  if (job.needsCredentials) { openFtpCredentials(job); return; }
  if (job.status === 'complete') await api.reveal(job.id);
  else if (['paused', 'error'].includes(job.status)) await selectedAction('resume');
}

async function actOnJobs(targets, action) {
  if (actionRunning || !targets.length) return;
  actionRunning = true;
  syncSelection();
  let succeeded = 0;
  const failures = [];
  try {
    for (const job of targets) {
      try {
        await api.action(job.id, action);
        succeeded++;
        if (action === 'remove') selectedIds.delete(job.id);
      } catch (error) { failures.push(error); }
    }
  } finally {
    actionRunning = false;
    if (!selectedIds.has(selectedId)) selectedId = selectedIds.values().next().value || null;
    syncSelection();
  }
  const messages = { resume: __sahmT("استُؤنف {0} تنزيل.", [succeeded]), pause: __sahmT("أُوقف {0} تنزيل مؤقتًا.", [succeeded]), remove: __sahmT("أُزيل {0} تنزيل من القائمة. بقيت الملفات على القرص.", [succeeded]) };
  notice(messages[action] + (failures.length ? __sahmT(" تعذّر تنفيذ الإجراء على {0} تنزيل: {1}", [failures.length, sahmI18n.formatMessage(failures[0].message)]) : ''));
}

async function selectedAction(action) {
  if (actionRunning || currentView !== 'downloads') return;
  const selected = selectedJobs();
  if (action === 'reveal') {
    const job = selectedJob();
    if (selected.length === 1 && job?.status === 'complete') await api.reveal(job.id);
    return;
  }
  const targets = selected.filter(job => canApply(job, action));
  if (!targets.length && action === 'resume' && selected.some(job => job.needsRecapture)) {
    notice(__sahmT("أعد إرسال التنزيلات المحددة من المتصفح لتجديد بيانات الجلسة."));
    return;
  }
  await actOnJobs(targets, action);
}

async function runCommand(command) {
  if (command === 'add') return openAdd();
  if (['browser', 'preferences', 'downloads', 'queues', 'network', 'sites', 'automation'].includes(command)) return showView(command);
  if (command === 'help') return openDialog('help-dialog');
  if (command === 'grab') return openDialog('grab-dialog', 'grab-url');
  if (command === 'batch') { $('batch-error').hidden = true; return openDialog('batch-dialog', 'batch-pattern'); }
  if (command === 'search') { showView('downloads'); $('search').focus(); return; }
  if (command === 'import') {
    const result = await api.import();
    if (result) notice(__sahmT("أُضيف {0} رابط. الروابط المرفوضة: {1}.", [result.added, result.rejected]));
    return;
  }
  if (command === 'export') {
    if (await api.export()) notice(__sahmT("حُفظت روابط التنزيلات."));
    return;
  }
  if (['pause-all', 'resume-all'].includes(command)) {
    const action = command === 'pause-all' ? 'pause' : 'resume';
    await actOnJobs(jobs.filter(job => canApply(job, action)), action);
    return;
  }
  if (['resume', 'pause', 'reveal', 'remove'].includes(command)) await selectedAction(command);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function renderIntegration(browser = {}) {
  const chromeAvailable = !!browser.stores?.chrome?.available, edgeAvailable = !!browser.stores?.edge?.available;
  $('install-chrome').disabled = !chromeAvailable; $('install-edge').disabled = !edgeAvailable;
  $('extension-store-status').textContent = chromeAvailable || edgeAvailable ? __sahmT("افتح المتجر الرسمي للمتصفح، ثم وافق على إضافة سَهم. يمكنك تعطيل الإضافة أو إزالتها من المتصفح.") : __sahmT("إضافة سَهم بانتظار النشر في المتجرين. يتوفر الإعداد اليدوي لهذه النسخة التجريبية.");
  $('chrome-store-status').textContent = chromeAvailable ? __sahmT("Chrome: افتح صفحة المتجر ثم اضغط «إضافة إلى Chrome». لا يلزم وضع المطوّر.") : __sahmT("Chrome: لم تُنشر الإضافة في المتجر بعد.");
  $('edge-store-status').textContent = edgeAvailable ? __sahmT("Edge: افتح صفحة المتجر ثم اضغط «الحصول» ووافق على الإضافة. لا يلزم وضع المطوّر.") : __sahmT("Edge: لم تُنشر الإضافة في المتجر بعد.");
  const manualSetup = $('extension-manual-setup');
  if (!manualSetup.dataset.initialized) { manualSetup.open = !chromeAvailable && !edgeAvailable; manualSetup.dataset.initialized = 'true'; }
  $('capture-enabled').checked = !!browser.enabled;
  $('register-integration').disabled = !!browser.registered;
  $('register-integration').textContent = browser.registered ? __sahmT("الاتصال مسجّل") : __sahmT("تسجيل الاتصال");
  $('unregister-integration').disabled = !browser.registered;
  $('extension-path').textContent = browser.extensionPath || '—';
  $('extension-path').title = browser.extensionPath || '';
  $('extension-id').textContent = browser.extensionId || '—';
  $('extension-id').title = browser.extensionId || '';
  $('integration-dot').classList.toggle('connected', !!browser.connected);
  $('browser-dot').classList.toggle('connected', !!browser.connected && !!browser.enabled);
  let status = __sahmT("لم يُسجّل الاتصال بعد. ابدأ بالخطوة الأولى أدناه.");
  let summary = __sahmT("إعداد اتصال المتصفح");
  if (browser.registered) { status = __sahmT("قناة الاتصال مسجّلة. أكمل تثبيت الإضافة ثم اختبر تنزيلًا من المتصفح."); summary = __sahmT("قناة المتصفح جاهزة"); }
  if (browser.needsReregister) { status = __sahmT("يحتاج ربط المتصفح إلى تحديث. اضغط «تسجيل الاتصال» لاستخدام النسخة الحالية."); summary = __sahmT("حدّث ربط المتصفح"); }
  if (browser.connected) { status = __sahmT("الإضافة متصلة بالتطبيق."); summary = __sahmT("المتصفح متصل"); }
  if (!browser.enabled) { status += __sahmT(" الالتقاط متوقف في سَهم."); summary = __sahmT("التقاط المتصفح متوقف"); }
  $('integration-status').textContent = status;
  $('browser-summary').textContent = summary;
}

async function refreshSettings() {
  if (!api.settings) return;
  settingsLoading++;
  const saveButton = $('preferences-form').querySelector('[type="submit"]');
  saveButton.disabled = true;
  try {
    settings = await api.settings();
    renderIntegration(settings.browser);
    $('download-directory').value = settings.downloadDirectory || '';
    $('theme').value = settings.theme || 'system';
    $('language').value = settings.language || 'ar';
    $('speed-limit').value = Math.round((settings.speedLimit || 0) / 1024);
    $('parallel').value = settings.parallel || 2;
    $('session-capture-enabled').checked = !!settings.sessionCaptureEnabled;
    $('post-capture-enabled').checked = !!settings.postCaptureEnabled;
    $('show-download-windows').checked = settings.showDownloadWindows !== false;
    $('clipboard-monitor').checked = !!settings.clipboardMonitorEnabled;
    $('start-with-windows').checked = !!settings.startWithWindows;
    $('download-rules').value = (settings.downloadRules || []).map(rule => `${rule.name}|${rule.extensions.join(',')}|${rule.directory || ''}`).join('\n');
    const scanner = settings.scanner || { mode: 'defender', args: ['{file}'], timeoutMs: 120000 };
    $('scan-enabled').checked = !!scanner.enabled;
    $('scan-mode').value = scanner.mode;
    $('scan-executable').value = scanner.executable || '';
    $('scan-args').value = JSON.stringify(scanner.args);
    $('scan-timeout').value = scanner.timeoutMs / 1000;
    updateScannerFields();
    for (const id of ['ftp-remember', 'ftp-job-remember']) {
      $(id).disabled = !settings.vault?.available;
      if ($(id).disabled) $(id).checked = false;
      $(id).title = $(id).disabled ? __sahmT("تشفير Windows غير متاح؛ يبقى الحساب في الذاكرة فقط.") : '';
    }
    applyTheme(settings.theme);
    await window.sahmTable.load(settings.tableLayout);
  } finally {
    settingsLoading--;
    saveButton.disabled = settingsLoading > 0 || !settings?.downloadDirectory;
  }
}

async function integrationAction(action, button) {
  if (button) await busy(button, () => api.integration(action));
  else await api.integration(action);
  await refreshSettings();
  if (action === 'register') notice(__sahmT("سُجّلت قناة الاتصال. ثبّت الإضافة من إعدادات المتصفح لإكمال الربط."));
  if (action === 'unregister') notice(__sahmT("أُلغي تسجيل قناة اتصال المتصفح."));
}

function renderDiscoveredLinks(result) {
  discoveredLinks = result.links.slice(0, 100);
  const rows = discoveredLinks.map((link, index) => {
    const row = element('label', '', 'grab-result');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.index = index;
    const label = element('span', link.name || link.url);
    label.title = link.url;
    row.append(check, label);
    return row;
  });
  $('grab-results').replaceChildren(...rows);
  $('grab-results').hidden = rows.length === 0;
  $('grab-add').hidden = rows.length === 0;
  const suffix = result.truncated ? __sahmT(" عُرضت النتائج ضمن حد الفحص.") : '';
  $('grab-status').textContent = rows.length ? __sahmT("عُثر على {0} رابط ملف.{1}", [rows.length, suffix]) : __sahmT("لم يُعثر على روابط ملفات مباشرة في الصفحة.");
}

function queueOptions(id, includeAll = false) {
  const select = $(id);
  const previous = select.value;
  const options = queues.map(queue => {
    const option = element('option', sahmI18n.queueLabel(queue));
    option.value = queue.id;
    return option;
  });
  if (includeAll) { const all = element('option', __sahmT("كل القوائم")); all.value = 'all'; options.unshift(all); }
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === previous) ? previous : (includeAll ? 'all' : 'default');
}

async function refreshQueues(edit = false) {
  if (!api.queues) return;
  queues = await api.queues();
  for (const id of ['add-queue', 'move-queue', 'batch-queue', 'queue-editor']) queueOptions(id);
  queueOptions('queue-filter', true);
  window.sahmPolicies?.queueOptions();
  queueFilter = $('queue-filter').value;
  if (edit) loadQueueEditor();
  renderQueueJobs();
}

function loadQueueEditor() {
  const queue = queues.find(value => value.id === $('queue-editor').value);
  if (!queue) return;
  $('queue-name').value = queue.name;
  $('queue-parallel').value = queue.parallel;
  $('queue-completion-type').value = queue.completionAction?.type || 'none';
  $('queue-completion-delay').value = queue.completionAction?.delaySeconds ?? 30;
  updateCompletionFields();
  $('queue-schedule-enabled').checked = !!queue.schedule;
  $('queue-schedule-fields').disabled = !queue.schedule;
  $('queue-start-time').value = queue.schedule?.start || '01:00';
  $('queue-stop-time').value = queue.schedule?.stop || '07:00';
  document.querySelectorAll('.queue-days input').forEach(check => { check.checked = !queue.schedule || queue.schedule.days.includes(Number(check.value)); });
  $('queue-error').hidden = true;
  renderQueueJobs();
}

function updateCompletionFields() {
  const type = $('queue-completion-type').value;
  const delay = $('queue-completion-delay');
  delay.disabled = type === 'none';
  delay.min = ['exit', 'shutdown', 'sleep', 'hibernate'].includes(type) ? '30' : '0';
  if (Number(delay.value) < Number(delay.min)) delay.value = delay.min;
}
$('queue-completion-type').onchange = updateCompletionFields;

function renderQueueJobs() {
  const queue = queues.find(value => value.id === $('queue-editor').value);
  if (!queue) return;
  $('queue-start').disabled = queue.enabled || queueSaving;
  $('queue-stop').disabled = !queue.enabled || queueSaving;
  $('queue-remove').disabled = queue.id === 'default' || queueSaving || jobs.some(job => job.queueId === queue.id);
  const state = queue.enabled ? (queue.open ? __sahmT("القائمة مفعّلة وتعمل الآن.") : __sahmT("القائمة مفعّلة وتنتظر موعد التشغيل.")) : __sahmT("القائمة متوقفة.");
  $('queue-state').textContent = state + __sahmT(" · {0} تنزيل", [jobs.filter(job => job.queueId === queue.id).length]);
  const members = jobs.filter(job => job.queueId === queue.id).sort((a, b) => a.queuePosition - b.queuePosition);
  const signature = queue.id + ':' + members.map(job => `${job.id}:${job.name}:${job.status}:${job.queuePosition}`).join('|') + ':' + queueSaving;
  if (signature === queueJobsSignature) return;
  queueJobsSignature = signature;
  const pending = members.filter(job => job.status !== 'complete' && job.status !== 'downloading');
  const rows = members.map((job, index) => {
    const row = element('tr');
    const name = element('td', job.name);
    name.title = job.name;
    const controls = element('td');
    for (const [direction, text] of [['up', __sahmT("تقديم")], ['down', __sahmT("تأخير")]]) {
      const button = element('button', text);
      button.type = 'button';
      button.dataset.jobId = job.id;
      button.dataset.direction = direction;
      const position = pending.indexOf(job);
      button.disabled = queueSaving || position === -1 || (direction === 'up' ? position === 0 : position === pending.length - 1);
      button.setAttribute('aria-label', `${text} ${job.name}`);
      button.onclick = () => perform(() => changeQueue('reorder', { id: job.id, direction }));
      controls.append(button);
    }
    row.append(element('td', String(index + 1), 'numeric'), name, element('td', statusText(job)), controls);
    return row;
  });
  $('queue-jobs').replaceChildren(...rows);
  $('queue-jobs-empty').hidden = members.length > 0;
}

async function changeQueue(action, data) {
  if (queueSaving) return;
  queueSaving = true;
  renderQueueJobs();
  try {
    const result = await api.queueAction(action, data);
    await refreshQueues(false);
    if (action === 'create') $('queue-editor').value = result.queue.id;
    if (['create', 'update', 'remove'].includes(action)) loadQueueEditor();
    notice(__sahmT("حُفظت إعدادات قوائم التنزيل."));
    return result;
  } finally { queueSaving = false; renderQueueJobs(); }
}

$('queue-filter').onchange = event => { queueFilter = event.target.value; clearSelection(); showView('downloads'); render(); };
$('queue-editor').onchange = loadQueueEditor;
$('queue-schedule-enabled').onchange = event => { $('queue-schedule-fields').disabled = !event.target.checked; };
$('queue-create-form').onsubmit = event => {
  event.preventDefault();
  perform(async () => { await changeQueue('create', { name: $('queue-new-name').value, parallel: 2 }); $('queue-new-name').value = ''; });
};
$('queue-start').onclick = () => perform(() => changeQueue('update', { id: $('queue-editor').value, settings: { enabled: true } }));
$('queue-stop').onclick = () => perform(() => changeQueue('update', { id: $('queue-editor').value, settings: { enabled: false } }));
$('queue-remove').onclick = () => perform(() => changeQueue('remove', { id: $('queue-editor').value }));
$('queue-form').onsubmit = async event => {
  event.preventDefault();
  $('queue-error').hidden = true;
  try {
    const schedule = $('queue-schedule-enabled').checked ? { start: $('queue-start-time').value, stop: $('queue-stop-time').value, days: [...document.querySelectorAll('.queue-days input:checked')].map(check => Number(check.value)) } : null;
    const completionAction = { type: $('queue-completion-type').value, delaySeconds: Number($('queue-completion-delay').value) };
    await changeQueue('update', { id: $('queue-editor').value, settings: { name: $('queue-name').value, parallel: Number($('queue-parallel').value), schedule, completionAction } });
  } catch (error) { $('queue-error').textContent = sahmI18n.formatMessage(error.message); $('queue-error').hidden = false; }
};
$('move-selected').onclick = () => { $('move-error').hidden = true; openDialog('move-dialog', 'move-queue'); };
$('move-form').onsubmit = async event => {
  event.preventDefault();
  $('move-error').hidden = true;
  try {
    await changeQueue('assign', { ids: [...selectedIds], queueId: $('move-queue').value });
    $('move-dialog').close();
  } catch (error) { $('move-error').textContent = sahmI18n.formatMessage(error.message); $('move-error').hidden = false; }
};
$('refresh-address').onclick = () => {
  const job = selectedJob();
  if (!job) return;
  refreshingAddressId = job.id;
  $('refresh-url').value = job.url;
  $('refresh-error').hidden = true;
  openDialog('refresh-dialog', 'refresh-url');
};
$('refresh-form').onsubmit = async event => {
  event.preventDefault();
  $('refresh-error').hidden = true;
  try {
    await busy(event.submitter || event.target.querySelector('[type="submit"]'), async () => {
      const result = await api.refreshAddress(refreshingAddressId, $('refresh-url').value.trim());
      $('refresh-dialog').close();
      notice(result.resumedPartial ? __sahmT("حُدّث الرابط مع الاحتفاظ بـ {0}. اضغط «استئناف» للمتابعة.", [bytes(result.preservedBytes)]) : __sahmT("حُدّث الرابط. يبدأ الاستئناف من جديد ويحفظ سَهم الجزء السابق عند وجوده."));
    });
  } catch (error) { $('refresh-error').textContent = sahmI18n.formatMessage(error.message); $('refresh-error').hidden = false; }
};
$('batch-preview').onclick = () => perform(async () => {
  $('batch-error').hidden = true;
  try {
    const urls = await api.batchPreview($('batch-pattern').value.trim());
    $('batch-results').value = urls.join('\n');
    $('batch-results').hidden = false;
    $('batch-summary').textContent = __sahmT("{0} رابط جاهز للإضافة.", [urls.length]);
  } catch (error) { $('batch-error').textContent = sahmI18n.formatMessage(error.message); $('batch-error').hidden = false; }
});
$('batch-form').onsubmit = async event => {
  event.preventDefault();
  $('batch-error').hidden = true;
  try {
    await busy(event.submitter || event.target.querySelector('[type="submit"]'), async () => {
      const result = await api.batchAdd({ pattern: $('batch-pattern').value.trim(), queueId: $('batch-queue').value });
      $('batch-dialog').close();
      showView('downloads');
      notice(__sahmT("أُضيف {0} رابط. تعذّرت إضافة {1}.", [result.added, result.rejected]));
    });
  } catch (error) { $('batch-error').textContent = sahmI18n.formatMessage(error.message); $('batch-error').hidden = false; }
};

$('toggle-add').onclick = openAdd;
$('empty-add').onclick = openAdd;
$('dismiss-notice').onclick = () => notice('');
$('search').oninput = () => { clearSelection(); render(); };
$('select-all').onchange = event => selectAll(event.target.checked);
$('clear-selection').onclick = () => { if (!actionRunning) { clearSelection(); syncSelection(); } };
document.querySelectorAll('[data-filter]').forEach(node => { node.onclick = () => { filter = node.dataset.filter; clearSelection(); showView('downloads'); render(); }; });
document.querySelectorAll('[data-view]').forEach(node => { node.onclick = () => showView(node.dataset.view); });
document.querySelectorAll('[data-command]').forEach(node => { node.onclick = () => perform(() => runCommand(node.dataset.command)); });
document.querySelectorAll('[data-close]').forEach(node => { node.onclick = () => $(node.dataset.close).close(); });
document.querySelectorAll('[data-sort]').forEach(node => {
  node.onclick = () => {
    if (sortKey === node.dataset.sort) sortDirection *= -1;
    else { sortKey = node.dataset.sort; sortDirection = 1; }
    document.querySelectorAll('[data-sort]').forEach(button => {
      const active = button === node;
      button.classList.toggle('sorted', active);
      button.parentElement.setAttribute('aria-sort', active ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none');
    });
    render();
    void window.sahmTable.rememberSort(sortKey, sortDirection);
  };
});
$('customize-columns').onclick = () => perform(() => window.sahmTable.open());

$('add-form').onsubmit = async event => {
  event.preventDefault();
  $('add-error').hidden = true;
  try {
    await busy(event.submitter || event.target.querySelector('[type="submit"]'), async () => {
      const ftp = /^ftps?:/i.test($('url').value.trim());
      const job = await api.add({ ...window.sahmMediaAdd.selection(), url: $('url').value.trim(), name: $('name').value.trim(), connections: Number($('connections').value), startAt: $('schedule').value ? new Date($('schedule').value).toISOString() : null, queueId: $('add-queue').value, ...(ftp ? { credentials: $('ftp-username').value ? { username: $('ftp-username').value, password: $('ftp-password').value } : undefined, rememberCredentials: $('ftp-remember').checked, ftpTLS: $('ftp-tls').value } : {}) });
      $('url').value = ''; $('name').value = ''; $('schedule').value = '';
      $('ftp-username').value = ''; $('ftp-password').value = ''; $('ftp-remember').checked = false;
      $('add-dialog').close();
      filter = 'all';
      queueFilter = 'all'; $('queue-filter').value = 'all';
      selectedIds.clear();
      if (job?.id) selectedIds.add(job.id);
      selectedId = job?.id || null;
      showView('downloads');
      render();
      notice(__sahmT("أُضيف الرابط إلى قائمة التنزيلات."));
    });
  } catch (error) { $('add-error').textContent = sahmI18n.formatMessage(error.message); $('add-error').hidden = false; }
};

$('capture-enabled').onchange = event => {
  const enabled = event.target.checked;
  perform(async () => {
    try { await busy(event.target, () => api.capture(enabled)); }
    finally { await refreshSettings(); }
  });
};
for (const [id, preference] of [['session-capture-enabled', 'sessionCaptureEnabled'], ['post-capture-enabled', 'postCaptureEnabled']]) {
  $(id).onchange = event => perform(async () => {
    try { await busy(event.target, () => api.preferences({ [preference]: event.target.checked })); }
    finally { await refreshSettings(); }
  });
}
$('register-integration').onclick = event => perform(() => integrationAction('register', event.currentTarget));
$('unregister-integration').onclick = event => perform(() => integrationAction('unregister', event.currentTarget));
$('open-extension').onclick = () => perform(() => integrationAction('open-extension'));
$('install-chrome').onclick = event => perform(() => integrationAction('install-chrome', event.currentTarget));
$('install-edge').onclick = event => perform(() => integrationAction('install-edge', event.currentTarget));
$('refresh-integration').onclick = () => perform(refreshSettings);
$('choose-directory').onclick = () => perform(async () => {
  const value = await api.chooseDirectory();
  if (value?.downloadDirectory) $('download-directory').value = value.downloadDirectory;
});
$('preferences-form').onsubmit = event => {
  event.preventDefault();
  if (settingsLoading || !settings?.downloadDirectory) return;
  $('preferences-saved').textContent = '';
  perform(() => busy(event.submitter || event.target.querySelector('[type="submit"]'), async () => {
    let scannerArgs;
    try { scannerArgs = JSON.parse($('scan-args').value); }
    catch { throw new Error(__sahmT("معاملات الفحص يجب أن تكون مصفوفة JSON، مثل [\"{file}\"].")); }
    await api.preferences({ downloadDirectory: $('download-directory').value, theme: $('theme').value, language: $('language').value, speedLimit: Number($('speed-limit').value) * 1024, parallel: Number($('parallel').value), showDownloadWindows: document.getElementById('show-download-windows').checked, clipboardMonitorEnabled: $('clipboard-monitor').checked, startWithWindows: $('start-with-windows').checked, downloadRulesText: $('download-rules').value, scanner: { enabled: $('scan-enabled').checked, mode: $('scan-mode').value, executable: $('scan-executable').value, args: scannerArgs, timeoutMs: Number($('scan-timeout').value) * 1000 } });
    await refreshSettings();
    $('preferences-saved').textContent = __sahmT("حُفظت الإعدادات.");
  }));
};

$('grab-form').onsubmit = async event => {
  event.preventDefault();
  $('grab-status').textContent = __sahmT("جارٍ فحص الصفحة…");
  $('grab-results').hidden = true;
  $('grab-add').hidden = true;
  try { await busy($('grab-submit'), async () => renderDiscoveredLinks(await api.grab($('grab-url').value.trim()))); }
  catch (error) { $('grab-status').textContent = sahmI18n.formatMessage(error.message); }
};
$('grab-add').onclick = async () => {
  try {
    await busy($('grab-add'), async () => {
      const checked = [...$('grab-results').querySelectorAll('input:checked')];
      if (!checked.length) { $('grab-status').textContent = __sahmT("حدّد رابطًا واحدًا على الأقل."); return; }
      for (const check of checked) {
        const link = discoveredLinks[Number(check.dataset.index)];
        await api.add({ url: link.url, name: link.name, connections: 4, queueId: queueFilter === 'all' ? 'default' : queueFilter });
        check.checked = false;
      }
      $('grab-dialog').close();
      filter = 'all'; showView('downloads'); render();
      notice(__sahmT("أُضيف {0} رابط إلى قائمة التنزيلات.", [checked.length]));
    });
  } catch (error) { $('grab-status').textContent = sahmI18n.formatMessage(error.message); }
};

document.addEventListener('keydown', event => {
  const dialogOpen = !!document.querySelector('dialog[open]');
  const editing = event.target.matches('input:not([type="checkbox"]), select, textarea, [contenteditable]');
  if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openAdd(); return; }
  if (dialogOpen) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); showView('downloads'); $('search').focus(); return; }
  if (editing || currentView !== 'downloads') return;
  if (event.ctrlKey && event.key.toLowerCase() === 'a' && event.target.closest('.table-region')) { event.preventDefault(); selectAll(true); return; }
  if (event.key === 'Escape') { event.preventDefault(); if (!actionRunning) { clearSelection(); syncSelection(); } return; }
  if (event.key === 'Delete') { event.preventDefault(); perform(() => selectedAction('remove')); }
  if (event.key === 'Enter' && event.target.closest('.table-region')) { event.preventDefault(); perform(activateSelected); }
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && event.target.closest('.table-region')) {
    event.preventDefault();
    const visible = visibleJobs();
    const index = visible.findIndex(job => job.id === selectedId);
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    const job = visible[Math.max(0, Math.min(visible.length - 1, next))];
    if (job) { selectJob(job.id); $('jobs').querySelector(`[data-id="${job.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }
});

window.sahmTable.bind({ render, setSort(value) { sortKey = value.key; sortDirection = value.direction === 'asc' ? 1 : -1; } });
let completionStates = [];
function renderCompletion(statuses) {
  completionStates = statuses;
  const waiting = statuses.filter(status => ['pending', 'blocked'].includes(status.state));
  $('completion-notice').hidden = waiting.length === 0;
  const labels = { notify: __sahmT("إشعار"), 'open-folder': __sahmT("فتح مجلد التنزيلات"), exit: __sahmT("الخروج من سَهم"), shutdown: __sahmT("إيقاف تشغيل الجهاز"), sleep: __sahmT("سكون الجهاز"), hibernate: __sahmT("إسبات الجهاز") };
  $('completion-summary').textContent = waiting.map(status => status.state === 'blocked' ? __sahmT("{0}: {1} ينتظر انتهاء العمل الجاري.", [status.queueName, labels[status.type]]) : __sahmT("{0}: {1} بعد {2} ثانية.", [status.queueName, labels[status.type], status.remainingSeconds])).join(' · ');
  $('completion-cancel').textContent = waiting.length > 1 ? __sahmT("إلغاء جميع الإجراءات") : __sahmT("إلغاء الإجراء");
}
$('completion-cancel').onclick = () => perform(() => busy($('completion-cancel'), async () => {
  for (const status of completionStates.filter(value => ['pending', 'blocked'].includes(value.state))) await api.cancelCompletion(status.queueId);
  renderCompletion(await api.completionStatus());
}));
api.onCompletion(statuses => {
  for (const status of statuses.filter(value => value.state === 'error')) {
    if (!completionStates.some(previous => previous.queueId === status.queueId && previous.state === 'error')) notice(__sahmT("تعذّر تنفيذ الإجراء بعد اكتمال {0}. راجع إعدادات Windows وصلاحيات الجهاز.", [status.queueName]));
  }
  renderCompletion(statuses);
});
api.onJobs(value => { jobs = value; render(); });
api.onQueues?.(value => { queues = value; renderQueueJobs(); });
api.onClipboardLink?.(url => {
  if (document.querySelector('dialog[open]')) return;
  openAdd();
  $('url').value = url;
  updateFtpFields();
});
api.onStorageError(message => notice(__sahmT("تعذّر حفظ القائمة: {0}", [message])));
api.onCommand?.(command => perform(() => runCommand(command)));
api.onSettings?.(value => { settings = value; renderIntegration(value.browser); applyTheme(value.theme); });
window.addEventListener('focus', () => perform(async () => {
  if (!api.settings) return;
  const value = await api.settings();
  renderIntegration(value.browser);
}));
document.addEventListener('dragover', event => {
  if ([...event.dataTransfer.types].some(type => ['text/uri-list', 'text/plain'].includes(type))) event.preventDefault();
});
document.addEventListener('drop', event => {
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
  if (!text || text.length > 8192) return;
  const value = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.trim();
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol) || url.username || url.password) return;
    event.preventDefault();
    if (document.querySelector('dialog[open]')) return;
    openAdd(); $('url').value = url.href;
    updateFtpFields();
  } catch { /* Unsupported dropped text is left unchanged. */ }
});
setInterval(() => { if (currentView === 'queues' && !queueSaving) perform(() => refreshQueues(false)); }, 5000);
window.sahmLocaleReady = perform(async () => { jobs = await api.list(); await refreshQueues(false); render(); await refreshSettings(); renderCompletion(await api.completionStatus()); });

function renderParts(job) {
  const container = $('transfer-parts');
  const parts = job?.transferParts || [];
  container.hidden = !parts.length;
  if (!parts.length) { container.replaceChildren(); return; }
  const title = element('span', __sahmT("أجزاء الملف: {0}", [parts.length]), 'hint');
  const ranges = element('div', '', 'part-ranges');
  for (const [index, part] of parts.slice(0, 64).entries()) {
    const progress = element('progress');
    progress.max = Math.max(1, part.end - part.start + 1);
    progress.value = part.received || 0;
    progress.title = __sahmT("الجزء {0}: {1} / {2}{3}", [index + 1, bytes(part.received || 0), bytes(progress.max), part.active ? __sahmT(" · نشط") : '']);
    progress.setAttribute('aria-label', progress.title);
    progress.classList.toggle('active-part', !!part.active);
    ranges.append(progress);
  }
  container.replaceChildren(title, ranges);
}

function updateFtpFields() {
  const ftp = /^ftps?:/i.test($('url').value.trim());
  $('ftp-add-fields').hidden = !ftp;
  $('ftp-add-fields').disabled = !ftp;
  $('connections').disabled = ftp;
}

function openFtpCredentials(job = selectedJob()) {
  if (job?.kind !== 'ftp' || ['downloading', 'complete'].includes(job.status)) return;
  ftpCredentialsId = job.id;
  $('ftp-job-name').textContent = job.name;
  $('ftp-job-username').value = '';
  $('ftp-job-password').value = '';
  $('ftp-job-remember').checked = false;
  $('ftp-error').hidden = true;
  openDialog('ftp-dialog', 'ftp-job-username');
}
$('url').oninput = updateFtpFields;
$('ftp-credentials').onclick = () => openFtpCredentials();
$('ftp-form').onsubmit = async event => {
  event.preventDefault();
  $('ftp-error').hidden = true;
  try {
    await busy(event.submitter, () => api.ftpCredentials(ftpCredentialsId, { credentials: { username: $('ftp-job-username').value, password: $('ftp-job-password').value }, remember: $('ftp-job-remember').checked }));
    $('ftp-job-password').value = '';
    $('ftp-dialog').close();
    jobs = await api.list(); render();
    notice(__sahmT("حُفظ حساب FTP. اضغط استئناف لبدء التنزيل."));
  } catch (error) { $('ftp-error').textContent = sahmI18n.formatMessage(error.message); $('ftp-error').hidden = false; }
};
for (const id of ['add-dialog', 'ftp-dialog']) $(id).addEventListener('close', () => {
  $(id === 'add-dialog' ? 'ftp-password' : 'ftp-job-password').value = '';
});

function updateScannerFields() {
  $('scanner-fields').disabled = !$('scan-enabled').checked;
  const custom = $('scan-mode').value === 'custom';
  $('scanner-custom').hidden = !custom;
  $('scan-executable').required = custom && $('scan-enabled').checked;
}
$('scan-enabled').onchange = updateScannerFields;
$('scan-mode').onchange = updateScannerFields;
$('choose-scanner').onclick = () => perform(async () => {
  const path = await api.chooseScanner();
  if (path) $('scan-executable').value = path;
});

function updateNetworkFields() {
  for (const [id, mode] of [['proxy-manual', 'manual'], ['proxy-pac', 'pac']]) {
    $(id).hidden = $('network-mode').value !== mode;
    $(id).disabled = $(id).hidden;
  }
  $('choose-pac').hidden = $('pac-source').value !== 'file';
}
async function loadNetwork() {
  networkLoading++;
  const submit = $('network-form').querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const value = await api.networkSettings();
    const config = value.config;
    $('network-mode').value = config.mode;
    $('proxy-type').value = config.proxy?.type || 'http';
    $('proxy-host').value = config.proxy?.host || '';
    $('proxy-port').value = config.proxy?.port || 8080;
    $('proxy-username').value = value.username;
    $('proxy-password').value = '';
    $('proxy-password-hint').textContent = value.hasPassword ? __sahmT("اتركها فارغة للإبقاء على كلمة مرور هذا الوكيل للحساب نفسه.") : __sahmT("اتركها فارغة إن كان الوكيل لا يتطلب حسابًا.");
    $('proxy-clear-auth').checked = false;
    $('proxy-remember').checked = value.remembered;
    $('proxy-remember').disabled = !value.encryptionAvailable;
    $('pac-source').value = config.pacFile ? 'file' : 'url';
    $('pac-address').value = config.pacFile || config.pacUrl || '';
    $('proxy-bypass').value = config.bypass.join('\n');
    window.sahmEnterprise.load(value);
    $('network-warning').textContent = sahmI18n.formatMessage(value.warning) || (!value.encryptionAvailable ? __sahmT("تشفير Windows غير متاح. بيانات الدخول تبقى في الذاكرة حتى إغلاق التطبيق.") : '');
    $('network-warning').hidden = !$('network-warning').textContent;
    updateNetworkFields();
  } finally { submit.disabled = --networkLoading > 0; }
}
$('network-mode').onchange = updateNetworkFields;
$('pac-source').onchange = updateNetworkFields;
$('choose-pac').onclick = () => perform(async () => {
  const path = await api.choosePac();
  if (path) { $('pac-source').value = 'file'; $('pac-address').value = path; updateNetworkFields(); }
});
$('network-form').onsubmit = async event => {
  event.preventDefault();
  if (networkLoading) return;
  $('network-error').hidden = true;
  $('network-saved').textContent = '';
  const config = { mode: $('network-mode').value, bypass: lines($('proxy-bypass').value) };
  if (config.mode === 'manual') config.proxy = { type: $('proxy-type').value, host: $('proxy-host').value.trim(), port: Number($('proxy-port').value) };
  if (config.mode === 'pac') config[$('pac-source').value === 'file' ? 'pacFile' : 'pacUrl'] = $('pac-address').value.trim();
  try {
    await busy(event.submitter, async () => {
      const enterprise = window.sahmEnterprise.read(config);
      await api.networkSave({ ...enterprise, username: $('proxy-username').value, password: $('proxy-password').value, remember: $('proxy-remember').checked, clearCredentials: $('proxy-clear-auth').checked });
      window.sahmEnterprise.clearSecrets();
      await loadNetwork();
      $('network-saved').textContent = __sahmT("حُفظ الاتصال.");
    });
  } catch (error) { $('network-error').textContent = sahmI18n.formatMessage(error.message); $('network-error').hidden = false; }
};

function lines(value) { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function renderSites() {
  const labels = { queued: __sahmT("في الانتظار"), running: __sahmT("جارٍ النسخ"), paused: __sahmT("متوقفة"), partial: __sahmT("نسخة جزئية"), complete: __sahmT("مكتملة"), error: __sahmT("تعذّر النسخ"), conflict: __sahmT("تعديلات محلية"), 'needs-session': __sahmT("تسجيل الدخول مطلوب") };
  const focused = document.activeElement.closest('#site-jobs [data-site-action]');
  const focusedJob = focused?.closest('[data-site-id]')?.dataset.siteId;
  const focusedAction = focused?.dataset.siteAction;
  $('site-empty').hidden = siteJobs.length > 0;
  $('site-jobs').replaceChildren(...siteJobs.map(job => {
    const row = element('tr'); row.dataset.siteId = job.id;
    const address = element('td');
    const link = element('div', job.rootUrl, 'site-address'); link.dir = sahmI18n.direction(); link.title = job.rootUrl;
    address.append(link);
    if (job.options?.renderMode === 'browser') address.append(element('div', __sahmT("لقطة بعد تشغيل JavaScript"), 'hint'));
    if (job.options?.hashRoutes) address.append(element('div', __sahmT("مسارات hash مستقلة"), 'hint'));
    if (job.sessionRequired) address.append(element('div', job.sessionAvailable ? __sahmT("جلسة دخول جاهزة") : __sahmT("تحتاج جلسة دخول للمتابعة"), 'hint'));
    if (job.schedule) {
      address.append(element('div', job.schedule.enabled ? __sahmT("مزامنة كل {0} دقيقة", [job.schedule.intervalMinutes]) : __sahmT("المزامنة الدورية موقوفة"), 'hint'));
      if (job.nextRunAt) address.append(element('div', __sahmT("الفحص التالي: {0}", [scheduleFormatter.format(new Date(job.nextRunAt))]), 'hint'));
      if (job.lastCycle) address.append(element('div', __sahmT("آخر دورة: {0} محدّث، {1} دون تغيير، {2} محذوف من النسخة الجديدة", [job.lastCycle.updated, job.lastCycle.unchanged, job.lastCycle.removed]), 'hint'));
    }
    if (sahmI18n.formatMessage(job.error)) address.append(element('div', sahmI18n.formatMessage(job.error), 'error-text site-error'));
    if (job.failed) address.append(element('div', __sahmT("{0} ملف لم يُحفظ", [job.failed]), 'hint'));
    const actions = element('td'); const controls = element('div', '', 'site-actions');
    const action = (name, text) => { const button = element('button', text); button.type = 'button'; button.dataset.siteAction = name; button.onclick = () => perform(() => busy(button, async () => {
      if (name === 'open') await api.openSite(job.id);
      else if (name === 'previous') await api.openSite(job.id, 'previous');
      else if (name === 'schedule') {
        $('site-schedule-form').dataset.jobId = job.id;
        $('site-schedule-address').textContent = job.rootUrl;
        $('site-schedule-enabled').checked = !!job.schedule?.enabled;
        $('site-schedule-minutes').value = job.schedule?.intervalMinutes || 60;
        $('site-schedule-error').hidden = true; $('site-schedule-dialog').showModal();
      }
      else if (name === 'folder') await api.siteFolder(job.id);
      else if (name === 'login') {
        const session = await window.sahmSiteSessions.open(job.rootUrl);
        siteJobs = await api.attachSiteSession(job.id, session.id); renderSites();
      }
      else { await api.siteAction(job.id, name); siteJobs = await api.sites(); renderSites(); }
    })); controls.append(button); };
    if (['running', 'queued'].includes(job.state)) action('pause', __sahmT("إيقاف"));
    else if (job.sessionRequired && !job.sessionAvailable && (job.state !== 'complete' || job.schedule)) action('login', __sahmT("تسجيل الدخول والمتابعة"));
    else if (['paused', 'partial', 'error'].includes(job.state)) action('resume', __sahmT("استئناف"));
    if (!['running', 'queued'].includes(job.state)) {
      action('schedule', __sahmT("جدول التحديث…"));
      if (job.schedule && (!job.sessionRequired || job.sessionAvailable)) action('check', __sahmT("فحص الآن"));
      if (job.schedule?.enabled) action('pause', __sahmT("إيقاف المزامنة"));
    }
    if (job.entryPath && (job.publishedRevision || !['running', 'queued'].includes(job.state))) action('open', __sahmT("فتح النسخة"));
    if (job.previousRevision) action('previous', __sahmT("النسخة السابقة"));
    action('folder', __sahmT("المجلد"));
    if (!['running', 'queued'].includes(job.state)) action('remove', __sahmT("إزالة"));
    actions.append(controls);
    row.append(address, element('td', labels[job.state] || job.state), element('td', `${job.pages || 0} / ${job.files || 0}`, 'numeric'), element('td', bytes(job.bytes || 0), 'numeric'), actions);
    return row;
  }));
  if (focusedJob) $('site-jobs').querySelector(`[data-site-id="${focusedJob}"] [data-site-action="${focusedAction}"]`)?.focus({ preventScroll: true });
}
$('site-form').onsubmit = async event => {
  event.preventDefault();
  $('site-error').hidden = true;
  $('site-status').textContent = '';
  try {
    await busy(event.submitter || event.currentTarget.querySelector('[type="submit"]'), async () => {
      const url = $('site-url').value.trim();
      const schedule = $('site-periodic').checked ? { enabled: true, intervalMinutes: Number($('site-interval').value) } : undefined;
      await api.addSite({ url, schedule, sessionId: window.sahmSiteSessions.selected(url), options: { renderMode: $('site-render-mode').value, renderWaitMs: Math.round(Number($('site-render-wait').value) * 1000), hashRoutes: $('site-hash-routes').checked, depth: Number($('site-depth').value), maxPages: Number($('site-pages').value), maxBytes: Number($('site-megabytes').value) * 1024 ** 2, maxFileBytes: Number($('site-file-megabytes').value) * 1024 ** 2, maxResources: Number($('site-resources').value), concurrency: Number($('site-concurrency').value), respectRobots: $('site-robots').checked, externalAssets: $('site-external').checked, include: lines($('site-include').value), exclude: lines($('site-exclude').value) } });
      siteJobs = await api.sites(); renderSites();
      $('site-status').textContent = __sahmT("أُضيف الموقع إلى قائمة النسخ.");
    });
  } catch (error) { $('site-error').textContent = sahmI18n.formatMessage(error.message); $('site-error').hidden = false; }
};
api.onSites?.(value => { siteJobs = value; if (currentView === 'sites') renderSites(); });
$('site-periodic').onchange = () => { $('site-interval').disabled = !$('site-periodic').checked; };
$('site-schedule-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('site-schedule-error').hidden = true;
  try {
    await busy(event.submitter || form.querySelector('[type="submit"]'), async () => {
      siteJobs = await api.siteSchedule(form.dataset.jobId, { enabled: $('site-schedule-enabled').checked, intervalMinutes: Number($('site-schedule-minutes').value) });
      renderSites(); $('site-schedule-dialog').close();
    });
  } catch (error) { $('site-schedule-error').textContent = sahmI18n.formatMessage(error.message); $('site-schedule-error').hidden = false; }
};


window.sahmUiState = {
  capture: () => ({ currentView, filter, queueFilter, selectedId, selectedIds: [...selectedIds], syncEditingId: window.sahmPolicies.captureDraft(), ftpCredentialsId, refreshingAddressId, siteScheduleId: $("site-schedule-form").dataset.jobId }),
  async restore(state) {
    filter = Object.hasOwn(filterTitles, state.filter) ? state.filter : 'all';
    queueFilter = state.queueFilter || 'all'; selectedId = state.selectedId;
    selectedIds.clear(); for (const id of state.selectedIds || []) selectedIds.add(id);
    ftpCredentialsId = state.ftpCredentialsId; refreshingAddressId = state.refreshingAddressId; $("site-schedule-form").dataset.jobId = state.siteScheduleId || "";
    await loadNetwork(); await window.sahmServerRules.load(); await window.sahmSiteSessions.load(); await window.sahmPolicies.load();
    await showView(['downloads','browser','preferences','queues','network','sites','automation'].includes(state.currentView) ? state.currentView : 'downloads');
    window.sahmPolicies.restoreDraft(state.syncEditingId);
    render();
  }
};
