import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { downloadFtp } from '../src/ftp.mjs';
import { NetworkService } from '../src/network.mjs';
import { isTransientNetworkError } from '../src/network-retry.mjs';
import { ftpFixture, ftpCaFile } from './helpers/ftp-fixture.mjs';
import { windowsConnectProxy } from './helpers/windows-connect-proxy-fixture.mjs';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

async function connectProxy(t, { authentication, rejectData = false } = {}) {
  const seen = [], server = http.createServer();
  let controlPort;
  server.on('connect', (request, client, head) => {
    const [host, portText] = request.url.split(':'), port = Number(portText);
    controlPort ||= port;
    seen.push({ target: request.url, authenticated: request.headers['proxy-authorization'] === authentication });
    if ((authentication && request.headers['proxy-authorization'] !== authentication) || (rejectData && port !== controlPort)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return;
    }
    const target = net.connect({ host, port });
    target.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    target.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      client.pipe(target); target.pipe(client);
    });
    client.once('close', () => target.destroy());
  });
  return { port: await listen(t, server), seen };
}

async function network(t, route, credentials) {
  const service = new NetworkService();
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: route.port } }, { credentials });
  t.after(() => service.close()); return service;
}

async function socksProxy(t, version) {
  const seen = [], server = net.createServer(socket => {
    let buffered = Buffer.alloc(0), greeted = false;
    socket.on('data', receive);
    function receive(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (version === 4) {
        if (buffered.length < 9) return;
        const userEnd = buffered.indexOf(0, 8), hostEnd = buffered.indexOf(0, userEnd + 1);
        if (userEnd < 0 || hostEnd < 0) return;
        const host = buffered.subarray(userEnd + 1, hostEnd).toString(), port = buffered.readUInt16BE(2);
        seen.push({ host, port, remoteDNS: buffered.subarray(4, 8).equals(Buffer.from([0, 0, 0, 1])) });
        socket.off('data', receive); tunnel(host, port, Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]), buffered.subarray(hostEnd + 1)); return;
      }
      if (!greeted) {
        if (buffered.length < 2 || buffered.length < buffered[1] + 2) return;
        socket.write(Buffer.from([5, 0])); buffered = buffered.subarray(buffered[1] + 2); greeted = true;
      }
      if (buffered.length < 5) return;
      const addressType = buffered[3];
      let host, port, consumed;
      if (addressType === 3) {
        const size = buffered[4]; if (buffered.length < size + 7) return;
        host = buffered.subarray(5, 5 + size).toString(); port = buffered.readUInt16BE(5 + size); consumed = size + 7;
      } else if (addressType === 1) {
        if (buffered.length < 10) return;
        host = [...buffered.subarray(4, 8)].join('.'); port = buffered.readUInt16BE(8); consumed = 10;
      } else { socket.destroy(); return; }
      seen.push({ host, port, remoteDNS: addressType === 3 });
      socket.off('data', receive); tunnel(host, port, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), buffered.subarray(consumed));
    }
    function tunnel(host, port, reply, rest) {
      const target = net.connect({ host: host === 'remote-only.test' ? '127.0.0.1' : host, port });
      target.on('error', () => socket.destroy());
      target.once('connect', () => { socket.write(reply); if (rest.length) target.write(rest); socket.pipe(target); target.pipe(socket); });
      socket.once('close', () => target.destroy());
    }
  });
  return { port: await listen(t, server), seen };
}

test('FTP HTTP CONNECT authentication covers both control and data channels', async t => {
  const f = await ftpFixture(t), credentials = { username: 'proxy-user', password: 'proxy-secret' };
  const proxy = await connectProxy(t, { authentication: `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}` });
  await downloadFtp(f.url, f.path, { network: await network(t, proxy, credentials) });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(proxy.seen.length, 4, 'before/after metadata, transfer control, and transfer data are tunneled');
  assert.ok(proxy.seen.every(record => record.authenticated));
  assert.equal(new Set(proxy.seen.map(record => record.target)).size, 2);
  assert.ok(f.requests.filter(record => record.command === 'USER').every(record => record.value === 'anonymous'));
});

for (const scheme of ['ntlm', 'negotiate']) test(`FTP ${scheme} authenticates every control/data tunnel and counts only file bytes`, { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const f = await ftpFixture(t), proxy = await windowsConnectProxy(t, scheme);
  let usedBytes = 0, routeLookups = 0;
  const quota = { assertAvailable: async () => {}, consume: async size => { usedBytes += size; return size; } };
  const service = new NetworkService({ quota });
  t.after(() => service.close());
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: 'localhost', port: proxy.port }, authentication: { proxy: { scheme, currentAccount: true, allowedHosts: ['localhost'] } } });
  const routesFor = service.routesFor.bind(service);
  service.routesFor = async url => {
    routeLookups++;
    assert.ok(url.startsWith('ftp:'), 'FTP-selected routes must not be re-evaluated as HTTPS CONNECT targets');
    return routesFor(url);
  };
  await downloadFtp(f.url, f.path, { network: service, quota, signal: AbortSignal.timeout(60000) });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(f.retrievals, 1);
  assert.equal(routeLookups, 1);
  assert.equal(usedBytes, f.original.length, 'Local gateway must not account for FTP control or repeat payload quota');
  assert.deepEqual(proxy.failures, []);
  assert.equal(proxy.accepted.length, 4, 'Metadata and transfer control/data each require their own Windows identity exchange');
  assert.equal(new Set(proxy.accepted).size, 2);
  assert.equal(proxy.seen.length, 8);
  assert.ok(proxy.seen.every(record => record.scheme.toLowerCase() === (scheme === 'ntlm' ? 'ntlm' : 'negotiate')), 'Random local Basic credentials never reach the upstream proxy');
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../artifacts/ftp-enterprise-${scheme}-0.9.json`, import.meta.url), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), nativeSspiExecuted: true, scheme, routeLookups, authenticatedTunnels: proxy.accepted.length, distinctControlAndDataTargets: new Set(proxy.accepted).size, bytes: f.original.length, quotaBytes: usedBytes, retrievals: f.retrievals, upstreamBasicCredentials: false, operatingSystemSettingsChanged: false, dedicatedKerberosKdcTested: false }, null, 2));
});

test('FTP Windows current-account policy rejects an untrusted proxy before connection', async t => {
  const f = await ftpFixture(t), proxy = await connectProxy(t), service = new NetworkService();
  t.after(() => service.close());
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port }, authentication: { proxy: { scheme: 'ntlm', currentAccount: true, allowedHosts: ['localhost'] } } });
  await assert.rejects(downloadFtp(f.url, f.path, { network: service }), { code: 'windows-auth-untrusted-host' });
  assert.equal(proxy.seen.length, 0);
  assert.equal(f.requests.length, 0);
});

test('FTP SSPI authentication failure cannot fall back to a PAC DIRECT alternative', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const f = await ftpFixture(t), proxy = await connectProxy(t, { authentication: 'refuse' }), service = new NetworkService();
  t.after(() => service.close());
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: 'localhost', port: proxy.port }, authentication: { proxy: { scheme: 'ntlm', currentAccount: true, allowedHosts: ['localhost'] } } });
  service.routesFor = async () => [{ type: 'http', host: 'localhost', port: proxy.port }, { type: 'direct' }];
  await assert.rejects(downloadFtp(f.url, f.path, { network: service, signal: AbortSignal.timeout(30000) }), error => {
    assert.equal(error.code, 'ftp-transfer-failed');
    assert.equal(isTransientNetworkError(error), false, 'A rejected Windows proxy account must not acquire a reconnect budget');
    return true;
  });
  assert.equal(f.requests.length, 0);
  assert.equal(proxy.seen.length, 1);
});

test('FTPS explicit and implicit TLS remain verified through HTTP CONNECT', async t => {
  for (const mode of ['explicit', 'implicit']) await t.test(mode, async sub => {
    const f = await ftpFixture(sub, { mode }), proxy = await connectProxy(sub);
    await downloadFtp(f.url, f.path, { tlsMode: mode, caFile: ftpCaFile, network: await network(sub, proxy) });
    assert.deepEqual(await readFile(f.path), f.original);
    assert.equal(proxy.seen.length, 4);
    assert.ok(f.requests.some(record => record.command === 'PROT' && record.value === 'P'));
  });
});

test('FTP refused proxy credentials never bypass the proxy to a reachable server', async t => {
  const f = await ftpFixture(t), proxy = await connectProxy(t, { authentication: 'refuse' });
  await assert.rejects(downloadFtp(f.url, f.path, { network: await network(t, proxy) }), error => {
    assert.equal(error.code, 'ftp-transfer-failed');
    assert.equal(error.proxyStatus, 407);
    assert.equal(isTransientNetworkError(error), false);
    return true;
  });
  assert.equal(f.requests.length, 0);
  assert.equal(proxy.seen.length, 1);
});

test('FTP data tunnel refusal fails without direct data access or repeating RETR', async t => {
  const f = await ftpFixture(t), proxy = await connectProxy(t, { rejectData: true });
  await assert.rejects(downloadFtp(f.url, f.path, { network: await network(t, proxy) }), error => {
    assert.equal(error.code, 'ftp-transfer-failed');
    assert.equal(error.proxyStatus, 407);
    assert.equal(isTransientNetworkError(error), false);
    return true;
  });
  assert.equal(f.retrievals, 0);
  assert.ok(proxy.seen.length >= 3, 'data route can retry EPSV as PASV, but must stay behind the proxy');
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('FTP PAC alternatives can change only before RETR and require an explicit DIRECT route', async t => {
  const f = await ftpFixture(t), proxy = await connectProxy(t, { authentication: 'refuse' });
  const choices = [{ type: 'http', host: '127.0.0.1', port: proxy.port }, { type: 'direct' }];
  await downloadFtp(f.url, f.path, { network: { routesFor: async () => choices, credentialsFor: async () => null } });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(proxy.seen.length, 1);
  assert.equal(f.retrievals, 1);
});

for (const version of [4, 5]) test(`FTP SOCKS${version} uses remote DNS for both control and data`, async t => {
  const f = await ftpFixture(t), proxy = await socksProxy(t, version), service = new NetworkService();
  await service.configure({ mode: 'manual', proxy: { type: `socks${version}`, host: '127.0.0.1', port: proxy.port } });
  t.after(() => service.close());
  await downloadFtp(f.url.replace('127.0.0.1', 'remote-only.test'), f.path, { network: service });
  assert.deepEqual(await readFile(f.path), f.original);
  assert.equal(proxy.seen.length, 4);
  assert.ok(proxy.seen.every(record => record.remoteDNS && record.host === 'remote-only.test'));
  assert.equal(new Set(proxy.seen.map(record => record.port)).size, 2);
});
