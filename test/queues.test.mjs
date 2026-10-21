import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUEUE_ID, QueueStore, queueIsOpen } from '../src/queues.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-queues-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await new QueueStore(directory).init() };
}

test('daily windows include the start, exclude the stop, and honor enabled days', () => {
  const queue = { enabled: true, schedule: { start: '09:15', stop: '17:30', days: [1] } };
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 19, 9, 14, 59)), false);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 19, 9, 15)), true);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 19, 17, 29, 59)), true);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 19, 17, 30)), false);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 20, 12)), false);
  assert.equal(queueIsOpen({ ...queue, enabled: false }, new Date(2026, 9, 19, 12)), false);
  assert.equal(queueIsOpen({ enabled: true, schedule: null }), true);
});

test('overnight windows use the preceding selected day after midnight, including the week boundary', () => {
  const queue = { enabled: true, schedule: { start: '22:00', stop: '06:00', days: [6] } };
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 17, 21, 59)), false);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 17, 22)), true);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 18, 0)), true);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 18, 5, 59, 59)), true);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 18, 6)), false);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 18, 23)), false);
  assert.equal(queueIsOpen(queue, new Date(2026, 9, 19, 2)), false);
});

test('queue changes serialize concurrent settings, persist, and return detached values', async t => {
  const { directory, store } = await fixture(t);
  assert.equal(store.get(DEFAULT_QUEUE_ID).parallel, 8);
  const created = await store.create({ name: ' فيديو ', parallel: 2 });
  assert.equal(created.name, 'فيديو');
  created.name = 'external mutation';
  assert.equal(store.get(created.id).name, 'فيديو');
  await Promise.all([
    store.update(created.id, { name: 'Films' }),
    store.update(created.id, { parallel: 4 }),
    store.update(created.id, { enabled: false }),
    store.update(created.id, { schedule: { start: '22:00', stop: '06:00', days: [6, 1, 6] } })
  ]);
  const restored = await new QueueStore(directory).init();
  assert.deepEqual(restored.list(), store.list());
  assert.deepEqual(restored.get(created.id), { id: created.id, name: 'Films', parallel: 4, enabled: false, schedule: { start: '22:00', stop: '06:00', days: [1, 6] }, completionAction: { type: 'none', delaySeconds: 30 } });
  const snapshot = restored.list(); snapshot[0].name = 'changed';
  assert.equal(restored.get(DEFAULT_QUEUE_ID).name, 'القائمة الرئيسية');
  await store.remove(created.id);
  assert.deepEqual((await new QueueStore(directory).init()).list().map(queue => queue.id), [DEFAULT_QUEUE_ID]);
});

test('old queue stores migrate safely and completion settings persist without countdown state', async t => {
  const { directory } = await fixture(t);
  const old = { id: 'default', name: 'Main', enabled: true, parallel: 4, schedule: null };
  await writeFile(join(directory, 'queues.json'), JSON.stringify({ version: 1, queues: [old] }));
  const migrated = await new QueueStore(directory).init();
  assert.deepEqual(migrated.get('default').completionAction, { type: 'none', delaySeconds: 30 });
  await migrated.update('default', { completionAction: { type: 'shutdown', delaySeconds: 120 } });
  const saved = JSON.parse(await readFile(join(directory, 'queues.json'), 'utf8'));
  assert.deepEqual(saved.queues[0].completionAction, { type: 'shutdown', delaySeconds: 120 });
  assert.deepEqual((await new QueueStore(directory).init()).list(), migrated.list());
  assert.equal(JSON.stringify(saved).includes('deadline'), false);
  const copy = migrated.list(); copy[0].completionAction.type = 'exit';
  assert.equal(migrated.get('default').completionAction.type, 'shutdown');
});

test('completion actions reject unknown settings and out of range delays', async t => {
  const { store } = await fixture(t);
  for (const completionAction of [null, [], 'shutdown', { type: 'reboot' }, { type: 'shutdown', delaySeconds: 0 }, { type: 'shutdown', delaySeconds: 29 }, { type: 'shutdown', delaySeconds: 1801 }, { type: 'shutdown', delaySeconds: 30.5 }, { type: 'shutdown', delaySeconds: '30' }, { type: 'shutdown', command: 'unsafe' }, { type: 'shutdown', deadline: 1 }]) {
    await assert.rejects(store.update('default', { completionAction }));
    assert.deepEqual(store.get('default').completionAction, { type: 'none', delaySeconds: 30 });
  }
  for (const type of ['none', 'notify', 'open-folder', 'exit', 'shutdown', 'sleep', 'hibernate']) {
    await store.update('default', { completionAction: { type } });
    assert.deepEqual(store.get('default').completionAction, { type, delaySeconds: 30 });
  }
  for (const type of ['none', 'notify', 'open-folder']) {
    await store.update('default', { completionAction: { type, delaySeconds: 0 } });
    assert.equal(store.get('default').completionAction.delaySeconds, 0);
  }
});

test('queue validation rejects duplicates, malformed limits and schedules, and removal of the default queue', async t => {
  const { store } = await fixture(t);
  const queue = await store.create({ name: 'Work', parallel: 2 });
  for (const input of [
    { name: '' }, { name: 'bad\nname' }, { name: 'x'.repeat(81) }, { name: ' work ' },
    { name: 'Other', parallel: 0 }, { name: 'Other', parallel: 9 }, { name: 'Other', parallel: 1.5 },
    { name: 'Other', enabled: 'true' }, { name: 'Other', unknown: true },
    ...[
      { start: '24:00', stop: '06:00', days: [1] }, { start: '22:00', stop: '06:60', days: [1] },
      { start: '22:00', stop: '22:00', days: [1] }, { start: '22:00', stop: '06:00', days: [] },
      { start: '22:00', stop: '06:00', days: [7] }, { start: '22:00', stop: '06:00', days: [-1] },
      { start: '22:00', stop: '06:00', days: ['1'] }, { start: '22:00', stop: '06:00', days: [1.5] }
    ].map(schedule => ({ name: 'Other', schedule }))
  ]) await assert.rejects(store.create(input));
  await assert.rejects(store.update(queue.id, { name: 'القائمة الرئيسية' }));
  await assert.rejects(store.update('missing', { enabled: false }));
  await assert.rejects(store.remove(DEFAULT_QUEUE_ID));
  await assert.rejects(store.remove('missing'));
  assert.equal(store.list().length, 2);
});

test('failed queue persistence leaves live and saved state intact and permits a later successful change', async t => {
  const { directory, store } = await fixture(t);
  const queue = await store.create({ name: 'Recoverable', parallel: 2 });
  const before = store.list();
  await mkdir(join(directory, 'queues.json.tmp'));
  await assert.rejects(store.update(queue.id, { name: 'Must not be visible', enabled: false }));
  assert.deepEqual(store.list(), before);
  assert.deepEqual((await new QueueStore(directory).init()).list(), before);
  const saved = JSON.parse(await readFile(join(directory, 'queues.json'), 'utf8'));
  assert.equal(saved.queues.find(value => value.id === queue.id).name, 'Recoverable');
  await rm(join(directory, 'queues.json.tmp'), { recursive: true });
  await store.update(queue.id, { parallel: 3 });
  assert.equal((await new QueueStore(directory).init()).get(queue.id).parallel, 3);
});

test('a failed completion setting save cannot arm a new system action or corrupt the saved action', async t => {
  const { directory, store } = await fixture(t);
  await store.update('default', { completionAction: { type: 'notify', delaySeconds: 0 } });
  await mkdir(join(directory, 'queues.json.tmp'));
  await assert.rejects(store.update('default', { completionAction: { type: 'shutdown', delaySeconds: 30 } }));
  assert.deepEqual(store.get('default').completionAction, { type: 'notify', delaySeconds: 0 });
  assert.deepEqual((await new QueueStore(directory).init()).get('default').completionAction, { type: 'notify', delaySeconds: 0 });
  await rm(join(directory, 'queues.json.tmp'), { recursive: true });
  await store.update('default', { completionAction: { type: 'open-folder', delaySeconds: 15 } });
  assert.deepEqual((await new QueueStore(directory).init()).get('default').completionAction, { type: 'open-folder', delaySeconds: 15 });
});
