(() => {
  const byId = id => document.getElementById(id);
  const api = window.sahm || window.rafid;
  let definitions, normalize, layout, committed, draft;
  let callbacks = {}, revision = 0, pendingSaves = 0, saving = Promise.resolve(), dialogSaving = false;
  const ready = import('../src/table-layout.mjs').then(module => {
    definitions = module.COLUMN_DEFINITIONS;
    normalize = module.normalizeTableLayout;
    layout = normalize();
    committed = structuredClone(layout);
    return definitions;
  });

  function showError(error) {
    const message = sahmI18n.formatMessage(error.message) || __sahmT("تعذّر حفظ تخصيص الأعمدة. أعد المحاولة.");
    const target = byId('columns-dialog')?.open ? byId('columns-error') : byId('notice-text');
    if (target) { target.textContent = message; target.hidden = false; }
    if (target?.id === 'notice-text') byId('notice').hidden = false;
  }

  function updateSort() {
    for (const button of document.querySelectorAll('.download-table [data-sort]')) {
      const active = button.dataset.sort === layout.sort.key;
      button.classList.toggle('sorted', active);
      button.parentElement.setAttribute('aria-sort', active ? (layout.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    }
  }

  function apply() {
    if (!layout) return;
    const table = document.querySelector('.download-table');
    if (!table) return;
    for (const container of [table.querySelector('colgroup'), table.tHead?.rows[0], ...Array.from(byId('jobs')?.rows || [])]) {
      if (!container) continue;
      const cells = new Map(Array.from(container.children).filter(node => node.dataset.column).map(node => [node.dataset.column, node]));
      let position = container.children.length - cells.size;
      for (const column of layout.columns) {
        const cell = cells.get(column.id);
        if (!cell) continue;
        cell.hidden = !column.visible;
        cell.style.width = `${column.width}px`;
        // Leave existing nodes in place during progress updates and pointer resizing.
        if (container.children[position] !== cell) container.insertBefore(cell, container.children[position] || null);
        position++;
      }
    }
    const width = 36 + layout.columns.filter(column => column.visible).reduce((sum, column) => sum + column.width, 0);
    table.style.width = `${width}px`;
    table.style.minWidth = `${width}px`;
    updateSort();
    attachResizeHandles(table);
  }

  async function persist(next) {
    const normalized = normalize(next), attempt = ++revision;
    pendingSaves++;
    layout = normalized;
    apply();
    const task = saving.catch(() => {}).then(async () => {
      await api.preferences({ tableLayout: normalized });
      committed = structuredClone(normalized);
    });
    saving = task;
    try { await task; return true; }
    catch (error) {
      if (revision === attempt) {
        layout = structuredClone(committed);
        apply();
        callbacks.setSort?.(layout.sort);
        callbacks.render?.();
      }
      showError(error);
      return false;
    } finally { pendingSaves--; }
  }

  function resizeWidth(id, value) {
    const definition = definitions.find(column => column.id === id);
    const column = layout.columns.find(column => column.id === id);
    column.width = Math.min(definition.maxWidth, Math.max(definition.minWidth, Math.round(value)));
    apply();
  }

  function attachResizeHandles(table) {
    for (const heading of Array.from(table.tHead?.rows[0]?.cells || [])) {
      const definition = definitions.find(column => column.id === heading.dataset.column);
      if (!definition || heading.querySelector('[data-column-resize]')) continue;
      const handle = document.createElement('span');
      handle.className = 'column-resize-handle';
      handle.dataset.columnResize = definition.id;
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', __sahmT("تغيير عرض عمود {0}", [__sahmT(definition.label)]));
      handle.setAttribute('aria-valuemin', String(definition.minWidth));
      handle.setAttribute('aria-valuemax', String(definition.maxWidth));
      handle.title = __sahmT("اسحب لتغيير العرض، أو استخدم أسهم اليمين واليسار. Shift يغيّر العرض بمقدار 50 بكسل.");
      handle.onclick = event => event.stopPropagation();
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const startX = event.clientX, startWidth = layout.columns.find(column => column.id === definition.id).width;
        const direction = getComputedStyle(table).direction === 'rtl' ? -1 : 1;
        const move = pointer => resizeWidth(definition.id, startWidth + (pointer.clientX - startX) * direction);
        const finish = pointer => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', finish);
          handle.removeEventListener('pointercancel', finish);
          if (handle.hasPointerCapture(pointer.pointerId)) handle.releasePointerCapture(pointer.pointerId);
          void persist(layout);
        };
        handle.setPointerCapture(event.pointerId);
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
      };
      handle.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const width = layout.columns.find(column => column.id === definition.id).width;
        const rtl = getComputedStyle(table).direction === 'rtl';
        const expands = rtl ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
        const delta = (expands ? 1 : -1) * (event.shiftKey ? 50 : 10);
        resizeWidth(definition.id, event.key === 'Home' ? definition.minWidth : event.key === 'End' ? definition.maxWidth : width + delta);
        void persist(layout);
      };
      heading.append(handle);
    }
    for (const handle of table.querySelectorAll('[data-column-resize]')) {
      handle.setAttribute('aria-valuenow', String(layout.columns.find(column => column.id === handle.dataset.columnResize).width));
    }
  }

  function renderEditor() {
    const rows = draft.columns.map((column, index) => {
      const definition = definitions.find(value => value.id === column.id);
      const row = document.createElement('tr');
      row.dataset.columnSetting = column.id;
      const labelCell = document.createElement('td'), label = document.createElement('label'), check = document.createElement('input');
      label.className = 'check-label'; check.type = 'checkbox'; check.dataset.columnVisible = column.id;
      check.checked = column.visible; check.disabled = column.id === 'name';
      check.onchange = () => { column.visible = check.checked; };
      const name = document.createElement('span'); name.textContent = __sahmT(definition.label);
      label.append(check, name); labelCell.append(label);
      const widthCell = document.createElement('td'), width = document.createElement('input');
      width.type = 'number'; width.min = definition.minWidth; width.max = definition.maxWidth; width.step = 1; width.value = column.width;
      width.required = true; width.dataset.columnWidth = column.id;
      width.setAttribute('aria-label', __sahmT("عرض عمود {0} بالبكسل", [__sahmT(definition.label)]));
      width.oninput = () => { column.width = Number(width.value); };
      widthCell.append(width);
      const orderCell = document.createElement('td');
      for (const [action, label, offset] of [['up', __sahmT("لأعلى"), -1], ['down', __sahmT("لأسفل"), 1]]) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label; button.dataset.columnMove = action; button.dataset.columnId = column.id;
        button.setAttribute('aria-label', __sahmT("نقل عمود {0} {1}", [__sahmT(definition.label), label]));
        button.disabled = index + offset < 0 || index + offset >= draft.columns.length;
        button.onclick = () => {
          const next = index + offset;
          [draft.columns[index], draft.columns[next]] = [draft.columns[next], draft.columns[index]];
          renderEditor();
          const movedRow = Array.from(byId('column-settings').rows).find(value => value.dataset.columnSetting === column.id);
          const focus = Array.from(movedRow.querySelectorAll('button')).find(value => value.dataset.columnMove === action && !value.disabled) || movedRow.querySelector('input[type="number"]');
          focus.focus();
        };
        orderCell.append(button);
      }
      row.append(labelCell, widthCell, orderCell);
      return row;
    });
    byId('column-settings').replaceChildren(...rows);
  }

  ready.then(() => {
    const form = byId('columns-form');
    if (!form) return;
    byId('columns-reset').onclick = () => { if (!dialogSaving) { draft = normalize(); renderEditor(); byId('columns-error').hidden = true; } };
    form.onsubmit = async event => {
      event.preventDefault();
      if (dialogSaving) return;
      let next;
      try { next = normalize(draft); } catch (error) { showError(error); return; }
      dialogSaving = true;
      const controls = Array.from(form.querySelectorAll('input, button')).map(control => [control, control.disabled]);
      for (const [control] of controls) control.disabled = true;
      byId('columns-error').hidden = true;
      try {
        if (await persist(next)) {
          callbacks.setSort?.(layout.sort);
          callbacks.render?.();
          byId('columns-dialog').close();
        }
      } finally {
        dialogSaving = false;
        for (const [control, disabled] of controls) control.disabled = disabled;
      }
    };
  }).catch(showError);

  window.sahmTable = {
    ready,
    bind(value) { callbacks = value; },
    async load(value) {
      await ready;
      if (dialogSaving || pendingSaves) return;
      const next = normalize(value);
      const changedSort = !layout || next.sort.key !== layout.sort.key || next.sort.direction !== layout.sort.direction;
      layout = next;
      committed = structuredClone(next);
      apply();
      if (changedSort || !this.loaded) { callbacks.setSort?.(layout.sort); callbacks.render?.(); }
      this.loaded = true;
    },
    captureDraft: () => byId('columns-dialog').open && draft ? structuredClone(draft) : null,
    async restoreDraft(value) { if (value) { await ready; draft = structuredClone(value); renderEditor(); } },
    snapshot() { return layout ? structuredClone(layout) : null; },
    apply,
    onRendered: apply,
    async open() {
      await ready;
      draft = structuredClone(layout);
      renderEditor();
      byId('columns-error').hidden = true;
      byId('columns-dialog').showModal();
    },
    async rememberSort(key, direction) {
      await ready;
      try { return await persist({ columns: layout.columns, sort: { key, direction: direction === 1 ? 'asc' : direction === -1 ? 'desc' : direction } }); }
      catch (error) { showError(error); return false; }
    }
  };
})();

