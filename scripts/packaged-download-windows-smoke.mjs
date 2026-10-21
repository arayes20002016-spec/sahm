import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { sha256 } from './lib/runtime-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const portable = resolve(argument('--portable') || `dist/${version}/SAHM-win32-x64`);
const directory = resolve(argument('--result-directory') || `artifacts/packaged-download-windows/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const rounds = Number(argument('--rounds') || 3), parallel = Number(argument('--parallel') || 2), uiDelayMs = Number(argument('--ui-delay-ms') || 6500);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
assert.ok(Number.isInteger(parallel) && parallel >= 2 && parallel <= 4);
assert.ok(Number.isInteger(uiDelayMs) && uiDelayMs >= 0 && uiDelayMs <= 10000);
await mkdir(directory, { recursive: true });
const run = promisify(execFile), application = join(portable, 'resources/app.asar');
const env = { ...process.env, NODE_OPTIONS: '' }; delete env.ELECTRON_RUN_AS_NODE;
const report = { ok: false, version, application, rounds, parallel, uiDelayMs, cases: [], overlaps: [],
  automaticRetries: 0, personalProfileUsed: false, installerExecuted: false, virtualMachineUsed: false };
try {
  const runtime = createRequire(import.meta.url)('electron');
  const probe = await run(join(portable, 'SAHM.exe'), ['-e', `console.log(JSON.stringify({electron:process.versions.electron,version:require(${JSON.stringify(join(application, 'package.json'))}).version}))`], {
    windowsHide: true, timeout: 20000, env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  });
  report.shippedRuntime = JSON.parse(probe.stdout.trim()); assert.equal(report.shippedRuntime.version, version);
  const development = await run(runtime, ['-e', 'console.log(process.versions.electron)'], { windowsHide: true, timeout: 20000, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(development.stdout.trim(), report.shippedRuntime.electron);
  report.appAsarSha256 = await sha256(application);
  for (let round = 1; round <= rounds; round++) {
    const controls = Array.from({ length: parallel }, (_, index) => ({ output: join(directory, `round-${round}-worker-${index + 1}`), token: randomUUID(), controller: new AbortController(), finished: false }));
    for (const control of controls) await mkdir(control.output);
    const running = controls.map(async (control, index) => {
      const { output, token, controller } = control;
      try {
        const child = await run(runtime, [join(root, 'scripts/download-windows-smoke.cjs'), '--source-root', application,
          '--result-directory', output, '--ui-delay-ms', String(uiDelayMs), '--control-token', token], { cwd: root, env, signal: controller.signal, windowsHide: true, timeout: 100000, maxBuffer: 1024 * 1024 });
        await writeFile(join(output, 'process.log'), child.stdout + '\n' + child.stderr);
        const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
        assert.ok(result.ok && result.parentBarrierApplied && result.peerCompletedWhileFirstPaused && result.resumedFromSavedOffset);
        assert.equal(result.transport, 'explicit-response-barriers'); assert.equal(result.uiDelayMs, uiDelayMs);
        assert.equal(result.afterUiDelay.length, 2);
        assert.ok(result.afterUiDelay.every(job => job.status === 'downloading' && job.received > 0 && job.received < job.total));
        return { round, worker: index + 1, ok: true, heldAt: result.heldAt, uiReadyAt: result.uiReadyAt, result: join(output, 'result.json') };
      } catch (error) {
        await writeFile(join(output, 'process-error.log'), error.stack + '\n' + (error.stdout || '') + '\n' + (error.stderr || ''));
        return { round, worker: index + 1, ok: false, error: error.stack, result: join(output, 'result.json') };
      } finally { control.finished = true; }
    });
    const completion = Promise.allSettled(running);
    let barrierError;
    try {
      const deadline = Date.now() + 30000;
      while (true) {
        const ready = await Promise.all(controls.map(async control => {
          assert.equal(control.finished, false, 'Window process exited before the shared barrier');
          try { assert.equal(JSON.parse(await readFile(join(control.output, 'held.json'), 'utf8')).token, control.token); return true; }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        }));
        if (ready.every(Boolean)) break;
        assert.ok(Date.now() < deadline, 'Concurrent transfer readiness timed out');
        await delay(25);
      }
      for (const control of controls) {
        const marker = join(control.output, 'continue.json');
        await writeFile(marker + '.tmp', JSON.stringify({ token: control.token })); await rename(marker + '.tmp', marker);
      }
    } catch (error) { barrierError = error; for (const control of controls) control.controller.abort(); }
    const results = await completion;
    const cases = results.map(result => result.status === 'fulfilled' ? result.value : { round, ok: false, error: String(result.reason) });
    report.cases.push(...cases);
    if (barrierError) throw barrierError;
    assert.ok(cases.every(result => result.ok), 'A concurrent window case failed; evidence retained, no retry');
    const milliseconds = Math.min(...cases.map(result => Date.parse(result.uiReadyAt))) - Math.max(...cases.map(result => Date.parse(result.heldAt)));
    assert.ok(milliseconds > 0, 'Window workers did not overlap while transfers were held');
    report.overlaps.push({ round, milliseconds });
    console.log(`WINDOW ROUND ${round}: ${parallel} passed, held overlap ${milliseconds}ms`);
  }
  assert.equal(report.cases.length, rounds * parallel); report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log('PACKAGED DOWNLOAD WINDOWS ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
