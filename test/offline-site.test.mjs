import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveOfflineSite } from '../src/offline-site.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-offline-test-')), root = join(directory, 'site');
  await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.sahm-mirror', 'raw'), { recursive: true }); await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>محلي</title><script src="assets/app.js"></script>');
  await writeFile(join(root, 'assets', 'app.js'), 'document.body.dataset.local = "yes";');
  await writeFile(join(root, 'docs', 'page.html'), '<p>page</p>');
  await writeFile(join(root, 'sahm-mirror.json'), 'private manifest'); await writeFile(join(root, '.sahm-mirror', 'raw', 'secret.bin'), 'private original');
  await writeFile(join(directory, 'outside.txt'), 'outside folder');
  const server = await serveOfflineSite(root); t.after(() => server.close());
  return { directory, root, server, address: new URL(server.url), prefixPath: new URL(server.prefix).pathname };
}
function raw(address, path, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: host ? { Host: host } : {} }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject); req.end();
  });
}

test('offline server serves real GET and HEAD with local MIME, content length, CSP and no-store headers', async t => {
  const { server, address, prefixPath } = await fixture(t);
  const page = await fetch(server.url); assert.equal(page.status, 200);
  const body = await page.text(); assert.match(body, /محلي/);
  assert.equal(Number(page.headers.get('content-length')), Buffer.byteLength(body));
  assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/); assert.match(page.headers.get('content-security-policy'), /object-src 'none'/); assert.match(page.headers.get('content-security-policy'), /worker-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.equal(page.headers.get('cache-control'), 'no-store');
  const head = await raw(address, prefixPath + 'index.html', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], String(Buffer.byteLength(body)));
  const script = await raw(address, prefixPath + 'assets/app.js');
  assert.equal(script.status, 200); assert.match(script.headers['content-type'], /^text\/javascript/); assert.match(script.body, /dataset.local/);
  assert.equal((await raw(address, prefixPath)).status, 200);
  assert.equal((await raw(address, prefixPath + 'docs')).status, 404);
});

test('capability tokens and exact loopback Host are required, and POST cannot change saved content', async t => {
  const { root, server, address, prefixPath } = await fixture(t);
  const second = await serveOfflineSite(root); t.after(() => second.close());
  assert.notEqual(server.prefix, second.prefix);
  assert.equal((await raw(address, '/index.html')).status, 404);
  assert.equal((await raw(address, '/wrong-token/index.html')).status, 404);
  assert.equal((await raw(address, new URL(second.url).pathname)).status, 404);
  assert.equal((await raw(address, prefixPath + 'index.html', { host: 'attacker.example' })).status, 403);
  assert.equal((await raw(address, prefixPath + 'index.html', { method: 'POST' })).status, 405);
  assert.match((await raw(address, prefixPath + 'index.html')).body, /محلي/);
});

test('encoded traversal, hidden raw files, manifests and malformed paths never leave the mirror directory', async t => {
  const { address, prefixPath } = await fixture(t);
  const paths = ['../outside.txt', '%2e%2e/outside.txt', '%2e%2e%2foutside.txt', '..%5coutside.txt', '%2f..%2foutside.txt', '.sahm-mirror/raw/secret.bin', '%2esahm-mirror/raw/secret.bin', 'sahm-mirror.json', 'SAHM-MIRROR.JSON', 'sahm-mirror.json.', 'sahm-mirror.json%20', 'sahm-mirror.json::$DATA', 'assets/../sahm-mirror.json', '%00', '%E0%A4%A'];
  for (const path of paths) {
    const response = await raw(address, prefixPath + path);
    assert.ok([403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(response.body, /outside folder|private manifest|private original/);
  }
});

test('an available directory symlink or junction cannot expose files outside the mirror root', async t => {
  const { directory, root, address, prefixPath } = await fixture(t), outside = join(directory, 'external');
  await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'symlink outside content');
  try { await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Symlink creation is unavailable in this environment'); return; } throw error; }
  const response = await raw(address, prefixPath + 'escape/secret.txt');
  assert.equal(response.status, 403); assert.doesNotMatch(response.body, /symlink outside/);
});
