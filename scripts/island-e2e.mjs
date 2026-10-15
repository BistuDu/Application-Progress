/** Formal manifest, isolated profile, localhost model mock. No real credentials. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CDP, httpJson, waitFor } from './cdp.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),OUT=path.join(ROOT,'tmp/island-glass-qa');fs.mkdirSync(OUT,{recursive:true});
const EXT=path.join(os.tmpdir(),'jdt-island-ext'),PROFILE=path.join(os.tmpdir(),'jdt-island-profile');
fs.rmSync(EXT,{recursive:true,force:true});fs.mkdirSync(EXT,{recursive:true});
for(const p of ['manifest.json','src','icons'])fs.cpSync(path.join(ROOT,p),path.join(EXT,p),{recursive:true});
fs.rmSync(PROFILE,{recursive:true,force:true});
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');
const CHROME=process.env.JDT_CHROME||fs.readdirSync(cache).filter(x=>x.startsWith('chromium-')).sort().reverse().map(x=>path.join(cache,x,'chrome-mac/Chromium.app/Contents/MacOS/Chromium')).find(fs.existsSync);
let modelDelay=700, requests=0, modelError=false, lastImage='';
const job={is_job:true,company:'Example 科技',title:'测试开发工程师（实习）',location:'上海',salary:'200–300 元/天',jd:'设计稳定、高效的测试系统',requirements:'Java SQL Linux',skills:['Java','SQL','Linux'],summary:'实习测试开发岗位'};
const server=http.createServer(async(req,res)=>{
 if(req.method==='POST'){
  requests++;let body='';for await(const chunk of req)body+=chunk;
  const input=JSON.parse(body), text=JSON.stringify(input.messages);
  lastImage=input.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(x=>x.type==='image_url')?.image_url?.url||'';
  const question=text.includes('候选问答')||text.includes('题目与答案')||text.includes('questions');
  const result=question?{questions:[{question:'为什么 B+ 树适合索引？',answerMarkdown:'叶子节点链表方便范围查询。',category:'数据库',tags:['索引']}]}:job;
  setTimeout(()=>{if(modelError){res.writeHead(401);res.end('{"error":{"message":"invalid key"}}');return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));},modelDelay);return;
 }
 if(req.url==='/frame'){res.end('<html><body>子框架</body></html>');return;}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(ROOT,'scripts/island-testpage.html')));
});
await new Promise(r=>server.listen(8782,'0.0.0.0',r));
let proc,browser,sw,extId;const connections=[];let pass=0;
function check(name,value){if(!value)throw Error(`FAIL: ${name}`);pass++;console.log(`✓ ${name}`);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){proc=spawn(CHROME,[`--user-data-dir=${PROFILE}`,`--load-extension=${EXT}`,`--disable-extensions-except=${EXT}`,'--remote-debugging-port=9432','--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--window-size=1200,850','about:blank'],{stdio:'ignore'});const v=await waitFor(()=>httpJson('http://127.0.0.1:9432/json/version'));browser=await CDP.connect(v.webSocketDebuggerUrl);const w=await waitFor(async()=> (await httpJson('http://127.0.0.1:9432/json/list')).find(t=>t.type==='service_worker'));sw=await CDP.connect(w.webSocketDebuggerUrl);extId=new URL(w.url).host;await sw.send('Runtime.enable');await waitFor(()=>sw.eval('!!globalThis.chrome?.storage?.local'));}
async function stop(){for(const c of connections)c.close();connections.length=0;sw?.close();await browser?.send('Browser.close').catch(()=>{});browser?.close();if(proc.exitCode===null&&proc.signalCode===null)await new Promise(r=>proc.once('exit',r));await sleep(250);}
async function open(url){const t=await browser.send('Target.createTarget',{url});const info=await waitFor(async()=> (await httpJson('http://127.0.0.1:9432/json/list')).find(x=>x.id===t.targetId));const c=await CDP.connect(info.webSocketDebuggerUrl);connections.push(c);c.contexts=[];c.on(m=>{if(m.method==='Runtime.executionContextCreated')c.contexts.push(m.params.context);if(m.method==='Runtime.executionContextsCleared')c.contexts=[];});await c.send('Runtime.enable');await c.send('Page.enable');await waitFor(()=>c.eval('document.readyState==="complete"'));return c;}
const $root=`document.getElementById('jdt-island-host').shadowRoot`;
async function context(c){return waitFor(async()=>{for(const x of c.contexts.filter(x=>!x.auxData?.isDefault)){try{if(await c.eval('!!globalThis.__JDT_ISLAND__',{contextId:x.id}))return x.id;}catch{}}});}
async function islandSend(c,msg){const id=await context(c);return c.eval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`,{contextId:id});}
async function ready(c){await waitFor(()=>c.eval(`!!document.getElementById('jdt-island-host')?.shadowRoot`));await sleep(120);}
async function front(c){await c.send('Page.bringToFront');await sleep(120);}
async function click(c,sel){const b=await c.eval(`(()=>{const b=${$root}.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...b,button:'left',buttons:1,clickCount:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',buttons:0,clickCount:1});}
async function shot(c,name){await c.send('Page.bringToFront');fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(await c.screenshot({format:'png'}),'base64'));}
async function expand(c){await front(c);if(await c.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`))return;await waitFor(()=>c.eval(`${$root}.querySelector('.surface').classList.contains('collapsed')`));await click(c,'.toggle');await waitFor(()=>c.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`));await sleep(300);}
async function collapse(c){if(await c.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`)){await c.eval(`${$root}.querySelector('.action').focus()`);await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});if(await c.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`))await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}await sleep(300);}
async function appearance(c,scheme){await c.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});await sleep(80);}
async function closeOverlay(c){await c.eval(`document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('#jdt-close2,#jdt-close,#jdt-close-kb')?.click()`);}
async function select(c){await waitFor(()=>c.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('.shot')`));await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x:180,y:170,button:'left',buttons:1});await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:720,y:610,button:'left',buttons:1});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:720,y:610,button:'left',buttons:0});}
async function processing(c){await waitFor(()=>c.eval(`${$root}.querySelector('.surface').classList.contains('processing')`));await sleep(300);}
try{
 await launch();await sw.eval(`chrome.storage.local.set({settings:{apiBase:'http://127.0.0.1:8782',apiKey:'mock-only',model:'mock',timeoutMs:4000}})`);
 const a=await open('http://127.0.0.1:8782'),b=await open('http://localhost:8782'),same=await open('http://127.0.0.1:8782/other');await ready(a);await ready(b);await ready(same);await front(a);
 check('formal manifest all_urls and top frame',JSON.parse(fs.readFileSync(path.join(EXT,'manifest.json'))).host_permissions.includes('<all_urls>'));
 check('automatic single icon no words',await a.eval(`${$root}.querySelector('.toggle').innerText===''&&${$root}.querySelector('.panel').hidden`));
 check('iframe no duplicate',await a.eval(`document.querySelector('iframe').contentDocument.querySelectorAll('#jdt-island-host').length===0`));
 check('idle no model requests',requests===0);
 const publicState=await islandSend(a,{type:'ISLAND_GET_STATE'});check('minimal state no credentials/business',!JSON.stringify(publicState).includes('mock-only')&&!('records'in publicState)&&publicState.host==='127.0.0.1');
 check('page cannot spoof hostname', (await islandSend(a,{type:'ISLAND_SET_SITE',host:'localhost',enabled:false})).preferences.disabledHosts.includes('127.0.0.1'));
 await waitFor(()=>same.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));check('same host synchronized, second host visible',await b.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));
 await islandSend(a,{type:'ISLAND_SET_SITE',enabled:true});await ready(a);
 await sw.eval(`(async()=>chrome.scripting.executeScript({target:{tabId:(await chrome.tabs.query({})).find(t=>t.url==="http://127.0.0.1:8782/").id},files:['src/lib/island-core.js','src/content/island.js']}))()`);
 check('repeated injection single host',await a.eval(`document.querySelectorAll('#jdt-island-host').length===1`));
 await a.eval(`document.getElementById('jdt-island-host').remove()`);await ready(a);check('SPA host remounted',await a.eval(`document.querySelectorAll('#jdt-island-host').length===1`));
 await shot(a,'light-collapsed');for(const style of ['dark','dense']){await appearance(a,style==='dark'?'dark':'light');await a.eval(`document.body.className=${JSON.stringify(style)}`);await shot(a,`${style}-collapsed`);}await a.eval(`document.body.className=''`);await expand(a);check('four actions fit',await a.eval(`${$root}.querySelectorAll('.action').length===4&&[...${$root}.querySelectorAll('.action')].every(n=>n.scrollWidth<=n.clientWidth)`));await shot(a,'light-expanded');

 check('icon-only row with more, no old labels',await a.eval(`${$root}.querySelectorAll('.action,.more').length===5&&${$root}.querySelector('.panel').innerText.trim()===''&&!${$root}.querySelector('.foot,.label')`));
 check('approved expanded dimensions and glass',await a.eval(`(()=>{const r=${$root}.querySelector('.surface').getBoundingClientRect();const css=getComputedStyle(${$root}.querySelector('.surface'));return Math.abs(r.width-212)<1&&Math.abs(r.height-44)<1&&css.backdropFilter.includes('24px')})()`));
 const lightInk=await a.eval(`getComputedStyle(${$root}.querySelector('.surface')).color`),appearancePrefs=JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences);
 await appearance(a,'dark');check('system change updates glass without writing preferences',lightInk!==await a.eval(`getComputedStyle(${$root}.querySelector('.surface')).color`)&&appearancePrefs===JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences));await appearance(a,'light');
 await click(a,'.more');await sleep(180);await shot(a,'light-more');check('more menu exposes reset and site disable',await a.eval(`!${$root}.querySelector('.more-menu').hidden&&${$root}.querySelectorAll('.menu-action').length===2`));
 await a.eval(`${$root}.querySelector('.more').focus()`);await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});check('ArrowDown enters more menu',await a.eval(`${$root}.activeElement?.dataset.action==='reset'`));await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});check('menu arrow navigation reaches site control',await a.eval(`${$root}.activeElement?.dataset.action==='disable'`));
 await a.eval(`${$root}.querySelector('.menu-action').focus()`);await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});check('first Escape returns to more',await a.eval(`${$root}.querySelector('.more-menu').hidden&&${$root}.activeElement===${$root}.querySelector('.more')&&${$root}.querySelector('.surface').classList.contains('expanded')`));
 await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});check('second Escape returns to collapsed icon',await a.eval(`${$root}.activeElement===${$root}.querySelector('.toggle')`));await sleep(300);await expand(a);
 for(const action of ['job','question','dashboard','knowledge']){await a.eval(`${$root}.querySelector('[data-action="${action}"]').focus()`);await sleep(500);check(`${action} focus tooltip accessible`,await a.eval(`${$root}.querySelector('.tip').textContent===${$root}.activeElement.getAttribute('aria-label')&&!${$root}.querySelector('.tip').hidden`));}
 await click(a,'.more');await click(a,'[data-action="reset"]');check('more reset returns to right top',JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.position)===JSON.stringify({x:1,y:0}));
 await click(a,'.more');await click(a,'[data-action="disable"]');await waitFor(()=>a.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));check('more site disable uses existing preference', (await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.disabledHosts.includes('127.0.0.1'));await islandSend(a,{type:'ISLAND_SET_SITE',enabled:true});await sleep(150);await expand(a);
 await appearance(a,'dark');await a.eval(`document.body.className='dark'`);await shot(a,'dark-expanded');await click(a,'.more');await sleep(180);await shot(a,'dark-more');await click(a,'.more');await appearance(a,'light');await a.eval(`document.body.className='dense'`);await shot(a,'dense-expanded');await a.eval(`document.body.className=''`);
 // Collapse with Escape scoped to widget; page input works afterwards.
 await a.eval(`${$root}.querySelector('.action').focus()`);await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await sleep(300);check('Escape collapses and returns focus',await a.eval(`${$root}.activeElement===${$root}.querySelector('.toggle')&&${$root}.querySelector('.toggle').getAttribute('aria-expanded')==='false'`));
 await a.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await a.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await sleep(300);check('Enter expands',await a.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`));await collapse(a);await sleep(300);
 await a.eval(`document.querySelector('input').focus()`);await a.send('Input.insertText',{text:'普通网页输入'});check('page input unaffected',await a.eval(`document.querySelector('input').value==='普通网页输入'`));
 // Drag with real pointer input.
 const pos=await a.eval(`(()=>{const b=${$root}.querySelector('.toggle').getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
 await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pos.x-340,y:pos.y+280,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x-340,y:pos.y+280,button:'left',buttons:0});await sleep(500);
 let pref=(await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences;check('drag saves and does not click-expand',pref.position.x<.9&&pref.position.y>.2&&await a.eval(`${$root}.querySelector('.surface').classList.contains('collapsed')`));
 check('position synchronized other hostname',JSON.stringify((await islandSend(b,{type:'ISLAND_GET_STATE'})).preferences.position)===JSON.stringify(pref.position));

 // Cancel/blur leave remembered coordinates intact; remote completion defers while dragging.

 let concurrentPoint=await a.eval(`(()=>{const r=${$root}.querySelector('.toggle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...concurrentPoint,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:concurrentPoint.x+30,y:concurrentPoint.y+40,button:'left',buttons:1});
 const during=await a.eval(`${$root}.querySelector('.surface').getBoundingClientRect().x`);
 await islandSend(b,{type:'ISLAND_SET_POSITION',position:{x:.1,y:.1}});await sleep(150);
 check('remote position deferred during active drag',await a.eval(`${$root}.querySelector('.surface').getBoundingClientRect().x`)===during);
 await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:concurrentPoint.x+30,y:concurrentPoint.y+40,button:'left',buttons:0});await sleep(400);
 pref=(await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences;
 check('last completed drag wins after remote write',pref.position.x>.1&&pref.position.y>.1);
 const memory=JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.position);
 let dragPoint=await a.eval(`(()=>{const r=${$root}.querySelector('.toggle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...dragPoint,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x-30,y:dragPoint.y+30,button:'left',buttons:1});
 await a.eval(`${$root}.querySelector('.surface').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1}))`);await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragPoint.x-30,y:dragPoint.y+30,button:'left',buttons:0});
 check('pointercancel does not save temporary drag',JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.position)===memory);
 dragPoint=await a.eval(`(()=>{const r=${$root}.querySelector('.toggle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...dragPoint,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x+20,y:dragPoint.y+20,button:'left',buttons:1});
 await a.eval(`window.dispatchEvent(new Event('blur'))`);await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragPoint.x+20,y:dragPoint.y+20,button:'left',buttons:0});
 check('blur does not save interrupted drag',JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.position)===memory);
 await a.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:false});await expand(a);await shot(a,'narrow-expanded');check('narrow bounds and no overflow',await a.eval(`(()=>{const b=${$root}.querySelector('.surface').getBoundingClientRect();return b.x>=0&&b.right<=document.documentElement.clientWidth&&b.bottom<=document.documentElement.clientHeight})()`));
 await a.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await a.send('Emulation.setDeviceMetricsOverride',{width:320,height:480,deviceScaleFactor:1,mobile:false});await sleep(350);check('coarse pointer keeps five 44px targets',await a.eval(`matchMedia('(pointer:coarse)').matches&&[...${$root}.querySelectorAll('.action,.more')].every(n=>n.getBoundingClientRect().width>=44)`));await shot(a,'coarse-pointer');await a.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await a.send('Emulation.setDeviceMetricsOverride',{width:240,height:480,deviceScaleFactor:1,mobile:false});await sleep(300);await shot(a,'narrow-compact-row');check('narrow row fits all five icons',await a.eval(`(()=>{const s=${$root}.querySelector('.surface').getBoundingClientRect();return[...${$root}.querySelectorAll('.action,.more')].every(n=>{const r=n.getBoundingClientRect();return r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom})})()`));
 check('resize did not save clamp',JSON.stringify((await islandSend(a,{type:'ISLAND_GET_STATE'})).preferences.position)===JSON.stringify(pref.position));
 const anchor=await a.eval(`(()=>{const r=${$root}.querySelector('.surface').getBoundingClientRect();return{x:${pref.position.x}>.5?r.right-28:r.left+28,y:${pref.position.y}>.5?r.bottom-18:r.top+18,top:r.top}})()`),narrowPoint={x:anchor.x,y:anchor.top+2},delta={x:anchor.x>120?-12:12,y:anchor.y>240?-12:12},narrowEnd={x:narrowPoint.x+delta.x,y:narrowPoint.y+delta.y};
 await a.send('Input.dispatchMouseEvent',{type:'mousePressed',...narrowPoint,button:'left',buttons:1});await a.send('Input.dispatchMouseEvent',{type:'mouseMoved',...narrowEnd,button:'left',buttons:1});
 check('drag expanded clamped row preserves visible anchor',await a.eval(`(()=>{const r=${$root}.querySelector('.toggle').getBoundingClientRect();return Math.abs(r.x+r.width/2-${anchor.x+delta.x})<2&&Math.abs(r.y+r.height/2-${anchor.y+delta.y})<2})()`));
 await a.send('Input.dispatchMouseEvent',{type:'mouseReleased',...narrowEnd,button:'left',buttons:0});await sleep(200);await islandSend(a,{type:'ISLAND_SET_POSITION',position:pref.position});await sleep(300);await expand(a);
 await a.send('Emulation.clearDeviceMetricsOverride');await collapse(a);await sleep(300);
 for(const [x,y,name] of [[0,1,'bottom-left'],[1,1,'bottom-right']]){await islandSend(a,{type:'ISLAND_SET_POSITION',position:{x,y}});await sleep(300);await expand(a);await shot(a,name);await click(a,'.more');await sleep(180);check(`${name} menu stays in visible viewport`,await a.eval(`(()=>{const r=${$root}.querySelector('.more-menu').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=document.documentElement.clientWidth&&r.bottom<=document.documentElement.clientHeight})()`));await shot(a,name+'-more');await collapse(a);await sleep(300);}await islandSend(a,{type:'ISLAND_RESET_POSITION'});await sleep(300);await expand(a);await shot(a,'right-expanded');
 await click(a,'[data-action="job"]');await waitFor(()=>a.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('.shot')`));check('direct page button starts without toolbar grant',true);
 check('selection hides full island',await a.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));
 const image=await a.eval(`document.getElementById('jdt-overlay-host').shadowRoot.querySelector('.shot').src`);fs.writeFileSync(path.join(OUT,'captured-without-island.jpg'),Buffer.from(image.split(',')[1],'base64'));
 modelDelay=2000;await select(a);await processing(a);await shot(a,'processing');for(const style of ['dark','dense']){await appearance(a,style==='dark'?'dark':'light');await a.eval(`document.body.className=${JSON.stringify(style)}`);await shot(a,`${style}-processing`);}await a.eval(`document.body.className=''`);check('processing page local and elapsed',await b.eval(`${$root}.querySelector('.surface').classList.contains('collapsed')`)&&await a.eval(`${$root}.querySelector('.elapsed').textContent.includes('秒')`));
 await waitFor(()=>a.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('#jdt-save')`));check('JD review hides island, no auto save',await a.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`)&&(await sw.eval(`chrome.storage.local.get('records')`)).records===undefined);
 await a.eval(`document.getElementById('jdt-overlay-host').shadowRoot.querySelector('#jdt-save').click()`);await waitFor(()=>sw.eval(`chrome.storage.local.get('records').then(r=>r.records?.length===1)`));check('explicit save works',true);await sleep(4500);await shot(a,'saved');for(const style of ['dark','dense']){await appearance(a,style==='dark'?'dark':'light');await a.eval(`document.body.className=${JSON.stringify(style)}`);await shot(a,`${style}-saved`);}await a.eval(`document.body.className=''`);check('saved terminal follows actual persistence',await a.eval(`${$root}.querySelector('.status').textContent.includes('已保存')`));await sleep(1900);await closeOverlay(a);await front(a);
 // Late response cancelled, no records/session/new knowledge page.
 modelDelay=2500;await expand(a);await click(a,'[data-action="question"]');await select(a);await processing(a);await click(a,'.cancel');await shot(a,'cancelled');await sleep(2900);
 check('cancelled question leaves no handoff',!(await sw.eval(`chrome.storage.session.get('knowledgePending')`)).knowledgePending);
 check('late response no knowledge page',!(await httpJson('http://127.0.0.1:9432/json/list')).some(t=>t.url.includes('/knowledge/')));
 check('cancel leaves collapsed usable island',await a.eval(`${$root}.querySelector('.surface').classList.contains('collapsed')`));
 // Disable during processing falls back without cancelling.
 modelDelay=3500;await expand(a);await click(a,'[data-action="job"]');await select(a);await processing(a);await islandSend(a,{type:'ISLAND_SET_SITE',enabled:false});await waitFor(()=>a.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('#jdt-abort')`));check('disable switches to original cancel UI',true);await shot(a,'disabled-processing');await a.eval(`document.getElementById('jdt-overlay-host').shadowRoot.querySelector('#jdt-abort').click()`);await sleep(100);check('hidden remains after cancel',await a.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));
 await a.send('Page.reload');await ready(a);check('disabled survives refresh',await a.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));
 await stop();await launch();const restarted=await open('http://127.0.0.1:8782');await ready(restarted);check('disabled survives browser restart',await restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='hidden'`));
 const options=await open(`chrome-extension://${extId}/src/options/options.html`);await waitFor(()=>options.eval(`!!document.querySelector('#island-sites button')`));await options.eval(`document.querySelector('#island-sites button').click()`);await waitFor(()=>restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));check('options restore hidden host',true);check('extension page has no island',await options.eval(`!document.getElementById('jdt-island-host')`));
 const blank=await open('about:blank');check('built-in page no island',await blank.eval(`!document.getElementById('jdt-island-host')`));
 // Four shortcuts reuse tabs.
 await front(restarted);await expand(restarted);await click(restarted,'[data-action="dashboard"]');await sleep(400);let tabs=await httpJson('http://127.0.0.1:9432/json/list');check('dashboard shortcut opens',tabs.some(t=>t.url.includes('/dashboard/')));
 await front(restarted);await expand(restarted);await click(restarted,'[data-action="dashboard"]');await sleep(300);tabs=await httpJson('http://127.0.0.1:9432/json/list');check('dashboard reuses existing',tabs.filter(t=>t.url.includes('/dashboard/')).length===1);
 await front(restarted);await expand(restarted);await click(restarted,'[data-action="knowledge"]');await sleep(400);check('knowledge shortcut opens',(await httpJson('http://127.0.0.1:9432/json/list')).some(t=>t.url.includes('/knowledge/')));
 await front(restarted);await expand(restarted);await click(restarted,'[data-action="knowledge"]');await sleep(300);check('knowledge reuses existing',(await httpJson('http://127.0.0.1:9432/json/list')).filter(t=>t.url.includes('/knowledge/')).length===1);
 // Reduced motion, tooltip and transition frames.
 await front(restarted);await restarted.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await expand(restarted);check('reduced motion no shape animation',await restarted.eval(`getComputedStyle(${$root}.querySelector('.surface')).transitionDuration==='0s'`));await shot(restarted,'reduced-motion');await collapse(restarted);await restarted.send('Emulation.setEmulatedMedia',{features:[]});
 await click(restarted,'.toggle');await shot(restarted,'transition-early');await sleep(100);await shot(restarted,'transition-mid');await sleep(200);await shot(restarted,'transition-final');

 // Native keyboard Space / Tab and hover does not expand.
 await collapse(restarted);await sleep(300);
 await restarted.eval(`${$root}.querySelector('.toggle').focus()`);
 await restarted.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await restarted.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
 check('Space expands',await restarted.eval(`${$root}.querySelector('.surface').classList.contains('expanded')`));
 await restarted.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
 check('Tab reaches shortcut',await restarted.eval(`${$root}.activeElement?.classList.contains('action')`));await collapse(restarted);await sleep(300);
 const togglePoint=await restarted.eval(`(()=>{const b=${$root}.querySelector('.toggle').getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
 await restarted.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:400});await restarted.send('Input.dispatchMouseEvent',{type:'mouseMoved',...togglePoint});await sleep(550);
 check('hover shows tooltip only',await restarted.eval(`!${$root}.querySelector('.tip').hidden&&${$root}.querySelector('.panel').hidden`));await shot(restarted,'tooltip');
 // Pixel audit on a distinctive blue backdrop; both light and dark glass alter these pixels if leaked.
 async function auditShot(c,label){
  await waitFor(()=>c.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('.shot')`));
  check(`${label}: captured image excludes island/menu/tooltip`,await c.eval(`(async()=>{const img=document.getElementById('jdt-overlay-host').shadowRoot.querySelector('.shot');await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const sx=img.naturalWidth/innerWidth,sy=img.naturalHeight/innerHeight;return[[innerWidth-44,35],[innerWidth-44,85],[innerWidth-100,120]].every(([x,y])=>{const rgb=ctx.getImageData(x*sx,y*sy,1,1).data;return Math.abs(rgb[0]-23)<12&&Math.abs(rgb[1]-92)<12&&Math.abs(rgb[2]-156)<12})})()`));
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(650);
 }
 // The actual popup route and the callbacks' shared function use the same screenshot handshake.
 await front(restarted);const popup=await open(`chrome-extension://${extId}/src/popup/popup.html`);await front(restarted);
 await restarted.eval(`(()=>{const d=document.createElement('div');d.id='capture-reference';d.style.cssText='position:fixed;right:0;top:0;width:400px;height:180px;background:rgb(23,92,156);z-index:2147483645;pointer-events:none';document.documentElement.append(d)})()`);
 await expand(restarted);await click(restarted,'.more');await sleep(180);
 await popup.eval(`chrome.runtime.sendMessage({type:'START_CAPTURE',mode:'region'})`);await auditShot(restarted,'toolbar');
 await popup.eval(`chrome.runtime.sendMessage({type:'START_CAPTURE',mode:'region'})`);await auditShot(restarted,'keyboard shared capture');

 check('context capture accepted',(await islandSend(restarted,{type:'START_CAPTURE',mode:'region',target:'technical-question'})).ok);await auditShot(restarted,'context-menu shared capture');
 check('recapture accepted',(await islandSend(restarted,{type:'RECAPTURE',mode:'region'})).ok);await auditShot(restarted,'recapture');await restarted.eval(`document.getElementById('capture-reference').remove()`);
 // Website toggle and reset via popup; hidden site remains accessible from the popup.
 await popup.send('Page.reload');await sleep(350);await front(restarted);await popup.eval(`renderIsland()` ).catch(()=>{});
 const toggled=await popup.eval(`chrome.runtime.sendMessage({type:'ISLAND_SET_SITE',enabled:false})`);
 check('popup can disable current active website',toggled.ok&&toggled.preferences.disabledHosts.includes('127.0.0.1'));
 const reset=await popup.eval(`chrome.runtime.sendMessage({type:'ISLAND_RESET_POSITION'})`);check('popup reset keeps site switch',reset.preferences.disabledHosts.includes('127.0.0.1'));
 await popup.eval(`chrome.runtime.sendMessage({type:'ISLAND_SET_SITE',enabled:true})`);await sleep(100);
 // Failures must release capture reason; no unbounded hidden state.
 await sw.eval(`globalThis.originalCapture=chrome.tabs.captureVisibleTab;chrome.tabs.captureVisibleTab=async()=>{throw new Error('simulated screenshot failure')}`);
 const failure=await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await sw.eval(`chrome.tabs.captureVisibleTab=globalThis.originalCapture`);
 check('capture API failure reported and host restored',!failure.ok&&await restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));
 // Inject failure after screenshot must also release.
 await sw.eval(`globalThis.originalInject=chrome.scripting.executeScript;globalThis.originalSend=chrome.tabs.sendMessage;chrome.tabs.sendMessage=(id,msg,...args)=>msg.type==='JDT_PING'?Promise.reject(new Error('not loaded')):originalSend(id,msg,...args);chrome.scripting.executeScript=async()=>{throw new Error('simulated injection failure')}`);
 const injection=await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await sw.eval(`chrome.scripting.executeScript=originalInject;chrome.tabs.sendMessage=originalSend`);
 check('injection failure releases capture reason',!injection.ok&&await restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));await sleep(1900);

 // Simulate a worker that disappeared after acknowledging hide, before finally release.
 const leasedTab=await sw.eval(`chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0].id)`);
 await sw.eval(`chrome.tabs.sendMessage(${leasedTab},{type:'JDT_ISLAND_PREPARE',token:'lost-release'})`);await sleep(6200);
 check('lost screenshot release expires without permanent hide',await restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));await sleep(1900);
 // Background lost-result and worker interruption both recover through the page watchdog.
 await sw.eval(`chrome.storage.local.get('settings').then(r=>chrome.storage.local.set({settings:{...r.settings,timeoutMs:1000}}))`);
 modelDelay=600;await sw.eval(`globalThis.originalSend=chrome.tabs.sendMessage;chrome.tabs.sendMessage=(id,msg,...args)=>msg.type==='JDT_ANALYZE_RESULT'?Promise.resolve({ok:true}):originalSend(id,msg,...args)`);
 await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await select(restarted);await processing(restarted);await sleep(6400);
 check('lost result exits processing with readable error',await restarted.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.textContent.includes('未按时返回')`));await sw.eval(`chrome.tabs.sendMessage=originalSend`);await closeOverlay(restarted);await sleep(1900);
 // Delayed response cancellation for JD; later results must not reopen review or persist.
 modelDelay=2500;await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await select(restarted);await processing(restarted);await click(restarted,'.cancel');await sleep(2800);
 check('late JD result cannot reopen review',await restarted.eval(`!document.getElementById('jdt-overlay-host')`));
 check('late JD result does not save',await sw.eval(`chrome.storage.local.get('records').then(r=>r.records.length===1)`));
 // A switch during paint preparation stops the source request.
 const other=await open('http://localhost:8782/race');await ready(other);await front(restarted);
 const ctx=await context(restarted);await restarted.eval(`globalThis.originalRAF=requestAnimationFrame;globalThis.requestAnimationFrame=(fn)=>originalRAF(()=>setTimeout(fn,180));`,{contextId:ctx});
 const capturePromise=islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await sleep(50);await front(other);const race=await capturePromise;
 check('tab switch stops capture with feedback',!race.ok&&/切换|绘制|超时/.test(race.error));await restarted.eval(`globalThis.requestAnimationFrame=originalRAF`,{contextId:ctx});await front(restarted);await sleep(400);
 check('tab race does not leave host hidden',await restarted.eval(`getComputedStyle(document.getElementById('jdt-island-host')).visibility==='visible'`));

 // Page navigation ends processing; the next document starts idle.
 modelDelay=2500;await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await select(restarted);await processing(restarted);await restarted.send('Page.navigate',{url:'http://127.0.0.1:8782/navigated'});await ready(restarted);await sleep(2700);
 check('navigation clears old processing/result',await restarted.eval(`${$root}.querySelector('.surface').classList.contains('collapsed')&&!document.getElementById('jdt-overlay-host')`));
 // Simulate a genuinely stopped extension service worker through CDP's lifecycle domain.
 modelDelay=2500;await islandSend(restarted,{type:'START_CAPTURE',mode:'region'});await select(restarted);await processing(restarted);
 const worker=(await httpJson('http://127.0.0.1:9432/json/list')).find(t=>t.type==='service_worker');
 const closed=await browser.send('Target.closeTarget',{targetId:worker.id});check('worker stop requested',closed.success);
 await sleep(6400);check('worker stop recovers through watchdog',await restarted.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.textContent.includes('未按时返回')`));
 const nextWorker=await waitFor(async()=> (await httpJson('http://127.0.0.1:9432/json/list')).find(t=>t.type==='service_worker'));
 sw.close();sw=await CDP.connect(nextWorker.webSocketDebuggerUrl);await sw.send('Runtime.enable');await waitFor(()=>sw.eval('!!globalThis.chrome?.storage?.local'));await closeOverlay(restarted);await sleep(1900);
 // Invalidated context removes its DOM and listeners; later reinjection starts a single instance.
 const cleanup=await open('http://localhost:8782/cleanup');await ready(cleanup);await front(cleanup);const cleanupContext=await context(cleanup);
 await cleanup.eval(`chrome.runtime.sendMessage=async()=>{throw new Error('Extension context invalidated')}`,{contextId:cleanupContext});await expand(cleanup);await click(cleanup,'[data-action="dashboard"]');await waitFor(()=>cleanup.eval(`!document.getElementById('jdt-island-host')`));check('invalidated extension cleans island host',true);
 await front(restarted);
 // Successful question still requires explicit review in knowledge library.
 modelDelay=700;await islandSend(restarted,{type:'START_CAPTURE',mode:'region',target:'technical-question'});await select(restarted);await processing(restarted);
 await waitFor(()=>restarted.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.textContent.includes('已提取')`));check('question success hands candidates to review',true);

 // Missing configuration yields an actionable error and makes no model request.
 await front(restarted);await closeOverlay(restarted);await sleep(1900);
 const savedSettings=await sw.eval(`chrome.storage.local.get('settings').then(r=>r.settings)`);await sw.eval(`chrome.storage.local.set({settings:{...${JSON.stringify(savedSettings)},apiKey:''}})`);const beforeNoKey=requests;
 await expand(restarted);await click(restarted,'[data-action="job"]');await waitFor(()=>restarted.eval(`${$root}.querySelector('.status').textContent.includes('API Key')`));check('missing key is visible and makes no request',requests===beforeNoKey);await front(restarted);await sleep(300);await shot(restarted,'missing-key');await sw.eval(`chrome.storage.local.set({settings:${JSON.stringify(savedSettings)}})`);
 // Preferences do not leak business or credentials.
 const prefsOnly=await islandSend(restarted,{type:'ISLAND_GET_STATE'});check('final page state excludes model config and records',!('settings'in prefsOnly)&&!('records'in prefsOnly)&&!JSON.stringify(prefsOnly).includes('mock-only'));
 console.log(`\n${pass}/${pass} passed; ${OUT}`);fs.writeFileSync(path.join(OUT,'result.json'),JSON.stringify({pass,formalManifest:true,mock:true},null,2));
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await stop().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
