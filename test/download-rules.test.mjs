import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { normalizeDownloadRules, parseDownloadRules, formatDownloadRules, defaultDownloadCategory, resolveDownloadRule } from '../src/download-rules.mjs';

test('custom extension rules use first-match priority, case-insensitive matching and optional absolute destinations', () => {
  const saved = resolve('fixtures', 'saved'), fallback = resolve('fixtures', 'downloads');
  const rules = parseDownloadRules(`نسخ المصدر|.ZIP,tar.gz|${saved}\nالضغط|zip,rar|`);
  assert.deepEqual(resolveDownloadRule('SOURCE.ZIP', rules, fallback), { category: 'نسخ المصدر', directory: saved, ruleIndex: 0 });
  assert.deepEqual(resolveDownloadRule('source.tar.gz', rules, fallback), { category: 'نسخ المصدر', directory: saved, ruleIndex: 0 });
  assert.deepEqual(resolveDownloadRule('other.RAR', rules, fallback), { category: 'الضغط', directory: fallback, ruleIndex: 1 });
  assert.deepEqual(resolveDownloadRule('archive.gz', rules, fallback), { category: 'أرشيف', directory: fallback, ruleIndex: null });
  assert.deepEqual(resolveDownloadRule('notazip', rules, fallback), { category: 'أخرى', directory: fallback, ruleIndex: null });
});

test('empty custom rules preserve the existing built-in categories exactly', () => {
  const samples = { 'film.mp4': 'فيديو', 'clip.MKV': 'فيديو', 'music.flac': 'صوت', 'archive.tar.gz': 'أرشيف', 'book.docx': 'مستندات', 'setup.msix': 'برامج', 'photo.png': 'أخرى' };
  for (const [name, category] of Object.entries(samples)) {
    assert.equal(defaultDownloadCategory(name), category);
    assert.equal(resolveDownloadRule(name).category, category);
  }
});

test('text rules round trip without mutating caller arrays and normalize extension punctuation', () => {
  const input = [{ name: ' صوت إضافي ', extensions: ['.OPUS', 'opus', 'aiff'], directory: '' }];
  const snapshot = structuredClone(input), normalized = normalizeDownloadRules(input);
  assert.deepEqual(normalized, [{ name: 'صوت إضافي', extensions: ['opus', 'aiff'], directory: '' }]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(parseDownloadRules(formatDownloadRules(input)), normalized);
  assert.deepEqual(parseDownloadRules('\nصوت|opus،aiff\n\n'), normalized.map(rule => ({ ...rule, name: 'صوت' })));
  assert.deepEqual(parseDownloadRules('  \r\n'), []);
});

test('invalid rules produce explicit errors including the source line, rather than accepting ambiguous destinations', () => {
  assert.throws(() => parseDownloadRules('جيد|zip|\nسيئ|*.exe|'), /السطر 2/);
  assert.throws(() => parseDownloadRules('اسم|zip|relative'), /مسارًا مطلقًا/);
  assert.throws(() => parseDownloadRules('اسم|zip|a|b'), /السطر 1/);
  assert.throws(() => parseDownloadRules('اسم||'), /امتداد/);
  assert.throws(() => normalizeDownloadRules([{ name: 'اسم', extensions: ['zip'], directory: null }]), /مجلد/);
  assert.throws(() => normalizeDownloadRules([{ name: 'اسم', extensions: ['zip'], enabled: true }]), /قاعدة/);
  assert.throws(() => normalizeDownloadRules(Array.from({ length: 51 }, () => ({ name: 'اسم', extensions: ['zip'] }))), /50/);
  assert.throws(() => resolveDownloadRule('bad\0name.zip', []), /اسم ملف/);
});
