import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { downloadVerified, validateRuntimeLock, verifyRuntime } from '../scripts/lib/runtime-integrity.mjs';

const bytes = Buffer.from('verified-runtime');
const digest = createHash('sha256').update(bytes).digest('hex');
const lockedFile = { name: 'runtime.exe', size: bytes.length, sha256: digest };
function fixtureLock() {
  return { schemaVersion: 1, platform: 'win32-x64', dependencies: [{
    repository: 'example/runtime', version: 'v1.0.0',
    archiveUrl: 'https://github.com/example/runtime/releases/download/v1.0.0/runtime.exe',
    archiveSha256: digest, installed: [{ ...lockedFile }],
    licenses: [{ path: 'licenses/LICENSE.txt', size: bytes.length, sha256: digest, url: 'https://raw.githubusercontent.com/example/runtime/v1.0.0/LICENSE' }],
  }] };
}
async function directory(t) {
  const value = await mkdtemp(join(tmpdir(), 'sahm-runtime-lock-'));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
test('dependency locks reject moving releases, credentials, traversal and colliding files', () => {
  assert.ok(validateRuntimeLock(fixtureLock()));
  for (const mutate of [
    lock => { lock.dependencies[0].version = 'latest'; },
    lock => { lock.dependencies[0].archiveUrl = 'https://user:password@github.com/example/runtime/releases/download/v1.0.0/runtime.exe'; },
    lock => { lock.dependencies[0].archiveUrl = 'https://github.com/other/runtime/releases/download/v1.0.0/runtime.exe'; },
    lock => { lock.dependencies[0].licenses[0].path = 'licenses/../../private.txt'; },
    lock => { lock.dependencies[0].installed.push({ ...lockedFile, name: 'RUNTIME.EXE' }); },
    lock => { lock.dependencies[0].archiveSha256 = 'invalid'; },
  ]) { const lock = fixtureLock(); mutate(lock); assert.throws(() => validateRuntimeLock(lock)); }
});
test('runtime verification detects binary, manifest and inventory changes without executing tools', async t => {
  const runtime = await directory(t), lock = fixtureLock();
  await mkdir(join(runtime, 'licenses'));
  await writeFile(join(runtime, 'runtime.exe'), bytes);
  await writeFile(join(runtime, 'licenses/LICENSE.txt'), bytes);
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ platform: lock.platform, dependencies: lock.dependencies }));
  assert.deepEqual(await verifyRuntime(runtime, lock), { platform: 'win32-x64', dependencies: 1, files: 2 });
  await writeFile(join(runtime, 'runtime.exe'), Buffer.alloc(bytes.length));
  await assert.rejects(verifyRuntime(runtime, lock), /SHA256/);
  await writeFile(join(runtime, 'runtime.exe'), bytes);
  await writeFile(join(runtime, 'unexpected.dll'), bytes);
  await assert.rejects(verifyRuntime(runtime, lock), /Unexpected/);
  await rm(join(runtime, 'unexpected.dll'));
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ platform: lock.platform, dependencies: [] }));
  await assert.rejects(verifyRuntime(runtime, lock), /manifest/);
});
test('dependency cache is verified before reuse and corrupt bytes are replaced only after verification', async t => {
  const cache = await directory(t), target = join(cache, 'download');
  let calls = 0;
  const fetchFile = async () => { calls++; return new Response(bytes); };
  await downloadVerified('https://github.com/fixture', digest, target, fetchFile);
  await downloadVerified('https://github.com/fixture', digest, target, fetchFile);
  assert.equal(calls, 1);
  await writeFile(target, 'old-cache');
  await assert.rejects(downloadVerified('https://github.com/fixture', digest, target, async () => new Response('altered')), /SHA256/);
  assert.equal(await readFile(target, 'utf8'), 'old-cache');
  assert.deepEqual(await readdir(cache), ['download']);
  await downloadVerified('https://github.com/fixture', digest, target, fetchFile);
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(calls, 2);
});
test('interrupted dependency downloads leave existing files intact and remove partial files', async t => {
  const cache = await directory(t), target = join(cache, 'download');
  await writeFile(target, 'old-cache');
  const broken = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.error(new Error('connection lost')); } });
  await assert.rejects(downloadVerified('https://github.com/fixture', digest, target, async () => new Response(broken)), /connection lost/);
  assert.equal(await readFile(target, 'utf8'), 'old-cache');
  assert.deepEqual(await readdir(cache), ['download']);
});
