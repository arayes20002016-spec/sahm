import { EventEmitter } from 'node:events';
import { normalizeCompletionAction, queueIsOpen } from './queues.mjs';

const powerActions = new Set(['exit', 'shutdown', 'sleep', 'hibernate']);
const waitingStates = new Set(['pending', 'blocked']);

function configuration(queue) {
  return JSON.stringify({ name: queue.name, enabled: queue.enabled, parallel: queue.parallel, schedule: queue.schedule || null, completionAction: normalizeCompletionAction(queue.completionAction || {}) });
}

function unfinished(job) {
  return job.status !== 'complete' || job.scanResult?.status === 'running';
}

function sameIds(a, b) {
  return a.size === b.size && [...a].every(id => b.has(id));
}

// Countdowns belong to this process only. A restart establishes a new baseline;
// completed downloads and a newly selected action never replay a previous action.
export class CompletionActions extends EventEmitter {
  constructor({ queueSnapshot = () => [], jobsSnapshot = () => [], activeSnapshot = () => [], isBusy = () => false, execute = async () => {}, now = () => Date.now(), tickMs = 250 } = {}) {
    super();
    if (![queueSnapshot, jobsSnapshot, activeSnapshot, isBusy, execute, now].every(value => typeof value === 'function')) throw new TypeError('Completion action callbacks must be functions.');
    if (!Number.isInteger(tickMs) || tickMs < 10 || tickMs > 60000) throw new TypeError('Invalid completion timer interval.');
    Object.assign(this, { queueSnapshot, jobsSnapshot, activeSnapshot, isBusy, execute, now, tickMs });
    this.records = new Map();
    this.statuses = new Map();
    this.closed = false;
  }

  start() {
    if (this.closed || this.timer) return this;
    this.reconcile();
    this.timer = setInterval(() => {
      try { this.reconcile(); }
      catch (error) { this.emit('controller-error', error); }
    }, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  snapshot() { return structuredClone([...this.statuses.values()]); }

  publish(status, event = 'update') {
    this.statuses.set(status.queueId, structuredClone(status));
    this.emit(event, structuredClone(status));
    if (event === 'cancelled') this.emit('cancel', structuredClone(status));
    this.emit('status', structuredClone(status));
    this.emit('change', this.snapshot());
  }

  cancel(queueId, reason = 'user-cancelled') {
    const status = this.statuses.get(queueId);
    if (!status || !waitingStates.has(status.state)) return false;
    const record = this.records.get(queueId);
    if (record) {
      record.armed = false;
      if (['user-cancelled', 'other-work-started', 'another-power-action'].includes(reason)) record.suppressed = true;
    }
    this.publish({ ...status, state: 'cancelled', deadline: null, remainingSeconds: 0, reason }, 'cancelled');
    return true;
  }

  reconcile(input = {}) {
    if (this.closed) return this.snapshot();
    const queues = input.queues ?? this.queueSnapshot();
    const jobs = input.jobs ?? this.jobsSnapshot();
    const activeInput = input.activeIds ?? this.activeSnapshot();
    const activeIds = new Set(activeInput instanceof Map ? activeInput.keys() : activeInput);
    const timestamp = this.now();
    const date = new Date(timestamp);
    const ids = new Set(queues.map(queue => queue.id));
    for (const [id] of this.records) {
      if (!ids.has(id)) { this.cancel(id, 'queue-removed'); this.records.delete(id); }
    }
    for (const queue of queues) {
      const action = normalizeCompletionAction(queue.completionAction || {});
      const config = configuration(queue);
      const batch = jobs.filter(job => job.queueId === queue.id);
      const batchIds = new Set(batch.map(job => job.id));
      const incomplete = batch.some(unfinished);
      const open = queue.open !== false && queueIsOpen(queue, date);
      const previous = this.records.get(queue.id);
      const ready = batch.length > 0 && !incomplete && !batch.some(job => activeIds.has(job.id));
      if (!previous) {
        this.records.set(queue.id, { config, ids: batchIds, armed: incomplete && action.type !== 'none', suppressed: false });
        continue;
      }
      const changed = previous.config !== config;
      const membershipChanged = !sameIds(previous.ids, batchIds);
      if (changed || membershipChanged) {
        const added = [...batchIds].some(id => !previous.ids.has(id));
        this.cancel(queue.id, changed ? 'queue-settings-changed' : 'queue-jobs-changed');
        previous.config = config;
        previous.ids = batchIds;
        if (added) previous.suppressed = false;
        previous.armed = incomplete && action.type !== 'none' && !previous.suppressed;
        // Adding/removing completed records or changing settings is not a
        // completion transition, even if no unfinished records remain.
        continue;
      }
      if (!open || action.type === 'none') {
        this.cancel(queue.id, !open ? 'queue-closed' : 'action-disabled');
        previous.armed = incomplete && action.type !== 'none' && !previous.suppressed;
        continue;
      }
      if (!ready) {
        this.cancel(queue.id, 'queue-unfinished');
        if (incomplete && !previous.suppressed) previous.armed = true;
        continue;
      }
      if (!previous.armed) continue;
      let busy = false;
      if (powerActions.has(action.type)) {
        try {
          busy = jobs.some(unfinished) || activeIds.size > 0 || Boolean(input.busy ?? this.isBusy());
        } catch { busy = true; }
      }
      let status = this.statuses.get(queue.id);
      // A slow folder/notification callback must settle before the next batch
      // announces its countdown, otherwise its result could replace that timer.
      if (status?.state === 'executing') continue;
      if (!status || !waitingStates.has(status.state)) {
        status = { scope: 'queue', ownerId: queue.id, queueId: queue.id, queueName: queue.name, type: action.type, state: busy ? 'blocked' : 'pending', deadline: busy ? null : timestamp + action.delaySeconds * 1000, remainingSeconds: action.delaySeconds, reason: busy ? 'other-work' : null };
        this.publish(status, 'start');
        status = this.statuses.get(queue.id);
        if (!previous.armed || !waitingStates.has(status.state) || busy || action.delaySeconds > 0) continue;
      }
      if (busy && status.state === 'pending') {
        // Newly arrived work cancels an already announced power action. It
        // cannot run hours later after unrelated work happens to finish.
        this.cancel(queue.id, 'other-work-started');
        continue;
      }
      if (busy) continue;
      if (status.state === 'blocked') {
        this.publish({ ...status, state: 'pending', deadline: timestamp + action.delaySeconds * 1000, remainingSeconds: action.delaySeconds, reason: null });
        continue;
      }
      const remainingSeconds = Math.max(0, Math.ceil((status.deadline - timestamp) / 1000));
      if (remainingSeconds > 0) {
        if (remainingSeconds !== status.remainingSeconds) this.publish({ ...status, remainingSeconds });
        continue;
      }
      previous.armed = false;
      if (powerActions.has(action.type)) this.cancelCompetingPowerActions(queue.id, queues);
      this.run({ ...status, state: 'executing', deadline: null, remainingSeconds: 0 });
    }
    return this.snapshot();
  }

  cancelCompetingPowerActions(queueId, queues) {
    // One idle completion wave can request only one system action. In
    // particular, simultaneous queues must never request shutdown and sleep.
    for (const queue of queues) {
      const record = this.records.get(queue.id);
      const action = normalizeCompletionAction(queue.completionAction || {});
      if (queue.id === queueId || !record?.armed || !powerActions.has(action.type)) continue;
      record.armed = false;
      record.suppressed = true;
      if (this.cancel(queue.id, 'another-power-action')) continue;
      this.publish({ scope: 'queue', ownerId: queue.id, queueId: queue.id, queueName: queue.name, type: action.type, state: 'cancelled', deadline: null, remainingSeconds: 0, reason: 'another-power-action' }, 'cancelled');
    }
  }

  async run(status) {
    this.publish(status);
    try {
      await this.execute(structuredClone(status));
      this.publish({ ...status, state: 'done', reason: null }, 'done');
    } catch (error) {
      this.publish({ ...status, state: 'error', reason: typeof error?.code === 'string' ? error.code : 'execution-failed' }, 'action-error');
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const [id] of this.statuses) this.cancel(id, 'app-closing');
  }
}
