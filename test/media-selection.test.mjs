import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSelectionCatalog, resolveMediaSelection, validateMediaSelection } from '../src/media-selection.mjs';
import { publicMediaOptions } from '../browser/extension/media-selection.mjs';
import { validateRequest } from '../browser/protocol.mjs';

const formats = [
  { format_id: 'h264-360', height: 360, vcodec: 'avc1.4d401e', acodec: 'none', filesize: 1000 },
  { format_id: 'h264-720', height: 720, vcodec: 'h264', acodec: 'none', filesize: 2000 },
  { format_id: 'vp9-1080', height: 1080, vcodec: 'vp9', acodec: 'none', filesize: 3000 },
  { format_id: 'aac-en', height: null, vcodec: 'none', acodec: 'mp4a.40.2', language: 'en', filesize: 400, abr: 128 },
  { format_id: 'aac-ar', vcodec: 'none', acodec: 'aac', language: 'ar', filesize_approx: 500, abr: 128 },
  { format_id: 'opus-ar', vcodec: 'none', acodec: 'opus', language: 'ar', tbr: 64, abr: 64 },
];
const info = { duration: 10, formats };

test('media catalogue filters containers by codecs and lists real audio formats and size estimates', () => {
  const { options } = mediaSelectionCatalog(info);
  assert.deepEqual(options.containers.map(value => value.id), ['auto', 'mp4', 'mkv', 'webm', 'mp3', 'm4a']);
  const english = options.audioTracks.find(value => value.label.startsWith('en'));
  const arabicAAC = options.audioTracks.find(value => value.label.startsWith('ar') && value.label.includes(' · aac'));
  const arabicOpus = options.audioTracks.find(value => value.label.startsWith('ar') && value.label.includes(' · opus'));
  assert.equal(resolveMediaSelection(info, { container: 'mp4', quality: 'best', audioTrack: english.id }).selector, 'h264-720+aac-en');
  assert.equal(resolveMediaSelection(info, { container: 'webm', quality: 'best', audioTrack: arabicOpus.id }).selector, 'vp9-1080+opus-ar');
  assert.throws(() => resolveMediaSelection(info, { container: 'mp4', audioTrack: arabicOpus.id }), /لم تعد/);
  assert.throws(() => resolveMediaSelection(info, { container: 'mp4', audioTrack: 'a-' + '0'.repeat(24) }), /لم تعد/);
  const size = options.combinations.find(value => value.container === 'mp4' && value.quality === '720' && value.audioTrack === english.id);
  assert.equal(size.estimatedBytes, 2400); assert.equal(size.approximate, false);
  assert.equal(options.combinations.find(value => value.container === 'mkv' && value.quality === 'best' && value.audioTrack === arabicAAC.id).approximate, true);
  assert.equal(options.combinations.find(value => value.container === 'webm' && value.quality === 'best' && value.audioTrack === arabicOpus.id).estimatedBytes, 83000);
  assert.ok(!options.combinations.some(value => value.container === 'webm' && value.quality === '360'));
  assert.ok(!options.combinations.some(value => value.container === 'mp4' && value.quality === '1080'));
});

test('media choices preserve sound when only a combined video is available and reject incompatible tracks', () => {
  const combined = { formats: [{ format_id: 'single', vcodec: 'h264', acodec: 'aac', height: 360 }, { format_id: 'silent-hd', vcodec: 'h264', acodec: 'none', height: 720 }] };
  assert.equal(resolveMediaSelection(combined, { container: 'mp4' }).selector, 'single');
  assert.equal(mediaSelectionCatalog(combined).options.audioTracks.length, 2);
  assert.equal(resolveMediaSelection(combined, { container: 'mp3' }).selector, 'single');
  assert.equal(mediaSelectionCatalog(combined).options.combinations.find(value => value.container === 'mp3').requiresVideoDownload, true);
  assert.throws(() => resolveMediaSelection({ formats: [combined.formats[1]] }, { container: 'mp3' }), /لم تعد/);
  assert.equal(resolveMediaSelection({ formats: [combined.formats[1]] }, { container: 'mp4' }).selector, 'silent-hd');
});

test('media options never expose extractor secrets and reject injected identifiers and malformed selections', () => {
  const protectedInfo = { ...info, formats: [...formats.map(value => ({ ...value, url: 'https://secret/?token=private', http_headers: { cookie: 'private' } })), { ...formats[0], format_id: 'bad+id/evil', height: 4320 }, { ...formats[0], format_id: 'drm', has_drm: true, height: 2160 }] };
  const options = mediaSelectionCatalog(protectedInfo).options;
  assert.ok(!JSON.stringify(options).includes('private'));
  assert.ok(!options.combinations.some(value => ['4320', '2160'].includes(value.quality)));
  assert.deepEqual(publicMediaOptions({ ...options, secret: 'private' }), options);
  for (const container of ['avi', '--exec', null, {}, 1]) assert.throws(() => validateMediaSelection({ container }));
  for (const audioTrack of ['ba/b', 'en', '--exec', {}, null]) assert.throws(() => validateMediaSelection({ audioTrack }));
  assert.deepEqual(validateMediaSelection(), { container: 'auto', audioTrack: 'default' });
  assert.deepEqual(mediaSelectionCatalog({ formats: [{ ...formats[0], format_id: 'all' }] }).options.combinations, []);
});

test('browser protocol carries validated media choices and rejects overrides for direct files', () => {
  const request = { v: 1, type: 'media-enqueue', requestId: 'formats:1', expiresAt: Date.now() + 8000, source: 'video-overlay', kind: 'youtube', url: 'https://youtu.be/BaW_jenozKc', quality: '720', container: 'mp4', audioTrack: mediaSelectionCatalog(info).options.audioTracks[1].id };
  const parsed = validateRequest(request); assert.equal(parsed.container, 'mp4'); assert.equal(parsed.audioTrack, request.audioTrack);
  assert.throws(() => validateRequest({ ...request, audioTrack: 'ba[language=en]' }));
  assert.throws(() => validateRequest({ ...request, kind: 'direct', url: 'https://media.example/movie.mp4' }), /Direct/);
});

test('audio-only catalogue prefers separate tracks and never invents video qualities or source URLs', () => {
  const { options } = mediaSelectionCatalog(info), track = options.audioTracks.find(value => value.label.startsWith('en'));
  for (const container of ['mp3', 'm4a']) {
    assert.equal(resolveMediaSelection(info, { container, audioTrack: track.id }).selector, 'aac-en');
    assert.ok(options.combinations.filter(value => value.container === container).every(value => value.quality === 'best' && !value.requiresVideoDownload));
    assert.throws(() => resolveMediaSelection(info, { container, quality: '720' }), /دقة فيديو/);
    assert.throws(() => validateRequest({ v: 1, type: 'media-enqueue', requestId: 'audio:1', expiresAt: Date.now() + 8000, source: 'video-overlay', kind: 'youtube', url: 'https://youtu.be/BaW_jenozKc', quality: '720', container }), /دقة فيديو/);
  }
  assert.deepEqual(mediaSelectionCatalog({ formats: [formats[3]] }).options.containers.map(value => value.id), ['mp3', 'm4a']);
});
