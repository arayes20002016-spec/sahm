import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import https from 'node:https';
import tls from 'node:tls';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { clientCertificateKey, loadClientCertificate, MAX_CLIENT_CERTIFICATE_BYTES, normalizeClientCertificateOrigin, normalizeClientCertificates } from '../src/client-certificates.mjs';
import { clientIdentityTlsOptions, clearClientIdentityCache } from '../src/client-certificate-identity.mjs';

let directory, pfxFile, emptyPasswordFile, unicodePasswordFile, certOnlyFile, wrongClientFile, serverTrustBundleFile, serverOnlyFile, expiredFile, futureFile, clientCertificate, serverCertificate, serverKey;
const phrase = 'sahm-local-pfx-phrase-94a2';
const unicodePhrase = 'تجربة-é-🔑';
const origin = 'https://client.example.test';
const openssl = process.env.SAHM_TEST_OPENSSL || (process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');

async function opensslFixture(args, passphrase = '') {
  assert.ok(!args.some(value => value.includes(phrase)), 'Passphrases must never enter command-line arguments.');
  await new Promise((resolve, reject) => {
    const child = execFile(openssl, args, { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, failure => failure ? reject(new Error('OpenSSL test fixture creation failed: ' + (failure.code || 'unknown'))) : resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(passphrase + '\n');
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sahm-client-certificates-'));
  const key = join(directory, 'client-key.pem'), cert = join(directory, 'client-cert.pem');
  pfxFile = join(directory, 'client.pfx'); emptyPasswordFile = join(directory, 'client-empty.p12'); certOnlyFile = join(directory, 'no-private-key.pfx'); wrongClientFile = join(directory, 'untrusted-client.pfx');
  const serverCertPath = fileURLToPath(new URL('./fixtures/ftp/server-cert.pem', import.meta.url));
  const serverKeyPath = fileURLToPath(new URL('./fixtures/ftp/server-key.pem', import.meta.url));
  await opensslFixture(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=SAHM Local Client', '-addext', 'extendedKeyUsage=clientAuth', '-addext', 'basicConstraints=critical,CA:FALSE']);
  unicodePasswordFile = join(directory, 'client-unicode.pfx');
  for (const [output, password] of [[pfxFile, phrase], [emptyPasswordFile, ''], [unicodePasswordFile, unicodePhrase]]) await opensslFixture(['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', output, '-passout', 'stdin'], password);
  await opensslFixture(['pkcs12', '-export', '-in', cert, '-nokeys', '-out', certOnlyFile, '-passout', 'stdin'], phrase);
  await opensslFixture(['pkcs12', '-export', '-in', serverCertPath, '-inkey', serverKeyPath, '-out', wrongClientFile, '-passout', 'stdin'], phrase);
  serverTrustBundleFile = join(directory, 'client-plus-untrusted-server-ca.pfx');
  await opensslFixture(['pkcs12', '-export', '-in', cert, '-inkey', key, '-certfile', serverCertPath, '-out', serverTrustBundleFile, '-passout', 'stdin'], phrase);
  const serverOnlyKey = join(directory, 'server-only-key.pem'), serverOnlyCert = join(directory, 'server-only-cert.pem');
  serverOnlyFile = join(directory, 'server-only-identity.pfx');
  await opensslFixture(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', serverOnlyKey, '-out', serverOnlyCert, '-days', '2', '-subj', '/CN=SAHM Server Only', '-addext', 'extendedKeyUsage=serverAuth']);
  await opensslFixture(['pkcs12', '-export', '-in', serverOnlyCert, '-inkey', serverOnlyKey, '-out', serverOnlyFile, '-passout', 'stdin'], phrase);
  const database = join(directory, 'ca-index.txt'), serial = join(directory, 'ca-serial'), config = join(directory, 'ca.cnf');
  const quote = value => '"' + value.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  await Promise.all([writeFile(database, ''), writeFile(serial, '01\n'), writeFile(config, `[ca]\ndefault_ca = fixture\n[fixture]\ndatabase = ${quote(database)}\nserial = ${quote(serial)}\nnew_certs_dir = ${quote(directory)}\ncertificate = ${quote(serverCertPath)}\nprivate_key = ${quote(serverKeyPath)}\ndefault_md = sha256\npolicy = client_policy\n[client_policy]\ncommonName = supplied\n[client_extensions]\nbasicConstraints = critical,CA:FALSE\nextendedKeyUsage = clientAuth\n`)]);
  for (const [label, start, end] of [['expired', '20200101000000Z', '20210101000000Z'], ['future', '20990101000000Z', '21000101000000Z']]) {
    const csr = join(directory, `${label}.csr`), signed = join(directory, `${label}.pem`), output = join(directory, `${label}.pfx`);
    await opensslFixture(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=SAHM ${label} client`]);
    await opensslFixture(['ca', '-config', config, '-batch', '-in', csr, '-out', signed, '-startdate', start, '-enddate', end, '-notext', '-extensions', 'client_extensions']);
    await opensslFixture(['pkcs12', '-export', '-in', signed, '-inkey', key, '-out', output, '-passout', 'stdin'], phrase);
    if (label === 'expired') expiredFile = output;
    else futureFile = output;
  }
  [clientCertificate, serverCertificate, serverKey] = await Promise.all([readFile(cert), readFile(serverCertPath), readFile(serverKeyPath)]);
});

after(async () => { clearClientIdentityCache(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('client certificate profiles canonicalize exact HTTPS origins and keep secrets out of persisted data', () => {
  const input = [{ origin: 'HTTPS://Client.Example.Test:443/', pfxFile }];
  const profiles = normalizeClientCertificates(input);
  assert.deepEqual(profiles, [{ origin, pfxFile, enabled: true }]);
  input[0].pfxFile = 'modified';
  assert.equal(profiles[0].pfxFile, pfxFile);
  assert.deepEqual(normalizeClientCertificates(), []);
  assert.equal(normalizeClientCertificateOrigin('https://[::1]:8443/'), 'https://[::1]:8443');
  assert.equal(clientCertificateKey(origin), clientCertificateKey('https://CLIENT.EXAMPLE.TEST:443/'));
  assert.match(clientCertificateKey(origin), /^client-cert:[a-f0-9]{64}$/);
  assert.notEqual(clientCertificateKey(origin), clientCertificateKey(origin + ':8443'));
});

test('client certificate schemas reject paths, account data, wildcards, duplicates, excess profiles and unknown fields', () => {
  for (const address of ['http://client.example.test', 'https://client.example.test/file', 'https://client.example.test/?', 'https://client.example.test/#', 'https://user:secret@client.example.test', 'https://@client.example.test', 'https://*.example.test', ' https://client.example.test', 'https:\\\\client.example.test', 'file:///client.pfx', '', null, {}]) {
    assert.throws(() => normalizeClientCertificates([{ origin: address, pfxFile }]), { code: 'CLIENT_CERTIFICATE_ORIGIN' });
  }
  for (const input of [null, {}, 'bad', [null], [{ origin, pfxFile, passphrase: phrase }], [{ origin, pfxFile, enabled: 'true' }], [{ origin, pfxFile }, { origin: origin + ':443/', pfxFile }], Array.from({ length: 33 }, (_, index) => ({ origin: `https://client${index}.example.test`, pfxFile }))]) {
    assert.throws(() => normalizeClientCertificates(input));
  }
  for (const path of ['relative.pfx', pfxFile + '\0secret', pfxFile + '\n', 'x'.repeat(4097)]) assert.throws(() => normalizeClientCertificates([{ origin, pfxFile: path }]), { code: 'CLIENT_CERTIFICATE_CONFIG' });
});

test('a disabled profile or different scheme, host or port never loads its certificate', async () => {
  const profile = { origin, pfxFile: join(directory, 'missing-file.pfx'), enabled: true };
  assert.equal(await loadClientCertificate('https://another.example.test', profile, phrase), null);
  assert.equal(await loadClientCertificate(origin + ':8443', profile, phrase), null);
  assert.equal(await loadClientCertificate(origin, { ...profile, enabled: false }, {}), null);
  await assert.rejects(loadClientCertificate('http://client.example.test', profile, phrase), { code: 'CLIENT_CERTIFICATE_ORIGIN' });
});

test('PFX loading returns only client identity options and validates password and contained certificate', async () => {
  const profile = { origin, pfxFile };
  const options = await loadClientCertificate(origin, profile, phrase);
  assert.deepEqual(Object.keys(options), ['pfx', 'passphrase']);
  assert.ok(Buffer.isBuffer(options.pfx));
  assert.deepEqual(options.pfx, await readFile(pfxFile));
  assert.equal(options.passphrase, phrase);
  assert.doesNotThrow(() => tls.createSecureContext(options));
  assert.notEqual((await loadClientCertificate(origin, profile, phrase)).pfx, options.pfx);
  assert.equal((await loadClientCertificate(origin, { origin, pfxFile: emptyPasswordFile })).passphrase, '');
  await assert.rejects(loadClientCertificate(origin, profile, 'incorrect-password'), failure => {
    assert.equal(failure.code, 'CLIENT_CERTIFICATE_INVALID');
    assert.ok(!String(failure.stack).includes(pfxFile));
    assert.ok(!String(failure.stack).includes('incorrect-password'));
    assert.equal(failure.cause, undefined);
    return true;
  });
  await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: certOnlyFile }, phrase), { code: 'CLIENT_CERTIFICATE_INVALID' });
});

test('passphrases reject nonstrings, control characters and excessive lengths before file access', async () => {
  for (const secret of [null, {}, Buffer.from(phrase), 123, phrase + '\n', '\0', '\x7f', 'a'.repeat(4097)]) {
    await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: join(directory, 'missing.pfx') }, secret), { code: 'CLIENT_CERTIFICATE_SECRET' });
  }
});

test('PFX validation rejects expired, not-yet-valid and server-only certificates before connecting', async () => {
  for (const file of [expiredFile, futureFile]) await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: file }, phrase), { code: 'CLIENT_CERTIFICATE_VALIDITY' });
  await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: serverOnlyFile }, phrase), { code: 'CLIENT_CERTIFICATE_PURPOSE' });
});

test('PFX file reads reject missing, empty, oversized, directory and symbolic link sources with redacted errors', async t => {
  const empty = join(directory, 'empty.pfx'), oversized = join(directory, 'oversized.pfx'), corrupt = join(directory, 'corrupt.pfx');
  await Promise.all([writeFile(empty, ''), writeFile(oversized, Buffer.alloc(MAX_CLIENT_CERTIFICATE_BYTES + 1)), writeFile(corrupt, 'not a PKCS12 container')]);
  for (const file of [join(directory, 'private-filename-missing.pfx'), directory, empty, oversized]) {
    await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: file }, phrase), failure => {
      assert.equal(failure.code, 'CLIENT_CERTIFICATE_FILE');
      assert.ok(!String(failure.stack).includes(file));
      assert.ok(!String(failure.stack).includes(phrase));
      return true;
    });
  }
  await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: corrupt }, phrase), { code: 'CLIENT_CERTIFICATE_INVALID' });
  const link = join(directory, 'linked.pfx');
  try { await symlink(pfxFile, link, 'file'); }
  catch (failure) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(failure.code)) throw failure; t.diagnostic('File symlinks require a Windows permission unavailable to this test; regular-file, directory and size guards remain tested.'); return; }
  await access(link);
  await assert.rejects(loadClientCertificate(origin, { origin, pfxFile: link }, phrase), { code: 'CLIENT_CERTIFICATE_FILE' });
});

async function mutualTlsServer(t) {
  const peers = [], failures = [], sockets = new Set();
  const server = https.createServer({ key: serverKey, cert: serverCertificate, ca: clientCertificate, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    peers.push({ authorized: request.socket.authorized, commonName: request.socket.getPeerCertificate().subject.CN, protocol: request.socket.getProtocol(), alpn: request.socket.alpnProtocol, servername: request.socket.servername });
    response.end('SAHM mutual TLS download bytes');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', failure => failures.push(failure.code));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `https://127.0.0.1:${server.address().port}`, peers, failures };
}

async function request(address, options) {
  const { pfx, passphrase, ...transport } = options;
  const identity = pfx ? await clientIdentityTlsOptions({ pfx, passphrase }) : {};
  return new Promise((resolve, reject) => {
    const outgoing = https.get(address + '/download', { ...transport, ...identity, agent: false, timeout: 5000 }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    outgoing.on('error', reject);
    outgoing.on('timeout', () => outgoing.destroy(new Error('Local mTLS test timed out.')));
  });
}

test('real HTTPS mutual TLS rejects anonymous access then downloads bytes using the selected PFX identity', async t => {
  const server = await mutualTlsServer(t);
  await assert.rejects(request(server.origin, { ca: serverCertificate }));
  assert.deepEqual(server.peers, []);
  const options = await loadClientCertificate(server.origin, { origin: server.origin, pfxFile }, phrase);
  assert.equal(await request(server.origin, { ...options, ca: serverCertificate }), 'SAHM mutual TLS download bytes');
  assert.deepEqual(server.peers.map(({ authorized, commonName }) => ({ authorized, commonName })), [{ authorized: true, commonName: 'SAHM Local Client' }]);
  assert.ok(server.failures.length >= 1);
});

test('client identity never disables server certificate verification or bypasses the server client-CA policy', async t => {
  const server = await mutualTlsServer(t);
  const options = await loadClientCertificate(server.origin, { origin: server.origin, pfxFile }, phrase);
  await assert.rejects(request(server.origin, { ...options, ca: [] }));
  const untrusted = await loadClientCertificate(server.origin, { origin: server.origin, pfxFile: wrongClientFile }, phrase);
  await assert.rejects(request(server.origin, { ...untrusted, ca: serverCertificate }));
  assert.deepEqual(server.peers, []);
});

test('a CA carried inside the client PFX must not become a server trust anchor', async t => {
  const server = await mutualTlsServer(t);
  const options = await loadClientCertificate(server.origin, { origin: server.origin, pfxFile: serverTrustBundleFile }, phrase);
  const identity = await clientIdentityTlsOptions(options);
  assert.deepEqual(Object.keys(identity), ['cert', 'key']);
  await assert.rejects(request(server.origin, { ...options, ca: [] }), failure => {
    assert.ok(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(failure.code));
    return true;
  });
  assert.deepEqual(server.peers, []);
});

test('separated client identity preserves TLS 1.2 and 1.3, ALPN and SNI while keeping server trust strict', async t => {
  const server = await mutualTlsServer(t);
  const identity = await loadClientCertificate(server.origin, { origin: server.origin, pfxFile: serverTrustBundleFile }, phrase);
  for (const version of ['TLSv1.2', 'TLSv1.3']) {
    const transport = { minVersion: version, maxVersion: version, ALPNProtocols: ['http/1.1'], servername: 'localhost' };
    await assert.rejects(request(server.origin, { ...identity, ...transport, ca: [] }));
    assert.equal(await request(server.origin, { ...identity, ...transport, ca: serverCertificate }), 'SAHM mutual TLS download bytes');
    assert.equal(server.peers.at(-1).protocol, version); assert.equal(server.peers.at(-1).alpn, 'http/1.1'); assert.equal(server.peers.at(-1).servername, 'localhost');
  }
  assert.equal(server.peers.length, 2); assert.ok(server.peers.every(peer => peer.authorized));
});

test('client identity extraction refuses malformed options without an unsafe PFX fallback', async () => {
  for (const identity of [{}, { pfx: 'bad', passphrase: '' }, { pfx: Buffer.from('bad'), passphrase: '', ca: serverCertificate }, { pfx: Buffer.from('bad'), passphrase: null }]) {
    await assert.rejects(clientIdentityTlsOptions(identity), { code: 'CLIENT_CERTIFICATE_EXTRACT' });
  }
});

test('RSA and ECC identities export matching memory-only PKCS8 keys, including Unicode passphrases', async () => {
  for (const [file, password, type] of [[wrongClientFile, phrase, 'rsa'], [pfxFile, phrase, 'ec'], [unicodePasswordFile, unicodePhrase, 'ec'], [emptyPasswordFile, '', 'ec']]) {
    const options = await loadClientCertificate(origin, { origin, pfxFile: file }, password);
    const identity = await clientIdentityTlsOptions(options);
    assert.deepEqual(Object.keys(identity), ['cert', 'key']);
    assert.ok(Buffer.isBuffer(identity.key));
    const key = createPrivateKey(identity.key), certificate = new X509Certificate(identity.cert);
    assert.equal(key.asymmetricKeyType, type); assert.equal(certificate.checkPrivateKey(key), true);
  }
});

test('concurrent certificate segments share extraction while an individual abort does not cancel other consumers', async () => {
  clearClientIdentityCache();
  const options = await loadClientCertificate(origin, { origin, pfxFile }, phrase);
  const controller = new AbortController();
  const cancelled = clientIdentityTlsOptions(options, { signal: controller.signal });
  const segments = Array.from({ length: 16 }, () => clientIdentityTlsOptions(options));
  assert.ok(segments.every(promise => promise === segments[0]));
  controller.abort('reason must not be copied into an error');
  await assert.rejects(cancelled, failure => { assert.equal(failure.name, 'AbortError'); assert.equal(failure.code, 'ABORT_ERR'); assert.ok(!failure.message.includes('reason')); return true; });
  const identities = await Promise.all(segments);
  assert.ok(identities.every(value => value === identities[0]));
  await assert.rejects(clientIdentityTlsOptions(options, { signal: controller.signal }), { code: 'ABORT_ERR' });
  clearClientIdentityCache();
  const renewed = clientIdentityTlsOptions(options);
  assert.notEqual(renewed, segments[0]);
  assert.equal(new X509Certificate((await renewed).cert).checkPrivateKey(createPrivateKey((await renewed).key)), true);
});

test('clearing extraction rejects queued and active work without keeping failed secrets in cache', async () => {
  clearClientIdentityCache();
  const bytes = await readFile(pfxFile);
  const pending = Array.from({ length: 8 }, (_, index) => clientIdentityTlsOptions({ pfx: bytes, passphrase: `invalid-fixture-${index}` }));
  const settled = Promise.allSettled(pending);
  clearClientIdentityCache();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'CLIENT_CERTIFICATE_EXTRACT'));
  const options = await loadClientCertificate(origin, { origin, pfxFile }, phrase);
  assert.ok((await clientIdentityTlsOptions(options)).key.length > 0);
});
