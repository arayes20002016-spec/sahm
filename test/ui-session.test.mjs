import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../electron/ui-session.cjs',import.meta.url),'utf8');
function fixture(){
 const handlers=new Map(),listeners=new Map(),timers=new Set(),events=new Map();let reloads=0;
 const main={mainFrame:{},reload(){reloads++;}},download={mainFrame:{}};
 const module={exports:{}};
 vm.runInNewContext(source,{module,structuredClone,require:()=>({ipcMain:{on:(name,callback)=>listeners.set(name,callback),handle:(name,callback)=>handlers.set(name,callback),removeListener:name=>listeners.delete(name),removeAllListeners:name=>listeners.delete(name),removeHandler:name=>handlers.delete(name)}}),setTimeout:callback=>{const timer={callback,unref(){}};timers.add(timer);return timer;},clearTimeout:timer=>timers.delete(timer)});
 module.exports.wireUiSession({window:{webContents:main,once:(name,callback)=>events.set(name,callback)},preferences:{snapshot:()=>({language:'en'})},downloadWindows:{owns:sender=>sender===download}});
 const event={sender:main,senderFrame:main.mainFrame};
 return {handlers,listeners,timers,events,event,download,reloads:()=>reloads};
}
test('language bootstrap trusts only owned top-level windows, never website frames',()=>{
 const f=fixture();for(const [sender,frame,expected] of [[f.event.sender,f.event.senderFrame,'en'],[f.download,f.download.mainFrame,'en'],[f.event.sender,{},'ar'],[{mainFrame:{}},{},'ar']]){const event={sender,senderFrame:frame};f.listeners.get('ui-language')(event);assert.equal(event.returnValue,expected);}
});
test('form drafts are isolated in memory, detached, bounded, one-time and expire',()=>{
 const f=fixture(),save=f.handlers.get('ui-draft-save'),take=f.handlers.get('ui-draft-take');
 const value={fields:[{value:'synthetic-private-password'}]};
 save(f.event,value);value.fields[0].value='mutated';assert.equal(take(f.event).fields[0].value,'synthetic-private-password');assert.equal(take(f.event),null);
 for(const bad of [null,[],{value:'x'.repeat(1024*1024)}])assert.throws(()=>save(f.event,bad));
 const wrong={sender:f.download,senderFrame:f.download.mainFrame};assert.throws(()=>save(wrong,{}),/Untrusted/);assert.throws(()=>take(wrong),/Untrusted/);
 save(f.event,{});[...f.timers][0].callback();assert.equal(take(f.event),null);
 save(f.event,{});f.events.get('closed')();assert.equal(f.handlers.size,0);assert.equal(f.timers.size,0);
});
test('renderer reload requires an owned application frame and an available in-memory draft',()=>{
 const f=fixture(),reload=f.listeners.get('ui-reload');reload(f.event);assert.equal(f.reloads(),0);
 f.handlers.get('ui-draft-save')(f.event,{});reload({sender:f.download,senderFrame:f.download.mainFrame});assert.equal(f.reloads(),0);reload(f.event);assert.equal(f.reloads(),1);
});
