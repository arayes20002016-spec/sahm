import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { once } from 'node:events';
import { NetworkService } from '../src/network.mjs';
import { MediaService } from '../src/media.mjs';
import { setTransportFetch } from '../src/transport.mjs';
import { startMediaFixture } from './media-browser-fixture.mjs';

const run = promisify(execFile);
const directory = resolve('artifacts', 'proxy-media-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const report = { startedAt: new Date().toISOString(), target: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', usesCookies: false, changesSystemProxy: false, runtime: resolve('artifacts', 'media-runtime'), requests: [], operations: [], children: [] };
const auth = { username: 'sahm-smoke', password: randomBytes(24).toString('hex') };
const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
const sockets = new Set();
let network, media, fixture, localMediaProxy;
const proxy = createServer((request, response) => {
  if (request.headers['proxy-authorization'] !== authorization) { response.writeHead(407); response.end(); return; }
  let target;
  try { target = new URL(request.url); if (target.protocol !== 'http:') throw new Error('invalid target'); }
  catch { response.writeHead(400); response.end(); return; }
  const record = { type: 'forward', method: request.method, host: target.hostname, port: Number(target.port || 80), path: target.pathname, responseBytes: 0 }; report.requests.push(record);
  const headers = { ...request.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const upstream = http.request(target, { method: request.method, headers }, result => {
    record.status = result.statusCode;
    response.writeHead(result.statusCode, result.headers);
    result.on('data', chunk => { record.responseBytes += chunk.length; }); result.pipe(response);
  });
  upstream.on('error', error => { record.error = error.code || 'upstream-error'; if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream);
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
proxy.on('connect', (request, client, head) => {
  if (request.headers['proxy-authorization'] !== authorization) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(request.url);
  if (!match || Number(match[2]) !== 443) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const record = { type: 'connect', host: match[1], port: Number(match[2]), responseBytes: 0 }; report.requests.push(record);
  const upstream = net.connect({ host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) }); sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
  upstream.setTimeout(30000, () => upstream.destroy());
  upstream.once('connect', () => { record.connected = true; client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  upstream.on('data', chunk => { record.responseBytes += chunk.length; });
  upstream.on('error', error => { record.error = error.code || 'upstream-error'; client.destroy(); }); client.once('close', () => upstream.destroy());
});
async function probe(path) {
  const { stdout } = await run(join(report.runtime, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { windowsHide: true, timeout: 20000, maxBuffer: 512 * 1024 });
  const parsed = JSON.parse(stdout), streams = parsed.streams.map(stream => ({ codecType: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height }));
  assert.ok(streams.some(stream => stream.codecType === 'video')); assert.ok(streams.some(stream => stream.codecType === 'audio'));
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), duration: Number(parsed.format.duration), streams };
}
async function operation(name, callback) {
  const record = { name, startedAt: new Date().toISOString(), firstRequest: report.requests.length }; report.operations.push(record);
  try { await callback(record); record.passed = true; }
  catch (error) { record.passed = false; record.error = error.message; }
  record.lastRequest = report.requests.length; record.completedAt = new Date().toISOString();
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`${name}: ${record.passed ? 'PASS' : 'FAIL'} (${record.lastRequest - record.firstRequest} upstream requests)`);
}
try {
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  network = new NetworkService(); await network.configure({ mode: 'manual', proxy: { type: 'http', host: '127.0.0.1', port: proxy.address().port } }, { credentials: auth });
  setTransportFetch(network.createFetch()); localMediaProxy = new URL(await network.externalProxy());
  media = new MediaService({ network, runtimeDirectory: report.runtime, spawnProcess: (executable, args, options) => {
    const index = args.indexOf('--proxy'), url = index >= 0 && args[index + 1] ? new URL(args[index + 1]) : null;
    report.children.push({ executable: basename(executable), extractor: args[args.indexOf('--use-extractors') + 1], proxyPresent: index >= 0, proxyIsPrivateLoopback: url ? url.host === localMediaProxy.host && url.username === localMediaProxy.username && url.password === localMediaProxy.password : false, proxyIsExplicitlyEmpty: index >= 0 && args[index + 1] === '' });
    return spawn(executable, args, options);
  } });
  await operation('YouTube inspect and 240p download through manual proxy', async record => {
    record.info = await media.inspect(report.target, { signal: AbortSignal.timeout(100000) });
    assert.ok(record.info.qualities.includes('240'));
    const result = await media.download(report.target, join(directory, 'youtube', 'public-video.mkv'), { quality: '240', signal: AbortSignal.timeout(150000) });
    record.file = await probe(result.path);
    assert.ok(record.file.streams.some(stream => stream.codecType === 'video' && stream.height <= 240));
    const connections = report.requests.slice(record.firstRequest).filter(request => request.type === 'connect' && request.connected);
    assert.ok(connections.some(request => /(^|\.)youtube\.com$/.test(request.host)));
    assert.ok(connections.some(request => /(^|\.)googlevideo\.com$/.test(request.host)));
    assert.ok(report.children.filter(child => child.extractor === 'youtube').every(child => child.proxyIsPrivateLoopback));
  });
  fixture = await startMediaFixture({ streamDirectory: resolve('artifacts', 'public-stream-fixture') });
  for (const manifest of ['master.m3u8', 'vod.mpd']) await operation(`${manifest} inspect and download through shared transport proxy`, async record => {
    const url = `${fixture.origin}/stream/${manifest}`;
    record.info = await media.inspect(url, { signal: AbortSignal.timeout(50000) });
    const result = await media.download(url, join(directory, manifest.endsWith('mpd') ? 'dash' : 'hls', 'public-stream.mkv'), { quality: '240', signal: AbortSignal.timeout(90000) });
    record.file = await probe(result.path);
    const throughProxy = report.requests.slice(record.firstRequest).filter(request => request.type === 'forward');
    assert.ok(throughProxy.some(request => request.path.endsWith(manifest)));
    assert.ok(throughProxy.some(request => /\.(?:ts|m4s)$/.test(request.path)));
    record.forwardRequests = throughProxy.length;
  });
} catch (error) { report.error = error.message; }
finally {
  await media?.close(); setTransportFetch((input, init) => globalThis.fetch(input, init)); await network?.close(); await fixture?.close();
  for (const socket of sockets) socket.destroy(); if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  report.completedAt = new Date().toISOString(); report.passed = !report.error && report.operations.length === 3 && report.operations.every(operation => operation.passed);
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(directory, 'result.json')}`);
  if (!report.passed) process.exitCode = 1;
}
