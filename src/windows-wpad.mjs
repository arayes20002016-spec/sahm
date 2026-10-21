import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxOutputBytes = 32768;
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = @'
using System;
using System.Runtime.InteropServices;
namespace Sahm {
    public static class WindowsWpad {
        [DllImport("winhttp.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WinHttpDetectAutoProxyConfigUrl(uint flags, out IntPtr url);
        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern IntPtr GlobalFree(IntPtr memory);
        public static object Discover() {
            IntPtr address = IntPtr.Zero;
            try {
                // DHCP (1), then DNS A (2); this discovers a URL only.
                bool ok = WinHttpDetectAutoProxyConfigUrl(3u, out address);
                uint error = ok ? 0u : unchecked((uint)Marshal.GetLastWin32Error());
                string url = ok && address != IntPtr.Zero ? Marshal.PtrToStringUni(address) : null;
                return new { ok = ok, url = url, error = error };
            } finally {
                if (address != IntPtr.Zero) GlobalFree(address);
            }
        }
    }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[Console]::Out.Write(([Sahm.WindowsWpad]::Discover() | ConvertTo-Json -Compress))
`;

function failure(message, code) { return Object.assign(new Error(message), { code }); }

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('أُلغي اكتشاف إعداد الوكيل.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function pacUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value !== value.trim() || /[\x00-\x20\x7f\\]/.test(value)) throw failure('أعاد Windows عنوان PAC غير صالح.', 'wpad-invalid-url');
  let address;
  try { address = new URL(value); } catch { throw failure('أعاد Windows عنوان PAC غير صالح.', 'wpad-invalid-url'); }
  if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password || address.hash) throw failure('أعاد Windows عنوان PAC غير صالح.', 'wpad-invalid-url');
  if (address.href.length > 4096) throw failure('أعاد Windows عنوان PAC غير صالح.', 'wpad-invalid-url');
  return address.href;
}

export async function discoverWindowsPac({ signal, runner = run, platform = process.platform, systemRoot = process.env.SystemRoot, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (platform !== 'win32') throw failure('الاكتشاف التلقائي للوكيل متاح على Windows فقط.', 'wpad-unsupported-platform');
  if (typeof runner !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid WPAD runner or timeout.');
  if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\x00-\x1f\x7f]/.test(systemRoot)) throw failure('تعذّر تحديد أدوات Windows لاكتشاف الوكيل.', 'wpad-unavailable');
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  let output;
  try {
    output = await runner(executable, args, { signal, windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxOutputBytes });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw abortError(signal);
    if ((error?.killed && error?.signal === 'SIGKILL') || error?.code === 'ETIMEDOUT') throw failure('انتهت مهلة الاكتشاف التلقائي للوكيل.', 'wpad-discovery-timeout');
    if (error?.code === 'ENOENT') throw failure('أداة اكتشاف الوكيل في Windows غير متاحة.', 'wpad-unavailable');
    throw failure('تعذّر اكتشاف إعداد الوكيل في Windows.', 'wpad-discovery-failed');
  }
  if (signal?.aborted) throw abortError(signal);
  if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout, 'utf8') > maxOutputBytes) throw failure('أعاد Windows نتيجة اكتشاف غير صالحة.', 'wpad-invalid-result');
  let result;
  try { result = JSON.parse(output.stdout.trim()); } catch { throw failure('أعاد Windows نتيجة اكتشاف غير صالحة.', 'wpad-invalid-result'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !['ok', 'url', 'error'].includes(key)) || typeof result.ok !== 'boolean' || !Number.isInteger(result.error) || result.error < 0 || result.error > 0xffffffff) throw failure('أعاد Windows نتيجة اكتشاف غير صالحة.', 'wpad-invalid-result');
  if (!result.ok) {
    if (result.url !== null) throw failure('أعاد Windows نتيجة اكتشاف غير صالحة.', 'wpad-invalid-result');
    if (result.error === 12180) return null;
    const error = failure('لم يستطع Windows إكمال اكتشاف الوكيل.', 'wpad-discovery-failed');
    error.windowsError = result.error;
    throw error;
  }
  if (result.error !== 0) throw failure('أعاد Windows نتيجة اكتشاف غير صالحة.', 'wpad-invalid-result');
  return pacUrl(result.url);
}
