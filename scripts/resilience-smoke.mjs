import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const worker = process.argv.indexOf('--worker');
if (worker !== -1) {
  const [application, directory, mode, url] = process.argv.slice(worker + 1);
  const { DownloadManager } = await import(pathToFileURL(join(application, 'src/manager.mjs')));
  const manager = await new DownloadManager(join(directory, 'data'), join(directory, 'files')).init();
  try {
    const loaded = manager.list();
    const job = mode === 'first' ? await manager.add({ url, name: 'payload.bin', connections: 4 }) : loaded[0];
    process.send({ type: 'ready', job, loaded });
    if (mode !== 'first') await manager.action(job.id, 'resume');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const current = manager.list().find(value => value.id === job.id);
      if (current.status === 'error') throw new Error(current.error);
      if (current.status === 'complete') {
        await manager.close();
        process.send({ type: 'complete', job: current });
        process.disconnect();
        break;
      }
      await delay(100);
    }
    if (!manager.stopped) throw new Error('Worker timed out');
  } catch (error) {
    await manager.close();
    process.send?.({ type: 'error', message: error.stack });
    process.exitCode = 1;
    process.disconnect?.();
  }
} else {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const portable = resolve(process.argv[2] || 'dist/' + version + '/SAHM-win32-x64');
  const executable = join(portable, 'SAHM.exe'), application = join(portable, 'resources/app.asar');
  const parent = resolve('artifacts/resilience-smoke');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = (index * 31 + (index >>> 12)) % 256;
  const hash = value => createHash('sha256').update(value).digest('hex');
  const requests = [], children = new Set(), messages = [];
  let phase = 'first', server;
  const report = { ok: false, version, portable, application, abruptProcessTermination: true, operatingSystemPowerLossTested: false, operatingSystemSettingsChanged: false };
  function start(mode, url) {
    const child = fork(fileURLToPath(import.meta.url), ['--worker', application, directory, mode, url], {
      execPath: executable, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', value => { stderr += value.toString(); });
    child.stdout.resume();
    child.on('error', error => messages.push({ mode, type: 'error', message: error.message }));
    child.on('message', message => messages.push({ mode, ...message }));
    child.on('exit', (code, signal) => { children.delete(child); report.workerExits ||= []; report.workerExits.push({ mode, code, signal, stderr }); });
    return child;
  }
  async function waitFor(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const failure = messages.find(message => message.type === 'error');
      if (failure) throw new Error(failure.message);
      const result = await predicate();
      if (result) return result;
      await delay(50);
    }
    throw new Error('Resilience check timed out');
  }
  try {
    server = createServer(async (request, response) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : payload.length - 1;
      requests.push({ phase, start, end });
      response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"sahm-resilience-fixture-v1"', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + payload.length } : {}) });
      for (let offset = start; offset <= end && !response.destroyed; offset += 16384) {
        response.write(payload.subarray(offset, Math.min(offset + 16384, end + 1)));
        if (end > start) await delay(20);
      }
      response.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await mkdir(join(directory, 'files'));
    const sentinel = Buffer.from('existing user file must survive');
    await writeFile(join(directory, 'files/existing.bin'), sentinel);
    const url = 'http://127.0.0.1:' + server.address().port + '/payload.bin';
    const first = start('first', url);
    const ready = await waitFor(() => messages.find(message => message.mode === 'first' && message.type === 'ready'));
    const checkpoint = await waitFor(async () => {
      let value;
      try { value = JSON.parse(await readFile(ready.job.path + '.resume.json', 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const received = value.parts.reduce((sum, part) => sum + part.done, 0);
      return received >= 256 * 1024 && received < payload.length ? { value, received } : null;
    });
    const exited = once(first, 'exit');
    first.kill('SIGKILL'); await exited;
    assert.ok(!messages.some(message => message.mode === 'first' && message.type === 'complete'));
    const persisted = JSON.parse(await readFile(join(directory, 'data/jobs.json'), 'utf8'));
    assert.equal(persisted[0].id, ready.job.id);
    assert.equal(persisted[0].status, 'downloading');
    phase = 'resume';
    const second = start('resume', url);
    const restored = await waitFor(() => messages.find(message => message.mode === 'resume' && message.type === 'ready'));
    assert.equal(restored.loaded[0].id, ready.job.id);
    assert.equal(restored.loaded[0].status, 'paused');
    const finished = await waitFor(() => messages.find(message => message.mode === 'resume' && message.type === 'complete'), 60000);
    if (second.exitCode === null) await once(second, 'exit');
    const actual = await readFile(finished.job.path);
    assert.equal(actual.length, payload.length);
    assert.equal(hash(actual), hash(payload));
    assert.deepEqual(await readFile(join(directory, 'files/existing.bin')), sentinel);
    const resumed = requests.filter(value => value.phase === 'resume' && value.end > value.start);
    assert.ok(resumed.some(value => checkpoint.value.parts.some(part => part.done > 0 && value.start === part.start + part.done)), 'Resume must use a persisted offset');
    report.ok = true;
    Object.assign(report, { jobId: ready.job.id, checkpointBytes: checkpoint.received, completedBytes: actual.length, sha256: hash(actual), recoveredStatus: restored.loaded[0].status, resumedAtPersistedOffset: true, existingUserFilePreserved: true, requests });
  } catch (error) { report.error = error.stack; }
  finally {
    for (const child of children) child.kill('SIGKILL');
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  }
  console.log('RESILIENCE ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
  if (!report.ok) process.exitCode = 1;
}
