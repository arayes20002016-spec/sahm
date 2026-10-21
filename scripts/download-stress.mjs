import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stressDownloadFixture } from './lib/stress-download-fixture.mjs';
import { sha256 } from './lib/runtime-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const application = resolve(argument('--application-root') || root), runtime = resolve(argument('--runtime') || process.execPath);
const durationSeconds = Number(argument('--duration-seconds') || 1800), parallel = Number(argument('--parallel') || 4);
const outageMs = Number(argument('--outage-ms') || 6000);
const maxRssMiB = Number(argument('--max-rss-mib') || 512);
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 86400);
assert.ok(Number.isInteger(parallel) && parallel >= 2 && parallel <= 8);
assert.ok(Number.isInteger(outageMs) && outageMs >= 1500 && outageMs <= 30000);
assert.ok(Number.isInteger(maxRssMiB) && maxRssMiB >= 64 && maxRssMiB <= 4096);
const directory = resolve(argument('--result-directory') || join(root, 'artifacts/download-stress', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(dirname(directory), { recursive: true }); await mkdir(directory);
const downloads = join(directory, 'downloads'), profile = join(directory, 'profile');
await mkdir(downloads); const realDownloads = await realpath(downloads);
const fixture = await stressDownloadFixture(), started = Date.now();
const report = { ok: false, application, runtime, durationSeconds, parallel, maxRssMiB, outageMs, startedAt: new Date(started).toISOString(),
  phases: [], waves: [], samples: [], workerStarts: 0, forcedTerminations: 0, gracefulRestarts: 0,
  networkInterruptions: 0, manualResumesAfterOutage: 0, automaticRecoveredJobs: 0, automaticRetryAttemptsObserved: 0,
  pauseResumes: 0, resumedRanges: 0, verifiedFiles: 0, verifiedBytes: 0,
  automaticCaseRetries: 0, personalProfileUsed: false, virtualMachineUsed: false, installerExecuted: false };
let worker, sequence = 0, lastSample = 0, previousFiles = [];
const automaticJobs = new Set(), automaticAttempts = new Set();
function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

async function startWorker() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  if (/\.exe$/i.test(runtime) && runtime.toLowerCase().endsWith('sahm.exe')) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [join(root, 'scripts/lib/download-stress-worker.mjs'), application, profile, downloads, String(parallel)], {
    windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const index = ++report.workerStarts, pending = new Map();
  const stdout = createWriteStream(join(directory, 'worker-' + index + '-stdout.log'));
  const stderr = createWriteStream(join(directory, 'worker-' + index + '-stderr.log'));
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let readyResolve, readyReject;
  const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('Worker startup timed out')), 30000);
  const exit = new Promise(resolveExit => child.once('exit', (code, signal) => {
    clearTimeout(timer); readyReject(new Error('Worker exited: ' + code + '/' + signal));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Worker exited during RPC')); }
    pending.clear(); resolveExit({ code, signal });
  }));
  child.once('error', error => { clearTimeout(timer); readyReject(error); });
  child.on('message', message => {
    if (message.ready) { clearTimeout(timer); readyResolve(message); return; }
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  });
  const rpc = (operation, data) => new Promise((resolveRpc, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Worker RPC timed out: ' + operation)); }, 30000);
    pending.set(id, { resolve: resolveRpc, reject, timer: timeout });
    child.send({ id, operation, data }, error => { if (error) { clearTimeout(timeout); pending.delete(id); reject(error); } });
  });
  worker = { child, exit, rpc, index };
  const initial = await ready;
  report.runtimeVersions ||= initial.versions;
  return initial;
}

async function snapshot() {
  const value = await worker.rpc('snapshot');
  assert.deepEqual(value.storageErrors, [], 'Unexpected persistence error');
  assert.ok(value.metrics.memory.rss <= maxRssMiB * 1024 ** 2, 'Download worker exceeded the RSS budget');
  for (const job of value.jobs) if (job.networkRetry) {
    automaticJobs.add(job.id); automaticAttempts.add(job.id + ':' + job.networkRetry.attempt);
  }
  if (Date.now() - lastSample >= 5000) {
    lastSample = Date.now();
    const sample = { worker: worker.index, jobs: value.jobs.length, active: value.active.length, ...value.metrics };
    report.samples.push(sample); await appendFile(join(directory, 'samples.jsonl'), JSON.stringify(sample) + '\n');
  }
  return value;
}

async function waitFor(check, description, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await snapshot(), result = await check(value);
    if (result) return result;
    await delay(100);
  }
  throw new Error('Stress phase timed out: ' + description);
}

async function restart(force, sources) {
  const before = await snapshot(), ids = before.jobs.map(job => job.id).sort();
  if (force) { worker.child.kill('SIGKILL'); report.forcedTerminations++; }
  else { await worker.rpc('close'); report.gracefulRestarts++; }
  const result = await worker.exit;
  if (!force) assert.equal(result.code, 0);
  const checkpoints = [];
  for (const job of before.jobs.filter(job => before.active.includes(job.id))) {
    const state = JSON.parse(await readFile(job.path + '.resume.json', 'utf8'));
    assert.ok(state.parts.some(part => part.done > 0), 'Crash must follow a flushed nonzero checkpoint');
    const partial = await readFile(job.path + '.part'), source = sources.find(source => source.url === job.url);
    for (const part of state.parts) assert.deepEqual(partial.subarray(part.start, part.start + part.done), source.payload.subarray(part.start, part.start + part.done));
    checkpoints.push({ id: job.id, name: new URL(job.url).pathname, path: job.path, ranged: state.ranged,
      requestIndex: fixture.requests.length, parts: state.parts.map(part => ({ ...part })) });
  }
  const initial = await startWorker();
  assert.deepEqual(initial.jobs.map(job => job.id).sort(), ids, 'Restart lost or duplicated job history');
  assert.ok(initial.jobs.every(job => job.status === 'complete' || job.status === 'paused' || job.status === 'queued' || job.status === 'error'));
  fixture.release();
  for (const job of initial.jobs.filter(job => job.status !== 'complete')) await worker.rpc('action', { id: job.id, action: 'resume' });
  return checkpoints;
}

async function prune(files) {
  for (const file of files) {
    const parent = await realpath(dirname(file));
    assert.ok(parent.startsWith(realDownloads + sep), 'Generated download escaped the stress directory');
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      assert.ok(entry.isFile(), 'Unexpected generated download entry');
      await unlink(join(parent, entry.name));
    }
  }
}

try {
  const info = await stat(application);
  report.version = JSON.parse(await readFile(info.isFile() ? join(dirname(application), 'browser/extension/manifest.json') : join(application, 'package.json'), 'utf8')).version;
  if (info.isFile()) report.appAsarSha256 = await sha256(application);
  await startWorker();
  for (let wave = 1; wave <= 4 || Date.now() - started < durationSeconds * 1000; wave++) {
    // Exercise recovery early, then keep a worker alive across many waves.
    let phase = 'pause-resume';
    if (wave === 1 || wave % 60 === 0) phase = 'forced-restart';
    else if (wave === 4) phase = 'graceful-restart';
    else if (wave % 3 === 2) phase = 'network-outage';
    const held = phase.includes('restart');
    const sources = Array.from({ length: parallel * 2 }, (_, index) => {
      const serial = (wave - 1) * parallel * 2 + index;
      return { serial, mode: ['stable', 'reset', 'unavailable', 'plain'][index % 4], ...fixture.add(serial, ['stable', 'reset', 'unavailable', 'plain'][index % 4], held) };
    });
    const began = Date.now(), requestIndex = fixture.requests.length;
    const jobs = await worker.rpc('add', sources.map(source => ({ url: source.url, name: 'سهم-' + source.serial + '.bin', connections: 4 })));
    const ids = new Set(jobs.map(job => job.id));
    await waitFor(value => {
      const active = value.jobs.filter(job => ids.has(job.id) && value.active.includes(job.id));
      assert.ok(!value.jobs.some(job => ids.has(job.id) && job.status === 'error'), 'Unexpected error before fault injection');
      return active.length === parallel && active.every(job => job.received >= 65536);
    }, 'partial data in every active transfer');
    let checkpoints = [];
    if (held) {
      await waitFor(async value => {
        for (const job of value.jobs.filter(job => ids.has(job.id) && value.active.includes(job.id))) {
          const state = await readFile(job.path + '.resume.json', 'utf8').then(JSON.parse);
          if (!state.parts.some(part => part.done > 0)) return false;
        }
        return true;
      }, 'flushed checkpoints before restart');
      checkpoints = await restart(phase === 'forced-restart', sources);
    } else if (phase === 'network-outage') {
      fixture.interrupt(); report.networkInterruptions++;
      await delay(outageMs); fixture.reconnect();
    } else {
      const active = (await snapshot()).jobs.find(job => ids.has(job.id) && job.status === 'downloading' && job.url.includes('/stable.bin'));
      assert.ok(active); await worker.rpc('action', { id: active.id, action: 'pause' });
      const state = JSON.parse(await readFile(active.path + '.resume.json', 'utf8'));
      checkpoints = [{ id: active.id, name: new URL(active.url).pathname, ranged: state.ranged, parts: state.parts, requestIndex: fixture.requests.length }];
      const paused = await snapshot(); assert.equal(paused.jobs.find(job => job.id === active.id).status, 'paused');
      await delay(250);
      const later = await snapshot(); assert.equal(later.jobs.find(job => job.id === active.id).status, 'paused');
      assert.equal(later.jobs.find(job => job.id === active.id).received, paused.jobs.find(job => job.id === active.id).received);
      await worker.rpc('action', { id: active.id, action: 'resume' }); report.pauseResumes++;
    }
    const completed = await waitFor(async value => {
      const current = value.jobs.filter(job => ids.has(job.id));
      assert.equal(current.length, jobs.length);
      for (const job of current.filter(job => job.status === 'error')) {
        assert.fail('Automatic reconnection must settle without a manual resume: ' + job.error);
      }
      return current.every(job => job.status === 'complete' && !value.active.includes(job.id)) ? current : false;
    }, 'wave completion');
    report.automaticRecoveredJobs += completed.filter(job => automaticJobs.has(job.id)).length;
    report.automaticRetryAttemptsObserved = automaticAttempts.size;
    const requests = fixture.requests.slice(requestIndex), files = [];
    for (const job of completed) {
      const source = sources.find(source => source.url === job.url), actual = await readFile(job.path), expected = hash(source.payload);
      assert.equal(hash(actual), expected, 'Final file corruption'); assert.equal(actual.length, source.payload.length);
      await assert.rejects(readFile(job.path + '.part'), { code: 'ENOENT' });
      await assert.rejects(readFile(job.path + '.resume.json'), { code: 'ENOENT' });
      files.push({ id: job.id, path: job.path, serial: source.serial, mode: source.mode, bytes: actual.length, sha256: expected });
      report.verifiedFiles++; report.verifiedBytes += actual.length;
    }
    for (const checkpoint of checkpoints.filter(checkpoint => checkpoint.ranged)) {
      const used = fixture.requests.slice(checkpoint.requestIndex).filter(request => request.name === checkpoint.name && !request.probe && checkpoint.parts.some(part => part.done > 0 && part.done < part.end - part.start + 1 && request.start === part.start + part.done));
      assert.ok(used.length, 'Restart did not use any saved nonzero range'); report.resumedRanges += used.length;
    }
    const result = { wave, phase, elapsedMs: Date.now() - began, files, checkpoints,
      requests: requests.map(({ name, start, end, probe, status, bytes, fault }) => ({ name, start, end, probe, status, bytes, fault })) };
    await appendFile(join(directory, 'waves.jsonl'), JSON.stringify(result) + '\n');
    report.waves.push({ wave, phase, elapsedMs: result.elapsedMs, files: files.length, checkpointedJobs: checkpoints.length, requests: requests.length });
    report.phases = [...new Set([...report.phases, phase])];
    await prune(previousFiles); previousFiles = files.map(file => file.path); fixture.forget(sources.map(source => source.name));
    console.log(`STRESS wave=${wave} phase=${phase} files=${report.verifiedFiles} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
    await writeFile(join(directory, 'progress.json'), JSON.stringify({ ...report, samples: undefined, server: fixture.counters }, null, 2));
  }
  const final = await snapshot();
  assert.equal(report.phases.length, 4, 'Every recovery phase must run');
  assert.equal(report.manualResumesAfterOutage, 0);
  assert.ok(report.automaticRecoveredJobs > 0 && report.automaticRetryAttemptsObserved > 0, 'No automatic reconnection was observed');
  assert.ok(final.jobs.every(job => job.status === 'complete')); assert.equal(final.active.length, 0);
  report.historyJobs = final.jobs.length; assert.equal(report.historyJobs, report.verifiedFiles);
  await worker.rpc('close'); const exit = await worker.exit; assert.equal(exit.code, 0);
  report.finalFilesRetained = previousFiles; report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await worker.exit; }
  await fixture.close(); report.server = fixture.counters;
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
  report.peakRssBytes = Math.max(0, ...report.samples.map(sample => sample.memory.rss));
  report.peakHeapBytes = Math.max(0, ...report.samples.map(sample => sample.memory.heapUsed));
  report.maxObservedEventLoopDelayMs = Math.max(0, ...report.samples.map(sample => sample.eventLoopMaxMs));
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('DOWNLOAD STRESS ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
}
