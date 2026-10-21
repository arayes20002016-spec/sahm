(() => {
  const byId = id => document.getElementById(id);
  const form = byId('server-rules-form'), rows = byId('server-rule-rows');
  const fields = byId('server-rules-fields'), add = byId('server-rule-add');
  const error = byId('server-rules-error'), saved = byId('server-rules-saved');
  function empty() { byId('server-rules-empty').hidden = rows.children.length > 0; add.disabled = fields.disabled || rows.children.length >= 64; }
  function row(value = {}) {
    const root = document.createElement('fieldset'); root.className = 'connection-fields server-rule-row';
    const legend = document.createElement('legend'); legend.textContent = __sahmT("قاعدة نطاق"); root.append(legend);
    const grid = document.createElement('div'); grid.className = 'preference-columns'; root.append(grid);
    function input(name, title, type, initial, options = {}) {
      const label = document.createElement('label'); label.className = 'setting-field'; label.textContent = title;
      const field = document.createElement('input'); field.type = type; field.dataset.ruleField = name; field.value = initial;
      Object.assign(field, options); if (name !== 'category') field.dir = sahmI18n.direction();
      label.append(field); grid.append(label); return field;
    }
    input('host', __sahmT("النطاق أو النمط"), 'text', value.host || '', { required: true, maxLength: 253, placeholder: '*.example.com' });
    input('port', __sahmT("المنفذ (فارغ لجميع المنافذ)"), 'number', value.port ?? '', { min: '1', max: '65535', step: '1' });
    input('connections', __sahmT("أقصى عمليات نقل للخادم"), 'number', value.connections ?? 8, { min: '1', max: '32', step: '1', required: true });
    input('fileConnections', __sahmT("أقصى اتصالات لملف HTTP"), 'number', value.fileConnections ?? 4, { min: '1', max: '16', step: '1', required: true });
    input('speedLimit', __sahmT("حد سرعة الملف (KiB/s، صفر دون حد)"), 'number', (value.speedLimit || 0) / 1024, { min: '0', max: '1073741824', step: 'any', required: true });
    input('category', __sahmT("التصنيف (اختياري)"), 'text', value.category || '', { maxLength: 80 });
    const path = input('directory', __sahmT("مجلد الحفظ (اختياري)"), 'text', value.directory || '', { maxLength: 8192 });
    const actions = document.createElement('div'); actions.className = 'form-actions';
    const browse = document.createElement('button'); browse.type = 'button'; browse.textContent = __sahmT("استعراض المجلد…");
    browse.onclick = async () => { try { const selected = await window.sahm.chooseServerRuleDirectory(); if (selected) path.value = selected; } catch (failure) { error.hidden = false; error.textContent = sahmI18n.formatMessage(failure.message); } };
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = __sahmT("إزالة القاعدة");
    remove.onclick = () => { root.remove(); empty(); saved.textContent = ''; };
    actions.append(browse, remove); root.append(actions); rows.append(root); empty();
  }
  function values() {
    return [...rows.children].map(root => {
      const field = name => root.querySelector(`[data-rule-field="${name}"]`).value;
      return { host: field('host').trim(), port: field('port') === '' ? null : Number(field('port')), connections: Number(field('connections')), fileConnections: Number(field('fileConnections')), speedLimit: Number(field('speedLimit')) * 1024, directory: field('directory').trim() || null, category: field('category').trim() };
    });
  }
  add.onclick = () => { row(); rows.lastElementChild.querySelector('input').focus(); saved.textContent = ''; };
  form.onsubmit = async event => {
    event.preventDefault(); error.hidden = true; saved.textContent = '';
    const data = values(); fields.disabled = true; empty();
    try { const checked = await window.sahm.saveServerRules(data); rows.replaceChildren(); for (const rule of checked) row(rule); saved.textContent = __sahmT("حُفظت قواعد النطاقات."); }
    catch (failure) { error.hidden = false; error.textContent = sahmI18n.formatMessage(failure.message); }
    finally { fields.disabled = false; empty(); }
  };
  window.sahmServerRules = {
    captureDraft: () => rows.children.length,
    restoreDraft(count) {
      const wanted = Math.min(Math.max(Number(count) || 0, 0), 100);
      while (rows.children.length > wanted) rows.lastElementChild.remove();
      while (rows.children.length < wanted) row();
      empty();
    },
    async load() {
    fields.disabled = true; empty(); error.hidden = true; saved.textContent = '';
    try { const rules = await window.sahm.serverRules(); rows.replaceChildren(); for (const value of rules) row(value); fields.disabled = false; }
    catch (failure) { error.hidden = false; error.textContent = sahmI18n.formatMessage(failure.message); }
    empty();
  } };
})();

