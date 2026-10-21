import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

test('test runner removes its own leftovers after passing and failing tests, preserving outside junction targets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sahm-runner-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside'), qa = join(root, 'qa'); await mkdir(outside); await mkdir(qa);
  await writeFile(join(outside, 'keep.txt'), 'unrelated');
  for (const fail of [false, true]) {
    const file = join(root, 'fixture.test.mjs');
    await writeFile(file, `import {test} from 'node:test';import {mkdir,writeFile,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';test('fixture',async()=>{await writeFile(join(tmpdir(),'leftover.txt'),'owned');await symlink(${JSON.stringify(outside)},join(tmpdir(),'link'),'junction');${fail ? "throw new Error('intentional failure');" : ''}});`);
    const env = { ...process.env, SAHM_QA_ROOT: qa }; delete env.NODE_TEST_CONTEXT;
    const result = await new Promise((accept, reject) => { const child = spawn(process.execPath, [resolve('scripts/run-tests.mjs'), file], { env, shell: false, windowsHide: true, stdio: 'pipe' }); child.stdout.resume(); child.stderr.resume(); child.once('error', reject); child.once('close', accept); });
    assert.equal(result, fail ? 1 : 0); assert.deepEqual(await readdir(qa), []);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'unrelated');
  }
});
