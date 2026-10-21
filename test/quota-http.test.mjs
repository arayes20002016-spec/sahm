import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QuotaStore } from '../src/quota.mjs';

test('real HTTP POST is sent once and payload is bounded durably across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-quota-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let posts = 0, methods = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method);
    if (request.method === 'POST') {
      posts++;
      let body = ''; for await (const chunk of request) body += chunk;
      assert.equal(body, 'one-time export');
    }
    response.writeHead(200, { 'content-length': '10000', 'content-type': 'application/octet-stream' });
    response.end(Buffer.alloc(10000, 42));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/export`;
  const store = await new QuotaStore(directory).init();
  await store.configure({ enabled: true, limitBytes: 1234, periodHours: 24 });
  const response = await store.wrapFetch(fetch)(url, { method: 'POST', body: 'one-time export', redirect: 'manual' });
  assert.equal(response.url, url); assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let received = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; received += value.byteLength; } }
  catch (error) { assert.equal(error.code, 'DOWNLOAD_QUOTA_EXCEEDED'); }
  assert.equal(received, 1234); assert.equal(posts, 1);
  const restored = await new QuotaStore(directory).init();
  assert.equal(restored.snapshot().usedBytes, received);
  await assert.rejects(restored.wrapFetch(fetch)(url), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  assert.deepEqual(methods, ['POST']);
});
