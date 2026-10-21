import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {BrowserCdp} from './real-browser-cdp.mjs';
import {EXTENSION_ID} from '../browser/protocol.mjs';
const directory=resolve(process.env.SAHM_I18N_BROWSER_RESULT || 'E:/SAHM-Build/0.24.0/i18n-browsers');
const extension=resolve(process.env.SAHM_BROWSER_DIRECTORY || 'browser/extension');
const report={ok:false,browsers:[],personalProfilesUsed:false,productionRegistryChanged:false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,label){const end=Date.now()+30000;while(Date.now()<end){try{const result=await check();if(result)return result;}catch{}await delay(100);}throw new Error('Browser locale timeout: '+label);}
const descendants=node=>[node,...(node.children||[]).flatMap(descendants),...(node.shadowRoots||[]).flatMap(descendants)];
const attrs=node=>Object.fromEntries(Array.from({length:(node.attributes||[]).length/2},(_,i)=>[node.attributes[2*i],node.attributes[2*i+1]]));
const server=createServer((req,res)=>{if(req.url==='/file.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="fr" dir="ltr"><meta charset="utf-8"><body><video controls src="/file.mp4" style="width:640px;height:360px;background:#222"></video><p>صفحة اختبار 123 English</p></body></html>');});
await mkdir(directory,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 for(const [name,binary] of [['chrome','C:/Program Files/Google/Chrome/Application/chrome.exe'],['edge','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]){
  const browser=await BrowserCdp.launch(binary,join(directory,name+'-profile'));
  try {
   assert.equal((await browser.send('Extensions.loadUnpacked',{path:extension})).id,EXTENSION_ID);
   const page=await browser.page('http://127.0.0.1:'+server.address().port+'/');
   const popup=await browser.page('chrome-extension://'+EXTENSION_ID+'/popup.html');
   await wait(()=>browser.evaluate(popup.sessionId,'!!document.getElementById("language") && document.getElementById("connection").textContent !== sahmI18n.t("جارٍ فحص اتصال التطبيق…")'),'popup-loaded');
   await browser.evaluate(popup.sessionId,'chrome.storage.local.set({enabled:true,showVideoButton:true})');
   const cases=[];
   for(const language of ['en','ar']){
    await browser.evaluate(popup.sessionId,'document.getElementById("excludedDomains").value="draft.example";document.getElementById("language").value="'+language+'";document.getElementById("language").dispatchEvent(new Event("change"));true');
    const direction=language==='ar'?'rtl':'ltr';
    await wait(()=>browser.evaluate(popup.sessionId,'document.documentElement.lang==="'+language+'"&&document.getElementById("enabled").checked&&document.getElementById("excludedDomains").value==="draft.example"'),'popup-language-'+language);
    assert.equal(await browser.evaluate(popup.sessionId,'getComputedStyle(document.getElementById("excludedDomains")).direction'),direction);
    assert.equal(await browser.evaluate(popup.sessionId,'document.getElementById("excludedDomains").value'),'draft.example');
    assert.equal(await browser.evaluate(popup.sessionId,'document.querySelector("label[for=language] span").textContent'),language==='ar'?'لغة الواجهة':'Interface language');
    await browser.send('DOM.enable',{},page.sessionId);
    const host=await wait(async()=>descendants((await browser.send('DOM.getDocument',{depth:-1,pierce:true},page.sessionId)).root).find(node=>Object.hasOwn(attrs(node),'data-sahm-media-overlay')&&attrs(node).dir===direction),'overlay-direction-'+language);
    const text=descendants(host).filter(node=>node.nodeType===3).map(node=>node.nodeValue).join(' ');
    assert.ok(text.includes(language==='ar'?'تنزيل الفيديو':'Download video'),text);
    assert.deepEqual(await browser.evaluate(page.sessionId,'({lang:document.documentElement.lang,dir:document.documentElement.dir})'),{lang:'fr',dir:'ltr'});
    cases.push({language,direction,popup:true,overlay:true,hostPageUnchanged:true,unsavedPopupDraftPreserved:true});
   }
   report.browsers.push({name,passed:true,cases});
  } finally {await browser.close();}
 }
 report.ok=true;
} catch(error){report.error=error.stack;process.exitCode=1;}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,browsers:report.browsers.map(x=>x.name),error:report.error}));}
