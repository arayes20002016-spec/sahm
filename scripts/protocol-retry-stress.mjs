import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { protocolRetryFixture } from './lib/protocol-retry-fixture.mjs';
import { sha256 } from './lib/runtime-integrity.mjs';
import { writeCheckpoint } from '../src/checkpoint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), execute = promisify(execFile);
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const application = resolve(argument('--application-root') || root), runtime = resolve(argument('--runtime') || process.execPath);
const runtimeDirectory = resolve(argument('--media-runtime') || join(root, 'artifacts/media-runtime'));
const durationSeconds = Number(argument('--duration-seconds') || 1800), outageMs = Number(argument('--outage-ms') || 12000);
assert.ok(Number.isSafeInteger(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 86400);
assert.ok(Number.isSafeInteger(outageMs) && outageMs >= 6000 && outageMs <= 120000);
const directory = resolve(argument('--result-directory') || join(root, 'artifacts/protocol-retry-stress', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(dirname(directory), { recursive: true }); await mkdir(directory);
const downloads = join(directory, 'downloads'), profile = join(directory, 'profile'); await mkdir(downloads);
const realDownloads = await realpath(downloads), fixture = await protocolRetryFixture(join(directory, 'fixture'), runtimeDirectory);
const report = { ok: false, initializedAt: new Date().toISOString(), durationSeconds, outageMs, parallel: 2, application, runtime, runtimeDirectory,
  baselines: {}, waves: [], samples: [], workers: [], workerStarts: 0, networkInterruptions: 0, manualResumesAfterNetworkOutage: 0,
  automaticRecovered: { ftp: 0, hls: 0, dash: 0 }, observedRetryAttempts: 0, gracefulRestarts: 0, manualPauseResumes: 0, resumesAfterAppRestart: 0,
  verifiedFiles: 0, verifiedBytes: 0, ftpRestResumes: 0, mediaRangeResumes: 0, automaticCaseRetries: 0, cleanedMediaProcessDirectories: 0,
  personalProfileUsed: false, virtualMachineUsed: false, installerExecuted: false, maxRssMiB: 384 };
let worker, sequence = 0, sampledAt = 0, previousFiles = [], started;
const reportReservation = join(directory, '.report-reserve');
let reportReservationCreated = false;
const retryJobs = new Set(), retryAttempts = new Set();
async function startWorker() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  if (/sahm\.exe$/i.test(runtime)) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime, [join(root, 'scripts/lib/protocol-retry-worker.mjs'), application, profile, downloads, runtimeDirectory], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const index = ++report.workerStarts, pending = new Map();
  child.stdout.pipe(createWriteStream(join(directory, `worker-${index}-stdout.log`)));
  child.stderr.pipe(createWriteStream(join(directory, `worker-${index}-stderr.log`)));
  let acceptReady, rejectReady;
  const ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error('Protocol worker startup timed out')), 30000);
  const exit = new Promise(resolveExit => child.once('exit', (code, signal) => {
    clearTimeout(timer); rejectReady(new Error('Protocol worker exited'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Protocol worker exited during RPC')); }
    pending.clear(); resolveExit({ code, signal });
  }));
  child.once('error', error => { clearTimeout(timer); rejectReady(error); });
  child.on('message', message => {
    if (message.ready) { clearTimeout(timer); acceptReady(message); return; }
    const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  });
  const rpc = (operation, data) => new Promise((accept, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Protocol RPC timeout: ' + operation)); }, 30000);
    pending.set(id, { resolve: accept, reject, timer });
    child.send({ id, operation, data }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
  });
  worker = { child, exit, rpc, index }; const initial = await ready; report.runtimeVersions ||= initial.versions; return initial;
}
async function snapshot() {
  const value = await worker.rpc('snapshot'); assert.deepEqual(value.storageErrors, []);
  assert.ok(value.metrics.memory.rss <= report.maxRssMiB * 1024 ** 2, 'Protocol worker RSS exceeded budget');
  for (const job of value.jobs) if (job.networkRetry) { retryJobs.add(job.id); retryAttempts.add(job.id + ':' + job.networkRetry.attempt); }
  if (Date.now() - sampledAt >= 5000) {
    sampledAt = Date.now(); const sample = { worker: worker.index, jobs: value.jobs.length, active: value.active.length, ...value.metrics };
    report.samples.push(sample); await appendFile(join(directory, 'samples.jsonl'), JSON.stringify(sample) + '\n');
  }
  return value;
}
async function waitFor(predicate, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await snapshot();
    assert.ok(!value.jobs.some(job => job.status === 'error'), 'A protocol job failed: ' + JSON.stringify(value.jobs.filter(job => job.status === 'error').map(job => ({ kind: job.kind, error: job.error }))));
    const result = await predicate(value); if (result) return result; await delay(100);
  }
  throw new Error('Protocol phase timeout: ' + label);
}
async function mediaProof(path) {
  const run = (name, args) => execute(join(runtimeDirectory, name + '.exe'), args, { windowsHide: true, timeout: 30000, maxBuffer: 512 * 1024 });
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])).stdout);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video')); assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Number(probe.format.duration) >= 7.9 && Number(probe.format.duration) < 9);
  const decoded = {};
  for (const type of ['video', 'audio']) {
    const output = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-threads', '1', '-i', path, '-map', type === 'video' ? '0:v:0' : '0:a:0',
      ...(type === 'video' ? ['-c:v', 'rawvideo', '-fps_mode', 'passthrough'] : ['-c:a', 'pcm_s16le']), '-threads', '1', '-f', 'hash', '-hash', 'sha256', '-']);
    assert.match(output.stdout.trim(), /^SHA256=[a-f0-9]{64}$/); decoded[type] = output.stdout.trim();
  }
  return { path, bytes: (await stat(path)).size, sha256: await sha256(path), duration: Number(probe.format.duration), decoded };
}
async function completed(ids) {
  return waitFor(value => { const jobs = value.jobs.filter(job => ids.has(job.id)); return jobs.length === ids.size && jobs.every(job => job.status === 'complete' && !value.active.includes(job.id)) ? jobs : false; }, 'all transfers complete');
}
async function closeWorker() {
  const final = await worker.rpc('close'); assert.ok(final.children.every(child => child.finishedAt));
  assert.equal((await worker.exit).code, 0);
  for (const child of final.children.filter(child => child.temporaryDirectory)) {
    assert.match(basename(child.temporaryDirectory), /^sahm-media-process-/);
    await assert.rejects(stat(child.temporaryDirectory), { code: 'ENOENT' });
    report.cleanedMediaProcessDirectories++;
  }
  report.workers.push({ index: worker.index, children: final.children }); return final;
}
async function prune(paths) {
  for (const path of paths) {
    const parent = await realpath(dirname(path)); assert.ok(parent.startsWith(realDownloads + sep));
    for (const entry of await readdir(parent, { withFileTypes: true })) { assert.ok(entry.isFile()); await unlink(join(parent, entry.name)); }
  }
}
try {
  const reservation = await open(reportReservation, 'wx', 0o600); reportReservationCreated = true;
  try { await reservation.writeFile(randomBytes(4 * 1024 * 1024)); await reservation.sync(); }
  finally { await reservation.close(); }
  const metadata = await stat(application);
  report.version = JSON.parse(await readFile(metadata.isFile() ? join(dirname(application), 'browser/extension/manifest.json') : join(application, 'package.json'), 'utf8')).version;
  if (metadata.isFile()) report.appAsarSha256 = await sha256(application);
  await startWorker(); fixture.release();
  for (const [kind, manifest] of [['hls', 'master.m3u8'], ['dash', 'vod.mpd']]) {
    const [job] = await worker.rpc('add', [{ kind: 'media', url: fixture.origin + '/' + manifest, title: 'مرجع-' + kind, quality: '240' }]);
    const [finished] = await completed(new Set([job.id])); report.baselines[kind] = await mediaProof(finished.path);
  }
  started = Date.now(); report.startedAt = new Date(started).toISOString();
  for (let wave = 1; wave <= 4 || Date.now() - started < durationSeconds * 1000; wave++) {
    fixture.hold();
    const type = wave % 2 ? 'hls' : 'dash', manifest = type === 'hls' ? 'master.m3u8' : 'vod.mpd';
    const ftpIndex = fixture.ftp.requests.length, mediaIndex = fixture.requests.length, began = Date.now();
    const jobs = await worker.rpc('add', [{ url: fixture.ftp.url, name: 'ملف-FTP-' + wave + '.bin', connections: 1 },
      { kind: 'media', url: fixture.origin + '/' + manifest, title: 'فيديو-' + type + '-' + wave, quality: '240' }]);
    const ids = new Set(jobs.map(job => job.id));
    await waitFor(value => value.jobs.filter(job => ids.has(job.id)).every(job => job.status === 'downloading' && job.received > 0) && fixture.ftp.heldTransfers > 0 && fixture.heldMediaTransfers > 0, 'both protocols held with partial bytes');
    let phase = 'network-outage', checkpoint;
    if (wave === 4 || wave === 60) {
      phase = 'graceful-restart'; const before = await snapshot(), beforeIds = before.jobs.map(job => job.id).sort();
      await closeWorker(); report.gracefulRestarts++;
      const restored = await startWorker(); assert.deepEqual(restored.jobs.map(job => job.id).sort(), beforeIds);
      fixture.release(); for (const job of jobs) { await worker.rpc('action', { id: job.id, action: 'resume' }); report.resumesAfterAppRestart++; }
    } else if (wave % 5 === 3) {
      phase = 'manual-pause';
      for (const job of jobs) await worker.rpc('action', { id: job.id, action: 'pause' });
      const before = fixture.ftp.requests.length + fixture.requests.length; fixture.release(); await delay(1200);
      const paused = await snapshot(); assert.ok(paused.jobs.filter(job => ids.has(job.id)).every(job => job.status === 'paused'));
      assert.equal(fixture.ftp.requests.length + fixture.requests.length, before);
      for (const job of jobs) { await worker.rpc('action', { id: job.id, action: 'resume' }); report.manualPauseResumes++; }
    } else {
      fixture.interrupt(); report.networkInterruptions++; await delay(outageMs);
      await waitFor(value => jobs.every(job => retryJobs.has(job.id)), 'each interrupted protocol entered automatic retry');
      checkpoint = JSON.parse(await readFile(jobs[0].path + '.ftp-resume.json', 'utf8')); assert.ok(checkpoint.received > 0);
      fixture.reconnect(); fixture.release();
    }
    const results = await completed(ids), files = [];
    for (const job of results) {
      if (job.kind === 'ftp') {
        assert.deepEqual(await readFile(job.path), fixture.ftpBytes);
        files.push({ kind: 'ftp', path: job.path, bytes: fixture.ftpBytes.length, sha256: createHash('sha256').update(fixture.ftpBytes).digest('hex') });
      } else {
        const proof = await mediaProof(job.path); assert.deepEqual(proof.decoded, report.baselines[type].decoded, 'Resumed audio/video content differs from healthy reference'); files.push({ kind: type, ...proof });
      }
      if (phase === 'network-outage') { assert.ok(retryJobs.has(job.id)); report.automaticRecovered[job.kind === 'ftp' ? 'ftp' : type]++; }
    }
    const rest = fixture.ftp.requests.slice(ftpIndex).filter(request => request.command === 'REST' && Number(request.value) > 0);
    if (checkpoint) assert.ok(rest.some(request => Number(request.value) === checkpoint.received), 'FTP did not resume its saved offset');
    report.ftpRestResumes += rest.length;
    report.mediaRangeResumes += fixture.requests.slice(mediaIndex).filter(request => request.range && !/^bytes=0-/.test(request.range)).length;
    report.verifiedFiles += files.length; report.verifiedBytes += files.reduce((sum, file) => sum + file.bytes, 0); report.observedRetryAttempts = retryAttempts.size;
    const result = { wave, type, phase, elapsedMs: Date.now() - began, files, ftpCheckpoint: checkpoint,
      ftpRequests: fixture.ftp.requests.slice(ftpIndex), mediaRequests: fixture.requests.slice(mediaIndex) };
    await appendFile(join(directory, 'waves.jsonl'), JSON.stringify(result) + '\n');
    report.waves.push({ wave, type, phase, elapsedMs: result.elapsedMs, files: files.length });
    await prune(previousFiles); previousFiles = files.map(file => file.path);
    await writeCheckpoint(join(directory, 'progress.json'), JSON.stringify({ ...report, samples: undefined }, null, 2));
    console.log(`PROTOCOL wave=${wave} type=${type} phase=${phase} files=${report.verifiedFiles} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
  }
  assert.ok(Object.values(report.automaticRecovered).every(value => value > 0)); assert.equal(report.manualResumesAfterNetworkOutage, 0);
  const final = await closeWorker(); assert.equal(final.jobs.length, report.verifiedFiles + 2); assert.ok(final.jobs.every(job => job.status === 'complete'));
  report.historyJobs = final.jobs.length; report.retainedFiles = previousFiles; report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
    try { await closeWorker(); } catch { worker.child.kill('SIGKILL'); await worker.exit; }
  }
  await fixture.close(); report.finishedAt = new Date().toISOString(); report.elapsedMs = started ? Date.now() - started : 0;
  report.peakRssBytes = Math.max(0, ...report.samples.map(sample => sample.memory.rss));
  if (reportReservationCreated) await unlink(reportReservation).catch(error => {
    if (error.code !== 'ENOENT') { report.reportStorageError = error.code; report.ok = false; process.exitCode = 1; }
  });
  try { await writeCheckpoint(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, error: report.error, reportStorageError: error.code, verifiedFiles: report.verifiedFiles }));
    throw error;
  }
  console.log('PROTOCOL RETRY STRESS ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
}
