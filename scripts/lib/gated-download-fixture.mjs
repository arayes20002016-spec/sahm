import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Test-only server: a real prefix is delivered, but completion needs an explicit release.
export async function gatedDownloadFixture(data, { prefixBytes = 8192 } = {}) {
  assert.ok(Buffer.isBuffer(data) && data.length > prefixBytes);
  assert.ok(Number.isSafeInteger(prefixBytes) && prefixBytes > 0);
  const gates = new Map(), requests = [], errors = [];
  const gateFor = name => {
    if (!gates.has(name)) gates.set(name, { released: false, waiters: new Set() });
    return gates.get(name);
  };
  function hold(gate, response, request) {
    if (gate.released || response.destroyed) return Promise.resolve();
    return new Promise(resolve => {
      const wake = () => {
        gate.waiters.delete(wake); response.off('close', wake); request.held = false; resolve();
      };
      request.held = true; gate.waiters.add(wake); response.once('close', wake);
    });
  }
  function release(name) {
    const gate = gateFor(name); gate.released = true;
    for (const wake of [...gate.waiters]) wake();
  }
  const server = createServer((req, res) => {
    void respond(req, res).catch(error => { errors.push(error.message); res.destroy(); });
  });
  async function respond(req, res) {
    const name = new URL(req.url, 'http://fixture.invalid').pathname;
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : data.length - 1;
    if ((req.headers.range && !match) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= data.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); res.end(); return;
    }
    const probe = match && start === 0 && end === 0;
    const request = { name, start, end, probe: !!probe, held: false, finished: false, closed: false };
    requests.push(request);
    res.once('finish', () => { request.finished = true; }); res.once('close', () => { request.closed = true; });
    res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"window-v1"', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}) });
    if (req.method === 'HEAD' || probe) { res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1)); return; }
    const next = Math.min(start + prefixBytes, end + 1);
    res.write(data.subarray(start, next));
    if (next <= end) await hold(gateFor(name), res, request);
    if (!res.destroyed) res.end(data.subarray(next, end + 1));
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: 'http://127.0.0.1:' + server.address().port, requests, errors, release,
    held: name => [...requests].filter(request => request.name === name && request.held).length,
    async close() {
      server.closeAllConnections();
      for (const name of gates.keys()) release(name);
      await new Promise(resolve => server.close(resolve));
    },
  };
}
