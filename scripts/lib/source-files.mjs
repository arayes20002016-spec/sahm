import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directories = ['locales', 'src', 'electron', 'ui', 'browser', 'assets', 'build', 'test', 'scripts', 'docs', '.github'];
const rootFiles = ['package.json', 'package-lock.json', 'media-runtime.lock.json', 'LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.npmrc'];
const publicTestCertificates = new Map([
  ['test/fixtures/ftp/server-cert.pem', 'ebb823d844e54345edf8bb0c02057910c5d0fa6a1f1bad1aa218cf0ef7ea10dc'],
  ['test/fixtures/ftp/server-key.pem', '61bc6fdc681ff3512becae6b64cf39dc2dafe4c4fee3ce77d5608e5280cc6a2b'],
]);

export async function sourceFiles(root) {
  const output = [];
  async function visit(relative) {
    const file = join(root, relative), metadata = await lstat(file);
    assert.ok(!metadata.isSymbolicLink(), 'Source export cannot follow a symlink: ' + relative);
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(file)).sort()) await visit(relative + '/' + entry);
    } else {
      assert.ok(metadata.isFile(), 'Unexpected source entry: ' + relative);
      if (relative === 'scripts/extract-idm.mjs') return;
      if (publicTestCertificates.has(relative)) {
        assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), publicTestCertificates.get(relative), 'Public test certificate was replaced');
      } else assert.ok(!/\.(?:exe|dll|pfx|p12|pem|key|asar|zip|7z|log|part)$/i.test(relative), 'Unexpected binary, credential or generated file in source: ' + relative);
      output.push(relative);
    }
  }
  for (const relative of [...rootFiles, ...directories]) await visit(relative);
  return output.sort();
}
