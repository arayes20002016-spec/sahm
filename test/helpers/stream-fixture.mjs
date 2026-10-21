import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function generateStreamFixture(directory, runtime = resolve('artifacts/media-runtime')) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const ffmpeg = join(runtime, 'ffmpeg.exe');
  const run = args => execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: directory, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const source = join(directory, 'source.mp4');
  await run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', source]);
  await run(['-i', source, '-map', '0', '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(directory, 'segment%03d.ts'), join(directory, 'vod.m3u8')]);
  await writeFile(join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240,CODECS="avc1.42c00c,mp4a.40.2"\nvod.m3u8\n');
  await run(['-i', source, '-map', '0', '-c', 'copy', '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', join(directory, 'vod.mpd')]);
  const list = id => `<SegmentList timescale="1" duration="2"><Initialization sourceURL="init-stream${id}.m4s"/>${[1, 2, 3, 4].map(index => `<SegmentURL media="chunk-stream${id}-${String(index).padStart(5, '0')}.m4s"/>`).join('')}</SegmentList>`;
  await writeFile(join(directory, 'vod-list.mpd'), `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.42c00c"><Representation id="0" bandwidth="500000" width="320" height="240">${list(0)}</Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"><Representation id="1" bandwidth="64000" audioSamplingRate="48000">${list(1)}</Representation></AdaptationSet></Period></MPD>`);
  return { directory, master: join(directory, 'master.m3u8'), hls: join(directory, 'vod.m3u8'), dash: join(directory, 'vod.mpd'), source };
}
