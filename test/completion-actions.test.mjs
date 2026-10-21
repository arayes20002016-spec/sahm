import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionActions } from '../src/completion-actions.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const job = (id, status = 'queued', queueId = 'a') => ({ id, queueId, status });
function fixture(t, { type = 'notify', jobs = [job('1')], queues, execute } = {}) {
  let clock = new Date(2026, 9, 19, 10).getTime();
  const state = {
    queues: queues || [{ id: 'a', name: 'A', enabled: true, parallel: 2, schedule: null, completionAction: { type, delaySeconds: 30 } }],
    jobs, activeIds: [], busy: false
  };
  const executed = [];
  const controller = new CompletionActions({
    queueSnapshot: () => state.queues, jobsSnapshot: () => state.jobs, activeSnapshot: () => state.activeIds,
    isBusy: () => state.busy, now: () => clock,
    execute: execute || (async value => { executed.push(value); }), tickMs: 60000
  });
  t.after(() => controller.close());
  const advance = seconds => { clock += seconds * 1000; controller.reconcile(); };
  const current = () => controller.snapshot().find(value => value.queueId === 'a');
  controller.reconcile();
  return { state, executed, controller, advance, current };
}

test('a finished batch waits the full countdown and executes once despite repeated updates', async t => {
  const { state, executed, controller, advance, current } = fixture(t);
  const starts = [], statuses = [], done = [];
  controller.on('start', value => starts.push(value)); controller.on('status', value => statuses.push(value)); controller.on('done', value => done.push(value));
  state.jobs[0].status = 'complete'; controller.reconcile();
  assert.equal(current().state, 'pending'); assert.equal(current().remainingSeconds, 30);
  advance(29); assert.equal(executed.length, 0); assert.equal(current().remainingSeconds, 1);
  advance(1); await turn(); assert.equal(current().state, 'done');
  for (let i = 0; i < 10; i++) { controller.reconcile(); advance(60); }
  assert.equal(executed.length, 1); assert.equal(starts.length, 1); assert.equal(done.length, 1);
  assert.ok(statuses.some(value => value.state === 'executing'));
  const copy = controller.snapshot(); copy[0].state = 'changed'; assert.equal(current().state, 'done');
});

test('partial, errored, manually paused, and future scheduled downloads prevent completion', async t => {
  for (const status of ['queued', 'downloading', 'error', 'paused']) {
    const item = job('2', status); item.startAt = '2099-01-01T00:00:00.000Z';
    const { state, controller, current, advance, executed } = fixture(t, { jobs: [job('1'), item] });
    state.jobs[0].status = 'complete'; controller.reconcile(); advance(600);
    assert.equal(current(), undefined); assert.equal(executed.length, 0);
    state.jobs[1].status = 'complete'; controller.reconcile(); advance(30); await turn();
    assert.equal(executed.length, 1);
  }
});

test('scanning and active worker cleanup finish before the countdown starts', t => {
  const { state, controller, advance, current } = fixture(t);
  Object.assign(state.jobs[0], { status: 'complete', scanResult: { status: 'running' } });
  state.activeIds = ['1']; controller.reconcile(); advance(60); assert.equal(current(), undefined);
  state.jobs[0].scanResult.status = 'clean'; controller.reconcile(); assert.equal(current(), undefined);
  state.activeIds = []; controller.reconcile(); assert.equal(current().remainingSeconds, 30);
});

test('completed history, restarts, and action changes alone never cause actions', t => {
  const { state, controller, advance, current, executed } = fixture(t, { jobs: [job('1', 'complete')] });
  advance(60); assert.equal(current(), undefined);
  state.queues[0].completionAction = { type: 'shutdown', delaySeconds: 60 }; controller.reconcile(); advance(120);
  assert.equal(executed.length, 0); assert.equal(current(), undefined);
  state.jobs.push(job('2', 'complete')); controller.reconcile(); advance(120); assert.equal(current(), undefined);
  state.jobs.push(job('3')); controller.reconcile(); state.jobs[2].status = 'complete'; controller.reconcile();
  assert.equal(current().state, 'pending');
  const restarted = new CompletionActions({ queueSnapshot: () => state.queues, jobsSnapshot: () => state.jobs, execute: () => executed.push('bad') });
  t.after(() => restarted.close()); restarted.start(); restarted.reconcile(); assert.deepEqual(restarted.snapshot(), []);
});

test('new downloads cancel a countdown and only their subsequent completion starts a new one', async t => {
  const { state, controller, advance, current, executed } = fixture(t);
  state.jobs[0].status = 'complete'; controller.reconcile(); advance(15);
  state.jobs.push(job('2')); controller.reconcile(); assert.equal(current().state, 'cancelled');
  advance(60); assert.equal(executed.length, 0);
  state.jobs[1].status = 'complete'; controller.reconcile(); assert.equal(current().remainingSeconds, 30);
  advance(30); await turn(); assert.equal(executed.length, 1);
});

test('removing the unfinished last item does not count as finishing a batch', t => {
  const { state, controller, advance, current, executed } = fixture(t, { jobs: [job('1', 'complete'), job('2')] });
  state.jobs.pop(); controller.reconcile(); advance(60);
  assert.equal(current(), undefined); assert.equal(executed.length, 0);
});

test('a user cancellation remains cancelled and the next batch can run', async t => {
  const { state, controller, advance, current, executed } = fixture(t);
  state.jobs[0].status = 'complete'; controller.reconcile(); assert.equal(controller.cancel('a'), true);
  advance(120); assert.equal(current().state, 'cancelled'); assert.equal(current().reason, 'user-cancelled'); assert.equal(executed.length, 0);
  assert.equal(controller.cancel('missing'), false); assert.equal(controller.cancel('a'), false);
  state.jobs.push(job('2')); controller.reconcile(); state.jobs[1].status = 'complete'; controller.reconcile(); advance(30); await turn();
  assert.equal(executed.length, 1);
});

test('queue disabling, schedule closure, settings changes, and queue removal cancel countdowns', t => {
  for (const mutate of [
    state => { state.queues[0].enabled = false; },
    state => { state.queues[0].schedule = { start: '11:00', stop: '12:00', days: [1] }; },
    state => { state.queues[0].completionAction.delaySeconds = 60; },
    state => { state.queues[0].name = 'Renamed'; },
    state => { state.queues = []; }
  ]) {
    const { state, controller, advance, current, executed } = fixture(t);
    state.jobs[0].status = 'complete'; controller.reconcile(); mutate(state); controller.reconcile(); advance(120);
    assert.equal(current().state, 'cancelled'); assert.equal(executed.length, 0);
  }
});

test('the end of an existing schedule window cancels without replay when it reopens', t => {
  const { state, controller, advance, current, executed } = fixture(t);
  state.queues[0].schedule = { start: '09:00', stop: '10:01', days: [1] }; controller.reconcile();
  advance(45); state.jobs[0].status = 'complete'; controller.reconcile(); assert.equal(current().state, 'pending');
  advance(15); assert.equal(current().state, 'cancelled'); assert.equal(current().reason, 'queue-closed');
  advance(7 * 24 * 3600); assert.equal(executed.length, 0);
});

test('power and exit wait for other unfinished tasks including paused tasks, plus site/sync activity', async t => {
  for (const type of ['exit', 'shutdown', 'sleep', 'hibernate']) {
    const { state, controller, advance, current, executed } = fixture(t, { type, jobs: [job('1'), job('other', 'paused', 'b')] });
    state.jobs[0].status = 'complete'; controller.reconcile(); assert.equal(current().state, 'blocked'); assert.equal(current().deadline, null);
    advance(120); assert.equal(executed.length, 0);
    state.jobs[1].status = 'complete'; state.busy = true; controller.reconcile(); assert.equal(current().state, 'blocked');
    state.busy = false; controller.reconcile(); assert.equal(current().state, 'pending'); assert.equal(current().remainingSeconds, 30);
    advance(29); assert.equal(executed.length, 0); advance(1); await turn(); assert.equal(executed.length, 1);
  }
});

test('a new unrelated task during a power countdown cancels permanently until a new batch', t => {
  const { state, controller, advance, current, executed } = fixture(t, { type: 'shutdown' });
  state.jobs[0].status = 'complete'; controller.reconcile(); advance(20);
  state.jobs.push(job('other', 'queued', 'b')); controller.reconcile();
  assert.equal(current().state, 'cancelled'); assert.equal(current().reason, 'other-work-started');
  state.jobs[1].status = 'complete'; controller.reconcile(); advance(120); assert.equal(executed.length, 0);
});

test('busy work appearing exactly at the deadline is checked before execution', t => {
  const { state, controller, advance, current, executed } = fixture(t, { type: 'sleep' });
  state.jobs[0].status = 'complete'; controller.reconcile(); state.busy = true; advance(30);
  assert.equal(current().state, 'cancelled'); assert.equal(executed.length, 0);
});

test('notifications and opening folders may finish while an unrelated queue remains paused', async t => {
  for (const type of ['notify', 'open-folder']) {
    const { state, controller, advance, executed } = fixture(t, { type, jobs: [job('1'), job('other', 'paused', 'b')] });
    state.busy = true; state.jobs[0].status = 'complete'; controller.reconcile(); advance(30); await turn(); assert.equal(executed.length, 1);
  }
});

test('failed execution is reported without an automatic retry', async t => {
  let calls = 0;
  const { state, controller, advance, current } = fixture(t, { execute: async () => { calls++; throw Object.assign(new Error('untrusted details'), { code: 'POWER_UNAVAILABLE' }); } });
  const errors = []; controller.on('action-error', status => errors.push(status));
  state.jobs[0].status = 'complete'; controller.reconcile(); advance(30); await turn(); advance(120);
  assert.equal(calls, 1); assert.equal(current().state, 'error'); assert.equal(current().reason, 'POWER_UNAVAILABLE'); assert.equal(errors.length, 1);
});

test('close cancels pending work and start is idempotent', t => {
  const { state, controller, advance, current, executed } = fixture(t);
  controller.start(); const timer = controller.timer; controller.start(); assert.equal(controller.timer, timer);
  state.jobs[0].status = 'complete'; controller.reconcile(); controller.close(); advance(120);
  assert.equal(current().state, 'cancelled'); assert.equal(current().reason, 'app-closing'); assert.equal(executed.length, 0);
  assert.equal(controller.timer, null); controller.start(); assert.equal(controller.timer, null);
});

test('immediate notifications and folder actions still require a new finished batch', async t => {
  for (const type of ['notify', 'open-folder']) {
    const { state, controller, executed, current } = fixture(t, { type, jobs: [job('1', 'complete')] });
    state.queues[0].completionAction.delaySeconds = 0; controller.reconcile();
    assert.equal(current(), undefined); assert.equal(executed.length, 0);
    state.jobs.push(job('2')); controller.reconcile();
    Object.assign(state.jobs[1], { status: 'complete', scanResult: { status: 'running' } });
    controller.reconcile(); assert.equal(executed.length, 0);
    state.jobs[1].scanResult.status = 'clean'; controller.reconcile(); await turn();
    assert.equal(executed.length, 1); assert.equal(current().state, 'done');
    controller.reconcile(); assert.equal(executed.length, 1);
    state.jobs = []; controller.reconcile(); assert.equal(executed.length, 1);
  }
});

test('cancelling from the immediate start notification is honored before execution', async t => {
  const { state, controller, executed, current } = fixture(t);
  state.queues[0].completionAction.delaySeconds = 0; controller.reconcile();
  controller.on('start', value => controller.cancel(value.queueId));
  state.jobs[0].status = 'complete'; controller.reconcile(); await turn();
  assert.equal(executed.length, 0); assert.equal(current().state, 'cancelled');
});

test('a slow execution cannot overwrite the following batch countdown', async t => {
  let resolve;
  const calls = [];
  const { state, controller, advance, current } = fixture(t, { execute: value => { calls.push(value); return new Promise(done => { resolve = done; }); } });
  state.jobs[0].status = 'complete'; controller.reconcile(); advance(30);
  assert.equal(current().state, 'executing'); assert.equal(calls.length, 1);
  state.jobs.push(job('2')); controller.reconcile(); state.jobs[1].status = 'complete'; controller.reconcile();
  advance(60); assert.equal(current().state, 'executing'); assert.equal(calls.length, 1);
  resolve(); await turn(); controller.reconcile(); assert.equal(current().state, 'pending'); assert.equal(current().remainingSeconds, 30);
  advance(30); assert.equal(calls.length, 2); resolve(); await turn(); assert.equal(current().state, 'done');
});

test('a cancelled batch stays cancelled even if the same job regresses or queue settings change', async t => {
  const { state, controller, advance, executed, current } = fixture(t);
  state.jobs[0].status = 'complete'; controller.reconcile(); controller.cancel('a');
  state.jobs[0].status = 'paused'; controller.reconcile();
  state.queues[0].completionAction.delaySeconds = 60; controller.reconcile();
  state.jobs[0].status = 'complete'; controller.reconcile(); advance(120);
  assert.equal(executed.length, 0); assert.equal(current().state, 'cancelled');
  state.jobs.push(job('2')); controller.reconcile(); state.jobs[1].status = 'complete'; controller.reconcile();
  advance(60); await turn(); assert.equal(executed.length, 1);
});

test('two queues finishing together execute only one power action', async t => {
  const queues = ['a', 'b'].map((id, index) => ({ id, name: id, enabled: true, parallel: 1, schedule: null, completionAction: { type: index ? 'hibernate' : 'shutdown', delaySeconds: 30 } }));
  const { state, controller, advance, executed } = fixture(t, { queues, jobs: [job('1'), job('2', 'queued', 'b')] });
  state.jobs.forEach(value => { value.status = 'complete'; }); controller.reconcile();
  assert.equal(controller.snapshot().filter(value => value.state === 'pending').length, 2);
  advance(30); await turn(); advance(60);
  assert.equal(executed.length, 1); assert.equal(executed[0].type, 'shutdown');
  assert.equal(controller.snapshot().find(value => value.queueId === 'b').reason, 'another-power-action');
  state.jobs[1].status = 'paused'; controller.reconcile(); state.jobs[1].status = 'complete'; controller.reconcile(); advance(60); assert.equal(executed.length, 1);
  state.jobs.push(job('3', 'queued', 'b')); controller.reconcile(); state.jobs[2].status = 'complete'; controller.reconcile(); advance(30); await turn();
  assert.equal(executed.length, 2); assert.equal(executed[1].type, 'hibernate');
});

test('a queue starting an immediate notice does not suppress another queue completion', async t => {
  const queues = ['a', 'b'].map(id => ({ id, name: id, enabled: true, schedule: null, completionAction: { type: 'notify', delaySeconds: 0 } }));
  const { state, controller, executed } = fixture(t, { queues, jobs: [job('1'), job('2', 'queued', 'b')] });
  state.jobs.forEach(value => { value.status = 'complete'; }); controller.reconcile(); await turn();
  assert.deepEqual(executed.map(value => value.queueId), ['a', 'b']);
});

test('the running timer observes a short batch and its deadline without explicit reconciliation', { timeout: 5000 }, async t => {
  let clock = Date.now();
  const queues = [{ id: 'a', name: 'A', enabled: true, schedule: null, completionAction: { type: 'notify', delaySeconds: 30 } }];
  const jobs = [job('1')], executed = [];
  const controller = new CompletionActions({ queueSnapshot: () => queues, jobsSnapshot: () => jobs, now: () => clock, tickMs: 10, execute: async status => { executed.push(status); } });
  t.after(() => controller.close());
  let timeout;
  const finished = new Promise((resolve, reject) => {
    controller.once('done', resolve);
    timeout = setTimeout(() => reject(new Error('Completion timer did not execute')), 3000);
  });
  controller.on('start', () => { clock += 30000; });
  controller.start(); jobs[0].status = 'complete';
  try { await finished; } finally { clearTimeout(timeout); }
  assert.equal(executed.length, 1); assert.equal(controller.snapshot()[0].state, 'done');
});
