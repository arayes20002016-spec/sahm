import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { download } from '../src/download.mjs';
import { setTransportFetch } from '../src/transport.mjs';
import { QuotaStore } from '../src/quota.mjs';

test('real ranged download checkpoints its quota boundary and resumes identical bytes after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-quota-resume-'));
  const payload = Buffer.from(Array.from({ length: 10000 }, (_, index) => index % 251));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.range);
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    assert.ok(range);
    const start = Number(range[1]), end = Number(range[2]);
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': end - start + 1, etag: '"quota-fixture-v1"' });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    setTransportFetch(globalThis.fetch);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/file.bin`;
  const path = join(directory, 'result.bin');
  const quota = await new QuotaStore(directory).init();
  await quota.configure({ enabled: true, limitBytes: 4000, periodHours: 24 });
  setTransportFetch(quota.wrapFetch(globalThis.fetch));
  await assert.rejects(download(url, path, { connections: 1 }), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  const checkpoint = JSON.parse(await readFile(path + '.resume.json', 'utf8'));
  assert.equal(checkpoint.parts.reduce((sum, part) => sum + part.done, 0), 4000);
  assert.equal(quota.snapshot().usedBytes, 4000);
  assert.deepEqual((await readFile(path + '.part')).subarray(0, 4000), payload.subarray(0, 4000));
  const restored = await new QuotaStore(directory).init();
  await restored.configure({ enabled: true, limitBytes: 10000, periodHours: 24 });
  setTransportFetch(restored.wrapFetch(globalThis.fetch));
  await download(url, path, { connections: 1 });
  assert.deepEqual(await readFile(path), payload);
  assert.equal(restored.snapshot().usedBytes, 10000);
  assert.equal(requests.at(-1), 'bytes=4000-9999');
});
