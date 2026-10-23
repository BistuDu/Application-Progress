/** Native side-panel integration, isolated Chromium + localhost model; no real credentials. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';
import {CDP,httpJson,waitFor} from './cdp.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'tmp/workbench-qa');fs.mkdirSync(out,{recursive:true});
const profile=path.join(os.tmpdir(),'jdt-workbench-profile'),ext=path.join(os.tmpdir(),'jdt-workbench-ext');
for(const dir of [profile,ext])fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(ext,{recursive:true});
for(const item of ['manifest.json','src','icons'])fs.cpSync(path.join(root,item),path.join(ext,item),{recursive:true});
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');const chrome=process.env.JDT_CHROME||fs.readdirSync(cache).filter(x=>x.startsWith('chromium-')).sort().reverse().map(x=>path.join(cache,x,'chrome-mac/Chromium.app/Contents/MacOS/Chromium')).find(fs.existsSync);
let delay=200;const server=http.createServer(async(req,res)=>{
 if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const text=JSON.stringify(JSON.parse(body).messages);const question=text.includes('questions')||text.includes('候选问答');const data=question?{questions:[{question:'为什么使用索引？',answerMarkdown:'减少扫描数据量',category:'数据库',tags:['索引']}]}:{is_job:true,company:'侧栏测试公司',title:'开发工程师',location:'北京',jd:'开发可靠系统',skills:['Java']};setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}));},delay);return;}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end('<html><head><title>原招聘网页</title></head><body style="font:24px sans-serif"><h1>原网页保留在左侧</h1><p>招聘开发工程师 Java SQL</p><input id="original" value="网页输入保持"><div style="height:1000px"></div></body></html>');
});await new Promise(r=>server.listen(8794,'127.0.0.1',r));
const proc=spawn(chrome,[...(process.env.JDT_HEADLESS==='1'?['--headless=new']:[]),`--user-data-dir=${profile}`,`--load-extension=${ext}`,`--disable-extensions-except=${ext}`,'--remote-debugging-port=9444','--no-first-run','--no-default-browser-check','--disable-gpu','--window-size=1450,950','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let browser,sw,web,panel,pass=0;const connections=[];
function check(name,value){if(!value)throw Error(`FAIL: ${name}`);pass++;console.log(`✓ ${name}`);}
try{
 const version=await waitFor(()=>httpJson('http://127.0.0.1:9444/json/version'));browser=await CDP.connect(version.webSocketDebuggerUrl);
 const targets=()=>httpJson('http://127.0.0.1:9444/json/list');
 const worker=await waitFor(async()=> (await targets()).find(t=>t.type==='service_worker'&&t.url.endsWith('/src/background.js')));sw=await CDP.connect(worker.webSocketDebuggerUrl);connections.push(sw);await sw.send('Runtime.enable');const id=new URL(worker.url).host;
 await waitFor(async()=>(await targets()).some(t=>t.url.includes('/workbench/workbench.html?view=options')));await sleep(250);
 await sw.eval(`chrome.storage.local.set({settings:{apiBase:'http://127.0.0.1:8794',apiKey:'mock-only',model:'mock',closePanelAfterSave:false,autoOpenDashboard:false}})`);
 const made=await browser.send('Target.createTarget',{url:'http://127.0.0.1:8794/'});const info=await waitFor(async()=>(await targets()).find(t=>t.id===made.targetId));web=await CDP.connect(info.webSocketDebuggerUrl);connections.push(web);const contexts=[];web.on(m=>{if(m.method==='Runtime.executionContextCreated')contexts.push(m.params.context)});await web.send('Runtime.enable');await web.send('Page.enable');await web.send('Page.bringToFront');
 await waitFor(()=>web.eval(`!!document.getElementById('jdt-island-host')?.shadowRoot`));
 const countBefore=(await sw.eval('chrome.tabs.query({}).then(t=>t.length)'));const widthBefore=await web.eval('innerWidth');
 const island=`document.getElementById('jdt-island-host').shadowRoot`;
 async function click(c,expr){const p=await c.eval(`(()=>{const r=(${expr}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...p});await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...p});await sleep(150);}
 await click(web,`${island}.querySelector('.toggle')`);await sleep(320);await click(web,`${island}.querySelector('[data-action="dashboard"]')`);
 const native=await waitFor(async()=> (await targets()).find(t=>t.url.includes('/workbench/workbench.html')&&!t.url.includes('?view=options')),{timeoutMs:10000});
 console.log('Native target:',native.type,native.url);panel=await CDP.connect(native.webSocketDebuggerUrl);connections.push(panel);await panel.send('Runtime.enable');await panel.send('Page.enable');
 await waitFor(()=>panel.eval(`!!document.querySelector('iframe')?.contentDocument?.querySelector('#btn-add')`));
 check('胶囊打开原生侧栏且不新开标签页',(await sw.eval('chrome.tabs.query({}).then(t=>t.length)'))===countBefore);
 check('左侧网页缩窄且输入保留',await web.eval(`innerWidth<${widthBefore}&&document.querySelector('#original').value==='网页输入保持'`));
 check('统一导航包含进度知识库设置',await panel.eval(`document.querySelectorAll('.workspace-tabs [data-view]').length===3`));
 // Keep the original settings node alive while navigating.
 await panel.eval(`document.querySelector('[data-view="options"]').click()`);await waitFor(()=>panel.eval(`!![...document.querySelectorAll('iframe')].find(f=>f.title==='设置')?.contentDocument?.querySelector('#model')`));
 await panel.eval(`(()=>{const d=[...document.querySelectorAll('iframe')].find(f=>f.title==='设置').contentDocument;d.querySelector('#model').value='未保存模型';d.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));window.settingsNode=d.querySelector('#model')})()`);
 await panel.eval(`document.querySelector('[data-view="knowledge"]').click()`);await waitFor(()=>panel.eval(`!![...document.querySelectorAll('iframe')].find(f=>f.title==='面试知识库')?.contentDocument?.querySelector('#proj-new')`));
 await panel.eval(`document.querySelector('[data-view="options"]').click()`);
 check('切换功能保留设置草稿和原节点',await panel.eval(`window.settingsNode.value==='未保存模型'&&[...document.querySelectorAll('iframe')].find(f=>f.title==='设置').contentDocument.querySelector('#model')===window.settingsNode`));
 await panel.eval(`document.querySelector('[data-view="dashboard"]').click()`);
 check('反复切换复用已加载页面',await panel.eval(`document.querySelectorAll('iframe').length===3`));
 await panel.eval(`(()=>{const d=[...document.querySelectorAll('iframe')].find(f=>f.title==='招聘进度').contentDocument;d.querySelector('#btn-add').click();d.querySelector('#m-company').value='手工侧栏公司';d.querySelector('#m-title').value='前端工程师';d.querySelector('#m-save').click()})()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('records').then(r=>r.records?.some(x=>x.company==='手工侧栏公司'))`));check('侧栏手动新增招聘记录成功',true);
 await panel.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'dashboard.png'),Buffer.from(r.data,'base64')));

 const captureDoc=`[...document.querySelectorAll('iframe')].find(f=>f.title==='识别核对').contentDocument`;
 const knowledgeDoc=`[...document.querySelectorAll('iframe')].find(f=>f.title==='面试知识库').contentDocument`;
 if(!process.argv.includes('--mode-only')){
 async function select(){
   await waitFor(()=>web.eval(`!!document.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('.shot')`));
   await web.send('Input.dispatchMouseEvent',{type:'mousePressed',x:35,y:95,button:'left',buttons:1,clickCount:1});
   await web.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:350,y:240,button:'left',buttons:1});
   await web.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:350,y:240,button:'left',buttons:0,clickCount:1});
 }
 await click(panel,`document.querySelector('[data-capture="job"]')`);await select();
 await waitFor(()=>panel.eval(`!!(${captureDoc})?.getElementById('jdt-overlay-host')?.shadowRoot.querySelector('#jdt-save')`));
 check('招聘识别结果在侧栏等待核对',await web.eval(`!document.getElementById('jdt-overlay-host')`) && (await sw.eval(`chrome.storage.local.get('records').then(r=>r.records.length)`))===1);
 await panel.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'capture.png'),Buffer.from(r.data,'base64')));
 await panel.eval(`(${captureDoc}).getElementById('jdt-overlay-host').shadowRoot.querySelector('#jdt-save').click()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('records').then(r=>r.records?.some(x=>x.company==='侧栏测试公司'))`));
 check('保存识别记录保留原网页来源',await sw.eval(`chrome.storage.local.get('records').then(r=>r.records.find(x=>x.company==='侧栏测试公司').sourceUrl==='http://127.0.0.1:8794/'&&r.records.find(x=>x.company==='侧栏测试公司').pageTitle==='原招聘网页')`));
 check('保存后清理临时截图',await sw.eval(`chrome.storage.session.get(null).then(r=>!Object.keys(r).some(k=>k.startsWith('workbenchCapture:')))`));
 await click(panel,`document.querySelector('[data-capture="technical-question"]')`);await select();
 await waitFor(()=>panel.eval(`!!(${knowledgeDoc})?.querySelector('#review-panel:not([hidden]) [data-act="save"]')`));
 check('题目识别在同一侧栏逐条核对',await panel.eval(`document.querySelector('[data-view="knowledge"]').getAttribute('aria-current')==='page'&&(${knowledgeDoc}).querySelector('#review-panel').textContent.includes('为什么使用索引')`));
 await panel.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'knowledge-review.png'),Buffer.from(r.data,'base64')));
 await panel.eval(`(${knowledgeDoc}).querySelector('#review-panel [data-act="save"]').click()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('knowledgeLibrary').then(r=>r.knowledgeLibrary?.technicalQuestions.some(q=>q.question==='为什么使用索引？'))`));
 check('侧栏核对后显式保存题目成功',true);
 check('全流程没有额外标签页且原网页仍可编辑',(await sw.eval('chrome.tabs.query({}).then(t=>t.length)'))===countBefore&&await web.eval(`document.querySelector('#original').value==='网页输入保持'`));
 await panel.eval(`document.querySelector('[data-view="knowledge"]').click()`);
 check('知识库窄屏无页面水平溢出',await panel.eval(`(${knowledgeDoc}).documentElement.scrollWidth<=(${knowledgeDoc}).documentElement.clientWidth+1`));
 await panel.eval(`document.querySelector('[data-view="options"]').click()`);
 check('设置窄屏无页面水平溢出',await panel.eval(`(()=>{const d=[...document.querySelectorAll('iframe')].find(f=>f.title==='设置').contentDocument;return d.documentElement.scrollWidth<=d.documentElement.clientWidth+1})()`));
 // Knowledge AI tasks must reach extension iframes (they have no sender.tab).
 check('侧栏知识库模型请求可收到结果',await panel.eval(`(async()=>{const f=[...document.querySelectorAll('iframe')].find(f=>f.title==='面试知识库');const api=await import('../knowledge/api.js');const task=api.startTask({task:'extract-questions',text:'为什么使用索引？\\n减少扫描'}, {watchdogMs:5000});try{const r=await task.promise;return r.ok===true;}catch(e){return false;}})()`));


 // Cancelling in the original page must not produce a late result in the sidebar.
 delay=1600;
 const recordCount=await sw.eval(`chrome.storage.local.get('records').then(r=>r.records.length)`);
 await click(panel,`document.querySelector('[data-capture="job"]')`);await select();
 await waitFor(()=>web.eval(`${island}.querySelector('.cancel')!==null`));
 await click(web,`${island}.querySelector('.cancel')`);await sleep(1900);
 check('取消识别后没有迟到核对或自动保存',await sw.eval(`chrome.storage.session.get(null).then(r=>!Object.keys(r).some(k=>k.startsWith('workbenchCapture:')))` )&&(await sw.eval(`chrome.storage.local.get('records').then(r=>r.records.length)`))===recordCount);
 await panel.eval(`document.querySelector('[data-view="dashboard"]').click()`);
 check('侧栏记录列表无需水平滚动',await panel.eval(`(()=>{const d=[...document.querySelectorAll('iframe')].find(f=>f.title==='招聘进度').contentDocument;return d.documentElement.scrollWidth<=d.documentElement.clientWidth+1 && d.querySelector('table').scrollWidth<=d.querySelector('.table-wrap').clientWidth+2})()`));
 check('侧栏工作台无横向溢出',await panel.eval(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`));
 check('侧栏工作台头部不超过两行',await panel.eval(`(()=>{const h=document.querySelector('.workspace-head');return h.offsetHeight<92})()`));
 await panel.send('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:false});
 await sleep(300);
 check('360px 工作台头部不超过两行且无横向溢出',await panel.eval(`(()=>{const h=document.querySelector('.workspace-head');return h.offsetHeight<100&&document.documentElement.scrollWidth<=document.documentElement.clientWidth+1})()`));
 await panel.send('Emulation.clearDeviceMetricsOverride');
 await sleep(200);

 // Dashboard: overview, company type, configurable columns.
 const dashDoc=`[...document.querySelectorAll('iframe')].find(f=>f.title==='招聘进度').contentDocument`;
 check('侧栏默认折叠数据概览',await panel.eval(`(()=>{const d=${dashDoc};return d.querySelector('#overview-body').hidden===true&&d.querySelector('#overview-toggle').getAttribute('aria-expanded')==='false'})()`));
 check('侧栏默认页面无纵向滚动',await panel.eval(`(()=>{const d=${dashDoc};return d.documentElement.scrollHeight<=d.documentElement.clientHeight+1})()`));
 check('概览摘要包含六项指标',await panel.eval(`(${dashDoc}).querySelectorAll('#overview-metrics .metric').length===6`));
 const dashRecords=JSON.parse(await sw.eval(`chrome.storage.local.get('records').then(r=>JSON.stringify(r.records.map(x=>({id:x.id,company:x.company}))))`));
 const manualRecord=dashRecords.find(x=>x.company==='手工侧栏公司');
 await panel.eval(`(()=>{const d=${dashDoc},id=${JSON.stringify(manualRecord.id)};d.querySelector('tr[data-id="'+id+'"] [data-act="open"]').click()})()`);
 await waitFor(()=>panel.eval(`!!(${dashDoc}).querySelector('#d-company-type')`));
 await panel.eval(`(()=>{const d=${dashDoc},s=d.querySelector('#d-company-type');s.value='私企';s.dispatchEvent(new Event('change',{bubbles:true}));d.querySelector('#d-save').click()})()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('records').then(r=>r.records.find(x=>x.id===${JSON.stringify(manualRecord.id)})?.companyType==='私企')`));
 await panel.eval(`(${dashDoc}).querySelector('#d-close').click()`);
 check('详情可修改企业性质并持久化',await panel.eval(`(${dashDoc}).querySelector('tr[data-id="${manualRecord.id}"] .type-badge')?.textContent==='私企'`));
 await panel.eval(`(()=>{const d=${dashDoc},s=d.querySelector('#f-company-type');s.value='私企';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 check('企业性质筛选只保留匹配记录',await panel.eval(`(${dashDoc}).querySelectorAll('#tbody tr[data-id]').length===1`));
 await panel.eval(`(()=>{const d=${dashDoc},s=d.querySelector('#f-company-type');s.value='__unset__';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 check('未标注筛选只保留未标注记录',await panel.eval(`(${dashDoc}).querySelectorAll('#tbody tr[data-id]').length===1`));
 await panel.eval(`(()=>{const d=${dashDoc},s=d.querySelector('#f-company-type');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 check('侧栏精简自动隐藏地点列',await panel.eval(`(()=>{const d=${dashDoc},th=d.querySelector('#thead .c-loc');return !!th&&d.defaultView.getComputedStyle(th).display==='none'})()`));
 await panel.eval(`(${dashDoc}).querySelector('#btn-columns').click()`);
 check('列设置浮层可打开',await panel.eval(`(${dashDoc}).querySelector('#column-pop').hidden===false`));
 await panel.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'dashboard-columns.png'),Buffer.from(r.data,'base64')));
 await panel.eval(`(()=>{const d=${dashDoc},cb=d.querySelector('[data-col-toggle="location"]');cb.checked=false;cb.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('settings').then(r=>r.settings?.dashboardColumns?.hidden?.includes('location'))`));
 check('隐藏列写入设置并移除表头',await panel.eval(`![...(${dashDoc}).querySelectorAll('#thead th')].some(th=>th.textContent.includes('地点'))`));
 await panel.eval(`(()=>{const d=${dashDoc},cb=d.querySelector('[data-col-toggle="location"]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('settings').then(r=>!r.settings?.dashboardColumns?.hidden?.includes('location'))`));
 check('重新显示地点列',await panel.eval(`!!(${dashDoc}).querySelector('#thead .c-loc')`));
 await panel.eval(`(${dashDoc}).querySelector('#cp-close').click()`);
 await panel.eval(`(${dashDoc}).querySelector('#overview-toggle').click()`);
 await waitFor(()=>sw.eval(`chrome.storage.local.get('settings').then(r=>r.settings?.dashboardOverviewExpanded===true)`));
 check('展开概览并写入设置',await panel.eval(`(${dashDoc}).querySelector('#overview-body').hidden===false`));
 await panel.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'dashboard-company-type.png'),Buffer.from(r.data,'base64')));


 await panel.eval(`document.querySelector('[data-view="knowledge"]').click();`);
 await panel.eval(`(()=>{const d=${knowledgeDoc};d.querySelector('#tabs [data-view="technical"]').click();d.querySelector('#bank-review').click();})()`);
 await waitFor(()=>panel.eval(`!!(${knowledgeDoc}).querySelector('#review-start')`));
 await panel.eval(`(${knowledgeDoc}).querySelector('#review-start').click()`);
 await waitFor(()=>panel.eval(`!!(${knowledgeDoc}).querySelector('#recall')`));
 await panel.eval(`(()=>{const a=(${knowledgeDoc}).querySelector('#recall');a.value='仅在内存的临时回想验收';a.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await click(panel,`document.querySelector('#display-mode')`);
 check('复习临时回答不进入交接快照且切换前提示',await panel.eval(`document.querySelector('#feedback').textContent.includes('临时回答')`)&&await sw.eval(`chrome.storage.session.get(null).then(r=>!JSON.stringify(r).includes('仅在内存的临时回想验收'))`));
 await panel.eval(`(()=>{const d=${knowledgeDoc},a=d.querySelector('#recall');a.value='';a.dispatchEvent(new Event('input',{bubbles:true}));d.querySelector('#bank-browse').click();})()`);
 }
 // Actual child-page navigation and reversible display modes, including an unsaved answer.
 async function frameClick(c,title,selector){
   const point=await c.eval(`(()=>{const f=[...document.querySelectorAll('iframe')].find(f=>f.title===${JSON.stringify(title)});const n=f.contentDocument.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),p=f.getBoundingClientRect();return{x:p.x+r.x+r.width/2,y:p.y+r.y+r.height/2}})()`);
   await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
   await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});await sleep(100);
 }
 const project=await panel.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_APPLY',op:'project.create',payload:{name:'全屏切换验收项目'}})`);
 const projectId=project.result.project.id;
 await panel.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_APPLY',op:'projectQuestion.create',payload:{projectId:${JSON.stringify(projectId)},question:'为什么选这个方案？',answerMarkdown:'原有答案'}})`);
 await panel.eval(`document.querySelector('[data-view="knowledge"]').click()`);await sleep(250);
 await panel.eval(`(()=>{const d=${knowledgeDoc};d.querySelector('#tabs [data-view="projects"]').click();d.querySelector('[data-pid="${projectId}"]').click();d.querySelector('#proj-detail [data-act="edit"]').click();})()`);
 const draft='未保存的跨模式答案\n'+('讨论取舍、验证效果与风险。\n'.repeat(100));
 await panel.eval(`(()=>{const a=(${knowledgeDoc}).querySelector('#ed-answer');a.value=${JSON.stringify(draft)};a.dispatchEvent(new Event('input',{bubbles:true}));a.focus();a.setSelectionRange(20,30);a.scrollTop=300;})()`);
 const initialNativeId=native.id;
 await click(panel,`document.querySelector('#display-mode')`);
 const fullInfo=await waitFor(async()=>(await targets()).find(t=>t.url.includes('/workbench/workbench.html?view=knowledge')));
 const fullTab=(await sw.eval('chrome.tabs.query({active:true,currentWindow:true})'))[0];
 const full=await CDP.connect(fullInfo.webSocketDebuggerUrl);connections.push(full);await full.send('Runtime.enable');await full.send('Page.enable');
 await waitFor(()=>full.eval(`document.documentElement.dataset.surface==='tab'&&!!(${knowledgeDoc})?.querySelector('#ed-answer')`));
 await waitFor(async()=>!(await targets()).some(t=>t.id===initialNativeId));
 check('侧栏可展开到完整标签页且关闭窄侧栏',await full.eval(`innerWidth>1000&&document.querySelector('#display-mode').textContent==='切回侧栏'`));
 check('全屏保留题目与未保存答案和光标',await full.eval(`(()=>{const a=(${knowledgeDoc}).querySelector('#ed-answer');return a.value===${JSON.stringify(draft)}&&a.selectionStart===20&&a.selectionEnd===30})()`));
 await full.send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(path.join(out,'full-workbench.png'),Buffer.from(r.data,'base64')));
 await frameClick(full,'面试知识库','#btn-dashboard');
 await waitFor(()=>full.eval(`document.querySelector('[data-view="dashboard"]').getAttribute('aria-current')==='page'`));
 check('知识库内进度表按钮实际点击可跳转',true);
 const fullDash=`[...document.querySelectorAll('iframe')].find(f=>f.title==='招聘进度').contentDocument`;
 check('全屏工作台头部保持单行',await full.eval(`(()=>{const h=document.querySelector('.workspace-head'),b=h.querySelector('.workspace-brand').getBoundingClientRect(),t=h.querySelector('.workspace-tabs').getBoundingClientRect();return h.offsetHeight<70&&Math.abs((b.top+b.height/2)-(t.top+t.height/2))<4})()`));
 check('全屏恢复地点列',await full.eval(`(()=>{const d=${fullDash},th=d.querySelector('#thead .c-loc');return !!th&&d.defaultView.getComputedStyle(th).display!=='none'})()`));
 check('全屏保留概览展开状态',await full.eval(`(${fullDash}).querySelector('#overview-body').hidden===false`));
 await frameClick(full,'招聘进度','#btn-knowledge');
 await waitFor(()=>full.eval(`document.querySelector('[data-view="knowledge"]').getAttribute('aria-current')==='page'`));
 check('进度表内知识库按钮实际点击可跳转且不丢编辑',await full.eval(`(${knowledgeDoc}).querySelector('#ed-answer').value===${JSON.stringify(draft)}`));
 await click(full,`document.querySelector('#display-mode')`);
 let returned=await waitFor(async()=>(await targets()).find(t=>t.url.endsWith('/workbench/workbench.html')));
 panel=await CDP.connect(returned.webSocketDebuggerUrl);connections.push(panel);await panel.send('Runtime.enable');await panel.send('Page.enable');
 await waitFor(()=>panel.eval(`document.documentElement.dataset.surface==='panel'&&(${knowledgeDoc})?.querySelector('#ed-answer')?.value===${JSON.stringify(draft)}`));
 check('全屏可切回侧栏并恢复未保存答案',true);
 check('切回侧栏回到原网页共存',await sw.eval(`chrome.tabs.query({active:true,currentWindow:true}).then(t=>t[0]?.url==='http://127.0.0.1:8794/')`));
 await panel.eval(`document.querySelector('[data-view="dashboard"]').click()`);await sleep(150);
 check('侧栏导航不会改变后台全屏页',await full.eval(`document.querySelector('[data-view="knowledge"]').getAttribute('aria-current')==='page'`));
 await panel.eval(`document.querySelector('[data-view="knowledge"]').click()`);
 await click(panel,`document.querySelector('#display-mode')`);
 await waitFor(async()=>!(await targets()).some(t=>t.id===returned.id));
 check('重复展开复用同一完整工作台标签',(await targets()).filter(t=>t.url.includes('/workbench/workbench.html?view=')).length===1);
 await frameClick(full,'面试知识库','#proj-detail [data-act="save"]');
 await waitFor(()=>sw.eval(`chrome.storage.local.get('knowledgeLibrary').then(r=>r.knowledgeLibrary.projectQuestions.some(q=>q.projectId===${JSON.stringify(projectId)}&&q.answerMarkdown===${JSON.stringify(draft)}))`));
 check('跨模式恢复的答案仍可正常保存',true);
 await click(full,`document.querySelector('#display-mode')`);
 returned=await waitFor(async()=>(await targets()).find(t=>t.url.endsWith('/workbench/workbench.html')));
 panel=await CDP.connect(returned.webSocketDebuggerUrl);connections.push(panel);await panel.send('Runtime.enable');await panel.send('Page.enable');
 await waitFor(()=>panel.eval(`!!(${knowledgeDoc})?.querySelector('#proj-detail')&&!(${knowledgeDoc}).querySelector('#ed-answer')`));
 await waitFor(()=>sw.eval(`chrome.storage.session.get(null).then(r=>!Object.keys(r).some(k=>k.startsWith('workbenchTransfer:')))`));
 check('模式交接结束清理临时草稿快照',true);
 // Legacy standalone pages have real links; they must keep full-page navigation working.
 const legacyMade=await browser.send('Target.createTarget',{url:`chrome-extension://${id}/src/knowledge/knowledge.html`});
 const legacyInfo=await waitFor(async()=>(await targets()).find(t=>t.id===legacyMade.targetId));const legacy=await CDP.connect(legacyInfo.webSocketDebuggerUrl);connections.push(legacy);await legacy.send('Runtime.enable');await legacy.send('Page.enable');await legacy.send('Page.bringToFront');
 await waitFor(()=>legacy.eval(`!!document.querySelector('.workspace-nav a')`));
 await click(legacy,`document.querySelector('.workspace-nav a[href*="view=dashboard"]')`);
 await waitFor(()=>legacy.eval(`location.pathname.endsWith('/workbench/workbench.html')&&document.documentElement.dataset.surface==='tab'&&document.querySelector('[data-view="dashboard"]').getAttribute('aria-current')==='page'`));
 check('独立页面知识库进度表导航是可点击的全屏链接',true);
 await browser.send('Target.closeTarget',{targetId:legacyMade.targetId});await web.send('Page.bringToFront');
 await panel.eval(`document.querySelector('[data-view="options"]').click();[...document.querySelectorAll('iframe')].find(f=>f.title==='设置').contentDocument.querySelector('#save').click()`);await sleep(300);
 await click(panel,`document.querySelector('#close')`);
 await waitFor(async()=>!(await targets()).some(t=>t.id===returned.id),{timeoutMs:5000});
 check('关闭按钮真正关闭原生侧栏且左侧页面保留',await web.eval(`!!document.querySelector('#original')`));
 console.log(`${pass}/${pass} passed`);
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await Promise.race([browser?.send('Browser.close').catch(()=>{}),sleep(1000)]);for(const c of connections)c.close();browser?.close();if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGTERM');await Promise.race([new Promise(r=>proc.once('exit',r)),sleep(1500)]);if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL');}server.closeAllConnections();server.close();}
