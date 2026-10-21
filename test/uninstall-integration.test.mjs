import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { nativeLauncher } from '../src/browser-bridge.mjs';
const { cleanupIntegration } = createRequire(import.meta.url)('../electron/uninstall-integration.cjs');

test('uninstall removes only registrations and startup values owned by its installation, preserving user files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-uninstall-')); const installation = join(directory, 'SAHM'), profile = join(directory, 'profile/browser-integration');
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  await mkdir(profile, { recursive: true }); const manifest = join(profile, 'com.sahm.downloader.json'), launcher = join(profile, 'sahm-native-host.cmd');
  await writeFile(manifest, JSON.stringify({ name: 'com.sahm.downloader', type: 'stdio', path: launcher }));
  await writeFile(launcher, nativeLauncher(join(installation, 'SAHM.exe'), join(installation, 'resources/browser/native-host.mjs'), join(profile, 'connection.json')));
  await writeFile(join(directory, 'download.bin'), 'user-original'); await writeFile(join(profile, 'receipts.json'), 'retained');
  const removed = [];
  const query = async (key, value) => value ? '"' + join(installation, 'SAHM.exe') + '" --background' : manifest;
  const result = await cleanupIntegration({ installDirectory: installation, query, removeKey: async key => removed.push(key), removeValue: async (key, value) => removed.push(value) });
  assert.equal(result.errors.length, 0); assert.equal(result.removed.length, 4); assert.equal(removed.length, 4);
  assert.equal(await readFile(join(directory, 'download.bin'), 'utf8'), 'user-original'); assert.equal(await readFile(join(profile, 'receipts.json'), 'utf8'), 'retained');
  const foreign = await cleanupIntegration({ installDirectory: installation + '-older', query, removeKey: async () => { throw new Error('Must retain other installation'); }, removeValue: async () => { throw new Error('Must retain other installation'); } });
  assert.deepEqual(foreign.removed, []); assert.deepEqual(foreign.errors, []); assert.equal(foreign.retained.length, 4);
});

test('registry access failures are reported and absent entries need no deletion', async () => {
  const empty = await cleanupIntegration({ installDirectory: resolve('test-install'), query: async () => null });
  assert.deepEqual(empty, { removed: [], retained: [], errors: [] });
  const failed = await cleanupIntegration({ installDirectory: resolve('test-install'), query: async () => { throw new Error('Denied'); } });
  assert.equal(failed.errors.length, 4); assert.deepEqual(failed.removed, []);
});

test('startup cleanup accepts Electron AUMID values and retains a different installation under the legacy name', async () => {
  const installation = resolve('test-install'), runtime = join(installation, 'SAHM.exe'), removed = [];
  const result = await cleanupIntegration({ installDirectory: installation,
    query: async (_key, value) => value === 'com.sahm.downloadmanager' ? runtime + ' --background' : value === 'SAHM' ? '"' + runtime + '-other" --background' : null,
    removeValue: async (_key, value) => removed.push(value) });
  assert.deepEqual(removed, ['com.sahm.downloadmanager']);
  assert.deepEqual(result.removed, ['startup:com.sahm.downloadmanager']); assert.deepEqual(result.retained, ['startup:SAHM']); assert.deepEqual(result.errors, []);
});
