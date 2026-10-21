import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { assertFile, downloadVerified, validateRuntimeLock, verifyRuntime } from './lib/runtime-integrity.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(root, 'artifacts/media-runtime');
const cache = resolve(root, 'artifacts/media-dependency-cache');
const lock = validateRuntimeLock(JSON.parse(await readFile(join(root, 'media-runtime.lock.json'), 'utf8')));

if (process.argv.includes('--verify')) {
  console.log(JSON.stringify(await verifyRuntime(runtime, lock)));
} else {
  assert.equal(process.platform, 'win32', 'The bundled media runtime targets Windows x64');
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(dirname(runtime), 'media-staging-'));
  try {
    for (const dependency of lock.dependencies) {
      const archiveName = basename(new URL(dependency.archiveUrl).pathname);
      const archive = await downloadVerified(dependency.archiveUrl, dependency.archiveSha256, join(cache, dependency.archiveSha256 + '-' + archiveName));
      let sourceFiles = [archive];
      if (archiveName.endsWith('.zip')) {
        const extracted = await mkdtemp(join(cache, 'extract-'));
        try {
          const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
          const listing = await run(tar, ['-tf', archive], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
          const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
          for (const entry of entries) assert.ok(!/^[\\/]|^[a-z]:|\\|(?:^|\/)\.\.(?:\/|$)/i.test(entry), 'Unsafe dependency archive path');
          await run(tar, ['-xf', archive, '-C', extracted], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120000 });
          async function collect(directory) {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              const file = join(directory, entry.name);
              assert.ok(!entry.isSymbolicLink(), 'Dependency archive contains a symlink');
              if (entry.isDirectory()) await collect(file);
              else if (entry.isFile()) sourceFiles.push(file);
              else throw new Error('Unexpected dependency archive entry');
            }
          }
          sourceFiles = [];
          await collect(extracted);
          await installFiles(dependency, sourceFiles);
        } finally {
          assert.equal(dirname(extracted), cache);
          await rm(extracted, { recursive: true, force: true });
        }
      } else await installFiles(dependency, sourceFiles);
      console.log(dependency.repository + ' ' + dependency.version + ': pinned files verified');
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({ platform: lock.platform, installedAt: new Date().toISOString(), dependencies: lock.dependencies }, null, 2) + '\n');
    console.log(JSON.stringify(await verifyRuntime(staging, lock)));
    const previous = runtime + '.previous-' + randomUUID();
    const existing = await lstat(runtime).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) {
      assert.ok(existing.isDirectory() && !existing.isSymbolicLink(), 'Runtime directory cannot be a symlink');
      await rename(runtime, previous);
    }
    try { await rename(staging, runtime); }
    catch (error) {
      if (existing) await rename(previous, runtime);
      throw error;
    }
    // Keep an existing runtime as a recovery copy; it is never shipped.
    if (existing) console.log('Previous runtime retained: ' + previous);
    console.log('Media runtime ready: ' + runtime);
  } finally {
    assert.equal(dirname(staging), dirname(runtime));
    await rm(staging, { recursive: true, force: true });
  }

  async function installFiles(dependency, sourceFiles) {
    for (const file of [...dependency.installed, ...dependency.licenses]) {
      const target = join(staging, file.path || file.name);
      await mkdir(dirname(target), { recursive: true });
      let source;
      if (file.url) source = await downloadVerified(file.url, file.sha256, join(cache, file.sha256 + '-' + basename(file.path)));
      else {
        const matches = sourceFiles.filter(value => basename(value) === (file.archiveName || file.name) || !dependency.archiveUrl.endsWith('.zip'));
        assert.equal(matches.length, 1, 'Missing or ambiguous dependency file: ' + (file.path || file.name));
        source = matches[0];
      }
      await assertFile(source, file);
      await copyFile(source, target);
    }
  }
}
