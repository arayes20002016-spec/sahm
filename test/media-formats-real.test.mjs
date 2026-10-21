import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import { MediaService } from '../src/media.mjs';
import { generateMultiaudioFixture } from './helpers/multiaudio-fixture.mjs';

const run = promisify(execFile);
const runtime = process.env.SAHM_MEDIA_RUNTIME_DIRECTORY || resolve('artifacts/media-runtime');

export async function multiaudioServer(directory) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!name || basename(name) !== name) return response.writeHead(404).end();
    try {
      const bytes = await readFile(join(directory, name));
      requests.push({ name, range: request.headers.range || null });
      const start = Number(/^bytes=(\d+)-/.exec(request.headers.range || '')?.[1] || 0);
      if (start >= bytes.length) return response.writeHead(416).end();
      response.writeHead(start ? 206 : 200, { 'Content-Length': bytes.length - start, 'Accept-Ranges': 'bytes', ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
      response.end(bytes.subarray(start));
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

function power(samples, frequency) {
  let sin = 0, cos = 0;
  for (let index = 0; index < samples.length / 2; index++) {
    const amplitude = samples.readInt16LE(index * 2), angle = 2 * Math.PI * frequency * index / 48000;
    sin += amplitude * Math.sin(angle); cos += amplitude * Math.cos(angle);
  }
  return sin * sin + cos * cos;
}

test('bundled engine selects real HLS/DASH audio languages and produces MP4, MKV and WebM without transcoding', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-format-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await generateMultiaudioFixture(join(directory, 'fixture'), runtime);
  const server = await multiaudioServer(join(directory, 'fixture')); t.after(server.close);
  const service = new MediaService({ runtimeDirectory: runtime, spawnProcess: (command, args, options) => {
    const child = spawn(command, args, options); let stderr = '';
    child.stderr?.on('data', data => { stderr += data; }); child.on('close', code => { if (code) t.diagnostic(stderr.slice(-12000)); }); return child;
  } }); t.after(() => service.close());
  const cases = [
    ['multi.m3u8', 'mp4', 'en', 440], ['multi.m3u8', 'mkv', 'ar', 880],
    ['multi.mpd', 'mp4', 'ar', 880], ['multi.mpd', 'mkv', 'en', 440], ['webm.mpd', 'webm', 'ar', 880],
  ];
  for (const [manifest, container, language, frequency] of cases) {
    const url = server.origin + '/' + manifest, before = server.requests.length;
    const info = await service.inspect(url);
    assert.ok(server.requests.slice(before).every(value => /\.(m3u8|mpd)$/.test(value.name)), 'inspection must not fetch media segments');
    const track = info.mediaOptions.audioTracks.find(value => value.label.startsWith(language));
    assert.ok(track, 'Audio language missing: ' + JSON.stringify(info.mediaOptions));
    const result = await service.download(url, join(directory, `${manifest}-${container}-${language}`, 'video.' + container), { container, quality: '240', audioTrack: track.id });
    assert.ok(result.path.endsWith('.' + container)); assert.ok((await stat(result.path)).size > 10000);
    const probe = JSON.parse((await run(join(runtime, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.path], { windowsHide: true, timeout: 10000 })).stdout);
    const video = probe.streams.filter(value => value.codec_type === 'video'), audio = probe.streams.filter(value => value.codec_type === 'audio');
    assert.equal(video.length, 1); assert.equal(audio.length, 1); assert.equal(video[0].height, 240);
    assert.equal(video[0].codec_name, container === 'webm' ? 'vp9' : 'h264');
    assert.equal(audio[0].codec_name, container === 'webm' ? 'opus' : 'aac');
    assert.ok(Number(probe.format.duration) >= 5.9 && Number(probe.format.duration) < 6.3);
    assert.ok(probe.format.format_name.includes(container === 'mp4' ? 'mp4' : 'matroska'));
    const pcm = (await run(join(runtime, 'ffmpeg.exe'), ['-v', 'error', '-i', result.path, '-ss', '1', '-t', '1', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
    assert.ok(power(pcm, frequency) > power(pcm, frequency === 440 ? 880 : 440) * 100, 'The saved audio must be the selected language track');
    const starts = [video[0], audio[0]].map(value => Number(value.start_time || 0));
    assert.ok(Math.abs(starts[0] - starts[1]) < 0.15, 'Audio/video start times must remain aligned');
    t.diagnostic(JSON.stringify({ manifest, container, language, bytes: result.bytes, duration: probe.format.duration, codecs: [video[0].codec_name, audio[0].codec_name], audioStartDifference: Math.abs(starts[0] - starts[1]) }));
  }
  const url = server.origin + '/multi.mpd', info = await service.inspect(url);
  const audioTrack = info.mediaOptions.audioTracks.find(value => value.label.startsWith('ar')).id;
  const path = join(directory, 'selected-resume', 'video.mp4'), controller = new AbortController();
  let paused = false;
  await assert.rejects(service.download(url, path, { quality: '240', container: 'mp4', audioTrack, signal: controller.signal, maxBytesPerSecond: 30000, onProgress: progress => {
    if (paused || progress.received < 20000) return; paused = true; controller.abort(new Error('Pause selected media'));
  } }), /Pause selected media/);
  assert.ok(paused); const files = await readdir(join(directory, 'selected-resume'));
  const retained = [];
  for (const name of files.filter(value => /^media\./.test(value) && !value.endsWith('.json'))) {
    const bytes = await readFile(join(directory, 'selected-resume', name));
    if (bytes.length) retained.push({ name, bytes });
  }
  assert.ok(retained.length, 'A partial or finished component must survive pause even when progress arrives late');
  const checkpoint = await readFile(join(directory, 'selected-resume', 'media-selection.json'), 'utf8');
  const before = server.requests.length;
  await assert.rejects(service.download(url, path, { quality: '240', container: 'mkv', audioTrack }), /تغيّرت خيارات/);
  assert.equal(await readFile(join(directory, 'selected-resume', 'media-selection.json'), 'utf8'), checkpoint);
  for (const saved of retained) assert.deepEqual(await readFile(join(directory, 'selected-resume', saved.name)), saved.bytes);
  assert.ok(server.requests.slice(before).every(value => /\.(m3u8|mpd)$/.test(value.name)));
  await service.close();
  const restarted = new MediaService({ runtimeDirectory: runtime }); t.after(() => restarted.close());
  const resumed = await restarted.download(url, path, { quality: '240', container: 'mp4', audioTrack });
  assert.ok(resumed.path.endsWith('.mp4')); assert.ok(resumed.bytes > 10000);
  const pcm = (await run(join(runtime, 'ffmpeg.exe'), ['-v', 'error', '-i', resumed.path, '-ss', '1', '-t', '1', '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
  assert.ok(power(pcm, 880) > power(pcm, 440) * 100);
  t.diagnostic('Selected MP4/Arabic survives pause and service restart; incompatible changes preserve partial data and fetch no segments');
});

test('bundled audio extraction produces MP3/M4A, converts Opus and preserves selected language without video requests', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-audio-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await generateMultiaudioFixture(join(directory, 'fixture'), runtime);
  const server = await multiaudioServer(join(directory, 'fixture')); t.after(server.close);
  let service = new MediaService({ runtimeDirectory: runtime }); t.after(() => service.close());
  const cases = [
    ['multi.m3u8', 'mp3', 'ar', 880], ['multi.m3u8', 'm4a', 'en', 440],
    ['multi.mpd', 'mp3', 'en', 440], ['multi.mpd', 'm4a', 'ar', 880], ['webm.mpd', 'm4a', 'ar', 880],
  ];
  for (const [manifest, container, language, frequency] of cases) {
    const url = server.origin + '/' + manifest, info = await service.inspect(url);
    const audioTrack = info.mediaOptions.audioTracks.find(value => value.label.startsWith(language)).id;
    const before = server.requests.length;
    const result = await service.download(url, join(directory, `${manifest}-${container}`, 'audio.' + container), { container, audioTrack });
    const probe = JSON.parse((await run(join(runtime, 'ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.path], { windowsHide: true, timeout: 10000 })).stdout);
    assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_type, 'audio');
    assert.equal(probe.streams[0].codec_name, container === 'mp3' ? 'mp3' : 'aac');
    assert.ok(Number(probe.format.duration) >= 5.9 && Number(probe.format.duration) < 6.4);
    assert.ok(!server.requests.slice(before).some(value => /^video\d+\.ts$/.test(value.name) || /^(?:init|chunk)-stream0[.-]/.test(value.name)), 'Audio-only must fetch no video segments');
    if (manifest === 'multi.mpd' && container === 'm4a') {
      const aac = async (path, track) => (await run(join(runtime, 'ffmpeg.exe'), ['-v', 'error', '-i', path, '-map', track, '-c:a', 'copy', '-f', 'adts', 'pipe:1'], { windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
      assert.deepEqual(await aac(result.path, '0:a:0'), await aac(join(directory, 'fixture', 'source.mp4'), '0:a:1'), 'M4A must copy AAC packets without re-encoding');
    }
    const pcm = (await run(join(runtime, 'ffmpeg.exe'), ['-v', 'error', '-i', result.path, '-ss', '1', '-t', '1', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true, encoding: 'buffer', timeout: 10000, maxBuffer: 1024 * 1024 })).stdout;
    assert.ok(power(pcm, frequency) > power(pcm, frequency === 440 ? 880 : 440) * 100);
    t.diagnostic(JSON.stringify({ manifest, container, language, bytes: result.bytes, codec: probe.streams[0].codec_name, duration: probe.format.duration, noVideoSegments: true }));
  }
  const url = server.origin + '/multi.mpd', info = await service.inspect(url);
  const audioTrack = info.mediaOptions.audioTracks.find(value => value.label.startsWith('ar')).id;
  const target = join(directory, 'resume-audio', 'audio.mp3'), controller = new AbortController();
  let paused = false;
  await assert.rejects(service.download(url, target, { container: 'mp3', audioTrack, signal: controller.signal, maxBytesPerSecond: 10000, onProgress: progress => {
    if (!paused && progress.received > 5000) { paused = true; controller.abort(new Error('Pause audio')); }
  } }), /Pause audio/);
  assert.ok(paused);
  const checkpoint = await readFile(join(directory, 'resume-audio', 'media-selection.json'), 'utf8');
  await assert.rejects(service.download(url, target, { container: 'm4a', audioTrack }), /تغيّرت خيارات/);
  assert.equal(await readFile(join(directory, 'resume-audio', 'media-selection.json'), 'utf8'), checkpoint);
  await service.close(); service = new MediaService({ runtimeDirectory: runtime });
  const result = await service.download(url, target, { container: 'mp3', audioTrack });
  assert.ok(result.bytes > 10000); assert.ok(result.path.endsWith('.mp3'));
  t.diagnostic('MP3/Arabic resumes after abort and service restart; changed format preserves saved checkpoint');
});
