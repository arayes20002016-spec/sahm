import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { validateRequest } from '../browser/protocol.mjs';
import { sendToBridge } from '../browser/native-host.mjs';
import { DEFAULT_SETTINGS, captureDecision, handoffDownload } from '../browser/extension/capture-policy.mjs';
import { MAX_BODY_BYTES, REQUEST_TTL, RequestObserver } from '../browser/extension/request-observer.mjs';
import { prepareBrowserDownload, startBrowserBridge } from '../src/browser-bridge.mjs';

const enabled = { ...DEFAULT_SETTINGS, enabled: true, allowSession: true, allowPost: true };
const item = { id: 42, url: 'https://example.com/export', finalUrl: 'https://example.com/export', filename: 'export.zip', mime: 'application/zip', totalBytes: 4, state: 'in_progress', danger: 'safe', startTime: '2026-10-18T12:00:00Z' };
const context = { method: 'POST', headers: { cookie: 'sid=private-cookie', 'x-csrf-token': 'private-csrf', 'content-type': 'application/x-www-form-urlencoded', referer: 'https://example.com/account', origin: 'https://example.com' }, bodyBase64: Buffer.from('file=42&csrf=private-body').toString('base64') };
function request(overrides = {}) {
  return { v: 1, type: 'enqueue', requestId: 'download:session:42', expiresAt: Date.now() + 8000, source: 'automatic', url: item.url, name: 'export.zip', mime: item.mime, totalBytes: 4, method: 'POST', requestObserved: true, usesCredentials: true, sessionApproved: true, postApproved: true, attachment: true, requestContext: context, ...overrides };
}

function observe(observer, { requestId = 'web:42', url = item.url, method = 'POST', requestBody = { raw: [{ bytes: Uint8Array.from(Buffer.from('file=42&csrf=private-body')).buffer }] }, headers = context.headers, attachment = true } = {}, settings = enabled) {
  const details = { requestId, url, method };
  observer.beforeRequest({ ...details, requestBody }, settings);
  observer.beforeHeaders({ requestId: details.requestId, url: details.url, requestHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })) }, settings);
  observer.responseHeaders({ requestId: details.requestId, url: details.url, statusCode: 200, responseHeaders: attachment ? [{ name: 'Content-Disposition', value: 'attachment; filename=export.zip' }] : [] });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-session-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('wire GET session keeps explicit consent and bounded allowed headers while POST replay is rejected', () => {
  assert.throws(() => validateRequest(request()), /POST replay is disabled/);
  const get = request({ method: 'GET', requestContext: { method: 'GET', headers: { cookie: context.headers.cookie } } });
  assert.equal(validateRequest(get).method, 'GET');
  for (const change of [{ sessionApproved: false }, { requestObserved: false }, { requestContext: undefined }, { requestContext: { method: 'GET', headers: { host: 'evil' } } }]) assert.throws(() => validateRequest({ ...get, ...change }));
});

test('observer does not read or retain POST bodies, cookie values or CSRF headers', () => {
  let now = Date.now(); const observer = new RequestObserver({ now: () => now });
  const details = { requestId: 'private', method: 'POST', url: item.url, get requestBody() { throw new Error('Must not inspect request body'); } };
  observer.beforeRequest(details, enabled);
  observer.beforeHeaders({ requestId: details.requestId, url: details.url, requestHeaders: Object.entries(context.headers).map(([name,value])=>({name,value})) }, enabled);
  observer.responseHeaders({ requestId: details.requestId, url: details.url, statusCode: 200, responseHeaders: [{name:'Content-Disposition',value:'attachment'}] });
  assert.ok(!JSON.stringify([...observer.requests.values()]).includes('private-cookie'));
  const found=observer.take(item); assert.equal(found.requestContext,undefined);assert.equal(found.bodyAvailable,false);
  assert.equal(captureDecision(item,enabled,found),'browser-complete');
  observe(observer); now += REQUEST_TTL + 1; observer.prune(); assert.equal(observer.take(item),undefined);
});

test('POST attachment adoption does not require replayable forms or upload bodies', () => {
  const observer = new RequestObserver();
  for(const requestBody of [null,{raw:[{file:'C:\\private.txt'}]},{raw:[{bytes:new Uint8Array(MAX_BODY_BYTES+1).buffer}]},{formData:{field:['value']}}]) {
    observe(observer,{requestBody}); const found=observer.take(item);assert.equal(found.requestContext,undefined);assert.equal(captureDecision(item,enabled,found),'browser-complete');
  }
  observe(observer,{headers:{'content-type':'multipart/form-data; boundary=private'}});
  assert.equal(captureDecision(item,enabled,observer.take(item)),'browser-complete');
  observe(observer,{attachment:false});assert.equal(captureDecision(item,enabled,observer.take(item)),'unsupported-request');
});

test('ambiguous requests stay in browser and redirected GET keeps only destination session', () => {
  const observer=new RequestObserver();observe(observer,{requestId:'first'});observe(observer,{requestId:'second'});assert.equal(observer.take(item),undefined);observer.clear();
  observe(observer,{requestId:'redirect',url:'https://login.example.com/export'});
  observe(observer,{requestId:'redirect',url:item.url,method:'GET',headers:{cookie:'destination-session'}});
  const found=observer.take({...item,url:'https://login.example.com/export'});assert.equal(found.method,'GET');assert.equal(found.requestContext.headers.cookie,'destination-session');assert.equal(found.requestContext.bodyBase64,undefined);
});

test('observer retains only bounded POST metadata and excludes incognito and disabled sites', () => {
  const observer=new RequestObserver();for(let id=0;id<180;id++)observe(observer,{requestId:'large:'+id});
  assert.ok(observer.requests.size<=128);assert.ok([...observer.requests.values()].reduce((sum,x)=>sum+x.retainedBytes,0)<=4*1024*1024);observer.clear();
  observer.beforeRequest({requestId:'private',url:item.url,method:'POST',incognito:true},enabled);observe(observer,{}, {...enabled,excludedDomains:['example.com']});assert.equal(observer.requests.size,0);
});

test('POST handoff never sends a request or cancels the browser original', async () => {
  const observer=new RequestObserver();observe(observer);let sent=0,cancelled=0;
  const result=await handoffDownload(item,{settings:enabled,observed:observer.take(item),send:async()=>{sent++;},cancel:async()=>{cancelled++;}});
  assert.equal(result.reason,'browser-completing');assert.equal(sent,0);assert.equal(cancelled,0);
});

test('clearing header deadline keeps an accepted session response alive beyond five seconds', async t => {
  const base = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': '4' });
    res.flushHeaders();
    setTimeout(() => res.end('FILE'), 5250).unref();
  });
  const directory = await temporaryDirectory(t);
  let retained;
  const bridge = await startBrowserBridge({ dataDirectory: directory, onDownload: async (data, { preparedResponse }) => { retained = preparedResponse; return { id: 'slow-session-job' }; } });
  t.after(() => bridge.close());
  const config = JSON.parse(await readFile(join(directory, 'browser-integration', 'connection.json'), 'utf8'));
  const response = await sendToBridge(config, request({ requestId: 'slow-session', url: `${base}/file`, method: 'GET', requestContext: { method: 'GET', headers: { cookie: context.headers.cookie } } }));
  assert.equal(response.durable, true);
  assert.equal(await retained.text(), 'FILE');
});

test('GET session preparation rejects changed MIME and cancels its retained response', async () => {
  let cancelled=false;const response=new Response(new ReadableStream({cancel:()=>{cancelled=true;}}),{headers:{'Content-Type':'text/html'}});
  await assert.rejects(prepareBrowserDownload(request({method:'GET',requestContext:{method:'GET',headers:{cookie:'session'}}}),{prepare:async()=>response}),/content-type-changed/);
  assert.equal(cancelled,true);
});
