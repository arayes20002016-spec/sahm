import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Preferences} from '../src/preferences.mjs';
const messages=JSON.parse(await readFile(new URL('../locales/messages.json',import.meta.url),'utf8'));
const files=await Promise.all(['i18n-data.js','i18n-core.js'].map(name=>readFile(new URL('../browser/extension/'+name,import.meta.url),'utf8')));
function locale(extra={}) {const context=vm.createContext({...extra});files.forEach(code=>vm.runInContext(code,context));return context.sahmI18n;}
test('English catalogue preserves every numbered substitution and translates authored labels only',()=>{
 const i=locale();i.setLanguage('en');
 for(const [key,value] of Object.entries(messages)) { assert.equal(i.t(key),value);assert.deepEqual([...key.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort(),[...value.matchAll(/\{\d+\}/g)].map(x=>x[0]).sort()); }
 const filename='الإعدادات ملف ١٢.txt';
 assert.equal(i.t('{0} ملف',[filename]),'Files: '+filename);
 assert.equal(i.formatMessage(filename),filename);
 assert.equal(i.categoryLabel('فيديو'),'Video');
 assert.equal(i.categoryLabel('Custom عربي'),'Custom عربي');
 assert.equal(i.queueLabel({id:'default',name:'القائمة الرئيسية'}),'Main queue');
 assert.equal(i.queueLabel({id:'custom',name:'القائمة الرئيسية'}),'القائمة الرئيسية');
 assert.equal(i.queueLabel({id:'default',name:'Custom عربي'}),'Custom عربي');
 assert.equal(i.formatMessage("Error invoking remote method 'x': Error: إعداد اللغة غير صالح."),'Invalid language setting.');
 i.setLanguage('ar');assert.equal(i.t('الإعدادات'),'الإعدادات');assert.throws(()=>i.setLanguage('fr'));
});
test('both languages use Latin digits and Gregorian dates regardless of formatting options',()=>{
 const i=locale();for(const language of ['ar','en']){i.setLanguage(language);assert.equal(i.direction(),language==='ar'?'rtl':'ltr');
 for(const text of [i.number(1234.5),i.number(.75,{style:'percent',numberingSystem:'arab'}),i.date(new Date('2026-10-21T12:34:00Z'),{dateStyle:'short',timeStyle:'short',numberingSystem:'arab',calendar:'islamic'})]) {assert.doesNotMatch(text,/[٠-٩۰-۹]/);assert.match(text,/[0-9]/);} }
});
test('locale helper in an isolated content script never changes the host page direction or language',()=>{
 const document={documentElement:{lang:'fr',dir:'ltr'},addEventListener(){throw new Error('Host page must remain unchanged');}};
 const i=locale({document,location:{href:'https://example.com'},chrome:{runtime:{getURL:()=> 'chrome-extension://test/'}}});i.setLanguage('ar');assert.equal(document.documentElement.lang,'fr');assert.equal(document.documentElement.dir,'ltr');
});
test('legacy preferences default to Arabic, English persists, and invalid languages never overwrite the last saved configuration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sahm-locale-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'preferences.json'),JSON.stringify({theme:'dark'}));
 const p=await new Preferences(root,root).init();assert.equal(p.snapshot().language,'ar');await p.update({language:'en'});
 assert.equal((await new Preferences(root,root).init()).snapshot().language,'en');
 for(const language of ['fr','EN',null,{},'rtl']) await assert.rejects(p.update({language}));
 assert.equal((await new Preferences(root,root).init()).snapshot().language,'en');
});
