import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || 'dist/' + version + '/SAHM-win32-x64');
const directory = resolve(process.env.SAHM_PACKAGED_BROWSER_RESULT || 'artifacts/packaged-browser-downloads-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const report = { ok: false, version, portable, application: join(portable, 'resources/app.asar'), sourceBrowserProfilesUsed: false, personalBrowserProfilesUsed: false, installerExecuted: false };
try {
  const output = await run(join(portable, 'SAHM.exe'), [fileURLToPath(new URL('./real-browser-tests.mjs', import.meta.url)), '--popup-only'], {
    cwd: resolve('.'), windowsHide: true, timeout: 300000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1', SAHM_APPLICATION_ROOT: report.application, SAHM_BROWSER_DIRECTORY: join(portable, 'resources/browser') },
  });
  report.stdout = output.stdout; report.stderr = output.stderr;
  const resultFile = /Evidence: (.+)/.exec(output.stdout)?.[1]?.trim(); assert.ok(resultFile);
  report.resultFile = resultFile; report.browserResults = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.ok(!report.browserResults.error); assert.equal(report.browserResults.productionRegistryUnchanged, true); assert.equal(report.browserResults.aliasRegistryRemoved, true);
  assert.equal(report.browserResults.browsers.length, 2);
  for (const browser of report.browserResults.browsers) { assert.equal(browser.passed, true); assert.equal(browser.postRecovery.passed, true); }
  report.ok = true;
} catch (error) { report.error = error.stack; report.stdout = error.stdout; report.stderr = error.stderr; }
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('PACKAGED BROWSER DOWNLOADS ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
