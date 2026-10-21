import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const application = resolve(process.argv[2] || root);
const portable = process.argv[3] && resolve(process.argv[3]);
const directory = resolve(process.env.SAHM_AUTH_RESULT_DIRECTORY || join(root, 'artifacts/auth-load-smoke', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(directory, { recursive: true });
const electron = join(root, 'node_modules/electron/dist/electron.exe');
const environment = { ...process.env, NODE_OPTIONS: '' }; delete environment.ELECTRON_RUN_AS_NODE;
const report = { ok: false, application, directory, rounds: [], personalBrowserProfilesUsed: false, operatingSystemSettingsChanged: false, coldHelperDelayMs: 6500 };

async function nativeRound(name, delay) {
  const resultDirectory = join(directory, name);
  const result = await run(electron, [join(root, 'scripts/site-routes-enterprise-smoke.cjs'), '--source-root', application, '--cold-start-delay-ms', String(delay), '--result-directory', resultDirectory], { cwd: root, env: environment, windowsHide: true, timeout: 210000, maxBuffer: 1024 * 1024 });
  await writeFile(join(directory, name + '.stderr.log'), result.stderr);
  const evidence = JSON.parse(await readFile(join(resultDirectory, 'result.json'), 'utf8'));
  assert.equal(evidence.ok, true); assert.equal(evidence.assertions.length, 9);
  assert.deepEqual(evidence.externalRequests, []);
  return { name, report: join(resultDirectory, 'result.json'), assertions: evidence.assertions.length, coldStartDelayMs: delay };
}

async function browserRound(product) {
  const executable = portable ? join(portable, 'SAHM.exe') : process.execPath;
  const env = { ...environment, SAHM_APPLICATION_ROOT: application, SAHM_BROWSER_DIRECTORY: join(portable ? join(portable, 'resources') : root, 'browser') };
  if (portable) env.ELECTRON_RUN_AS_NODE = '1';
  const result = await run(executable, [join(root, 'scripts/real-browser-tests.mjs'), product, '--no-captures'], { cwd: root, env, windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(join(directory, product + '.log'), result.stdout + '\n' + result.stderr);
  return { product, completed: true, log: join(directory, product + '.log') };
}

try {
  // Each browser runs its real GET/session/POST and worker-restart suite while
  // a fresh Electron process starts native NTLM/PFX authentication.
  for (const product of ['chrome', 'edge']) {
    const results = await Promise.allSettled([nativeRound(product + '-concurrent', 0), browserRound(product)]);
    report.rounds.push({ product, results: results.map(value => value.status === 'fulfilled' ? { ok: true, ...value.value } : { ok: false, error: value.reason.stack, stderr: value.reason.stderr }) });
    assert.equal(results.every(value => value.status === 'fulfilled'), true, product + ' concurrent authentication failed');
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  }
  report.rounds.push(await nativeRound('delayed-cold-start', report.coldHelperDelayMs));
  report.ok = true;
} catch (error) { report.error = error.stack; report.stderr = error.stderr; }
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log('AUTH LOAD ' + (report.ok ? 'PASS' : 'FAIL') + ': ' + join(directory, 'result.json'));
if (!report.ok) process.exitCode = 1;
