import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { authenticateProxyTunnel, tlsChannelBinding } from '../src/proxy-auth.mjs';
import { WindowsAuthService } from '../src/windows-auth.mjs';
import { windowsAuthServerService } from './helpers/windows-auth-fixture.mjs';

async function authenticatedFixture(t, { scheme = 'ntlm', chunked = false, secure = false, mismatchedBinding = false, omitFinalProof = false } = {}) {
  const nativeServer = await windowsAuthServerService(), nativeClient = new WindowsAuthService();
  const sockets = new Set(), requests = [], serverFailures = [], clientSteps = [];
  let connectionCount = 0, completed = 0, finalProofs = 0, fixtureBinding;
  const serverOptions = secure ? { key: await readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url)), cert: await readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)) } : null;
  if (secure) {
    const raw = new X509Certificate(serverOptions.cert).raw;
    fixtureBinding = Buffer.concat([Buffer.from('tls-server-end-point:'), createHash('sha256').update(raw).digest()]);
    if (mismatchedBinding) fixtureBinding[fixtureBinding.length - 1] ^= 1;
  }
  const handle = socket => {
    connectionCount++; sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0), tunnel = false, context, running = Promise.resolve();
    socket.on('data', chunk => {
      if (tunnel) { socket.write('echo:' + chunk.toString('utf8')); return; }
      buffered = Buffer.concat([buffered, chunk]);
      let end;
      while ((end = buffered.indexOf('\r\n\r\n')) !== -1) {
        const header = buffered.subarray(0, end + 4).toString('latin1'); buffered = buffered.subarray(end + 4);
        running = running.then(async () => {
          const first = /^CONNECT ([^\r\n]+) HTTP\/1\.1/.exec(header), auth = /\r\nProxy-Authorization:\s*(NTLM|Negotiate)\s+([a-z0-9+/=]+)\r\n/i.exec(header);
          assert.ok(first && auth); requests.push({ authority: first[1], scheme: auth[1] });
          context ||= await nativeServer.createContext({ scheme, host: 'localhost', currentAccount: true, allowedHosts: ['localhost'], channelBinding: fixtureBinding });
          const result = await context.step(auth[2]);
          const wireScheme = scheme === 'ntlm' ? 'NTLM' : 'Negotiate';
          if (result.complete) {
            completed++; tunnel = true;
            const proof = result.token && !omitFinalProof ? `Proxy-Authenticate: ${wireScheme} ${result.token}\r\n` : '';
            if (proof) finalProofs++;
            socket.write('HTTP/1.1 200 Connection Established\r\n' + proof + '\r\nready');
            await context.close(); return;
          }
          if (chunked) socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${wireScheme} ${result.token}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n4;fixture=yes\r\nbody\r\n0\r\nX-Fixture: trailer\r\n\r\n`);
          else socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${wireScheme} ${result.token}\r\nContent-Length: 13\r\nConnection: keep-alive\r\n\r\nfixture body!`);
        }).catch(error => { serverFailures.push({ code: error.code, status: error.sspiStatus }); socket.destroy(); });
      }
    });
    socket.once('close', () => { context?.close().catch(() => {}); });
  };
  const server = secure ? tls.createServer(serverOptions, handle) : net.createServer(handle);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let socket;
  t.after(async () => {
    socket?.destroy(); for (const item of sockets) item.destroy();
    await Promise.all([nativeServer.close(), nativeClient.close()]);
    await new Promise(resolve => server.close(resolve));
  });
  // Keep cold PowerShell startup and C# compilation outside the wire-level
  // handshake deadline. Cold helper deadlines have dedicated service tests.
  for (const native of [nativeClient, nativeServer]) {
    const warm = await native.createContext({ scheme, host: 'localhost', currentAccount: true, allowedHosts: ['localhost'], channelBinding: fixtureBinding });
    await warm.close();
  }
  socket = secure ? tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: serverOptions.cert }) : net.connect({ host: '127.0.0.1', port: server.address().port });
  await once(socket, secure ? 'secureConnect' : 'connect');
  const service = { createContext: async options => {
    const context = await nativeClient.createContext(options);
    return { close: () => context.close(), step: async token => { const result = await context.step(token); clientSteps.push({ complete: result.complete, package: result.package }); return result; } };
  } };
  return { socket, service, requests, serverFailures, clientSteps, stats: () => ({ connectionCount, completed, finalProofs }), options: { authority: 'target.example:443', route: { type: secure ? 'https' : 'http', host: 'localhost', port: server.address().port }, policy: { scheme, currentAccount: true, allowedHosts: ['localhost'] }, service, signal: AbortSignal.timeout(15000) } };
}

async function readBytes(socket, length) {
  const chunks = []; let size = 0;
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); socket.pause(); socket.off('data', receive); socket.off('error', failed); socket.off('end', failed);
      if (error) { reject(error); return; }
      const bytes = Buffer.concat(chunks); if (bytes.length > length) socket.unshift(bytes.subarray(length)); resolve(bytes.subarray(0, length));
    };
    const receive = chunk => { chunks.push(chunk); size += chunk.length; if (size >= length) finish(); };
    const failed = () => finish(new Error('Fixture tunnel ended early'));
    const timer = setTimeout(failed, 3000);
    socket.on('data', receive); socket.once('error', failed); socket.once('end', failed); socket.resume();
  });
}

for (const [name, options] of [
  ['NTLM over a single TCP connection drains a framed 407 body and preserves tunneled bytes', { scheme: 'ntlm' }],
  ['Negotiate handles chunked 407 bodies and validates the final 200 server proof', { scheme: 'negotiate', chunked: true }],
  ['HTTPS proxy NTLM uses the trusted TLS certificate as a native SSPI channel binding', { scheme: 'ntlm', secure: true }]
]) test(name, { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const fixture = await authenticatedFixture(t, options);
  await authenticateProxyTunnel(fixture.socket, fixture.options);
  assert.equal((await readBytes(fixture.socket, 5)).toString(), 'ready');
  fixture.socket.write('ping'); assert.equal((await readBytes(fixture.socket, 9)).toString(), 'echo:ping');
  assert.equal(fixture.stats().connectionCount, 1); assert.equal(fixture.stats().completed, 1); assert.equal(fixture.requests.length, 2); assert.deepEqual(fixture.serverFailures, []);
  assert.ok(fixture.requests.every(request => request.authority === 'target.example:443'));
  assert.equal(fixture.clientSteps.at(-1).complete, true);
  if (options.scheme === 'negotiate') { assert.ok(fixture.stats().finalProofs > 0); assert.equal(fixture.clientSteps.length, 3); }
  if (options.secure) assert.equal(fixture.socket.authorized, true);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/proxy-enterprise-${options.secure ? 'https-ntlm' : options.scheme}-0.9.json`, import.meta.url), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), scheme: options.scheme, secure: !!options.secure, chunked: !!options.chunked, ...fixture.stats(), clientSteps: fixture.clientSteps, nativeSspiExecuted: true, dedicatedKerberosKdcTested: false, operatingSystemSettingsChanged: false, credentialsOrTokensLogged: false }, null, 2));
});

test('TLS channel binding includes the SHA256 fixture certificate digest and rejects a missing certificate', async () => {
  const pem = await readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), raw = new X509Certificate(pem).raw;
  assert.equal(tlsChannelBinding({ encrypted: false }), undefined);
  assert.deepEqual(tlsChannelBinding({ encrypted: true, getPeerCertificate: () => ({ raw }) }), Buffer.concat([Buffer.from('tls-server-end-point:'), createHash('sha256').update(raw).digest()]));
  assert.throws(() => tlsChannelBinding({ encrypted: true, getPeerCertificate: () => ({}) }), { code: 'windows-proxy-auth-failed' });
});

test('a Negotiate tunnel cannot succeed when a required final server proof is omitted', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const fixture = await authenticatedFixture(t, { scheme: 'negotiate', omitFinalProof: true });
  await assert.rejects(authenticateProxyTunnel(fixture.socket, fixture.options), { code: 'windows-proxy-auth-failed' });
  assert.equal(fixture.stats().completed, 1); assert.equal(fixture.clientSteps.at(-1).complete, false);
});

test('native SSPI rejects a mismatched HTTPS proxy channel binding', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const fixture = await authenticatedFixture(t, { scheme: 'ntlm', secure: true, mismatchedBinding: true });
  await assert.rejects(authenticateProxyTunnel(fixture.socket, fixture.options));
  assert.equal(fixture.stats().completed, 0);
  assert.ok(fixture.serverFailures.some(failure => failure.status === '80090346'), 'The native server must report SEC_E_BAD_BINDINGS');
});

test('proxy authentication rejects CRLF targets and current-identity hosts outside the allowlist before sending tokens', async () => {
  const service = new WindowsAuthService({ spawnImpl: () => { throw new Error('Native helper must not start'); } });
  const socket = { encrypted: false, write: () => { throw new Error('No authentication token may be sent'); } };
  try {
    await assert.rejects(authenticateProxyTunnel(socket, { authority: 'target.example:443\r\nInjected: header', route: { host: 'proxy.example' }, policy: { scheme: 'ntlm', currentAccount: true, allowedHosts: [] }, service, signal: AbortSignal.timeout(1000) }), { code: 'windows-proxy-auth-failed' });
    await assert.rejects(authenticateProxyTunnel(socket, { authority: 'target.example:443', route: { host: 'proxy.example' }, policy: { scheme: 'ntlm', currentAccount: true, allowedHosts: [] }, service, signal: AbortSignal.timeout(1000) }), { code: 'WINDOWS_AUTH_NOT_ALLOWED' });
  } finally { await service.close(); }
});
