import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverWindowsPac } from '../src/windows-wpad.mjs';

const run = promisify(execFile);
const options = { platform: 'win32', systemRoot: 'C:\\Windows' };
const output = (url = 'http://wpad.example.test/wpad.dat') => ({ stdout: JSON.stringify({ ok: true, error: 0, url }), stderr: '' });
const from = stdout => ({ ...options, runner: async () => ({ stdout, stderr: '' }) });
const code = expected => error => error.code === expected;

test('WPAD uses a fixed encoded command and trusted system executable with bounded execution', async () => {
  let captured;
  assert.equal(await discoverWindowsPac({ ...options, runner: async (...args) => { captured = args; return output('HTTPS://WPAD.Example.test:443/proxy.pac'); } }), 'https://wpad.example.test/proxy.pac');
  const [executable, args, config] = captured;
  assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(source, /WinHttpDetectAutoProxyConfigUrl\(3u, out address\)/);
  assert.match(source, /SetLastError = true/); assert.match(source, /finally[\s\S]*GlobalFree\(address\)/);
  for (const forbidden of ['Invoke-WebRequest', 'Invoke-RestMethod', 'Set-ItemProperty', 'reg.exe', 'DownloadString', 'WinHttpGetProxyForUrl']) assert.equal(source.includes(forbidden), false);
  assert.equal(config.windowsHide, true); assert.equal(config.shell, false); assert.equal(config.timeout, 15000);
  assert.equal(config.maxBuffer, 32768); assert.equal(config.encoding, 'utf8'); assert.equal(config.killSignal, 'SIGKILL');
});

test('no PAC found is distinct from an OS or process failure', async () => {
  assert.equal(await discoverWindowsPac(from('{"ok":false,"url":null,"error":12180}')), null);
  await assert.rejects(discoverWindowsPac(from('{"ok":false,"url":null,"error":8}')), error => error.code === 'wpad-discovery-failed' && error.windowsError === 8);
  await assert.rejects(discoverWindowsPac({ ...options, runner: async () => { throw Object.assign(new Error('stderr with sensitive data'), { code: 'ENOENT' }); } }), code('wpad-unavailable'));
  await assert.rejects(discoverWindowsPac({ ...options, runner: async () => { throw new Error('sensitive URL'); } }), error => error.code === 'wpad-discovery-failed' && !error.message.includes('sensitive'));
});

test('PAC discoveries reject unsafe protocols, credentials, control characters, ambiguous URLs and excessive length', async () => {
  for (const url of [null, 1, '', 'file:///C:/proxy.pac', 'ftp://wpad.example.test/wpad.dat', 'javascript:alert(1)', '//wpad.example.test/wpad.dat', 'http://user:pass@wpad.example.test/wpad.dat', 'http://user@wpad.example.test/wpad.dat', 'http://wpad.example.test/a#fragment', 'http://wpad.example.test/a\\b', 'http://wpad.example.test/a\nb', ' http://wpad.example.test/a', 'http://wpad.example.test/a ', 'http://wpad.example.test/a b', `http://wpad.example.test/${'a'.repeat(4096)}`]) {
    await assert.rejects(discoverWindowsPac({ ...options, runner: async () => output(url) }), code('wpad-invalid-url'));
  }
  assert.equal(await discoverWindowsPac({ ...options, runner: async () => output('https://wpad.example.test/proxy.pac?version=2') }), 'https://wpad.example.test/proxy.pac?version=2');
});

test('malformed, oversized or contradictory process output cannot silently permit a direct connection', async () => {
  for (const value of ['', 'not json', '[]', 'null', '{}', '{"ok":1,"error":0,"url":"http://wpad/a"}', '{"ok":true,"error":8,"url":"http://wpad/a"}', '{"ok":false,"error":-1}', '{"ok":false,"error":4294967296}', '{"ok":false,"error":12180,"url":"http://wpad/a"}', '{"ok":false,"error":12180}', '{"ok":false,"error":12180,"url":null,"command":"bad"}', ' '.repeat(32769)]) {
    await assert.rejects(discoverWindowsPac(from(value)), code('wpad-invalid-result'));
  }
  await assert.rejects(discoverWindowsPac({ ...options, runner: async () => ({}) }), code('wpad-invalid-result'));
});

test('WPAD checks the platform, executable root and execution limits before starting a process', async () => {
  let calls = 0;
  const runner = async () => { calls++; return output(); };
  await assert.rejects(discoverWindowsPac({ ...options, platform: 'linux', runner }), code('wpad-unsupported-platform'));
  for (const systemRoot of [null, '', 'powershell.exe', '\\\\host\\Windows', 'C:\\Win\ndows']) await assert.rejects(discoverWindowsPac({ ...options, systemRoot, runner }), code('wpad-unavailable'));
  for (const timeoutMs of [0, -1, 1.5, 120001, '15000']) await assert.rejects(discoverWindowsPac({ ...options, timeoutMs, runner }), TypeError);
  assert.equal(calls, 0);
});

test('abort before and during discovery never returns a PAC URL', async () => {
  const stopped = new AbortController(); stopped.abort(); let called = false;
  await assert.rejects(discoverWindowsPac({ ...options, signal: stopped.signal, runner: async () => { called = true; return output(); } }), error => error.name === 'AbortError');
  assert.equal(called, false);
  const controller = new AbortController();
  await assert.rejects(discoverWindowsPac({ ...options, signal: controller.signal, runner: async (_exe, _args, config) => { assert.equal(config.signal, controller.signal); controller.abort(); return output(); } }), error => error.name === 'AbortError');
});

test('timeout and abort errors are distinguishable and do not expose process output', async () => {
  for (const error of [Object.assign(new Error('private'), { killed: true, signal: 'SIGKILL' }), Object.assign(new Error('private'), { code: 'ETIMEDOUT' })]) {
    await assert.rejects(discoverWindowsPac({ ...options, timeoutMs: 20, runner: async (_exe, _args, config) => { assert.equal(config.timeout, 20); throw error; } }), code('wpad-discovery-timeout'));
  }
  await assert.rejects(discoverWindowsPac({ ...options, runner: async () => { throw Object.assign(new Error('private'), { code: 'ABORT_ERR', name: 'AbortError' }); } }), error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
});

test('the shipped C# PInvoke compiles on Windows without invoking DHCP, DNS or PAC discovery', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  let captured;
  await discoverWindowsPac({ platform: 'win32', runner: async (...args) => { captured = args; return output(); } });
  const [executable, args] = captured;
  const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  const invoke = '[Console]::Out.Write(([Sahm.WindowsWpad]::Discover() | ConvertTo-Json -Compress))';
  assert.equal(source.split(invoke).length, 2);
  const compileOnly = source.replace(invoke, "[Console]::Out.Write('compiled-without-discovery')");
  const { stdout } = await run(executable, [...args.slice(0, -1), Buffer.from(compileOnly, 'utf16le').toString('base64')], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 25000, maxBuffer: 32768 });
  assert.equal(stdout.trim(), 'compiled-without-discovery');
});

test('Windows discovery cancellation and timeout terminate a real helper process without network activity', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const sleeper = async (executable, args, config) => {
    const sleep = Buffer.from('Start-Sleep -Seconds 60', 'utf16le').toString('base64');
    return run(executable, [...args.slice(0, -1), sleep], config);
  };
  await assert.rejects(discoverWindowsPac({ runner: sleeper, timeoutMs: 100 }), code('wpad-discovery-timeout'));
  const controller = new AbortController();
  const pending = discoverWindowsPac({ runner: sleeper, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, error => error.name === 'AbortError'); }
  finally { clearTimeout(timer); }
});
