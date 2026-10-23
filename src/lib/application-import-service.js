/** Shared record write queue and latest-state import validation. */
import { MAX_IMPORT_ROWS, normalizeCsvRecord, planCsv, planJson } from './application-import.js';
import { uid } from './util.js';
export function createRecordQueue(){
  let chain=Promise.resolve();
  return fn=>{const next=chain.then(fn);chain=next.catch(()=>{});return next;};
}
export function createImportService({listRecords,saveRecords,getSettings}){
  const completed=new Map();
  return async function execute(request){
    const {format,rows,choices={},fingerprint,token,excludeInvalid=false}=request;
    // Mapped JSON adds keys and GB18030 text can expand in UTF-8. The file
    // limit is 10 MiB; allow a bounded 32 MiB internal representation.
    if(new TextEncoder().encode(JSON.stringify(rows)).length>32*1024*1024)throw Error('导入数据体积超过内部处理上限。');
    if(!Array.isArray(rows)||(format==='csv'&&!rows.length)||rows.length>MAX_IMPORT_ROWS)throw Error('导入记录数量无效。');
    if(!['csv','json'].includes(format))throw Error('请选择 JSON 或 CSV。');
    const signature=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({format,rows,choices,excludeInvalid}))))).map(n=>n.toString(16).padStart(2,'0')).join('');
    if(request.commit&&(!token||typeof token!=='string'||token.length>200))throw Error('导入提交令牌无效。');
    if(request.commit&&completed.has(token)){
      const saved=completed.get(token);if(saved.signature!==signature)throw Error('提交令牌已经用于其他内容。');return saved.result;
    }
    const existing=await listRecords(), settings=await getSettings();
    const now=Date.now();
    const candidates=format==='csv'?rows.map((raw,index)=>{
      try{return {index,raw,...normalizeCsvRecord(raw,settings.defaultStatus,now)};}
      catch(e){return {index,raw,error:e.message};}
    }):null;
    const plan=format==='csv'?planCsv(existing,candidates,choices):planJson(existing,rows);
    const summary={added:plan.added,updated:plan.updated,skipped:plan.skipped,excluded:plan.excluded,invalid:plan.invalid};
    if(!request.commit)return {ok:true,plan:format==='csv'?{...plan,rows:plan.rows}: {...summary,fingerprint:plan.fingerprint}};
    if(fingerprint!==plan.fingerprint)return {ok:false,conflict:true,error:'记录已变化，请重新核对后确认。'};
    if(plan.invalid&&!excludeInvalid)throw Error('请明确排除无效行后再提交。');
    let records;
    if(format==='csv'){
      records=[...existing,...plan.rows.filter(r=>r.action==='add').map(({record})=>({...record,id:uid('job'),updatedAt:now,statusHistory:[{status:record.status,at:now,note:'CSV 导入'}]}))];
    }else records=plan.records;
    await saveRecords(records);
    const result={ok:true,...summary,message:`导入完成：新增 ${summary.added}，更新 ${summary.updated}，重复跳过 ${summary.skipped}，主动排除 ${summary.excluded}，无效 ${summary.invalid} 条。`};
    completed.set(token,{signature,result});
    if(completed.size>100)completed.delete(completed.keys().next().value);
    return result;
  };
}
