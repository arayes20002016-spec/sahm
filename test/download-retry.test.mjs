import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { download } from '../src/download.mjs';
import { stressDownloadFixture } from '../scripts/lib/stress-download-fixture.mjs';

async function fixture(t) {
  const server = await stressDownloadFixture({ bytes: 256 * 1024, intervalMs: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'sahm-network-retry-'));
  t.after(async () => {
    await server.close();
    assert.equal(dirname(await realpath(directory)), await realpath(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, path: join(directory, 'file.bin') };
}

test('transient HTTP failures during the GET probe recover without a manual restart', async t => {
  const f = await fixture(t), source = f.add(1, 'unavailable');
  await download(source.url, f.path, { connections: 2 });
  assert.deepEqual(await readFile(f.path), source.payload);
  assert.equal(f.counters.unavailable, 2);
  assert.equal(f.requests.filter(request => request.probe).length, 3);
});

test('GET probe retries honor the configured limit', async t => {
  const f = await fixture(t), source = f.add(2, 'unavailable');
  await assert.rejects(download(source.url, f.path, { maxRetries: 1 }), /HTTP 503/);
  assert.equal(f.requests.length, 2);
  await assert.rejects(readFile(f.path + '.part'), { code: 'ENOENT' });
});

test('a failed POST is never replayed by GET probe retry handling', async t => {
  const f = await fixture(t), source = f.add(5, 'unavailable');
  await assert.rejects(download(source.url, f.path, { requestContext: { method: 'POST', bodyBase64: Buffer.from('one operation').toString('base64') } }), /HTTP 503/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].probe, false);
});

test('cancelling GET probe retry backoff promptly stops further requests', async t => {
  const f = await fixture(t), source = f.add(3, 'unavailable'), controller = new AbortController();
  const running = download(source.url, f.path, { signal: controller.signal });
  while (!f.requests.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancel probe'));
  await assert.rejects(running, /cancel probe/);
  assert.equal(f.requests.length, 1);
});

test('a dropped range resumes at written bytes and produces the complete original file', async t => {
  const f = await fixture(t), source = f.add(4, 'reset');
  await download(source.url, f.path, { connections: 1 });
  assert.equal(f.counters.resets, 1);
  assert.ok(f.requests.some(request => !request.probe && request.start > 0));
  assert.deepEqual(await readFile(f.path), source.payload);
});
