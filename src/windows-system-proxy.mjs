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
    public static class WindowsSystemProxy {
        [StructLayout(LayoutKind.Sequential)]
        private struct ProxyConfig {
            [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
            public IntPtr AutoConfigUrl;
            public IntPtr Proxy;
            public IntPtr ProxyBypass;
        }
        [DllImport("winhttp.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool WinHttpGetIEProxyConfigForCurrentUser(ref ProxyConfig config);
        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern IntPtr GlobalFree(IntPtr memory);
        public static object Read() {
            ProxyConfig config = new ProxyConfig();
            try {
                bool ok = WinHttpGetIEProxyConfigForCurrentUser(ref config);
                uint error = ok ? 0u : unchecked((uint)Marshal.GetLastWin32Error());
                return new {
                    ok = ok,
                    error = error,
                    autoDetect = ok && config.AutoDetect,
                    proxy = ok && config.Proxy != IntPtr.Zero ? Marshal.PtrToStringUni(config.Proxy) : null,
                    proxyBypass = ok && config.ProxyBypass != IntPtr.Zero ? Marshal.PtrToStringUni(config.ProxyBypass) : null,
                    autoConfigUrl = ok && config.AutoConfigUrl != IntPtr.Zero ? Marshal.PtrToStringUni(config.AutoConfigUrl) : null
                };
            } finally {
                if (config.AutoConfigUrl != IntPtr.Zero) GlobalFree(config.AutoConfigUrl);
                if (config.Proxy != IntPtr.Zero) GlobalFree(config.Proxy);
                if (config.ProxyBypass != IntPtr.Zero) GlobalFree(config.ProxyBypass);
            }
        }
    }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[Console]::Out.Write(([Sahm.WindowsSystemProxy]::Read() | ConvertTo-Json -Compress))
`;

function failure(message, code) { return Object.assign(new Error(message), { code }); }
function aborted() { return Object.assign(new Error('أُلغيت قراءة إعدادات وكيل Windows.'), { name: 'AbortError', code: 'ABORT_ERR' }); }
function invalidResult() { return failure('أعاد Windows إعدادات وكيل غير صالحة.', 'windows-system-proxy-invalid-result'); }

function setting(value, maximum) {
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw invalidResult();
  return value;
}

export async function readWindowsSystemProxy({ runner = run, platform = process.platform, signal, systemRoot = process.env.SystemRoot, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) throw aborted();
  if (platform !== 'win32') return {};
  if (typeof runner !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid Windows system proxy reader options.');
  if (typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || systemRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(systemRoot)) throw failure('تعذّر تحديد أداة قراءة إعدادات وكيل Windows.', 'windows-system-proxy-unavailable');
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  let output;
  try {
    output = await runner(executable, args, { signal, windowsHide: true, shell: false, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxOutputBytes });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw aborted();
    if (error?.code === 'ETIMEDOUT' || error?.killed && error?.signal === 'SIGKILL') throw failure('انتهت مهلة قراءة إعدادات وكيل Windows.', 'windows-system-proxy-timeout');
    if (error?.code === 'ENOENT') throw failure('أداة قراءة إعدادات وكيل Windows غير متاحة.', 'windows-system-proxy-unavailable');
    throw failure('تعذّرت قراءة إعدادات وكيل Windows.', 'windows-system-proxy-failed');
  }
  if (signal?.aborted) throw aborted();
  if (typeof output?.stdout !== 'string' || Buffer.byteLength(output.stdout, 'utf8') > maxOutputBytes) throw invalidResult();
  let result;
  try { result = JSON.parse(output.stdout.trim()); } catch { throw invalidResult(); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !['ok', 'error', 'autoDetect', 'proxy', 'proxyBypass', 'autoConfigUrl'].includes(key)) || typeof result.ok !== 'boolean' || typeof result.autoDetect !== 'boolean' || !Number.isInteger(result.error) || result.error < 0 || result.error > 0xffffffff) throw invalidResult();
  const proxy = setting(result.proxy, 8192), bypass = setting(result.proxyBypass, 16384), pac = setting(result.autoConfigUrl, 4096);
  if (!result.ok) {
    if (!result.error || result.autoDetect || proxy || bypass || pac) throw invalidResult();
    const error = failure('لم يستطع Windows قراءة إعدادات الوكيل الحالية.', 'windows-system-proxy-failed');
    error.windowsError = result.error;
    throw error;
  }
  if (result.error !== 0) throw invalidResult();
  return { ProxyEnable: proxy.trim() ? '1' : '0', ProxyServer: proxy, ProxyOverride: bypass, AutoConfigURL: pac, AutoDetect: result.autoDetect ? '1' : '0' };
}
