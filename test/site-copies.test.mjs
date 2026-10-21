import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteCopies } from '../src/site-copies.mjs';

async function fixture(t, handler) {
  const requests = [], server = createServer((req, res) => { requests.push(req.url); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function directory() { return mkdtemp(join(tmpdir(), 'sahm-site-copies-')); }
async function waitFor(predicate, message = 'site copy state') {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(`Timed out: ${message}`);
}
async function manager(t, root, fetchImpl = fetch) {
  const copies = await new SiteCopies(join(root, 'state'), join(root, 'downloads'), { fetchImpl }).init();
  const close = copies.close.bind(copies);
  let closing;
  copies.close = () => closing ||= close();
  t.after(() => copies.close());
  return copies;
}

test('site-copy manager limits work to two active jobs and starts a queued copy when a slot opens', async t => {
  const blocked = new Map();
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.write('<html>'); blocked.set(req.url, () => res.end('done</html>'));
  });
  const copies = await manager(t, await directory());
  const first = await copies.add({ url: f.url + '/a' }), second = await copies.add({ url: f.url + '/b' }), third = await copies.add({ url: f.url + '/c' });
  await waitFor(() => blocked.size === 2);
  assert.equal(copies.active.size, 2); assert.equal(copies.list().find(job => job.id === third.id).state, 'queued');
  assert.ok(!f.requests.includes('/c'));
  blocked.get('/a')();
  await waitFor(() => blocked.has('/c'));
  assert.equal(copies.active.size, 2);
  blocked.get('/b')(); blocked.get('/c')();
  await waitFor(() => copies.active.size === 0);
  assert.ok(copies.list().every(job => job.state === 'complete'));
  assert.notEqual(first.directory, second.directory);
});

test('pause and restart preserve completed pages, and resume completes the remaining response', async t => {
  let slowStarted = false;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/slow') { slowStarted = true; res.write('<html>'); return setTimeout(() => res.end('slow</html>'), 350); }
    res.end('<a href="/slow">slow</a>');
  });
  const root = await directory(), copies = await manager(t, root);
  const job = await copies.add({ url: f.url, options: { concurrency: 1 } });
  await waitFor(() => slowStarted);
  await copies.action(job.id, 'pause');
  assert.equal(copies.list()[0].state, 'paused');
  assert.match(await readFile(join(job.directory, 'index.html'), 'utf8'), /slow/);
  await copies.close();
  const restored = await manager(t, root);
  assert.equal(restored.list()[0].state, 'paused'); assert.equal(restored.active.size, 0);
  await restored.action(job.id, 'resume');
  await waitFor(() => restored.list()[0].state === 'complete');
  assert.equal(f.requests.filter(path => path === '/').length, 1);
  assert.deepEqual(await restored.entry(job.id), { directory: job.directory, entryPath: 'index.html' });
});

test('closing suspends active jobs and startup normalizes interrupted running jobs to paused', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.write('<html>');
  });
  const root = await directory(), copies = await manager(t, root);
  const job = await copies.add({ url: f.url });
  await waitFor(() => f.requests.includes('/'));
  await copies.close();
  assert.equal(copies.list()[0].state, 'paused'); assert.equal(copies.active.size, 0);
  const persisted = JSON.parse(await readFile(join(root, 'state', 'site-copies.json'), 'utf8'));
  persisted[0].state = 'running';
  await writeFile(join(root, 'state', 'site-copies.json'), JSON.stringify(persisted));
  const restored = await manager(t, root);
  assert.equal(restored.list()[0].id, job.id); assert.equal(restored.list()[0].state, 'paused'); assert.equal(restored.active.size, 0);
});

test('removing history keeps all saved files and refuses resuming over an unrelated folder', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end('<p>saved</p>');
  });
  const root = await directory(), copies = await manager(t, root);
  const job = await copies.add({ url: f.url });
  await waitFor(() => copies.list()[0].state === 'complete');
  await copies.action(job.id, 'remove');
  assert.deepEqual(copies.list(), []); assert.match(await readFile(join(job.directory, 'index.html'), 'utf8'), /saved/);
  const userFolder = join(root, 'my-files'); await mkdir(userFolder); await writeFile(join(userFolder, 'index.html'), 'user file');
  copies.jobs.push({ ...job, id: 'existing-user-folder', directory: userFolder, state: 'paused' });
  await copies.action('existing-user-folder', 'resume');
  await waitFor(() => copies.list()[0].state === 'error');
  assert.match(copies.list()[0].error, /مجلدًا فارغًا/);
  assert.equal(await readFile(join(userFolder, 'index.html'), 'utf8'), 'user file');
});

test('entry rejects a root rejected by robots rather than returning a nonexistent file', async t => {
  const f = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/plain'); res.end('User-agent: *\nDisallow: /');
  });
  const copies = await manager(t, await directory());
  const job = await copies.add({ url: f.url });
  await waitFor(() => copies.list()[0].state === 'partial');
  await assert.rejects(copies.entry(job.id), /لم تُحفظ الصفحة الأولى/);
});

test('network reconfiguration suspends both automatic and explicit site starts until its guard clears', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end('<p>guarded</p>');
  });
  const copies = await manager(t, await directory());
  copies.networkChanging = true;
  const job = await copies.add({ url: f.url });
  copies.start(copies.jobs.find(item => item.id === job.id));
  assert.equal(copies.list()[0].state, 'queued'); assert.equal(copies.active.size, 0); assert.deepEqual(f.requests, []);
  copies.networkChanging = false; copies.pump();
  await waitFor(() => copies.list()[0].state === 'complete');
  assert.ok(f.requests.includes('/'));
});
