(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  const pad = value => String(value).padStart(2, '0');
  const digits = value => value.replace(/[٠-٩۰-۹]/g, character => String(character.charCodeAt(0) - (character <= '٩' ? 1632 : 1776)));
  function valid(value, type) {
    if (!value) return true;
    if (type === 'time') return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4)) && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
  }
  const dialog = make('dialog'); dialog.id = 'date-picker-dialog'; dialog.setAttribute('aria-labelledby', 'date-picker-title');
  const form = make('form'); const heading = make('div', '', 'dialog-heading'), title = make('h2', __sahmT('اختيار الموعد')); title.id = 'date-picker-title'; heading.append(title);
  const body = make('div', '', 'dialog-body'), dateFields = make('div', '', 'date-picker-fields'), timeFields = make('div', '', 'date-picker-fields');
  const controls = {};
  for (const [key, label, minimum, maximum] of [['year','السنة',1,9999],['month','الشهر',1,12],['day','اليوم',1,31],['hour','الساعة',0,23],['minute','الدقيقة',0,59]]) {
    const node = make('input'); node.type = 'number'; node.min = minimum; node.max = maximum; node.required = true; node.id = 'date-picker-' + key; node.lang = 'en-US';
    const field = make('label', __sahmT(label)); field.append(node); (['hour','minute'].includes(key) ? timeFields : dateFields).append(field); controls[key] = node;
  }
  const error = make('p', '', 'inline-error'); error.id = 'date-picker-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const footer = make('div', '', 'dialog-footer'), accept = make('button', __sahmT('استخدام الموعد'), 'primary'), cancel = make('button', __sahmT('إلغاء'));
  accept.type = 'submit'; cancel.type = 'button'; cancel.onclick = () => dialog.close(); footer.append(accept, cancel); body.append(dateFields, timeFields, error); form.append(heading, body, footer); dialog.append(form); document.body.append(dialog);
  let target;
  function open(input) {
    target = input; error.hidden = true; const type = input.dataset.valueType;
    const date = valid(input.value, type) && input.value ? new Date(type === 'time' ? '2000-01-01T' + input.value : input.value) : new Date();
    const values = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() };
    dateFields.hidden = type === 'time';
    for (const [key, control] of Object.entries(controls)) { control.value = values[key]; control.disabled = type === 'time' && ['year','month','day'].includes(key); }
    dialog.showModal(); controls[type === 'time' ? 'hour' : 'year'].focus();
  }
  form.onsubmit = event => {
    event.preventDefault(); if (!target) return;
    const value = String(controls.year.value).padStart(4, '0') + '-' + pad(controls.month.value) + '-' + pad(controls.day.value) + 'T' + pad(controls.hour.value) + ':' + pad(controls.minute.value);
    const text = target.dataset.valueType === 'time' ? value.slice(-5) : value;
    if (!valid(text, target.dataset.valueType)) { error.textContent = __sahmT('أدخل تاريخًا ووقتًا صحيحين.'); error.hidden = false; return; }
    target.value = text; target.setCustomValidity(''); target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true })); dialog.close(); target.focus();
  };
  for (const input of document.querySelectorAll('[data-value-type]')) {
    input.pattern = input.dataset.valueType === 'time' ? '([01][0-9]|2[0-3]):[0-5][0-9]' : '[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]';
    input.addEventListener('input', () => { input.value = digits(input.value); input.setCustomValidity(valid(input.value, input.dataset.valueType) ? '' : __sahmT(input.dataset.valueType === 'time' ? 'أدخل وقتًا صحيحًا بصيغة HH:mm.' : 'أدخل تاريخًا ووقتًا صحيحين.')); });
    const wrapper = make('span', '', 'date-value-control'), button = make('button'); button.type = 'button'; button.setAttribute('aria-label', __sahmT('اختيار الموعد')); button.title = __sahmT('اختيار الموعد');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS(svg.namespaceURI, 'use'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-clock'); svg.append(use); button.append(svg);
    input.replaceWith(wrapper); wrapper.append(input, button); button.onclick = () => open(input);
  }
  window.sahmDates = { captureDraft: () => target?.id, restoreDraft: id => { target = id ? byId(id) : null; dateFields.hidden = target?.dataset.valueType === 'time'; } };
})();
