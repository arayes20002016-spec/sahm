import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NetworkService, normalizeNetworkConfig, parsePacResult, bypassesProxy } from '../src/network.mjs';

async function listening(server, t) {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function network(t, config, options = {}, auth) {
  const service = new NetworkService(options); await service.configure(config, { credentials: auth }); t.after(() => service.close()); return service;
}
async function origin(t, secure = false) {
  const requests = [];
  const handler = (req, res) => { requests.push({ url: req.url, headers: req.headers, method: req.method }); const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => res.end(req.method === 'POST' ? Buffer.concat(chunks) : 'through proxy')); };
  const server = secure ? https.createServer({ key: await readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url)), cert: await readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)) }, handler) : http.createServer(handler);
  const port = await listening(server, t); return { port, url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}/file`, requests };
}
async function connectProxy(t, { authentication, secure = false, rejectConnect = false, rejectConnectStatus } = {}) {
  const seen = [];
  const options = secure ? { key: await readFile(new URL('./fixtures/ftp/server-key.pem', import.meta.url)), cert: await readFile(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)) } : null;
  const server = secure ? https.createServer(options) : http.createServer();
  server.on('request', (request, response) => {
    seen.push({ target: request.url, authorization: request.headers['proxy-authorization'] });
    if (authentication && request.headers['proxy-authorization'] !== authentication) { response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' }); response.end(); return; }
    const address = new URL(request.url);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['proxy-authorization', 'proxy-connection'].includes(name)));
    const upstream = http.request(address, { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  server.on('connect', (request, client, head) => {
    seen.push({ target: request.url, authorization: request.headers['proxy-authorization'] });
    if (rejectConnect) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (rejectConnectStatus) { client.end(`HTTP/1.1 ${rejectConnectStatus} Refused\r\n\r\n`); return; }
    if (authentication && request.headers['proxy-authorization'] !== authentication) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = request.url.split(':'); const target = net.connect({ host: host === 'remote-only.test' ? '127.0.0.1' : host, port: Number(port) });
    target.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    target.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); client.pipe(target); target.pipe(client); });
    client.once('close', () => target.destroy());
  });
  return { port: await listening(server, t), seen };
}
async function socksProxy(t, version, auth = null) {
  const seen = [];
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0), stage = 0;
    socket.on('data', receive);
    function receive(chunk) {
      data = Buffer.concat([data, chunk]);
      if (version === 4) {
        if (data.length < 9) return; const userEnd = data.indexOf(0, 8); if (userEnd < 0) return; const hostEnd = data.indexOf(0, userEnd + 1); if (hostEnd < 0) return;
        const host = data.subarray(userEnd + 1, hostEnd).toString(), port = data.readUInt16BE(2), user = data.subarray(8, userEnd).toString();
        seen.push({ host, port, user, remoteDNS: data.subarray(4, 8).equals(Buffer.from([0, 0, 0, 1])) });
        socket.off('data', receive); tunnel(host, port, Buffer.from([0, 90, 0, 0, 0, 0, 0, 0]), data.subarray(hostEnd + 1)); return;
      }
      if (stage === 0) { if (data.length < 3) return; assert.equal(data[0], 5); socket.write(Buffer.from([5, auth ? 2 : 0])); data = data.subarray(2 + data[1]); stage = auth ? 1 : 2; }
      if (stage === 1) {
        if (data.length < 2) return; const nameLength = data[1]; if (data.length < 3 + nameLength) return; const passwordLength = data[2 + nameLength]; if (data.length < 3 + nameLength + passwordLength) return;
        const username = data.subarray(2, 2 + nameLength).toString(), password = data.subarray(3 + nameLength, 3 + nameLength + passwordLength).toString();
        seen.push({ username, password }); socket.write(Buffer.from([1, username === auth.username && password === auth.password ? 0 : 1])); data = data.subarray(3 + nameLength + passwordLength); stage = 2;
      }
      if (stage === 2) {
        if (data.length < 5) return; assert.equal(data[3], 3); const size = data[4]; if (data.length < size + 7) return;
        const host = data.subarray(5, 5 + size).toString(), port = data.readUInt16BE(5 + size); seen.push({ host, port, remoteDNS: true });
        socket.off('data', receive); tunnel(host, port, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]), data.subarray(7 + size));
      }
    }
    function tunnel(host, port, reply, rest) {
      const target = net.connect({ host: host === 'remote-only.test' ? '127.0.0.1' : host, port }); target.on('error', () => socket.destroy());
      target.once('connect', () => { socket.write(reply); if (rest.length) target.write(rest); socket.pipe(target); target.pipe(socket); }); socket.once('close', () => target.destroy());
    }
  });
  return { port: await listening(server, t), seen };
}
async function pacFile(t, source) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-pac-')); t.after(() => rm(directory, { recursive: true, force: true })); const file = join(directory, 'test.pac'); await writeFile(file, source); return file;
}

test('proxy configuration validates and serializes no credentials; bypass matching is bounded to hosts', () => {
  const config = normalizeNetworkConfig({ mode: 'manual', proxy: { type: 'http', host: 'PROXY.test', port: 8080, password: 'secret' }, password: 'secret', bypass: ['*.example.com', '.local.test', '<local>'] });
  assert.equal(JSON.stringify(config).includes('secret'), false); assert.equal(config.proxy.host, 'proxy.test');
  assert.equal(bypassesProxy('a.example.com', config.bypass), true); assert.equal(bypassesProxy('example.com.attacker.test', config.bypass), false); assert.equal(bypassesProxy('local.test', config.bypass), true); assert.equal(bypassesProxy('printer', config.bypass), true);
  assert.throws(() => normalizeNetworkConfig({ mode: 'manual', proxy: { type: 'http', host: 'user:password@proxy', port: 1 } }));
  assert.throws(() => normalizeNetworkConfig({ mode: 'pac', pacUrl: 'file:///etc/passwd' }));
  assert.throws(() => parsePacResult('PROXY user:password@host:80')); assert.throws(() => parsePacResult('')); assert.throws(() => parsePacResult('DIRECT; UNKNOWN a:80'));
});

test('HTTP forward proxy with Basic auth carries GET and POST while proxy auth never reaches origin', async t => {
  const target = await origin(t), auth = { username: 'sahm-user', password: 'sahm-secret' }, basic = `Basic ${Buffer.from('sahm-user:sahm-secret').toString('base64')}`;
  const proxy = await connectProxy(t, { authentication: basic, rejectConnect: true });
  const service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } }, {}, auth);
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy');
  assert.equal(await (await service.fetch(new Request(target.url, { method: 'POST', body: 'one operation', headers: { authorization: 'Bearer origin' } }))).text(), 'one operation');
  assert.equal(target.requests.length, 2); assert.equal(target.requests[1].headers.authorization, 'Bearer origin'); assert.equal(target.requests[0].headers['proxy-authorization'], undefined); assert.equal(proxy.seen[0].authorization, basic);
  assert.equal(proxy.seen[0].target, target.url); assert.equal(proxy.seen[1].target, target.url);
  assert.equal(JSON.stringify(service.snapshot()).includes('sahm-secret'), false);
  await assert.rejects(service.fetch(target.url, { headers: { 'proxy-authorization': basic } }));
});

test('manual proxy refusal fails closed and never requests the reachable origin directly', async t => {
  const target = await origin(t), proxy = await connectProxy(t, { authentication: 'unavailable' });
  const service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } });
  await assert.rejects(service.fetch(target.url)); assert.equal(target.requests.length, 0); assert.equal(proxy.seen.length, 1);
});

for (const type of ['socks4', 'socks5']) test(`${type} delegates DNS to proxy and transfers exact response`, async t => {
  const target = await origin(t), proxy = await socksProxy(t, type === 'socks4' ? 4 : 5);
  const service = await network(t, { mode: 'manual', proxy: { type, host: '127.0.0.1', port: proxy.port } });
  assert.equal(await (await service.fetch(`http://remote-only.test:${target.port}/file`)).text(), 'through proxy');
  assert.deepEqual(proxy.seen[0], { host: 'remote-only.test', port: target.port, ...(type === 'socks4' ? { user: '' } : {}), remoteDNS: true });
});

test('SOCKS5 password authentication is supported and failures cannot fall back directly', async t => {
  const target = await origin(t), auth = { username: 'user', password: 'pass' }, proxy = await socksProxy(t, 5, auth);
  const service = await network(t, { mode: 'manual', proxy: { type: 'socks5', host: '127.0.0.1', port: proxy.port } }, {}, auth);
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.deepEqual(proxy.seen[0], auth);
  await service.configure(service.snapshot(), { credentials: { username: 'user', password: 'bad' } });
  await assert.rejects(service.fetch(target.url)); assert.equal(target.requests.length, 1);
});

test('PAC executes standard helpers and respects ordered proxy alternatives including explicit DIRECT', async t => {
  const target = await origin(t), working = await connectProxy(t);
  const file = await pacFile(t, `function FindProxyForURL(url, host) { if (shExpMatch(url, '*direct*')) return 'PROXY 127.0.0.1:1; DIRECT'; if (dnsDomainIs(host, '.test')) return 'SOCKS5 127.0.0.1:1'; return 'PROXY 127.0.0.1:1; PROXY 127.0.0.1:${working.port}'; }`);
  const service = await network(t, { mode: 'pac', pacFile: file });
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.equal(working.seen.length, 1);
  assert.equal(await (await service.fetch(target.url + '?direct')).text(), 'through proxy'); assert.equal(working.seen.length, 1); assert.equal(target.requests.length, 2);
  await assert.rejects(service.fetch(`http://remote-only.test:${target.port}/file`)); assert.equal(target.requests.length, 2);
});

test('PAC is sandboxed, bounded, and rejects invalid results without direct fallback', async t => {
  const target = await origin(t);
  for (const source of ["function FindProxyForURL(){return typeof process === 'undefined' ? 'INVALID' : 'DIRECT'}", 'function FindProxyForURL(){while(true){}}', 'function FindProxyForURL(){return ""}']) {
    const file = await pacFile(t, source), service = await network(t, { mode: 'pac', pacFile: file });
    const start = Date.now(); await assert.rejects(service.fetch(target.url)); assert.ok(Date.now() - start < 6000);
  }
  assert.equal(target.requests.length, 0);
});

test('ordered PAC HTTP proxies forward a POST once without requiring CONNECT', async t => {
  const target = await origin(t), auth = { username: 'user', password: 'secret' }, basic = `Basic ${Buffer.from('user:secret').toString('base64')}`;
  const working = await connectProxy(t, { authentication: basic, rejectConnect: true });
  const file = await pacFile(t, `function FindProxyForURL(){return 'PROXY 127.0.0.1:1; PROXY 127.0.0.1:${working.port}'}`);
  const service = await network(t, { mode: 'pac', pacFile: file }, { credentialsProvider: route => route.port === working.port ? auth : null });
  assert.equal(await (await service.fetch(target.url, { method: 'POST', body: 'exactly once' })).text(), 'exactly once');
  assert.equal(target.requests.length, 1); assert.equal(working.seen.length, 1); assert.equal(working.seen[0].target, target.url); assert.equal(working.seen[0].authorization, basic);
});

test('PAC does not replay a dispatched POST through another proxy after authentication or socket failure', async t => {
  const target = await origin(t), working = await connectProxy(t);
  for (const failure of ['authentication', 'socket']) {
    let calls = 0, received = '';
    const failing = http.createServer((req, res) => { calls++; req.on('data', chunk => { received += chunk; }); req.on('end', () => { if (failure === 'authentication') { res.writeHead(407); res.end(); } else req.socket.destroy(); }); });
    const port = await listening(failing, t), file = await pacFile(t, `function FindProxyForURL(){return 'PROXY 127.0.0.1:${port}; PROXY 127.0.0.1:${working.port}; DIRECT'}`);
    const service = await network(t, { mode: 'pac', pacFile: file });
    await assert.rejects(service.fetch(target.url, { method: 'POST', body: 'one operation', signal: AbortSignal.timeout(5000) }));
    assert.equal(calls, 1); assert.equal(received, 'one operation'); assert.equal(working.seen.length, 0); assert.equal(target.requests.length, 0);
  }
});

test('PAC HTTP source is bounded and fetched without stored proxy credentials', async t => {
  const target = await origin(t), seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); if (req.url === '/large') res.end('a'.repeat(262145)); else res.end('function FindProxyForURL(url,host){return "DIRECT"}'); });
  const port = await listening(server, t), service = await network(t, { mode: 'pac', pacUrl: `http://127.0.0.1:${port}/proxy.pac` }, {}, { username: 'secret', password: 'never-shared' });
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.equal(seen[0]['proxy-authorization'], undefined);
  await service.configure({ mode: 'pac', pacUrl: `http://127.0.0.1:${port}/large` }); await assert.rejects(service.fetch(target.url)); assert.equal(target.requests.length, 1);
});

test('system Windows ProxyServer/Override/AutoConfigURL are read without changing system settings', async t => {
  const target = await origin(t), proxy = await connectProxy(t);
  let settings = { ProxyEnable: '0x1', ProxyServer: `http=127.0.0.1:${proxy.port};https=127.0.0.1:9`, ProxyOverride: 'localhost;<local>' };
  const service = await network(t, { mode: 'system' }, { systemSettings: async () => settings });
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.equal(proxy.seen.length, 1);
  assert.deepEqual(await service.routesFor('https://example.test/'), [{ type: 'http', host: '127.0.0.1', port: 9 }]);
  assert.deepEqual(await service.routesFor('http://printer/file'), [{ type: 'direct' }]);
  const pacServer = http.createServer((req, res) => res.end(`function FindProxyForURL(){return 'PROXY 127.0.0.1:${proxy.port}'}`)); const port = await listening(pacServer, t);
  settings = { AutoConfigURL: `http://127.0.0.1:${port}/proxy.pac` }; await service.configure({ mode: 'system' }); assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.equal(proxy.seen.length, 2);
  settings = { AutoDetect: '1' }; await service.configure({ mode: 'system' }); await assert.rejects(service.fetch(target.url));
});

test('explicit bypass makes a direct request and never sends proxy credentials to the origin', async t => {
  const target = await origin(t), proxy = await connectProxy(t);
  const service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port }, bypass: ['127.0.0.1'] }, {}, { username: 'secret', password: 'not-origin' });
  assert.equal(await (await service.fetch(target.url)).text(), 'through proxy'); assert.equal(proxy.seen.length, 0); assert.equal(target.requests[0].headers['proxy-authorization'], undefined);
});

test('external gateway distinguishes proxy refusals, rate limits and temporary failures', async t => {
  const target = await origin(t);
  for (const { options, expected } of [
    { options: { authentication: 'refused' }, expected: 403 },
    { options: { rejectConnect: true }, expected: 403 },
    { options: { rejectConnectStatus: 429 }, expected: 429 },
    { options: { rejectConnectStatus: 502 }, expected: 502 },
  ]) {
    const proxy = await connectProxy(t, options);
    const service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } }, {}, { username: 'fixture', password: 'invalid' });
    const gateway = new URL(await service.externalProxy());
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: gateway.hostname, port: gateway.port, method: 'CONNECT', path: `127.0.0.1:${target.port}`,
        headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${gateway.username}:${gateway.password}`).toString('base64')}` } });
      request.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
      request.once('error', reject); request.end();
    });
    assert.equal(status, expected, 'The gateway must preserve denials and distinguish temporary failures');
    assert.equal(proxy.seen.length, 1);
    assert.equal(proxy.seen[0].authorization, `Basic ${Buffer.from('fixture:invalid').toString('base64')}`);
  }
  assert.equal(target.requests.length, 0);
});

test('external media proxy requires its private token and obeys the same upstream routes', async t => {
  const target = await origin(t), proxy = await connectProxy(t), service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } });
  const addresses = await Promise.all(Array.from({ length: 8 }, () => service.externalProxy())); assert.equal(new Set(addresses).size, 1);
  const local = new URL(addresses[0]);
  const request = (auth, path) => new Promise((resolve, reject) => { const req = http.get({ host: local.hostname, port: local.port, path, headers: auth ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(local.username)}:${decodeURIComponent(local.password)}`).toString('base64')}` } : {} }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); }); req.once('error', reject); });
  assert.equal((await request(false, target.url)).status, 407); assert.equal(target.requests.length, 0);
  assert.deepEqual(await request(true, target.url), { status: 200, text: 'through proxy' }); assert.equal(proxy.seen.length, 1); assert.equal(target.requests[0].headers['proxy-authorization'], undefined);
  const client = net.connect({ host: local.hostname, port: Number(local.port) }); await once(client, 'connect');
  const basic = `Basic ${Buffer.from(`${local.username}:${local.password}`).toString('base64')}`;
  client.write(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nProxy-Authorization: ${basic}\r\n\r\n`);
  const [reply] = await once(client, 'data'); assert.match(reply.toString(), /200 Connection Established/);
  client.write('GET /media HTTP/1.1\r\nHost: target\r\nConnection: close\r\n\r\n'); let response = ''; for await (const chunk of client) response += chunk; assert.match(response, /through proxy/); assert.equal(proxy.seen.length, 2);
});

test('HTTPS origins and HTTPS proxies retain certificate validation', async t => {
  const target = await origin(t, true), proxy = await connectProxy(t), service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port } });
  await assert.rejects(service.fetch(target.url)); assert.equal(target.requests.length, 0); assert.equal(proxy.seen.length, 1);
  const secureProxy = await connectProxy(t, { secure: true }); await service.configure({ mode: 'manual', proxy: { type: 'https', host: '127.0.0.1', port: secureProxy.port } });
  await assert.rejects(service.fetch('http://127.0.0.1:8/file')); assert.equal(secureProxy.seen.length, 0);
});

test('HTTPS origin and HTTPS CONNECT proxy transfer bytes with a trusted CA and remote host policy', async () => {
  const moduleUrl = new URL('../src/network.mjs', import.meta.url).href;
  const cert = fileURLToPath(new URL('./fixtures/ftp/server-cert.pem', import.meta.url));
  const key = fileURLToPath(new URL('./fixtures/ftp/server-key.pem', import.meta.url));
  const script = `import https from 'node:https';import net from 'node:net';import{readFile}from'node:fs/promises';import{once}from'node:events';import{NetworkService}from${JSON.stringify(moduleUrl)};
  const options={key:await readFile(${JSON.stringify(key)}),cert:await readFile(${JSON.stringify(cert)})};
  const sockets=new Set();const listen=async server=>{server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s))});server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port};
  const target=https.createServer(options,(req,res)=>res.end('trusted TLS bytes'));const targetPort=await listen(target);
  let tunnels=0;const proxy=https.createServer(options);proxy.on('connect',(req,client,head)=>{tunnels++;let remote=net.connect({host:'127.0.0.1',port:targetPort});remote.on('error',()=>client.destroy());remote.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client)});client.on('close',()=>remote.destroy())});const proxyPort=await listen(proxy);
  const network=new NetworkService();try{await network.configure({mode:'manual',proxy:{type:'https',host:'127.0.0.1',port:proxyPort}});const response=await network.fetch('https://127.0.0.1:'+targetPort+'/file');if(await response.text()!=='trusted TLS bytes'||tunnels!==1)throw Error('TLS transfer failed');console.log('trusted-tls-pass')}finally{await network.close();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>target.close(r))])}`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  assert.match(stdout, /trusted-tls-pass/);
});
