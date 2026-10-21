import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { youtubeUrl } from '../browser/extension/media-policy.mjs';
import { normalizeMediaUrl } from '../src/media.mjs';

const context = { URL };
for (const file of ['i18n-data.js','i18n-core.js','media-targets.js']) vm.runInNewContext(await readFile(new URL('../browser/extension/' + file, import.meta.url), 'utf8'), context);
const { mediaTarget, youtubePageUrl, excludedPage, httpUrl, mediaTargetLabel } = context.sahmMediaTargets;

test('video overlay accepts direct HTTP media, resolves sources and excludes embedded credentials', () => {
  const target = mediaTarget({ pageUrl: 'https://example.com/watch', sources: ['blob:https://example.com/key', '/media/file.mp4?q=1'] });
  assert.equal(target.kind, 'direct');
  assert.equal(target.url, 'https://example.com/media/file.mp4?q=1');
  assert.equal(httpUrl('https://user:secret@example.com/file.mp4'), null);
  assert.equal(mediaTarget({ pageUrl: 'https://example.com/', sources: ['javascript:alert(1)', 'data:video/mp4;a', ''] }).kind, 'unsupported');
});

test('YouTube watch, Shorts, short links and embed resolve to canonical page rather than media fragments', () => {
  for (const url of ['https://www.youtube.com/watch?v=BaW_jenozKc&t=9', 'https://m.youtube.com/shorts/BaW_jenozKc', 'https://youtu.be/BaW_jenozKc', 'https://www.youtube-nocookie.com/embed/BaW_jenozKc']) {
    assert.equal(youtubePageUrl(url), 'https://www.youtube.com/watch?v=BaW_jenozKc');
    const target = mediaTarget({ pageUrl: url, sources: ['blob:https://www.youtube.com/123', 'https://rr.googlevideo.com/videoplayback?token=secret'] });
    assert.equal(target.kind, 'youtube');
    assert.equal(target.url, 'https://www.youtube.com/watch?v=BaW_jenozKc');
  }
  assert.equal(youtubePageUrl('https://youtube.com.evil.example/watch?v=BaW_jenozKc'), null);
  assert.equal(youtubePageUrl('https://youtube.com/watch?v=invalid'), null);
});

test('DOM targets do not treat DRM, blob, manifests or raw YouTube tracks as direct video files', () => {
  for (const sources of [['blob:https://example.com/123'], ['https://example.com/live.m3u8'], ['https://example.com/live.mpd'], ['https://rr.googlevideo.com/videoplayback']]) {
    assert.equal(mediaTarget({ pageUrl: 'https://example.com/', sources }).kind, 'unsupported');
  }
  assert.equal(mediaTarget({ pageUrl: 'https://youtube.com/watch?v=BaW_jenozKc', sources: [], encrypted: true }).kind, 'unsupported');
});

test('discovered media labels identify the type and size without exposing signed URL query parameters', () => {
  const label = mediaTargetLabel({ url: 'https://example.com/folder/video%20clip.mp4?token=signed-secret', kind: 'direct', mime: 'video/mp4', bytes: 1048576 });
  assert.ok(label.includes('MP4'));
  assert.ok(label.includes('video clip.mp4'));
  assert.equal(label.includes('signed-secret'), false);
  assert.ok(mediaTargetLabel({ url: 'https://example.com/master.mpd', kind: 'stream', requiresSession: true }).includes('DASH'));
  assert.ok(mediaTargetLabel({ url: 'https://example.com/master.m3u8', kind: 'stream', requiresSession: true }).includes('يتطلب جلسة'));
});

test('excluded domains match an exact host or its subdomains without suffix confusion', () => {
  assert.equal(excludedPage('https://media.example.com/watch', ['example.com']), true);
  assert.equal(excludedPage('https://example.com/watch', ['.EXAMPLE.com']), true);
  assert.equal(excludedPage('https://notexample.com/watch', ['example.com']), false);
  assert.equal(excludedPage('https://example.com.evil.com/watch', ['example.com']), false);
  assert.equal(excludedPage('chrome://extensions', []), true);
});
test('overlay, service worker and desktop normalize the same supported YouTube addresses', () => {
  const id = 'jNQXAC9IVRw', canonical = 'https://www.youtube.com/watch?v=' + id;
  for (const value of [canonical, 'https://music.youtube.com/watch?v=' + id, 'https://youtube-nocookie.com/embed/' + id, 'https://youtu.be/' + id + '/', 'https://www.youtube.com/watch/?v=' + id, 'https://m.youtube.com/shorts/' + id]) {
    assert.equal(youtubePageUrl(value), canonical); assert.equal(youtubeUrl(value), canonical); assert.equal(normalizeMediaUrl(value), canonical);
  }
  for (const value of ['http://www.youtube.com/watch?v=' + id, 'https://www.youtube.com:8443/watch?v=' + id, 'https://studio.youtube.com/watch?v=' + id, 'https://www.youtube.com.evil.invalid/watch?v=' + id]) {
    assert.equal(youtubePageUrl(value), null); assert.equal(youtubeUrl(value), null); assert.throws(() => normalizeMediaUrl(value));
  }
});
