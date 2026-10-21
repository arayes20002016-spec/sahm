import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadManager } from '../src/manager.mjs';

const video = 'https://www.youtube.com/watch?v=BaW_jenozKc';
async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('media enqueue saves and acknowledges without inspecting or waiting for the worker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-manager-'));
  const media = { inspect: async () => { throw new Error('Must not inspect while enqueuing'); }, download: async (_url, path, { signal }) => {
    if (signal.aborted) throw signal.reason;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const manager = await new DownloadManager(directory, join(directory, 'files'), { mediaService: media }).init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await manager.addMedia({ url: video, title: 'Video', quality: '720', externalId: 'media-one' });
  assert.equal(job.kind, 'media'); assert.equal(job.mediaQuality, '720');
  assert.equal((await manager.addMedia({ url: video, externalId: 'media-one' })).id, job.id);
  const saved = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8'));
  assert.equal(saved.length, 1); assert.equal(saved[0].kind, 'media');
  await manager.action(job.id, 'pause');
  assert.equal(manager.list()[0].status, 'paused');
  assert.equal(manager.list()[0].needsRecapture, false);
});

test('media job completes with the actual extension and byte count from the worker', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-complete-'));
  let quality;
  const manager = await new DownloadManager(directory, directory, { mediaService: { download: async (_url, path, options) => { quality = options.quality; options.onProgress({ received: 4, total: 5 }); return { bytes: 5, name: 'Video.webm', path: path.replace(/\.mkv$/, '.webm') }; } } }).init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await manager.addMedia({ url: video, title: 'Video', quality: '480' });
  await waitFor(() => manager.list()[0].status === 'complete');
  const result = manager.list()[0];
  assert.equal(result.id, job.id); assert.equal(result.name, 'Video.webm'); assert.ok(result.path.endsWith('.webm'));
  assert.equal(result.received, 5); assert.equal(result.total, 5); assert.equal(quality, '480');
});

test('queued media survives restart and interrupted media restores paused without session recapture', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-restore-'));
  let manager = await new DownloadManager(directory, directory, { mediaService: {} }).init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const job = await manager.addMedia({ url: video, startAt: new Date(Date.now() + 3600000).toISOString() });
  await manager.close();
  let saved = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8'));
  saved[0].status = 'downloading'; await writeFile(join(directory, 'jobs.json'), JSON.stringify(saved));
  manager = await new DownloadManager(directory, directory, { mediaService: {} }).init();
  assert.equal(manager.list()[0].id, job.id); assert.equal(manager.list()[0].status, 'paused'); assert.equal(manager.list()[0].needsRecapture, false);
});

test('failed media persistence does not start a worker or leave an acknowledged job', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-no-save-'));
  let starts = 0;
  const manager = await new DownloadManager(directory, directory, { mediaService: { download: async () => { starts++; } } }).init();
  const save = manager.save;
  t.after(async () => { manager.save = save; await manager.close(); await rm(directory, { recursive: true, force: true }); });
  manager.save = async () => { manager.pump(); throw new Error('disk full'); };
  await assert.rejects(manager.addMedia({ url: video }), /disk full/);
  assert.equal(starts, 0); assert.equal(manager.list().length, 0);
});

test('media format and audio selection survive restart, reach the worker and retain defaults for older jobs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-choices-'));
  let observed;
  let manager = await new DownloadManager(directory, directory, { mediaService: {} }).init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const audioTrack = 'a-' + '1'.repeat(24);
  const job = await manager.addMedia({ url: video, container: 'mp4', audioTrack, quality: '360', startAt: new Date(Date.now() + 3600000).toISOString() });
  assert.ok(job.path.endsWith('.mp4')); await manager.close();
  const saved = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8'));
  saved[0].status = 'paused'; saved[0].startAt = null; await writeFile(join(directory, 'jobs.json'), JSON.stringify(saved));
  manager = await new DownloadManager(directory, directory, { mediaService: { download: async (_url, path, options) => { observed = options; return { path, name: 'selected.mp4', bytes: 12 }; } } }).init();
  assert.equal(manager.list()[0].mediaAudioTrack, audioTrack);
  await manager.action(job.id, 'resume'); await waitFor(() => manager.list()[0].status === 'complete');
  assert.equal(observed.container, 'mp4'); assert.equal(observed.audioTrack, audioTrack); assert.equal(observed.quality, '360');
  await assert.rejects(manager.addMedia({ url: video, container: 'bad' }));
  assert.equal(manager.list().length, 1);
});

test('audio-only jobs persist MP3/M4A and selected track across restart and complete with their actual output name', async t => {
  for (const container of ['mp3', 'm4a']) {
    const directory = await mkdtemp(join(tmpdir(), 'sahm-audio-job-'));
    let observed, manager = await new DownloadManager(directory, directory, { mediaService: {} }).init();
    t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
    const audioTrack = 'a-' + '2'.repeat(24);
    const job = await manager.addMedia({ url: video, title: 'صوت.mp4', container, audioTrack, startAt: new Date(Date.now() + 3600000).toISOString() });
    assert.equal(job.name, 'صوت.' + container); await manager.close();
    manager = await new DownloadManager(directory, directory, { mediaService: { download: async (_url, path, options) => { observed = options; return { path, name: 'صوت.' + container, bytes: 123 }; } } }).init();
    await assert.rejects(manager.addMedia({ url: video, container, quality: '720' }), /دقة فيديو/);
    await manager.action(job.id, 'resume'); await waitFor(() => manager.list()[0].status === 'complete');
    assert.equal(observed.container, container); assert.equal(observed.audioTrack, audioTrack); assert.equal(observed.quality, 'best');
    assert.ok(manager.list()[0].path.endsWith('.' + container));
  }
});
