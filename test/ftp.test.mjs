import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { downloadFtp, normalizeFtpUrl, parseFtpInput } from '../src/ftp.mjs';
import { ftpFixture, ftpCaFile } from './helpers/ftp-fixture.mjs';

test('FTP anonymous binary EPSV transfer reproduces all bytes', async t => {
  const f = await ftpFixture(t);
  const result = await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(result.bytes, f.original.length);
  assert.ok(f.requests.some(r => r.command === 'EPSV'));
  assert.equal(f.retrievals, 1);
});

test('FTP authenticated PASV ignores the advertised third-party IP', async t => {
  const f = await ftpFixture(t, { epsv: false, pasvHost: '203,0,113,9', requireLogin: true });
  const credentials = { username: 'test-user', password: 'secret-ftp-password' };
  await downloadFtp(f.url, f.path, { credentials });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok(f.requests.some(r => r.command === 'PASV'));
});

test('FTP pause persists only durable offsets and a fresh invocation uses REST', async t => {
  const f = await ftpFixture(t), controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { signal: controller.signal, checkpointInterval: 50, onProgress(p) { if (p.received >= 32768) controller.abort(new Error('paused')); } }), /paused/);
  const state = JSON.parse(await readFile(f.path + '.ftp-resume.json', 'utf8'));
  assert.ok(state.received >= 32768 && state.received < f.original.length);
  assert.equal((await readFile(f.path + '.part')).length, state.received);
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok(f.requests.some(r => r.command === 'REST' && Number(r.value) === state.received));
});

test('FTP changed SIZE/MDTM preserves old partial and starts a fresh file', async t => {
  const f = await ftpFixture(t), controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { signal: controller.signal, onProgress(p) { if (p.received >= 16384) controller.abort(new Error('paused')); } }), /paused/);
  const changed = Buffer.alloc(f.original.length + 100, 87); f.change(changed);
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), changed);
  assert.ok((await readdir(f.directory)).some(n => n.includes('.part.stale-')));
  assert.equal(f.requests.filter(r => r.command === 'REST' && Number(r.value) > 0).length, 0);
});

test('FTP never overwrites an existing destination', async t => {
  const f = await ftpFixture(t);
  await writeFile(f.path, 'keep my file');
  await assert.rejects(downloadFtp(f.url, f.path), { code: 'EEXIST' });
  assert.equal(await readFile(f.path, 'utf8'), 'keep my file');
});

test('FTP credentials are separate and CRLF, globbing protocol overrides and ASCII suffixes cannot inject commands', () => {
  assert.deepEqual(parseFtpInput('ftp://name:p%22a%5Css@localhost/file.bin'), { url: 'ftp://localhost/file.bin', credentials: { username: 'name', password: 'p"a\\ss' } });
  assert.equal(normalizeFtpUrl('ftps://localhost/file[1].bin'), 'ftps://localhost/file[1].bin');
  for (const url of ['ftp://u:p@localhost/file', 'ftp://localhost/file%0d%0aDELE%20a', 'ftp://localhost/a\nb', 'ftp://localhost/file;type=A', 'http://localhost/file', 'ftp://localhost/', 'ftp://localhost/a?b']) assert.throws(() => normalizeFtpUrl(url));
});

test('FTPS explicit and implicit modes verify TLS and protect the data channel', async t => {
  for (const mode of ['explicit', 'implicit']) {
    await t.test(mode, async sub => {
      const f = await ftpFixture(sub, { mode });
      await downloadFtp(f.url, f.path, { tlsMode: mode, caFile: ftpCaFile });
      assert.deepEqual(await readFile(f.path), f.original);
      assert.ok(f.requests.some(r => r.command === 'PROT' && r.value === 'P'));
      if (mode === 'explicit') assert.ok(f.requests.some(r => r.command === 'AUTH' && ['TLS', 'SSL'].includes(r.value)));
    });
  }
});

test('FTPS rejects untrusted certificates and never downgrades explicit TLS', async t => {
  const f = await ftpFixture(t, { mode: 'explicit' });
  await assert.rejects(downloadFtp(f.url, f.path, { tlsMode: 'explicit' }), /certificate|TLS handshake/);
  assert.equal(f.retrievals, 0);
  const plain = await ftpFixture(t, { mode: 'plain' });
  await assert.rejects(downloadFtp(plain.url, plain.path, { tlsMode: 'explicit' }), /FTP transfer failed/);
  assert.equal(plain.retrievals, 0);
});

test('FTP login errors are fixed messages and checkpoint contains no credentials', async t => {
  const f = await ftpFixture(t, { requireLogin: true });
  const error = await downloadFtp(f.url, f.path, { credentials: { username: 'test-user', password: 'DO-NOT-LEAK-THIS' } }).then(() => null, e => e);
  assert.equal(error.code, 'ftp-auth-required');
  assert.doesNotMatch(error.message, /test-user|DO-NOT-LEAK-THIS/);
  const controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { credentials: { username: 'test-user', password: 'secret-ftp-password' }, signal: controller.signal, onProgress(p) { if (p.received > 0) controller.abort(new Error('paused')); } }), /paused/);
  const checkpoint = await readFile(f.path + '.ftp-resume.json', 'utf8');
  assert.doesNotMatch(checkpoint, /test-user|secret-ftp-password|username|password/);
});

test('FTP speed limit is shared by the stream and can be changed while downloading', async t => {
  const f = await ftpFixture(t), started = Date.now();
  await downloadFtp(f.url, f.path, { maxBytesPerSecond: () => f.original.length });
  assert.ok(Date.now() - started >= 900);
  assert.deepEqual(await readFile(f.path), f.original);
});

test('FTP a crash tail after the durable checkpoint is discarded before REST', async t => {
  const f = await ftpFixture(t), controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { signal: controller.signal, onProgress(p) { if (p.received >= 16384) controller.abort(new Error('paused')); } }), /paused/);
  const state = JSON.parse(await readFile(f.path + '.ftp-resume.json', 'utf8'));
  await appendFile(f.path + '.part', 'uncheckpointed crash tail');
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok(f.requests.some(r => r.command === 'REST' && Number(r.value) === state.received));
});

test('FTP without REST support preserves a paused partial and restarts safely', async t => {
  const f = await ftpFixture(t, { rest: false }), controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { signal: controller.signal, onProgress(p) { if (p.received >= 16384) controller.abort(new Error('paused')); } }), /paused/);
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok((await readdir(f.directory)).some(n => n.includes('.part.stale-')));
  assert.equal(f.requests.filter(r => r.command === 'REST' && Number(r.value) > 0).length, 0);
});

test('FTP without SIZE or MDTM can download but never resumes an unverified partial', async t => {
  const f = await ftpFixture(t, { missingMetadata: true }), controller = new AbortController();
  await assert.rejects(downloadFtp(f.url, f.path, { signal: controller.signal, onProgress(p) { if (p.received >= 16384) controller.abort(new Error('paused')); } }), /paused/);
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok((await readdir(f.directory)).some(n => n.includes('.part.stale-')));
});

test('FTP changing MDTM during the transfer cannot publish a completed file', async t => {
  const f = await ftpFixture(t);
  let changed = false;
  await assert.rejects(downloadFtp(f.url, f.path, { onProgress(p) {
    if (!changed && p.received >= 32768) { changed = true; f.change(Buffer.from(f.original)); }
  } }), /changed during transfer/);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await downloadFtp(f.url, f.path);
  assert.deepEqual(await readFile(f.path), f.original);
});

test('FTP authenticated resume requires the same non-secret credential scope', async t => {
  const f = await ftpFixture(t, { requireLogin: true }), controller = new AbortController();
  const credentials = { username: 'test-user', password: 'secret-ftp-password' };
  await assert.rejects(downloadFtp(f.url, f.path, { credentials, credentialScope: 'account-record-v1', signal: controller.signal, onProgress(p) { if (p.received >= 16384) controller.abort(new Error('paused')); } }), /paused/);
  const state = JSON.parse(await readFile(f.path + '.ftp-resume.json', 'utf8'));
  await downloadFtp(f.url, f.path, { credentials, credentialScope: 'account-record-v1' });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.ok(f.requests.some(r => r.command === 'REST' && Number(r.value) === state.received));
  const second = await ftpFixture(t, { requireLogin: true }), paused = new AbortController();
  await assert.rejects(downloadFtp(second.url, second.path, { credentials, credentialScope: 'account-record-v1', signal: paused.signal, onProgress(p) { if (p.received >= 16384) paused.abort(new Error('paused')); } }), /paused/);
  await downloadFtp(second.url, second.path, { credentials, credentialScope: 'account-record-v2' });
  assert.deepEqual(await readFile(second.path), second.original);
  assert.equal(second.requests.filter(r => r.command === 'REST' && Number(r.value) > 0).length, 0);
  assert.ok((await readdir(second.directory)).some(n => n.includes('.part.stale-')));
});
