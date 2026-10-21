import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('VM diagnostics serialize plain log strings promptly on Windows PowerShell 5.1', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sahm-vm-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./fixtures/vm/report-serialization.ps1', import.meta.url));
  const source = fileURLToPath(new URL('../scripts/vm/guest-tests.ps1', import.meta.url));
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Directory', directory, '-Source', source],
    { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(result.powerShellMajor, 5);
  assert.equal(result.lines, 200);
  assert.equal(result.plainStrings, true);
  assert.ok(result.jsonBytes < 16384);
});
