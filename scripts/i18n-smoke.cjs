const {app,BrowserWindow,clipboard,Menu,shell}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createServer}=require('node:http');
const source=path.resolve(process.argv[process.argv.indexOf('--source-root')+1] || '.');
const directory=path.resolve(process.env.SAHM_I18N_RESULT || 'E:/SAHM-Build/0.24.0/i18n-ui');
let main,server,done=false,stage='start';const windows=[],errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=code=>main.webContents.executeJavaScript(code);
async function wait(check,label,timeout=40000){stage=label;let end=Date.now()+timeout;while(Date.now()<end){try{const v=await check();if(v)return v;}catch{}await delay(100);}throw new Error('Timeout '+label+' '+errors.join(';'));}
async function finish(error){if(done)return;done=true;if(error){console.error(error); if(main&&!main.isDestroyed()) {const diagnostic=await evaluate('({lang:document.documentElement.lang,initial:window.sahm.initialLanguage,notice:document.getElementById("notice-text").textContent,ready:!!window.sahmLocaleRestored,ui:typeof window.sahmUiState,bridge:typeof window.sahm.saveUiDraft})').catch(e=>({error:String(e)}));console.error(JSON.stringify(diagnostic));}}await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({ok:!error,stage,error:error?.stack,errors,source,applicationSha256:source.endsWith(".asar")?require("node:crypto").createHash("sha256").update(require("original-fs").readFileSync(source)).digest("hex"):null},null,2));server?.closeAllConnections();server?.close();app.once('will-quit',()=>app.exit(error?1:0));app.quit();}
app.disableHardwareAcceleration();clipboard.readText=async()=>'';app.setLoginItemSettings=()=>{throw new Error('Must not change startup');};shell.openPath=async()=>'';
(async()=>{
 await fs.mkdir(directory,{recursive:true});const profile=path.join(directory,'profile');await fs.mkdir(profile,{recursive:true});if(process.argv.includes('--initial-language=en'))await fs.writeFile(path.join(profile,'preferences.json'),JSON.stringify({language:'en'}));await fs.mkdir(path.join(directory,'files'),{recursive:true});app.setPath('appData',directory);app.setPath('userData',profile);app.setPath('downloads',path.join(directory,'files'));
 const payload=Buffer.alloc(1024*1024,97);
 server=createServer((req,res)=>{res.setHeader('Content-Length',payload.length);res.setHeader('Content-Type','application/octet-stream');let at=0;const timer=setInterval(()=>{res.write(payload.subarray(at,at+16384));at+=16384;if(at>=payload.length){clearInterval(timer);res.end();}},125);res.on('close',()=>clearInterval(timer));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 app.on('browser-window-created',(_,window)=>{windows.push(window);window.webContents.on('console-message',(_e,...args)=>{if(args.some(x=>String(x).includes('Error')))errors.push(args.map(String).join(' '));});window.webContents.once('did-finish-load',()=>{if(window.webContents.getURL().endsWith('/ui/index.html'))main=window;});});
 const watchdog=setTimeout(()=>finish(new Error('i18n watchdog at '+stage)),180000);watchdog.unref();
 require(path.join(source,'electron/main.cjs'));
 await wait(()=>main&&evaluate('window.sahmLocaleReady?.then(()=>true)'),'ready');
 await evaluate('window.sahm.preferences({theme:"light",showDownloadWindows:true})');main.setSize(1100,800);
 const job=await evaluate('window.sahm.add('+JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/file.bin',name:'English عربي 123.bin',connections:1})+')');
 await evaluate('document.querySelector("[data-view=network]").click();true');await wait(()=>evaluate('!!document.querySelector("#network-mode")&&!document.querySelector("#enterprise-server-add").disabled'),'network-ready');
 await evaluate('document.getElementById("enterprise-server-add").click(); const current=document.querySelector("#enterprise-servers [data-enterprise-field=server-current-account]");current.checked=false;current.dispatchEvent(new Event("change")); document.querySelector("#enterprise-servers input[type=password]").value="synthetic-secret-not-logged";document.getElementById("proxy-host").value="Arabic عربي host";document.getElementById("toggle-add").click();document.getElementById("url").value="https://example.com/English.zip";document.getElementById("name").value="العربية English 123";document.getElementById("schedule").value="2026-02-30T10:00";document.getElementById("schedule").dispatchEvent(new Event("input"));true');
 async function switchLanguage(language){await evaluate('window.sahm.preferences({language:'+JSON.stringify(language)+'})');await wait(()=>evaluate('document.documentElement.lang==='+JSON.stringify(language)+'&&window.sahmLocaleRestored?.then(()=>true)'),'language-'+language);}
 await switchLanguage('en');
 assert.equal(await evaluate('document.getElementById("schedule").checkValidity()'),false);
 stage='restored-name';assert.equal(await evaluate('document.getElementById("name").value'),'العربية English 123');
 stage='restored-secret';assert.equal(await evaluate('document.querySelector("#enterprise-servers input[type=password]").value'),'synthetic-secret-not-logged');
 assert.equal(await evaluate('document.getElementById("add-dialog").open'),true);
 assert.equal(await evaluate('document.querySelector("#enterprise-servers .enterprise-login-fields").disabled'),false);
 for(const language of ['en','ar']){
  if(language==='ar')await switchLanguage(language);
  const expected=language==='ar'?'rtl':'ltr';
  const directions=await evaluate('(()=>{const bad=[...document.querySelectorAll("body *")].filter(n=>getComputedStyle(n).direction!=="'+expected+'");return bad.map(n=>n.id||n.tagName).slice(0,15)})()');assert.deepEqual(directions,[]);
  assert.equal(await evaluate('document.getElementById("url").value'),'https://example.com/English.zip');
  assert.equal(await evaluate('document.querySelector("#add-dialog button[type=submit]").textContent'),language==='ar'?'بدء التنزيل':'Start download');
  assert.equal(Menu.getApplicationMenu().items[0].label,language==='ar'?'ملف':'File');
  await evaluate('(()=>{const input=document.getElementById("schedule");input.value="2026-02-30T10:00";input.dispatchEvent(new Event("input"));if(input.checkValidity())throw new Error("Invalid calendar date accepted");input.value="٢٠٣٠-٠٢-٢٨T١٣:٠٥";input.dispatchEvent(new Event("input"));if(input.value!=="2030-02-28T13:05"||!input.checkValidity())throw new Error("Date digit conversion failed");input.parentElement.querySelector("button").click();return true})()');
  assert.equal(await evaluate('document.getElementById("date-picker-dialog").open'),true);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("date-picker-year")).direction'),expected);
  await evaluate('document.getElementById("date-picker-dialog").querySelector("form").requestSubmit();true');
  assert.equal(await evaluate('document.getElementById("schedule").value'),'2030-02-28T13:05');

  for(const theme of ['light','dark']){
   await evaluate('window.sahm.preferences({theme:"'+theme+'"}).then(()=>refreshSettings())');main.setSize(theme==='dark'?900:1100,theme==='dark'?680:800);main.showInactive();await delay(120);await fs.writeFile(path.join(directory,language+'-'+theme+'.png'),(await main.webContents.capturePage()).toPNG());
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  }
  const dw=await wait(()=>windows.find(w=>!w.isDestroyed()&&w.webContents.getURL().endsWith('/ui/download.html')),'download-window');
  await wait(()=>dw.webContents.executeJavaScript('document.documentElement.lang==="'+language+'"'),'download-language');
  assert.equal(await dw.webContents.executeJavaScript('getComputedStyle(document.getElementById("path")).direction'),expected);
 }
 const complete=await wait(async()=> (await evaluate('window.sahm.list()')).find(v=>v.id===job.id&&v.status==='complete'),'download-complete');assert.equal(complete.received,payload.length);assert.equal(complete.name,'English عربي 123.bin');
 assert.equal(errors.length,0);await finish();
})().catch(finish);
