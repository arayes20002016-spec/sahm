import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export async function generateMultiaudioFixture(directory, runtime = resolve('artifacts/media-runtime')) {
  await mkdir(directory, { recursive: true });
  const run = args => promisify(execFile)(join(runtime, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: directory, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
  const source = join(directory, 'source.mp4');
  await run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '6', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-b:a', '64k', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ara', source]);
  await run(['-i', source, '-map', '0', '-c', 'copy', '-f', 'dash', '-seg_duration', '2', '-adaptation_sets', 'id=0,streams=v id=1,streams=1 id=2,streams=2', join(directory, 'multi.mpd')]);
  for (const [name, stream] of [['video', '0:v'], ['english', '0:a:0'], ['arabic', '0:a:1']]) {
    await run(['-i', source, '-map', stream, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(directory, name + '%03d.ts'), join(directory, name + '.m3u8')]);
  }
  await writeFile(join(directory, 'multi.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="english.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Arabic",LANGUAGE="ar",DEFAULT=NO,AUTOSELECT=YES,URI="arabic.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="audio"\nvideo.m3u8\n');
  await run(['-i', source, '-map', '0:v', '-map', '0:a:1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-metadata:s:a:0', 'language=ara', '-f', 'dash', '-seg_duration', '2', join(directory, 'webm.mpd')]);
  return { directory, source };
}
