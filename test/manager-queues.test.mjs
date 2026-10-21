import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DownloadManager } from '../src/manager.mjs';
import { DEFAULT_QUEUE_ID } from '../src/queues.mjs';

const video = 'https://www.youtube.com/watch?v=BaW_jenozKc';
const future = () => new Date(Date.now() + 3600000).toISOString();
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for queue transition');
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-manager-queues-'));
  const starts = [];
  const transfers = new Map();
  const media = {
    download: async (_url, path, { signal }) => {
      signal.throwIfAborted();
      const name = basename(path, '.mkv');
      starts.push(name);
      return new Promise((resolve, reject) => {
        const abort = () => { transfers.delete(name); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        transfers.set(name, () => {
          transfers.delete(name); signal.removeEventListener('abort', abort);
          resolve({ path, name: basename(path), bytes: 5 });
        });
      });
    }
  };
  const manager = await new DownloadManager(directory, join(directory, 'files'), { mediaService: media }).init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, media, starts, transfers };
}

async function create(manager, name, parallel = 2) {
  return (await manager.queueAction('create', { name, parallel })).queue;
}

test('two queues respect their own parallel caps and the global cap', async t => {
  const { manager, starts, transfers } = await fixture(t);
  manager.stopped = true;
  manager.parallel = 3;
  const a = await create(manager, 'A', 1), b = await create(manager, 'B', 2);
  for (const [queue, titles] of [[a, ['A1', 'A2']], [b, ['B1', 'B2', 'B3']]]) {
    for (const title of titles) await manager.addMedia({ url: video, title, queueId: queue.id });
  }
  manager.stopped = false; manager.pump();
  await waitFor(() => starts.length === 3);
  assert.deepEqual(starts.slice().sort(), ['A1', 'B1', 'B2']);
  assert.equal(manager.active.size, 3);
  const queues = manager.queues();
  assert.equal(queues.find(queue => queue.id === a.id).active, 1);
  assert.equal(queues.find(queue => queue.id === b.id).active, 2);
  transfers.get('A1')();
  await waitFor(() => starts.includes('A2'));
  assert.equal(manager.active.size, 3);
  transfers.get('B1')();
  await waitFor(() => starts.includes('B3'));
  assert.equal(manager.active.size, 3);
});

test('round robin shares one global slot fairly while keeping each queue FIFO', async t => {
  const { manager, starts, transfers } = await fixture(t);
  manager.stopped = true;
  manager.parallel = 1;
  const a = await create(manager, 'A'), b = await create(manager, 'B');
  for (const [queue, titles] of [[a, ['A1', 'A2', 'A3']], [b, ['B1', 'B2', 'B3']]]) {
    for (const title of titles) await manager.addMedia({ url: video, title, queueId: queue.id });
  }
  manager.stopped = false; manager.pump();
  for (let index = 0; index < 6; index++) {
    await waitFor(() => starts.length > index);
    transfers.get(starts[index])();
  }
  await waitFor(() => manager.list().every(job => job.status === 'complete'));
  assert.deepEqual(starts, ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
});

test('closing and reopening a queue resumes held work while preserving a manual pause', async t => {
  const { manager, starts } = await fixture(t);
  const queue = await create(manager, 'Pauseable', 2);
  const held = await manager.addMedia({ url: video, title: 'Held', queueId: queue.id });
  const manual = await manager.addMedia({ url: video, title: 'Manual', queueId: queue.id });
  await waitFor(() => starts.length === 2);
  await manager.action(manual.id, 'pause');
  await manager.queueAction('update', { id: queue.id, settings: { enabled: false } });
  await waitFor(() => manager.active.size === 0);
  const paused = manager.list();
  assert.equal(paused.find(job => job.id === held.id).queueHeld, true);
  assert.equal(paused.find(job => job.id === held.id).status, 'paused');
  assert.equal(paused.find(job => job.id === manual.id).queueHeld, false);
  await manager.queueAction('update', { id: queue.id, settings: { enabled: true } });
  await waitFor(() => starts.filter(name => name === 'Held').length === 2);
  assert.equal(starts.filter(name => name === 'Manual').length, 1);
  assert.equal(manager.list().find(job => job.id === manual.id).status, 'paused');
});

test('a schedule closing holds active work and reopening its time window releases it', async t => {
  const { manager, starts } = await fixture(t);
  const queue = await create(manager, 'Window');
  const job = await manager.addMedia({ url: video, title: 'Window job', queueId: queue.id });
  await waitFor(() => starts.length === 1);
  const time = offset => {
    const minute = (new Date().getHours() * 60 + new Date().getMinutes() + offset + 1440) % 1440;
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  };
  await manager.queueAction('update', { id: queue.id, settings: { schedule: { start: time(60), stop: time(120), days: [0, 1, 2, 3, 4, 5, 6] } } });
  await waitFor(() => manager.active.size === 0);
  assert.equal(manager.list().find(value => value.id === job.id).queueHeld, true);
  assert.equal(manager.queues().find(value => value.id === queue.id).open, false);
  await manager.queueAction('update', { id: queue.id, settings: { schedule: { start: time(-60), stop: time(60), days: [0, 1, 2, 3, 4, 5, 6] } } });
  await waitFor(() => starts.length === 2);
  assert.equal(manager.list().find(value => value.id === job.id).queueHeld, false);
});

test('a manual pause clears an existing queue hold and survives later reopening', async t => {
  const { manager, starts } = await fixture(t);
  const queue = await create(manager, 'Held then manually paused');
  const job = await manager.addMedia({ url: video, title: 'Stay paused', queueId: queue.id });
  await waitFor(() => starts.length === 1);
  await manager.queueAction('update', { id: queue.id, settings: { enabled: false } });
  await waitFor(() => manager.active.size === 0);
  assert.equal(manager.list().find(value => value.id === job.id).queueHeld, true);
  await manager.action(job.id, 'pause');
  await manager.queueAction('update', { id: queue.id, settings: { enabled: true } });
  assert.equal(manager.list().find(value => value.id === job.id).status, 'paused');
  assert.equal(manager.list().find(value => value.id === job.id).queueHeld, false);
  assert.equal(starts.length, 1);
});

test('queue settings and held jobs survive restart and resume only when the queue reopens', async t => {
  const { directory, manager, media, starts } = await fixture(t);
  const queue = await create(manager, 'Restart held queue', 1);
  const job = await manager.addMedia({ url: video, title: 'Restart held', queueId: queue.id });
  await waitFor(() => starts.length === 1);
  await manager.queueAction('update', { id: queue.id, settings: { enabled: false } });
  await waitFor(() => manager.active.size === 0);
  await manager.close();
  const restored = await new DownloadManager(directory, directory, { mediaService: media }).init();
  try {
    const held = restored.list().find(value => value.id === job.id);
    assert.equal(held.status, 'paused'); assert.equal(held.queueHeld, true);
    assert.equal(restored.queues().find(value => value.id === queue.id).enabled, false);
    restored.pump();
    assert.equal(restored.active.size, 0);
    await restored.queueAction('update', { id: queue.id, settings: { enabled: true } });
    await waitFor(() => starts.length === 2);
    assert.equal(restored.list().find(value => value.id === job.id).queueHeld, false);
  } finally { await restored.close(); }
});

test('active downloads cannot be reassigned or reordered', async t => {
  const { manager, starts } = await fixture(t);
  const queue = await create(manager, 'Active');
  const job = await manager.addMedia({ url: video, title: 'Active job', queueId: queue.id });
  await waitFor(() => starts.length === 1);
  await assert.rejects(manager.queueAction('assign', { ids: [job.id], queueId: DEFAULT_QUEUE_ID }), /أوقف/);
  await assert.rejects(manager.queueAction('reorder', { id: job.id, direction: 'down' }), /أوقف/);
  assert.equal(manager.list().find(value => value.id === job.id).queueId, queue.id);
});

test('queue assignment and reordering persist without losing jobs and reject unsafe targets', async t => {
  const { directory, manager } = await fixture(t);
  const queue = await create(manager, 'Ordered');
  const jobs = [];
  for (const name of ['first', 'second', 'third']) jobs.push(await manager.add({ url: `https://example.com/${name}.zip`, startAt: future() }));
  await manager.queueAction('assign', { ids: jobs.map(job => job.id), queueId: queue.id });
  await manager.queueAction('reorder', { id: jobs[2].id, direction: 'up' });
  const saved = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8'));
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.slice().sort((a, b) => a.queuePosition - b.queuePosition).map(job => job.id), [jobs[0].id, jobs[2].id, jobs[1].id]);
  const restored = await new DownloadManager(directory, directory, { mediaService: {} }).init();
  try {
    assert.equal(restored.queues().find(value => value.id === queue.id).count, 3);
    assert.deepEqual(restored.list(), manager.list());
  } finally { await restored.close(); }
  await assert.rejects(manager.queueAction('remove', { id: queue.id }), /انقل/);
  await assert.rejects(manager.queueAction('assign', { ids: [], queueId: queue.id }));
  await assert.rejects(manager.queueAction('assign', { ids: ['missing'], queueId: queue.id }));
  await assert.rejects(manager.queueAction('assign', { ids: [jobs[0].id], queueId: 'missing' }));
  await assert.rejects(manager.queueAction('reorder', { id: jobs[0].id, direction: 'sideways' }));
  await manager.queueAction('assign', { ids: jobs.map(job => job.id), queueId: DEFAULT_QUEUE_ID });
  await manager.queueAction('remove', { id: queue.id });
  assert.equal(manager.list().length, 3);
  assert.ok(manager.list().every(job => job.queueId === DEFAULT_QUEUE_ID));
});

test('a failed reorder restores live positions and the previously saved order', async t => {
  const { directory, manager } = await fixture(t);
  const first = await manager.add({ url: 'https://example.com/first.zip', startAt: future() });
  const second = await manager.add({ url: 'https://example.com/second.zip', startAt: future() });
  const before = manager.list();
  const saved = await readFile(join(directory, 'jobs.json'), 'utf8');
  const save = manager.save;
  manager.save = async () => { throw new Error('simulated full disk'); };
  try { await assert.rejects(manager.queueAction('reorder', { id: second.id, direction: 'up' }), /full disk/); }
  finally { manager.save = save; }
  assert.deepEqual(manager.list(), before);
  assert.equal(await readFile(join(directory, 'jobs.json'), 'utf8'), saved);
  assert.ok(manager.list().find(job => job.id === first.id).queuePosition < manager.list().find(job => job.id === second.id).queuePosition);
});

test('removing held work while its queue reopens cannot restart an orphaned transfer', async t => {
  const { manager, media } = await fixture(t);
  const aborted = deferred(), release = deferred();
  let attempts = 0;
  media.download = async (_url, _path, { signal }) => {
    const attempt = ++attempts;
    return new Promise((_, reject) => {
      const abort = () => {
        if (attempt === 1) { aborted.resolve(); release.promise.then(() => reject(signal.reason)); }
        else reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const queue = await create(manager, 'Remove while reopening');
  const job = await manager.addMedia({ url: video, title: 'Remove held', queueId: queue.id });
  await waitFor(() => attempts === 1);
  await manager.queueAction('update', { id: queue.id, settings: { enabled: false } });
  await aborted.promise;
  const removing = manager.action(job.id, 'remove');
  await manager.queueAction('update', { id: queue.id, settings: { enabled: true } });
  release.resolve();
  await removing;
  assert.equal(manager.list().length, 0);
  assert.equal(attempts, 1, 'explicit removal must cancel automatic queue reopening for that job');
  assert.equal(manager.active.has(job.id), false, 'removed work must not survive in the active map');
});

test('legacy jobs migrate to the default queue with their original FIFO priority', async t => {
  const { directory, manager } = await fixture(t);
  await manager.close();
  const jobs = ['newest', 'middle', 'oldest'].map(id => ({ id, url: `https://example.com/${id}`, path: join(directory, id), name: id, status: 'queued', startAt: future() }));
  await writeFile(join(directory, 'jobs.json'), JSON.stringify(jobs));
  const restored = await new DownloadManager(directory, directory, { mediaService: {} }).init();
  try {
    assert.ok(restored.list().every(job => job.queueId === DEFAULT_QUEUE_ID));
    assert.deepEqual(restored.list().sort((a, b) => a.queuePosition - b.queuePosition).map(job => job.id), ['oldest', 'middle', 'newest']);
  } finally { await restored.close(); }
});

test('removing a queue concurrently with assignment cannot leave an orphaned job', async t => {
  const { manager } = await fixture(t);
  const queue = await create(manager, 'Concurrent removal');
  const job = await manager.add({ url: 'https://example.com/job.zip', startAt: future() });
  const entered = deferred(), release = deferred();
  const remove = manager.queueStore.remove.bind(manager.queueStore);
  manager.queueStore.remove = async id => { entered.resolve(); await release.promise; return remove(id); };
  const removing = manager.queueAction('remove', { id: queue.id });
  await entered.promise;
  const assigning = manager.queueAction('assign', { ids: [job.id], queueId: queue.id });
  const finished = Promise.allSettled([removing, assigning]);
  await nextTurn(); release.resolve();
  await finished;
  assert.equal(manager.list().length, 1);
  assert.ok(manager.list().every(value => manager.queueStore.get(value.queueId)), 'every job must retain an existing queue after competing operations');
});

test('removing a queue concurrently with enqueue cannot acknowledge a job in a missing queue', async t => {
  const { manager } = await fixture(t);
  const queue = await create(manager, 'Concurrent enqueue');
  const entered = deferred(), release = deferred();
  const remove = manager.queueStore.remove.bind(manager.queueStore);
  manager.queueStore.remove = async id => { entered.resolve(); await release.promise; return remove(id); };
  const removing = manager.queueAction('remove', { id: queue.id });
  await entered.promise;
  const adding = manager.addMedia({ url: video, title: 'Concurrent job', startAt: future(), queueId: queue.id });
  const finished = Promise.allSettled([removing, adding]);
  await nextTurn(); release.resolve();
  const results = await finished;
  assert.ok(results.some(value => value.status === 'rejected'), 'a conflicting operation must fail before acknowledging an invalid state');
  assert.ok(manager.list().every(value => manager.queueStore.get(value.queueId)), 'accepted jobs must reference a queue that still exists');
});

test('failed assignment rollback cannot undo a later successful concurrent assignment', async t => {
  const { directory, manager } = await fixture(t);
  const a = await create(manager, 'A'), b = await create(manager, 'B');
  const job = await manager.add({ url: 'https://example.com/job.zip', startAt: future() });
  const entered = deferred(), release = deferred();
  const save = manager.save.bind(manager);
  let calls = 0;
  manager.save = async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error('simulated disk failure'); }
    return save();
  };
  const failing = manager.queueAction('assign', { ids: [job.id], queueId: a.id });
  await entered.promise;
  const succeeding = manager.queueAction('assign', { ids: [job.id], queueId: b.id });
  const finished = Promise.allSettled([failing, succeeding]);
  await nextTurn(); release.resolve();
  const results = await finished;
  manager.save = save;
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(manager.list().find(value => value.id === job.id).queueId, b.id);
  assert.equal(JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8')).find(value => value.id === job.id).queueId, b.id);
});
