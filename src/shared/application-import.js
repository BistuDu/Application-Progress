import { decodeImport, parseCsv, autoMapping, IMPORT_FIELDS, validateMapping, checkSize, readJsonImport } from '../lib/application-import.js';

/** File bytes and candidates live only in this dialog's closure. */
export function openApplicationImport({onSuccess=()=>{}}={}){
  const existing=document.querySelector('#application-import[open]');if(existing){existing.focus();return existing;}
  const dialog=document.createElement('dialog');dialog.id='application-import';dialog.className='application-import';
  dialog.setAttribute('aria-labelledby','application-import-title');
  dialog.innerHTML=`<header><h2 id="application-import-title">导入招聘记录</h2><button type="button" data-close aria-label="关闭导入">×</button></header>
    <section class="import-scroll"><p>选择格式后选取文件，核对后才会保存。JSON 同 ID 会更新；CSV 只新增、不覆盖。</p>
    <div class="import-file-controls"><label>导入格式<select data-format><option value="csv">CSV 表格</option><option value="json">JSON 备份</option></select></label>
    <label data-encoding-label>文字编码<select data-encoding><option value="utf-8">UTF-8</option><option value="gb18030">GB18030（中文 Excel）</option></select></label>
    <label>选择文件<input type="file" data-file accept=".csv,text/csv"></label></div>
    <p>上限 10 MiB、10000 条记录。CSV 不恢复截图及完整状态历史；“状态变更次数”仅为汇总，不会生成历史。未匹配列将忽略。</p>
    <p data-error role="alert"></p><div data-mapping></div><p data-summary role="status"></p><p data-warning></p>
    <div data-review></div><div class="import-pager" data-pager hidden><button data-prev>上一页</button><span data-page></span><button data-next>下一页</button></div>
    <label data-invalid-label hidden><input type="checkbox" data-invalid>我确认排除全部无效行，仅导入选中的有效记录</label>
    </section><footer><button data-cancel>取消</button><button data-preview disabled>核对导入</button><button data-commit disabled>确认导入</button></footer>`;
  document.body.append(dialog);
  const $=q=>dialog.querySelector(q);
  let file=null, parsed=null, rows=null, mapping=[],plan=null, choices={},page=0,busy=false,version=0,token=crypto.randomUUID(),done=false;
  const request=async data=>{
    const res=await chrome.runtime.sendMessage({type:'APPLICATION_IMPORT',...data});
    if(!res)throw Error('扩展没有响应。');
    if(!res.ok){const e=Error(res.error||'导入失败');e.conflict=res.conflict;throw e;}return res;
  };
  const close=()=>{if(busy)return;version++;dialog.close();dialog.remove();file=parsed=rows=plan=null;};
  const error=e=>{$('[data-error]').textContent=e.message||String(e);};
  const setBusy=value=>{
    busy=value;dialog.dataset.busy=String(value);
    dialog.querySelectorAll('button,select,input').forEach(n=>{n.disabled=value;});
    if(!value){$('[data-preview]').disabled=!rows;$('[data-commit]').disabled=!plan||done||Boolean(plan.invalid&&!$('[data-invalid]').checked);renderPager();}
  };
  const reset=()=>{
    plan=null;choices={};page=0;token=crypto.randomUUID();done=false;
    $('[data-review]').replaceChildren();$('[data-summary]').textContent='';$('[data-warning]').textContent='';
    $('[data-commit]').disabled=true;$('[data-invalid-label]').hidden=true;$('[data-invalid]').checked=false;$('[data-pager]').hidden=true;
  };
  function renderPager(){if(!plan)return;const count=rows.length;$('[data-pager]').hidden=count<=50;$('[data-page]').textContent=`${page+1} / ${Math.max(1,Math.ceil(count/50))}`;$('[data-prev]').disabled=busy||page===0;$('[data-next]').disabled=busy||(page+1)*50>=count;}
  function renderReview(){
    const box=$('[data-review]');box.replaceChildren();
    if(!plan)return;
    $('[data-summary]').textContent=`共 ${rows.length} 条：新增 ${plan.added}，更新 ${plan.updated}，重复跳过 ${plan.skipped}，主动排除 ${plan.excluded}，无效 ${plan.invalid}。`;
    $('[data-warning]').textContent=$('[data-format]').value==='json'?'JSON 中相同 ID 的记录将更新；保留截图和历史，不恢复全局设置。':'空投递时间保持为空；空记录时间使用本次导入时间，空状态使用当前默认状态。';
    $('[data-invalid-label]').hidden=!plan.invalid;
    const csv=$('[data-format]').value==='csv';
    const shown=csv?plan.rows:rows.map((record,index)=>({record,index}));
    shown.slice(page*50,(page+1)*50).forEach(r=>{
      const card=document.createElement('article');card.className='import-row';
      const title=document.createElement('strong');title.textContent=`第 ${csv?parsed.lines[r.index]:r.index+1} ${csv?'行':'条'} · ${(r.record||r.raw)?.company||'无公司'} · ${(r.record||r.raw)?.title||'未填写岗位'}`;card.append(title);
      const status=document.createElement('p');status.textContent=r.error?`无效：${r.error}`:(r.warnings||[]).join('；');card.append(status);
      if(csv&&!r.error){
        const select=document.createElement('select');select.setAttribute('aria-label',`第 ${parsed.lines[r.index]} 行导入方式`);select.dataset.row=String(r.index);
        for(const [value,label] of [['add',r.duplicates.length?'另存为新记录（疑似重复）':'导入'],['skip','跳过重复'],['exclude','不导入']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
        select.value=r.action;select.addEventListener('change',()=>{choices[r.index]=select.value;void preview(false);});card.append(select);
        if(r.duplicates.length){const p=document.createElement('p');p.textContent=`疑似重复（共 ${r.duplicateCount} 条，最多展示 3 条）：`+r.duplicates.map(d=>`${d.company} · ${d.title||'未填岗位'} · ${d.status||''} · ${d.appliedAt?new Date(d.appliedAt).toLocaleDateString():'无投递日期'}`).join('；');card.append(p);}
      }
      const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='查看完整字段';pre.textContent=JSON.stringify(r.record||r.raw||r,null,2);details.append(summary,pre);card.append(details);box.append(card);
    });
    $('[data-commit]').disabled=busy||done||Boolean(plan.invalid&&!$('[data-invalid]').checked);renderPager();
  }
  async function preview(clear=true){
    if(busy)return;
    $('[data-error]').textContent='';
    if(clear){choices={};token=crypto.randomUUID();page=0;}
    plan=null;$('[data-commit]').disabled=true;
    try{
      if($('[data-format]').value==='csv'){
        validateMapping(mapping,parsed.headers.length);
        rows=parsed.rows.map(cells=>{const raw={};mapping.forEach((k,i)=>{if(k)raw[k]=cells[i];});return raw;});
      }
      setBusy(true);
      const res=await request({format:$('[data-format]').value,rows,choices});plan=res.plan;renderReview();
    }catch(e){error(e);}finally{setBusy(false);}
  }
  function renderMapping(){
    const box=$('[data-mapping]');box.replaceChildren();
    parsed.headers.forEach((header,i)=>{
      const label=document.createElement('label');label.className='import-map';
      const span=document.createElement('span');span.textContent=`列 ${i+1}：${header||'空表头'}`;
      const select=document.createElement('select');select.dataset.column=String(i);select.setAttribute('aria-label',`列 ${i+1} 字段映射`);
      for(const [key,name] of [['','忽略'],...IMPORT_FIELDS]){const option=document.createElement('option');option.value=key;option.textContent=name;select.append(option);}
      select.value=mapping[i];select.addEventListener('change',()=>{mapping[i]=select.value;reset();});label.append(span,select);box.append(label);
    });
  }
  async function read(){
    const revision=++version;reset();rows=parsed=null;$('[data-mapping]').replaceChildren();$('[data-error]').textContent='';
    if(!file){$('[data-preview]').disabled=true;return;}
    setBusy(true);
    try{
      checkSize(file.size);const bytes=await file.arrayBuffer();if(revision!==version)return;
      const format=$('[data-format]').value;
      const text=decodeImport(bytes,format==='csv'?$('[data-encoding]').value:'utf-8');
      if(format==='csv'){parsed=parseCsv(text,{byteLength:bytes.byteLength});mapping=autoMapping(parsed.headers);rows=parsed.rows;renderMapping();}
      else rows=readJsonImport(text);
    }catch(e){error(e);}finally{setBusy(false);}
    if(rows)await preview();
  }
  $('[data-file]').addEventListener('change',e=>{file=e.target.files[0]||null;e.target.value='';void read();});
  $('[data-format]').addEventListener('change',()=>{file=null;rows=null;parsed=null;reset();$('[data-mapping]').replaceChildren();$('[data-error]').textContent='';$('[data-file]').accept=$('[data-format]').value==='csv'?'.csv,text/csv':'.json,application/json';$('[data-encoding-label]').hidden=$('[data-format]').value!=='csv';$('[data-preview]').disabled=true;});
  $('[data-encoding]').addEventListener('change',()=>void read());
  $('[data-preview]').addEventListener('click',()=>void preview());
  $('[data-prev]').addEventListener('click',()=>{page--;renderReview();});$('[data-next]').addEventListener('click',()=>{page++;renderReview();});
  $('[data-invalid]').addEventListener('change',()=>{$('[data-commit]').disabled=!plan||done||Boolean(plan.invalid&&!$('[data-invalid]').checked);});
  $('[data-commit]').addEventListener('click',async()=>{
    if(busy||!plan||done)return;setBusy(true);$('[data-error]').textContent='';
    try{
      const res=await request({format:$('[data-format]').value,rows,choices,fingerprint:plan.fingerprint,token,excludeInvalid:$('[data-invalid]').checked,commit:true});
      done=true;file=null;parsed=null;rows=null;plan=null;$('[data-mapping]').replaceChildren();$('[data-review]').replaceChildren();$('[data-invalid-label]').hidden=true;$('[data-pager]').hidden=true;$('[data-summary]').textContent=res.message;
      try{await onSuccess(res);}catch{error(Error('记录已导入，但页面刷新失败，请手动刷新。'));}
    }catch(e){error(e);if(e.conflict){setBusy(false);await preview(false);error(e);}}
    finally{setBusy(false);}
  });
  $('[data-close]').addEventListener('click',close);$('[data-cancel]').addEventListener('click',close);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  dialog.showModal();return dialog;
}
