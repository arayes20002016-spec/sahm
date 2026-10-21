import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { download } from '../src/download.mjs';
import { DownloadManager } from '../src/manager.mjs';

const payload = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-crash-recovery-')), requests = [], cleanup = [];
  let version = 'v1';
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : payload.length - 1;
    requests.push({ start, end });
    res.writeHead(match ? 206 : 200, { 'ETag': `"${version}"`, 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) });
    res.end(version === 'v1' ? payload.subarray(start, end + 1) : Buffer.alloc(end - start + 1, 17));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const close of cleanup.reverse()) await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, requests, url: `http://127.0.0.1:${server.address().port}/file.bin`, change: () => { version = 'v2'; }, onCleanup: close => cleanup.push(close) };
}

async function wait(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error('Recovery test timed out');
}

function worker(f, phase) {
  const child = fork(new URL('../scripts/lib/recovery-worker.mjs', import.meta.url), [f.directory, f.url, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const events = [];
  let errors = '';
  child.stdout.resume(); child.stderr.on('data', chunk => { errors += chunk; });
  child.on('message', message => events.push(message));
  f.onCleanup(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  return { child, events, check: () => { assert.equal(child.exitCode, null, errors); } };
}

test('forced termination retains job history and resumes flushed HTTP ranges to identical bytes', { timeout: 30000 }, async t => {
  const f = await fixture(t), w = worker(f, 'transfer');
  const job = await wait(() => { w.check(); return w.events.find(event => event.event === 'job')?.job; });
  const checkpoint = await wait(async () => {
    w.check();
    try { const state = JSON.parse(await readFile(job.path + '.resume.json', 'utf8')); return state.parts.reduce((sum, part) => sum + part.done, 0) > 128 * 1024 ? state : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  });
  const exit = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exit;
  const before = await readFile(job.path + '.part');
  for (const part of checkpoint.parts) assert.deepEqual(before.subarray(part.start, part.start + part.done), payload.subarray(part.start, part.start + part.done));
  const manager = await new DownloadManager(join(f.directory, 'profile'), f.directory).init();
  f.onCleanup(() => manager.close());
  assert.equal(manager.jobs.length, 1); assert.equal(manager.jobs[0].status, 'paused');
  f.requests.length = 0;
  await manager.action(job.id, 'resume');
  await wait(() => { const current = manager.jobs[0]; assert.notEqual(current.status, 'error', current.error); return current.status === 'complete'; });
  assert.deepEqual(await readFile(job.path), payload);
  assert.ok(f.requests.some(request => checkpoint.parts.some(part => part.done > 0 && request.start >= part.start + part.done && request.start <= part.end)), 'Resume must use saved offsets');
  await manager.close();
});

for (const phase of ['published-link', 'partial-unlinked']) {
  test(`termination after ${phase} recovers a published file without another network request`, { timeout: 30000 }, async t => {
    const f = await fixture(t), w = worker(f, phase), target = join(f.directory, 'transfer.bin');
    await wait(() => { w.check(); return w.events.some(event => event.event === phase); });
    const exit = once(w.child, 'exit'); w.child.kill('SIGKILL'); await exit;
    assert.deepEqual(await readFile(target), payload);
    f.requests.length = 0;
    assert.deepEqual(await download(f.url, target), { path: target, bytes: payload.length });
    assert.equal(f.requests.length, 0);
    await assert.rejects(readFile(target + '.resume.json'), { code: 'ENOENT' });
    await assert.rejects(readFile(target + '.part'), { code: 'ENOENT' });
  });
}

test('after a crash, a changed remote version preserves old partial data before starting afresh', { timeout: 30000 }, async t => {
  const f = await fixture(t), target = join(f.directory, 'transfer.bin');
  const controller = new AbortController();
  await assert.rejects(download(f.url, target, { connections: 1, signal: controller.signal, onProgress: () => controller.abort() }));
  const old = await readFile(target + '.part');
  f.change();
  await download(f.url, target);
  assert.deepEqual(await readFile(target), Buffer.alloc(payload.length, 17));
  const stale = (await readdir(f.directory)).find(file => file.startsWith('transfer.bin.part.stale-'));
  assert.ok(stale); assert.deepEqual(await readFile(join(f.directory, stale)), old);
});

test('an unrelated existing destination survives a complete download and is never replaced', async t => {
  const f = await fixture(t), target = join(f.directory, 'transfer.bin');
  const original = Buffer.from('user file'); await writeFile(target, original);
  await assert.rejects(download(f.url, target), { code: 'EEXIST' });
  assert.deepEqual(await readFile(target), original);
  await assert.rejects(download(f.url, target), { code: 'EEXIST' });
  assert.deepEqual(await readFile(target), original);
});
