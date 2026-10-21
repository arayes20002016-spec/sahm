import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>SAHM media browser fixture</title>
<style>body{font:16px Segoe UI,sans-serif;background:#edf0f4;color:#173045;margin:32px}video{display:block;width:640px;height:360px;background:#172432}#player{width:640px;position:relative}#player:fullscreen{width:100%;height:100%;background:#172432}#player:fullscreen video{width:100%;height:100%}button{padding:8px 14px;margin:10px 8px 10px 0;font:inherit}</style>
<h1>SAHM media browser fixture</h1><p>Public CC0 flower sample from MDN. No credentials.</p>
<div id="player"><video id="video" controls preload="metadata" src="/media/direct.mp4"></video><div id="controls-layer" style="display:none;position:absolute;inset:0" aria-label="Player controls layer"></div></div>
<button id="dynamic">Add dynamic video</button><button id="fullscreen">Enter fullscreen</button>
<script>
document.getElementById('dynamic').onclick=()=>{const video=document.createElement('video');video.id='dynamic-video';video.controls=true;video.preload='metadata';const source=document.createElement('source');source.type='video/mp4';source.src='/media/dynamic.mp4';video.append(source);document.body.append(video)};
document.getElementById('fullscreen').onclick=()=>document.getElementById('player').requestFullscreen();
</script></html>`;

export async function startMediaFixture({ streamDirectory } = {}) {
  let payload = null;
  const requests = [];
  const streams = new Map();
  if (streamDirectory) {
    for (const entry of await readdir(streamDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-zA-Z0-9_-]+\.(?:m3u8|mpd|ts|mp4|m4s|webm)$/.test(entry.name)) streams.set(`/stream/${entry.name}`, await readFile(join(streamDirectory, entry.name)));
    }
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
      return;
    }
    const stream = streams.get(url.pathname);
    const bytes = stream || (/^\/media\/[a-z-]+\.mp4$/.test(url.pathname) ? payload : null);
    if (!bytes) {
      response.writeHead(404); response.end(); return;
    }
    requests.push({ method: request.method, path: url.pathname, range: request.headers.range || null });
    const mime = url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : url.pathname.endsWith('.mpd') ? 'application/dash+xml' : url.pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    response.setHeader('Content-Type', mime);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', '"sahm-local-generated-media"');
    response.setHeader('Cache-Control', 'no-store');
    let start = 0, end = bytes.length - 1;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (match) {
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= bytes.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return;
      }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    }
    response.setHeader('Content-Length', end - start + 1);
    response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    setPayload(bytes) {
      payload = Buffer.from(bytes);
      return { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
    },
    get payload() { return payload; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}


