import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function checkedUrl(value, host) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && url.hostname === host && !url.username && !url.password && !url.port && !url.hash && !url.search, 'Untrusted dependency URL');
  assert.ok(!url.pathname.split('/').includes('latest'), 'Moving dependency versions are forbidden');
}

export function validateRuntimeLock(lock) {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.platform, 'win32-x64');
  assert.ok(Array.isArray(lock.dependencies) && lock.dependencies.length > 0);
  const names = new Set();
  for (const dependency of lock.dependencies) {
    assert.match(dependency.repository, /^[\w.-]+\/[\w.-]+$/);
    assert.match(dependency.version, /^[\w.-]+$/);
    assert.notEqual(dependency.version, 'latest');
    checkedUrl(dependency.archiveUrl, 'github.com');
    assert.ok(new URL(dependency.archiveUrl).pathname.startsWith('/' + dependency.repository + '/releases/download/' + dependency.version + '/'), 'Archive must belong to its pinned release');
    assert.match(dependency.archiveSha256, /^[a-f0-9]{64}$/);
    assert.ok(dependency.installed.length > 0 && dependency.licenses.length > 0);
    for (const file of [...dependency.installed, ...dependency.licenses]) {
      const relative = file.path || file.name;
      assert.match(relative, file.path ? /^licenses\/[a-zA-Z0-9._/-]+$/ : /^[a-zA-Z0-9._-]+$/);
      assert.ok(!relative.split('/').some(part => part === '..' || part === '.' || !part), 'Unsafe runtime path');
      assert.ok(!names.has(relative.toLowerCase()), 'Duplicate runtime file');
      names.add(relative.toLowerCase());
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
      if (file.url) checkedUrl(file.url, 'raw.githubusercontent.com');
      else if (file.path) assert.match(file.archiveName, /^[a-zA-Z0-9._-]+$/);
    }
  }
  return lock;
}

export async function assertFile(file, expected) {
  const metadata = await lstat(file);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Runtime entry is not an ordinary file: ' + file);
  assert.equal(metadata.size, expected.size, 'Runtime size mismatch: ' + basename(file));
  assert.equal(await sha256(file), expected.sha256, 'Runtime SHA256 mismatch: ' + basename(file));
}

export async function downloadVerified(url, expectedHash, destination, fetchFile = fetch) {
  try {
    if (await sha256(destination) === expectedHash) return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = destination + '.' + randomUUID() + '.part';
  try {
    const response = await fetchFile(url, { signal: AbortSignal.timeout(180000) });
    assert.ok(response.ok && response.body, 'Dependency download failed: HTTP ' + response.status);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    assert.equal(await sha256(temporary), expectedHash, 'Dependency archive SHA256 mismatch');
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Symlinks are forbidden in the runtime');
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(join(directory, entry.name), relative + '/'));
    else {
      assert.ok(entry.isFile(), 'Unexpected runtime entry');
      files.push(relative);
    }
  }
  return files;
}

export async function verifyRuntime(directory, lock) {
  validateRuntimeLock(lock);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.platform, lock.platform);
  assert.deepEqual(manifest.dependencies, lock.dependencies, 'Runtime manifest differs from the dependency lock');
  const expectedFiles = ['manifest.json'];
  for (const dependency of lock.dependencies) {
    for (const file of [...dependency.installed, ...dependency.licenses]) {
      const relative = file.path || file.name;
      await assertFile(join(directory, relative), file);
      expectedFiles.push(relative);
    }
  }
  assert.deepEqual((await filesUnder(directory)).sort(), expectedFiles.sort(), 'Unexpected or missing runtime files');
  return { platform: lock.platform, dependencies: lock.dependencies.length, files: expectedFiles.length - 1 };
}
