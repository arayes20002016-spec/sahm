const { app, BrowserWindow, dialog, clipboard }=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const application=path.resolve(process.env.SAHM_APPLICATION_ROOT || '.');
const output=path.resolve(process.env.SAHM_BROWSER_SETUP_RESULT || 'artifacts/browser-setup-ui');
const workspace=path.resolve(process.env.SAHM_BROWSER_SETUP_WORKSPACE || path.join(output,'workspace'));
let main,finished=false;const prompts=[],errors=[];
const childProcess=require('node:child_process'), originalExecFile=childProcess.execFile;
const {promisify}=require('node:util'), runExecFile=promisify(originalExecFile);
let registryWriteAttempts=0;
function checkRegistryWrite(file,args){
 if(path.basename(file).toLowerCase()==='reg.exe'&&['add','delete'].includes(args?.[0]?.toLowerCase())){registryWriteAttempts++;throw new Error('Browser setup fixture forbids production registry writes');}
}
childProcess.execFile=function(file,args,...options){
 checkRegistryWrite(file,args);
 return originalExecFile.call(this,file,args,...options);
};
childProcess.execFile[promisify.custom]=async(file,args,...options)=>{checkRegistryWrite(file,args);return runExecFile(file,args,...options);};
require('node:module').syncBuiltinESMExports();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=code=>main.webContents.executeJavaScript(code);
async function wait(check,label){const end=Date.now()+30000;while(Date.now()<end){try{if(await check())return;}catch{}await delay(100);}throw new Error('Timeout: '+label);}
async function finish(error){if(finished)return;finished=true;await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'result.json'),JSON.stringify({ok:!error,error:error?.stack,prompts,errors,registryWriteAttempts,applicationSha256:application.endsWith('.asar')?require('node:crypto').createHash('sha256').update(require('original-fs').readFileSync(application)).digest('hex'):null,storeInstallTested:false,unpublishedActionsRemainDisabled:true},null,2));app.once('will-quit',()=>app.exit(error?1:0));app.quit();}
app.disableHardwareAcceleration();clipboard.readText=async()=>'';app.setLoginItemSettings=()=>{throw new Error('Unexpected startup write');};dialog.showMessageBox=async(_window,options)=>{prompts.push({type:options.type,message:options.message});return {response:0};};
(async()=>{
 await fs.mkdir(workspace,{recursive:true});await fs.mkdir(output,{recursive:true});app.setPath('appData',workspace);app.setPath('userData',path.join(workspace,'profile'));app.setPath('downloads',path.join(workspace,'files'));
 process.argv.push('--setup-browser');

 app.on('browser-window-created',(_event,window)=>{window.webContents.once('did-finish-load',()=>{if(window.webContents.getURL().endsWith('/ui/index.html'))main=window;});window.webContents.on('console-message',(_event,...args)=>{if(args.some(x=>String(x).includes('Error')))errors.push(args.map(String).join(' '));});});
 setTimeout(()=>finish(new Error('Browser setup watchdog')),150000).unref();
 require(path.join(application,'electron/main.cjs'));
 await wait(()=>main&&evaluate('window.sahmLocaleReady?.then(()=>true)'),'ready');
 await wait(()=>prompts.length===1,'installer setup prompt');
 assert.equal(prompts[0].type,'info');
 main.webContents.reload();app.emit('second-instance',{},['--setup-browser']);
 await wait(()=>prompts.length===2,'setup request during renderer reload');
 await wait(()=>evaluate('window.sahmLocaleReady?.then(()=>true)'),'reloaded UI');
 for(const language of ['ar','en']){
  await evaluate('window.sahm.preferences({language:'+JSON.stringify(language)+'})');await wait(()=>evaluate('document.documentElement.lang==='+JSON.stringify(language)+'&&window.sahmLocaleRestored?.then(()=>true)'),'locale');
  await evaluate('document.querySelector("[data-view=browser]").click();true');
  await wait(()=>evaluate('document.getElementById("chrome-store-status").textContent.length>0'),'browser status');
  assert.equal(await evaluate('document.getElementById("install-chrome").disabled&&document.getElementById("install-edge").disabled'),true);
  assert.equal(await evaluate('document.getElementById("extension-manual-setup").open'),true);
  const status=await evaluate('window.sahm.settings()');assert.equal(status.browser.registered,false);
  assert.equal(await evaluate('window.sahm.integration("install-edge").then(()=>false,()=>true)'),true);
  assert.equal((await evaluate('window.sahm.settings()')).browser.registered,false);
  for(const theme of ['light','dark']){
   await evaluate('window.sahm.preferences({theme:'+JSON.stringify(theme)+'})');main.setSize(theme==='light'?1100:900,theme==='light'?800:680);main.showInactive();await delay(150);
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
   await fs.writeFile(path.join(output,language+'-'+theme+'.png'),(await main.webContents.capturePage()).toPNG());
  }
 }
 assert.equal(prompts.length,2);assert.equal(errors.length,0);assert.equal(registryWriteAttempts,0);await finish();
})().catch(finish);
