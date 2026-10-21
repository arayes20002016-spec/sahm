import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MediaService, normalizeMediaUrl, normalizeDownloadMediaUrl, getMediaSource, MEDIA_QUALITIES } from '../src/media.mjs';
import { isTransientNetworkError } from '../src/network-retry.mjs';

const video = 'https://www.youtube.com/watch?v=BaW_jenozKc';
function mockProcesses(operation) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 12345; child.exitCode = null;
    child.kill = () => { child.exitCode = 1; child.emit('close', 1); };
    calls.push({ command, args, options, child });
    setImmediate(async () => {
      try { await operation(child, calls.at(-1)); }
      catch (error) { child.emit('error', error); }
    });
    return child;
  };
  return { calls, spawnProcess };
}
function complete(child, stdout, code = 0, stderr = '') {
  child.stdout.end(stdout); child.stderr.end(stderr); child.exitCode = code; child.emit('close', code);
}

test('media gives each child a private temporary directory and removes unpacked tools on success and failure', async t => {
  const parent = await realpath(tmpdir()), temporaryDirectories = [], inheritedTemporary = process.env.TEMP;
  const { calls, spawnProcess } = mockProcesses(async (child, call) => {
    const directory = call.options.env.TEMP;
    if (directory !== inheritedTemporary) {
      await mkdir(join(directory, '_MEI-fixture'));
      await writeFile(join(directory, '_MEI-fixture', 'python.dll'), 'unpacked child fixture');
    }
    complete(child, JSON.stringify({ title: 'Temporary fixture', formats: [{ height: 144, vcodec: 'h264' }] }), calls.length === 1 ? 0 : 1, 'ConnectionResetError');
  });
  const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
  await service.inspect(video);
  for (let index = 0; index < 2; index++) {
    if (index) await assert.rejects(service.inspect(video), error => isTransientNetworkError(error));
    const env = calls[index].options.env;
    assert.notEqual(env.TEMP, inheritedTemporary, 'A media child must not unpack into the shared system temporary directory');
    assert.equal(dirname(env.TEMP), parent);
    assert.equal(env.TMP, env.TEMP); assert.equal(env.TMPDIR, env.TEMP);
    assert.equal(env.DENO_DIR, join(env.TEMP, 'deno'));
    await assert.rejects(stat(env.TEMP), { code: 'ENOENT' });
    temporaryDirectories.push(env.TEMP);
  }
  assert.equal(new Set(temporaryDirectories).size, 2);
  assert.equal(process.env.TEMP, inheritedTemporary);
});

test('media cancellation waits for the process tree before removing its temporary directory', async t => {
  let active, directory, started, directorySurvivedUntilTreeExit = false;
  const ready = new Promise(resolve => { started = resolve; });
  const spawnProcess = (command, _args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 45678; child.exitCode = null;
    child.kill = () => complete(child, '', 1);
    if (/taskkill\.exe$/i.test(command)) setImmediate(async () => {
      active.kill();
      await new Promise(resolve => setTimeout(resolve, 30));
      directorySurvivedUntilTreeExit = await stat(directory).then(() => true, () => false);
      complete(child, '', 0);
    });
    else { active = child; directory = options.env.TEMP; started(); }
    return child;
  };
  const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
  const inspection = service.inspect(video), rejected = assert.rejects(inspection, /أُغلق محرك الفيديو/);
  await ready;
  assert.notEqual(directory, process.env.TEMP);
  await service.close(); await rejected;
  if (process.platform === 'win32') assert.equal(directorySurvivedUntilTreeExit, true);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('media cleanup refuses a replaced directory and preserves files outside its workspace', async t => {
  const parent = await realpath(tmpdir()), outside = await mkdtemp(join(parent, 'sahm-media-outside-'));
  const sentinel = join(outside, 'keep.txt'); await writeFile(sentinel, 'unrelated file');
  let directory, preserved;
  t.after(async () => {
    if (directory) { assert.equal(dirname(directory), parent); await unlink(directory); }
    if (preserved) { assert.equal(dirname(preserved), parent); await rm(preserved, { recursive: true, force: true }); }
    assert.equal(dirname(outside), parent); await rm(outside, { recursive: true, force: true });
  });
  const { spawnProcess } = mockProcesses(async (child, call) => {
    directory = call.options.env.TEMP;
    assert.equal(dirname(directory), parent); assert.match(directory, /sahm-media-process-/);
    preserved = directory + '.preserved'; assert.equal(dirname(preserved), parent);
    await rename(directory, preserved); await symlink(outside, directory, 'junction');
    complete(child, JSON.stringify({ title: 'Fixture', formats: [{ height: 144, vcodec: 'h264' }] }));
  });
  const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
  await assert.rejects(service.inspect(video), error => error.code === 'media-output-failed' && !isTransientNetworkError(error));
  assert.equal(await readFile(sentinel, 'utf8'), 'unrelated file');
  assert.ok((await stat(preserved)).isDirectory());
});

test('media exposes only recognized connection failures to automatic retry and keeps local failures terminal', async () => {
  for (const message of ['ConnectionResetError: [WinError 10054] connection reset', "Unable to connect to proxy: NewConnectionError: [WinError 10061] No connection could be made because the target machine actively refused it", "ProxyError: Unable to connect to proxy: OSError('Tunnel connection failed: 502 Bad Gateway')", 'Temporary failure in name resolution', 'The read operation timed out', 'HTTP Error 503: Service Unavailable', 'IncompleteRead: 12 bytes read, 40 more expected']) {
    const { spawnProcess } = mockProcesses(child => complete(child, '', 1, message + ' https://private.invalid/?token=secret'));
    await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).inspect(video), error => isTransientNetworkError(error) && !error.message.includes('secret'));
  }
  for (const message of ['Unable to download video: HTTP Error 404', 'HTTP Error 429: Too Many Requests', 'HTTP Error 403: Forbidden', 'Tunnel connection failed: 403 Forbidden', 'Tunnel connection failed: 407 Authentication Required', 'Tunnel connection failed: 429 Too Many Requests', 'Tunnel connection failed: 502 followed by HTTP Error 403', 'Sign in to confirm your age', 'DRM protected content', 'Unable to open for writing: Permission denied', 'No space left on device', 'SSL: CERTIFICATE_VERIFY_FAILED', 'Unable to download: unknown extractor failure']) {
    const { spawnProcess } = mockProcesses(child => complete(child, '', 1, message));
    await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).inspect(video), error => !isTransientNetworkError(error));
  }
});

test('media URLs canonicalize individual YouTube videos and reject unsafe origins and playlists', () => {
  for (const url of ['https://youtu.be/BaW_jenozKc?t=2', 'https://m.youtube.com/shorts/BaW_jenozKc', video + '&list=playlist']) assert.equal(normalizeMediaUrl(url), video);
  for (const url of ['http://www.youtube.com/watch?v=BaW_jenozKc', 'https://www.youtube.com.evil/watch?v=BaW_jenozKc', 'https://user@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com:8443/watch?v=BaW_jenozKc', 'https://youtube.com/playlist?list=123', 'https://youtu.be/../x', 'file:///C:/x.mp4']) assert.throws(() => normalizeMediaUrl(url));
});

test('media inspection uses fixed hardened process arguments and returns no signed URLs or headers', async () => {
  const { calls, spawnProcess } = mockProcesses(child => complete(child, JSON.stringify({ title: 'Sample', duration: 7, formats: [{ height: 1080, vcodec: 'vp9', url: 'https://signed.example/secret', http_headers: { cookie: 'private' } }, { height: 360, vcodec: 'h264' }] })));
  const service = new MediaService({ runtimeDirectory: 'C:/verified/tools', spawnProcess, verifyRuntime: false });
  const result = await service.inspect(video);
  assert.deepEqual(result, { title: 'Sample', duration: 7, webpageUrl: video, qualities: ['best', '1080', '360'], source: 'youtube', mediaOptions: { containers: [], audioTracks: [{ id: 'default', label: 'الصوت الافتراضي' }], combinations: [] } });
  const { args, options } = calls[0];
  for (const flag of ['--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-remote-components', '--no-js-runtimes']) assert.ok(args.includes(flag));
  assert.ok(!args.includes('--netrc')); assert.ok(!args.includes('--netrc-cmd'));
  for (const executable of ['ffmpeg', 'ffprobe']) assert.ok(args.includes(`${executable}_i:-protocol_whitelist file,pipe -format_whitelist mov,mpegts,matroska,webm,aac,mp3,ogg,flac`));
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(args.slice(-2), ['--', video]);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('download media URL routing accepts only individual YouTube or credential-free HTTP manifests', () => {
  assert.equal(normalizeDownloadMediaUrl(video), video);
  assert.equal(getMediaSource(video), 'youtube');
  for (const url of ['https://media.example/public.m3u8?token=123', 'http://127.0.0.1:12345/test.mpd']) {
    assert.equal(normalizeDownloadMediaUrl(url), url); assert.equal(getMediaSource(url), 'stream');
  }
  for (const url of ['file:///secret.mpd', 'concat:https://a|https://b.m3u8', 'https://user:secret@example.com/file.mpd', 'https://example.com/file.mp4', 'https://example.com/file.mpd#x']) assert.throws(() => normalizeDownloadMediaUrl(url));
  assert.deepEqual(MEDIA_QUALITIES, ['best', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
});

test('inspection lists actual source heights without inventing larger quality choices', async () => {
  const { spawnProcess } = mockProcesses(child => complete(child, JSON.stringify({ title: '240p only', formats: [{ height: 240, vcodec: 'av1' }, { height: 1080, vcodec: 'vp9', has_drm: true }, { height: 720, vcodec: 'none' }] })));
  assert.deepEqual((await new MediaService({ spawnProcess, verifyRuntime: false }).inspect(video)).qualities, ['best', '240']);
});

test('media inspection rejects live and DRM videos with safe errors', async () => {
  for (const info of [{ is_live: true }, { has_drm: true }, { formats: [] }]) {
    const { spawnProcess } = mockProcesses(child => complete(child, JSON.stringify(info)));
    await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).inspect(video), /البث المباشر|صيغة فيديو/);
  }
  const { spawnProcess } = mockProcesses(child => complete(child, '', 1, 'HTTP Error 403 https://signed.example/?token=private'));
  await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).inspect(video), error => !error.message.includes('private') && error.message.includes('رفض YouTube'));
});

test('media download publishes only the checked completed video and reports audio plus video progress', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const finished = join(directory, 'media.mkv');
  const events = [];
  const { calls, spawnProcess } = mockProcesses(async child => {
    await writeFile(finished, 'merged-video-and-audio');
    complete(child, [
      'SAHM_PROGRESS:' + JSON.stringify({ filename: 'video', downloaded_bytes: 100, total_bytes: 100, speed: 12 }),
      'SAHM_PROGRESS:' + JSON.stringify({ filename: 'audio', downloaded_bytes: 20, total_bytes: 20, speed: 5 }),
      'SAHM_FILE:' + JSON.stringify(finished), '',
    ].join('\n'));
  });
  const result = await new MediaService({ spawnProcess, verifyRuntime: false }).download(video, join(directory, 'الاختبار.mkv'), { quality: '720', onProgress: value => events.push(value) });
  assert.equal(result.name, 'الاختبار.mkv'); assert.equal(await readFile(result.path, 'utf8'), 'merged-video-and-audio');
  assert.equal(result.bytes, 22); assert.equal(events.at(-1).received, 120);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--format') + 1], 'bv*[height<=720]+ba/b[height<=720]');
  assert.ok(!args.includes('--exec'));
});

test('media output cannot publish a path outside the job directory or an incomplete empty file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-reject-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const finished of [join(directory, '..', 'outside.mkv'), join(directory, 'media.mkv')]) {
    await writeFile(join(directory, 'media.mkv'), '');
    const { spawnProcess } = mockProcesses(child => complete(child, 'SAHM_FILE:' + JSON.stringify(finished)));
    await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).download(video, join(directory, 'target.mkv')), /غير صالح/);
  }
});

test('media publication preserves an existing destination and the completed source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-existing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'media.mkv');
  const destination = join(directory, 'existing.mkv');
  await writeFile(destination, 'original-file');
  const { spawnProcess } = mockProcesses(async child => {
    await writeFile(source, 'completed-video');
    complete(child, 'SAHM_FILE:' + JSON.stringify(source));
  });
  await assert.rejects(new MediaService({ spawnProcess, verifyRuntime: false }).download(video, destination), /يوجد ملف/);
  assert.equal(await readFile(destination, 'utf8'), 'original-file');
  assert.equal(await readFile(source, 'utf8'), 'completed-video');
});

test('explicit media selections constrain process arguments and cannot change over saved parts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-selected-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const info = { formats: [{ format_id: 'video720', vcodec: 'h264', acodec: 'none', height: 720 }, { format_id: 'audioEn', vcodec: 'none', acodec: 'aac', language: 'en' }] };
  const { calls, spawnProcess } = mockProcesses(async (child, call) => {
    if (call.args.includes('--dump-single-json')) return complete(child, JSON.stringify(info));
    await writeFile(join(directory, 'media.mp4.part'), 'retained-selected-bytes'); complete(child, '', 1, 'Connection reset by peer');
  });
  const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
  await assert.rejects(service.download(video, join(directory, 'video.mp4'), { container: 'mp4', quality: '720' }), error => isTransientNetworkError(error));
  const download = calls.find(call => call.args.includes('--continue'));
  assert.equal(download.args[download.args.indexOf('--format') + 1], 'video720+audioEn');
  assert.equal(download.args[download.args.indexOf('--remux-video') + 1], 'mp4');
  const count = calls.filter(call => call.args.includes('--continue')).length;
  await assert.rejects(service.download(video, join(directory, 'video.mp4'), { container: 'mkv', quality: '720' }), /تغيّرت خيارات/);
  assert.equal(calls.filter(call => call.args.includes('--continue')).length, count);
  assert.equal(await readFile(join(directory, 'media.mp4.part'), 'utf8'), 'retained-selected-bytes');
  info.formats[1].format_id = 'changed';
  await assert.rejects(service.download(video, join(directory, 'video.mp4'), { container: 'mp4', quality: '720' }), /تغيّرت خيارات/);
});

test('missing or altered bundled runtime fails before spawning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-integrity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { calls, spawnProcess } = mockProcesses(() => {});
  const service = new MediaService({ runtimeDirectory: directory, spawnProcess });
  await assert.rejects(service.inspect(video), /محرك الفيديو/);
  await mkdir(join(directory, 'licenses'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ dependencies: [{ installed: ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe'].map(name => ({ name, sha256: '0'.repeat(64) })) }] }));
  await assert.rejects(service.inspect(video), /محرك الفيديو/);
  assert.equal(calls.length, 0);
});

test('closing media service cancels an active inspection and prevents later child processes', async () => {
  let active, started;
  const spawnStarted = new Promise(resolve => { started = resolve; });
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 54321; child.exitCode = null;
    child.kill = () => complete(child, '', 1);
    if (/taskkill\.exe$/i.test(command)) setImmediate(() => { active.kill(); child.emit('close', 0); });
    else { active = child; started(); }
    return child;
  };
  const service = new MediaService({ spawnProcess, verifyRuntime: false });
  const inspection = service.inspect(video);
  const rejected = assert.rejects(inspection, /أُغلق محرك الفيديو/);
  await spawnStarted;
  await service.close(); await rejected;
  await assert.rejects(service.inspect(video), /أُغلق محرك الفيديو/);
});

test('audio extraction uses one literal stream and validates the final audio before publishing', async t => {
  for (const container of ['mp3', 'm4a']) {
    const directory = await mkdtemp(join(tmpdir(), 'sahm-audio-unit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const finished = join(directory, 'media.' + container);
    const { calls, spawnProcess } = mockProcesses(async (child, call) => {
      if (call.command.endsWith('ffprobe.exe')) return complete(child, JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: container === 'mp3' ? 'mp3' : 'aac' }], format: { duration: '6.1', format_name: container === 'mp3' ? 'mp3' : 'mov,mp4,m4a,3gp,3g2,mj2' } }));
      if (call.args.includes('--dump-single-json')) return complete(child, JSON.stringify({ formats: [{ format_id: 'a123', vcodec: 'none', acodec: 'aac' }, { format_id: 'v123', vcodec: 'h264', acodec: 'none' }] }));
      await writeFile(finished, 'audio only'); complete(child, 'SAHM_FILE:' + JSON.stringify(finished));
    });
    const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
    const result = await service.download(video, join(directory, 'saved.' + container), { container });
    assert.equal(await readFile(result.path, 'utf8'), 'audio only');
    const args = calls.find(call => call.args.includes('--extract-audio')).args;
    assert.equal(args[args.indexOf('--format') + 1], 'a123');
    assert.equal(args[args.indexOf('--audio-format') + 1], container);
    assert.equal(args[args.indexOf('--audio-quality') + 1], '192K');
    assert.ok(!args.includes('--remux-video')); assert.ok(!args.includes('--merge-output-format'));
    assert.equal(calls.filter(call => call.command.endsWith('ffprobe.exe')).length, 1);
    await assert.rejects(service.download(video, join(directory, 'bad.' + container), { container, quality: '720' }), /دقة فيديو/);
  }
});

test('audio verification rejects video, wrong codecs, missing duration and corrupt output without publication or retry', async t => {
  for (const metadata of [
    { streams: [{ codec_type: 'video', codec_name: 'h264' }], format: { duration: 6, format_name: 'mp3' } },
    { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: { duration: 6, format_name: 'mp3' } },
    { streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: { duration: 'N/A', format_name: 'mp3' } },
    { streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: { duration: 6, format_name: 'mov' } },
    'invalid JSON', null,
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'sahm-audio-invalid-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const finished = join(directory, 'media.mp3'), target = join(directory, 'saved.mp3');
    const { spawnProcess } = mockProcesses(async (child, call) => {
      if (call.command.endsWith('ffprobe.exe')) return complete(child, typeof metadata === 'string' ? metadata : JSON.stringify(metadata), metadata === null ? 1 : 0, 'HTTP 503 private token');
      if (call.args.includes('--dump-single-json')) return complete(child, JSON.stringify({ formats: [{ format_id: 'a123', vcodec: 'none', acodec: 'aac' }] }));
      await writeFile(finished, 'retained staging'); complete(child, 'SAHM_FILE:' + JSON.stringify(finished));
    });
    const service = new MediaService({ spawnProcess, verifyRuntime: false }); t.after(() => service.close());
    await assert.rejects(service.download(video, target, { container: 'mp3' }), error => error.code === 'media-output-failed' && !isTransientNetworkError(error) && !error.message.includes('private'));
    await assert.rejects(stat(target), { code: 'ENOENT' }); assert.equal(await readFile(finished, 'utf8'), 'retained staging');
  }
});
