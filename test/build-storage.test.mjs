import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GiB, prepareBuildStorage } from '../scripts/lib/build-storage.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sahm-build-space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { output: join(root, 'release'), temporaryDirectory: join(root, 'temporary') };
}

test('build reserves output and staging together when they share a volume', async t => {
  const paths = await fixture(t);
  const inspect = async () => ({ id: 'same-disk', available: BigInt(GiB * 1.5) });
  await assert.rejects(prepareBuildStorage({ ...paths, inspect }), { code: 'ENOSPC' });
});

test('a spacious output volume cannot conceal an exhausted temporary volume', async t => {
  const paths = await fixture(t);
  const inspect = async directory => ({ id: directory, available: BigInt(directory === paths.output ? 10 * GiB : GiB / 2) });
  await assert.rejects(prepareBuildStorage({ ...paths, inspect }), error => error.code === 'ENOSPC' && error.message.includes(paths.temporaryDirectory));
});

test('enough space on distinct volumes allows their individual reservations', async t => {
  const paths = await fixture(t);
  const inspect = async directory => ({ id: directory, available: BigInt(GiB) });
  assert.equal(await prepareBuildStorage({ ...paths, inspect }), paths.temporaryDirectory);
});

test('shared-volume reservation uses the smaller free-space observation', async t => {
  const paths = await fixture(t);
  let calls = 0;
  const inspect = async () => ({ id: 'same-disk', available: BigInt(++calls === 1 ? 3 * GiB : GiB) });
  await assert.rejects(prepareBuildStorage({ ...paths, inspect }), { code: 'ENOSPC' });
});
