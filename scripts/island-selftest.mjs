import assert from 'node:assert/strict';
import { createPreferenceStore, hostname, normalizePreferences, ISLAND_KEY } from '../src/lib/island-preferences.js';
import '../src/lib/island-core.js';
const C = globalThis.JDTIslandCore;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`✓ ${name}`); }
const data = { records: [{ id: 'keep' }], settings: { apiKey: 'private' }, knowledgeLibrary: { keep: true } };
let writes = 0, fail = false;
const store = createPreferenceStore({ get: async (key) => ({ [key]: structuredClone(data[key]) }), set: async (patch) => { if (fail) throw Error('storage-full'); writes++; Object.assign(data, structuredClone(patch)); } });
test('HTTP HTTPS ports paths share hostname', () => assert.equal(hostname('http://EXAMPLE.com:90/a'), hostname('https://example.com/b')));
test('subdomains independent', () => assert.notEqual(hostname('https://a.example.com'), hostname('https://example.com')));
test('IPv6 hostname preference accepted without ports',()=>assert.deepEqual(normalizePreferences({disabledHosts:['[::1]','example.com:80']}).disabledHosts,['[::1]']));
test('non-web URLs refused', () => assert.equal(hostname('chrome://settings'), ''));
test('whitelisted normalized fields', () => assert.deepEqual(normalizePreferences({ apiKey:'leak', position:{x:4,y:-1}, disabledHosts:['Example.com','example.com','bad/path','x:80','sub.example.com'] }), {schemaVersion:1,position:{x:1,y:0},disabledHosts:['example.com','sub.example.com']}));
const defaults = await store.read();
test('initial read does not write', () => assert.equal(writes, 0));
test('default top right', () => assert.deepEqual(defaults.position, { x:1,y:0 }));
await Promise.all([store.update({position:{x:.3,y:.7}}),store.update({host:'example.com',enabled:false})]);
test('concurrent position and site survive', () => assert.deepEqual(data[ISLAND_KEY], {schemaVersion:1,position:{x:.3,y:.7},disabledHosts:['example.com']}));
await store.update({reset:true});
test('reset preserves hosts', () => assert.deepEqual(data[ISLAND_KEY].disabledHosts,['example.com']));
fail=true;
await assert.rejects(store.update({position:{x:.1,y:.2}}), /storage-full/); passed++; console.log('✓ write failure propagates');
test('failed write leaves previous value', () => assert.deepEqual(data[ISLAND_KEY].position,{x:1,y:0}));
fail=false; await store.update({host:'example.com',enabled:true});
test('queue recovers after failure', () => assert.deepEqual(data[ISLAND_KEY].disabledHosts,[]));
await assert.rejects(store.update({position:{x:NaN,y:0}}), /有效数值/); passed++;
test('business data untouched', () => assert.deepEqual({records:data.records,settings:data.settings,knowledgeLibrary:data.knowledgeLibrary}, {records:[{id:'keep'}],settings:{apiKey:'private'},knowledgeLibrary:{keep:true}}));
for (const v of [{width:1440,height:900},{width:320,height:480},{width:200,height:180},{width:80,height:80}]) {
 for (const p of [{x:0,y:0},{x:1,y:1},{x:.5,y:.5},{x:1,y:0}]) {
  test(`bounds ${v.width} ${p.x},${p.y}`, () => {const b=C.bounds(p,v,{width:304,height:230});assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=v.width+.01&&b.y+b.height<=v.height+.01);});
  test(`position reversible ${v.width} ${p.x},${p.y}`, () => assert.deepEqual(C.normalize(C.point(p,v),v),{x:C.area(v).x?p.x:1,y:C.area(v).y?p.y:0}));
 }
}
test('edge expands inward', () => {const b=C.bounds({x:1,y:1},{width:1200,height:900},{width:304,height:230});assert.ok(b.right&&b.bottom);assert.equal(b.x+b.width,1184);});
test('resize clamp does not mutate memory', () => {const p={x:.9,y:.7}; C.bounds(p,{width:200,height:180},{width:304,height:230});assert.deepEqual(p,{x:.9,y:.7});});
test('approved collapsed size',()=>assert.deepEqual(C.size,{width:56,height:36,margin:16}));
for(const v of [{width:1440,height:900},{width:320,height:480},{width:200,height:180}])for(const p of [{x:0,y:0},{x:1,y:0},{x:0,y:1},{x:1,y:1}]){
 test(`menu within viewport ${v.width} ${p.x},${p.y}`,()=>{const anchor=C.bounds(p,v,{width:212,height:44});const menu=C.popover(anchor,v,{width:178,height:94});assert.ok(menu.x>=0&&menu.y>=0&&menu.x+menu.width<=v.width&&menu.y+menu.height<=v.height);if(p.y===0)assert.ok(menu.y>=anchor.y+anchor.height);});
}
test('below drag threshold remains click', () => assert.equal(C.dragged({x:0,y:0},{x:3,y:4}),false));
test('threshold starts drag', () => assert.equal(C.dragged({x:0,y:0},{x:6,y:0}),true));
let reasons=C.hide(new Set(),'review',true);reasons=C.hide(reasons,'capture:a',true);reasons=C.hide(reasons,'site-disabled',true);reasons=C.hide(reasons,'capture:a',false);
test('release only own hidden reason', () => assert.deepEqual([...reasons],['review','site-disabled']));
test('cancelled task invalid', () => assert.equal(C.currentTask({id:'a',deadline:20,cancelled:true},'a',10),false));
test('expired task invalid', () => assert.equal(C.currentTask({id:'a',deadline:20},'a',21),false));
test('late old id invalid', () => assert.equal(C.currentTask({id:'a',deadline:20},'b',10),false));
test('current live task valid', () => assert.equal(C.currentTask({id:'a',deadline:20},'a',10),true));
console.log(`\n${passed}/${passed} passed`);

// Exercise actual background routes, trusted senders and native entry callbacks.
const messages=[], commands=[], menus=[], installed=[];let local={}, writeFail=false, captureCount=0, captureFail=false;
let active={id:1,windowId:2,url:'https://example.com/job',active:true};
const storage={get:async key=> typeof key==='string'?{[key]:local[key]}:{...local},set:async patch=>{if(writeFail)throw Error('disk unavailable');Object.assign(local,structuredClone(patch));},remove:async key=>{delete local[key];}};
globalThis.chrome={
 storage:{local:storage,session:storage,onChanged:{addListener(){}}},
 sidePanel:{open:async()=>{}},
 runtime:{sendMessage:async()=>({}),id:'island-test',getURL:p=>`chrome-extension://island-test/${p}`,onMessage:{addListener:f=>messages.push(f)},onInstalled:{addListener:f=>installed.push(f)},onStartup:{addListener(){}},getPlatformInfo:async()=>({}),openOptionsPage:async()=>{}},
 tabs:{TAB_ID_NONE:-1,get:async()=>active,query:async()=>[active],onRemoved:{addListener(){}},onUpdated:{addListener(){}},create:async()=>({id:5}),update:async()=>{},sendMessage:async(id,msg)=>{if(msg.type==='JDT_ISLAND_PING')return{pong:true,documentId:'doc-1'};if(msg.type==='JDT_ISLAND_PREPARE')return{ok:true,documentId:'doc-1'};if(msg.type==='JDT_PING')return{pong:true};return{ok:true};},captureVisibleTab:async()=>{if(captureFail)throw Error('capture unavailable');captureCount++;return'data:image/jpeg;base64,AAAA';}},
 windows:{getLastFocused:async()=>({id:2}),get:async()=>({focused:true}),update:async()=>{}},permissions:{contains:async()=>true},scripting:{executeScript:async()=>{}},notifications:{create:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},contextMenus:{onClicked:{addListener:f=>menus.push(f)},removeAll:async()=>{},create(){}},commands:{onCommand:{addListener:f=>commands.push(f)}}
};
await import('../src/background.js');
const pageSender={id:'island-test',url:active.url,frameId:0,tab:active};
const extSender={id:'island-test',url:'chrome-extension://island-test/src/popup/popup.html'};
const bg=(msg,sender=pageSender)=>new Promise(resolve=>messages[0](msg,sender,resolve));
const state=await bg({type:'ISLAND_GET_STATE'});
test('actual page state is minimal',()=>{assert.equal(state.ok,true);assert.deepEqual(Object.keys(state).sort(),['available','enabled','host','ok','permission','preferences']);});
const iframe=await bg({type:'ISLAND_GET_STATE'},{...pageSender,frameId:1});test('iframe refused',()=>assert.equal(iframe.ok,false));
const a=await Promise.all([bg({type:'ISLAND_SET_POSITION',position:{x:.2,y:.4}}),bg({type:'ISLAND_SET_SITE',host:'evil.com',enabled:false})]);
test('actual route queue and trusted hostname',()=>{assert.ok(a.every(x=>x.ok));assert.deepEqual(local.islandPreferences,{schemaVersion:1,position:{x:.2,y:.4},disabledHosts:['example.com']});});
writeFail=true;const failed=await bg({type:'ISLAND_SET_POSITION',position:{x:.8,y:.9}});writeFail=false;
test('actual route storage failure response',()=>assert.deepEqual(failed,{ok:false,error:'disk unavailable'}));
const restored=await bg({type:'ISLAND_SET_SITE',host:'example.com',enabled:true},extSender);
test('extension page can restore hidden site',()=>assert.deepEqual(restored.preferences.disabledHosts,[]));
local.settings={apiKey:'mock-only'};
await commands[0]('capture-region');await commands[0]('capture-viewport');
await menus[0]({menuItemId:'jdt-capture-question'},active);
await bg({type:'START_CAPTURE',mode:'region'});await bg({type:'RECAPTURE',mode:'viewport'});
test('all five entry routes share capture',()=>assert.equal(captureCount,5));
captureFail=true;const failedCapture=await bg({type:'START_CAPTURE'});captureFail=false;
test('capture failure visible and next request recoverable',()=>assert.match(failedCapture.error,/capture unavailable/));
assert.equal((await bg({type:'START_CAPTURE'})).ok,true);passed++;
active={...active,active:false};const switched=await bg({type:'START_CAPTURE'});
test('inactive initiating tab refuses capture',()=>assert.match(switched.error,/已切换/));
active={...active,active:true};chrome.windows.get=async()=>({focused:false});const switchedWindow=await bg({type:'START_CAPTURE'});
test('inactive window refuses capture',()=>assert.match(switchedWindow.error,/已切换/));chrome.windows.get=async()=>({focused:true});
const noKeySettings=local.settings;local.settings={apiKey:''};const noKey=await bg({type:'START_CAPTURE'});local.settings=noKeySettings;
test('missing key gives setup response',()=>assert.equal(noKey.needSetup,true));
let injectedFiles=[];chrome.scripting.executeScript=async params=>{injectedFiles=params.files;};
active={...active,active:true};await installed[0]({reason:'update'});
test('update injects existing ordinary tabs in core-first order',()=>assert.deepEqual(injectedFiles,['src/lib/island-core.js','src/content/island.js']));
console.log(`\n${passed}/${passed} total passed`);
