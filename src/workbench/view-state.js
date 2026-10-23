/** Transient UI state for an explicit side-panel/full-page switch. Never saves edits. */
export function registerViewState(capture, restore, afterRestore) {
  window.__JDT_WORKBENCH_VIEW__ = { capture, restore, afterRestore };
  if (window.parent !== window) {
    window.parent.dispatchEvent(new window.parent.CustomEvent('jdt-view-ready', { detail: { source: window } }));
  }
}
export function capturePage(win) {
  const doc = win.document;
  if(!win.__JDT_WORKBENCH_VIEW__)throw new Error('页面仍在载入，请稍后切换显示模式。');
  const busy = doc.querySelector('#application-import[open], #io-status:not([hidden]), #assist-panel:not([hidden]), #restore-panel:not([hidden])');
  if (busy || doc.querySelector('button:disabled[data-act="save"]')) {
    throw new Error('请先完成或取消当前识别、导入或保存，再切换显示模式。');
  }
  if(doc.querySelector('#view-review:not([hidden]) #recall')?.value)throw new Error('复习临时回答只留在当前页面，请完成本题或清空临时回答后切换。');
  const nodes = [...doc.querySelectorAll('input:not([type=file]), textarea:not(#recall), select')];
  const controls = nodes.map(node => ({ id: node.id, value: node.value, checked: node.checked, top: node.scrollTop,
    start: node.selectionStart, end: node.selectionEnd }));
  const active = doc.activeElement;
  return { app: win.__JDT_WORKBENCH_VIEW__?.capture(), controls, active: nodes.indexOf(active),
    dirty: doc.documentElement.dataset.workbenchDirty === 'true', scroll: { x: win.scrollX, y: win.scrollY },
    panes: [...doc.querySelectorAll('.pane-body,.list,.m-body,.d-body')].map(n => ({top:n.scrollTop,left:n.scrollLeft})),
    details: [...doc.querySelectorAll('details')].map(n=>n.open) };
}
export async function restorePage(win, saved) {
  await win.__JDT_WORKBENCH_VIEW__?.restore(saved.app);
  const doc = win.document, nodes = [...doc.querySelectorAll('input:not([type=file]), textarea:not(#recall), select')];
  saved.controls?.forEach((value, i) => {
    const node = value.id ? doc.getElementById(value.id) : nodes[i];
    if (!node || !value.id || node.type === 'file') return;
    node.value=value.value; if(typeof value.checked==='boolean')node.checked=value.checked;
    if(typeof value.start==='number' && (node.tagName==='TEXTAREA' || /^(text|search|url|tel|password)$/.test(node.type || '')))node.setSelectionRange(value.start,value.end);
    node.scrollTop=value.top||0;
  });
  [...doc.querySelectorAll('details')].forEach((n,i)=>{if(saved.details?.[i]!==undefined)n.open=saved.details[i];});
  doc.documentElement.dataset.workbenchDirty=String(Boolean(saved.dirty));
  await win.__JDT_WORKBENCH_VIEW__?.afterRestore?.();
  const active=nodes[saved.active];if(active)active.focus({preventScroll:true});
  const scroll=()=>{
    saved.controls?.forEach((v,i)=>{const n=v.id?doc.getElementById(v.id):nodes[i];if(n)n.scrollTop=v.top||0;});
    [...doc.querySelectorAll('.pane-body,.list,.m-body,.d-body')].forEach((n,i)=>{if(saved.panes?.[i]){n.scrollTop=saved.panes[i].top;n.scrollLeft=saved.panes[i].left;}});
    win.scrollTo(saved.scroll?.x||0,saved.scroll?.y||0);
  };
  scroll();win.requestAnimationFrame(scroll);
}
