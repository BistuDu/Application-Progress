import { capturePage } from './view-state.js';
const paths = {dashboard:'src/dashboard/dashboard.html',knowledge:'src/knowledge/knowledge.html',options:'src/options/options.html'};
export function navigate(view) {
  if (!Object.hasOwn(paths,view)) return Promise.resolve({ok:false,error:'未知入口'});
  if (window.parent !== window && window.parent.location.pathname.endsWith('/workbench/workbench.html')) {
    // Extension postMessage may expose a null source. Use the same-origin parent DOM channel.
    window.parent.dispatchEvent(new window.parent.CustomEvent('jdt-workbench-nav', {detail:{view,source:window}}));
  } else {
    location.assign(chrome.runtime.getURL(`src/workbench/workbench.html?view=${view}`));
  }
  return Promise.resolve({ok:true});
}
export function installNavigation(current) {
  if (window.parent !== window) {
    document.documentElement.classList.add('in-workbench');
    if(new URLSearchParams(location.search).get('surface')==='panel')document.documentElement.classList.add('in-sidepanel');
    return;
  }
  const link=document.createElement('link');link.rel='stylesheet';link.href=chrome.runtime.getURL('src/workbench/navigation.css');document.head.append(link);
  const nav=document.createElement('nav');nav.className='workspace-nav';nav.setAttribute('aria-label','工作台导航');
  for(const [view,label] of [['dashboard','招聘进度'],['knowledge','知识库'],['options','设置']]){
    const a=document.createElement('a');a.textContent=label;a.href=chrome.runtime.getURL(`src/workbench/workbench.html?view=${view}`);
    if(view===current)a.setAttribute('aria-current','page');nav.append(a);
  }
  const mode=document.createElement('button');mode.className='workspace-mode';mode.textContent='在侧栏打开';
  mode.addEventListener('click',async()=>{
    try{
      const res=await chrome.runtime.sendMessage({type:'SWITCH_WORKBENCH_MODE',mode:'panel',view:current,snapshot:{view:current,pages:{[current]:capturePage(window)}}});
      if(!res?.ok)throw new Error(res?.error||'切换失败');
    }catch(error){mode.textContent=error.message;}
  });
  nav.append(mode);document.body.prepend(nav);
}
