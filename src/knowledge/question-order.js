/** Shared pointer/keyboard ordering. Persist only on drop, never on pointercancel. */
export function installQuestionOrder({root,getRevision,move,onError}) {
  let drag=null,scrollTimer;
  const rows=scope=>[...root.querySelectorAll('[data-sort-id]')].filter(n=>n.dataset.sortScope===scope);
  function clear(){clearInterval(scrollTimer);root.querySelectorAll('.sort-before,.sort-after,.sort-dragging').forEach(n=>n.classList.remove('sort-before','sort-after','sort-dragging'));drag=null;}
  function targetAt(){
    root.querySelectorAll('.sort-before,.sort-after').forEach(n=>n.classList.remove('sort-before','sort-after'));
    const row=document.elementFromPoint(drag.x,drag.y)?.closest('[data-sort-id]');
    drag.target=null;
    if(!row||row.dataset.sortScope!==drag.scope||row.dataset.sortId===drag.id)return;
    const side=drag.y<row.getBoundingClientRect().top+row.getBoundingClientRect().height/2?'before':'after';
    row.classList.add(`sort-${side}`);drag.target={targetId:row.dataset.sortId,side};
  }
  async function commit(d,target){
    const res=await move({library:d.library,projectId:d.projectId,id:d.id,...target,baseRevision:d.revision});
    if(!res.ok)onError(res.error||'排序保存失败，请重试');
    root.querySelector(`[data-sort-id="${CSS.escape(d.id)}"] .sort-handle`)?.focus({preventScroll:true});
  }
  root.addEventListener('pointerdown',e=>{
    const handle=e.target.closest('.sort-handle');if(!handle||e.button!==0)return;
    e.preventDefault();e.stopPropagation();const row=handle.closest('[data-sort-id]');
    drag={id:row.dataset.sortId,scope:row.dataset.sortScope,library:row.dataset.sortLibrary,projectId:row.dataset.sortProject||'',revision:getRevision(),startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,moved:false,handle};
    handle.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove',e=>{
    if(!drag)return;drag.x=e.clientX;drag.y=e.clientY;
    if(!drag.moved&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<6)return;
    if(!drag.moved){drag.moved=true;drag.handle.closest('[data-sort-id]').classList.add('sort-dragging');
      scrollTimer=setInterval(()=>{
        if(!drag)return;
        let node=document.elementFromPoint(drag.x,drag.y),scroller;
        while(node&&node!==document.body){const style=getComputedStyle(node);if(/auto|scroll/.test(style.overflowY)&&node.scrollHeight>node.clientHeight){scroller=node;break;}node=node.parentElement;}
        scroller ||= document.scrollingElement;
        const r=scroller===document.scrollingElement?{top:0,bottom:innerHeight}:scroller.getBoundingClientRect();
        const dy=drag.y<r.top+45?-14:drag.y>r.bottom-45?14:0;
        if(dy){scroller.scrollTop+=dy;targetAt();}
      },20);
    }
    targetAt();
  });
  root.addEventListener('pointerup',e=>{if(!drag)return;const d=drag,t=d.target;clear();if(d.moved&&t)void commit(d,t);e.preventDefault();});
  root.addEventListener('pointercancel',clear);window.addEventListener('blur',clear);
  root.addEventListener('lostpointercapture',()=>{if(drag)clear();});
  root.addEventListener('click',e=>{if(e.target.closest('.sort-handle')){e.preventDefault();e.stopPropagation();}},true);
  root.addEventListener('keydown',e=>{
    const handle=e.target.closest('.sort-handle');if(!handle||!['ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();const row=handle.closest('[data-sort-id]'),list=rows(row.dataset.sortScope),index=list.indexOf(row),target=list[index+(e.key==='ArrowUp'?-1:1)];
    if(target)void commit({id:row.dataset.sortId,library:row.dataset.sortLibrary,projectId:row.dataset.sortProject||'',revision:getRevision()},{targetId:target.dataset.sortId,side:e.key==='ArrowUp'?'before':'after'});
  });
}
