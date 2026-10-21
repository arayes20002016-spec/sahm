import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceFiles } from './lib/source-files.mjs';
import { sha256 } from './lib/runtime-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
const output = process.env.SAHM_SOURCE_DIRECTORY ? resolve(process.env.SAHM_SOURCE_DIRECTORY) : resolve(root, 'dist/source');
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, '.source-')), name = 'SAHM-' + version + '-source';
try {
  const snapshot = join(staging, name), files = [];
  for (const relative of await sourceFiles(root)) {
    const source = join(root, relative === 'README.md' ? 'docs/README.public.md' : relative), target = join(snapshot, relative);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    files.push({ path: relative, bytes: (await stat(target)).size, sha256: await sha256(target) });
  }
  await writeFile(join(snapshot, 'SOURCE-MANIFEST.json'), JSON.stringify({ version, license: 'GPL-3.0-or-later', files }, null, 2) + '\n');
  const archive = join(output, name + '.tar.gz');
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe') : 'tar';
  await run(tar, ['-czf', archive, '-C', staging, name], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const extracted = join(staging, 'verification');
  await mkdir(extracted);
  await run(tar, ['-xzf', archive, '-C', extracted], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  for (const file of files) assert.equal(await sha256(join(extracted, name, file.path)), file.sha256, 'Source archive changed: ' + file.path);
  const digest = await sha256(archive);
  await writeFile(join(output, name + '.sha256'), digest + '  ' + name + '.tar.gz\n');
  console.log(JSON.stringify({ archive, sha256: digest, files: files.length, bytes: (await stat(archive)).size, roundTripVerified: true }));
} finally {
  assert.equal(dirname(await realpath(staging)), await realpath(output));
  await rm(staging, { recursive: true, force: true });
}
