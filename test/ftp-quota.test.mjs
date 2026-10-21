import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFtp } from '../src/ftp.mjs';
import { QuotaStore } from '../src/quota.mjs';
import { ftpFixture } from './helpers/ftp-fixture.mjs';

test('FTP writes the exact partial allowance, persists it, and resumes with REST without charging old bytes', async t => {
  const f = await ftpFixture(t, { requireLogin: true });
  let now = Date.now();
  const directory = join(f.directory, 'quota');
  const quota = await new QuotaStore(directory, { now: () => now }).init();
  const limit = 123 * 1024 + 7;
  await quota.configure({ enabled: true, limitBytes: limit, periodHours: 1 });
  const options = { credentials: { username: 'test-user', password: 'secret-ftp-password' }, credentialScope: 'ftp-account-v1', quota };
  await assert.rejects(downloadFtp(f.url, f.path, options), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  const checkpoint = JSON.parse(await readFile(f.path + '.ftp-resume.json', 'utf8'));
  assert.equal(checkpoint.received, limit); assert.equal(checkpoint.credentialScope, options.credentialScope);
  assert.deepEqual(await readFile(f.path + '.part'), f.original.subarray(0, limit));
  assert.equal(quota.snapshot().usedBytes, limit);
  const restored = await new QuotaStore(directory, { now: () => now }).init();
  const before = f.retrievals;
  await assert.rejects(downloadFtp(f.url, f.path, { ...options, quota: restored }), { code: 'DOWNLOAD_QUOTA_EXCEEDED' });
  assert.equal(f.retrievals, before, 'a spent allowance does not issue another RETR');
  now = restored.snapshot().resetAt;
  await restored.refresh();
  await restored.configure({ enabled: true, limitBytes: f.original.length, periodHours: 1 });
  await downloadFtp(f.url, f.path, { ...options, quota: restored });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok(f.requests.some(record => record.command === 'REST' && Number(record.value) === limit));
  assert.equal(limit + restored.snapshot().usedBytes, f.original.length);
});

test('FTP completes successfully when its last byte equals the allowance', async t => {
  const f = await ftpFixture(t);
  const quota = await new QuotaStore(join(f.directory, 'quota')).init();
  await quota.configure({ enabled: true, limitBytes: f.original.length, periodHours: 24 });
  await downloadFtp(f.url, f.path, { quota });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(quota.snapshot().usedBytes, f.original.length);
});
