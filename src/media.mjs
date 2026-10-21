import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, lstat, link, unlink, open, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeStreamUrl, prepareStream } from './stream-media.mjs';
import { replaceCheckpoint } from './checkpoint.mjs';
import { isTransientNetworkError } from './network-retry.mjs';
import { mediaSelectionCatalog, resolveMediaSelection, validateMediaSelection, isAudioContainer } from './media-selection.mjs';

export const MEDIA_QUALITIES = Object.freeze(['best', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144']);
const defaultRuntimeDirectory = fileURLToPath(new URL('../artifacts/media-runtime/', import.meta.url));
const videoId = /^[A-Za-z0-9_-]{11}$/;
const runtimeMissing = 'محرك الفيديو غير متاح. شغّل النسخة الكاملة من سَهم التي تتضمن أدوات الفيديو.';
const mediaInputArguments = '-protocol_whitelist file,pipe -format_whitelist mov,mpegts,matroska,webm,aac,mp3,ogg,flac';

export function normalizeMediaUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('أدخل رابط فيديو YouTube صالحًا.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error('يلزم رابط YouTube آمن دون بيانات دخول.');
  const host = parsed.hostname.toLowerCase();
  let id;
  if (host === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    if (/^\/watch\/?$/.test(parsed.pathname)) id = parsed.searchParams.get('v');
    else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(parsed.pathname)?.[1];
  }
  if (!videoId.test(id || '')) throw new Error('يدعم هذا الخيار روابط فيديو YouTube المفردة وShorts.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function validateMediaQuality(value = 'best') {
  if (!MEDIA_QUALITIES.includes(value)) throw new Error('جودة الفيديو غير صالحة.');
  return value;
}

export function normalizeDownloadMediaUrl(value) {
  try { return normalizeMediaUrl(value); }
  catch { return normalizeStreamUrl(value); }
}

export function getMediaSource(value) {
  try { normalizeMediaUrl(value); return 'youtube'; }
  catch { normalizeStreamUrl(value); return 'stream'; }
}

function formatSelector(quality) {
  const limit = quality === 'best' ? '' : `[height<=${quality}]`;
  return `bv*${limit}+ba/b${limit}`;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function saveMediaCheckpoint(destination, identity) {
  const temporary = join(dirname(destination), `.media-checkpoint-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx');
    await file.writeFile(JSON.stringify(identity)); await file.sync(); await file.close(); file = null;
    await replaceCheckpoint(temporary, destination);
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

function processError(stderr, source) {
  const error = (message, code) => Object.assign(new Error(message), { code });
  if (/private video|sign in|login|members.only|age.restricted|confirm.*age/i.test(stderr)) return error('هذا الفيديو يحتاج إلى تسجيل دخول أو صلاحية خاصة؛ يتاح هنا تنزيل الفيديو العام فقط.', 'media-auth-required');
  if (/DRM|protected content/i.test(stderr)) return error('هذا الفيديو محمي ولا يدعم سَهم تنزيله.', 'unsupported-encrypted');
  if (/no space left|disk (?:is )?full|permission denied|unable to open.*writ|error opening output|postprocessing|conversion failed|WinError (?:5|32|112)\b/i.test(stderr)) return error('تعذّر حفظ الفيديو أو معالجته؛ تحقق من التخزين وصلاحيات الملف.', 'media-output-failed');
  if (/certificate.verify.failed|CERTIFICATE_VERIFY_FAILED|certificate has expired|certificate.*hostname|SSL.*handshake/i.test(stderr)) return error('تعذّر التحقق من الاتصال الآمن بمصدر الفيديو.', 'media-certificate-invalid');
  const statuses = [...stderr.matchAll(/(?:HTTP Error |Tunnel connection failed:\s*)(\d{3})\b/gi)].map(match => Number(match[1]));
  if (statuses.length && statuses.every(status => [408, 425, 500, 502, 503, 504].includes(status))) return error('تعذّر الاتصال بمصدر الفيديو مؤقتًا.', 'media-network-error');
  if (statuses.length || /bot|not available|unavailable|unsupported URL|unable to extract/i.test(stderr)) return error(source === 'stream' ? 'رفض مصدر البث إتاحة الفيديو العام للتنزيل.' : 'رفض YouTube إتاحة هذا الفيديو للتنزيل. جرّب فيديو عامًا آخر أو أعد المحاولة لاحقًا.', 'media-unavailable');
  if (/timed out|temporary failure in name resolution|Name or service not known|NameResolutionError|getaddrinfo failed|failed to resolve|NewConnectionError|Connection(?:Reset|Refused|Aborted)Error|connection (?:reset|refused|aborted|closed)|RemoteDisconnected|remote end closed connection|network is (?:unreachable|down)|no route to host|IncompleteRead|\d+ bytes read, \d+ more expected|\b(?:WinError|Errno) (?:1005[134]|1006[01]|11001|111|101|104|110)\b/i.test(stderr)) return error('تعذّر الاتصال بمصدر الفيديو مؤقتًا.', 'media-network-error');
  return error('تعذّر تنزيل الفيديو. قد يكون غير متاح أو تحتاج أدوات الفيديو إلى تحديث.', 'media-process-failed');
}

function terminateTree(child, spawnProcess) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return Promise.resolve(); }
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, 5000);
    const done = () => { clearTimeout(timer); resolvePromise(); };
    const fallback = () => { try { child.kill(); } catch { /* The close event decides whether cleanup is safe. */ } done(); };
    try {
      const killer = spawnProcess(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', fallback); killer.once('close', done);
    } catch { fallback(); }
  });
}

async function removeProcessTemporaryDirectory(directory, parent) {
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || dirname(await realpath(directory)) !== parent || !basename(directory).startsWith('sahm-media-process-')) throw new Error('Temporary directory ownership changed');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw Object.assign(new Error('تعذّر تنظيف ملفات أداة الفيديو المؤقتة. تحقق من صلاحيات المجلد ثم أعد المحاولة.'), { code: 'media-output-failed' });
  }
}

export class MediaService {
  #verified;
  #operations = new Set();
  #closed = false;
  constructor({ runtimeDirectory = defaultRuntimeDirectory, spawnProcess = spawn, verifyRuntime = true, network } = {}) {
    this.runtimeDirectory = resolve(runtimeDirectory);
    this.spawnProcess = spawnProcess;
    this.verifyRuntime = verifyRuntime;
    this.network = network;
  }
  async ready() {
    if (!this.#verified) this.#verified = this.#verify().catch(error => { this.#verified = null; throw error; });
    return this.#verified;
  }
  async #verify() {
    if (!this.verifyRuntime) return;
    try {
      const manifest = JSON.parse(await readFile(join(this.runtimeDirectory, 'manifest.json'), 'utf8'));
      const files = manifest.dependencies.flatMap(value => value.installed);
      for (const name of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe']) if (!files.some(value => value.name === name)) throw new Error('Incomplete runtime');
      for (const file of files) {
        if (basename(file.name) !== file.name || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid runtime manifest');
        if (await sha256(join(this.runtimeDirectory, file.name)) !== file.sha256) throw new Error('Runtime integrity mismatch');
      }
    } catch { throw new Error(runtimeMissing); }
  }
  #arguments(source = 'youtube') {
    return [
      '--ignore-config', '--no-config-locations', '--no-plugin-dirs', '--no-cache-dir',
      '--no-cookies', '--no-cookies-from-browser', '--no-remote-components', '--no-js-runtimes',
      '--js-runtimes', `deno:${join(this.runtimeDirectory, 'deno.exe')}`,
      '--ffmpeg-location', this.runtimeDirectory, '--no-playlist', '--use-extractors', source === 'stream' ? 'generic' : 'youtube',
      '--downloader', 'dash,m3u8:native',
      '--postprocessor-args', `ffmpeg_i:${mediaInputArguments}`, '--postprocessor-args', `ffprobe_i:${mediaInputArguments}`,
      '--no-mark-watched', '--no-warnings', '--color', 'never', '--socket-timeout', '20',
      '--retries', '2', '--fragment-retries', '2', ...(source === 'stream' ? ['--proxy', ''] : []),
    ];
  }
  async #execute(args, options = {}) {
    if (this.#closed) throw new Error('أُغلق محرك الفيديو.');
    const controller = new AbortController();
    let finish;
    const entry = { controller, done: new Promise(resolvePromise => { finish = resolvePromise; }) };
    this.#operations.add(entry);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try { return await this.#run(args, { ...options, signal }); }
    finally { this.#operations.delete(entry); finish(); }
  }
  async close() {
    this.#closed = true;
    const operations = [...this.#operations];
    for (const entry of operations) entry.controller.abort(new Error('أُغلق محرك الفيديو.'));
    await Promise.allSettled(operations.map(entry => entry.done));
  }
  async #run(args, { signal, onLine, source = 'youtube', executable = 'yt-dlp.exe', timeoutMs = 0, maxOutputBytes = 16 * 1024 * 1024 } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Paused');
    await this.ready();
    if (signal?.aborted) throw signal.reason || new Error('Paused');
    const localProbe = executable === 'ffprobe.exe';
    if (!localProbe && executable !== 'yt-dlp.exe') throw new Error('Invalid media tool');
    const proxyArguments = !localProbe && source === 'youtube' && this.network ? ['--proxy', await this.network.externalProxy()] : [];
    if (signal?.aborted) throw signal.reason || new Error('Paused');
    const temporaryParent = await realpath(tmpdir());
    const temporary = await mkdtemp(join(temporaryParent, 'sahm-media-process-'));
    let termination = Promise.resolve(), childRunning = false, finishChild;
    const closed = new Promise(resolvePromise => { finishChild = resolvePromise; });
    try {
      if (signal?.aborted) throw signal.reason || new Error('Paused');
      return await new Promise((resolvePromise, reject) => {
        const child = this.spawnProcess(join(this.runtimeDirectory, executable), [...(localProbe ? [] : this.#arguments(source)), ...proxyArguments, ...args], {
          cwd: this.runtimeDirectory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, DENO_DIR: join(temporary, 'deno'),
            PYTHONPATH: '', PYTHONHOME: '', YTDLP_PLUGIN_DIRS: '', DENO_NO_UPDATE_CHECK: '1' },
        });
        childRunning = Boolean(child.pid);
        let stdout = '', stderr = '', lineBuffer = '', bytes = 0, failure;
        const fail = error => { if (!failure) { failure = error; termination = terminateTree(child, this.spawnProcess); } };
        const abort = () => fail(signal.reason || new Error('Paused'));
        signal?.addEventListener('abort', abort, { once: true });
        const timer = timeoutMs ? setTimeout(() => fail(new Error('انتهت مهلة قراءة معلومات الفيديو. أعد المحاولة.')), timeoutMs) : null;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', data => {
          if (!onLine) {
            bytes += Buffer.byteLength(data);
            if (bytes > maxOutputBytes) { fail(new Error('تجاوزت استجابة الفيديو الحجم المسموح.')); return; }
            stdout += data;
          }
          else {
            lineBuffer += data;
            if (Buffer.byteLength(lineBuffer) > maxOutputBytes) { fail(new Error('تجاوزت استجابة الفيديو الحجم المسموح.')); return; }
            const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop();
            for (const line of lines) onLine(line);
          }
        });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        child.once('error', () => { cleanup(); fail(new Error(runtimeMissing)); reject(failure); });
        child.once('close', code => {
          childRunning = false; finishChild();
          cleanup();
          if (onLine && lineBuffer) onLine(lineBuffer);
          if (failure) reject(failure);
          else if (code !== 0) reject(localProbe ? Object.assign(new Error('تعذّر التحقق من ملف الصوت النهائي؛ لم يُنشر الملف.'), { code: 'media-output-failed' }) : processError(stderr, source));
          else resolvePromise(stdout);
        });
      });
    } finally {
      await termination;
      if (childRunning) await new Promise(resolvePromise => {
        const timer = setTimeout(resolvePromise, 5000);
        closed.then(() => { clearTimeout(timer); resolvePromise(); });
      });
      if (childRunning) throw Object.assign(new Error('لم تتوقف أداة الفيديو؛ أوقف التنزيل قبل إعادة المحاولة.'), { code: 'media-output-failed' });
      await removeProcessTemporaryDirectory(temporary, temporaryParent);
    }
  }
  async #stream(url, options, operation) {
    if (this.#closed) throw new Error('أُغلق محرك الفيديو.');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let finish, prepared;
    const entry = { controller, done: new Promise(resolvePromise => { finish = resolvePromise; }) };
    this.#operations.add(entry);
    try {
      await this.ready();
      prepared = await prepareStream(url, { signal, allowSegments: options.allowSegments });
      try { return await operation(prepared, signal); }
      catch (error) {
        // The loopback gateway's 502 must not hide an upstream denial, invalid
        // certificate or unsafe segment, and an old network error cannot turn
        // a local postprocessing failure into an automatic download retry.
        const upstreamFailure = prepared.failure();
        if ((isTransientNetworkError(error) || error.code === 'media-process-failed') && upstreamFailure) throw upstreamFailure;
        throw error;
      }
    } finally {
      try { await prepared?.close(); }
      finally { this.#operations.delete(entry); finish(); }
    }
  }
  async inspect(url, { signal } = {}) {
    const canonical = normalizeDownloadMediaUrl(url), source = getMediaSource(canonical);
    if (source === 'stream') return this.#stream(canonical, { signal, allowSegments: false }, (prepared, signal) => this.#inspect(prepared.url, canonical, source, signal, prepared.duration, prepared.audioCodec));
    return this.#inspect(canonical, canonical, source, signal);
  }
  async #inspect(url, canonical, source, signal, duration, audioCodec) {
    const info = await this.#information(url, source, signal, audioCodec);
    const formats = Array.isArray(info.formats) ? info.formats.filter(format => (source === 'stream' || format.vcodec) && format.vcodec !== 'none' && !format.has_drm) : [];
    const heights = new Set(formats.map(format => String(format.height)));
    let streamTitle;
    try { streamTitle = decodeURIComponent(new URL(canonical).pathname.split('/').pop()).replace(/\.(mpd|m3u8)$/i, ''); }
    catch { streamTitle = 'فيديو بث'; }
    const title = source === 'stream' ? streamTitle || 'فيديو بث' : info.title || 'فيديو YouTube';
    return { title: String(title).slice(0, 240), webpageUrl: canonical, duration: Number.isFinite(info.duration) ? info.duration : duration ?? null, qualities: ['best', ...MEDIA_QUALITIES.slice(1).filter(value => heights.has(value))], source, mediaOptions: mediaSelectionCatalog(info).options };
  }
  async #information(url, source, signal, audioCodec) {
    const output = await this.#execute(['--skip-download', '--dump-single-json', '--', url], { signal, source, timeoutMs: 90000 });
    let info;
    try { info = JSON.parse(output); } catch { throw new Error('تعذّر قراءة معلومات الفيديو.'); }
    if (info.is_live || info.live_status === 'is_upcoming') throw new Error('التنزيل الحالي مخصص للفيديو المسجّل؛ البث المباشر غير مدعوم.');
    if (audioCodec) for (const format of info.formats || []) {
      if (format.vcodec === 'none' && !format.acodec) format.acodec = audioCodec(format.url);
    }
    const formats = Array.isArray(info.formats) ? info.formats.filter(format => !format.has_drm && (((source === 'stream' || format.vcodec) && format.vcodec !== 'none') || (format.acodec && format.acodec !== 'none'))) : [];
    if (info.has_drm || !formats.length) throw new Error('لا تتوفر صيغة فيديو أو صوت قابلة للتنزيل.');
    return info;
  }
  async download(url, destination, { quality = 'best', container = 'auto', audioTrack = 'default', signal, onProgress = () => {}, maxBytesPerSecond = 0 } = {}) {
    const canonical = normalizeDownloadMediaUrl(url), source = getMediaSource(canonical);
    validateMediaQuality(quality);
    validateMediaSelection({ container, audioTrack, quality });
    if (source === 'stream') return this.#stream(canonical, { signal, allowSegments: true }, async (prepared, signal) => {
      const directory = resolve(dirname(destination));
      await mkdir(directory, { recursive: true });
      const checkpoint = join(directory, 'media-stream.json');
      const identity = { fingerprint: prepared.fingerprint, quality, container, audioTrack };
      try {
        const previous = JSON.parse(await readFile(checkpoint, 'utf8'));
        if (previous.fingerprint !== identity.fingerprint || previous.quality !== quality) throw new Error('تغيّر بيان البث منذ الإيقاف؛ أضف تنزيلًا جديدًا لحماية الأجزاء المحفوظة.');
        if ((previous.container || 'auto') !== container || (previous.audioTrack || 'default') !== audioTrack) throw new Error('تغيّرت خيارات الفيديو منذ الإيقاف؛ أضف تنزيلًا جديدًا لحماية الأجزاء المحفوظة.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await saveMediaCheckpoint(checkpoint, identity);
      const result = await this.#download(prepared.url, destination, { quality, container, audioTrack, canonical, audioCodec: prepared.audioCodec, signal, onProgress, maxBytesPerSecond, source });
      await unlink(checkpoint); return result;
    });
    return this.#download(canonical, destination, { quality, container, audioTrack, canonical, signal, onProgress, maxBytesPerSecond, source });
  }
  async #download(url, destination, { quality, container, audioTrack, canonical, audioCodec, signal, onProgress, maxBytesPerSecond, source }) {
    const directory = resolve(dirname(destination));
    await mkdir(directory, { recursive: true });
    const selection = container !== 'auto' || audioTrack !== 'default'
      ? resolveMediaSelection(await this.#information(url, source, signal, audioCodec), { quality, container, audioTrack }) : null;
    const identity = { url: createHash('sha256').update(canonical).digest('hex'), quality, container, audioTrack, selector: selection?.selector || formatSelector(quality) };
    const checkpoint = join(directory, 'media-selection.json');
    try {
      const previous = JSON.parse(await readFile(checkpoint, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('تغيّرت خيارات الفيديو منذ الإيقاف؛ أضف تنزيلًا جديدًا لحماية الأجزاء المحفوظة.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await saveMediaCheckpoint(checkpoint, identity);
    let completedPath;
    const streamBytes = new Map();
    const args = ['--newline', '--progress', '--progress-delta', '0.25', '--progress-template', 'download:SAHM_PROGRESS:%(progress)j', '--print', 'after_move:SAHM_FILE:%(filepath)j', '--no-simulate', '--continue', '--part', '--abort-on-unavailable-fragments', '--windows-filenames', '--format', selection?.selector || formatSelector(quality), '--match-filter', '!is_live', '--output', join(directory, 'media.%(ext)s')];
    if (isAudioContainer(container)) args.push('--extract-audio', '--audio-format', container, '--audio-quality', '192K');
    else {
      args.push('--merge-output-format', container === 'auto' ? 'mkv' : container);
      if (container !== 'auto') args.push('--remux-video', container);
    }
    if (Number.isFinite(maxBytesPerSecond) && maxBytesPerSecond > 0) args.push('--limit-rate', String(Math.floor(maxBytesPerSecond)));
    args.push('--', url);
    await this.#execute(args, { signal, source, maxOutputBytes: 256 * 1024, onLine: line => {
      if (line.startsWith('SAHM_FILE:')) {
        try { completedPath = JSON.parse(line.slice(10)); } catch { /* An unparseable result cannot be published. */ }
      } else if (line.startsWith('SAHM_PROGRESS:')) {
        let progress;
        try { progress = JSON.parse(line.slice(14)); } catch { return; }
        const key = progress.filename || 'current';
        streamBytes.set(key, { received: Number(progress.downloaded_bytes) || 0, total: Number(progress.total_bytes || progress.total_bytes_estimate) || null });
        const streams = [...streamBytes.values()];
        onProgress({ received: streams.reduce((sum, value) => sum + value.received, 0), total: streams.every(value => value.total !== null) ? streams.reduce((sum, value) => sum + value.total, 0) : null, speed: Number(progress.speed) || 0 });
      }
    } });
    if (typeof completedPath !== 'string' || !isAbsolute(completedPath)) throw new Error('لم يُرجع محرك الفيديو ملفًا مكتملًا.');
    const childPath = relative(directory, resolve(completedPath));
    if (!childPath || childPath.startsWith('..') || isAbsolute(childPath) || dirname(childPath) !== '.') throw new Error('مسار ملف الفيديو غير صالح.');
    const file = await lstat(completedPath);
    if (!file.isFile() || file.isSymbolicLink() || !file.size || !/^\.(mkv|mp4|webm|mov|mp3|m4a)$/i.test(extname(completedPath))) throw new Error('ملف الوسائط النهائي غير صالح.');
    if (container !== 'auto' && extname(completedPath).toLowerCase() !== '.' + container) throw new Error('صيغة الملف النهائي لا تطابق الاختيار؛ لم يُنشر الملف.');
    if (isAudioContainer(container)) await this.#verifyAudio(completedPath, container, signal);
    if (signal?.aborted) throw signal.reason || new Error('Paused');
    const extension = extname(completedPath).toLowerCase();
    const name = basename(destination, extname(destination)) + extension;
    const path = join(directory, name);
    if (resolve(completedPath) !== resolve(path)) {
      try { await link(completedPath, path); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('يوجد ملف بالاسم نفسه؛ غيّر اسم التنزيل لحفظ الفيديو.');
        throw error;
      }
      await unlink(completedPath);
    }
    await unlink(checkpoint);
    return { path, name, bytes: file.size };
  }
  async #verifyAudio(path, container, signal) {
    const output = await this.#execute(['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,mp3,aac', '-show_entries', 'stream=codec_type,codec_name:format=format_name,duration', '-of', 'json', path], { executable: 'ffprobe.exe', signal, timeoutMs: 10000, maxOutputBytes: 65536 });
    let info;
    try { info = JSON.parse(output); } catch { /* Invalid metadata cannot authorize publication. */ }
    const streams = info?.streams, duration = Number(info?.format?.duration);
    const expectedCodec = container === 'mp3' ? 'mp3' : 'aac';
    if (!Array.isArray(streams) || streams.length !== 1 || streams[0].codec_type !== 'audio' || streams[0].codec_name !== expectedCodec || !Number.isFinite(duration) || duration <= 0 || !String(info?.format?.format_name).split(',').includes(container === 'mp3' ? 'mp3' : 'mov')) {
      throw Object.assign(new Error('ملف الصوت لا يطابق الصيغة المختارة أو يحتوي فيديو؛ لم يُنشر الملف. أعد التنزيل.'), { code: 'media-output-failed' });
    }
  }
}
