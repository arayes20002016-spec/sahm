import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || process.env.SAHM_PORTABLE_DIRECTORY || `dist/${version}/SAHM-win32-x64`);
const runtime = /\.exe$/i.test(portable) ? portable : join(portable, 'SAHM.exe');
const application = join(dirname(runtime), 'resources', 'app.asar');
await stat(runtime); await stat(application);
const directory = resolve('artifacts', 'packaged-completion-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const payload = Buffer.alloc(256 * 1024); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const report = { runtime, application, directory, requests: [], countdownDeadlineClock: 'Injected clock', nativePowerExecuted: false, systemStartupChanged: false };
const server = createServer((request, response) => {
  report.requests.push({ url: request.url, method: request.method, range: request.headers.range || null });
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), first = range ? Number(range[1]) : 0;
  const last = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
  response.writeHead(range ? 206 : 200, { ETag: '"packaged-completion"', 'Accept-Ranges': 'bytes', 'Content-Length': last - first + 1, ...(range ? { 'Content-Range': `bytes ${first}-${last}/${payload.length}` } : {}) });
  if (request.method === 'HEAD') { response.end(); return; }
  let offset = first;
  const timer = setInterval(() => { const next = Math.min(offset + 16384, last + 1); response.write(payload.subarray(offset, next)); offset = next; if (offset > last) { clearInterval(timer); response.end(); } }, 20);
  response.once('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const childReport = join(directory, 'runtime-result.json'), childScript = join(directory, 'runtime-probe.mjs');
const moduleUrl = name => pathToFileURL(join(application, 'src', name)).href;
const script = `import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DownloadManager } from ${JSON.stringify(moduleUrl('manager.mjs'))};
import { CompletionActions } from ${JSON.stringify(moduleUrl('completion-actions.mjs'))};
import { Preferences } from ${JSON.stringify(moduleUrl('preferences.mjs'))};
import { QueueStore } from ${JSON.stringify(moduleUrl('queues.mjs'))};
import { normalizeTableLayout } from ${JSON.stringify(moduleUrl('table-layout.mjs'))};
const require=createRequire(import.meta.url);
const {createCompletionPlatform}=require(${JSON.stringify(join(application, 'electron', 'completion-platform.cjs'))});
const directory=${JSON.stringify(directory)},origin=${JSON.stringify(origin)},result={assertions:[],executions:[],nativeCalls:[],nativePowerExecuted:false};
const manager=await new DownloadManager(join(directory,'state'),join(directory,'files')).init();
let clock=Date.now();
const makeController=()=>new CompletionActions({queueSnapshot:()=>manager.queueStore.list(),jobsSnapshot:()=>manager.list(),activeSnapshot:()=>manager.active.keys(),execute:async status=>result.executions.push(status),now:()=>clock,tickMs:20});
const controller=makeController();
const wait=async predicate=>{const deadline=Date.now()+12000;while(Date.now()<deadline){controller.reconcile();if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Packaged completion did not settle');};
try {
  await manager.queueStore.update('default',{completionAction:{type:'notify',delaySeconds:0}});controller.start();
  const job=await manager.add({url:origin+'/completed.bin',name:'packaged-completed.bin',connections:2});
  await wait(()=>manager.list().find(item=>item.id===job.id)?.status==='complete'&&result.executions.length===1);
  const bytes=await readFile(job.path);assert.equal(bytes.length,262144);for(let index=0;index<bytes.length;index++)assert.equal(bytes[index],index%251);
  assert.equal(result.executions[0].type,'notify');controller.reconcile();await new Promise(resolve=>setTimeout(resolve,60));assert.equal(result.executions.length,1);
  result.assertions.push('The shipped download manager receives exact HTTP bytes and its queue produces one completion action after transfer cleanup');
  await manager.queueStore.update('default',{completionAction:{type:'shutdown',delaySeconds:30}});controller.reconcile();
  const cancelled=await manager.add({url:origin+'/cancelled.bin',connections:2});await wait(()=>controller.snapshot().some(status=>status.state==='pending'&&status.type==='shutdown'));
  assert.equal(controller.cancel('default'),true);clock+=31000;controller.reconcile();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(result.executions.length,1);
  const restoredQueues=await new QueueStore(join(directory,'state')).init();assert.deepEqual(restoredQueues.get('default').completionAction,{type:'shutdown',delaySeconds:30});
  result.assertions.push('The packaged queue stores the chosen power action, and cancellation survives an elapsed deadline without dispatch');
  controller.close();const restored=makeController();restored.start();restored.reconcile();await new Promise(resolve=>setTimeout(resolve,30));restored.close();assert.equal(result.executions.length,1);
  result.assertions.push('A fresh controller does not replay actions for downloads already complete when the application starts');
  const preferences=await new Preferences(join(directory,'preferences'),join(directory,'files')).init();
  const layout=normalizeTableLayout({columns:[{id:'category',visible:true,width:190},{id:'name',visible:true,width:310},{id:'speed',visible:false,width:100}],sort:{key:'name',direction:'asc'}});
  await preferences.update({tableLayout:layout});const reloaded=await new Preferences(join(directory,'preferences'),join(directory,'files')).init();assert.deepEqual(reloaded.snapshot().tableLayout,layout);
  await assert.rejects(preferences.update({tableLayout:{columns:[{id:'name',visible:false,width:310}]}}));assert.deepEqual(reloaded.snapshot().tableLayout,layout);
  result.assertions.push('The shipped preferences retain column order, pixel widths, visibility and sorting while rejecting a hidden filename column');
  const platform=createCompletionPlatform({app:{quit:()=>result.nativeCalls.push({type:'quit'})},getDirectory:()=>join(directory,'files'),shell:{openPath:async value=>{result.nativeCalls.push({type:'folder',value});return '';}},platform:'win32',systemRoot:'C:\\\\Windows',execFile:(file,args,options,callback)=>{result.nativeCalls.push({file,args,options});callback(null);}});
  for(const type of ['shutdown','sleep','hibernate'])await platform.execute({type});
  assert.deepEqual(result.nativeCalls[0].args,['/s','/t','0']);assert.equal(result.nativeCalls[0].options.shell,false);assert.equal(result.nativeCalls[0].options.windowsHide,true);assert.deepEqual(result.nativeCalls[2].args,['/h']);
  const powerScript=Buffer.from(result.nativeCalls[1].args.at(-1),'base64').toString('utf16le');assert.ok(powerScript.includes('SetSuspendState(false, false, false)'));assert.ok(!result.nativeCalls.flatMap(call=>call.args||[]).includes('/f'));
  result.assertions.push('The shipped native adapter constructs non-forcing Windows commands using an injected process runner; no operating-system power action runs');
  result.passed=true;
}catch(error){result.error=error.stack;result.passed=false;process.exitCode=1;}
finally{controller.close();await manager.close();await writeFile(${JSON.stringify(childReport)},JSON.stringify(result,null,2));console.log('PACKAGED COMPLETION '+(result.passed?'PASS':'FAIL'));}
`;
try {
  await writeFile(childScript, script);
  try {
    const output = await run(runtime, [childScript], { windowsHide: true, cwd: dirname(runtime), timeout: 60000, maxBuffer: 512 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
    report.stdout = output.stdout.trim(); report.stderr = output.stderr.trim();
  } catch (error) { report.stdout = error.stdout?.trim(); report.stderr = error.stderr?.trim(); report.error = error.message; }
  report.runtimeResult = await readFile(childReport, 'utf8').then(JSON.parse, () => null);
  assert.equal(report.runtimeResult?.passed, true, 'Shipped completion actions and column preferences must pass in SAHM.exe Node mode');
  assert.ok(report.requests.some(request => request.range)); report.passed = true;
} catch (error) { report.passed = false; report.error ||= error.message; }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`PACKAGED COMPLETION ${report.passed ? 'PASS' : 'FAIL'}: ${join(directory, 'result.json')}`);
  if (!report.passed) process.exitCode = 1;
}
