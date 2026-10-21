import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { WindowsAuthService, authorizeWindowsIdentity } from '../src/windows-auth.mjs';
import { loopbackWindowsIdentity, windowsAuthServerService } from './helpers/windows-auth-fixture.mjs';

function nativeFixture({ onRequest, ready = true } = {}) {
  const invocations = [], messages = [];
  let child;
  const spawnImpl = (file, args, options) => {
    invocations.push({ file, args, options });
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    const respond = reply => queueMicrotask(() => { if (!child.killed) child.stdout.write(JSON.stringify(reply) + '\n'); });
    let buffer = '';
    child.stdin = new Writable({ write(chunk, encoding, done) {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(request);
        if (request.source) { if (ready !== null) respond({ ready }); }
        else if (onRequest) onRequest(request, respond, child);
        else respond(request.op === 'step' ? { id: request.id, ok: true, token: Buffer.from('opaque-token').toString('base64'), complete: true, package: 'NTLM' } : { id: request.id, ok: true });
      }
      done();
    } });
    child.stdin.on('finish', () => queueMicrotask(() => { if (!child.killed) { child.killed = true; child.emit('exit', 0); } }));
    child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); } return true; };
    return child;
  };
  const service = new WindowsAuthService({ spawnImpl, platform: 'win32', systemRoot: 'C:\\Windows', bootTimeoutMs: 1000, requestTimeoutMs: 1000 });
  return { service, invocations, messages, child: () => child };
}

const current = { scheme: 'ntlm', host: 'proxy.corp.example', currentAccount: true, allowedHosts: ['proxy.corp.example'] };

test('current-account authentication requires an exact allowlist and explicit opt-in', () => {
  assert.throws(() => authorizeWindowsIdentity({ host: 'proxy.corp.example', currentAccount: true }), { code: 'WINDOWS_AUTH_NOT_ALLOWED' });
  assert.throws(() => authorizeWindowsIdentity({ host: 'proxy.corp.example', currentAccount: true, allowedHosts: ['*.corp.example'] }), { code: 'WINDOWS_AUTH_HOST' });
  assert.throws(() => authorizeWindowsIdentity({ host: 'proxy.corp.example', allowedHosts: ['proxy.corp.example'] }), { code: 'WINDOWS_AUTH_CREDENTIALS' });
  assert.deepEqual(authorizeWindowsIdentity({ host: 'PROXY.CORP.EXAMPLE.', currentAccount: true, allowedHosts: ['proxy.corp.example'] }), { host: 'proxy.corp.example', currentAccount: true, credentials: null });
});

test('host matching rejects suffix, port, URL, control and wildcard confusion', () => {
  assert.throws(() => authorizeWindowsIdentity({ host: 'proxy.corp.example.attacker.test', currentAccount: true, allowedHosts: ['proxy.corp.example'] }), { code: 'WINDOWS_AUTH_NOT_ALLOWED' });
  for (const host of ['https://proxy.corp.example', 'proxy.corp.example:8080', 'proxy.corp.example\r\n', '*.corp.example', 'user@proxy.corp.example']) assert.throws(() => authorizeWindowsIdentity({ host, currentAccount: true, allowedHosts: ['proxy.corp.example'] }), { code: 'WINDOWS_AUTH_HOST' });
  assert.equal(authorizeWindowsIdentity({ host: '[::1]', currentAccount: true, allowedHosts: ['::1'] }).host, '::1');
});

test('explicit accounts normalize DOMAIN\\user and preserve UPN without using current credentials', () => {
  assert.deepEqual(authorizeWindowsIdentity({ host: 'proxy.example', credentials: { username: 'CORP\\alice', password: 'fixture-password' } }).credentials, { username: 'alice', domain: 'CORP', password: 'fixture-password' });
  assert.equal(authorizeWindowsIdentity({ host: 'proxy.example', credentials: { username: 'alice@example.test', password: '' } }).credentials.username, 'alice@example.test');
  assert.throws(() => authorizeWindowsIdentity({ host: 'proxy.example', credentials: { username: 'CORP\\alice', domain: 'OTHER', password: 'fixture' } }), { code: 'WINDOWS_AUTH_CREDENTIALS' });
  assert.throws(() => authorizeWindowsIdentity({ ...current, credentials: { username: 'alice', password: 'fixture' } }), { code: 'WINDOWS_AUTH_POLICY' });
});

test('an untrusted host is rejected before starting a native helper', async () => {
  const { service, invocations } = nativeFixture();
  await assert.rejects(service.createContext({ ...current, allowedHosts: [] }), { code: 'WINDOWS_AUTH_NOT_ALLOWED' });
  assert.equal(invocations.length, 0); await service.close();
});

test('secrets travel only over stdin and a single helper serves separate contexts', async () => {
  const { service, invocations, messages } = nativeFixture();
  try {
    const first = await service.createContext({ scheme: 'ntlm', host: 'proxy.example', credentials: { username: 'CORP\\fixture-user', password: 'not-on-the-command-line' } });
    const second = await service.createContext(current);
    assert.equal(invocations.length, 1); assert.equal(invocations[0].file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(invocations[0].options.shell, false); assert.equal(invocations[0].options.windowsHide, true);
    assert.ok(!JSON.stringify(invocations).includes('not-on-the-command-line')); assert.ok(!JSON.stringify(invocations).includes('fixture-user'));
    assert.ok(!invocations[0].args.some(value => /ExecutionPolicy|Bypass/i.test(value)));
    const requests = messages.filter(message => message.op === 'create');
    assert.equal(requests[0].password, 'not-on-the-command-line'); assert.equal(requests[0].domain, 'CORP'); assert.equal(requests[1].currentAccount, true); assert.notEqual(requests[0].context, requests[1].context);
    assert.deepEqual(await first.step(null), { token: Buffer.from('opaque-token').toString('base64'), complete: true, package: 'NTLM' });
    await first.close(); await first.close(); await second.close();
    assert.equal(messages.filter(message => message.op === 'close').length, 2);
  } finally { await service.close(); }
});

test('channel-binding application data is supplied only as a bounded binary value', async () => {
  const { service, messages } = nativeFixture();
  try {
    for (const channelBinding of ['', Buffer.alloc(0), Buffer.alloc(16385)]) await assert.rejects(service.createContext({ ...current, channelBinding }), { code: 'WINDOWS_AUTH_BINDING' });
    const bytes = Buffer.concat([Buffer.from('tls-server-end-point:'), Buffer.alloc(32, 83)]), context = await service.createContext({ ...current, channelBinding: bytes });
    assert.equal(messages.find(message => message.op === 'create').channelBinding, bytes.toString('base64')); await context.close();
  } finally { await service.close(); }
});

test('malformed and oversized challenge tokens never reach SSPI', async () => {
  const { service, messages } = nativeFixture();
  try {
    const context = await service.createContext(current);
    for (const token of ['not base64', 'abcd\n', 'YQ=', Buffer.alloc(131073).toString('base64')]) await assert.rejects(context.step(token), { code: 'WINDOWS_AUTH_TOKEN' });
    assert.equal(messages.filter(message => message.op === 'step').length, 0); await context.close();
  } finally { await service.close(); }
});

test('one context cannot run simultaneous SSPI calls and is capped at four steps', async () => {
  let release;
  const { service, messages } = nativeFixture({ onRequest(request, respond) {
    if (request.op !== 'step') { respond({ id: request.id, ok: true }); return; }
    release = () => respond({ id: request.id, ok: true, token: '', complete: false, package: null });
  } });
  try {
    const context = await service.createContext(current), pending = context.step(null);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(context.step(null), { code: 'WINDOWS_AUTH_BUSY' }); release(); await pending;
    for (let index = 0; index < 3; index++) { const next = context.step(null); await new Promise(resolve => setImmediate(resolve)); release(); await next; }
    await assert.rejects(context.step(null), { code: 'WINDOWS_AUTH_ROUNDS' });
    assert.equal(messages.filter(message => message.op === 'step').length, 4);
    assert.equal(messages.filter(message => message.op === 'close').length, 1);
  } finally { await service.close(); }
});

test('native errors keep the numeric status without retaining diagnostic output', async () => {
  const { service } = nativeFixture({ onRequest(request, respond, child) {
    child.stderr.write('private Windows identity and path must not be surfaced');
    respond(request.op === 'step' ? { id: request.id, ok: false, status: '8009030c', message: 'private password must be ignored' } : { id: request.id, ok: true });
  } });
  try {
    const context = await service.createContext(current);
    await assert.rejects(context.step(null), error => error.code === 'WINDOWS_AUTH_FAILED' && error.sspiStatus === '8009030c' && !error.message.includes('private'));
  } finally { await service.close(); }
});

test('strict Kerberos requests retain their package without implicit NTLM selection', async () => {
  const { service, messages } = nativeFixture();
  try {
    const context = await service.createContext({ ...current, scheme: 'kerberos' });
    assert.equal(messages.find(message => message.op === 'create').scheme, 'kerberos');
    await assert.rejects(context.step(null), { code: 'WINDOWS_AUTH_PACKAGE' }); await context.close();
    await assert.rejects(service.createContext({ ...current, scheme: 'automatic' }), { code: 'WINDOWS_AUTH_SCHEME' });
  } finally { await service.close(); }
});

test('unsupported platforms cannot start a helper', async () => {
  const service = new WindowsAuthService({ platform: 'linux', spawnImpl: () => { throw new Error('Must not spawn'); } });
  await assert.rejects(service.createContext(current), { code: 'WINDOWS_AUTH_UNAVAILABLE' }); await service.close();
});

test('cancelling one handshake closes its context while other handshakes retain the shared helper', async () => {
  const abort = new AbortController();
  let delayed, cancelledContext;
  const { service, child } = nativeFixture({ onRequest(request, respond) {
    if (request.op === 'create' && !cancelledContext) cancelledContext = request.context;
    if (request.op === 'step' && request.context === cancelledContext) { delayed = () => respond({ id: request.id, ok: true, token: 'AA==', complete: true, package: 'NTLM' }); return; }
    respond(request.op === 'step' ? { id: request.id, ok: true, token: 'AA==', complete: true, package: 'NTLM' } : { id: request.id, ok: true });
  } });
  try {
    const context = await service.createContext({ ...current, signal: abort.signal });
    const other = await service.createContext(current);
    const pending = context.step(null), rejected = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve)); abort.abort(); await rejected;
    assert.equal(child().killed, false); delayed();
    await assert.rejects(context.step(null), { code: 'WINDOWS_AUTH_CLOSED' });
    assert.deepEqual(await other.step(null), { token: 'AA==', complete: true, package: 'NTLM' });
    await other.close();
  } finally { await service.close(); }
});

test('preparing a shared helper sends no identity and cancelling one startup waiter leaves others ready', async () => {
  const { service, messages, child, invocations } = nativeFixture({ ready: null });
  const abort = new AbortController();
  try {
    const cancelled = service.prepare(abort.signal), waiting = service.prepare();
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    for (let count = 0; !child() && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 10));
    abort.abort(); await rejected;
    assert.ok(child()); assert.equal(child().killed, false); assert.equal(invocations.length, 1);
    assert.equal(messages.length, 1); assert.ok(messages[0].source);
    child().stdout.write(JSON.stringify({ ready: true }) + '\n'); await waiting;
    assert.equal(messages.length, 1);
    const context = await service.createContext(current); await context.close();
  } finally { await service.close(); }
});

test('helper startup, request timeouts and malformed replies fail closed', async () => {
  const compile = nativeFixture({ ready: false });
  await assert.rejects(compile.service.createContext(current), { code: 'WINDOWS_AUTH_HELPER' }); await compile.service.close();
  const timeout = nativeFixture({ onRequest() {} });
  await assert.rejects(timeout.service.createContext(current), { code: 'WINDOWS_AUTH_TIMEOUT' }); assert.equal(timeout.child().killed, true); await timeout.service.close();
  const malformed = nativeFixture({ onRequest(request, respond, child) { child.stdout.write('Not JSON\n'); } });
  await assert.rejects(malformed.service.createContext(current), { code: 'WINDOWS_AUTH_PROTOCOL' }); await malformed.service.close();
});

test('closing the service releases contexts and rejects further operations', async () => {
  const { service, child } = nativeFixture();
  const context = await service.createContext(current); await service.close(); await service.close();
  assert.equal(child().killed, true); await assert.rejects(context.step(null), { code: 'WINDOWS_AUTH_CLOSED' });
  await assert.rejects(service.createContext(current), { code: 'WINDOWS_AUTH_CLOSED' });
});

test('closing a service rejects an in-flight native step before allowing any late token', async () => {
  const { service } = nativeFixture({ onRequest(request, respond) { if (request.op !== 'step') respond({ id: request.id, ok: true }); } });
  const context = await service.createContext(current), pending = context.step(null);
  const rejected = assert.rejects(pending, { code: 'WINDOWS_AUTH_CLOSED' });
  await new Promise(resolve => setImmediate(resolve)); await service.close(); await rejected;
});

test('a pre-aborted request never starts PowerShell', async () => {
  const { service, invocations } = nativeFixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(service.createContext({ ...current, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(invocations.length, 0); await service.close();
});

test('the helper enforces a bounded number of live security contexts', async () => {
  const { service } = nativeFixture();
  try {
    const contexts = await Promise.all(Array.from({ length: 32 }, () => service.createContext(current)));
    await assert.rejects(service.createContext(current), { code: 'WINDOWS_AUTH_BUSY' });
    await contexts[0].close(); const replacement = await service.createContext(current); await replacement.close();
    await Promise.all(contexts.map(context => context.close()));
  } finally { await service.close(); }
});

test('actual Windows SSPI performs an NTLM client/server exchange without a domain or settings changes', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const client = new WindowsAuthService(), server = await windowsAuthServerService();
  const options = loopbackWindowsIdentity;
  try {
    const [outbound, inbound] = await Promise.all([client.createContext(options), server.createContext(options)]);
    const negotiate = await outbound.step(null); assert.equal(negotiate.complete, false);
    assert.equal(Buffer.from(negotiate.token, 'base64').subarray(0, 8).toString('ascii'), 'NTLMSSP\0');
    const challenge = await inbound.step(negotiate.token); assert.equal(challenge.complete, false);
    const authenticate = await outbound.step(challenge.token); assert.equal(authenticate.complete, true); assert.equal(authenticate.package, 'NTLM');
    const accepted = await inbound.step(authenticate.token); assert.equal(accepted.complete, true);
    await outbound.close(); await inbound.close();
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL('../artifacts/windows-auth-sspi-0.9.json', import.meta.url), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), package: 'NTLM', clientSteps: 2, serverSteps: 2, nativeSspiExecuted: true, kerberosKdcTested: false, operatingSystemSettingsChanged: false, credentialsOrTokensLogged: false }, null, 2));
  } finally { await Promise.all([client.close(), server.close()]); }
});

test('actual Negotiate completes its native exchange and reports the selected package', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const client = new WindowsAuthService(), server = await windowsAuthServerService();
  const options = { ...loopbackWindowsIdentity, scheme: 'negotiate' }, transitions = [];
  try {
    const [outbound, inbound] = await Promise.all([client.createContext(options), server.createContext(options)]);
    let response = await outbound.step(null), accepted;
    for (let round = 0; round < 4; round++) {
      transitions.push({ side: 'client', complete: response.complete, package: response.package });
      assert.ok(response.token, 'An unfinished native exchange must carry a token');
      accepted = await inbound.step(response.token);
      transitions.push({ side: 'server', complete: accepted.complete });
      if (accepted.complete && response.complete) break;
      assert.ok(accepted.token, 'An unfinished exchange must return a challenge or final server proof');
      response = await outbound.step(accepted.token);
      if (accepted.complete && response.complete) { transitions.push({ side: 'client', complete: response.complete, package: response.package }); break; }
    }
    assert.equal(accepted.complete, true); assert.equal(response.complete, true); assert.ok(['NTLM', 'Kerberos'].includes(response.package));
    await outbound.close(); await inbound.close();
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL('../artifacts/windows-auth-negotiate-0.9.json', import.meta.url), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), selectedPackage: response.package, transitions, nativeSspiExecuted: true, dedicatedKerberosKdcTested: false, operatingSystemSettingsChanged: false, credentialsOrTokensLogged: false }, null, 2));
  } finally { await Promise.all([client.close(), server.close()]); }
});

test('actual NTLM marshals an explicit ephemeral account without attempting a server logon', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const service = new WindowsAuthService();
  try {
    const context = await service.createContext({ scheme: 'ntlm', host: 'localhost', credentials: { username: 'SAHMTEST\\fixture-user', password: 'ephemeral-fixture-password-not-a-real-account' } });
    const result = await context.step(null), token = Buffer.from(result.token, 'base64');
    assert.equal(token.subarray(0, 8).toString('ascii'), 'NTLMSSP\0'); assert.equal(token.readUInt32LE(8), 1); assert.equal(result.complete, false);
    // Type 1 negotiates capabilities only. No Type 2 challenge is accepted and
    // no password response is generated or submitted for this synthetic account.
    await context.close();
  } finally { await service.close(); }
});

test('actual strict Kerberos never substitutes an NTLM token when a KDC is unavailable', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const service = new WindowsAuthService();
  try {
    try {
      const context = await service.createContext({ ...loopbackWindowsIdentity, scheme: 'kerberos' });
      const result = await context.step(null);
      assert.notEqual(Buffer.from(result.token, 'base64').subarray(0, 8).toString('ascii'), 'NTLMSSP\0');
      assert.notEqual(result.package, 'NTLM'); await context.close();
    } catch (error) {
      assert.equal(error.code, 'WINDOWS_AUTH_FAILED'); assert.match(error.sspiStatus, /^[a-f0-9]{8}$/);
    }
  } finally { await service.close(); }
});
