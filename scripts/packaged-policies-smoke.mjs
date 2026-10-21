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
const directory = resolve('artifacts', 'packaged-policies-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const payload = Buffer.alloc(256 * 1024); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const report = { runtime, application, directory, requests: [], noSystemSettingsChanged: true };
let syncRequests = 0;
const source = createServer((request, response) => {
  const record = { url: request.url, method: request.method, range: request.headers.range || null, ifNoneMatch: request.headers['if-none-match'] || null }; report.requests.push(record);
  if (request.url === '/sync.txt') {
    syncRequests++; const revision = syncRequests <= 2 ? 1 : 2, etag = `"packaged-sync-${revision}"`;
    if (request.headers['if-none-match'] === etag) { record.status = 304; response.writeHead(304, { ETag: etag }); response.end(); return; }
    const body = Buffer.from(`Packaged synchronized revision ${revision}\n`); record.status = 200;
    response.writeHead(200, { ETag: etag, 'Content-Length': body.length }); response.end(body); return;
  }
  if (request.url !== '/quota.bin') { response.writeHead(404); response.end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || ''), start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
  response.writeHead(range ? 206 : 200, { ETag: '"packaged-policy"', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` } : {}) }); response.end(payload.subarray(start, end + 1));
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${source.address().port}`;
const childReport = join(directory, 'runtime-result.json'), childScript = join(directory, 'runtime-probe.mjs');
const moduleUrl = name => pathToFileURL(join(application, 'src', name)).href;
const script = `import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QuotaStore } from ${JSON.stringify(moduleUrl('quota.mjs'))};
import { NetworkService } from ${JSON.stringify(moduleUrl('network.mjs'))};
import { setTransportFetch } from ${JSON.stringify(moduleUrl('transport.mjs'))};
import { download } from ${JSON.stringify(moduleUrl('download.mjs'))};
import { SyncService } from ${JSON.stringify(moduleUrl('synchronization.mjs'))};
const directory=${JSON.stringify(directory)}, origin=${JSON.stringify(origin)}, result={assertions:[]};
const quota=await new QuotaStore(join(directory,'ledger')).init();
const network=new NetworkService({quota});await network.configure({mode:'direct'});
setTransportFetch(quota.wrapFetch(network.createFetch()));
const sync=new SyncService(join(directory,'sync-data'),join(directory,'files'),{quota});await sync.init();
try {
  const configured=await quota.configure({enabled:true,limitBytes:65536,periodHours:1});
  assert.equal(configured.resetAt-configured.windowStart,3600000);
  result.assertions.push('The first one-hour quota starts immediately while the consumption ledger is empty');
  const target=join(directory,'download.bin');
  await assert.rejects(download(origin+'/quota.bin',target,{connections:2}));
  assert.equal(quota.snapshot().usedBytes,65536);
  const state=JSON.parse(await readFile(target+'.resume.json','utf8'));
  assert.ok(state.parts.reduce((sum,part)=>sum+part.done,0)<=65536);
  result.assertions.push('The shipped HTTP engine stops at the durable quota before writing excess payload');
  const increased=await quota.configure({enabled:true,limitBytes:1048576,periodHours:1});
  assert.equal(increased.resetAt,configured.resetAt);assert.equal(increased.usedBytes,65536);
  const completed=await download(origin+'/quota.bin',target,{connections:2});
  const bytes=await readFile(completed.path);assert.equal(bytes.length,262144);
  for(let index=0;index<bytes.length;index++)assert.equal(bytes[index],index%251);
  const restored=await new QuotaStore(join(directory,'ledger')).init();
  assert.equal(restored.snapshot().usedBytes,quota.snapshot().usedBytes);
  result.assertions.push('The shipped downloader resumes exactly, and a new ledger instance reloads the saved consumption');
  const project=await sync.add({name:'Packaged policy smoke',urls:origin+'/sync.txt',intervalMinutes:1,enabled:false});
  const cycle=async()=>{const before=sync.list()[0].lastSuccessAt;await sync.action(project.id,'run');const deadline=Date.now()+12000;while(Date.now()<deadline){const value=sync.list()[0];if(value.lastSuccessAt&&value.lastSuccessAt!==before&&value.state==='paused')return value;if(['error','conflict','blocked'].includes(value.state))throw new Error(value.error);await new Promise(resolve=>setTimeout(resolve,15));}throw new Error('Packaged sync did not settle');};
  const first=await cycle();const local=join(first.directory,first.entries[0].filename);
  assert.equal(await readFile(local,'utf8'),'Packaged synchronized revision 1\\n');
  const unchanged=await cycle();assert.equal(unchanged.unchangedFiles,1);assert.equal(unchanged.receivedBytes,0);
  const updated=await cycle();assert.equal(await readFile(local,'utf8'),'Packaged synchronized revision 2\\n');
  assert.equal(await readFile(join(updated.directory,updated.entries[0].previousVersion),'utf8'),'Packaged synchronized revision 1\\n');
  result.assertions.push('The packaged synchronization module downloads, receives 304 without a body, and preserves the previous revision on update');
  result.quota=quota.snapshot();result.passed=true;
}catch(error){result.error=error.stack;result.passed=false;process.exitCode=1;}
finally{await sync.close();await network.close();await writeFile(${JSON.stringify(childReport)},JSON.stringify(result,null,2));console.log('PACKAGED POLICIES '+(result.passed?'PASS':'FAIL'));}
`;
try {
  await writeFile(childScript, script);
  try {
    const output = await run(runtime, [childScript], { windowsHide: true, cwd: dirname(runtime), timeout: 60000, maxBuffer: 512 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } });
    report.stdout = output.stdout.trim(); report.stderr = output.stderr.trim();
  } catch (error) { report.stdout = error.stdout?.trim(); report.stderr = error.stderr?.trim(); report.error = error.message; }
  report.runtimeResult = await readFile(childReport, 'utf8').then(JSON.parse, () => null);
  assert.equal(report.runtimeResult?.passed, true, 'The shipped quota and synchronization modules must pass in SAHM.exe Node mode');
  assert.equal(report.requests.filter(request => request.url === '/sync.txt').length, 3);
  assert.ok(report.requests.some(request => request.url === '/sync.txt' && request.status === 304));
  report.passed = true;
} catch (error) { report.passed = false; report.error ||= error.message; }
finally {
  source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`PACKAGED POLICIES ${report.passed ? 'PASS' : 'FAIL'}: ${join(directory, 'result.json')}`);
  if (!report.passed) process.exitCode = 1;
}
