(() => {
  'use strict';
  const api = window.sahm;
  const fields = () => [...document.querySelectorAll('input:not([type=file]),textarea,select')];
  // DOM paths identify generated rows without storing user data in attributes.
  function path(node) {
    if (node.id) return '#' + CSS.escape(node.id);
    const parent = node.parentElement;
    return parent ? path(parent) + ' > :nth-child(' + ([...parent.children].indexOf(node) + 1) + ')' : 'html';
  }
  function capture() {
    return {
      ui: window.sahmUiState.capture(), dateTarget: window.sahmDates.captureDraft(),
      enterprise: window.sahmEnterprise.captureDraft(), rules: window.sahmServerRules.captureDraft(),
      columns: window.sahmTable.captureDraft(), media: window.sahmMediaAdd.captureDraft(),
      fields: fields().filter(node => node.id !== 'language').map(node => ({ path: path(node), value: node.value, checked: node.checked })),
      dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.id),
      focus: document.activeElement === document.body ? null : path(document.activeElement),
      scroll: [...document.querySelectorAll('[id]')].filter(node => node.scrollTop || node.scrollLeft).map(node => ({ id: node.id, top: node.scrollTop, left: node.scrollLeft }))
    };
  }
  let changing = false;
  api.onLanguageChanged(async () => {
    if (changing) return;
    changing = true;
    try { await api.saveUiDraft(capture()); api.reloadUi(); }
    catch (error) { changing = false; document.getElementById('notice-text').textContent = sahmI18n.formatMessage(error.message); document.getElementById('notice').hidden = false; }
  });
  window.sahmLocaleRestored = (async () => {
    await window.sahmLocaleReady;
    const draft = await api.takeUiDraft();
    if (!draft) return;
    try {
      await window.sahmUiState.restore(draft.ui);
      window.sahmDates.restoreDraft(draft.dateTarget);
      window.sahmEnterprise.restoreDraft(draft.enterprise);
      window.sahmServerRules.restoreDraft(draft.rules);
      await window.sahmTable.restoreDraft(draft.columns);
      const applyFields = () => {
        for (const field of draft.fields || []) {
          const node = document.querySelector(field.path);
          if (node?.matches('input:not([type=file]),textarea,select')) { node.value = field.value; node.checked = field.checked; }
        }
      };
      applyFields(); window.sahmMediaAdd.restoreDraft(draft.media); applyFields();
      for (const id of draft.dialogs || []) document.getElementById(id)?.showModal();
      // Recompute validation and dependent controls without saving any settings.
      for (const input of document.querySelectorAll('[data-value-type]')) input.dispatchEvent(new Event('input'));
      window.sahmEnterprise.refreshDraft();
      document.getElementById('url').dispatchEvent(new Event('input'));
      for (const id of ['network-mode','proxy-type','proxy-auth-scheme','proxy-current-account']) document.getElementById(id)?.dispatchEvent(new Event('change'));
      for (const value of draft.scroll || []) { const node = document.getElementById(value.id); if (node) { node.scrollTop = value.top; node.scrollLeft = value.left; } }
      if (draft.focus) document.querySelector(draft.focus)?.focus({ preventScroll: true });
    } catch { document.getElementById('notice-text').textContent = __sahmT('تعذّر استعادة بعض مسودات الحقول بعد تغيير اللغة.'); document.getElementById('notice').hidden = false; }
  })();
})();
