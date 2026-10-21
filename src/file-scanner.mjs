import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const defaultTimeout = 120000;
const controls = /[\x00-\x1f\x7f]/;

export function normalizeScannerConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('إعدادات فحص الملفات غير صالحة.');
  const enabled = input.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('خيار تفعيل الفحص غير صالح.');
  const mode = input.mode || 'defender';
  if (!['defender', 'custom'].includes(mode)) throw new Error('اختر Windows Defender أو برنامج فحص مخصصًا.');
  const timeoutMs = input.timeoutMs ?? defaultTimeout;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15 * 60 * 1000) throw new Error('مهلة الفحص من ثانية إلى 15 دقيقة.');
  const executable = input.executable || '';
  if (typeof executable !== 'string' || executable.length > 4096 || controls.test(executable)) throw new Error('مسار برنامج الفحص غير صالح.');
  if (mode === 'custom' && enabled && (!isAbsolute(executable) || !/\.exe$/i.test(executable))) throw new Error('اختر المسار الكامل لبرنامج فحص EXE.');
  const args = input.args ?? ['{file}'];
  if (!Array.isArray(args) || args.length > 32 || args.some(value => typeof value !== 'string' || value.length > 4096 || controls.test(value))) throw new Error('وسيطات برنامج الفحص غير صالحة.');
  if (args.join('').length > 16000 || !args.some(value => value.includes('{file}'))) throw new Error('أضف {file} إلى وسيطات برنامج الفحص لتحديد الملف.');
  // Defender has fixed arguments; retain custom settings for switching back.
  return { enabled, mode, executable, args: [...args], timeoutMs };
}

export async function locateDefender() {
  if (process.platform !== 'win32') return null;
  const platform = join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  let versions = [];
  try {
    versions = (await readdir(platform, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+){3}(?:-\d+)?$/.test(entry.name))
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch {}
  const candidates = versions.map(version => join(platform, version, 'MpCmdRun.exe'));
  candidates.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'));
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}

export async function scanDownloadedFile(path, configuration, {
  signal, spawnProcess = spawn, findDefender = locateDefender,
} = {}) {
  const config = normalizeScannerConfig(configuration);
  const started = Date.now();
  const result = (status, code, exitCode = null) => ({ status, code, engine: config.mode, exitCode, scannedAt: new Date().toISOString(), durationMs: Date.now() - started });
  if (!config.enabled) return result('skipped', 'scan-disabled');
  if (signal?.aborted) return result('error', 'scan-cancelled');
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 8192 || controls.test(path)) return result('error', 'scan-invalid-file');
  try { if (!(await stat(path)).isFile()) return result('error', 'scan-invalid-file'); }
  catch { return result('error', 'scan-file-unavailable'); }
  let executable;
  try { executable = config.mode === 'defender' ? await findDefender() : config.executable; }
  catch { return result('error', 'scan-program-unavailable'); }
  if (!executable) return result('error', 'scan-program-unavailable');
  if (signal?.aborted) return result('error', 'scan-cancelled');
  const args = config.mode === 'defender'
    ? ['-Scan', '-ScanType', '3', '-File', path, '-DisableRemediation']
    : config.args.map(value => value.replaceAll('{file}', path));
  if ([executable, ...args].join(' ').length > 30000) return result('error', 'scan-arguments-too-long');
  return new Promise(resolve => {
    let child, timer, finished = false, interrupted;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const stop = code => {
      interrupted = code;
      try { child?.kill(); } catch {}
      finish(result('error', code));
    };
    const abort = () => stop('scan-cancelled');
    try {
      child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      // Antivirus output can contain filenames, identifiers and terminal control
      // sequences. Keep only the bounded exit code, never its untrusted text.
      child.stdout?.resume(); child.stderr?.resume();
      child.once('error', () => finish(result('error', 'scan-program-unavailable')));
      child.once('close', exitCode => {
        if (interrupted) finish(result('error', interrupted));
        else if (exitCode === 0) finish(result('clean', 'scan-clean', 0));
        else if (Number.isInteger(exitCode)) finish(result('attention', 'scan-needs-review', exitCode));
        else finish(result('error', 'scan-process-stopped'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('scan-timeout'), config.timeoutMs);
      if (signal?.aborted) abort();
    } catch { finish(result('error', 'scan-program-unavailable')); }
  });
}
