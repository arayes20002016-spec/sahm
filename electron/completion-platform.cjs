const { t: __sahmT } = require('./locale.cjs');
const { execFile: executeFile } = require('node:child_process');
const path = require('node:path');

// A fixed native call preserves wake events and enables only the shutdown
// privilege required by SetSuspendState. No user input becomes PowerShell code.
const suspendSource = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SahmSleep {
  [StructLayout(LayoutKind.Sequential)] struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public uint Count; public LUID Luid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out LUID value);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES privileges, uint length, IntPtr previous, IntPtr required);
  [DllImport("powrprof.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.U1)]
  static extern bool SetSuspendState([MarshalAs(UnmanagedType.U1)] bool hibernate, [MarshalAs(UnmanagedType.U1)] bool force, [MarshalAs(UnmanagedType.U1)] bool disableWakeEvents);
  public static void Run() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      LUID luid;
      if (!LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
      TOKEN_PRIVILEGES privileges = new TOKEN_PRIVILEGES { Count=1, Luid=luid, Attributes=2 };
      if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int error = Marshal.GetLastWin32Error();
      if (error != 0) throw new Win32Exception(error);
      if (!SetSuspendState(false, false, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(token); }
  }
}`;
const suspendCommand = "$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n" + suspendSource + "\n'@\n[SahmSleep]::Run()";

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createCompletionPlatform({ app, Notification, shell, showWindow = () => {}, getDirectory = () => app.getPath('downloads'), execFile = executeFile, platform = process.platform, systemRoot = process.env.SystemRoot } = {}) {
  if (!app || typeof app.quit !== 'function' || typeof execFile !== 'function' || typeof getDirectory !== 'function') throw new TypeError('Completion platform callbacks are required.');

  async function nativePower(type) {
    if (platform !== 'win32' || typeof systemRoot !== 'string' || !/^[a-z]:[\\/]/i.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) throw failure(__sahmT("إجراءات الطاقة متاحة على Windows فقط."), 'unsupported-platform');
    const systemDirectory = path.win32.join(systemRoot, 'System32');
    const executable = path.win32.join(systemDirectory, type === 'sleep' ? 'WindowsPowerShell\\v1.0\\powershell.exe' : 'shutdown.exe');
    // A positive shutdown /t implies /f on Windows. SAHM owns the preceding
    // cancellable countdown and passes /t 0 so open apps can protect their work.
    const args = type === 'shutdown' ? ['/s', '/t', '0'] : type === 'hibernate' ? ['/h'] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(suspendCommand, 'utf16le').toString('base64')];
    await new Promise((resolve, reject) => {
      const failed = () => reject(failure(__sahmT("تعذّر تنفيذ إجراء الطاقة. قد تمنعه صلاحيات Windows أو إعدادات الجهاز."), 'power-action-failed'));
      try {
        execFile(executable, args, { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 65536 }, error => error ? failed() : resolve());
      } catch { failed(); }
    });
  }

  return {
    announce(status) {
      if (status?.state !== 'pending' || !(status.remainingSeconds > 0) || !Notification?.isSupported?.()) return false;
      const labels = { notify: __sahmT("عرض إشعار"), 'open-folder': __sahmT("فتح مجلد التنزيلات"), exit: __sahmT("إغلاق سَهم"), shutdown: __sahmT("إيقاف تشغيل الجهاز"), sleep: __sahmT("السكون"), hibernate: __sahmT("الإسبات") };
      if (!labels[status.type]) return false;
      const notification = new Notification({ title: __sahmT("سَهم — إجراء بعد اكتمال التنزيل"), body: __sahmT("{0} بعد {1} ثانية. انقر لفتح سَهم وإلغاء الإجراء.", [labels[status.type], status.remainingSeconds]), silent: true });
      notification.on('click', showWindow);
      notification.show();
      return true;
    },
    async execute(status) {
      if (!status || typeof status !== 'object') throw failure(__sahmT("إجراء الاكتمال غير صالح."), 'invalid-action');
      if (status.type === 'none') return;
      if (status.type === 'notify') {
        if (!Notification?.isSupported?.()) throw failure(__sahmT("إشعارات Windows غير متاحة على هذا الجهاز."), 'notification-unavailable');
        const name = typeof status.queueName === 'string' ? status.queueName.slice(0, 80) : __sahmT("قائمة التنزيل");
        new Notification({ title: __sahmT("سَهم — اكتملت التنزيلات"), body: __sahmT("اكتملت ملفات «{0}».", [name]), silent: true }).show();
        return;
      }
      if (status.type === 'open-folder') {
        const directory = getDirectory();
        if (typeof directory !== 'string' || !path.isAbsolute(directory) || !shell || typeof shell.openPath !== 'function') throw failure(__sahmT("مجلد التنزيلات غير متاح."), 'folder-unavailable');
        if (await shell.openPath(directory)) throw failure(__sahmT("تعذّر فتح مجلد التنزيلات."), 'folder-open-failed');
        return;
      }
      if (status.type === 'exit') { app.quit(); return; }
      if (['shutdown', 'sleep', 'hibernate'].includes(status.type)) { await nativePower(status.type); return; }
      throw failure(__sahmT("إجراء الاكتمال غير صالح."), 'invalid-action');
    }
  };
}

module.exports = { createCompletionPlatform };

