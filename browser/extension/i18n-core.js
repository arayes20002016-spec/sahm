(() => {
  'use strict';
  const messages = globalThis.sahmLocaleMessages || {};
  let language = 'ar', patterns;
  const direction = () => language === 'ar' ? 'rtl' : 'ltr';
  const locale = () => language === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-US-u-ca-gregory-nu-latn';
  const validLanguage = value => value === 'ar' || value === 'en';
  function t(key, values = []) {
    const source = String(key ?? '');
    const text = language === 'en' && Object.hasOwn(messages, source) ? messages[source] : source;
    return text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match);
  }
  function formatMessage(value) {
    if (typeof value !== 'string' || language === 'ar') return value;
    const text = value.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    if (Object.hasOwn(messages, text)) return messages[text];
    if (text.length > 32768) return text;
    if (!patterns) patterns = Object.keys(messages).filter(key => /\{\d+\}/.test(key)).sort((a, b) => b.length - a.length).map(key => {
      const indices = [], parts = key.split(/(\{\d+\})/);
      const pattern = parts.map(part => { const match = /^\{(\d+)\}$/.exec(part); if (match) { indices.push(Number(match[1])); return '([\\s\\S]*?)'; } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('');
      return { key, indices, regex: new RegExp('^' + pattern + '$') };
    });
    for (const item of patterns) {
      const match = item.regex.exec(text);
      if (!match) continue;
      const values = []; item.indices.forEach((index, position) => { values[index] = match[position + 1]; });
      return t(item.key, values);
    }
    return text;
  }
  const categories = new Set(['فيديو', 'صوت', 'أرشيف', 'مستندات', 'برامج', 'أخرى']);
  const categoryLabel = value => categories.has(value) ? t(value) : value;
  const queueLabel = queue => queue?.id === 'default' && queue.name === 'القائمة الرئيسية' ? t('القائمة الرئيسية') : queue?.name;
  const number = (value, options = {}) => new Intl.NumberFormat(locale(), { ...options, numberingSystem: 'latn' }).format(value);
  const date = (value, options = {}) => new Intl.DateTimeFormat(locale(), { ...options, calendar: 'gregory', numberingSystem: 'latn' }).format(value);
  function setLanguage(value) { if (!validLanguage(value)) throw new Error(t('إعداد اللغة غير صالح.')); language = value; }
  function applyDocument(root = globalThis.document) {
    if (!root) return;
    if (root.documentElement) {
      root.documentElement.lang = language; root.documentElement.dir = direction(); root.documentElement.dataset.sahmLanguage = language;
      root.documentElement.style.setProperty('--sahm-direction', direction());
    }
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'content']) {
      for (const node of root.querySelectorAll('[data-i18n-' + attribute + ']')) node.setAttribute(attribute, t(node.getAttribute('data-i18n-' + attribute)));
    }
    for (const node of root.querySelectorAll('[dir]')) node.dir = direction();
    // Chromium's native date editors otherwise choose regional digits independently.
    for (const node of root.querySelectorAll('input[type=date],input[type=time],input[type=datetime-local],input[type=number]')) node.lang = 'en-US';
  }
  function mediaLabel(value) {
    if (typeof value !== 'string' || language === 'ar') return value;
    if (Object.hasOwn(messages, value)) return t(value);
    const parts = value.split(' · '), code = parts[0];
    if (/^[a-zA-Z0-9_-]{1,32}$/.test(code)) {
      try { if (parts[1] && /[\u0600-\u06ff]/.test(parts[1])) parts[1] = new Intl.DisplayNames(['en'], { type: 'language' }).of(code.replace(/-orig$/, '').replaceAll('_', '-')); } catch { /* Preserve unknown source language identifiers. */ }
    }
    return parts.map(formatMessage).join(' · ');
  }
  globalThis.sahmI18n = Object.freeze({ t, formatMessage, number, date, locale, direction, validLanguage, setLanguage, applyDocument, mediaLabel, queueLabel, categoryLabel, getLanguage: () => language });
  globalThis.__sahmT = t;
  if (globalThis.document && (globalThis.sahm || globalThis.downloadWindow || (globalThis.chrome?.runtime?.getURL && location.href.startsWith(chrome.runtime.getURL(''))))) {
    const initial = globalThis.sahm?.initialLanguage || globalThis.downloadWindow?.initialLanguage;
    if (validLanguage(initial)) setLanguage(initial);
    document.documentElement.lang = language; document.documentElement.dir = direction(); document.documentElement.dataset.sahmLanguage = language;
    document.documentElement.style.setProperty('--sahm-direction', direction());
    document.addEventListener('DOMContentLoaded', () => applyDocument(), { once: true });
  }
})();
