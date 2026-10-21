import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceFiles } from './lib/source-files.mjs';
import { validateRuntimeLock } from './lib/runtime-integrity.mjs';

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async relative => JSON.parse(await readFile(join(root, relative), 'utf8'));
const manifest = await readJson('package.json'), lock = await readJson('package-lock.json');
assert.equal(manifest.version, lock.version);
assert.equal(manifest.version, lock.packages[''].version);
assert.equal(manifest.version, (await readJson('browser/extension/manifest.json')).version);
assert.equal(manifest.license, 'GPL-3.0-or-later');
assert.equal(manifest.license, lock.packages[''].license);
assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies);
assert.deepEqual(manifest.devDependencies, lock.packages[''].devDependencies);
assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE[\s\S]+Version 3, 29 June 2007/);
validateRuntimeLock(await readJson('media-runtime.lock.json'));
const files = await sourceFiles(root), javascript = files.filter(file => /\.(?:mjs|cjs|js)$/.test(file));
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < javascript.length) {
    const file = javascript[next++];
    await run(process.execPath, ['--check', join(root, file)], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024 });
  }
}));
console.log(JSON.stringify({ version: manifest.version, sourceFiles: files.length, syntaxChecked: javascript.length, dependencyLock: true, license: manifest.license }));
