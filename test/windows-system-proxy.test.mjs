import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWindowsSystemProxy } from '../src/windows-system-proxy.mjs';

const run = promisify(execFile);
const options = { platform: 'win32', systemRoot: 'C:\\Windows' };
const result = (fields = {}) => ({ ok: true, error: 0, autoDetect: false, proxy: null, proxyBypass: null, autoConfigUrl: null, ...fields });
const output = fields => ({ stdout: JSON.stringify(result(fields)), stderr: '' });
const withOutput = value => ({ ...options, runner: async () => ({ stdout: value, stderr: '' }) });

test('system proxy reading uses a fixed native read-only command and frees all three WinHTTP allocations', async () => {
  let captured;
  const settings = await readWindowsSystemProxy({ ...options, runner: async (...args) => { captured = args; return output({ autoDetect: true }); } });
  assert.deepEqual(settings, { ProxyEnable: '0', ProxyServer: '', ProxyOverride: '', AutoConfigURL: '', AutoDetect: '1' });
  const [executable, args, config] = captured;
  assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(source, /WinHttpGetIEProxyConfigForCurrentUser\(ref config\)/);
  assert.match(source, /StructLayout\(LayoutKind.Sequential\)/);
  assert.match(source, /MarshalAs\(UnmanagedType.Bool\)/);
  for (const pointer of ['AutoConfigUrl', 'Proxy', 'ProxyBypass']) assert.match(source, new RegExp(`finally[\\s\\S]*GlobalFree\\(config\\.${pointer}\\)`));
  for (const forbidden of ['reg.exe', 'Set-ItemProperty', 'WinHttpDetectAutoProxyConfigUrl', 'WinHttpGetProxyForUrl', 'Invoke-WebRequest', 'DownloadString']) assert.equal(source.includes(forbidden), false);
  assert.equal(config.windowsHide, true); assert.equal(config.shell, false); assert.equal(config.encoding, 'utf8');
  assert.equal(config.timeout, 10000); assert.equal(config.maxBuffer, 32768); assert.equal(config.killSignal, 'SIGKILL');
});

test('native proxy, bypass, PAC and auto-detection values preserve their meanings independently', async () => {
  const fields = { proxy: 'http=proxy.example.test:8080;https=secure.example.test:8443', proxyBypass: 'localhost;<local>;*.internal.test', autoConfigUrl: 'https://pac.example.test/config.pac', autoDetect: true };
  assert.deepEqual(await readWindowsSystemProxy({ ...options, runner: async () => output(fields) }), { ProxyEnable: '1', ProxyServer: fields.proxy, ProxyOverride: fields.proxyBypass, AutoConfigURL: fields.autoConfigUrl, AutoDetect: '1' });
  const pacOnly = await readWindowsSystemProxy({ ...options, runner: async () => output({ autoConfigUrl: fields.autoConfigUrl }) });
  assert.equal(pacOnly.ProxyEnable, '0'); assert.equal(pacOnly.AutoConfigURL, fields.autoConfigUrl); assert.equal(pacOnly.AutoDetect, '0');
});

test('malformed and contradictory native results cannot silently become direct networking', async () => {
  const invalid = ['', 'not-json', '[]', 'null', '{}', ' '.repeat(32769)];
  for (const fields of [{ ok: 1 }, { error: -1 }, { error: 0x100000000 }, { ok: true, error: 8 }, { ok: false, error: 0 }, { ok: false, error: 2, autoDetect: true }, { ok: false, error: 2, proxy: 'private.example.test:80' }, { autoDetect: 'true' }, { proxy: 1 }, { proxyBypass: [] }, { autoConfigUrl: {} }, { extra: 'command' }, { proxy: 'a'.repeat(8193) }, { proxyBypass: 'a'.repeat(16385) }, { autoConfigUrl: 'a'.repeat(4097) }, { proxy: 'private\naddress' }]) invalid.push(JSON.stringify(result(fields)));
  for (const value of invalid) await assert.rejects(readWindowsSystemProxy(withOutput(value)), { code: 'windows-system-proxy-invalid-result' });
  await assert.rejects(readWindowsSystemProxy({ ...options, runner: async () => ({}) }), { code: 'windows-system-proxy-invalid-result' });
});

test('native and process errors retain safe codes without disclosing private setting values', async () => {
  await assert.rejects(readWindowsSystemProxy(withOutput(JSON.stringify(result({ ok: false, error: 2 })))), failure => failure.code === 'windows-system-proxy-failed' && failure.windowsError === 2);
  for (const [problem, expected] of [[new Error('private-host private-URL'), 'windows-system-proxy-failed'], [Object.assign(new Error('private-host'), { code: 'ENOENT' }), 'windows-system-proxy-unavailable'], [Object.assign(new Error('private-host'), { code: 'ETIMEDOUT' }), 'windows-system-proxy-timeout'], [Object.assign(new Error('private-host'), { killed: true, signal: 'SIGKILL' }), 'windows-system-proxy-timeout']]) {
    await assert.rejects(readWindowsSystemProxy({ ...options, runner: async () => { throw problem; } }), failure => {
      assert.equal(failure.code, expected); assert.equal(failure.cause, undefined); assert.ok(!String(failure.stack).includes('private-')); return true;
    });
  }
});

test('platform, runner, executable root, timeout and signal are checked before creating a process', async () => {
  let calls = 0;
  const runner = async () => { calls++; return output(); };
  assert.deepEqual(await readWindowsSystemProxy({ ...options, platform: 'linux', runner }), {});
  for (const systemRoot of [null, '', 'powershell.exe', '\\\\host\\Windows', 'C:\\Win\ndows', 'C:\\' + 'a'.repeat(4096)]) await assert.rejects(readWindowsSystemProxy({ ...options, systemRoot, runner }), { code: 'windows-system-proxy-unavailable' });
  for (const timeoutMs of [0, -1, 1.5, 120001, '10000']) await assert.rejects(readWindowsSystemProxy({ ...options, timeoutMs, runner }), TypeError);
  await assert.rejects(readWindowsSystemProxy({ ...options, runner: null }), TypeError);
  await assert.rejects(readWindowsSystemProxy({ ...options, signal: {} }), TypeError);
  assert.equal(calls, 0);
});

test('aborting before, during and after the helper never returns stale proxy settings', async () => {
  let calls = 0;
  const stopped = new AbortController(); stopped.abort(new Error('private cancellation reason'));
  await assert.rejects(readWindowsSystemProxy({ ...options, signal: stopped.signal, runner: async () => { calls++; return output(); } }), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(readWindowsSystemProxy({ ...options, signal: controller.signal, runner: async (_exe, _args, config) => { assert.equal(config.signal, controller.signal); controller.abort(); return output(); } }), { name: 'AbortError' });
  await assert.rejects(readWindowsSystemProxy({ ...options, runner: async () => { throw Object.assign(new Error('private cancellation reason'), { name: 'AbortError', code: 'ABORT_ERR' }); } }), failure => failure.name === 'AbortError' && !failure.message.includes('private'));
});

test('the native WinHTTP reader executes against current Windows settings without writing settings or printing addresses', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const settings = await readWindowsSystemProxy({ timeoutMs: 25000 });
  assert.deepEqual(Object.keys(settings).sort(), ['AutoConfigURL', 'AutoDetect', 'ProxyEnable', 'ProxyOverride', 'ProxyServer'].sort());
  assert.ok(['0', '1'].includes(settings.AutoDetect)); assert.ok(['0', '1'].includes(settings.ProxyEnable));
  t.diagnostic(JSON.stringify({ nativeRead: true, proxyConfigured: settings.ProxyEnable === '1', automaticDetection: settings.AutoDetect === '1', pacConfigured: Boolean(settings.AutoConfigURL), bypassEntries: settings.ProxyOverride.split(';').filter(Boolean).length }));
});

test('timeouts and cancellation stop a real Windows helper without invoking native proxy reads', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const sleeper = async (executable, args, config) => run(executable, [...args.slice(0, -1), Buffer.from('Start-Sleep -Seconds 60', 'utf16le').toString('base64')], config);
  await assert.rejects(readWindowsSystemProxy({ runner: sleeper, timeoutMs: 100 }), { code: 'windows-system-proxy-timeout' });
  const controller = new AbortController(), pending = readWindowsSystemProxy({ runner: sleeper, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});
