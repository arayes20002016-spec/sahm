import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, relative, sep } from 'node:path';

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function privatePath(path) {
  return path.split(/[\\/]/).some(part => {
    const normalized = part.replace(/[. ]+$/g, '').toLowerCase();
    return part.startsWith('.') || part.includes(':') || normalized === 'sahm-mirror.json';
  });
}
export async function serveOfflineSite(directory, entryPath = 'index.html') {
  const root = await realpath(directory);
  const token = randomBytes(24).toString('hex');
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      if (request.headers.host !== `127.0.0.1:${server.address().port}`) { response.writeHead(403); response.end(); return; }
      const address = new URL(request.url, 'http://127.0.0.1');
      if (!address.pathname.startsWith(`/${token}/`)) { response.writeHead(404); response.end(); return; }
      const path = decodeURIComponent(address.pathname.slice(token.length + 2)) || entryPath;
      if (privatePath(path)) { response.writeHead(404); response.end(); return; }
      const filename = await realpath(resolve(root, path));
      if (!filename.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
      if (privatePath(relative(root, filename))) { response.writeHead(404); response.end(); return; }
      const info = await stat(filename);
      if (!info.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(filename).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'",
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(filename).on('error', () => response.destroy()).pipe(response);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/${token}/${entryPath}`, prefix: `${origin}/${token}/`, close: () => { server.closeAllConnections(); return new Promise(resolveClose => server.close(resolveClose)); } };
}
