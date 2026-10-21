import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { extractFile, getRawHeader, listPackage, statFile } from '@electron/asar';
import { AsarPackager } from 'app-builder-lib/out/asar/asarUtil.js';
import { checkFileInArchive } from 'app-builder-lib/out/asar/asarFileChecker.js';
import sevenZipBinary from '7zip-bin';

test('overridden Electron build downloader supports proxy, NO_PROXY and checksum validation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-build-proxy-'));
  const payload = Buffer.from('synthetic build artifact; not an executable');
  const proxied = [], direct = [];
  const respond = (requests, req, res) => { requests.push(req.url); res.end(payload); };
  const proxy = createServer((req, res) => respond(proxied, req, res));
  const origin = createServer((req, res) => respond(direct, req, res));
  t.after(async () => { proxy.closeAllConnections(); origin.closeAllConnections(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))]);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/lib/build-proxy-worker.cjs', import.meta.url)),
    `http://127.0.0.1:${proxy.address().port}`, `http://127.0.0.1:${origin.address().port}/direct.zip`, directory, createHash('sha256').update(payload).digest('hex')],
  { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 });
  assert.equal(JSON.parse(stdout.trim()).ok, true);
  assert.deepEqual(proxied, ['http://sahm-build.invalid/electron.zip', 'http://sahm-build.invalid/invalid.zip']);
  assert.deepEqual(direct, ['/direct.zip']);
});

test('NSIS builder uses modern ASAR for streams, unpacked files and archive validation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-builder-asar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('app-builder-lib'));
  assert.equal(builderRequire.resolve('@electron/asar'), require.resolve('@electron/asar'));
  const fixtures = [
    { path: 'package.json', bytes: Buffer.from('{"main":"index.js"}'), unpacked: false },
    { path: 'واجهة.js', bytes: Buffer.from('module.exports = "سَهم";'), unpacked: false },
    { path: 'native.node', bytes: Buffer.from([0, 1, 2, 255]), unpacked: true },
    { path: 'empty.txt', bytes: Buffer.alloc(0), unpacked: false },
  ];
  const streams = [];
  for (const file of fixtures) {
    const input = join(directory, file.path);
    await writeFile(input, file.bytes);
    streams.push({ type: 'file', path: file.path, unpacked: file.unpacked, stat: await stat(input), streamGenerator: () => createReadStream(input) });
  }
  const resources = join(directory, 'resources');
  await mkdir(resources);
  await new AsarPackager({}, { resourcePath: resources }).executeElectronAsar(streams);
  const archive = join(resources, 'app.asar');
  assert.ok(getRawHeader(archive).headerSize > 0);
  assert.equal(listPackage(archive).length, fixtures.length);
  for (const file of fixtures) assert.deepEqual(extractFile(archive, file.path), file.bytes);
  assert.equal(statFile(archive, 'native.node').unpacked, true);
  assert.deepEqual(await readFile(archive + '.unpacked/native.node'), fixtures[2].bytes);
  assert.ok((await checkFileInArchive(archive, 'واجهة.js', 'SAHM')).size > 0);
  await assert.rejects(checkFileInArchive(archive, 'missing.js', 'SAHM'));
  await assert.rejects(checkFileInArchive(archive, 'empty.txt', 'SAHM'), /size 0/);
});

test('standalone 7-Zip creates and verifies extension archives without Squirrel', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-build-zip-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = '{"manifest_version":3,"name":"SAHM","version":"0.17.0"}';
  await writeFile(join(directory, 'manifest.json'), manifest);
  const archive = join(directory, 'extension.zip');
  const run = promisify(execFile), options = { cwd: directory, windowsHide: true, timeout: 15000 };
  await run(sevenZipBinary.path7za, ['a', '-tzip', archive, 'manifest.json'], options);
  assert.match((await run(sevenZipBinary.path7za, ['t', archive], options)).stdout, /Everything is Ok/);
  assert.equal((await run(sevenZipBinary.path7za, ['e', '-so', archive, 'manifest.json'], options)).stdout, manifest);
});
