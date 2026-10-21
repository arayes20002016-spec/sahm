import { downloadHttpUrl } from './request-context.mjs';

export function expandBatch(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 8192) throw new Error('أدخل نمط روابط صالحًا.');
  const matches = [...pattern.matchAll(/\[([0-9]+|[a-zA-Z]):([0-9]+|[a-zA-Z])\]/g)];
  if (matches.length !== 1) throw new Error('استخدم نطاقًا واحدًا مثل [001:020] أو [a:z].');
  const [token, left, right] = matches[0];
  const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
  const letters = /^[a-z]$/.test(left) && /^[a-z]$/.test(right) || /^[A-Z]$/.test(left) && /^[A-Z]$/.test(right);
  if (!numeric && !letters) throw new Error('يجب أن يكون طرفا النطاق أرقامًا أو حرفين بالحالة نفسها.');
  const start = numeric ? Number(left) : left.charCodeAt(0);
  const end = numeric ? Number(right) : right.charCodeAt(0);
  if (![start, end].every(Number.isSafeInteger) || Math.abs(end - start) >= 500) throw new Error('الحد الأقصى 500 رابط.');
  const width = numeric && (left.startsWith('0') || right.startsWith('0')) ? Math.max(left.length, right.length) : 0;
  const step = start <= end ? 1 : -1;
  return Array.from({ length: Math.abs(end - start) + 1 }, (_, index) => {
    const value = start + index * step;
    const replacement = numeric ? String(value).padStart(width, '0') : String.fromCharCode(value);
    return downloadHttpUrl(pattern.replace(token, replacement));
  });
}
