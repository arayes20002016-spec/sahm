import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_RELEASE } from '../browser/distribution.mjs';

test('unpublished installer setup survives initial loading and a second-instance request during renderer reload', { skip: process.platform !== 'win32' || Object.values(STORE_RELEASE).some(Boolean), timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-browser-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const environment = { ...process.env, SAHM_APPLICATION_ROOT: root, SAHM_BROWSER_SETUP_RESULT: directory, SAHM_BROWSER_SETUP_WORKSPACE: join(directory, 'workspace') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SAHM_SCREENSHOT', 'RAFID_SCREENSHOT']) delete environment[key];
  await promisify(execFile)(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'scripts/browser-setup-smoke.cjs')], { env: environment, windowsHide: true, timeout: 160000, maxBuffer: 256 * 1024 });
  const report = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(report.ok, true, report.error); assert.equal(report.prompts.length, 2);
  assert.equal(report.registryWriteAttempts, 0); assert.deepEqual(report.errors, []);
});
