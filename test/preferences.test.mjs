import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Preferences } from '../src/preferences.mjs';
import { normalizeNetworkConfig } from '../src/network.mjs';
import { normalizeScannerConfig } from '../src/file-scanner.mjs';
import { normalizeTableLayout } from '../src/table-layout.mjs';

test('preferences serialize concurrent updates and survive reload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-prefs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = await new Preferences(directory, directory).init();
  await Promise.all([prefs.update({ theme: 'dark' }), prefs.update({ speedLimit: 128000 }), prefs.update({ parallel: 3 })]);
  const restored = await new Preferences(directory, directory).init();
  assert.deepEqual(restored.snapshot(), { language: 'ar', theme: 'dark', speedLimit: 128000, parallel: 3, downloadDirectory: directory, captureEnabled: false, sessionCaptureEnabled: false, postCaptureEnabled: false, clipboardMonitorEnabled: false, startWithWindows: false, showDownloadWindows: true, network: normalizeNetworkConfig(), downloadRules: [], serverRules: [], scanner: normalizeScannerConfig(), tableLayout: normalizeTableLayout() });
  await assert.rejects(prefs.update({ theme: 'invalid' }), /غير صالح/);
  await assert.rejects(prefs.update({ speedLimit: -1 }), /غير صالح/);
  await Promise.all([prefs.update({ sessionCaptureEnabled: true }), prefs.update({ postCaptureEnabled: true }), prefs.update({ clipboardMonitorEnabled: true })]);
  const approved = await new Preferences(directory, directory).init();
  assert.equal(approved.snapshot().sessionCaptureEnabled, true);
  assert.equal(approved.snapshot().postCaptureEnabled, true);
  assert.equal(approved.snapshot().clipboardMonitorEnabled, true);
  await assert.rejects(prefs.update({ postCaptureEnabled: 'true' }), /غير صالح/);
  await prefs.update({ showDownloadWindows: false });
  assert.equal((await new Preferences(directory, directory).init()).snapshot().showDownloadWindows, false);
  await assert.rejects(prefs.update({ showDownloadWindows: 'false' }), /غير صالح/);
});

test('preferences save column order, widths, visibility and sort independently of other settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-column-prefs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = await new Preferences(directory, directory).init();
  const tableLayout = normalizeTableLayout();
  const url = tableLayout.columns.find(column => column.id === 'url');
  url.visible = true; url.width = 430;
  tableLayout.columns = [url, ...tableLayout.columns.filter(column => column !== url)];
  tableLayout.columns.find(column => column.id === 'speed').visible = false;
  tableLayout.sort = { key: 'url', direction: 'asc' };
  await Promise.all([prefs.update({ tableLayout }), prefs.update({ theme: 'dark' })]);
  url.width = 700;
  const saved = (await new Preferences(directory, directory).init()).snapshot();
  assert.equal(saved.tableLayout.columns[0].id, 'url');
  assert.equal(saved.tableLayout.columns[0].width, 430);
  assert.equal(saved.tableLayout.columns.find(column => column.id === 'speed').visible, false);
  assert.deepEqual(saved.tableLayout.sort, { key: 'url', direction: 'asc' });
  assert.equal(saved.theme, 'dark');
  await assert.rejects(prefs.update({ tableLayout: { columns: [{ id: 'name', visible: false }] } }), /اسم الملف/);
  assert.deepEqual(prefs.snapshot().tableLayout, saved.tableLayout);
});

test('preferences persist normalized download rules and opt-in scanner configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-rules-prefs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = await new Preferences(directory, directory).init();
  const rules = [{ name: 'نسخ المصدر', extensions: '.ZIP,tar.gz', directory }];
  const scanner = { enabled: true, mode: 'custom', executable: process.execPath, args: ['--file={file}'], timeoutMs: 5000 };
  await Promise.all([prefs.update({ downloadRules: rules }), prefs.update({ scanner })]);
  rules[0].name = 'changed by caller'; scanner.args.push('changed');
  const restored = (await new Preferences(directory, directory).init()).snapshot();
  assert.deepEqual(restored.downloadRules, [{ name: 'نسخ المصدر', extensions: ['zip', 'tar.gz'], directory }]);
  assert.deepEqual(restored.scanner.args, ['--file={file}']); assert.equal(restored.scanner.enabled, true);
  await assert.rejects(prefs.update({ downloadRules: [{ name: 'bad', extensions: ['*.exe'] }] }), /الامتداد/);
  await assert.rejects(prefs.update({ scanner: { enabled: true, mode: 'custom', executable: process.execPath, args: ['--no-target'] } }), /file/);
  assert.equal(prefs.snapshot().downloadRules[0].name, 'نسخ المصدر');
});
