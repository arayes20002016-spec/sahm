import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { gatedDownloadFixture } from '../scripts/lib/gated-download-fixture.mjs';
import { DownloadManager } from '../src/manager.mjs';

async function wait(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error('Controlled download fixture condition timed out');
}
const data = Buffer.alloc(256 * 1024, 'gated native-window regression\n');

test('range probes bypass the body barrier, and cancellation releases held HTTP responses', async t => {
  const fixture = await gatedDownloadFixture(data);
  t.after(() => fixture.close());
  const probe = await fetch(fixture.origin + '/one', { headers: { Range: 'bytes=0-0' } });
  assert.equal(probe.status, 206); assert.deepEqual(Buffer.from(await probe.arrayBuffer()), data.subarray(0, 1));
  const controller = new AbortController();
  const response = await fetch(fixture.origin + '/one', { signal: controller.signal });
  const reader = response.body.getReader();
  let received = 0;
  while (received < 8192) { const chunk = await reader.read(); assert.equal(chunk.done, false); received += chunk.value.byteLength; }
  assert.equal(received, 8192);
  assert.equal(fixture.held('/one'), 1);
  for (let i = 0; i < 20; i++) await nextTurn();
  assert.equal(fixture.requests.at(-1).finished, false);
  controller.abort(); await reader.cancel().catch(() => {});
  await wait(() => fixture.held('/one') === 0 && fixture.requests.at(-1).closed);
  assert.deepEqual(fixture.errors, []);
});

test('controlled transfers hold through delayed observation, finish the peer while paused, and resume saved ranges', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-window-fixture-'));
  const fixture = await gatedDownloadFixture(data);
  const manager = await new DownloadManager(join(directory, 'profile'), join(directory, 'downloads')).init();
  t.after(async () => { await manager.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const one = await manager.add({ url: fixture.origin + '/one', name: 'one.bin', connections: 2 });
  const two = await manager.add({ url: fixture.origin + '/two', name: 'two.bin', connections: 2 });
  await wait(() => manager.list().every(job => job.status === 'downloading' && job.received > 0) && fixture.held('/one') > 0 && fixture.held('/two') > 0);
  for (let i = 0; i < 20; i++) await nextTurn();
  assert.ok(manager.list().every(job => job.received < data.length && job.status === 'downloading'));
  await manager.action(one.id, 'pause');
  const checkpoint = JSON.parse(await readFile(one.path + '.resume.json', 'utf8'));
  fixture.release('/two');
  await wait(() => manager.list().find(job => job.id === two.id).status === 'complete');
  assert.equal(manager.list().find(job => job.id === one.id).status, 'paused');
  assert.deepEqual(await readFile(two.path), data);
  await wait(() => fixture.held('/one') === 0);
  const beforeResume = fixture.requests.length;
  await manager.action(one.id, 'resume');
  await wait(() => fixture.requests.slice(beforeResume).some(request => request.name === '/one' && !request.probe && checkpoint.parts.some(part => part.done > 0 && request.start === part.start + part.done)));
  assert.ok(manager.list().find(job => job.id === one.id).received < data.length);
  fixture.release('/one');
  await wait(() => manager.list().every(job => job.status === 'complete'));
  assert.deepEqual(await readFile(one.path), data);
  assert.deepEqual(fixture.errors, []);
});
