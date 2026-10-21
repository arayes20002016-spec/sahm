import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest } from '../browser/protocol.mjs';
import { directMediaUrl, mediaSenderAllowed, qualityOptions, youtubeUrl } from '../browser/extension/media-policy.mjs';
import { DEFAULT_SETTINGS } from '../browser/extension/capture-policy.mjs';
import { RequestObserver } from '../browser/extension/request-observer.mjs';
import { sendToBridge } from '../browser/native-host.mjs';
import { startBrowserBridge } from '../src/browser-bridge.mjs';
import { DownloadManager } from '../src/manager.mjs';

const youtube = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
function mediaRequest(overrides = {}) {
  return { v: 1, type: 'media-enqueue', requestId: 'video:test:1', source: 'video-overlay', kind: 'youtube', quality: '720', url: youtube, expiresAt: Date.now() + 8000, ...overrides };
}

test('media protocol canonicalizes single videos and rejects unsafe sources, formats and credential transfer', () => {
  assert.equal(youtubeUrl('https://youtu.be/jNQXAC9IVRw?t=3'), youtube);
  assert.equal(youtubeUrl('https://www.youtube-nocookie.com/embed/jNQXAC9IVRw'), youtube);
  for (const url of ['https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=test', 'http://youtu.be/jNQXAC9IVRw', 'https://user:secret@youtu.be/jNQXAC9IVRw']) assert.equal(youtubeUrl(url), null);
  for (const url of ['blob:https://example.com/id', 'https://r1.googlevideo.com/videoplayback', 'https://example.com/stream.m3u8']) assert.equal(directMediaUrl(url), null);
  assert.equal(validateRequest(mediaRequest()).quality, '720');
  assert.throws(() => validateRequest(mediaRequest({ quality: 'arbitrary-command' })));
  assert.throws(() => validateRequest(mediaRequest({ requestContext: { method: 'GET', headers: { cookie: 'private' } } })));
  assert.throws(() => validateRequest(mediaRequest({ kind: 'direct', url: 'https://example.com/file.mp4', requestContext: { method: 'GET', headers: { cookie: 'private' } } })));
  assert.equal(validateRequest(mediaRequest({ kind: 'direct', url: 'https://example.com/file.mp4', requestContext: { method: 'GET', headers: { cookie: 'private' } }, sessionApproved: true })).usesCredentials, true);
  for (const suffix of ['m3u8', 'mpd']) {
    const stream = mediaRequest({ kind: 'stream', url: `https://cdn.example.com/video.${suffix}?id=public`, quality: '240' });
    assert.equal(validateRequest(stream).kind, 'stream');
    assert.equal(validateRequest({ ...stream, type: 'media-info' }).quality, '240');
    assert.throws(() => validateRequest({ ...stream, requestContext: { method: 'GET', headers: {} } }));
  }
  for (const url of ['file:///C:/private.m3u8', 'https://user:password@cdn.example.com/video.mpd', 'https://cdn.example.com/video.m3u8#fragment', 'https://cdn.example.com/page.html']) assert.throws(() => validateRequest(mediaRequest({ kind: 'stream', url })));
});

test('stream media uses the durable media callback without a file preflight or credential transfer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-stream-bridge-'));
  let accepted = 0;
  const bridge = await startBrowserBridge({ dataDirectory: directory, canCapture: async () => true,
    onDownload: async () => { throw new Error('Wrong download path'); },
    onMediaDownload: async request => { accepted++; assert.equal(request.url, 'https://cdn.example.com/public.m3u8'); return { id: 'stream-job' }; },
    onMediaInfo: async () => ({ title: 'Public video', qualities: ['best', '240', 'arbitrary'], privateField: 'not exposed' }),
    preflight: async () => { throw new Error('Must not probe a manifest as a file'); },
  });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = JSON.parse(await readFile(join(directory, 'browser-integration/connection.json'), 'utf8'));
  const request = mediaRequest({ kind: 'stream', url: 'https://cdn.example.com/public.m3u8', quality: '240' });
  const info = await sendToBridge(config, { ...request, type: 'media-info', requestId: 'stream:info' });
  assert.deepEqual(info.qualities, ['best', '240']);
  assert.equal(info.privateField, undefined);
  const first = await sendToBridge(config, request);
  const duplicate = await sendToBridge(config, { ...request, expiresAt: Date.now() + 8000 });
  assert.equal(first.durable, true);
  assert.equal(first.jobId, duplicate.jobId);
  assert.equal(accepted, 1);
});

test('bridge preserves chosen formats, sanitizes catalogues and detects conflicting reuse of a media receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-selection-bridge-'));
  const track = 'a-' + 'a'.repeat(24), calls = [];
  const options = { containers: [{ id: 'mp4', label: 'MP4', privateUrl: 'secret' }], audioTracks: [{ id: 'default', label: 'الصوت الافتراضي' }, { id: track, label: 'العربية' }], combinations: [{ container: 'mp4', quality: '720', audioTrack: track, estimatedBytes: 123, approximate: true, signedUrl: 'secret' }] };
  const bridge = await startBrowserBridge({ dataDirectory: directory, canCapture: () => true, onDownload: async () => { throw new Error('Wrong route'); }, onMediaDownload: async request => { calls.push(request); return { id: 'selected-media' }; }, onMediaInfo: async () => ({ qualities: ['best', '720'], mediaOptions: options }) });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = JSON.parse(await readFile(join(directory, 'browser-integration/connection.json'), 'utf8'));
  const info = await sendToBridge(config, mediaRequest({ type: 'media-info', requestId: 'selected:info' }));
  assert.ok(!JSON.stringify(info).includes('secret')); assert.equal(info.mediaOptions.combinations[0].estimatedBytes, 123);
  const request = mediaRequest({ requestId: 'selected:enqueue', container: 'mp4', audioTrack: track });
  assert.equal((await sendToBridge(config, request)).durable, true);
  assert.equal(calls[0].container, 'mp4'); assert.equal(calls[0].audioTrack, track);
  assert.equal((await sendToBridge(config, request)).jobId, 'selected-media'); assert.equal(calls.length, 1);
  assert.equal((await sendToBridge(config, { ...request, container: 'mkv' })).ok, false); assert.equal(calls.length, 1);
});

test('content messages require the installed extension, allowed frame, enabled setting and site', () => {
  const sender = { id: 'extension', tab: { id: 2, incognito: false }, frameId: 0, url: 'https://example.com/watch' };
  const settings = { ...DEFAULT_SETTINGS, enabled: true };
  assert.equal(mediaSenderAllowed(sender, 'extension', settings), true);
  for (const bad of [{ ...sender, id: 'other' }, { ...sender, tab: undefined }, { ...sender, tab: { id: 2, incognito: true } }, { ...sender, url: 'file:///private' }]) assert.equal(mediaSenderAllowed(bad, 'extension', settings), false);
  assert.equal(mediaSenderAllowed(sender, 'extension', { ...settings, showVideoButton: false }), false);
  assert.equal(mediaSenderAllowed(sender, 'extension', { ...settings, excludedDomains: ['example.com'] }), false);
  assert.deepEqual(qualityOptions(['best', '720', '720', 'unsafe']), [{ id: 'best', label: 'أفضل جودة' }, { id: '720', label: 'حتى 720p' }]);
});

test('a video click can reuse only headers observed in the exact tab and frame', () => {
  const observer = new RequestObserver();
  const details = { requestId: 'media:1', method: 'GET', url: 'https://cdn.example.com/video.mp4', tabId: 8, frameId: 2 };
  const settings = { ...DEFAULT_SETTINGS, enabled: true, allowSession: true };
  observer.beforeRequest(details, settings);
  observer.beforeHeaders({ ...details, requestHeaders: [{ name: 'Cookie', value: 'local-session' }] }, settings);
  assert.equal(observer.mediaContext(details.url, { tab: { id: 9 }, frameId: 2 }), undefined);
  assert.equal(observer.mediaContext(details.url, { tab: { id: 8 }, frameId: 0 }), undefined);
  assert.equal(observer.mediaContext(details.url, { tab: { id: 8 }, frameId: 2 }).requestContext.headers.cookie, 'local-session');
});

test('media bridge streams the direct video once, persists its ACK and rejects HTML or disabled inspection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-bridge-'));
  const payload = Buffer.alloc(32768, 91);
  let requests = 0, inspections = 0, allowed = true;
  const server = createServer((request, response) => {
    requests++;
    response.setHeader('Content-Type', request.url === '/login' ? 'text/html' : 'video/webm');
    response.setHeader('Content-Length', payload.length);
    response.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = await new DownloadManager(directory, join(directory, 'files')).init();
  const bridge = await startBrowserBridge({
    dataDirectory: directory, canCapture: () => allowed,
    onDownload: (data, { preparedResponse }) => manager.addPrepared({ ...data, source: 'browser', externalId: data.browserRequestId }, preparedResponse),
    onMediaInfo: async () => { inspections++; return { title: 'فيديو', qualities: ['best', '720'], privateField: 'discard' }; },
  });
  t.after(async () => { await bridge.close(); await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const config = JSON.parse(await readFile(join(directory, 'browser-integration/connection.json'), 'utf8'));
  const url = `http://127.0.0.1:${server.address().port}/video.webm`;
  const request = mediaRequest({ kind: 'direct', url, title: 'فيديو التجربة' });
  const ack = await sendToBridge(config, request);
  assert.equal(ack.ok, true); assert.equal(ack.durable, true);
  for (let i = 0; i < 100 && manager.list()[0]?.status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const job = manager.list()[0];
  assert.equal(job.status, 'complete', job.error);
  assert.deepEqual(await readFile(job.path), payload);
  assert.equal(requests, 1, 'the inspected response must become the download');
  assert.equal((await sendToBridge(config, { ...request, expiresAt: Date.now() + 8000 })).jobId, job.id);
  assert.equal(requests, 1);
  assert.equal((await sendToBridge(config, mediaRequest({ requestId: 'video:login', kind: 'direct', url: url.replace('/video.webm', '/login') }))).ok, false);
  assert.equal(manager.list().length, 1);
  const info = await sendToBridge(config, mediaRequest({ type: 'media-info', requestId: 'video:info' }));
  assert.equal(info.ok, true); assert.deepEqual(info.qualities, ['best', '720']); assert.equal(info.privateField, undefined);
  allowed = false;
  assert.equal((await sendToBridge(config, mediaRequest({ type: 'media-info', requestId: 'video:disabled' }))).ok, false);
  assert.equal(inspections, 1, 'policy must run before extractor/network access');
});

test('asynchronous capture approval cannot exceed two concurrent media inspections and close aborts them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-concurrency-'));
  let started = 0;
  const bridge = await startBrowserBridge({ dataDirectory: directory, onDownload: async () => ({ id: 'unused' }), canCapture: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return true; },
    onMediaInfo: (_request, { signal }) => { started++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); },
  });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const config = JSON.parse(await readFile(join(directory, 'browser-integration/connection.json'), 'utf8'));
  const calls = [1, 2, 3].map(id => sendToBridge(config, mediaRequest({ type: 'media-info', requestId: `video:concurrent:${id}` })).catch(() => null));
  for (let attempt = 0; attempt < 100 && started < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(started, 2);
  await bridge.close();
  await Promise.all(calls);
});
