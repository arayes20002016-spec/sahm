import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || `dist/${version}/SAHM-win32-x64`);
const runtime = join(portable, 'SAHM.exe'), application = join(portable, 'resources', 'app.asar');
await stat(runtime); await stat(application);
const directory = resolve('artifacts', 'packaged-site-routes-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const electronRuntime = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
const report = { ok: false, version, runtime, application, electronRuntime, directory, applicationUiLaunchedFromSahmExe: false, shippedApplicationLoadedInMatchingElectron: true, operatingSystemSettingsChanged: false, personalBrowserProfilesUsed: false, dedicatedKerberosKdcTested: false };
try {
  const probe = await run(runtime, ['-e', `const fs=require('node:fs');const assert=require('node:assert/strict');const application=${JSON.stringify(application)};const{requestBody}=require(application+'/electron/site-browser-transport.cjs');assert.deepEqual(requestBody({postDataEntries:[{bytes:'AP8='}]}),Buffer.from([0,255]));console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,version:JSON.parse(fs.readFileSync(application+'/package.json')).version,browserTransportModule:true}));`], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
  report.shippedRuntime = JSON.parse(probe.stdout.trim()); assert.equal(report.shippedRuntime.version, version);
  const environment = { ...process.env, NODE_OPTIONS: '' }; delete environment.ELECTRON_RUN_AS_NODE;
  const native = await run(electronRuntime, [fileURLToPath(new URL('./site-routes-enterprise-smoke.cjs', import.meta.url)), '--source-root', application, '--result-directory', join(directory, 'native')], { cwd: resolve('.'), windowsHide: true, timeout: 210000, maxBuffer: 1024 * 1024, env: environment });
  report.nativeStdout = native.stdout.trim(); report.nativeStderr = native.stderr.trim();
  report.nativeResult = JSON.parse(await readFile(join(directory, 'native', 'result.json'), 'utf8'));
  assert.equal(report.nativeResult.ok, true); assert.equal(report.nativeResult.sourceRoot, application);
  assert.equal(report.nativeResult.electronVersion, report.shippedRuntime.electron); assert.equal(report.nativeResult.assertions.length, 9);
  assert.deepEqual(report.nativeResult.externalRequests, []);
  const ui = await run(electronRuntime, [fileURLToPath(new URL('./site-session-ui-smoke.cjs', import.meta.url)), '--source-root', application, '--no-captures'], { cwd: resolve('.'), windowsHide: true, timeout: 170000, maxBuffer: 1024 * 1024, env: environment });
  report.uiStdout = ui.stdout.trim(); report.uiStderr = ui.stderr.trim();
  const uiDirectory = /REPORT: (.+)/.exec(ui.stdout)?.[1]?.trim(); assert.ok(uiDirectory);
  report.uiReport = join(uiDirectory, 'result.json'); report.uiResult = JSON.parse(await readFile(report.uiReport, 'utf8'));
  assert.equal(report.uiResult.ok, true); assert.equal(report.uiResult.sourceRoot, application);
  assert.equal(report.uiResult.electronVersion, report.shippedRuntime.electron); assert.equal(report.uiResult.assertions.length, 5);
  report.ok = true;
} catch (error) {
  report.error = error.stack || String(error); report.failedStdout = error.stdout?.trim(); report.failedStderr = error.stderr?.trim();
  report.nativeResult ||= await readFile(join(directory, 'native', 'result.json'), 'utf8').then(JSON.parse, () => null);
}
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('PACKAGED SITE ROUTES ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
