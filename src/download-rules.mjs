import { isAbsolute, normalize } from 'node:path';

const limits = { rules: 50, extensions: 100, name: 80, text: 24000, directory: 1024 };

function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'extensions', 'directory'].includes(key))) throw new Error('قاعدة التصنيف غير صالحة.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > limits.name || /[\x00-\x1f\x7f|]/.test(name)) throw new Error('اكتب اسم تصنيف من 1 إلى 80 حرفًا، دون فواصل عمودية.');
  const values = typeof input.extensions === 'string' ? input.extensions.split(/[,،\s]+/).filter(Boolean) : input.extensions;
  if (!Array.isArray(values) || !values.length || values.length > limits.extensions) throw new Error('اكتب من 1 إلى 100 امتداد مفصول بفاصلة، مثل zip,rar.');
  const extensions = [];
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('امتداد التصنيف غير صالح.');
    const extension = value.trim().replace(/^\./, '').toLowerCase();
    if (extension.length > 64 || !/^[a-z0-9][a-z0-9+_-]*(?:\.[a-z0-9][a-z0-9+_-]*){0,2}$/.test(extension)) throw new Error('الامتداد غير صالح؛ استخدم حروفًا وأرقامًا، مثل zip أو tar.gz.');
    if (!extensions.includes(extension)) extensions.push(extension);
  }
  const directory = input.directory === undefined ? '' : typeof input.directory === 'string' ? input.directory.trim() : null;
  if (directory === null || directory.length > limits.directory || /[\x00-\x1f\x7f|<>"?*]/.test(directory) || (directory && !isAbsolute(directory))) throw new Error('مجلد التصنيف يجب أن يكون مسارًا مطلقًا، أو اتركه فارغًا لاستخدام مجلد التنزيل الحالي.');
  return { name, extensions, directory: directory ? normalize(directory) : '' };
}

export function normalizeDownloadRules(input) {
  if (!Array.isArray(input) || input.length > limits.rules) throw new Error('الحد الأقصى 50 قاعدة تصنيف.');
  const rules = input.map(normalizeRule);
  if (rules.reduce((length, rule) => length + rule.name.length + rule.extensions.join(',').length + rule.directory.length + 3, 0) > limits.text) throw new Error('نص قواعد التصنيف أطول من الحد المسموح.');
  return rules;
}

export function parseDownloadRules(text) {
  if (typeof text !== 'string' || text.length > limits.text) throw new Error('نص قواعد التصنيف أطول من الحد المسموح.');
  const rules = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 2 || parts.length > 3) throw new Error(`السطر ${index + 1}: استخدم اسم التصنيف|zip,rar|مجلد اختياري.`);
    try { rules.push(normalizeRule({ name: parts[0], extensions: parts[1], directory: parts[2] || '' })); }
    catch (error) { throw new Error(`السطر ${index + 1}: ${error.message}`); }
    if (rules.length > limits.rules) throw new Error('الحد الأقصى 50 قاعدة تصنيف.');
  }
  return normalizeDownloadRules(rules);
}

export function formatDownloadRules(input) {
  return normalizeDownloadRules(input).map(rule => `${rule.name}|${rule.extensions.join(',')}|${rule.directory}`).join('\n');
}

export function defaultDownloadCategory(name) {
  if (/\.(mp4|mkv|webm|mov)$/i.test(name)) return 'فيديو';
  if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(name)) return 'صوت';
  if (/\.(zip|rar|7z|gz|tar)$/i.test(name)) return 'أرشيف';
  if (/\.(pdf|docx?|xlsx?|txt|epub)$/i.test(name)) return 'مستندات';
  if (/\.(exe|msi|msix)$/i.test(name)) return 'برامج';
  return 'أخرى';
}

export function resolveDownloadRule(filename, input = [], fallbackDirectory = null) {
  if (typeof filename !== 'string' || !filename || filename.length > 4096 || /[\0\r\n]/.test(filename)) throw new Error('اسم ملف التصنيف غير صالح.');
  const name = filename.toLowerCase();
  const rules = normalizeDownloadRules(input);
  const ruleIndex = rules.findIndex(rule => rule.extensions.some(extension => name.endsWith('.' + extension)));
  if (ruleIndex >= 0) return { category: rules[ruleIndex].name, directory: rules[ruleIndex].directory || fallbackDirectory, ruleIndex };
  return { category: defaultDownloadCategory(filename), directory: fallbackDirectory, ruleIndex: null };
}
