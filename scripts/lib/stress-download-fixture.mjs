import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export function stressPayload(serial, bytes = 4 * 1024 * 1024) {
  const block = Buffer.alloc(4096);
  for (let index = 0; index < block.length; index++) block[index] = (index * 17 + serial * 31) % 251;
  const data = Buffer.alloc(bytes, block);
  for (let offset = 0; offset + 8 <= bytes; offset += block.length) {
    data.writeUInt32LE(offset / block.length, offset); data.writeUInt32LE(serial >>> 0, offset + 4);
  }
  return data;
}

// Faults affect this loopback server only, never the host's network settings.
export async function stressDownloadFixture({ bytes = 4 * 1024 * 1024, intervalMs = 8 } = {}) {
  const entries = new Map(), requests = [], sockets = new Set();
  const counters = { resets: 0, unavailable: 0, offlineRequests: 0, sentBytes: 0, peakConnections: 0 };
  let offline = false;
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => response.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket); counters.peakConnections = Math.max(counters.peakConnections, sockets.size);
    socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
  });
  async function respond(request, response) {
    const name = new URL(request.url, 'http://fixture.invalid').pathname, entry = entries.get(name);
    if (!entry) { response.writeHead(404); response.end(); return; }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const ranged = entry.mode !== 'plain' && !!match;
    const start = ranged ? Number(match[1]) : 0, end = ranged && match[2] ? Number(match[2]) : bytes - 1;
    if (end < start || end >= bytes || !Number.isSafeInteger(start) || start < 0) { response.writeHead(416); response.end(); return; }
    const probe = ranged && start === 0 && end === 0;
    const record = { name, method: request.method, start, end, probe, status: 0, bytes: 0, at: Date.now() };
    requests.push(record);
    if (offline) { counters.offlineRequests++; record.fault = 'offline'; request.socket.destroy(); return; }
    if (entry.mode === 'unavailable' && entry.failures++ < 2) {
      counters.unavailable++; record.status = 503; response.writeHead(503); response.end(); return;
    }
    const data = entry.payload;
    record.status = ranged ? 206 : 200;
    response.writeHead(record.status, { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
      ...(entry.mode !== 'plain' ? { ETag: '"stress-' + entry.serial + '"', 'Accept-Ranges': 'bytes' } : {}),
      ...(ranged ? { 'Content-Range': `bytes ${start}-${end}/${bytes}` } : {}) });
    if (probe) { response.end(data.subarray(0, 1)); record.bytes = 1; counters.sentBytes++; return; }
    for (let offset = start; offset <= end && !response.destroyed; offset += 8192) {
      if (entry.held && record.bytes >= 65536) {
        await new Promise(resolve => {
          const wake = () => { entry.waiters.delete(wake); response.off('close', wake); resolve(); };
          entry.waiters.add(wake); response.once('close', wake);
        });
      }
      if (response.destroyed) break;
      const chunk = data.subarray(offset, Math.min(offset + 8192, end + 1));
      response.write(chunk); record.bytes += chunk.length; counters.sentBytes += chunk.length;
      if (entry.mode === 'reset' && !entry.reset && record.bytes >= 65536) {
        entry.reset = true; counters.resets++; record.fault = 'reset'; response.socket.destroy(); return;
      }
      await delay(intervalMs);
    }
    if (!response.destroyed) response.end();
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  function release() {
    for (const entry of entries.values()) { entry.held = false; for (const wake of [...entry.waiters]) wake(); }
  }
  return {
    origin, counters, requests,
    add(serial, mode, held = false) {
      assert.ok(Number.isSafeInteger(serial) && serial >= 0);
      assert.ok(['stable', 'reset', 'unavailable', 'plain'].includes(mode));
      const name = '/file/' + serial + '/' + mode + '.bin';
      assert.ok(!entries.has(name));
      const payload = stressPayload(serial, bytes);
      entries.set(name, { serial, mode, payload, failures: 0, reset: false, held, waiters: new Set() });
      return { url: origin + name, name, payload };
    },
    release,
    interrupt() { offline = true; server.closeAllConnections(); },
    reconnect() { offline = false; },
    forget(names) { for (const name of names) entries.delete(name); },
    async close() { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
