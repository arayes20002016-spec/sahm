import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceCheckpoint, writeCheckpoint } from '../src/checkpoint.mjs';

test('checkpoint data is flushed and closed before publishing its filename', async () => {
  const calls = [];
  await writeCheckpoint('state.json', 'new-state', {
    openFile: async (file, flags, mode) => {
      assert.equal(file, 'state.json.tmp'); assert.equal(flags, 'w'); assert.equal(mode, 0o600);
      return { writeFile: async text => { assert.equal(text, 'new-state'); calls.push('write'); }, sync: async () => calls.push('sync'), close: async () => calls.push('close') };
    },
    replaceFile: async (temporary, destination) => { assert.equal(temporary, 'state.json.tmp'); assert.equal(destination, 'state.json'); calls.push('replace'); },
  });
  assert.deepEqual(calls, ['write', 'sync', 'close', 'replace']);
});

for (const operation of ['writeFile', 'sync']) {
  test(`checkpoint ${operation} failure closes the staged file and preserves the last published state`, async t => {
    const { destination } = await fixture(t);
    const failure = Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
    let closed = false;
    await assert.rejects(writeCheckpoint(destination, 'next', {
      openFile: async () => ({ writeFile: async () => {}, sync: async () => {}, close: async () => { closed = true; }, [operation]: async () => { throw failure; } }),
      replaceFile: async () => assert.fail('Unflushed state must never replace a valid checkpoint'),
    }), error => error === failure);
    assert.equal(closed, true);
    assert.equal(await readFile(destination, 'utf8'), '{"received":100}');
    await writeCheckpoint(destination, '{"received":300}');
    assert.equal(await readFile(destination, 'utf8'), '{"received":300}');
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const temporary = join(directory, 'resume.json.tmp'), destination = join(directory, 'resume.json');
  await writeFile(temporary, '{"received":200}');
  await writeFile(destination, '{"received":100}');
  return { temporary, destination };
}

test('checkpoint replacement retries Windows sharing errors without deleting the valid manifest', async t => {
  const paths = await fixture(t);
  const failures = ['EPERM', 'EACCES', 'EBUSY'];
  let attempts = 0;
  await replaceCheckpoint(paths.temporary, paths.destination, {
    platform: 'win32',
    renameFile: async (temporary, destination) => {
      assert.equal(await readFile(destination, 'utf8'), '{"received":100}');
      if (attempts < failures.length) throw Object.assign(new Error('temporarily open'), { code: failures[attempts++] });
      attempts++;
      await rename(temporary, destination);
    },
  });
  assert.equal(attempts, 4);
  assert.equal(await readFile(paths.destination, 'utf8'), '{"received":200}');
  await assert.rejects(readFile(paths.temporary), { code: 'ENOENT' });
});

test('persistent checkpoint rename failure is bounded and preserves both previous and staged state', async t => {
  const paths = await fixture(t);
  const failure = Object.assign(new Error('sharing violation persists'), { code: 'EPERM' });
  let attempts = 0;
  await assert.rejects(replaceCheckpoint(paths.temporary, paths.destination, { platform: 'win32', renameFile: async () => { attempts++; throw failure; } }), error => error === failure);
  assert.equal(attempts, 6);
  assert.equal(await readFile(paths.destination, 'utf8'), '{"received":100}');
  assert.equal(await readFile(paths.temporary, 'utf8'), '{"received":200}');
});

test('checkpoint replacement immediately propagates unrelated filesystem errors', async () => {
  const failure = Object.assign(new Error('disk error'), { code: 'EIO' });
  let attempts = 0;
  await assert.rejects(replaceCheckpoint('staged', 'manifest', { platform: 'win32', renameFile: async () => { attempts++; throw failure; } }), error => error === failure);
  assert.equal(attempts, 1);
});

test('checkpoint replacement does not retry permission errors on other platforms', async () => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  let attempts = 0;
  await assert.rejects(replaceCheckpoint('staged', 'manifest', { platform: 'linux', renameFile: async () => { attempts++; throw failure; } }), error => error === failure);
  assert.equal(attempts, 1);
});
