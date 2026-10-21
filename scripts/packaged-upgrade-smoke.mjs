import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || 'dist/' + version + '/SAHM-win32-x64');
const runtime = join(portable, 'SAHM.exe'), application = join(portable, 'resources/app.asar');
const directory = resolve('artifacts/packaged-upgrade-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const report = { ok: false, version, runtime, application, installerExecuted: false, virtualMachineUsed: false, shippedApplicationLoadedInMatchingElectron: true, applicationUiLaunchedFromSahmExe: false };
try {
  const probe = await run(runtime, ['-e', 'console.log(JSON.stringify({electron:process.versions.electron,version:require(' + JSON.stringify(join(application, 'package.json')) + ').version}))'], {
    windowsHide: true, timeout: 20000, env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
  });
  report.shippedRuntime = JSON.parse(probe.stdout.trim()); assert.equal(report.shippedRuntime.version, version);
  const environment = { ...process.env, NODE_OPTIONS: '' }; delete environment.ELECTRON_RUN_AS_NODE;
  const output = await run(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url)), [
    fileURLToPath(new URL('./upgrade-smoke.cjs', import.meta.url)), '--source-root', application,
  ], { cwd: resolve('.'), windowsHide: true, timeout: 160000, maxBuffer: 1024 * 1024, env: environment });
  report.stdout = output.stdout; report.stderr = output.stderr;
  const resultFile = /UPGRADE PASS: (.+)/.exec(output.stdout)?.[1]?.trim(); assert.ok(resultFile);
  report.resultFile = resultFile; report.upgrade = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(report.upgrade.ok, true); assert.equal(report.upgrade.finalVersion, version);
  const recent = await run(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url)), [
    fileURLToPath(new URL('./upgrade-smoke.cjs', import.meta.url)), '--source-root', application,
    '--old-root', resolve('dist/0.13.0/SAHM-win32-x64/resources/app.asar'),
  ], { cwd: resolve('.'), windowsHide: true, timeout: 160000, maxBuffer: 1024 * 1024, env: environment });
  const recentFile = /UPGRADE PASS: (.+)/.exec(recent.stdout)?.[1]?.trim(); assert.ok(recentFile);
  report.recentResultFile = recentFile; report.recentUpgrade = JSON.parse(await readFile(recentFile, 'utf8'));
  assert.equal(report.recentUpgrade.ok, true); assert.equal(report.recentUpgrade.previousVersion, '0.13.0');
  assert.equal(report.recentUpgrade.finalVersion, version);
  const fresh = await run(fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url)), [
    fileURLToPath(new URL('./fresh-profile-smoke.cjs', import.meta.url)), '--source-root', application,
  ], { cwd: resolve('.'), windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024, env: environment });
  const freshFile = /FRESH PROFILE PASS: (.+)/.exec(fresh.stdout)?.[1]?.trim(); assert.ok(freshFile);
  report.freshFile = freshFile; report.freshProfile = JSON.parse(await readFile(freshFile, 'utf8'));
  assert.equal(report.freshProfile.ok, true);
  report.ok = true;
} catch (error) { report.error = error.stack; report.stdout = error.stdout; report.stderr = error.stderr; }
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('PACKAGED UPGRADE ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
