import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Preferences } from '../src/preferences.mjs';
import { CredentialVault } from '../src/credential-vault.mjs';
import { ConnectionSettings, proxyCredentialKey } from '../src/connection-settings.mjs';

function protector() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}
const proxy = (host = 'proxy.test', port = 3128, type = 'http') => ({ mode: 'manual', bypass: ['localhost'], proxy: { host, port, type } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sahm-connection-test-')), encryption = protector();
  const preferences = await new Preferences(root, join(root, 'downloads')).init();
  const vault = await new CredentialVault(root, encryption).init();
  const network = { calls: [], config: null, failNext: false, async configure(config) { this.calls.push(structuredClone(config)); if (this.failNext) { this.failNext = false; throw new Error('proxy configure failed'); } this.config = structuredClone(config); } };
  const settings = await new ConnectionSettings(network, preferences, vault).init();
  return { root, encryption, preferences, vault, network, settings };
}

test('proxy login is scoped by protocol, host and port, and preferences and snapshots never expose its password', async () => {
  const { settings, root, vault } = await fixture();
  const config = proxy('PROXY.test');
  await settings.save({ config, username: 'account', password: 'secret-persisted-password', remember: true });
  const route = { type: 'http', host: 'proxy.test', port: 3128 };
  assert.deepEqual(settings.credentialsFor(route), { username: 'account', password: 'secret-persisted-password' });
  assert.equal(settings.credentialsFor({ ...route, host: 'different.test' }), null);
  assert.equal(settings.credentialsFor({ ...route, port: 3129 }), null);
  assert.equal(settings.credentialsFor({ ...route, type: 'socks5' }), null);
  assert.equal(proxyCredentialKey(config), proxyCredentialKey(route));
  const snapshot = settings.snapshot();
  assert.equal(snapshot.username, 'account'); assert.equal(snapshot.hasPassword, true); assert.equal(snapshot.remembered, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-persisted-password/);
  const plainPreferences = await readFile(join(root, 'preferences.json'), 'utf8');
  assert.doesNotMatch(plainPreferences, /secret-persisted-password|account|password|username/);
  assert.ok(vault.get(proxyCredentialKey(config)));
});

test('turning off remember removes old stored credentials while retaining only the current session login', async () => {
  const { settings, root, encryption, network, preferences } = await fixture(), config = proxy();
  await settings.save({ config, username: 'account', password: 'remembered-secret', remember: true });
  await settings.save({ config, username: 'account', password: '', remember: false });
  assert.deepEqual(settings.credentialsFor(config), { username: 'account', password: 'remembered-secret' });
  assert.equal(settings.snapshot().remembered, false);
  const restoredVault = await new CredentialVault(root, encryption).init();
  assert.equal(restoredVault.get(proxyCredentialKey(config)), null);
  const restarted = await new ConnectionSettings(network, preferences, restoredVault).init();
  assert.equal(restarted.credentialsFor(config), null); assert.equal(restarted.snapshot().hasPassword, false);
  await settings.save({ config, username: 'account', password: '', remember: false, clearCredentials: true });
  assert.equal(settings.credentialsFor(config), null);
});

test('failed network configuration rolls back the stored login, session memory and effective proxy', async () => {
  const { settings, network, preferences, vault, root, encryption } = await fixture(), config = proxy();
  await settings.save({ config, username: 'old-account', password: 'old-secret', remember: true });
  const previousConfig = preferences.snapshot().network;
  network.failNext = true;
  await assert.rejects(settings.save({ config, username: 'new-account', password: 'new-secret', remember: true }), /configure failed/);
  assert.deepEqual(settings.credentialsFor(config), { username: 'old-account', password: 'old-secret' });
  assert.deepEqual(vault.get(proxyCredentialKey(config)), { username: 'old-account', password: 'old-secret' });
  assert.deepEqual(preferences.snapshot().network, previousConfig); assert.deepEqual(network.config, previousConfig);
  assert.equal((await new CredentialVault(root, encryption).init()).get(proxyCredentialKey(config)).password, 'old-secret');
  await settings.save({ config, username: 'recovered', password: 'recovered-secret', remember: false });
  assert.equal(settings.credentialsFor(config).username, 'recovered');
});

test('preference commit failure restores the previous proxy and removes credentials created for the rejected route', async () => {
  const { settings, preferences, network, vault } = await fixture(), original = proxy('original.test'), rejected = proxy('rejected.test');
  await settings.save({ config: original, username: 'original', password: 'old-secret', remember: true });
  const before = preferences.snapshot().network, update = preferences.update.bind(preferences);
  preferences.update = async () => { throw new Error('preferences cannot commit'); };
  await assert.rejects(settings.save({ config: rejected, username: 'rejected', password: 'new-secret', remember: true }), /cannot commit/);
  preferences.update = update;
  assert.deepEqual(network.config, before); assert.deepEqual(preferences.snapshot().network, before);
  assert.equal(settings.credentialsFor(rejected), null); assert.equal(vault.get(proxyCredentialKey(rejected)), null);
  assert.equal(settings.credentialsFor(original).password, 'old-secret');
});

test('invalid login or unavailable encryption does not partially change proxy configuration', async () => {
  const { settings, preferences, network, vault } = await fixture(), config = proxy();
  const before = preferences.snapshot().network, calls = network.calls.length;
  await assert.rejects(settings.save({ config, username: 'bad:user', password: 'secret', remember: true }), /غير صالحة/);
  assert.equal(network.calls.length, calls); assert.deepEqual(preferences.snapshot().network, before);
  vault.locked = true;
  await assert.rejects(settings.save({ config, username: 'account', password: 'secret', remember: true }), /تشفير/);
  assert.equal(settings.credentialsFor(config), null); assert.deepEqual(preferences.snapshot().network, before);
  await settings.save({ config, username: 'account', password: 'session-secret', remember: false });
  assert.equal(settings.credentialsFor(config).password, 'session-secret'); assert.equal(settings.snapshot().remembered, false);
});
