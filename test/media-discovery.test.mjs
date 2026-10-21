import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../browser/extension/capture-policy.mjs';
import { streamMediaUrl } from '../browser/extension/media-policy.mjs';
import { MEDIA_TTL, REQUEST_TTL, RequestObserver } from '../browser/extension/request-observer.mjs';

const settings = { ...DEFAULT_SETTINGS, enabled: true };
const sender = { tab: { id: 5 }, frameId: 0, documentId: 'document-a' };

function observe(observer, { id = 'request-a', url = 'https://cdn.example.org/video.mp4', tabId = 5, frameId = 0, documentId = 'document-a', method = 'GET', status = 200, mime = 'video/mp4', cookie = false } = {}) {
  const details = { requestId: id, url, tabId, frameId, documentId, method };
  observer.beforeRequest(details, settings);
  observer.beforeHeaders({ ...details, requestHeaders: cookie ? [{ name: 'Cookie', value: 'sensitive-session-value' }] : [] }, settings);
  observer.responseHeaders({ ...details, statusCode: status, responseHeaders: [{ name: 'Content-Type', value: mime }, { name: 'Content-Length', value: '1000000' }] });
}

test('network media discovery remains in the exact tab, frame and document and returns no session headers', () => {
  const observer = new RequestObserver();
  observe(observer, { cookie: true });
  observe(observer, { id: 'other-frame', url: 'https://cdn.example.org/frame.mp4', frameId: 1, documentId: 'frame-document' });
  observe(observer, { id: 'other-tab', url: 'https://cdn.example.org/tab.mp4', tabId: 8 });
  const candidates = observer.mediaCandidates(sender, settings);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'direct');
  assert.equal(candidates[0].requiresSession, true);
  assert.equal(candidates[0].bytes, 1000000);
  assert.equal(JSON.stringify(candidates).includes('sensitive-session-value'), false);
  assert.equal(Object.hasOwn(candidates[0], 'headers'), false);
  assert.equal(observer.mediaCandidates({ ...sender, documentId: 'new-navigation' }, settings).length, 0);
  assert.equal(observer.mediaContext(candidates[0].url, { ...sender, documentId: 'new-navigation' }), undefined);
  assert.equal(observer.mediaCandidates(sender, settings, { allFrames: true }).length, 2);
});

test('discovery includes public manifest URLs while excluding partial segments, non-media responses and unsafe protocols', () => {
  const observer = new RequestObserver();
  observe(observer, { id: 'hls', url: 'https://cdn.example.org/master.m3u8?token=public', mime: 'application/vnd.apple.mpegurl' });
  observe(observer, { id: 'dash', url: 'https://cdn.example.org/master.mpd', mime: 'application/dash+xml' });
  observe(observer, { id: 'segment', url: 'https://cdn.example.org/part.ts', mime: 'video/mp2t' });
  observe(observer, { id: 'm4s', url: 'https://cdn.example.org/part.m4s', mime: 'video/iso.segment' });
  observe(observer, { id: 'html', url: 'https://cdn.example.org/page', mime: 'text/html' });
  observe(observer, { id: 'post', url: 'https://cdn.example.org/post.mp4', method: 'POST' });
  observe(observer, { id: 'not-found', url: 'https://cdn.example.org/404.mp4', status: 404 });
  observe(observer, { id: 'yt-track', url: 'https://rr.googlevideo.com/videoplayback', mime: 'video/mp4' });
  assert.deepEqual(observer.mediaCandidates(sender, settings).map(item => item.kind), ['stream', 'stream']);
  for (const url of ['file:///c:/video.m3u8', 'blob:https://example.org/key', 'https://user:pass@example.org/video.mpd', 'https://example.org/video.mpd#fragment', 'https://example.org/no-manifest', 'https://rr.googlevideo.com/video.m3u8']) assert.equal(streamMediaUrl(url), null);
  assert.equal(streamMediaUrl('http://127.0.0.1:8123/master.m3u8?part=1'), 'http://127.0.0.1:8123/master.m3u8?part=1');
});

test('network discovery obeys settings and domain exclusions, expires, stays bounded and clears with request state', () => {
  let now = 0;
  const observer = new RequestObserver({ now: () => now });
  for (let index = 0; index < 70; index++) observe(observer, { id: `video-${index}`, url: `https://cdn.example.org/video-${index}.mp4` });
  assert.equal(observer.mediaCandidates(sender, settings).length, 64);
  assert.equal(observer.mediaCandidates(sender, { ...settings, enabled: false }).length, 0);
  assert.equal(observer.mediaCandidates(sender, { ...settings, showVideoButton: false }).length, 0);
  assert.equal(observer.mediaCandidates(sender, { ...settings, excludedDomains: ['example.org'] }).length, 0);
  now = REQUEST_TTL + 1;
  observer.prune();
  assert.equal(observer.requests.size, 0, 'Request headers and bodies expire before public candidate metadata');
  assert.equal(observer.mediaCandidates(sender, settings).length, 64);
  now = MEDIA_TTL + 1;
  assert.equal(observer.mediaCandidates(sender, settings).length, 0);
  observe(observer);
  observer.clear();
  assert.equal(observer.requests.size, 0);
  assert.equal(observer.mediaCandidates(sender, settings).length, 0);
});

test('navigation clears old page media while preserving a current navigation redirect chain', () => {
  const observer = new RequestObserver();
  observe(observer);
  observe(observer, { id: 'frame-video', url: 'https://cdn.example.org/frame.mp4', frameId: 1 });
  observe(observer, { id: 'other-tab-video', url: 'https://cdn.example.org/other.mp4', tabId: 6 });
  const navigation = { requestId: 'navigation', type: 'main_frame', url: 'https://page.example.org/new', method: 'GET', tabId: 5, frameId: 0 };
  observer.beforeRequest(navigation, settings);
  assert.equal(observer.mediaCandidates(sender, settings, { allFrames: true }).length, 0);
  assert.equal(observer.mediaCandidates({ ...sender, tab: { id: 6 } }, settings).length, 1);
  observer.beforeRequest({ ...navigation, url: 'https://page.example.org/redirected' }, settings);
  assert.equal(observer.requests.get('navigation').urls.has(navigation.url), true);
  assert.equal(observer.requests.get('navigation').urls.has('https://page.example.org/redirected'), true);
});
