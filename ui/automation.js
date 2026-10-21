(() => {
  let budget = null;
  let projects = [];
  let loading = 0;
  let editingId = null;
  const submitButton = form => form.querySelector('[type="submit"]');
  const date = value => value ? scheduleFormatter.format(new Date(value)) : '—';
  const blocked = () => !!(budget?.exhausted || budget?.storageError);

  function renderQuota() {
    if (!budget) return;
    $('quota-progress').max = budget.config.limitBytes;
    $('quota-progress').value = Math.min(budget.usedBytes, budget.config.limitBytes);
    $('quota-usage').textContent = __sahmT("{0}: {1} من {2}{3}", [budget.config.enabled ? __sahmT("المستهلك") : __sahmT("الحصة معطلة · الاستهلاك المحفوظ"), bytes(budget.usedBytes), bytes(budget.config.limitBytes), blocked() ? __sahmT(" · النقل متوقف") : '']);
    $('quota-renewal').textContent = budget.storageError || __sahmT("التجدد التالي: {0} · الفترة المضبوطة: {1} ساعة.", [date(budget.resetAt), budget.config.periodHours]);
    $('quota-renewal').classList.toggle('error-text', !!budget.storageError);
  }

  function receiveQuota(value) {
    const wasBlocked = blocked();
    budget = value;
    renderQuota();
    if (blocked() !== wasBlocked) render();
  }

  function syncQueueOptions() {
    for (const id of ['sync-queue', 'sync-edit-queue']) {
      const select = $(id), previous = select.value;
      const none = element('option', __sahmT("دون ربط بقائمة")); none.value = '';
      const options = queues.map(queue => { const option = element('option', sahmI18n.queueLabel(queue)); option.value = queue.id; return option; });
      select.replaceChildren(none, ...options);
      select.value = queues.some(queue => queue.id === previous) ? previous : '';
    }
  }

  async function load() {
    loading++;
    submitButton($('quota-form')).disabled = true;
    try {
      const [value, list] = await Promise.all([api.quota(), api.syncs()]);
      receiveQuota(value);
      projects = list;
      $('quota-enabled').checked = value.config.enabled;
      $('quota-megabytes').value = value.config.limitBytes / 1024 ** 2;
      $('quota-period-hours').value = value.config.periodHours;
      $('quota-fields').disabled = !value.config.enabled;
      syncQueueOptions(); renderProjects();
    } finally { submitButton($('quota-form')).disabled = --loading > 0 || !budget; }
  }

  function editProject(project) {
    editingId = project.id;
    syncQueueOptions();
    $('sync-edit-name').value = project.name;
    $('sync-edit-minutes').value = project.intervalMinutes;
    $('sync-edit-queue').value = project.queueId || '';
    $('sync-edit-enabled').checked = project.enabled;
    $('sync-edit-error').hidden = true;
    openDialog('sync-edit-dialog', 'sync-edit-name');
  }

  function renderProjects() {
    const labels = { idle: __sahmT("بانتظار الموعد"), running: __sahmT("جارٍ الفحص"), paused: __sahmT("متوقفة"), blocked: __sahmT("بانتظار السماح"), error: __sahmT("تعذّرت المزامنة"), conflict: __sahmT("تعديل محلي يحتاج مراجعة") };
    const focused = document.activeElement.closest('#sync-jobs [data-sync-action]');
    const focusedId = focused?.closest('[data-sync-id]')?.dataset.syncId;
    const focusedAction = focused?.dataset.syncAction;
    $('sync-empty').hidden = projects.length > 0;
    $('sync-jobs').replaceChildren(...projects.map(project => {
      const row = element('tr'); row.dataset.syncId = project.id;
      const name = element('td');
      name.append(element('div', project.name, 'sync-project-name'));
      const files = element('details', '', 'sync-files');
      files.append(element('summary', __sahmT("{0} ملف · كل {1} دقيقة", [project.entries.length, project.intervalMinutes])));
      const list = element('ul');
      for (const entry of project.entries) { const item = element('li', entry.filename); item.title = entry.url; list.append(item); }
      files.append(list); name.append(files);
      const state = element('td', project.quotaHeld ? __sahmT("بانتظار تجدد الحصة") : labels[project.state] || project.state);
      if (sahmI18n.formatMessage(project.error)) state.append(element('div', sahmI18n.formatMessage(project.error), 'error-text site-error'));
      const last = element('td', date(project.lastRunAt));
      if (project.lastRunAt) last.append(element('div', __sahmT("{0} محدّث · {1} دون تغيير", [project.updatedFiles || 0, project.unchangedFiles || 0]), 'hint'));
      const actions = element('td'), controls = element('div', '', 'site-actions');
      const addAction = (action, text) => {
        const button = element('button', text); button.type = 'button'; button.dataset.syncAction = action;
        button.onclick = () => {
          if (action === 'edit') { editProject(project); return; }
          perform(() => busy(button, async () => {
            if (action === 'folder') await api.syncFolder(project.id);
            else { await api.syncAction(project.id, action); projects = await api.syncs(); renderProjects(); }
          }));
        };
        controls.append(button);
      };
      if (project.state !== 'running') addAction('run', __sahmT("فحص الآن"));
      addAction(project.enabled || project.state === 'running' ? 'pause' : 'resume', project.enabled || project.state === 'running' ? __sahmT("إيقاف") : __sahmT("تفعيل"));
      if (project.state !== 'running') addAction('edit', __sahmT("الإعدادات"));
      addAction('folder', __sahmT("المجلد"));
      if (project.state !== 'running') addAction('remove', __sahmT("إزالة"));
      actions.append(controls);
      row.append(name, state, last, element('td', date(project.nextRunAt)), actions);
      return row;
    }));
    if (focusedId) $('sync-jobs').querySelector(`[data-sync-id="${focusedId}"] [data-sync-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }

  $('quota-enabled').onchange = () => { $('quota-fields').disabled = !$('quota-enabled').checked; };
  $('quota-form').onsubmit = async event => {
    event.preventDefault();
    if (loading || !budget) return;
    $('quota-error').hidden = true; $('quota-saved').textContent = '';
    try {
      await busy(event.submitter || submitButton(event.target), async () => {
        receiveQuota(await api.quotaSave({ enabled: $('quota-enabled').checked, limitBytes: Number($('quota-megabytes').value) * 1024 ** 2, periodHours: Number($('quota-period-hours').value) }));
        $('quota-saved').textContent = __sahmT("حُفظت الحصة. يبقى استهلاك الفترة الحالية محفوظًا.");
      });
    } catch (error) { $('quota-error').textContent = sahmI18n.formatMessage(error.message); $('quota-error').hidden = false; }
  };

  $('sync-form').onsubmit = async event => {
    event.preventDefault(); $('sync-error').hidden = true; $('sync-saved').textContent = '';
    try {
      await busy(event.submitter || submitButton(event.target), async () => {
        await api.syncAdd({ name: $('sync-name').value.trim(), urls: $('sync-urls').value, intervalMinutes: Number($('sync-minutes').value), queueId: $('sync-queue').value || null, enabled: $('sync-enabled').checked });
        $('sync-name').value = ''; $('sync-urls').value = '';
        projects = await api.syncs(); renderProjects();
        $('sync-saved').textContent = __sahmT("أُضيف مشروع المزامنة.");
      });
    } catch (error) { $('sync-error').textContent = sahmI18n.formatMessage(error.message); $('sync-error').hidden = false; }
  };

  $('sync-edit-form').onsubmit = async event => {
    event.preventDefault(); $('sync-edit-error').hidden = true;
    try {
      const previous = projects.find(project => project.id === editingId);
      const changes = { name: $('sync-edit-name').value.trim(), intervalMinutes: Number($('sync-edit-minutes').value), queueId: $('sync-edit-queue').value || null };
      if (previous?.enabled !== $('sync-edit-enabled').checked) changes.enabled = $('sync-edit-enabled').checked;
      await busy(event.submitter || submitButton(event.target), () => api.syncUpdate(editingId, changes));
      $('sync-edit-dialog').close();
      projects = await api.syncs(); renderProjects();
    } catch (error) { $('sync-edit-error').textContent = sahmI18n.formatMessage(error.message); $('sync-edit-error').hidden = false; }
  };

  api.onQuota?.(receiveQuota);
  api.onSyncs?.(list => { projects = list; if (currentView === 'automation') renderProjects(); });
  window.sahmPolicies = { load, queueOptions: syncQueueOptions, blocked, captureDraft: () => editingId, restoreDraft: value => { editingId = value; } };
  if (api.quota) perform(async () => receiveQuota(await api.quota()));
})();

