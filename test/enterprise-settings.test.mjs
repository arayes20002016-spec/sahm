import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import tls from 'node:tls';
import { Preferences } from '../src/preferences.mjs';
import { CredentialVault } from '../src/credential-vault.mjs';
import { ConnectionSettings, proxyCredentialKey } from '../src/connection-settings.mjs';
import { serverCredentialKey } from '../src/enterprise-auth.mjs';
import { clientCertificateKey } from '../src/client-certificates.mjs';

const origin = 'https://enterprise.example.test', otherOrigin = 'https://another.example.test';
const password = 'enterprise-unit-private-password', phrase = 'enterprise-unit-pfx-phrase';
const openssl = process.env.SAHM_TEST_OPENSSL || (process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');

function protector() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'); }
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-enterprise-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pfxFile = join(directory, 'client.pfx');
  const cert = fileURLToPath(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), key = fileURLToPath(new URL('./fixtures/ftp/server-key.pem', import.meta.url));
  await new Promise((resolve, reject) => {
    const child = execFile(openssl, ['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', pfxFile, '-passout', 'stdin'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, failure => failure ? reject(new Error('Cannot build local PFX test fixture.')) : resolve());
    child.stdin.on('error', () => {}); child.stdin.end(phrase + '\n');
  });
  const encryption = protector(), preferences = await new Preferences(directory, join(directory, 'files')).init(), vault = await new CredentialVault(directory, encryption).init();
  const network = {
    config: null, calls: [], failNext: false,
    async configure(config) { this.calls.push(structuredClone(config)); if (this.failNext) { this.failNext = false; throw new Error('synthetic enterprise network failure'); } this.config = structuredClone(config); }
  };
  const settings = await new ConnectionSettings(network, preferences, vault).init();
  const config = { mode: 'direct', authentication: { proxy: { scheme: 'basic', currentAccount: false, allowedHosts: [] }, servers: [{ origin, scheme: 'ntlm', currentAccount: false }] }, clientCertificates: [{ origin, pfxFile, enabled: true }] };
  const data = { config, serverCredentials: [{ origin, username: 'DOMAIN\\fixture-user', password, remember: true }], clientCertificateSecrets: [{ origin, passphrase: phrase, remember: true }] };
  return { directory, pfxFile, encryption, preferences, vault, network, settings, config, data };
}

test('enterprise credentials and PFX passphrases stay out of preferences, snapshots and network configuration', async t => {
  const { directory, settings, data, preferences, network, vault, pfxFile } = await fixture(t);
  const originalPfx = createHash('sha256').update(await readFile(pfxFile)).digest('hex'), roots = [...tls.rootCertificates];
  const snapshot = await settings.save(data);
  assert.equal(settings.serverCredentialsFor(origin).password, password);
  assert.equal(settings.serverCredentialsFor(otherOrigin), null);
  assert.equal((await settings.clientCertificateFor(origin)).passphrase, phrase);
  assert.equal(await settings.clientCertificateFor(otherOrigin), null);
  assert.deepEqual(snapshot.serverLogins, [{ origin, username: 'DOMAIN\\fixture-user', hasPassword: true, remembered: true }]);
  assert.deepEqual(snapshot.clientCertificateLogins, [{ origin, hasPassphrase: true, remembered: true }]);
  for (const text of [JSON.stringify(snapshot), JSON.stringify(network.config), JSON.stringify(preferences.snapshot()), await readFile(join(directory, 'preferences.json'), 'utf8')]) {
    assert.ok(!text.includes(password)); assert.ok(!text.includes(phrase));
  }
  const encrypted = await readFile(join(directory, 'credentials.dat'));
  assert.equal(encrypted.includes(Buffer.from(password)), false); assert.equal(encrypted.includes(Buffer.from(phrase)), false);
  assert.equal(vault.get(serverCredentialKey(origin)).password, password);
  assert.equal(vault.get(clientCertificateKey(origin)).username, 'tls-client-pfx');
  assert.equal(createHash('sha256').update(await readFile(pfxFile)).digest('hex'), originalPfx);
  assert.deepEqual(tls.rootCertificates, roots, 'Client identity loading must not alter Node trust roots.');
});

test('remembered enterprise identities survive service restart and blank fields retain the same scoped secrets', async t => {
  const { directory, encryption, preferences, network, settings, data } = await fixture(t);
  await settings.save(data);
  const reloaded = await new ConnectionSettings(network, preferences, await new CredentialVault(directory, encryption).init()).init();
  assert.equal(reloaded.serverCredentialsFor(origin).password, password);
  assert.equal((await reloaded.clientCertificateFor(origin)).passphrase, phrase);
  await reloaded.save({ ...data, serverCredentials: [{ ...data.serverCredentials[0], password: '' }], clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], passphrase: '' }] });
  assert.equal(reloaded.serverCredentialsFor(origin).password, password);
  assert.equal((await reloaded.clientCertificateFor(origin)).passphrase, phrase);
});

test('unchecking remember deletes persisted secrets but retains only the current session identity', async t => {
  const { directory, encryption, preferences, network, settings, data, vault } = await fixture(t);
  await settings.save(data);
  await settings.save({ ...data, serverCredentials: [{ ...data.serverCredentials[0], password: '', remember: false }], clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], passphrase: '', remember: false }] });
  assert.equal(vault.get(serverCredentialKey(origin)), null); assert.equal(vault.get(clientCertificateKey(origin)), null);
  assert.equal(settings.serverCredentialsFor(origin).password, password); assert.equal((await settings.clientCertificateFor(origin)).passphrase, phrase);
  const reloaded = await new ConnectionSettings(network, preferences, await new CredentialVault(directory, encryption).init()).init();
  assert.equal(reloaded.serverCredentialsFor(origin), null);
  await assert.rejects(reloaded.clientCertificateFor(origin), { code: 'CLIENT_CERTIFICATE_INVALID' });
});

test('removing profiles or selecting the Windows current account removes their stored credentials', async t => {
  const { settings, config, data, vault } = await fixture(t);
  await settings.save(data);
  await settings.save({ config: { ...config, authentication: { ...config.authentication, servers: [{ ...config.authentication.servers[0], currentAccount: true }] }, clientCertificates: [] } });
  assert.equal(settings.serverCredentialsFor(origin), null); assert.equal(await settings.clientCertificateFor(origin), null);
  assert.equal(vault.get(serverCredentialKey(origin)), null); assert.equal(vault.get(clientCertificateKey(origin)), null);
});

test('a later vault write failure restores prior stored credentials, memory and active configuration', async t => {
  const { directory, encryption, preferences, network, settings, data, vault } = await fixture(t);
  await settings.save(data);
  const before = preferences.snapshot().network, set = vault.set.bind(vault); let fail = true;
  vault.set = async (key, value) => { if (key === clientCertificateKey(origin) && fail) { fail = false; throw new Error('synthetic second vault write failure'); } return set(key, value); };
  await assert.rejects(settings.save({ ...data, serverCredentials: [{ ...data.serverCredentials[0], password: 'rejected-server-password' }] }), /second vault write failure/);
  assert.equal(settings.serverCredentialsFor(origin).password, password); assert.equal((await settings.clientCertificateFor(origin)).passphrase, phrase);
  assert.deepEqual(preferences.snapshot().network, before); assert.deepEqual(network.config, before);
  const restored = await new CredentialVault(directory, encryption).init();
  assert.equal(restored.get(serverCredentialKey(origin)).password, password); assert.equal(restored.get(clientCertificateKey(origin)).password, phrase);
});

test('bad PFX, network configure and preference persistence failures roll back enterprise changes', async t => {
  const { settings, data, config, preferences, network, vault } = await fixture(t);
  await settings.save(data);
  const before = preferences.snapshot().network;
  const changed = { ...data, serverCredentials: [{ ...data.serverCredentials[0], username: 'DOMAIN\\replacement', password: 'replacement-secret' }] };
  await assert.rejects(settings.save({ ...changed, clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], passphrase: 'incorrect-private-phrase' }] }), { code: 'CLIENT_CERTIFICATE_INVALID' });
  network.failNext = true;
  await assert.rejects(settings.save(changed), /enterprise network failure/);
  const update = preferences.update.bind(preferences);
  preferences.update = async () => { throw new Error('synthetic enterprise preferences failure'); };
  await assert.rejects(settings.save(changed), /enterprise preferences failure/);
  preferences.update = update;
  assert.deepEqual(preferences.snapshot().network, before); assert.deepEqual(network.config, before);
  assert.equal(settings.serverCredentialsFor(origin).password, password);
  assert.equal(vault.get(serverCredentialKey(origin)).password, password); assert.equal(vault.get(clientCertificateKey(origin)).password, phrase);
  await settings.save({ config, serverCredentials: [{ ...data.serverCredentials[0], remember: false }], clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], remember: false }] });
  assert.equal(settings.snapshot().serverLogins[0].remembered, false);
});

test('secrets are accepted only for matching explicit origins and enabled credential policies', async t => {
  const { settings, data, config, preferences, network } = await fixture(t);
  const before = preferences.snapshot().network, calls = network.calls.length;
  for (const change of [
    { serverCredentials: [{ ...data.serverCredentials[0], origin: otherOrigin }] },
    { serverCredentials: [data.serverCredentials[0], data.serverCredentials[0]] },
    { serverCredentials: [{ ...data.serverCredentials[0], password: 'bad\npassword' }] },
    { clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], origin: otherOrigin }] },
    { clientCertificateSecrets: [data.clientCertificateSecrets[0], data.clientCertificateSecrets[0]] },
    { clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], passphrase: null }] },
    { config: { ...config, authentication: { ...config.authentication, servers: [{ ...config.authentication.servers[0], currentAccount: true }] } } }
  ]) await assert.rejects(settings.save({ ...data, ...change }));
  assert.deepEqual(preferences.snapshot().network, before); assert.equal(network.calls.length, calls);
});

test('unavailable encryption rejects remembered identities and still permits an explicit session-only login', async t => {
  const { settings, data, preferences, vault } = await fixture(t);
  const before = preferences.snapshot().network;
  vault.locked = true;
  await assert.rejects(settings.save(data), /تشفير/);
  assert.deepEqual(preferences.snapshot().network, before); assert.equal(settings.serverCredentialsFor(origin), null);
  await settings.save({ ...data, serverCredentials: [{ ...data.serverCredentials[0], remember: false }], clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], remember: false }] });
  assert.equal(settings.serverCredentialsFor(origin).password, password); assert.equal((await settings.clientCertificateFor(origin)).passphrase, phrase);
  assert.equal(settings.snapshot().encryptionAvailable, false); assert.equal(settings.snapshot().serverLogins[0].remembered, false);
});

test('malformed secret entries and nonboolean flags fail before any vault, memory or network mutation', async t => {
  const { settings, data, preferences, network, vault, config } = await fixture(t);
  const before = preferences.snapshot().network, initialCalls = network.calls.length, set = vault.set.bind(vault); let writes = 0;
  vault.set = async (...args) => { writes++; return set(...args); };
  const malformed = [
    { serverCredentials: [null] }, { serverCredentials: [false] }, { serverCredentials: [[]] },
    { serverCredentials: [{ ...data.serverCredentials[0], remember: 'false' }] },
    { serverCredentials: [{ ...data.serverCredentials[0], clearCredentials: 'false' }] },
    { clientCertificateSecrets: [null] }, { clientCertificateSecrets: [1] }, { clientCertificateSecrets: [[]] },
    { clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], remember: 'true' }] },
    { clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], clearPassphrase: 'false' }] },
    { config: { ...config, mode: 'manual', proxy: { type: 'http', host: 'proxy.example.test', port: 3128 } }, username: 'fixture', password, remember: 'true' },
    { config: { ...config, mode: 'manual', proxy: { type: 'http', host: 'proxy.example.test', port: 3128 } }, username: 'fixture', password, clearCredentials: 'false' }
  ];
  for (const change of malformed) await assert.rejects(settings.save({ ...data, ...change }), failure => {
    assert.match(failure.message, /غير صالحة/); assert.equal(failure instanceof TypeError, false); return true;
  });
  assert.equal(writes, 0); assert.equal(settings.memory.size, 0); assert.deepEqual(vault.values, {});
  assert.deepEqual(preferences.snapshot().network, before); assert.equal(network.calls.length, initialCalls);
});

test('a failed rollback reports incomplete restoration without exposing either internal failure', async t => {
  const { settings, data, preferences, network, vault } = await fixture(t);
  await settings.save(data);
  const before = preferences.snapshot().network, set = vault.set.bind(vault); let writes = 0;
  vault.set = async (key, value) => {
    writes++;
    if (writes === 3) throw new Error('private-rollback-storage-details');
    await set(key, value);
    if (writes === 2) throw new Error('private-write-storage-details');
  };
  await assert.rejects(settings.save({ ...data, serverCredentials: [{ ...data.serverCredentials[0], password: 'rejected-server-secret' }], clientCertificateSecrets: [{ ...data.clientCertificateSecrets[0], passphrase: 'rejected-pfx-secret' }] }), failure => {
    assert.match(failure.message, /استعادة جميع بياناته السابقة/); assert.ok(!failure.message.includes('private-')); assert.equal(failure.cause, undefined); return true;
  });
  assert.deepEqual(preferences.snapshot().network, before); assert.deepEqual(network.config, before);
  assert.equal(settings.serverCredentialsFor(origin).password, password);
  assert.equal(settings.memory.get(clientCertificateKey(origin)).password, phrase);
  assert.equal(vault.get(clientCertificateKey(origin)).password, 'rejected-pfx-secret', 'The explicit warning must not claim that an unavailable vault rollback succeeded.');
});

test('choosing the current Windows proxy account removes an old explicit proxy secret despite stale UI fields', async t => {
  const { settings, data, config, vault } = await fixture(t);
  const manual = { ...config, mode: 'manual', proxy: { type: 'http', host: 'proxy.example.test', port: 3128 } };
  await settings.save({ ...data, config: manual, username: 'DOMAIN\\old-proxy-user', password: 'old-explicit-proxy-secret', remember: true });
  assert.equal(vault.get(proxyCredentialKey(manual)).password, 'old-explicit-proxy-secret');
  await settings.save({ ...data, config: { ...manual, authentication: { ...manual.authentication, proxy: { scheme: 'ntlm', currentAccount: true, allowedHosts: ['proxy.example.test'] } } }, username: 'DOMAIN\\old-proxy-user', password: 'stale-explicit-value', remember: true });
  assert.equal(vault.get(proxyCredentialKey(manual)), null); assert.equal(settings.credentialsFor(manual), null);
  assert.equal(settings.snapshot().hasPassword, false); assert.equal(settings.snapshot().remembered, false);
});
