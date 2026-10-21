import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
assert.ok(process.argv[2], 'Pass the trusted makensis.exe path');
const electronMode = process.argv.includes('--electron');
const compiler = resolve(process.argv[2]), output = resolve(process.argv[3] || join(tmpdir(), 'sahm-native-process-smoke'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'owned-'));
const ownedDirectory = join(root, 'application'), foreignDirectory = join(root, 'another-copy');
await mkdir(ownedDirectory); await mkdir(foreignDirectory);
const ownedFile = join(ownedDirectory, 'SAHM.exe'), foreignFile = join(foreignDirectory, 'SAHM.exe');
const source = join(root, 'worker.cs'), script = join(root, 'probe.nsi'), probe = join(root, 'probe.exe'), resultFile = join(root, 'counts.txt');
const include = fileURLToPath(new URL('../build/process-control.nsh', import.meta.url));
for (const file of [root, include]) assert.ok(!/[$"\r\n]/.test(file), 'Unsupported NSIS test path');
const run = promisify(execFile);
await writeFile(source, 'public static class SahmOwnedWorker { public static void Main() { System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite); } }');
let ownedArguments = [];
if (electronMode) {
  const electronDirectory = fileURLToPath(new URL('../node_modules/electron/dist', import.meta.url));
  await cp(electronDirectory, ownedDirectory, { recursive: true });
  await copyFile(join(electronDirectory, 'electron.exe'), ownedFile);
  await run(join(process.env.SystemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/out:' + foreignFile, source], { windowsHide: true, timeout: 30000 });
  const fixture = join(root, 'electron-fixture.cjs');
  await writeFile(fixture, `const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',app.getPath('userData'));
app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});await window.loadURL('data:text/html,<title>SAHM isolated process fixture</title>');fs.writeFileSync(path.join(__dirname,'ready.json'),JSON.stringify(app.getAppMetrics().map(x=>({pid:x.pid,type:x.type}))));});setTimeout(()=>app.exit(0),60000);
`);
  ownedArguments = [fixture, '--user-data-dir=' + join(root, 'profile')];
} else {
  await run(join(process.env.SystemRoot, 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/out:' + ownedFile, source], { windowsHide: true, timeout: 30000 });
  await copyFile(ownedFile, foreignFile);
}
await writeFile(script, [
  'Unicode true', 'Name "SAHM isolated process test"', 'OutFile "' + probe + '"',
  'RequestExecutionLevel user', 'SilentInstall silent', 'AutoCloseWindow true', 'InstallDir "' + ownedDirectory + '"',
  '!include "LogicLib.nsh"', '!define APP_FILENAME "SAHM"', '!include "' + include + '"',
  'Section', 'StrCpy $SahmProcessAction "check"', 'Call SahmCheckProcesses',
  electronMode ? '${If} $SahmProcessResult < 2' : '${If} $SahmProcessResult != 1', 'SetErrorLevel 10', 'Quit', '${EndIf}',
  '!insertmacro customCheckAppRunning',
  'StrCpy $SahmProcessAction "check"', 'Call SahmCheckProcesses',
  '${If} $SahmProcessResult != 0', 'SetErrorLevel 12', 'Quit', '${EndIf}',
  'FileOpen $0 "' + resultFile + '" w', 'FileWrite $0 "check=1 stop=1 remaining=0"', 'FileClose $0', 'SectionEnd',
].join('\n'));
await run(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], { windowsHide: true, timeout: 30000 });
let owned, foreign;
const result = { ok: false, source: include, root, electronSandbox: electronMode, otherWindowsProcessesChanged: false };
try {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  owned = spawn(ownedFile, ownedArguments, { windowsHide: true, stdio: 'ignore', env: environment }); await once(owned, 'spawn');
  if (electronMode) {
    const end = Date.now() + 30000; let metrics;
    while (Date.now() < end) { try { metrics = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(metrics?.some(item => item.type === 'Tab'), 'Sandboxed renderer did not become ready'); result.processMetrics = metrics;
  }
  foreign = spawn(foreignFile, [], { windowsHide: true, stdio: 'ignore' }); await once(foreign, 'spawn');
  await run(probe, ['/S'], { windowsHide: true, timeout: 30000, env: { ...process.env, TEMP: root, TMP: root } });
  assert.equal(await readFile(resultFile, 'utf8'), 'check=1 stop=1 remaining=0');
  assert.equal(foreign.exitCode, null); assert.equal(foreign.signalCode, null);
  process.kill(foreign.pid, 0);
  result.ok = true; result.checked = 1; result.stopped = 1; result.remaining = 0; result.sameNamedForeignProcessPreserved = true;
  result.nativeSourceSha256 = createHash('sha256').update(await readFile(include)).digest('hex');
} catch (error) { result.error = error.stack; throw error; }
finally {
  for (const child of [owned, foreign]) {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
  }
  try { result.nativeLog = (await readFile(join(root, 'SAHM-process-control.log'), 'utf8')).trim().split(/\r?\n/).slice(-100); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (electronMode && result.nativeLog) {
    const checked = result.nativeLog.find(line => /^check-result \d+$/.test(line));
    const stopped = result.nativeLog.find(line => /^stop-result \d+$/.test(line));
    if (checked) result.checked = Number(checked.split(' ').at(-1));
    if (stopped) result.stopped = Number(stopped.split(' ').at(-1));
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
