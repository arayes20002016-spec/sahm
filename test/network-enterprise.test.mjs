import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NetworkService, normalizeNetworkConfig } from '../src/network.mjs';
import { normalizeAuthentication, proxyAuthentication, serverAuthentication } from '../src/enterprise-auth.mjs';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

async function target(t) {
  const requests = [];
  const server = http.createServer((request, response) => { requests.push({ method: request.method, url: request.url, headers: request.headers }); response.end('enterprise HTTP bytes'); });
  return { origin: `http://127.0.0.1:${await listen(t, server)}`, requests };
}

async function connectProxy(t) {
  const tunnels = [], requests = [], server = http.createServer((request, response) => {
    requests.push(request.url);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['proxy-authorization', 'proxy-connection'].includes(key)));
    const outgoing = http.request(new URL(request.url), { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    outgoing.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(outgoing);
  });
  server.on('connect', (request, client, head) => {
    tunnels.push({ authority: request.url, authorization: request.headers['proxy-authorization'] });
    const address = new URL('http://' + request.url), remote = net.connect({ host: address.hostname, port: Number(address.port) });
    remote.on('error', () => client.destroy()); client.on('close', () => remote.destroy());
    remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
  });
  return { host: '127.0.0.1', port: await listen(t, server), tunnels, requests };
}

async function pacServer(t, source, status = 200) {
  let calls = 0;
  const server = http.createServer((_request, response) => { calls++; response.writeHead(status, { 'content-type': 'application/x-ns-proxy-autoconfig' }); response.end(source); });
  return { url: `http://127.0.0.1:${await listen(t, server)}/proxy.pac`, get calls() { return calls; } };
}

async function network(t, config, providers = {}) {
  const service = new NetworkService(providers); t.after(() => service.close()); await service.configure(config); return service;
}

const authentication = (servers = [], proxy = { scheme: 'basic', currentAccount: false, allowedHosts: [] }) => ({ servers, proxy });
const serverPolicy = (origin, currentAccount = true, scheme = 'ntlm') => ({ origin, scheme, currentAccount });
const proxyPolicy = (currentAccount = true, allowedHosts = ['127.0.0.1'], scheme = 'negotiate') => ({ scheme, currentAccount, allowedHosts });
const nativeResponse = () => new Response('native enterprise bytes', { status: 200 });

test('enterprise authentication schema canonicalizes exact origins and trusted proxy hosts without accepting secret fields', () => {
  const value = normalizeAuthentication({ proxy: { scheme: 'negotiate', currentAccount: true, allowedHosts: ['PROXY.Example.test', 'proxy.example.test', '[::1]'] }, servers: [serverPolicy('HTTPS://Server.Example.test:443/')] });
  assert.deepEqual(value.proxy.allowedHosts, ['proxy.example.test', '::1']);
  assert.equal(value.servers[0].origin, 'https://server.example.test');
  for (const input of [null, [], { password: 'must-not-persist' }, { proxy: { scheme: 'kerberos' } }, { proxy: { scheme: 'basic', currentAccount: true } }, { proxy: { scheme: 'ntlm', currentAccount: true, allowedHosts: [] } }, { proxy: { scheme: 'ntlm', allowedHosts: ['*.example.test'] } }, { proxy: { scheme: 'ntlm', password: 'must-not-persist' } }, { servers: [{ ...serverPolicy('https://example.test'), password: 'must-not-persist' }] }, { servers: [serverPolicy('https://example.test/path')] }, { servers: [serverPolicy('https://user:secret@example.test')] }, { servers: [serverPolicy('https://example.test'), serverPolicy('https://example.test:443/')] }, { servers: Array.from({ length: 33 }, (_, index) => serverPolicy(`https://server${index}.example.test`)) }]) assert.throws(() => normalizeAuthentication(input));
  assert.throws(() => normalizeNetworkConfig({ clientCertificates: [{ origin: 'https://example.test', pfxFile: join(tmpdir(), 'client.pfx'), passphrase: 'must-not-persist' }] }));
  assert.deepEqual(normalizeNetworkConfig({ mode: 'wpad' }), { mode: 'wpad', bypass: [] });
});

test('server authentication matching includes scheme, host and port, and Windows proxy credentials require exact allowed hosts', () => {
  const config = { authentication: authentication([serverPolicy('https://auth.example.test:8443')], proxyPolicy(true, ['proxy.example.test'])) };
  assert.ok(serverAuthentication('https://auth.example.test:8443/download/file', config));
  for (const url of ['http://auth.example.test:8443/file', 'https://auth.example.test/file', 'https://another.example.test:8443/file']) assert.equal(serverAuthentication(url, config), null);
  assert.equal(proxyAuthentication({ type: 'direct' }, config), null);
  assert.equal(proxyAuthentication({ type: 'socks5', host: 'proxy.example.test' }, config), null);
  assert.equal(proxyAuthentication({ type: 'http', host: 'proxy.example.test' }, config).currentAccount, true);
  assert.throws(() => proxyAuthentication({ type: 'http', host: 'unknown.example.test' }, config), { code: 'windows-auth-untrusted-host' });
});

test('WPAD deduplicates discovery and PAC loading then downloads bytes through the actual selected HTTP proxy', async t => {
  const upstream = await target(t), proxy = await connectProxy(t), pac = await pacServer(t, `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${proxy.port}"; }`);
  let discoveries = 0;
  const service = await network(t, { mode: 'wpad' }, { discoverPac: async () => { discoveries++; return pac.url; } });
  const choices = await Promise.all(Array.from({ length: 6 }, () => service.routesFor(upstream.origin + '/download')));
  for (const routes of choices) assert.deepEqual(routes, [{ type: 'http', host: '127.0.0.1', port: proxy.port }]);
  assert.equal(discoveries, 1); assert.equal(pac.calls, 1);
  assert.equal(await (await service.fetch(upstream.origin + '/download')).text(), 'enterprise HTTP bytes');
  assert.equal(proxy.tunnels.length + proxy.requests.length, 1); assert.equal(upstream.requests.length, 1); assert.equal(pac.calls, 1); assert.equal(discoveries, 1);
  await service.configure({ mode: 'wpad' });
  await service.routesFor(upstream.origin + '/another');
  assert.equal(discoveries, 2); assert.equal(pac.calls, 2);
});

test('system auto-detection uses WPAD while an explicit system PAC URL takes precedence', async t => {
  const pac = await pacServer(t, 'function FindProxyForURL(url, host) { return "DIRECT"; }');
  let discoveries = 0, snapshots = 0;
  const service = await network(t, { mode: 'system' }, { systemSettings: async () => { snapshots++; return { AutoDetect: '1', ProxyEnable: '0' }; }, discoverPac: async () => { discoveries++; return pac.url; } });
  assert.deepEqual(await service.routesFor('https://origin.example.test/file'), [{ type: 'direct' }]);
  assert.equal(discoveries, 1); assert.equal(snapshots, 1);
  service.systemSettings = async () => ({ AutoDetect: '1', AutoConfigURL: pac.url, ProxyEnable: '0' });
  await service.configure({ mode: 'system' });
  assert.deepEqual(await service.routesFor('https://origin.example.test/file'), [{ type: 'direct' }]);
  assert.equal(discoveries, 1); assert.equal(pac.calls, 2);
});

test('system manual proxy currently precedes WPAD when both Windows settings are enabled', async t => {
  let discoveries = 0;
  const service = await network(t, { mode: 'system' }, {
    systemSettings: async () => ({ ProxyEnable: '1', ProxyServer: 'http=proxy.example.test:3128;https=secure-proxy.example.test:8443', AutoDetect: '1' }),
    discoverPac: async () => { discoveries++; throw new Error('A selected manual route must not discover WPAD.'); }
  });
  assert.deepEqual(await service.routesFor('http://origin.example.test/file'), [{ type: 'http', host: 'proxy.example.test', port: 3128 }]);
  assert.deepEqual(await service.routesFor('https://origin.example.test/file'), [{ type: 'http', host: 'secure-proxy.example.test', port: 8443 }]);
  assert.equal(discoveries, 0);
});

test('missing or failed WPAD and failed PAC bootstrap do not contact the download origin directly', async t => {
  const upstream = await target(t);
  const service = await network(t, { mode: 'wpad' }, { discoverPac: async () => null });
  await assert.rejects(service.fetch(upstream.origin + '/download'), { code: 'wpad-not-found' });
  service.discoverPac = async () => { throw Object.assign(new Error('synthetic discovery failure'), { code: 'wpad-discovery-failed' }); };
  await assert.rejects(service.fetch(upstream.origin + '/download'), { code: 'wpad-discovery-failed' });
  const pac = await pacServer(t, 'unavailable', 503);
  service.discoverPac = async () => pac.url;
  await assert.rejects(service.fetch(upstream.origin + '/download'), /PAC fetch failed/);
  assert.equal(upstream.requests.length, 0); assert.equal(pac.calls, 1);
});

test('caller cancellation and reconfiguration invalidate pending WPAD results without dispatching stale requests', async t => {
  const pac = await pacServer(t, 'function FindProxyForURL(url, host) { return "DIRECT"; }');
  let resolveDiscovery, starts = 0, nativeSignal;
  const service = await network(t, { mode: 'wpad' }, { discoverPac: options => { starts++; nativeSignal = options.signal; return new Promise(resolve => { resolveDiscovery = resolve; }); } });
  const controller = new AbortController(), first = service.routesFor('https://origin.example.test/file', { signal: controller.signal });
  controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  const pending = service.routesFor('https://origin.example.test/another');
  const rejected = assert.rejects(pending, /Network settings changed/);
  await service.configure({ mode: 'direct' });
  assert.equal(nativeSignal.aborted, true); await rejected;
  resolveDiscovery(pac.url);
  assert.deepEqual(await service.routesFor('https://origin.example.test/file'), [{ type: 'direct' }]);
  assert.equal(pac.calls, 0); assert.equal(starts, 1);
  service.discoverPac = async () => { starts++; return pac.url; };
  await service.configure({ mode: 'wpad' });
  assert.deepEqual(await service.routesFor('https://origin.example.test/file'), [{ type: 'direct' }]);
  assert.equal(starts, 2); assert.equal(pac.calls, 1);
});

test('explicit server credentials reach only the exact native-fetch origin while other ports use ordinary HTTP', async t => {
  const upstream = await target(t), other = await target(t), calls = [], credentialOrigins = [];
  const login = { username: 'DOMAIN\\fixture', password: 'session-only-secret' };
  const service = await network(t, { mode: 'direct', authentication: authentication([serverPolicy(upstream.origin, false)]) }, {
    serverCredentialsProvider: async origin => { credentialOrigins.push(origin); return login; },
    credentialsProvider: async () => { throw new Error('Direct requests must not read proxy credentials.'); },
    windowsFetch: async (...args) => { calls.push(args); return nativeResponse(); }
  });
  assert.equal(await (await service.fetch(upstream.origin + '/first')).text(), 'native enterprise bytes');
  assert.equal(await (await service.fetch(upstream.origin + '/second')).text(), 'native enterprise bytes');
  assert.equal(await (await service.fetch(other.origin + '/ordinary')).text(), 'enterprise HTTP bytes');
  assert.deepEqual(credentialOrigins, [upstream.origin, upstream.origin]);
  assert.equal(calls.length, 2); assert.equal(upstream.requests.length, 0); assert.equal(other.requests.length, 1);
  const [url, init, context] = calls[0];
  assert.equal(url, upstream.origin + '/first'); assert.equal(init.redirect, 'manual');
  assert.equal(context.serverAuth.credentials, login); assert.equal(context.proxyAuth, null); assert.deepEqual(context.route, { type: 'direct' });
  assert.equal(init.headers.has('authorization'), false); assert.equal(init.headers.has('proxy-authorization'), false);
});

test('current-account server and proxy policies never call explicit credential providers', async t => {
  const upstream = await target(t), calls = [], certificateOrigins = [];
  const config = { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: 3128 }, authentication: authentication([serverPolicy('https://secure.example.test')], proxyPolicy()) };
  const service = await network(t, config, {
    serverCredentialsProvider: async () => { throw new Error('Current account must not read stored server credentials.'); },
    credentialsProvider: async () => { throw new Error('Current account must not read stored proxy credentials.'); },
    clientCertificateProvider: async origin => { certificateOrigins.push(origin); return null; },
    windowsFetch: async (...args) => { calls.push(args); return nativeResponse(); }
  });
  await service.fetch('https://secure.example.test/download');
  assert.equal(calls[0][2].serverAuth.currentAccount, true); assert.equal(calls[0][2].serverAuth.credentials, null);
  assert.equal(calls[0][2].proxyAuth.currentAccount, true); assert.equal(calls[0][2].proxyAuth.credentials, null);
  assert.equal(calls[0][2].clientCertificate, null); assert.deepEqual(certificateOrigins, ['https://secure.example.test']);
  await service.configure({ ...config, authentication: authentication([], proxyPolicy()) });
  await service.fetch(upstream.origin + '/proxy-only');
  assert.equal(calls[1][2].serverAuth, null); assert.equal(calls[1][2].proxyAuth.currentAccount, true);
  assert.deepEqual(certificateOrigins, ['https://secure.example.test'], 'Plain HTTP must never request a client TLS certificate.');
});

test('missing explicit logins, manual authorization and untrusted current-account proxies fail before native dispatch or Basic fallback', async t => {
  const upstream = await target(t), proxy = await connectProxy(t); let nativeCalls = 0, credentialReads = 0;
  const service = await network(t, { mode: 'direct', authentication: authentication([serverPolicy(upstream.origin, false)]) }, { windowsFetch: async () => { nativeCalls++; return nativeResponse(); } });
  await assert.rejects(service.fetch(upstream.origin + '/missing'), { code: 'windows-auth-missing-credentials' });
  await assert.rejects(service.fetch(upstream.origin + '/manual', { headers: { authorization: 'Bearer manual-value' } }), /التفويض اليدوية/);
  service.credentialsProvider = async () => { credentialReads++; return { username: 'must-not-be-read', password: 'must-not-be-read' }; };
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: proxy.host, port: proxy.port }, authentication: authentication([], proxyPolicy(true, ['trusted.example.test'])) });
  await assert.rejects(service.fetch(upstream.origin + '/untrusted'), { code: 'windows-auth-untrusted-host' });
  service.credentialsProvider = undefined;
  await service.configure({ mode: 'manual', proxy: { type: 'http', host: proxy.host, port: proxy.port }, authentication: authentication([], proxyPolicy(false)) });
  await assert.rejects(service.fetch(upstream.origin + '/missing-proxy-login'), { code: 'windows-auth-missing-credentials' });
  assert.equal(nativeCalls, 0); assert.equal(credentialReads, 0); assert.equal(upstream.requests.length, 0); assert.equal(proxy.requests.length, 0); assert.equal(proxy.tunnels.length, 0);
});

test('Windows authentication chooses an available PAC route before native dispatch and never retries a 401 or 407 response', async t => {
  const upstream = await target(t), proxy = await connectProxy(t);
  const closed = net.createServer(); closed.listen(0, '127.0.0.1'); await once(closed, 'listening'); const closedPort = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const pac = await pacServer(t, `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${closedPort}; PROXY 127.0.0.1:${proxy.port}; DIRECT"; }`);
  let credentials = 0, nativeCalls = 0, status = 401;
  const service = await network(t, { mode: 'pac', pacUrl: pac.url, authentication: authentication([], proxyPolicy(false)) }, {
    credentialsProvider: async route => { credentials++; assert.equal(route.port, proxy.port); return { username: 'fixture', password: 'private' }; },
    windowsFetch: async (_url, init, context) => {
      nativeCalls++; assert.equal(context.route.port, proxy.port); assert.equal(context.proxyAuth.scheme, 'negotiate'); assert.equal(init.headers.has('proxy-authorization'), false);
      return new Response('native authentication rejected', { status });
    }
  });
  for (status of [401, 407]) {
    const response = await service.fetch(upstream.origin + '/download');
    assert.equal(response.status, status); assert.equal(await response.text(), 'native authentication rejected');
  }
  assert.equal(credentials, 2); assert.equal(nativeCalls, 2); assert.equal(upstream.requests.length, 0); assert.equal(proxy.tunnels.length, 0); assert.equal(proxy.requests.length, 0);
});

test('explicit proxy identity is passed as NTLM context rather than a Basic header', async t => {
  const upstream = await target(t), login = { username: 'DOMAIN\\proxy-user', password: 'private-proxy-value' }, calls = [];
  const service = await network(t, { mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: 3128 }, authentication: authentication([], proxyPolicy(false, [], 'ntlm')) }, {
    credentialsProvider: async () => login, windowsFetch: async (...args) => { calls.push(args); return nativeResponse(); }
  });
  await service.fetch(upstream.origin + '/download');
  assert.equal(calls[0][2].proxyAuth.scheme, 'ntlm'); assert.equal(calls[0][2].proxyAuth.credentials.username, login.username);
  assert.equal(calls[0][1].headers.has('proxy-authorization'), false); assert.equal(upstream.requests.length, 0);
});

test('NetworkService transfers real mTLS bytes directly and through an HTTP CONNECT proxy with identity scoped by origin', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-network-mtls-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cert = fileURLToPath(new URL('./fixtures/ftp/server-cert.pem', import.meta.url)), key = fileURLToPath(new URL('./fixtures/ftp/server-key.pem', import.meta.url)), pfxFile = join(directory, 'identity.pfx');
  const phrase = 'local-network-mtls-passphrase';
  const openssl = process.env.SAHM_TEST_OPENSSL || (process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');
  await new Promise((resolve, reject) => { const child = execFile(openssl, ['pkcs12', '-export', '-in', cert, '-inkey', key, '-out', pfxFile, '-passout', 'stdin'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, failure => failure ? reject(new Error('Cannot create local network mTLS identity.')) : resolve()); child.stdin.on('error', () => {}); child.stdin.end(phrase + '\n'); });
  const moduleUrl = new URL('../src/network.mjs', import.meta.url).href, certificateModule = new URL('../src/client-certificates.mjs', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';import https from 'node:https';import http from 'node:http';import net from 'node:net';import{readFile}from'node:fs/promises';import{once}from'node:events';import{NetworkService}from${JSON.stringify(moduleUrl)};import{loadClientCertificate}from${JSON.stringify(certificateModule)};
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));const cert=await readFile(input.cert),key=await readFile(input.key);const sockets=new Set(),peers=[],calls=[];
const listen=async server=>{server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket))});server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port};
let otherOrigin;const options={key,cert,ca:cert,requestCert:true,rejectUnauthorized:true};const target=https.createServer(options,(request,response)=>{peers.push({authorized:request.socket.authorized,cn:request.socket.getPeerCertificate().subject.CN});if(request.url==='/redirect'){response.writeHead(302,{location:otherOrigin+'/file'});response.end()}else response.end('NetworkService mutual TLS bytes')});target.on('tlsClientError',()=>{});const targetOrigin='https://127.0.0.1:'+await listen(target);
let otherRequests=0;const other=https.createServer(options,(_request,response)=>{otherRequests++;response.end('must not inherit identity')});other.on('tlsClientError',()=>{});otherOrigin='https://127.0.0.1:'+await listen(other);
let tunnels=0;const proxy=http.createServer();proxy.on('connect',(request,client,head)=>{tunnels++;const url=new URL('http://'+request.url),remote=net.connect({host:url.hostname,port:Number(url.port)});remote.on('error',()=>client.destroy());client.on('close',()=>remote.destroy());remote.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client)})});const proxyPort=await listen(proxy);
const profile={origin:targetOrigin,pfxFile:input.pfxFile,enabled:true};const service=new NetworkService({clientCertificateProvider:async origin=>{calls.push(origin);return origin===targetOrigin?loadClientCertificate(origin,profile,input.phrase):null}});
try{await service.configure({mode:'direct',clientCertificates:[profile]});assert.equal(await(await service.fetch(targetOrigin+'/file')).text(),'NetworkService mutual TLS bytes');await assert.rejects(service.fetch(otherOrigin+'/file'));await service.configure({mode:'manual',proxy:{type:'http',host:'127.0.0.1',port:proxyPort},clientCertificates:[profile]});assert.equal(await(await service.fetch(targetOrigin+'/file')).text(),'NetworkService mutual TLS bytes');const redirected=await service.fetch(targetOrigin+'/redirect');assert.equal(redirected.status,302);await redirected.body.cancel();await assert.rejects(service.fetch(redirected.headers.get('location')));assert.equal(otherRequests,0);assert.ok(peers.every(peer=>peer.authorized&&peer.cn==='localhost'));assert.ok(calls.includes(otherOrigin));assert.ok(tunnels>=2);console.log(JSON.stringify({ok:true,direct:true,httpProxy:true,identityScoped:true,redirectScoped:true,authorizedRequests:peers.length,tunnels,providerCalls:calls.length}))}finally{await service.close();for(const socket of sockets)socket.destroy();await Promise.all([target,other,proxy].map(server=>new Promise(resolve=>server.close(resolve))))}`;
  const environment = { ...process.env, NODE_EXTRA_CA_CERTS: cert }; delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', script], { env: environment, windowsHide: true, timeout: 15000, maxBuffer: 65536 }, (failure, stdout) => failure ? reject(failure) : resolve(stdout));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ cert, key, pfxFile, phrase }));
  });
  const report = JSON.parse(stdout.trim());
  assert.equal(report.ok, true); assert.equal(report.direct, true); assert.equal(report.httpProxy, true); assert.equal(report.identityScoped, true); assert.equal(report.redirectScoped, true);
  assert.equal(report.authorizedRequests, 3);
});
