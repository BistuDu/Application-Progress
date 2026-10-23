import { capturePage, restorePage } from './view-state.js';
import { paintIcons } from '../lib/icons.js';
paintIcons();
const paths={dashboard:'../dashboard/dashboard.html',knowledge:'../knowledge/knowledge.html',options:'../options/options.html',capture:'capture.html'};
const frames=new Map(), pendingSnapshots=new Map(), restoring=new Map();
const requested=new URLSearchParams(location.search).get('view');
const transferFromUrl=new URLSearchParams(location.search).get('transfer');
let windowId, tabId, current=Object.hasOwn(paths,requested)?requested:'dashboard', nativePanel=false, revision=0, transferId='';
let resolveReady;
const ready=new Promise(resolve=>{resolveReady=resolve;});
function feedback(message){const box=document.getElementById('feedback');box.textContent=message;box.hidden=!message;}
function show(view){
  if(!Object.hasOwn(paths,view))return;
  current=view;
  if(!nativePanel&&tabId!=null){const url=new URL(location.href);url.searchParams.set('view',view);url.searchParams.delete('transfer');history.replaceState(null,'',url);}
  if(!frames.has(view)){
    const frame=document.createElement('iframe');frame.src=paths[view]+(nativePanel?'?surface=panel':'');
    frame.title={dashboard:'招聘进度',knowledge:'面试知识库',options:'设置',capture:'识别核对'}[view];
    frames.set(view,frame);document.getElementById('pages').append(frame);
    frame.addEventListener('load',()=>void restoreView(view));
  }
  for(const [name,frame] of frames)frame.hidden=name!==view;
  document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
}
async function restoreView(view){
  if(restoring.has(view))return restoring.get(view);
  const saved=pendingSnapshots.get(view), win=frames.get(view)?.contentWindow;
  if(!saved || !win?.__JDT_WORKBENCH_VIEW__)return;
  const task=restorePage(win,saved).then(()=>pendingSnapshots.delete(view)).finally(()=>restoring.delete(view));
  restoring.set(view,task);return task;
}
async function receiveTransfer(id){
  if(!id || transferId===id)return;
  const key=`workbenchTransfer:${id}`,data=(await chrome.storage.session.get(key))[key];
  if(!data || data.status!=='pending')return;
  transferId=id;
  try{
    for(const [view,saved] of Object.entries(data.snapshot.pages||{})){
      if(!Object.hasOwn(paths,view))continue;
      pendingSnapshots.set(view,saved);show(view);await restoreView(view);
    }
    show(data.snapshot.view||current);
    const deadline=Date.now()+10000;
    while(pendingSnapshots.size && Date.now()<deadline){
      await Promise.all([...pendingSnapshots.keys()].map(restoreView));
      if(pendingSnapshots.size)await new Promise(r=>setTimeout(r,30));
    }
    if(pendingSnapshots.size)throw new Error('页面恢复超时，原窗口中的内容仍保留，可以重试。');
    await chrome.runtime.sendMessage({type:'WORKBENCH_TRANSFER_READY',id});
  }catch(error){transferId='';feedback(error.message);}
}
async function choose(view){
  await ready;if(!Object.hasOwn(paths,view))return;
  show(view);feedback('');
  const res=await chrome.runtime.sendMessage({type:'WORKBENCH_ROUTE',view,windowId,surface:nativePanel?'panel':'tab',workbenchTabId:tabId});
  if(!res?.ok)feedback(res?.error||'导航失败，请刷新后重试。');
}
chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
  if(msg?.type==='JDT_WORKBENCH_PING'){respond({workbench:true});return false;}
  if(msg?.type!=='JDT_WORKBENCH_ROUTE')return;
  void ready.then(()=>{
    if(msg.windowId!==windowId || (msg.surface||'panel')!==(nativePanel?'panel':'tab') || !nativePanel&&msg.workbenchTabId!==tabId)return;
    revision++;show(msg.view);if(msg.transferId)void receiveTransfer(msg.transferId);
  });
});
window.addEventListener('jdt-workbench-nav',event=>{
  if([...frames.values()].some(f=>f.contentWindow===event.detail?.source))void choose(event.detail.view);
});
window.addEventListener('jdt-view-ready',event=>{
  for(const [view,frame] of frames)if(frame.contentWindow===event.detail?.source)void restoreView(view);
});
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>void choose(b.dataset.view)));
document.querySelectorAll('[data-capture]').forEach(b=>b.addEventListener('click',async()=>{
  const res=await chrome.runtime.sendMessage({type:'START_CAPTURE',mode:'region',target:b.dataset.capture,windowId});
  feedback(res?.ok?'':res?.error||'无法开始截图，请回到普通网页重试。');
}));
async function closePanel(){if(chrome.sidePanel.close)await chrome.sidePanel.close({windowId});else window.close();}
document.getElementById('display-mode').addEventListener('click',async()=>{
  const button=document.getElementById('display-mode');button.disabled=true;feedback('');
  try{
    const pages={};for(const [view,frame] of frames)pages[view]=capturePage(frame.contentWindow);
    const res=await chrome.runtime.sendMessage({type:'SWITCH_WORKBENCH_MODE',mode:nativePanel?'tab':'panel',view:current,windowId,snapshot:{view:current,pages}});
    if(!res?.ok)throw new Error(res?.error||'切换失败，当前内容仍保留。');
    if(nativePanel){window.__JDT_MODE_TRANSFERRING__=true;await closePanel();}
  }catch(error){feedback(error.message);}finally{button.disabled=false;}
});
document.getElementById('close').addEventListener('click',async()=>{
  const dirty=[...frames.values()].some(f=>f.contentDocument?.querySelector('[data-workbench-dirty="true"]'));
  if(dirty&&!confirm('有未保存的修改，关闭可能丢失这些内容。仍要关闭吗？'))return;
  if(nativePanel)await closePanel();else await chrome.tabs.remove(tabId);
});
windowId=(await chrome.windows.getCurrent()).id;
const ownTab=await chrome.tabs.getCurrent();tabId=ownTab?.id;nativePanel=!ownTab;
document.documentElement.dataset.surface=nativePanel?'panel':'tab';
document.getElementById('display-mode').textContent=nativePanel?'全屏展开':'切回侧栏';
document.getElementById('mode-label').textContent=nativePanel?'侧栏模式':'全屏模式';
document.getElementById('close').title=nativePanel?'关闭侧栏':'关闭工作台';
document.getElementById('close').setAttribute('aria-label',nativePanel?'关闭侧栏':'关闭工作台');
const routeKey=nativePanel?`workbenchRoute:${windowId}`:`workbenchTabRoute:${tabId}`;
const before=revision, stored=(await chrome.storage.session.get(routeKey))[routeKey];
resolveReady();
if(before===revision)show(Object.hasOwn(paths,requested)?requested:stored?.view||current);
const initialTransfer=transferFromUrl||stored?.transferId;
if(initialTransfer)await receiveTransfer(initialTransfer);
