/** Selection-preserving Markdown edits. No parsing or storage of user content. */
export function markdownEdit(value, start, end, command) {
  const selected=value.slice(start,end);
  const wrap=(left,right=left,placeholder='文字')=>{
    if(value.slice(Math.max(0,start-left.length),start)===left && value.slice(end,end+right.length)===right){return {text:value.slice(0,start-left.length)+selected+value.slice(end+right.length),start:start-left.length,end:end-left.length};}
    const content=selected||placeholder;
    return {text:value.slice(0,start)+left+content+right+value.slice(end),start:start+left.length,end:start+left.length+content.length};
  };
  if(command.startsWith('accent-') && ['blue','red','green'].includes(command.slice(7))) {
    const open=`<strong class="md-accent-${command.slice(7)}">`,close='</strong>';
    for(const color of ['blue','red','green']) {
      const previous=`<strong class="md-accent-${color}">`;
      if(value.slice(Math.max(0,start-previous.length),start)===previous && value.slice(end,end+close.length)===close) {
        const same=previous===open,left=same?'':open,right=same?'':close;
        return {text:value.slice(0,start-previous.length)+left+selected+right+value.slice(end+close.length),start:start-previous.length+left.length,end:start-previous.length+left.length+selected.length};
      }
    }
    if(value.slice(Math.max(0,start-2),start)==='**'&&value.slice(end,end+2)==='**')return {text:value.slice(0,start-2)+open+selected+close+value.slice(end+2),start:start-2+open.length,end:start-2+open.length+selected.length};
    return wrap(open,close);
  }
  if(command==='bold')return wrap('**');
  if(command==='italic')return wrap('*');
  if(command==='inline')return wrap('`','`','代码');
  if(command==='link') {
    const label=selected||'链接文字',insert=`[${label}](https://)`;
    return {text:value.slice(0,start)+insert+value.slice(end),start:start+label.length+3,end:start+insert.length-1};
  }
  if(command==='code')return wrap(`${start&&value[start-1]!=='\n'?'\n':''}\`\`\`\n`,'\n```\n','在这里写代码');
  if(command==='indent' && start===end)return {text:value.slice(0,start)+'  '+value.slice(end),start:start+2,end:start+2};
  const from=start===0?0:value.lastIndexOf('\n',start-1)+1;
  const last=end>start && value[end-1]==='\n'?end-1:end;
  const at=value.indexOf('\n',last),to=at===-1?value.length:at;
  const lines=value.slice(from,to).split('\n');
  let result;
  if(command==='outdent')result=lines.map(l=>l.replace(/^( {1,2}|\t)/,'')).join('\n');
  else if(command==='indent')result=lines.map(l=>'  '+l).join('\n');
  else {
    const prefix=command==='bullet'?'- ':command==='ordered'?null:command==='quote'?'> ':command.startsWith('heading')?'#'.repeat(Number(command.slice(-1)))+' ':null;
    if(prefix===null && command!=='ordered')return {text:value,start,end};
    result=lines.map((l,i)=>`${command==='ordered'?`${i+1}. `:prefix}${l.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/,'')}`).join('\n');
  }
  return {text:value.slice(0,from)+result+value.slice(to),start:from,end:from+result.length};
}

/** Smallest contiguous replacement, so native editing never selects the whole document. */
export function markdownPatch(before,after) {
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let end=before.length,tail=after.length;
  while(end>start&&tail>start&&before[end-1]===after[tail-1]){end--;tail--;}
  return {start,end,text:after.slice(start,tail)};
}

export function bindEditorTools(box,area,{switchMode}) {
  let tabOut=false;
  function edit(command) {
    const result=markdownEdit(area.value,area.selectionStart,area.selectionEnd,command);
    if(result.text===area.value)return;
    const scroll=[];
    for(let node=area;node;node=node.parentElement)scroll.push({node,top:node.scrollTop,left:node.scrollLeft});
    const restore=()=>scroll.forEach(({node,top,left})=>{node.scrollTop=top;node.scrollLeft=left;});
    const patch=markdownPatch(area.value,result.text);
    area.focus({preventScroll:true});
    area.setSelectionRange(patch.start,patch.end);
    // Keep native undo history, but replace only the changed region near the selection.
    if(!document.execCommand('insertText',false,patch.text))area.setRangeText(patch.text,patch.start,patch.end,'end');
    area.setSelectionRange(result.start,result.end);
    area.dispatchEvent(new Event('input',{bubbles:true}));
    restore();
    requestAnimationFrame(()=>{if(area.isConnected&&document.activeElement===area&&area.selectionStart===result.start&&area.selectionEnd===result.end)restore();});
  }
  const expandButton=box.querySelector('[data-md-expand]');
  function expand(on) {
    box.classList.toggle('md-expanded',on);expandButton.textContent=on?'退出宽屏':'宽屏编辑';expandButton.setAttribute('aria-pressed',String(on));
    if(on)area.hidden?box.querySelector('[data-mode="edit"]').focus():area.focus();else expandButton.focus();
  }
  box.querySelectorAll('[data-md-command]').forEach(b=>{
    b.addEventListener('mousedown',e=>e.preventDefault());
    b.addEventListener('click',()=>{if(area.hidden)switchMode('edit');edit(b.dataset.mdCommand);});
  });
  expandButton.addEventListener('click',()=>expand(!box.classList.contains('md-expanded')));
  box.addEventListener('keydown',e=>{
    if(e.isComposing||e.keyCode===229)return;
    const mod=(e.ctrlKey||e.metaKey)&&!e.altKey,key=e.key.toLowerCase();
    if(e.key==='Escape'){
      if(box.classList.contains('md-expanded')){e.preventDefault();e.stopPropagation();expand(false);}
      else tabOut=true;
      return;
    }
    if(mod&&key==='s') {
      const scope=box.closest('.modal-card')||box.closest('.q-block');
      const save=scope?.querySelector('[data-act="save"], [data-act="accept"]');
      if(save){e.preventDefault();if(!save.disabled)save.click();}return;
    }
    if(mod&&e.shiftKey&&key==='p'){e.preventDefault();switchMode(area.hidden?'edit':'preview');return;}
    if(e.target!==area)return;
    let command;
    if(mod&&!e.shiftKey)command={b:'bold',i:'italic',k:'link',e:'inline'}[key];
    if(mod&&e.shiftKey)command=e.code==='Digit7'?'ordered':e.code==='Digit8'?'bullet':key==='k'?'code':undefined;
    if((e.ctrlKey||e.metaKey)&&e.altKey&&!e.shiftKey&&!e.getModifierState('AltGraph')){
      if(/^Digit[123]$/.test(e.code))command='heading'+e.code.slice(-1);
      if(/^Digit[456]$/.test(e.code))command='accent-'+{Digit4:'blue',Digit5:'red',Digit6:'green'}[e.code];
    }
    if(e.key==='Tab'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){if(tabOut){tabOut=false;return;}command=e.shiftKey?'outdent':'indent';}
    if(command){e.preventDefault();edit(command);tabOut=false;}
  });
}
