import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || process.env.SAHM_PORTABLE_DIRECTORY || `dist/${version}/SAHM-win32-x64`);
const runtime = /\.exe$/i.test(portable) ? portable : join(portable, 'SAHM.exe');
const application = join(dirname(runtime), 'resources', 'app.asar');
await stat(runtime); await stat(application);
const directory = resolve('artifacts', 'packaged-site-session-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const electronRuntime = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
const report = { ok: false, version, runtime, application, electronRuntime, directory, applicationUiLaunchedFromSahmExe: false, bundledModulesTestedWithMatchingElectron: true, operatingSystemSettingsChanged: false };
try {
  const probe = await run(runtime, ['-e', `const fs=require('node:fs');const application=${JSON.stringify(application)};console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,version:JSON.parse(fs.readFileSync(application+'/package.json')).version,browserModule:fs.existsSync(application+'/electron/site-browser.cjs')}));`], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
  report.shippedRuntime = JSON.parse(probe.stdout.trim());
  assert.equal(report.shippedRuntime.version, version); assert.equal(report.shippedRuntime.browserModule, true);
  const browserEnvironment = { ...process.env, NODE_OPTIONS: '' };
  delete browserEnvironment.ELECTRON_RUN_AS_NODE;
  const featureFlags = ['--with-server-rules', '--with-site-schedule'].filter(flag => process.argv.includes(flag));
  report.featureFlags = featureFlags;
  const output = await run(electronRuntime, [fileURLToPath(new URL('./site-session-smoke.cjs', import.meta.url)), '--source-root', application, '--result-directory', join(directory, 'browser'), ...featureFlags], { windowsHide: true, timeout: 210000, maxBuffer: 1024 * 1024, cwd: resolve('.'), env: browserEnvironment });
  report.stdout = output.stdout.trim(); report.stderr = output.stderr.trim();
  report.browserResult = JSON.parse(await readFile(join(directory, 'browser', 'result.json'), 'utf8'));
  assert.equal(report.browserResult.ok, true); assert.equal(report.browserResult.electronVersion, report.shippedRuntime.electron);
  report.ok = true;
} catch (error) { report.error = error.stack || String(error); report.stdout ||= error.stdout?.trim(); report.stderr ||= error.stderr?.trim(); report.browserResult ||= await readFile(join(directory, 'browser', 'result.json'), 'utf8').then(JSON.parse, () => null); }
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('PACKAGED SITE SESSION ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
