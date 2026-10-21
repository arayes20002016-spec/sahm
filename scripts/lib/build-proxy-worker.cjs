const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

(async () => {
  const [proxy, direct, directory, expectedHash] = process.argv.slice(2);
  process.env.GLOBAL_AGENT_HTTP_PROXY = proxy;
  process.env.GLOBAL_AGENT_NO_PROXY = '127.0.0.1';
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
  const getRequire = createRequire(builderRequire.resolve('@electron/get'));
  assert.equal(getRequire('global-agent/package.json').version, '4.1.3');
  const get = builderRequire('@electron/get');
  get.initializeProxy();
  assert.ok(global.GLOBAL_AGENT, 'Proxy bootstrap must not silently fail');
  const artifactName = 'electron-v44.9.0-win32-x64.zip';
  for (const [index, url] of ['http://sahm-build.invalid/electron.zip', direct].entries()) {
    const file = await get.downloadArtifact({
      version: '44.9.0', artifactName: 'electron', platform: 'win32', arch: 'x64',
      cacheRoot: path.join(directory, `cache-${index}`), force: true,
      mirrorOptions: { resolveAssetURL: async () => url },
      checksums: { [artifactName]: expectedHash }, downloadOptions: { quiet: true },
    });
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), expectedHash);
  }
  await assert.rejects(get.downloadArtifact({
    version: '44.9.0', artifactName: 'electron', platform: 'win32', arch: 'x64',
    cacheRoot: path.join(directory, 'bad-checksum'), force: true,
    mirrorOptions: { resolveAssetURL: async () => 'http://sahm-build.invalid/invalid.zip' },
    checksums: { [artifactName]: '0'.repeat(64) }, downloadOptions: { quiet: true },
  }));
  console.log(JSON.stringify({ ok: true, proxyBootstrap: true, directExclusion: true, checksumRejection: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
