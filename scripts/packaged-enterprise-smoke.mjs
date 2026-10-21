import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ntlmHttpOrigin, createEnterprisePfx } from '../test/helpers/enterprise-origin-fixture.mjs';
import { ftpFixture } from '../test/helpers/ftp-fixture.mjs';
import { windowsConnectProxy } from '../test/helpers/windows-connect-proxy-fixture.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const portable = resolve(process.argv[2] || process.env.SAHM_PORTABLE_DIRECTORY || `dist/${version}/SAHM-win32-x64`);
const runtime = /\.exe$/i.test(portable) ? portable : join(portable, 'SAHM.exe'), application = join(dirname(runtime), 'resources', 'app.asar');
await stat(runtime); await stat(application);
const directory = resolve('artifacts', 'packaged-enterprise-smoke', new Date().toISOString().replace(/[:.]/g, '-')); await mkdir(directory, { recursive: true });
const payload = Buffer.alloc(256 * 1024); for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
const phrase = 'packaged-enterprise-pfx-fixture-0.9', identity = await createEnterprisePfx(directory, phrase);
const serverCertificateFile = fileURLToPath(new URL('../test/fixtures/ftp/server-cert.pem', import.meta.url));
const [serverCertificate, serverKey, clientCertificate] = await Promise.all([readFile(serverCertificateFile), readFile(new URL('../test/fixtures/ftp/server-key.pem', import.meta.url)), readFile(identity.cert)]);
const plain = await ntlmHttpOrigin(payload), secure = await ntlmHttpOrigin(payload, { tls: { key: serverKey, cert: serverCertificate, ca: clientCertificate, requestCert: true, rejectUnauthorized: true } });
const fixtureCleanup = [], fixtureLifetime = { after: callback => fixtureCleanup.unshift(callback) };
const ftp = await ftpFixture(fixtureLifetime), ftpProxy = await windowsConnectProxy(fixtureLifetime, 'ntlm');
const pac = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' }); response.end('function FindProxyForURL(url,host){return "DIRECT";}'); });
await new Promise(resolve => pac.listen(0, '127.0.0.1', resolve));
const pacUrl = `http://127.0.0.1:${pac.address().port}/proxy.pac`, childReport = join(directory, 'runtime-result.json'), childScript = join(directory, 'runtime-probe.mjs');
const report = { runtime, application, version, directory, fixtureChildNodeTrustOnly: true, operatingSystemSettingsChanged: false, dedicatedKerberosKdcTested: false };
const moduleUrl = name => pathToFileURL(join(application, 'src', name)).href;
const script = `import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NetworkService} from ${JSON.stringify(moduleUrl('network.mjs'))};
import {setTransportFetch} from ${JSON.stringify(moduleUrl('transport.mjs'))};
import {download} from ${JSON.stringify(moduleUrl('download.mjs'))};
import {downloadFtp} from ${JSON.stringify(moduleUrl('ftp.mjs'))};
import {Preferences} from ${JSON.stringify(moduleUrl('preferences.mjs'))};
import {loadClientCertificate} from ${JSON.stringify(moduleUrl('client-certificates.mjs'))};
import {WindowsAuthService} from ${JSON.stringify(moduleUrl('windows-auth.mjs'))};
import {discoverWindowsPac} from ${JSON.stringify(moduleUrl('windows-wpad.mjs'))};
import {useWindowsSystemTrust} from ${JSON.stringify(moduleUrl('windows-trust.mjs'))};
import {windowsAuthServerService,loopbackWindowsIdentity} from ${JSON.stringify(new URL('../test/helpers/windows-auth-fixture.mjs', import.meta.url).href)};
const input=await new Promise(resolve=>{const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));});
const directory=${JSON.stringify(directory)},plain=${JSON.stringify(plain.origin)},secure=${JSON.stringify(secure.origin)},pacUrl=${JSON.stringify(pacUrl)},pfxFile=${JSON.stringify(identity.pfx)};
const ftpUrl=${JSON.stringify(ftp.url)},ftpPort=${JSON.stringify(ftpProxy.port)};
const result={assertions:[],operatingSystemSettingsChanged:false,dedicatedKerberosKdcTested:false};
const profile={origin:secure,pfxFile,enabled:true};
const network=new NetworkService({clientCertificateProvider:origin=>origin===secure?loadClientCertificate(origin,profile,input.passphrase):null,discoverPac:async()=>pacUrl});
const client=new WindowsAuthService(),server=await windowsAuthServerService();
try{
 const trust=useWindowsSystemTrust();assert.equal(trust.enabled,true);assert.ok(Number.isInteger(trust.systemCertificates));result.systemTrustCertificates=trust.systemCertificates;
 result.assertions.push('The shipped runtime reads existing Windows certificate trust and preserves its original bundled and process-extra certificate authorities without changing the OS store');
 const [outbound,inbound]=await Promise.all([client.createContext(loopbackWindowsIdentity),server.createContext(loopbackWindowsIdentity)]);
 const first=await outbound.step(null),challenge=await inbound.step(first.token),final=await outbound.step(challenge.token),accepted=await inbound.step(final.token);assert.equal(final.complete,true);assert.equal(accepted.complete,true);assert.equal(final.package,'NTLM');await outbound.close();await inbound.close();
 result.assertions.push('The shipped SSPI client compiles its bundled C# from app.asar and completes a real native NTLM exchange without credential files or command arguments');
 const config={mode:'direct',authentication:{proxy:{scheme:'basic',currentAccount:false,allowedHosts:[]},servers:[{origin:plain,scheme:'ntlm',currentAccount:true},{origin:secure,scheme:'ntlm',currentAccount:true}]},clientCertificates:[profile]};
 await network.configure(config);setTransportFetch(network.createFetch());
 const completed=await download(plain+'/file.bin',join(directory,'plain.bin'),{connections:2});const bytes=await readFile(completed.path);assert.equal(bytes.length,262144);for(let index=0;index<bytes.length;index++)assert.equal(bytes[index],index%251);
 result.assertions.push('The packaged range downloader completes byte-identical HTTP data through actual native Windows NTLM 401 authentication');
 const post=await network.fetch(plain+'/post',{method:'POST',body:'one authorized packaged POST',redirect:'manual'});assert.equal(await post.text(),'one authorized packaged POST');
 result.assertions.push('The shipped authenticated HTTP path submits and receives one authorized POST body');
 const combined=await network.fetch(secure+'/combined.bin',{redirect:'manual'});const secureBytes=Buffer.from(await combined.arrayBuffer());assert.deepEqual(secureBytes,bytes);
 result.assertions.push('The packaged HTTPS transport combines a real PFX client certificate with NTLM authentication and TLS channel binding on the same connection while retaining server trust checks');
 assert.equal(await loadClientCertificate('https://different.example.test',profile,input.passphrase),null);
 const preferences=await new Preferences(join(directory,'settings'),directory).init();await preferences.update({network:config});const restored=await new Preferences(join(directory,'settings'),directory).init();assert.deepEqual(restored.snapshot().network.clientCertificates,[profile]);assert.ok(!JSON.stringify(restored.snapshot()).includes(input.passphrase));
 result.assertions.push('The shipped profile schema preserves exact HTTPS-origin metadata without persisting the PFX passphrase or applying the identity to another origin');
 let ftpQuotaBytes=0;const ftpQuota={assertAvailable:async()=>{},consume:async size=>{ftpQuotaBytes+=size;return size;}};
 const ftpNetwork=new NetworkService({quota:ftpQuota});
 try{
  await ftpNetwork.configure({mode:'manual',proxy:{type:'http',host:'localhost',port:ftpPort},authentication:{proxy:{scheme:'ntlm',currentAccount:true,allowedHosts:['localhost']}}});
  const completedFtp=await downloadFtp(ftpUrl,join(directory,'ftp.bin'),{network:ftpNetwork,quota:ftpQuota,signal:AbortSignal.timeout(60000)});assert.deepEqual(await readFile(completedFtp.path),bytes);assert.equal(ftpQuotaBytes,bytes.length);result.ftpQuotaBytes=ftpQuotaBytes;
  result.assertions.push('The packaged FTP engine authenticates control and data tunnels through the pinned Windows NTLM gateway and counts the file payload once');
 }finally{await ftpNetwork.close();}
 await network.configure({mode:'wpad'});assert.deepEqual(await network.routesFor('https://wpad-fixture.example.test/file'),[{type:'direct'}]);
 const found=await discoverWindowsPac({timeoutMs:10000});assert.ok(found===null||typeof found==='string');result.nativeWpadFound=!!found;
 result.assertions.push('The packaged WPAD/PAC path evaluates a discovered fixture PAC through the bundled worker, and the native WinHTTP discovery helper runs without editing Windows settings');
 result.passed=true;
}catch(error){result.passed=false;result.error=error.stack;process.exitCode=1;}
finally{await Promise.all([network.close(),client.close(),server.close()]);await writeFile(${JSON.stringify(childReport)},JSON.stringify(result,null,2));console.log('PACKAGED ENTERPRISE '+(result.passed?'PASS':'FAIL'));}
`;
try {
  await writeFile(childScript, script);
  const execution = await new Promise(resolve => {
    const child = execFile(runtime, [childScript], { windowsHide: true, cwd: dirname(runtime), timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_EXTRA_CA_CERTS: serverCertificateFile } }, (error, stdout, stderr) => resolve({ error: error?.message, stdout, stderr }));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ passphrase: phrase }));
  });
  Object.assign(report, execution);
  report.runtimeResult = await readFile(childReport, 'utf8').then(JSON.parse, () => null);
  assert.equal(report.runtimeResult?.passed, true, 'The packaged enterprise transports must pass from SAHM.exe');
  assert.equal(plain.requests.filter(request => request.method === 'POST').length, 1);
  assert.ok(secure.requests.length > 0 && secure.requests.every(request => request.mutualTls));
  assert.equal(ftpProxy.accepted.length, 4); assert.deepEqual(ftpProxy.failures, []); assert.equal(ftp.retrievals, 1);
  assert.ok(ftpProxy.seen.every(request => request.scheme.toLowerCase() === 'ntlm'));
  report.passed = true;
} catch (error) { report.passed = false; report.error ||= error.message; }
finally {
  report.httpAuthorizedRequests = plain.requests; report.mutualTlsAuthorizedRequests = secure.requests;
  report.ftpAuthenticatedTunnels = ftpProxy.accepted.length; report.ftpRetrievals = ftp.retrievals;
  await Promise.all([plain.close(), secure.close(), new Promise(resolve => pac.close(resolve))]);
  for (const cleanup of fixtureCleanup) await cleanup();
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`PACKAGED ENTERPRISE ${report.passed ? 'PASS' : 'FAIL'}: ${join(directory, 'result.json')}`);
  if (!report.passed) process.exitCode = 1;
}
