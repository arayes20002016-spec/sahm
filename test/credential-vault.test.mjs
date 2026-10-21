import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialVault } from '../src/credential-vault.mjs';

function protector() {
  const key = randomBytes(32);
  return {
    enabled: true, failEncryption: false,
    isEncryptionAvailable() { return this.enabled; },
    encryptString(text) {
      if (this.failEncryption) throw new Error('Mock protector failed');
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
const directory = () => mkdtemp(join(tmpdir(), 'sahm-vault-test-'));

test('vault round trips encrypted records, preserves concurrent updates and returns detached credentials', async () => {
  const root = await directory(), encryption = protector(), vault = await new CredentialVault(root, encryption).init();
  await Promise.all([vault.set('ftp:first', { username: 'test-user', password: 'sensitive-first' }), vault.set('proxy:second', { username: 'other-user', password: 'sensitive-second' })]);
  const bytes = await readFile(join(root, 'credentials.dat'));
  for (const plaintext of ['test-user', 'sensitive-first', 'other-user', 'sensitive-second']) assert.ok(!bytes.includes(Buffer.from(plaintext)));
  const restored = await new CredentialVault(root, encryption).init();
  assert.deepEqual(restored.get('ftp:first'), { username: 'test-user', password: 'sensitive-first' });
  assert.deepEqual(restored.get('proxy:second'), { username: 'other-user', password: 'sensitive-second' });
  const copy = restored.get('ftp:first'); copy.password = 'mutated';
  assert.equal(restored.get('ftp:first').password, 'sensitive-first');
  await restored.set('ftp:first', null);
  const removed = await new CredentialVault(root, encryption).init();
  assert.equal(removed.get('ftp:first'), null); assert.ok(removed.get('proxy:second'));
});

test('unavailable or invalid protector locks an existing vault without overwriting its encrypted bytes', async () => {
  const root = await directory(), encryption = protector(), vault = await new CredentialVault(root, encryption).init();
  await vault.set('ftp:account', { username: 'account', password: 'secret' });
  const before = await readFile(vault.file);
  encryption.enabled = false;
  const locked = await new CredentialVault(root, encryption).init();
  assert.equal(locked.available(), false); assert.equal(locked.get('ftp:account'), null); assert.match(locked.loadError, /تعذّر/);
  await assert.rejects(locked.set('ftp:account', { username: 'new', password: 'new' }), /تشفير/);
  assert.deepEqual(await readFile(vault.file), before);
  const wrongAccount = await new CredentialVault(root, protector()).init();
  assert.equal(wrongAccount.locked, true); assert.equal(wrongAccount.get('ftp:account'), null);
  assert.deepEqual(await readFile(vault.file), before);
});

test('encryption and disk-write failures keep the last committed records and a later save recovers', async () => {
  const root = await directory(), encryption = protector(), vault = await new CredentialVault(root, encryption).init();
  const previous = { username: 'old', password: 'old-secret' };
  await vault.set('ftp:account', previous);
  const before = await readFile(vault.file);
  encryption.failEncryption = true;
  await assert.rejects(vault.set('ftp:account', { username: 'new', password: 'new-secret' }), /protector failed/);
  assert.deepEqual(vault.get('ftp:account'), previous); assert.deepEqual(await readFile(vault.file), before);
  encryption.failEncryption = false;
  await mkdir(vault.file + '.tmp');
  await assert.rejects(vault.set('ftp:account', { username: 'new', password: 'new-secret' }));
  assert.deepEqual(vault.get('ftp:account'), previous); assert.deepEqual(await readFile(vault.file), before);
  await rmdir(vault.file + '.tmp');
  await vault.set('ftp:account', { username: 'saved', password: 'saved-secret' });
  assert.equal((await new CredentialVault(root, encryption).init()).get('ftp:account').password, 'saved-secret');
});

test('invalid credential input is rejected before creating files, and malformed decrypted data locks safely', async () => {
  const root = await directory(), encryption = protector(), vault = await new CredentialVault(root, encryption).init();
  await assert.rejects(vault.set('../outside', { username: 'a', password: 'b' }), /معرّف/);
  await assert.rejects(vault.set('ftp:account', { username: 'a\r\nb', password: 'b' }), /غير صالحة/);
  await assert.rejects(vault.set('ftp:account', { username: 'a', password: 'b'.repeat(4097) }), /غير صالحة/);
  await assert.rejects(readFile(vault.file), { code: 'ENOENT' });
  await writeFile(vault.file, encryption.encryptString(JSON.stringify({ version: 900, values: {} })));
  const malformed = await new CredentialVault(root, encryption).init();
  assert.equal(malformed.locked, true); assert.equal(malformed.available(), false);
});
