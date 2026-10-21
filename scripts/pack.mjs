import { packager } from '@electron/packager';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyRuntime } from './lib/runtime-integrity.mjs';
import { prepareBuildStorage } from './lib/build-storage.mjs';
import { STORE_RELEASE } from '../browser/distribution.mjs';
const requiredStores = (process.env.SAHM_REQUIRE_EXTENSION_STORES || '').split(',').filter(Boolean);
for (const browser of requiredStores) {
  if (!['edge', 'chrome'].includes(browser) || !STORE_RELEASE[browser]) throw new Error('A published extension store ID and URL are required before this distribution build: ' + browser);
}
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeLock = JSON.parse(await readFile(new URL('../media-runtime.lock.json', import.meta.url), 'utf8'));
await verifyRuntime(resolve('artifacts/media-runtime'), runtimeLock);
const destination = process.env.SAHM_PACK_DIRECTORY || process.env.SAHM_RELEASE_DIRECTORY;
const output = destination ? resolve(destination) : `dist/${version}`;
const temporary = await prepareBuildStorage({ output });
const paths = await packager({ dir: '.', name: 'SAHM', appBundleId: 'com.sahm.downloadmanager', appCopyright: 'SAHM', icon: 'assets/sahm.ico', platform: 'win32', arch: 'x64', out: output, tmpdir: temporary, overwrite: true, extraResource: ['browser', 'artifacts/media-runtime'], ignore: /^\/(?:SOURCE-MANIFEST\.json$|(?:artifacts|research|test|dist|downloads|scripts|build|docs|\.github|\.impeccable|\.sahm-qa|\.git)(?:\/|$))/ });
console.log(paths.join('\n'));
