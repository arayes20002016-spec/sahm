import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DownloadManager } from '../src/manager.mjs';
import { CredentialVault } from '../src/credential-vault.mjs';
import { ftpFixture as createFtpFixture } from './helpers/ftp-fixture.mjs';

const login = { username: 'test-user', password: 'secret-ftp-password' };

async function ftpFixture(t, options) {
  const cleanup = [], fixture = await createFtpFixture({ after: fn => cleanup.push(fn) }, options);
  fixture.managers = [];
  t.after(async () => {
    let failure;
    try {
      for (const manager of fixture.managers) {
        // Tests deliberately restore another manager in this directory. An old
        // closed instance must not rewrite its stale snapshot during cleanup.
        if (!manager.stopped) await manager.close();
      }
    } catch (error) { failure = error; }
    finally { for (const close of cleanup) await close(); }
    if (failure) throw failure;
  });
  return fixture;
}

function fakeProtector() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

async function manager(t, fixture, options = {}) {
  const value = await new DownloadManager(join(fixture.directory, 'data'), join(fixture.directory, 'downloads'), options).init();
  fixture.managers.push(value); return value;
}

async function waitFor(manager, id, predicate) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const job = manager.list().find(value => value.id === id);
    if (predicate(job)) return job;
    if (job?.status === 'error') assert.fail(`Unexpected FTP error: ${job.error}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('FTP job did not reach the expected state');
}

test('manager extracts FTP URL credentials, persists no secrets and requires re-entry after RAM loss', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), first = await manager(t, f);
  const job = await first.add({ url: f.url.replace('ftp://', 'ftp://test-user:secret-ftp-password@'), startAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal(job.kind, 'ftp'); assert.equal(job.connections, 1); assert.equal(job.url, f.url);
  assert.equal(job.ftpAuthenticated, true); assert.ok(job.ftpCredentialScope);
  const saved = await readFile(join(f.directory, 'data', 'jobs.json'), 'utf8');
  for (const secret of [login.username, login.password]) assert.equal((JSON.stringify(first.list()) + saved).includes(secret), false);
  await first.close();
  const restored = await manager(t, f), pending = restored.list()[0];
  assert.equal(pending.status, 'paused'); assert.equal(pending.needsCredentials, true);
  await assert.rejects(restored.action(job.id, 'resume'), /بيانات/);
  restored.pump(); assert.equal(f.requests.length, 0);
  const updated = await restored.updateFtpCredentials(job.id, login);
  assert.notEqual(updated.ftpCredentialScope, job.ftpCredentialScope);
  await restored.action(job.id, 'resume');
  const completed = await waitFor(restored, job.id, item => item.status === 'complete');
  assert.deepEqual(await readFile(completed.path), f.original);
});

test('remembered FTP credentials restore from the encrypted vault without plaintext job records', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), protector = fakeProtector();
  const vault = await new CredentialVault(join(f.directory, 'data'), protector).init();
  const first = await manager(t, f, { vault });
  const job = await first.add({ url: f.url, credentials: login, rememberCredentials: true, startAt: new Date(Date.now() + 3600000).toISOString() });
  assert.ok(job.credentialRef); await first.close();
  const serialized = Buffer.concat([await readFile(join(f.directory, 'data', 'jobs.json')), await readFile(join(f.directory, 'data', 'credentials.dat'))]).toString('utf8');
  for (const secret of [login.username, login.password]) assert.equal(serialized.includes(secret), false);
  const restoredVault = await new CredentialVault(join(f.directory, 'data'), protector).init();
  const restored = await manager(t, f, { vault: restoredVault });
  assert.equal(restored.list()[0].needsCredentials, false);
  await restored.action(job.id, 'resume');
  const completed = await waitFor(restored, job.id, item => item.status === 'complete');
  assert.deepEqual(await readFile(completed.path), f.original);
});

test('manager pauses and resumes FTP with REST using the same credential scope', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), value = await manager(t, f);
  value.speedLimit = 256 * 1024;
  const job = await value.add({ url: f.url, credentials: login });
  await waitFor(value, job.id, item => item.status === 'downloading' && item.received >= 32768);
  await value.action(job.id, 'pause');
  const partial = JSON.parse(await readFile(job.path + '.ftp-resume.json', 'utf8'));
  assert.equal(partial.credentialScope, job.ftpCredentialScope);
  assert.ok(partial.received > 0 && partial.received < f.original.length);
  value.speedLimit = 0; await value.action(job.id, 'resume');
  const completed = await waitFor(value, job.id, item => item.status === 'complete');
  assert.deepEqual(await readFile(completed.path), f.original);
  assert.ok(f.requests.some(record => record.command === 'REST' && Number(record.value) === partial.received));
});

test('updating FTP credentials rotates scope and safely preserves old partial data', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), value = await manager(t, f);
  value.speedLimit = 256 * 1024;
  const job = await value.add({ url: f.url, credentials: login });
  await waitFor(value, job.id, item => item.status === 'downloading' && item.received >= 32768);
  await value.action(job.id, 'pause');
  const updated = await value.updateFtpCredentials(job.id, login);
  assert.notEqual(updated.ftpCredentialScope, job.ftpCredentialScope);
  value.speedLimit = 0; await value.action(job.id, 'resume');
  const completed = await waitFor(value, job.id, item => item.status === 'complete');
  assert.deepEqual(await readFile(completed.path), f.original);
  assert.equal(f.requests.filter(record => record.command === 'REST' && Number(record.value) > 0).length, 0);
  assert.ok((await readdir(join(job.path, '..'))).some(name => name.includes('.part.stale-')));
});

test('changing remembered FTP credentials to session-only removes the old vault entry', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), vault = await new CredentialVault(join(f.directory, 'data'), fakeProtector()).init();
  const value = await manager(t, f, { vault });
  const job = await value.add({ url: f.url, credentials: login, rememberCredentials: true, startAt: new Date(Date.now() + 3600000).toISOString() });
  assert.deepEqual(vault.get(job.credentialRef), login);
  const updated = await value.updateFtpCredentials(job.id, login, false);
  assert.equal(updated.credentialRef, undefined);
  assert.equal(vault.get(job.credentialRef), null);
  await value.close();
  const restored = await manager(t, f, { vault });
  assert.equal(restored.list()[0].needsCredentials, true);
});
