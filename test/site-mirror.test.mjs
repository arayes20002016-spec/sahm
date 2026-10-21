import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSiteMirror, readSiteMirror, normalizeMirrorOptions } from '../src/site-mirror.mjs';
import { parseRobots } from '../src/mirror-robots.mjs';
import { transformCss, transformModule } from '../src/mirror-document.mjs';

async function fixture(t, handler) {
  const requests = [], server = createServer((req, res) => { requests.push(req.url); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, server };
}
const directory = () => mkdtemp(join(tmpdir(), 'sahm-site-mirror-'));

test('mirrors pages, CSS imports, fonts, srcset, scripts and modules with local links and durable query identities', async t => {
  const f = await fixture(t, (req, res) => {
    const path = req.url;
    if (path === '/robots.txt') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\nAllow: /private/allowed'); }
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><base href="/"><link rel="stylesheet" href="/style.css"><a href="/two">two</a><a href="/private">private</a><img src="/image.png?size=1" srcset="/image.png?size=1 1x, /image.png?size=2 2x"><script type="module" src="/main.js"></script><iframe src="/two"></iframe><form action="https://outside.test/login"></form>'); }
    if (path === '/two') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<a href="/#hello">home</a><a href="https://outside.test/">outside</a><div style="background: url(/image.png?size=2)"></div>'); }
    if (path === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('@import "nested.css"; body { background: url("/image.png?size=1"); }'); }
    if (path === '/nested.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('@font-face{font-family:test;src:url(/font.woff2)}'); }
    if (path === '/main.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('import { x } from "./module.js"; console.log(x);'); }
    if (path === '/module.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('export const x = 1;'); }
    res.writeHead(200, { 'Content-Type': path.startsWith('/image') ? 'image/png' : 'font/woff2' }); res.end(path);
  });
  const root = await directory();
  let network = 0;
  const result = await runSiteMirror(f.url + '/', root, { fetchImpl: (url, options) => { network++; assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined); return fetch(url, options); } });
  assert.equal(result.state, 'partial'); // Out-of-scope and robots links are reported, never fetched.
  assert.equal(result.stats.files, 9);
  assert.equal(result.stats.pages, 2);
  assert.ok(network > 0);
  assert.ok(!f.requests.includes('/private'));
  assert.equal(f.requests.filter(item => item === '/two').length, 1);
  assert.ok(result.errors.some(item => item.reason === 'robots-disallowed'));
  const images = result.resources.filter(item => item.url.includes('/image.png'));
  assert.equal(images.length, 2); assert.notEqual(images[0].path, images[1].path);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /<base|integrity=|action=/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  for (const resource of result.resources.filter(item => item.state === 'complete')) {
    const content = await readFile(join(root, resource.path));
    if (/text\//.test(resource.contentType)) assert.doesNotMatch(content.toString(), /(?:href|src)="https?:\/\/|url\(["']?https?:\/\//);
  }
  const css = result.resources.find(item => item.url.endsWith('/style.css'));
  assert.match(await readFile(join(root, css.path), 'utf8'), /@import "\.\/[a-f0-9]+\.css"/);
  const js = result.resources.find(item => item.url.endsWith('/main.js'));
  assert.match(await readFile(join(root, js.path), 'utf8'), /from "\.\/[a-f0-9]+\.js"/);
  assert.equal((await readSiteMirror(root)).stats.files, 9);
});

test('manual redirect boundary rejects another origin before a request is sent there', async t => {
  let outside = 0;
  const other = await fixture(t, (req, res) => { outside++; res.end('outside'); });
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<a href="/redirect">redirect</a>'); }
    res.writeHead(302, { Location: other.url + '/escape' }); res.end();
  });
  const result = await runSiteMirror(f.url, await directory());
  assert.equal(outside, 0); assert.ok(result.errors.some(item => item.reason === 'outside-origin'));
});

test('pause persists complete files and restart only fetches unfinished resources', async t => {
  const controller = new AbortController();
  let triggered = false;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<a href="/a">a</a><a href="/slow">slow</a>'); }
    if (req.url === '/slow') {
      res.setHeader('Content-Type', 'text/html'); res.write('<html>');
      if (!triggered) { triggered = true; setTimeout(() => controller.abort(), 30); }
      return setTimeout(() => res.end('finished</html>'), 400);
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<a href="/">home</a>');
  });
  const root = await directory();
  const first = await runSiteMirror(f.url, root, { signal: controller.signal, options: { concurrency: 1 } });
  assert.equal(first.state, 'paused'); assert.equal(first.stats.files, 2);
  assert.match(await readFile(join(root, 'index.html'), 'utf8'), /html/);
  const rootRequests = f.requests.filter(item => item === '/').length, completedRequests = f.requests.filter(item => item === '/a').length;
  const resumed = await runSiteMirror(f.url, root);
  assert.equal(resumed.state, 'complete'); assert.equal(resumed.stats.files, 3);
  assert.equal(f.requests.filter(item => item === '/').length, rootRequests);
  assert.equal(f.requests.filter(item => item === '/a').length, completedRequests);
  assert.equal(f.requests.filter(item => item === '/slow').length, 2);
});

test('limits, filter patterns and robots selection prevent unbounded crawling', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /all\nUser-agent: SAHM\nDisallow: /specific\nAllow: /specific/open');
    res.setHeader('Content-Type', 'text/html'); res.end('<a href="/docs/a">a</a><a href="/docs/b">b</a><a href="/other">other</a><a href="/specific">specific</a><img src="/big.bin">');
  });
  const result = await runSiteMirror(f.url, await directory(), { options: { depth: 1, maxPages: 2, include: ['/docs/*'], exclude: ['/big.*'] } });
  assert.equal(result.stats.pages, 2);
  assert.ok(!f.requests.includes('/other')); assert.ok(!f.requests.includes('/big.bin'));
  assert.ok(result.errors.some(item => item.reason === 'page-limit'));
  const allowed = parseRobots('User-agent: *\nDisallow: /all\nUser-agent: SAHM\nDisallow: /specific\nAllow: /specific/open');
  assert.equal(allowed(f.url + '/all'), true); assert.equal(allowed(f.url + '/specific'), false); assert.equal(allowed(f.url + '/specific/open'), true);
  assert.throws(() => normalizeMirrorOptions({ concurrency: 99 }));
});

test('byte budgets account concurrent bodies and no credential URL reaches transport or manifest', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<img src="/a.bin"><img src="/b.bin"><a href="/secret?token=hidden">secret</a>'); }
    res.end(Buffer.alloc(800));
  });
  const root = await directory();
  const result = await runSiteMirror(f.url, root, { options: { maxBytes: 1200, maxFileBytes: 1024 } });
  assert.ok(result.stats.bytes <= 1200); assert.ok(result.errors.some(item => item.reason === 'total-byte-limit'));
  assert.ok(!f.requests.some(item => item.includes('token')));
  assert.doesNotMatch(await readFile(join(root, 'sahm-mirror.json'), 'utf8'), /hidden/);
  await assert.rejects(runSiteMirror(f.url + '/?token=hidden', await directory()), /بيانات دخول/);
  await assert.rejects(runSiteMirror('https://user:password@example.test/', await directory()), /بيانات دخول/);
});

test('rejects forged checkpoints and raw paths outside the selected directory', async () => {
  const root = await directory();
  await writeFile(join(root, 'sahm-mirror.json'), JSON.stringify({ version: 1, entryPath: 'index.html', rootUrl: 'https://example.test/', options: {}, resources: [{ id: 'bad', url: 'https://example.test/', kind: 'page', depth: 0, bytes: 1, rawPath: '../outside' }] }));
  await assert.rejects(readSiteMirror(root), /سجل ملفات/);
});

test('rewrites CSS and static modules without treating comment or ordinary string contents as downloads', () => {
  const found = [];
  const resolve = address => { found.push(address); return './local'; };
  const css = transformCss('/* url(no) */ a{content:"url(no)"; background: url(image\\).png)} @import "nested.css";', resolve);
  assert.deepEqual(found, ['image).png', 'nested.css']);
  assert.match(css, /content:"url\(no\)"/);
  found.length = 0;
  const js = transformModule('const s = "import \'./no.js\'"; /* import "./no.js" */ import { x } from "./yes.js"; import("./lazy.js"); export {x} from "./export.js";', resolve);
  assert.deepEqual(found, ['./yes.js', './lazy.js', './export.js']);
  assert.match(js, /const s = "import '\.\/no.js'"/);
});

test('raising crawl limits resumes retained originals and does not hide excluded-link reports', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<a href="/a">a</a><a href="https://outside.test/">outside</a>');
  });
  const root = await directory();
  const first = await runSiteMirror(f.url, root, { options: { depth: 0 } });
  assert.equal(first.stats.pages, 1); assert.ok(first.errors.some(item => item.reason === 'depth-limit'));
  const second = await runSiteMirror(f.url, root, { options: { depth: 1 } });
  assert.equal(second.stats.pages, 2); assert.ok(second.errors.some(item => item.reason === 'outside-origin'));
  assert.equal(f.requests.filter(item => item === '/').length, 1);
});

test('new copies require an empty directory and keep existing user files intact', async () => {
  const root = await directory();
  await writeFile(join(root, 'index.html'), 'user file');
  await assert.rejects(runSiteMirror('https://example.test/', root), /مجلدًا فارغًا/);
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), 'user file');
});

test('SVG subresources are mirrored and legacy character sets become valid UTF-8 documents', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=windows-1252');
      return res.end(Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p><img src="/drawing.svg">', 'latin1'));
    }
    if (req.url === '/drawing.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg"><image href="/pixel.png"/></svg>'); }
    res.setHeader('Content-Type', 'image/png'); res.end('image');
  });
  const root = await directory(), result = await runSiteMirror(f.url, root);
  assert.equal(result.stats.files, 3);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /café/); assert.match(html, /charset="utf-8"/);
  const svg = result.resources.find(item => item.url.endsWith('.svg'));
  const document = await readFile(join(root, svg.path), 'utf8');
  assert.match(document, /^<svg/); assert.match(document, /href="\.\/[a-f0-9]+\.png"/);
});
