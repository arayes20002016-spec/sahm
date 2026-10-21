import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { MediaService } from '../src/media.mjs';
import { isTransientNetworkError } from '../src/network-retry.mjs';
import { prepareStream } from '../src/stream-media.mjs';
import { setTransportFetch } from '../src/transport.mjs';

test('a denied manifest keeps its HTTP status even when cancelling its failed body rejects', async () => {
  setTransportFetch(async () => new Response(new ReadableStream({ start(controller) {
    controller.error(Object.assign(new Error('premature response close'), { code: 'UND_ERR_SOCKET' }));
  } }), { status: 403 }));
  try { await assert.rejects(prepareStream('https://fixture.invalid/denied.m3u8'), error => error.status === 403 && !isTransientNetworkError(error)); }
  finally { setTransportFetch((input, init) => globalThis.fetch(input, init)); }
});

for (const mode of ['forbidden', 'rate', 'unavailable', 'invalid-bytes', 'postprocess']) test(`stream gateway preserves ${mode} instead of treating every local 502 as a network failure`, async t => {
  const server = createServer((request, response) => {
    if (request.url === '/video.m3u8') {
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n'); return;
    }
    if (mode === 'invalid-bytes') { response.end('not a media container'); return; }
    response.writeHead(mode === 'forbidden' ? 403 : mode === 'rate' ? 429 : 503, mode === 'rate' ? { 'Retry-After': '60' } : {}); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'sahm-stream-failure-'));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true });
  });
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 1; child.exitCode = null;
    setImmediate(async () => {
      try {
        const manifest = await fetch(args.at(-1)).then(response => response.text());
        const address = manifest.split('\n').find(line => line && !line.startsWith('#'));
        const response = await fetch(address); await response.arrayBuffer(); assert.equal(response.status, 502);
        child.stderr.end(mode === 'postprocess' ? 'ERROR: Postprocessing failed: No space left on device' : 'ERROR: fragment 1 not found, unable to continue');
        child.stdout.end(); child.exitCode = 1; child.emit('close', 1);
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  const service = new MediaService({ verifyRuntime: false, spawnProcess }); t.after(() => service.close());
  const error = await service.download(`http://127.0.0.1:${server.address().port}/video.m3u8`, join(directory, 'result.mkv')).then(() => null, error => error);
  assert.ok(error);
  assert.equal(isTransientNetworkError(error), ['rate', 'unavailable'].includes(mode));
  if (mode === 'forbidden') assert.equal(error.status, 403);
  if (mode === 'rate') { assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 60000); }
  if (mode === 'invalid-bytes') assert.equal(error.code, 'unsafe-media-content');
  if (mode === 'postprocess') assert.equal(error.code, 'media-output-failed');
});
