/** Window-scoped routes. Opening is only performed in a user-gesture call path. */
const views=new Set(['dashboard','knowledge','options','capture']);
export async function routeWorkbench(view,windowId,{surface='panel',workbenchTabId,transferId}={}){
  if(!views.has(view))throw new Error('未知工作台入口');
  if(!Number.isInteger(windowId))windowId=(await chrome.windows.getLastFocused()).id;
  const key=surface==='tab'?`workbenchTabRoute:${workbenchTabId}`:`workbenchRoute:${windowId}`;
  await chrome.storage.session.set({[key]:{view,transferId}});
  await chrome.runtime.sendMessage({type:'JDT_WORKBENCH_ROUTE',view,windowId,surface,workbenchTabId,transferId}).catch(()=>{});
  return {ok:true,windowId,sidePanel:true};
}
export async function openWorkbench(view,windowId){
  if(!views.has(view))throw new Error('未知工作台入口');
  if(!Number.isInteger(windowId))windowId=(await chrome.windows.getLastFocused()).id;
  // Do this before storage, messaging or any other awaited work: Chrome requires a gesture.
  await chrome.sidePanel.open({windowId});
  return routeWorkbench(view,windowId);
}

/** Explicit full-page mode; reuse one workbench tab in this browser window. */
export async function openFullWorkbench(view, windowId, transferId) {
  if (!views.has(view)) throw new Error('未知工作台入口');
  if (!Number.isInteger(windowId)) windowId=(await chrome.windows.getLastFocused()).id;
  const base=chrome.runtime.getURL('src/workbench/workbench.html');
  // Extension-page URLs may be omitted from tabs.query without the tabs permission.
  // Runtime contexts identify our own pages directly, including their tab and window.
  const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],windowIds:[windowId]});
  const context=contexts.find(c=>c.tabId>=0&&c.documentUrl?.startsWith(base));
  let tab=context?await chrome.tabs.get(context.tabId):null;
  if(tab) await chrome.tabs.update(tab.id,{active:true});
  else tab=await chrome.tabs.create({windowId,url:`${base}?view=${view}${transferId?`&transfer=${transferId}`:''}`});
  await routeWorkbench(view,windowId,{surface:'tab',workbenchTabId:tab.id,transferId});
  return {ok:true,tabId:tab.id,windowId,sidePanel:false};
}

export async function switchWorkbenchMode({mode,view,windowId,snapshot}) {
  if (!['panel','tab'].includes(mode)||!views.has(view))throw new Error('未知显示模式');
  if (!Number.isInteger(windowId))windowId=(await chrome.windows.getLastFocused()).id;
  // Preserve the user activation for sidePanel.open; no storage or tab queries before it.
  if(mode==='panel')await chrome.sidePanel.open({windowId});
  const id=crypto.randomUUID(),key=`workbenchTransfer:${id}`;
  await chrome.storage.session.set({[key]:{status:'pending',snapshot}});
  try {
    let result;
    if(mode==='tab'){
      const [source]=await chrome.tabs.query({windowId,active:true});
      if(source && /^https?:/.test(source.url||''))await chrome.storage.session.set({[`workbenchSource:${windowId}`]:source.id});
      result=await openFullWorkbench(view,windowId,id);
    }else{
      await routeWorkbench(view,windowId,{transferId:id});
      const sourceKey=`workbenchSource:${windowId}`,sourceId=(await chrome.storage.session.get(sourceKey))[sourceKey];
      if(sourceId!=null){try{const source=await chrome.tabs.get(sourceId);if(source.windowId===windowId)await chrome.tabs.update(sourceId,{active:true});}catch{/* Original webpage may have closed. */}}
      result={ok:true,windowId,sidePanel:true};
    }
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if((await chrome.storage.session.get(key))[key]?.status==='ready')return result;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('显示模式切换超时，原页面内容仍保留，请重试。');
  }finally{await chrome.storage.session.remove(key);}
}
