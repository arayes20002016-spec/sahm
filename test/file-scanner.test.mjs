import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeScannerConfig, scanDownloadedFile } from '../src/file-scanner.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-scanner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'download & $(echo secret).bin');
  await writeFile(path, 'a harmless test file created by this test');
  const program = join(directory, 'scanner-fixture.mjs');
  await writeFile(program, "import {readFile,writeFile} from 'node:fs/promises'; const [file,out,code,wait] = process.argv.slice(2); await writeFile(out, JSON.stringify({file,content:await readFile(file,'utf8')})); console.log('UNTRUSTED OUTPUT \\x1b[31m '+file); console.error('DO NOT SAVE STDERR'); if(wait==='wait') setInterval(()=>{},1000); else process.exit(Number(code));");
  return { directory, path, program, output: join(directory, 'invocation.json') };
}

test('file scanner defaults to disabled and cannot start a process before opt-in', async () => {
  assert.equal(normalizeScannerConfig().enabled, false);
  let calls = 0;
  const result = await scanDownloadedFile('a path that does not exist', {}, { spawnProcess() { calls++; }, findDefender() { calls++; } });
  assert.equal(result.status, 'skipped'); assert.equal(result.code, 'scan-disabled'); assert.equal(calls, 0);
});

test('file scanner validates an explicit EXE, literal argument array, placeholder and bounded timeout', () => {
  assert.throws(() => normalizeScannerConfig({ enabled: true, mode: 'custom', executable: 'scanner.exe' }));
  assert.throws(() => normalizeScannerConfig({ enabled: true, mode: 'custom', executable: 'C:\\scan.cmd' }));
  assert.throws(() => normalizeScannerConfig({ args: ['--scan'] }));
  assert.throws(() => normalizeScannerConfig({ args: ['{file}\n'] }));
  assert.throws(() => normalizeScannerConfig({ timeoutMs: 999 }));
  assert.throws(() => normalizeScannerConfig({ timeoutMs: 900001 }));
  const value = normalizeScannerConfig({ mode: 'custom', enabled: true, executable: process.execPath, args: ['{file}'] });
  assert.equal(value.executable, process.execPath);
});

test('custom scanner passes a metacharacter filename literally to a real process and sanitizes output', async t => {
  const f = await fixture(t);
  const result = await scanDownloadedFile(f.path, { enabled: true, mode: 'custom', executable: process.execPath, args: [f.program, '{file}', f.output, '0'] });
  assert.equal(result.status, 'clean'); assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), { file: f.path, content: 'a harmless test file created by this test' });
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED|STDERR|secret|scanner-fixture|harmless/);
});

test('custom scanner nonzero exit requests review and never claims the file is clean', async t => {
  const f = await fixture(t);
  const result = await scanDownloadedFile(f.path, { enabled: true, mode: 'custom', executable: process.execPath, args: [f.program, '{file}', f.output, '2'] });
  assert.equal(result.status, 'attention'); assert.equal(result.code, 'scan-needs-review'); assert.equal(result.exitCode, 2);
});

test('scanner timeout and cancellation stop their real fixture process', async t => {
  const f = await fixture(t), config = { enabled: true, mode: 'custom', executable: process.execPath, args: [f.program, '{file}', f.output, '0', 'wait'], timeoutMs: 1000 };
  const timed = await scanDownloadedFile(f.path, config);
  assert.equal(timed.status, 'error'); assert.equal(timed.code, 'scan-timeout');
  const controller = new AbortController();
  const running = scanDownloadedFile(f.path, config, { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  const cancelled = await running;
  assert.equal(cancelled.status, 'error'); assert.equal(cancelled.code, 'scan-cancelled');
});

test('missing scanner and missing file return an error without executing other programs', async t => {
  const f = await fixture(t);
  const result = await scanDownloadedFile(f.path, { enabled: true, mode: 'custom', executable: join(f.directory, 'absent.exe') });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'scan-program-unavailable');
  let started = false;
  const missing = await scanDownloadedFile(join(f.directory, 'absent.bin'), { enabled: true }, { spawnProcess() { started = true; } });
  assert.equal(missing.status, 'error'); assert.equal(started, false);
});

test('Defender uses a file-only scan without remediation and treats code 2 as ambiguous', async t => {
  const f = await fixture(t), invocations = [];
  const result = await scanDownloadedFile(f.path, { enabled: true, mode: 'defender' }, {
    findDefender: async () => 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
    spawnProcess(executable, args, options) {
      invocations.push({ executable, args, options });
      const child = new EventEmitter(); child.stdout = { resume() {} }; child.stderr = { resume() {} }; child.kill = () => {};
      queueMicrotask(() => child.emit('close', 2)); return child;
    },
  });
  assert.deepEqual(invocations[0].args, ['-Scan', '-ScanType', '3', '-File', f.path, '-DisableRemediation']);
  assert.equal(invocations[0].options.shell, false); assert.equal(invocations[0].options.windowsHide, true);
  assert.equal(result.status, 'attention'); assert.equal(result.code, 'scan-needs-review');
});

test('scanner cancellation remains bounded if the child never emits close', async t => {
  const f = await fixture(t), controller = new AbortController();
  let killed = false;
  const result = scanDownloadedFile(f.path, { enabled: true }, {
    signal: controller.signal, findDefender: async () => 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
    spawnProcess() {
      const child = new EventEmitter(); child.stdout = { resume() {} }; child.stderr = { resume() {} };
      child.kill = () => { killed = true; }; queueMicrotask(() => controller.abort()); return child;
    },
  });
  assert.equal((await result).code, 'scan-cancelled'); assert.equal(killed, true);
});
