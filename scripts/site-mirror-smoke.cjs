const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('node:http');
const { mkdtemp, mkdir, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, relative, extname, sep } = require('node:path');
const assert = require('node:assert/strict');

app.setPath('userData', join(tmpdir(), `sahm-mirror-browser-${process.pid}`));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sahm-mirror-offline-'));
  const reportDirectory = join(__dirname, '..', 'artifacts', 'site-mirror-smoke', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(reportDirectory, { recursive: true });
  const originalRequests = [], offlineRequests = [], remoteRequests = [];
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6F2nUAAAAASUVORK5CYII=', 'base64');
  let original, offline, window;
  try {
    original = createServer((req, res) => {
      originalRequests.push(req.url);
      if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body><h1 id="heading">Offline test</h1><img id="image" src="/pixel.png"><a id="next" href="/second">Second</a><script type="module" src="/main.js"></script></body></html>'); }
      if (req.url === '/second') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><body><h1 id="second">Second local page</h1><a href="/">Back</a></body></html>'); }
      if (req.url === '/main.css') { res.setHeader('Content-Type', 'text/css'); return res.end('@import "/nested.css"; body{font-family:sans-serif;background-image:url(/pixel.png)}'); }
      if (req.url === '/nested.css') { res.setHeader('Content-Type', 'text/css'); return res.end('#heading{color:rgb(12, 34, 56)}'); }
      if (req.url === '/main.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('import { text } from "./module.js"; document.body.dataset.module = text; fetch("https://example.invalid/offline-must-not-fetch").catch(() => document.body.dataset.blocked = "yes");'); }
      if (req.url === '/module.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('export const text = "module-loaded";'); }
      if (req.url === '/pixel.png') { res.setHeader('Content-Type', 'image/png'); return res.end(image); }
      res.writeHead(404); res.end();
    });
    await listen(original);
    const origin = `http://127.0.0.1:${original.address().port}`;
    const { runSiteMirror } = await import('../src/site-mirror.mjs');
    const result = await runSiteMirror(origin + '/', root);
    assert.equal(result.state, 'complete'); assert.equal(result.stats.files, 7);
    await close(original); original = null;
    offline = createServer(async (req, res) => {
      offlineRequests.push(req.url);
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const target = resolve(root, '.' + pathname), relation = relative(root, target);
        if (relation.startsWith('..' + sep) || relation === '..' || relation.split(sep).some(part => part.startsWith('.')) || relation.endsWith('sahm-mirror.json')) { res.writeHead(403); return res.end(); }
        const body = await readFile(pathname === '/' ? join(root, 'index.html') : target);
        const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }[extname(pathname)] || 'text/html; charset=utf-8';
        res.setHeader('Content-Type', type); res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await listen(offline);
    const offlineOrigin = `http://127.0.0.1:${offline.address().port}`;
    const browserSession = session.fromPartition(`mirror-smoke-${process.pid}`);
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const remote = /^https?:/.test(details.url) && new URL(details.url).origin !== offlineOrigin;
      if (remote) remoteRequests.push(details.url);
      callback({ cancel: remote });
    });
    window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    await window.loadURL(offlineOrigin + '/index.html');
    let state;
    for (let attempt = 0; attempt < 50; attempt++) {
      state = await window.webContents.executeJavaScript('({ module: document.body.dataset.module, blocked: document.body.dataset.blocked, image: document.querySelector("#image").naturalWidth, color: getComputedStyle(document.querySelector("#heading")).color, next: document.querySelector("#next").href })');
      if (state.module === 'module-loaded' && state.blocked === 'yes' && state.image === 1) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(state.module, 'module-loaded'); assert.equal(state.blocked, 'yes'); assert.equal(state.image, 1); assert.equal(state.color, 'rgb(12, 34, 56)');
    assert.equal(new URL(state.next).origin, offlineOrigin);
    await window.loadURL(state.next);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#second").textContent'), 'Second local page');
    assert.deepEqual(remoteRequests, []);
    const report = { ok: true, originalServerClosedBeforeBrowser: true, root, files: result.stats.files, bytes: result.stats.bytes, state, originalRequests, offlineRequests, remoteRequests };
    await writeFile(join(reportDirectory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, report: join(reportDirectory, 'result.json'), files: result.stats.files, externalRequests: remoteRequests.length }));
    window.destroy(); await close(offline); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    await writeFile(join(reportDirectory, 'result.json'), JSON.stringify({ ok: false, error: String(error.stack || error), originalRequests, offlineRequests, remoteRequests }, null, 2));
    window?.destroy(); if (original) await close(original); if (offline) await close(offline); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
