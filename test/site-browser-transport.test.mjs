import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkService } from '../src/network.mjs';
import { QuotaStore } from '../src/quota.mjs';
import { gzipSync, brotliCompressSync } from 'node:zlib';
const { SiteBrowserTransport, requestBody } = createRequire(import.meta.url)('../electron/site-browser-transport.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function wait(read) { for (let i = 0; i < 150; i++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('transport fixture did not settle'); }
function fixture(fetch, extra = {}) {
  const debug = new EventEmitter(), commands = [], cookies = [], cookieWrites = [];
  debug.isAttached = () => false; debug.attach = () => {};
  debug.sendCommand = async (method, params) => { commands.push({ method, params }); return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : {}; };
  const window = new EventEmitter(); window.webContents = { debugger: debug };
  const record = { origin: 'https://example.com', rootUrl: 'https://example.com/', controller: new AbortController(), session: { cookies: { get: async () => cookies, set: async value => cookieWrites.push(value) } }, rendering: { requestTimeout: 1000 } };
  const network = { browserFetch: fetch, requiresBrowserTransport: url => new URL(url).origin === record.origin, ...extra };
  const transport = new SiteBrowserTransport({ network, record });
  const request = (overrides = {}) => debug.emit('message', {}, 'Fetch.requestPaused', { requestId: 'one', networkId: 'network-one', frameId: 'main', resourceType: 'Document', request: { url: record.rootUrl, method: 'GET', headers: {}, ...overrides } });
  return { debug, commands, window, record, transport, request, cookies, cookieWrites };
}
test('browser transport is enabled only for exact configured origins and enabled PFX profiles', async () => {
  const network = new NetworkService();
  await network.configure({ authentication: { servers: [{ origin: 'http://example.com:8080', scheme: 'ntlm', currentAccount: true }] }, clientCertificates: [{ origin: 'https://example.com:8443', pfxFile: join(tmpdir(), 'fixture.pfx'), enabled: true }, { origin: 'https://disabled.example.com', pfxFile: join(tmpdir(), 'fixture2.pfx'), enabled: false }] });
  try {
    assert.equal(network.requiresBrowserTransport('http://example.com:8080/path'), true);
    assert.equal(network.requiresBrowserTransport('https://example.com:8443/path'), true);
    for (const url of ['http://example.com/', 'https://example.com/', 'https://example.com:8444/', 'https://disabled.example.com/', 'https://sub.example.com:8443/']) assert.equal(network.requiresBrowserTransport(url), false);
  } finally { await network.close(); }
});
test('CDP retains separate Set-Cookie fields, exact raw POST bytes, status and redirect without following it', async () => {
  let received;
  const headers = new Headers({ location: '/next' }); headers.append('set-cookie', 'a=one; HttpOnly'); headers.append('set-cookie', 'b=two');
  const f = fixture(async (url, init) => { received = { url, init }; return new Response(null, { status: 302, headers }); });
  await f.transport.attach(f.window);
  f.request({ method: 'POST', headers: { Host: 'wrong', Cookie: 'a=one', 'Proxy-Authorization': 'secret', 'Content-Length': '999' }, postDataEntries: [{ bytes: Buffer.from([0, 255, 42]).toString('base64') }], hasPostData: true });
  await wait(() => f.commands.some(item => item.method === 'Fetch.fulfillRequest'));
  assert.deepEqual(received.init.body, Buffer.from([0, 255, 42])); assert.equal(received.init.redirect, 'manual');
  assert.equal(received.init.headers.get('cookie'), 'a=one'); assert.equal(received.init.headers.has('proxy-authorization'), false); assert.equal(received.init.headers.has('host'), false);
  const delivered = f.commands.find(item => item.method === 'Fetch.fulfillRequest').params;
  assert.equal(delivered.responseCode, 302); assert.equal(delivered.responseHeaders.filter(item => item.name === 'Set-Cookie').length, 2);
  assert.equal(f.record.rendering.status, 302); f.transport.close();
});
test('an unexpected origin is continued without dispatching configured account or identity', async () => {
  const f = fixture(async () => { throw new Error('must not dispatch'); }); await f.transport.attach(f.window);
  f.request({ url: 'https://else.example.com/' }); await tick();
  assert.ok(f.commands.some(item => item.method === 'Fetch.continueRequest')); assert.ok(!f.commands.some(item => item.method === 'Fetch.fulfillRequest')); f.transport.close();
});
test('stopping a renderer request aborts its native transport and releases all pending work', async () => {
  let signal;
  const f = fixture(async (_, init) => { signal = init.signal; return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); });
  await f.transport.attach(f.window); f.request(); await wait(() => signal);
  f.debug.emit('message', {}, 'Network.loadingFailed', { requestId: 'network-one' });
  await wait(() => f.commands.some(item => item.method === 'Fetch.failRequest')); assert.equal(signal.aborted, true); f.transport.close();
  assert.equal(f.debug.listenerCount('message'), 0);
});
test('a resource beyond the renderer bound is canceled and cannot be reported as a successful document', async () => {
  let canceled = false;
  const f = fixture(async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-length': String(33 * 1024 ** 2) } }));
  await f.transport.attach(f.window); f.request(); await wait(() => f.commands.some(item => item.method === 'Fetch.failRequest'));
  assert.equal(canceled, true); assert.equal(f.record.rendering.failure.code, 'SITE_BROWSER_AUTH_TRANSPORT'); assert.ok(!f.commands.some(item => item.method === 'Fetch.fulfillRequest')); f.transport.close();
});
test('incomplete file uploads and oversized bodies are refused before an authenticated POST is sent', () => {
  assert.throws(() => requestBody({ hasPostData: true }), { code: 'SITE_BROWSER_UPLOAD' });
  assert.throws(() => requestBody({ postDataEntries: [{}] }), { code: 'SITE_BROWSER_UPLOAD' });
  assert.throws(() => requestBody({ postData: 'x'.repeat(4 * 1024 ** 2 + 1) }), { code: 'SITE_BROWSER_UPLOAD' });
  const entry = { bytes: Buffer.alloc(3 * 1024 ** 2).toString('base64') };
  assert.throws(() => requestBody({ postDataEntries: [entry, entry] }), { code: 'SITE_BROWSER_UPLOAD' });
});
test('protected static reads preserve HttpOnly/SameSite cookies without accepting another cookie domain', async () => {
  let headers;
  const returned = new Headers(); returned.append('set-cookie', 'next=value; Secure; HttpOnly; Path=/; SameSite=Strict'); returned.append('set-cookie', 'wrong=value; Domain=other.invalid; Path=/');
  const f = fixture(async (_, init) => { headers = init.headers; return new Response('resource', { headers: returned }); });
  f.cookies.push({ name: 'approved', value: 'cookie' });
  const response = await f.transport.fetchResource(new URL('https://example.com/resource'), { signal: new AbortController().signal });
  assert.equal(await response.text(), 'resource'); assert.equal(headers.get('cookie'), 'approved=cookie');
  assert.equal(f.cookieWrites.length, 1); assert.equal(f.cookieWrites[0].httpOnly, true); assert.equal(f.cookieWrites[0].sameSite, 'strict'); f.transport.close();
});
test('intercepted renderer bytes pass through the durable quota exactly once', async () => {
  const quota = await new QuotaStore(await mkdtemp(join(tmpdir(), 'sahm-browser-quota-'))).init();
  await quota.configure({ enabled: true, limitBytes: 3, periodHours: 1 });
  const f = fixture(async () => new Response('1234'), { quota }); await f.transport.attach(f.window); f.request();
  await wait(() => f.commands.some(item => item.method === 'Fetch.failRequest'));
  assert.equal(quota.snapshot().usedBytes, 3); assert.equal(f.record.rendering.failure.code, 'DOWNLOAD_QUOTA_EXCEEDED'); f.transport.close();
});
test('browser responses decode native compression and preserve multiple Set-Cookie headers independently', async () => {
  for (const [encoding, encode] of [['gzip', gzipSync], ['br', brotliCompressSync]]) {
    const encoded = encode(Buffer.from('protected API response'));
    const network = new NetworkService({ windowsFetch: async () => {
      const headers = new Headers({ 'content-encoding': encoding, 'content-length': String(encoded.length), 'content-type': 'text/plain' });
      headers.append('set-cookie', 'session=one; Secure; HttpOnly'); headers.append('set-cookie', 'visible=two; Secure');
      return new Response(encoded, { headers });
    } });
    await network.configure({ authentication: { servers: [{ origin: 'https://example.com', scheme: 'ntlm', currentAccount: true }] } });
    try {
      const response = await network.browserFetch('https://example.com/api');
      assert.equal(await response.text(), 'protected API response'); assert.equal(response.headers.has('content-encoding'), false); assert.equal(response.headers.has('content-length'), false);
      assert.deepEqual(response.headers.getSetCookie(), ['session=one; Secure; HttpOnly', 'visible=two; Secure']);
    } finally { await network.close(); }
  }
});
