import { mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// All test-created TEMP files belong to this one workspace, even after a failing test.
const parent = await realpath(process.env.SAHM_QA_ROOT || tmpdir());
const directory = await mkdtemp(join(parent, 'sahm-test-run-'));
let code = 1;
try {
  const args = process.argv.slice(2);
  const concurrency = args.some(value => value.startsWith('--test-concurrency')) ? [] : ['--test-concurrency=4'];
  code = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--test', ...concurrency, ...args], {
      stdio: 'inherit', shell: false, windowsHide: true,
      env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
    });
    child.once('error', reject);
    child.once('close', status => accept(status ?? 1));
  });
} finally {
  if (dirname(resolve(directory)) !== parent || (await lstat(directory)).isSymbolicLink()) throw new Error('Refusing replaced test workspace');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exitCode = code;
