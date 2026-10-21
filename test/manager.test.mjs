import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager, safeName, category } from '../src/manager.mjs';

test('queue schedule and pause survive restart, equal names have isolated paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rafid-manager-'));
  const manager = await new DownloadManager(join(dir, 'data'), join(dir, 'files')).init();
  let restored;
  try {
    const startAt = new Date(Date.now() + 3600000).toISOString();
    const a = await manager.add({ url: 'https://example.com/report.pdf', startAt });
    const b = await manager.add({ url: 'https://example.com/report.pdf', startAt });
    assert.notEqual(a.path, b.path);
    assert.equal(manager.active.size, 0);
    await manager.action(a.id, 'pause');
    await manager.close();
    restored = await new DownloadManager(join(dir, 'data'), join(dir, 'files')).init();
    assert.equal(restored.jobs.find(j => j.id === a.id).status, 'paused');
    assert.equal(restored.jobs.find(j => j.id === b.id).status, 'queued');
    assert.equal(restored.jobs[0].category, 'مستندات');
  } finally { await manager.close(); await restored?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Windows filenames and categories', () => {
  assert.ok(safeName('CON.txt').startsWith('download-'));
  assert.equal(safeName('x?.zip'), 'x_.zip');
  assert.equal(category('FILM.MP4'), 'فيديو');
});

test('browser capture identities are deduplicated across concurrent requests and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sahm-dedup-'));
  const manager = await new DownloadManager(dir, join(dir, 'files')).init();
  let restored;
  t.after(async () => { await manager.close(); await restored?.close(); await rm(dir, { recursive: true, force: true }); });
  const data = { url: 'https://example.com/a.zip', externalId: 'browser-session-123:download-1', startAt: new Date(Date.now() + 3600000).toISOString() };
  const [a, b] = await Promise.all([manager.add(data), manager.add(data)]);
  assert.equal(a.id, b.id); assert.equal(manager.jobs.length, 1);
  await manager.close();
  restored = await new DownloadManager(dir, join(dir, 'files')).init();
  assert.equal((await restored.add(data)).id, a.id);
  assert.equal(restored.jobs.length, 1);
});

test('failed persistence cannot acknowledge or start a browser capture', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sahm-failed-save-'));
  const manager = await new DownloadManager(dir, dir).init();
  const originalSave = manager.save;
  t.after(async () => { manager.save = originalSave; await manager.close(); await rm(dir, { recursive: true, force: true }); });
  manager.save = async () => { manager.pump(); throw new Error('disk full'); };
  await assert.rejects(manager.add({ url: 'https://example.com/a.zip', externalId: 'failed' }), /disk full/);
  assert.equal(manager.jobs.length, 0);
  assert.equal(manager.active.size, 0);
});
