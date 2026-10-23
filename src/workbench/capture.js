import { registerViewState } from './view-state.js';
const windowId=(await chrome.windows.getCurrent()).id;
const key=`workbenchCapture:${windowId}`;let shown='';
async function load(){
  const data=(await chrome.storage.session.get(key))[key];
  if(!data||data.requestId===shown)return;
  if(shown&&globalThis.__JDT_PANEL_REVIEW__?.dirty()&&!confirm('有未保存的识别结果，要切换到新结果吗？'))return;
  shown=data.requestId;globalThis.__JDT_PANEL_REVIEW__.show(data);
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes[key])void load();});
await load();

registerViewState(()=>globalThis.__JDT_PANEL_REVIEW__.snapshot(),saved=>globalThis.__JDT_PANEL_REVIEW__.restore(saved));
