/** Isolated Chromium import acceptance; no personal browser profile or API keys. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
import {CDP,httpJson,waitFor} from './cdp.mjs';
const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'jdt-csv-')),ext=path.join(temp,'extension'),profile=path.join(temp,'profile');
fs.mkdirSync(ext);for(const item of ['manifest.json','src','icons'])fs.cpSync(path.join(root,item),path.join(ext,item),{recursive:true});
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');const chrome=process.env.JDT_CHROME||fs.readdirSync(cache).filter(x=>x.startsWith('chromium-')).sort().reverse().flatMap(x=>['chrome-mac/Chromium.app/Contents/MacOS/Chromium','chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'].map(p=>path.join(cache,x,p))).find(fs.existsSync);
if(!chrome)throw Error('Chromium not found');
const proc=spawn(chrome,['--headless=new',`--user-data-dir=${profile}`,`--load-extension=${ext}`,`--disable-extensions-except=${ext}`,'--remote-debugging-port=9457','--no-first-run','--no-default-browser-check','--disable-gpu','--window-size=1450,950','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let browser,sw,page,pass=0;const conns=[];
const check=(name,v)=>{if(!v)throw Error('FAIL '+name);pass++;console.log('✓ '+name);};
try{
 browser=await CDP.connect((await waitFor(()=>httpJson('http://127.0.0.1:9457/json/version'))).webSocketDebuggerUrl);
 const targets=()=>httpJson('http://127.0.0.1:9457/json/list');
 const worker=await waitFor(async()=>(await targets()).find(t=>t.type==='service_worker'&&t.url.endsWith('/src/background.js')));sw=await CDP.connect(worker.webSocketDebuggerUrl);conns.push(sw);const id=new URL(worker.url).host;console.log('测试扩展已加载');
 const made=await browser.send('Target.createTarget',{url:`chrome-extension://${id}/src/dashboard/dashboard.html`});
 const target=await waitFor(async()=>(await targets()).find(t=>t.id===made.targetId));page=await CDP.connect(target.webSocketDebuggerUrl);conns.push(page);page.on(m=>{if(m.method==='Runtime.exceptionThrown')console.error('PAGE ERROR',m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});await page.send('Runtime.enable');await page.send('Page.enable');
 try{await waitFor(()=>page.eval(`!!document.querySelector('#btn-import')&&!!window.__JDT_WORKBENCH_VIEW__`));}catch(e){console.error(await page.eval(`({url:location.href,body:document.body.innerText.slice(-1800)})`));throw e;}
 await sw.eval(`chrome.storage.local.set({records:[]})`);
 const records=()=>sw.eval(`chrome.storage.local.get('records').then(r=>r.records||[])`);
 const open=async(button='#btn-import')=>{await page.eval(`document.querySelector(${JSON.stringify(button)}).click()`);await waitFor(()=>page.eval(`!!document.querySelector('#application-import[open]')`));};
 const q=s=>`document.querySelector('#application-import ${s}')`;
 const click=async s=>page.eval(`${q(s)}.click()`);
 const fill=async(text,name='test.csv')=>{
  await page.eval(`(()=>{const f=new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'text/plain'}),d=new DataTransfer();d.items.add(f);const n=${q('[data-file]')};n.files=d.files;n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(()=>page.eval(`${q('[data-file]')}.disabled===false`));
 };
 const ready=()=>waitFor(()=>page.eval(`!!${q('[data-summary]')}?.textContent`));
 const setFormat=async format=>page.eval(`(()=>{const n=${q('[data-format]')};n.value=${JSON.stringify(format)};n.dispatchEvent(new Event('change'));})()`);
 await open();check('招聘进度提供CSV与JSON选择',await page.eval(`${q('[data-format]')}.options.length===2&&${q('[data-file]')}.accept.includes('.csv')`));
 await fill('公司,企业性质,状态,备注,投递时间\n集团,央企,未投递,访问报错,');await ready();
 check('预览前没有落库',(await records()).length===0);
 check('映射中文表头并展示预览',await page.eval(`${q('[data-summary]')}.textContent.includes('新增 1')&&${q('[data-column="0"]')}.value==='company'`));
 await click('[data-cancel]');check('取消导入没有写入',(await records()).length===0);
 await open();await fill('公司,企业性质,状态,备注,投递时间\n集团,央企,未投递,访问报错,');await ready();await click('[data-commit]');await waitFor(async()=>(await records()).length===1);
 check('未投递企业/空岗位/空日期正确保存',(await records())[0].appliedAt===null&&(await records())[0].title===''&&(await records())[0].notes==='访问报错'&&(await records())[0].companyType==='央企');
 check('列表可筛选自定义未投递状态',await waitFor(()=>page.eval(`!!document.querySelector('[data-status="未投递"]')`)));
 await click('[data-cancel]');await open();await fill('公司,状态\n集团,已投递');await ready();
 check('库内重复默认跳过',await page.eval(`${q('[data-summary]')}.textContent.includes('重复跳过 1')`));
 await page.eval(`(()=>{const n=${q('[data-row="0"]')};n.value='add';n.dispatchEvent(new Event('change'));})()`);await waitFor(()=>page.eval(`${q('[data-summary]')}.textContent.includes('新增 1')&&!${q('[data-commit]')}.disabled`));await click('[data-commit]');await waitFor(async()=>(await records()).length===2);check('重复可另存且旧记录不覆盖',(await records())[0].status==='未投递');await click('[data-cancel]');
 await open();await fill('公司,岗位,备注\n,开发,缺公司\n新企业,,"<img src=x onerror=window.csvXss=true>"');await ready();
 check('无效行阻止提交且内容安全',await page.eval(`${q('[data-commit]')}.disabled&&!window.csvXss&&!document.querySelector('#application-import img')`));
 await click('[data-invalid]');await click('[data-commit]');await waitFor(async()=>(await records()).length===3);check('确认排除无效行后仅写有效行',(await records()).some(r=>r.company==='新企业'));await click('[data-cancel]');
 await open();await fill('公司,岗位\n并发企业,开发');await ready();
 await page.eval(`chrome.runtime.sendMessage({type:'SAVE_RECORD',input:{company:'并发企业',title:'开发'}})`);
 await click('[data-commit]');await waitFor(()=>page.eval(`${q('[data-error]')}.textContent.includes('重新核对')`));
 check('并发新记录触发重新核对',(await records()).filter(r=>r.company==='并发企业').length===1);await click('[data-cancel]');
 await open();await fill('公司,岗位\n重试企业,开发');await ready();
 await page.eval(`window.originalImportSend=chrome.runtime.sendMessage;chrome.runtime.sendMessage=async function(m){if(m.type==='APPLICATION_IMPORT'&&m.commit&&!window.importFailOnce){window.importFailOnce=true;return {ok:false,error:'模拟提交失败'};}return window.originalImportSend.call(this,m);}`);
 await click('[data-commit]');await waitFor(()=>page.eval(`${q('[data-error]')}.textContent.includes('模拟提交失败')`));
 check('失败保留核对内容不假报成功',await page.eval(`!!${q('[data-row="0"]')}&&!${q('[data-summary]')}.textContent.includes('导入完成')`));
 await click('[data-commit]');await waitFor(async()=>(await records()).some(r=>r.company==='重试企业'));check('失败后可直接重试',true);await page.eval(`chrome.runtime.sendMessage=window.originalImportSend`);await click('[data-cancel]');
 await open();await fill('公司\n只有一列\n多余,列');check('结构错误可恢复',await page.eval(`${q('[data-error]')}.textContent.includes('列数')`));
 await fill('公司\n恢复企业');await ready();check('文件错误后重选正常',await page.eval(`${q('[data-summary]')}.textContent.includes('新增 1')`));
 await page.send('Emulation.setDeviceMetricsOverride',{width:380,height:720,deviceScaleFactor:1,mobile:false});
 check('窄屏核对无水平溢出',await page.eval(`document.querySelector('#application-import').getBoundingClientRect().width<=innerWidth&&${q('.import-scroll')}.scrollWidth<=${q('.import-scroll')}.clientWidth`));
 check('核对期间模式切换受保护',await page.eval(`import(chrome.runtime.getURL('src/workbench/view-state.js')).then(m=>{try{m.capturePage(window);return false;}catch(e){return e.message.includes('导入');}})`));await click('[data-cancel]');
 await page.send('Emulation.clearDeviceMetricsOverride');
 await open();await fill('企业,职位名\n映射企业,开发');
 check('缺少公司映射会阻止导入',await page.eval(`${q('[data-error]')}.textContent.includes('公司')&&${q('[data-commit]')}.disabled`));
 await page.eval(`(()=>{for(const [i,key] of [[0,'company'],[1,'title']]){const n=document.querySelector('#application-import [data-column="'+i+'"]');n.value=key;n.dispatchEvent(new Event('change'));}})()`);
 await click('[data-preview]');await ready();check('用户可手动修正字段映射',await page.eval(`${q('[data-review]')}.textContent.includes('映射企业')&&${q('[data-review]')}.textContent.includes('开发')`));await click('[data-cancel]');
 // Both original and supplemented CSV are read-only acceptance inputs, never copied into source fixtures.
 const personal=path.join(root,'1022/求职进度_20261022_补充央企.csv');
 if(fs.existsSync(personal)){
  const before=fs.readFileSync(personal);await sw.eval(`chrome.storage.local.set({records:[]})`);await open();await fill(before.toString('utf8'),'求职进度_20261022_补充央企.csv');await ready();
  check('用户117行CSV预览完整',await page.eval(`${q('[data-summary]')}.textContent.includes('共 117 条')`));
  check('用户原表重复项默认跳过',await page.eval(`${q('[data-summary]')}.textContent.includes('重复跳过 1')`));
  await page.eval(`(()=>{const n=${q('[data-row="17"]')};n.value='add';n.dispatchEvent(new Event('change'));})()`);await waitFor(()=>page.eval(`${q('[data-summary]')}.textContent.includes('新增 117')&&!${q('[data-commit]')}.disabled`));
  await click('[data-commit]');await waitFor(async()=>(await records()).length===117);
  const all=await records(),groups=all.filter(r=>!r.title);check('99条央企中45已投递54未投递，空日期备注保留',groups.length===99&&groups.filter(r=>r.status==='已投递').length===45&&groups.filter(r=>r.status==='未投递'&&r.appliedAt===null&&r.notes).length===54);
  check('用户原CSV未改变',fs.readFileSync(personal).equals(before));await click('[data-cancel]');
 }
 // Settings entry and legacy JSON restore.
 await page.send('Page.navigate',{url:`chrome-extension://${id}/src/options/options.html`});await waitFor(()=>page.eval(`!!window.__JDT_WORKBENCH_VIEW__&&!!document.querySelector('#import')`));
 await open('#import');await setFormat('json');check('设置页可选择JSON',await page.eval(`${q('[data-file]')}.accept.includes('.json')`));
 const old=(await records())[0];const backup={...old,notes:'JSON恢复验证',screenshot:'data:image/png;base64,YQ==',statusHistory:[{status:'已投递',at:123,note:'旧历史'}]};
 await fill(JSON.stringify({records:[backup]}),'backup.json');await ready();check('JSON预览明确同ID更新',await page.eval(`${q('[data-summary]')}.textContent.includes('更新 1')&&${q('[data-warning]')}.textContent.includes('相同 ID')`));
 await click('[data-commit]');await waitFor(async()=>(await records()).find(r=>r.id===old.id)?.notes==='JSON恢复验证');
 check('JSON恢复截图和历史兼容',(await records()).find(r=>r.id===old.id).screenshot===backup.screenshot);await click('[data-cancel]');
 await open('#import');await fill('公司,备注\n设置新增,通过设置CSV');await ready();await click('[data-commit]');await waitFor(async()=>(await records()).some(r=>r.company==='设置新增'));check('设置入口CSV可导入',true);await click('[data-cancel]');
 // Open real native panel from a user gesture, then exercise its iframe.
 await page.eval(`(async()=>chrome.sidePanel.open({windowId:(await chrome.windows.getCurrent()).id}))()`,{userGesture:true});
 const native=await waitFor(async()=>(await targets()).find(t=>t.url.endsWith('/src/workbench/workbench.html')));
 const panel=await CDP.connect(native.webSocketDebuggerUrl);conns.push(panel);await panel.send('Runtime.enable');
 await waitFor(()=>panel.eval(`!!document.querySelector('iframe')?.contentDocument?.querySelector('#btn-import')`));
 await panel.eval(`document.querySelector('iframe').contentDocument.querySelector('#btn-import').click()`);
 check('原生侧栏可打开共享导入面板',await panel.eval(`!!document.querySelector('iframe').contentDocument.querySelector('#application-import[open]')`));
 await panel.eval(`(()=>{const d=document.querySelector('iframe').contentDocument,n=d.querySelector('[data-file]'),t=new DataTransfer();t.items.add(new File(['公司,状态,投递时间,备注\\n原生侧栏导入,未投递,,稍后再试'],'panel.csv'));n.files=t.files;n.dispatchEvent(new Event('change'));})()`);
 await waitFor(()=>panel.eval(`document.querySelector('iframe').contentDocument.querySelector('[data-summary]').textContent.includes('新增 1')`));
 check('原生侧栏核对按钮在可视区域',await panel.eval(`(()=>{const d=document.querySelector('iframe').contentDocument,r=d.querySelector('[data-commit]').getBoundingClientRect();return r.bottom<=d.documentElement.clientHeight&&r.right<=d.documentElement.clientWidth;})()`));
 await panel.eval(`document.querySelector('iframe').contentDocument.querySelector('[data-commit]').click()`);
 await waitFor(async()=>(await records()).some(r=>r.company==='原生侧栏导入'&&r.appliedAt===null));check('原生侧栏完成CSV保存',true);

 const out=path.join(root,'tmp/csv-import-qa');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'sidepanel.png'),Buffer.from((await panel.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log(`${pass}/${pass} passed`);
}catch(e){console.error(e.stack);process.exitCode=1;}finally{
 await Promise.race([browser?.send('Browser.close').catch(()=>{}),sleep(1000)]);for(const c of conns)c.close();browser?.close();proc.kill('SIGTERM');await sleep(300);if(proc.exitCode===null){proc.kill('SIGKILL');await sleep(200);}fs.rmSync(temp,{recursive:true,force:true});
}
