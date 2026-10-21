import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { ftpFixture } from '../test/helpers/ftp-fixture.mjs';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const release = resolve(process.argv[2] || process.env.SAHM_RELEASE_DIRECTORY || `dist/${version}`);
const runtime = /\.exe$/i.test(release) ? release : await stat(join(release, 'SAHM.exe')).then(() => join(release, 'SAHM.exe'), () => join(release, 'SAHM-win32-x64', 'SAHM.exe'));
const application = await stat(join(dirname(runtime), 'resources', 'app.asar')).then(() => join(dirname(runtime), 'resources', 'app.asar'), () => join(dirname(runtime), 'resources', 'app'));
const directory = resolve('artifacts', 'packaged-network-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const payload = Buffer.alloc(256 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
const report = { runtime, application, directory, noSystemSettingsChanged: true, requests: [], proxyRequests: [] };
const proxyLogin = { username: 'packaged-smoke', password: 'fixture-proxy-password' };
const basic = `Basic ${Buffer.from(`${proxyLogin.username}:${proxyLogin.password}`).toString('base64')}`;
const sockets = new Set(), cleanup = [];
let source, proxy, ftp;
function track(server) { server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); }); }
async function listen(server) { track(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
try {
  await stat(runtime);
  source = http.createServer((request, response) => {
    report.requests.push({ path: request.url, method: request.method, throughProxy: request.headers['x-packaged-proxy'] === 'yes' });
    if (request.headers['x-packaged-proxy'] !== 'yes') { response.writeHead(403); response.end(); return; }
    if (request.url === '/file.bin') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
      response.writeHead(match ? 206 : 200, { 'Content-Type': 'application/octet-stream', ETag: '"packaged-network"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) }); response.end(payload.subarray(start, end + 1)); return;
    }
    const resources = {
      '/robots.txt': ['text/plain', 'User-agent: *\nDisallow:\n'],
      '/site/': ['text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Packaged mirror</title><h1>Packaged site copy</h1><a href="second.html">Next</a><link rel="stylesheet" href="main.css">'],
      '/site/second.html': ['text/html', '<h1>Second saved page</h1>'],
      '/site/main.css': ['text/css', 'body{color:#173045}'],
    };
    const resource = resources[request.url]; if (!resource) { response.writeHead(404); response.end(); return; } response.writeHead(200, { 'Content-Type': resource[0] }); response.end(resource[1]);
  });
  const port = await listen(source), origin = `http://127.0.0.1:${port}`;
  proxy = http.createServer((request, response) => {
    const authorized = request.headers['proxy-authorization'] === basic; report.proxyRequests.push({ type: 'forward', method: request.method, path: new URL(request.url).pathname, authorized });
    if (!authorized) { response.writeHead(407); response.end(); return; }
    const headers = { ...request.headers, 'x-packaged-proxy': 'yes' }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = http.request(new URL(request.url), { method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  proxy.on('connect', (request, client, head) => {
    const authorized = request.headers['proxy-authorization'] === basic; report.proxyRequests.push({ type: 'connect', target: request.url, authorized });
    if (!authorized) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const match = /^127\.0\.0\.1:(\d+)$/.exec(request.url); if (!match) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect({ host: '127.0.0.1', port: Number(match[1]) }); sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); }); upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  ftp = await ftpFixture({ after: callback => cleanup.push(callback) }, { requireLogin: true });
  const pacFile = join(directory, 'proxy.pac');
  await writeFile(pacFile, `function FindProxyForURL(url,host){if(isPlainHostName(host)||shExpMatch(url,'*'))return 'PROXY 127.0.0.1:${proxyPort}';return 'PROXY 127.0.0.1:1'}`);
  const moduleUrl = name => pathToFileURL(join(application, 'src', name)).href;
  const childScript = join(directory, 'runtime-probe.mjs'), childReport = join(directory, 'runtime-result.json');
  const script = `import assert from 'node:assert/strict';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
import{NetworkService}from${JSON.stringify(moduleUrl('network.mjs'))};
import{download}from${JSON.stringify(moduleUrl('download.mjs'))};
import{downloadFtp}from${JSON.stringify(moduleUrl('ftp.mjs'))};
import{setTransportFetch,transportFetch}from${JSON.stringify(moduleUrl('transport.mjs'))};
import{runSiteMirror}from${JSON.stringify(moduleUrl('site-mirror.mjs'))};
const result={runtime:process.execPath,node:process.versions.node,electron:process.versions.electron,packagedModules:true,checks:[]};
const network=new NetworkService({credentialsProvider:route=>route.host==='127.0.0.1'&&route.port===${proxyPort}?${JSON.stringify(proxyLogin)}:null});
try{
await network.configure({mode:'pac',pacFile:${JSON.stringify(pacFile)}});setTransportFetch(network.createFetch());
const routes=await network.routesFor(${JSON.stringify(origin + '/file.bin')});assert.equal(routes[0].type,'http');assert.equal(routes[0].port,${proxyPort});result.checks.push('packaged PAC Worker and QuickJS WASM execute standard helpers');
const file=await download(${JSON.stringify(origin + '/file.bin')},${JSON.stringify(join(directory, 'http.bin'))},{connections:3});const bytes=await readFile(file.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),${JSON.stringify(createHash('sha256').update(payload).digest('hex'))});result.http={bytes:bytes.length};result.checks.push('packaged segmented HTTP downloader follows PAC and authenticates to proxy');
const site=await runSiteMirror(${JSON.stringify(origin + '/site/')},${JSON.stringify(join(directory, 'site'))},{fetchImpl:transportFetch,options:{depth:1,maxPages:10,maxBytes:1048576}});assert.equal(site.state,'complete');const html=await readFile(${JSON.stringify(join(directory, 'site', 'index.html'))},'utf8');assert.ok(html.includes('Packaged site copy'));result.site=site.stats;result.checks.push('packaged site parser and mirror dependencies copy local pages and CSS through PAC');
const ftp=await downloadFtp(${JSON.stringify(ftp.url)},${JSON.stringify(join(directory, 'ftp.bin'))},{network,credentials:{username:'test-user',password:'secret-ftp-password'},credentialScope:'packaged-smoke',tlsMode:'auto'});result.ftp={bytes:ftp.bytes};assert.equal(createHash('sha256').update(await readFile(ftp.path)).digest('hex'),${JSON.stringify(createHash('sha256').update(ftp.original).digest('hex'))});result.checks.push('packaged FTP transports control and data through authenticated PAC proxy');
result.passed=true;
}catch(error){result.passed=false;result.error=error.stack;process.exitCode=1}finally{await network.close();await writeFile(${JSON.stringify(childReport)},JSON.stringify(result,null,2));console.log('PACKAGED NETWORK '+(result.passed?'PASS':'FAIL'));}`;
  await writeFile(childScript, script);
  try {
    const output = await run(runtime, [childScript], { windowsHide: true, cwd: dirname(runtime), timeout: 60000, maxBuffer: 512 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } }); report.stdout = output.stdout.trim(); report.stderr = output.stderr.trim();
  } catch (error) { report.stdout = error.stdout?.trim(); report.stderr = error.stderr?.trim(); report.error = error.message.replaceAll(proxyLogin.password, '[fixture credential]'); }
  report.runtimeResult = await readFile(childReport, 'utf8').then(JSON.parse, () => null);
  assert.equal(report.runtimeResult?.passed, true, 'shipped modules and their PAC worker must pass in SAHM.exe Node mode');
  assert.ok(report.requests.length > 0 && report.requests.every(request => request.throughProxy));
  assert.ok(report.proxyRequests.every(request => request.authorized)); assert.ok(report.proxyRequests.filter(request => request.type === 'connect').length >= 2); assert.equal(ftp.retrievals, 1);
  report.passed = true;
} catch (error) { report.passed = false; report.error ||= error.message; }
finally {
  for (const socket of sockets) socket.destroy(); for (const server of [source, proxy]) if (server?.listening) await new Promise(resolve => server.close(resolve));
  for (const close of cleanup.reverse()) await close();
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`PACKAGED NETWORK ${report.passed ? 'PASS' : 'FAIL'}: ${join(directory, 'result.json')}`);
  if (!report.passed) process.exitCode = 1;
}
