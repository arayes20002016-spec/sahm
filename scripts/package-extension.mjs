import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sevenZipBinary from '7zip-bin';
import { STORE_RELEASE } from '../browser/distribution.mjs';
import { normalizePublisher, publicationStatus } from '../browser/publication.mjs';
const run = promisify(execFile), root = resolve('.');
const manifest = JSON.parse(await readFile(join(root, 'browser/extension/manifest.json'), 'utf8'));
const output = resolve(process.env.SAHM_EXTENSION_DIRECTORY || 'dist/extension/' + manifest.version);
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'sahm-extension-'));
try {
  const source = join(root, 'browser/extension');
  async function check(directory) { for (const name of await readdir(directory)) { const file = join(directory, name), metadata = await lstat(file); assert.ok(!metadata.isSymbolicLink()); if (metadata.isDirectory()) await check(file); else assert.match(name, /\.(?:json|mjs|js|html|css|png)$/); } }
  await check(source); await cp(source, staging, { recursive: true });
  const published = { ...manifest }; delete published.key;
  assert.equal(published.default_locale, 'ar');
  for (const language of ['ar', 'en']) {
    const messages = JSON.parse(await readFile(join(staging, '_locales', language, 'messages.json'), 'utf8'));
    for (const key of ['extensionName', 'extensionShortName', 'extensionDescription']) assert.ok(messages[key]?.message?.trim());
    assert.ok(messages.extensionDescription.message.length <= 132);
  }
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(published, null, 2) + '\n');
  const archive = join(output, 'SAHM-Extension-' + manifest.version + '-store.zip');
  await run(sevenZipBinary.path7za, ['a', '-tzip', '-mx=9', archive, '.'], { cwd: staging, windowsHide: true, timeout: 30000 });
  await run(sevenZipBinary.path7za, ['t', archive], { windowsHide: true, timeout: 30000 });
  const extracted = await run(sevenZipBinary.path7za, ['e', '-so', archive, 'manifest.json'], { windowsHide: true, timeout: 30000 });
  assert.deepEqual(JSON.parse(extracted.stdout), published);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(output, 'SHA256SUMS.txt'), sha256 + '  ' + 'SAHM-Extension-' + manifest.version + '-store.zip\n');
  const publisher = normalizePublisher(JSON.parse(await readFile(join(root, 'browser/publisher.json'), 'utf8')));
  const status = { version: manifest.version, archiveSha256: sha256, candidateStore: 'edge', ...publicationStatus(STORE_RELEASE, publisher) };
  await writeFile(join(output, 'publication-status.json'), JSON.stringify(status, null, 2) + '\n');
  await cp(join(root, 'docs/extension-store'), join(output, 'store-listing'), { recursive: true });
  await cp(join(root, 'docs/EXTENSION-PUBLISHING.md'), join(output, 'PUBLISHING.ar.md'));
  await cp(join(root, 'docs/EXTENSION-PRIVACY.md'), join(output, 'PRIVACY-DRAFT.ar.md'));
  console.log(JSON.stringify({ archive, version: manifest.version, sha256, developerKeyExcluded: true, submittedToStore: false, publishedStoreIdsRequired: true }));
} finally {
  assert.ok(resolve(staging).startsWith(resolve(tmpdir()) + sep)); await rm(staging, { recursive: true, force: true });
}
