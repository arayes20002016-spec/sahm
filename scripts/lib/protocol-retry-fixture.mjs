import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ftpFixture } from '../../test/helpers/ftp-fixture.mjs';
import { generateStreamFixture } from '../../test/helpers/stream-fixture.mjs';
import { stressPayload } from './stress-download-fixture.mjs';

export async function protocolRetryFixture(directory, runtimeDirectory) {
  const cleanup = [], ftp = await ftpFixture({ after: close => cleanup.push(close) }, { held: true, chunkDelay: 4 });
  const ftpBytes = stressPayload(2100, 1024 * 1024); ftp.change(ftpBytes);
  await generateStreamFixture(directory, runtimeDirectory);
  const streams = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) streams.set('/' + entry.name, await readFile(join(directory, entry.name)));
  const requests = [], sockets = new Set(), waiters = new Set();
  let offline = false, held = true;
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => response.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  async function serve(request, response) {
    const path = new URL(request.url, 'http://fixture.invalid').pathname, body = streams.get(path);
    const record = { path, method: request.method, range: request.headers.range || null, at: Date.now(), bytes: 0, status: 0 }; requests.push(record);
    if (offline) { record.status = 503; response.writeHead(503).end(); return; }
    if (!body) { record.status = 404; response.writeHead(404).end(); return; }
    const manifest = ['.m3u8', '.mpd'].includes(extname(path));
    let start = 0, end = body.length - 1;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (match) { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
    if (start > end || start >= body.length) { record.status = 416; response.writeHead(416).end(); return; }
    record.status = match ? 206 : 200;
    response.writeHead(record.status, { 'Content-Type': path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream',
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
    if (request.method === 'HEAD') { response.end(); return; }
    for (let offset = start; offset <= end && !response.destroyed; offset += 8192) {
      // Explicit gates keep real partial transfers alive while the other
      // protocol starts; an observation delay cannot finish the transfer.
      if (!manifest && held && record.bytes >= 32768) await new Promise(resolve => {
        const wake = () => { waiters.delete(wake); response.off('close', wake); resolve(); };
        waiters.add(wake); response.once('close', wake);
      });
      if (response.destroyed) break;
      const chunk = body.subarray(offset, Math.min(offset + 8192, end + 1)); response.write(chunk); record.bytes += chunk.length;
      if (!manifest) await delay(4);
    }
    if (!response.destroyed) response.end();
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    ftp, ftpBytes, requests, origin: 'http://127.0.0.1:' + server.address().port,
    hold() { assert.equal(waiters.size, 0); held = true; ftp.hold(); },
    release() { held = false; for (const wake of [...waiters]) wake(); ftp.release(); },
    interrupt() { offline = true; ftp.interrupt(); server.closeAllConnections(); },
    reconnect() { offline = false; ftp.reconnect(); },
    get heldMediaTransfers() { return waiters.size; },
    async close() {
      held = false; for (const wake of [...waiters]) wake();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      for (const close of cleanup) await close();
    },
  };
}
