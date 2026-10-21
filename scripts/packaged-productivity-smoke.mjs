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
const directory = resolve('artifacts', 'packaged-productivity-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const electronRuntime = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url));
const report = { ok: false, version, runtime, application, electronRuntime, directory, applicationUiLaunchedFromSahmExe: false, shippedApplicationLoadedInMatchingElectron: true, systemStartupChanged: false, systemClipboardUsed: false };
try {
  const probeScript = `const assert=require('node:assert/strict');const fs=require('node:fs');const application=${JSON.stringify(application)};
const{createClipboardMonitor}=require(application+'/electron/clipboard-monitor.cjs');
(async()=>{const links=[];const monitor=createClipboardMonitor({readText:async()=> ' https://example.com/fixture.zip ',isEnabled:()=>true,isReady:()=>true,onLink:url=>links.push(url)});
await monitor.poll();await monitor.poll();monitor.close();assert.deepEqual(links,['https://example.com/fixture.zip']);
console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,version:JSON.parse(fs.readFileSync(application+'/package.json')).version,asynchronousClipboardPassed:true}));})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const probe = await run(runtime, ['-e', probeScript], { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
  report.shippedRuntime = JSON.parse(probe.stdout.trim());
  assert.equal(report.shippedRuntime.version, version);
  const browserEnvironment = { ...process.env, NODE_OPTIONS: '' };
  delete browserEnvironment.ELECTRON_RUN_AS_NODE;
  const output = await run(electronRuntime, [fileURLToPath(new URL('./productivity-smoke.cjs', import.meta.url)), '--source-root', application], { cwd: resolve('.'), windowsHide: true, timeout: 110000, maxBuffer: 1024 * 1024, env: browserEnvironment });
  report.stdout = output.stdout.trim(); report.stderr = output.stderr.trim();
  const resultDirectory = /REPORT: (.+)/.exec(output.stdout)?.[1]?.trim();
  assert.ok(resultDirectory, 'The real application test must publish its report');
  report.uiReport = join(resultDirectory, 'result.json');
  report.uiResult = JSON.parse(await readFile(report.uiReport, 'utf8'));
  assert.equal(report.uiResult.ok, true);
  assert.equal(report.uiResult.sourceRoot, application);
  assert.equal(report.uiResult.electronVersion, report.shippedRuntime.electron);
  assert.equal(report.uiResult.clipboard.asynchronous, true);
  assert.ok(report.uiResult.clipboard.rejectedReads > 0);
  report.ok = true;
} catch (error) {
  report.error = error.stack || String(error);
  report.stdout ||= error.stdout?.trim(); report.stderr ||= error.stderr?.trim();
}
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('PACKAGED PRODUCTIVITY ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
