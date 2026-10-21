import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_RELEASE } from '../browser/distribution.mjs';

test('unpublished installer setup survives initial loading and a second-instance request during renderer reload', { skip: process.platform !== 'win32' || Object.values(STORE_RELEASE).some(Boolean), timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-browser-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const environment = { ...process.env, SAHM_APPLICATION_ROOT: root, SAHM_BROWSER_SETUP_RESULT: directory, SAHM_BROWSER_SETUP_WORKSPACE: join(directory, 'workspace'), SAHM_BROWSER_SETUP_CAPTURE: '0' };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT', 'SAHM_SCREENSHOT', 'RAFID_SCREENSHOT']) delete environment[key];
  const code = await new Promise((resolve, reject) => {
    // Wait for the app process, not pipes inherited by Chromium subprocesses.
    const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'scripts/browser-setup-smoke.cjs')], { env: environment, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Browser setup app exceeded its execution limit')); }, 160000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => { clearTimeout(timer); resolve(status); });
  });
  const report = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(code, 0, report.error);
  assert.equal(report.ok, true, report.error); assert.equal(report.prompts.length, 2);
  assert.equal(report.registryWriteAttempts, 0); assert.deepEqual(report.errors, []);
});
