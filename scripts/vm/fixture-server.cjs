const http = require('node:http');
const bytes = Buffer.alloc(2 * 1024 * 1024, 'SAHM VM installer acceptance\n');
http.createServer(async (req, res) => {
  if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
  if (req.url === '/site') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>SAHM VM snapshot</title><p>Offline fixture</p>'); return; }
  if (req.method === 'POST') { res.writeHead(409); res.end('POST must not be replayed'); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1;
  res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"sahm-vm-v1"', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
  for (let offset = start; offset <= end && !res.destroyed; offset += 8192) { res.write(bytes.subarray(offset, Math.min(end + 1, offset + 8192))); await new Promise(resolve => setTimeout(resolve, 5)); }
  res.end();
}).listen(18080, '127.0.0.1');
