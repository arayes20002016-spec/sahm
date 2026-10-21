import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, basename } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { MediaService } from '../src/media.mjs';
import { prepareStream } from '../src/stream-media.mjs';
import { generateStreamFixture } from './helpers/stream-fixture.mjs';

async function fixtureServer(t, files) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    requests.push({ path, headers: request.headers });
    const item = files instanceof Map ? files.get(path) : await readFile(join(files, basename(path))).catch(() => null);
    if (!item) return response.writeHead(404).end();
    const body = typeof item === 'string' ? Buffer.from(item) : item;
    const type = extname(path) === '.mpd' ? 'application/dash+xml' : extname(path) === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length }); response.end(request.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('stream validation rejects protected/live/local HLS and DASH before any segment request', async t => {
  const valid = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n';
  const mpd = '<MPD type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet><Representation id="0" bandwidth="1000" height="240"><SegmentTemplate media="seg-$Number$.m4s" initialization="init.m4s" duration="2"/></Representation></AdaptationSet></Period></MPD>';
  const cases = [
    ['encrypted.m3u8', valid.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="secret.key"\n#EXTINF:')],
    ['live.m3u8', valid.replace('#EXT-X-ENDLIST\n', '')],
    ['local.m3u8', valid.replace('segment.ts', 'file:///C:/Users/private.mp4')],
    ['concat.m3u8', valid.replace('segment.ts', 'concat:one|two')],
    ['unquoted.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nvod.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,URI=https://evil.example/audio.m3u8\n'],
    ['protected.mpd', mpd.replace('<Representation', '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/><Representation')],
    ['live.mpd', mpd.replace('type="static"', 'type="dynamic"')],
    ['local.mpd', mpd.replace('seg-$Number$.m4s', 'file:///C:/secret.mp4')],
    ['entity.mpd', '<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///C:/secret">]>' + mpd],
    ['external.mpd', mpd.replace('<Period>', '<Period xlink:href="https://evil.example/page.mpd">')],
    ['alias.mpd', mpd.replace('<Period>', '<Period xmlns:z="http://www.w3.org/1999/xlink" z:href="file:///C:/secret.mpd">')],
    ['nested.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nencrypted.m3u8\n'],
  ];
  const files = new Map(cases.map(([name, body]) => [`/${name}`, body])); files.set('/vod.m3u8', valid);
  const { origin, requests } = await fixtureServer(t, files);
  for (const [name] of cases) await assert.rejects(prepareStream(`${origin}/${name}`), /مشفّر|المباشر|غير مدعوم|آمن/);
  await assert.rejects(prepareStream(`${origin}/encrypted.m3u8`), error => error.code === 'unsupported-encrypted');
  await assert.rejects(prepareStream(`${origin}/live.mpd`), error => error.code === 'unsupported-live');
  await assert.rejects(prepareStream(`${origin}/local.mpd`), error => error.code === 'unsafe-media-manifest');
  assert.ok(requests.every(value => /\.(mpd|m3u8)$/.test(value.path)), 'no segment, key or private file may be requested during rejection');
});

test('frozen stream gateway serves manifests only in inspection mode and never forwards credentials', async t => {
  const files = new Map([['/vod.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n']]);
  const { origin, requests } = await fixtureServer(t, files);
  const prepared = await prepareStream(`${origin}/vod.m3u8`, { allowSegments: false }); t.after(prepared.close);
  const response = await fetch(prepared.url); const manifest = await response.text();
  assert.ok(manifest.includes('http://127.0.0.1:'));
  assert.ok(!manifest.includes(`${origin}/segment.ts`));
  const segment = manifest.split('\n').find(value => value.startsWith('http'));
  assert.equal((await fetch(segment, { headers: { Cookie: 'private', Authorization: 'secret' } })).status, 403);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.cookie, undefined); assert.equal(requests[0].headers.authorization, undefined);
});

test('stream gateway strips client credentials and refuses a nested playlist disguised as media bytes', async t => {
  const bytes = Buffer.alloc(512); bytes[0] = 0x47; bytes[188] = 0x47;
  const files = new Map([
    ['/valid.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n'],
    ['/invalid.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfake.ts\n#EXT-X-ENDLIST\n'],
    ['/segment.ts', bytes], ['/fake.ts', '#EXTM3U\n#EXTINF:2,\nfile:///C:/private.mp4\n#EXT-X-ENDLIST\n'],
  ]);
  const { origin, requests } = await fixtureServer(t, files);
  for (const [manifest, status] of [['valid.m3u8', 200], ['invalid.m3u8', 502]]) {
    const prepared = await prepareStream(`${origin}/${manifest}`);
    try {
      const text = await (await fetch(prepared.url)).text();
      const url = text.split('\n').find(line => line.startsWith('http'));
      const response = await fetch(url, { headers: { Cookie: 'private', Authorization: 'secret' } });
      assert.equal(response.status, status); await response.arrayBuffer();
    } finally { await prepared.close(); }
  }
  assert.ok(requests.every(value => !value.headers.cookie && !value.headers.authorization));
  assert.ok(!requests.some(value => value.path.includes('private')));
});

test('closing the service cancels a manifest fetch before spawning and authentication failures have a bounded code', async t => {
  let began;
  const requested = new Promise(resolve => { began = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/auth.m3u8') response.writeHead(401).end('secret login page');
    else began();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(prepareStream(`${origin}/auth.m3u8`), error => error.code === 'media-auth-required' && !error.message.includes('secret'));
  let processes = 0;
  const service = new MediaService({ verifyRuntime: false, spawnProcess: () => { processes++; throw new Error('Unexpected spawn'); } });
  const inspection = service.inspect(`${origin}/waiting.m3u8`);
  const rejected = assert.rejects(inspection, /أُغلق محرك الفيديو/);
  await requested; await service.close(); await rejected;
  assert.equal(processes, 0);
});

test('FFmpeg input restrictions reject HLS and concat demuxers before opening nested files', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-media-demuxer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guards = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mpegts,matroska,webm,aac,mp3,ogg,flac'];
  const manifests = [
    ['disguised.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nfile:///C:/private-not-opened.mp4\n#EXT-X-ENDLIST\n'],
    ['disguised.ffconcat', "ffconcat version 1.0\nfile 'C:/private-not-opened.mp4'\n"],
  ];
  for (const [name, body] of manifests) {
    const path = join(directory, name); await writeFile(path, body);
    for (const executable of ['ffmpeg', 'ffprobe']) {
      const args = executable === 'ffmpeg' ? ['-i', path, '-f', 'null', '-'] : ['-show_streams', '-of', 'json', path];
      await assert.rejects(promisify(execFile)(resolve(`artifacts/media-runtime/${executable}.exe`), ['-hide_banner', '-loglevel', 'error', ...guards, ...args], { windowsHide: true, timeout: 10000 }), error => /not on whitelist/i.test(error.stderr) && !/Impossible to open/i.test(error.stderr));
    }
  }
});

test('real bundled engine completes generated HLS master and DASH VOD with audio and video', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-stream-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await generateStreamFixture(join(directory, 'fixture'));
  const { origin, requests } = await fixtureServer(t, join(directory, 'fixture'));
  const service = new MediaService({ spawnProcess: (command, args, options) => {
    const child = spawn(command, args, options); let stderr = '';
    child.stderr?.on('data', data => { stderr += data; });
    child.on('close', code => { if (code) t.diagnostic(stderr); });
    return child;
  } }); t.after(() => service.close());
  for (const [manifest, qualities] of [['master.m3u8', ['best', '240']], ['vod.m3u8', ['best']], ['vod.mpd', ['best', '240']], ['vod-list.mpd', ['best', '240']]]) {
    const before = requests.length;
    const info = await service.inspect(`${origin}/${manifest}`);
    assert.equal(info.source, 'stream'); assert.deepEqual(info.qualities, qualities);
    assert.ok(requests.slice(before).every(value => /\.(m3u8|mpd)$/.test(value.path)), 'metadata must not transfer segments');
    const events = [];
    const result = await service.download(`${origin}/${manifest}`, join(directory, manifest, 'result.mkv'), { quality: qualities.at(-1), onProgress: value => events.push(value) });
    assert.ok(result.bytes > 10000); assert.ok(events.some(value => value.received > 0));
    const probe = await promisify(execFile)(resolve('artifacts/media-runtime/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.path], { windowsHide: true, timeout: 10000 });
    const metadata = JSON.parse(probe.stdout);
    assert.ok(metadata.streams.some(value => value.codec_type === 'video' && value.width === 320 && value.height === 240));
    assert.ok(metadata.streams.some(value => value.codec_type === 'audio'));
    assert.ok(Number(metadata.format.duration) >= 7.9);
    assert.ok(!(await readdir(join(directory, manifest))).some(value => value.endsWith('.part')));
  }
  assert.ok(requests.every(value => value.headers.cookie === undefined && value.headers.authorization === undefined));
});

test('real HLS and DASH downloads pause, survive service restart, and resume with unchanged manifest identity', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-stream-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await generateStreamFixture(join(directory, 'fixture'));
  const { origin, requests } = await fixtureServer(t, join(directory, 'fixture'));
  for (const manifest of ['master.m3u8', 'vod.mpd']) {
    const service = new MediaService(), controller = new AbortController();
    let pauseRequested = false;
    const path = join(directory, manifest, 'result.mkv');
    const timeout = setTimeout(() => controller.abort(new Error('Resume test timed out')), 60000);
    try {
      await assert.rejects(service.download(`${origin}/${manifest}`, path, {
        quality: '240', signal: controller.signal, maxBytesPerSecond: 40000,
        onProgress: value => {
          if (pauseRequested || value.received < 20000) return;
          pauseRequested = true;
          // The UI process can receive progress after the downloader has flushed or renamed a component.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
          controller.abort(new Error('Paused for restart'));
        },
      }), /Paused for restart/);
    } finally { clearTimeout(timeout); await service.close(); }
    const files = await readdir(join(directory, manifest));
    const retained = [];
    for (const name of files.filter(name => /^media\..*\.(?:part|mp4|m4a|webm|mkv)(?:-Frag\d+)?$|^media\.(?:mp4|m4a|webm|mkv)$/i.test(name))) {
      const file = join(directory, manifest, name);
      if ((await stat(file)).size > 0) retained.push({ file, bytes: await readFile(file) });
    }
    // A finished component may already have lost its .part suffix before progress reaches the UI.
    assert.ok(retained.length > 0, 'downloaded media bytes must remain for restart: ' + JSON.stringify(files));
    assert.ok(files.includes('media-stream.json'));
    const restarted = new MediaService();
    try {
      const manifestPath = join(directory, 'fixture', manifest), original = await readFile(manifestPath);
      const before = requests.length;
      try {
        await writeFile(manifestPath, Buffer.concat([original, Buffer.from(manifest.endsWith('.mpd') ? '\n<!-- changed manifest -->\n' : '\n# changed manifest\n')]));
        await assert.rejects(restarted.download(`${origin}/${manifest}`, path, { quality: '240' }), /تغيّر بيان البث/);
        assert.ok(requests.slice(before).every(value => /\.(mpd|m3u8)$/.test(value.path)), 'changed streams must reject before loading more fragments');
        for (const saved of retained) assert.deepEqual(await readFile(saved.file), saved.bytes, 'rejected manifest changes must preserve every retained media byte');
      } finally { await writeFile(manifestPath, original); }
      const result = await restarted.download(`${origin}/${manifest}`, path, { quality: '240' });
      const probe = await promisify(execFile)(resolve('artifacts/media-runtime/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.path], { windowsHide: true, timeout: 10000 });
      const info = JSON.parse(probe.stdout);
      assert.ok(info.streams.some(value => value.codec_type === 'video'));
      assert.ok(info.streams.some(value => value.codec_type === 'audio'));
      assert.ok(Number(info.format.duration) >= 7.9);
      assert.ok(!(await readdir(join(directory, manifest))).includes('media-stream.json'));
    } finally { await restarted.close(); }
  }
});
