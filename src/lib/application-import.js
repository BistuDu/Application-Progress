/** Local record import. No DOM, storage or network access. */
import { normalizeCompanyType } from './company-type.js';
import { normalizeKey } from './util.js';
import { mergeImport } from './store.js';
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10000;
export const IMPORT_FIELDS = [
  ['createdAt','记录时间'],['appliedAt','投递时间'],['company','公司'],['companyType','企业性质'],
  ['title','岗位'],['status','状态'],['location','地点'],['salary','薪资'],['jobType','类型'],
  ['education','学历'],['experience','经验'],['deadline','截止时间'],['skills','技能关键词'],
  ['contact','投递方式'],['nextAction','下一步'],['notes','备注'],['sourceSite','来源'],
  ['sourceUrl','链接'],['jd','岗位职责'],['requirements','任职要求'],
];
const aliases = new Map(IMPORT_FIELDS.flatMap(([key,label])=>[[key.toLowerCase(),key],[label,key]]));
for (const [a,k] of [['公司名称','company'],['企业名称','company'],['岗位名称','title'],['职位','title'],['投递日期','appliedAt']]) aliases.set(a,k);
export function checkSize(size) { if (size > MAX_IMPORT_BYTES) throw Error('文件超过 10 MiB 上限。'); }
export function decodeImport(bytes, encoding='utf-8') {
  checkSize(bytes.byteLength);
  if (!['utf-8','gb18030'].includes(encoding)) throw Error('不支持的编码。');
  try { return new TextDecoder(encoding,{fatal:true}).decode(bytes); }
  catch { throw Error('文件解码失败，请尝试切换 UTF-8／GB18030 编码。'); }
}
export function parseCsv(text, { byteLength } = {}) {
  checkSize(byteLength ?? new TextEncoder().encode(text).length);
  text = text.replace(/^\uFEFF/,'');
  const rows=[], lines=[]; let cells=[], value='', quoted=false, closed=false, line=1, start=1;
  const cell=()=>{ cells.push(value); value=''; closed=false; };
  const row=()=>{ cell(); if(cells.some(v=>v.trim())){rows.push(cells);lines.push(start);} cells=[]; if(rows.length>MAX_IMPORT_ROWS+1)throw Error('超过 10000 条数据记录上限。'); };
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}
      else {value+=c;if(c==='\n')line++;} continue;
    }
    if(c===','){cell();continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row();line++;start=line;continue;}
    if(closed)throw Error(`第 ${line} 行：引号结束后出现多余字符。`);
    if(c==='"'){if(value)throw Error(`第 ${line} 行：字段中的引号必须转义。`);quoted=true;}else value+=c;
  }
  if(quoted)throw Error(`第 ${start} 行：引号未闭合。`);
  row();
  if(rows.length<2)throw Error('CSV 没有可导入的数据记录。');
  const headers=rows.shift().map(h=>h.trim());lines.shift();
  rows.forEach((r,i)=>{if(r.length!==headers.length)throw Error(`第 ${lines[i]} 行列数为 ${r.length}，表头为 ${headers.length} 列。`);});
  return {headers,rows,lines};
}
export function autoMapping(headers){
  const counts=new Map();headers.forEach(h=>counts.set(h.trim().toLowerCase(),(counts.get(h.trim().toLowerCase())||0)+1));
  const used=new Set();return headers.map(h=>{const n=h.trim().toLowerCase(),key=aliases.get(n)||'';if(counts.get(n)>1||used.has(key))return '';used.add(key);return key;});
}
export function validateMapping(mapping, width){
  if(!Array.isArray(mapping)||mapping.length!==width)throw Error('字段映射与表头不一致。');
  const keys=mapping.filter(Boolean), allowed=new Set(IMPORT_FIELDS.map(([k])=>k));
  if(keys.some(k=>!allowed.has(k)))throw Error('字段映射含未知目标。');
  if(new Set(keys).size!==keys.length)throw Error('多个源列不能映射到同一字段。');
  if(!keys.includes('company'))throw Error('请映射“公司”字段。');
}
export function parseImportDate(value){
  if(!value)return null;
  const m=/^(\d{4})([-/])(\d{2})\2(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(value));
  if(!m)throw Error('日期应为 YYYY-MM-DD 或 YYYY/MM/DD，可带 HH:mm[:ss]。');
  const [,y,,mo,d,h='0',mi='0',s='0']=m, nums=[y,mo,d,h,mi,s].map(Number);
  const dt=new Date(0);dt.setFullYear(nums[0],nums[1]-1,nums[2]);dt.setHours(nums[3],nums[4],nums[5],0);
  if([dt.getFullYear(),dt.getMonth()+1,dt.getDate(),dt.getHours(),dt.getMinutes(),dt.getSeconds()].some((n,i)=>n!==nums[i]))throw Error('日期或时间不存在。');
  return dt.getTime();
}
export function normalizeCsvRecord(raw, defaultStatus='已投递', now=Date.now()){
  const record={},warnings=[];
  for(const [key] of IMPORT_FIELDS)record[key]=String(raw[key]??'').trim();
  // Notes/JD can contain meaningful line breaks and leading spaces.
  for(const k of ['notes','jd','requirements'])record[k]=String(raw[k]??'');
  if(!record.company)throw Error('公司不能为空。');
  for(const k of ['createdAt','appliedAt']){try{record[k]=parseImportDate(record[k]);}catch(e){throw Error(`${k==='createdAt'?'记录时间':'投递时间'}：${e.message}`);}}
  if(record.createdAt===null){record.createdAt=now;warnings.push('空记录时间使用本次导入时间');}
  if(!record.status){record.status=defaultStatus;warnings.push(`空状态使用 ${defaultStatus}`);}
  const originalType=record.companyType;record.companyType=normalizeCompanyType(originalType);
  if(originalType&&!record.companyType&&originalType!=='未标注')warnings.push(`企业性质“${originalType}”未识别，保存为未标注`);
  record.skills=[...new Set(record.skills.split('/').map(x=>x.trim()).filter(Boolean))];
  return {record,warnings};
}
export function csvCandidates(parsed,mapping,defaultStatus,now=Date.now()){
  validateMapping(mapping,parsed.headers.length);
  return parsed.rows.map((cells,index)=>{
    const raw={};mapping.forEach((k,i)=>{if(k)raw[k]=cells[i];});
    try{return {index,line:parsed.lines[index],raw,...normalizeCsvRecord(raw,defaultStatus,now)};}
    catch(e){return {index,line:parsed.lines[index],raw,error:e.message};}
  });
}
export function readJsonImport(text){
  checkSize(new TextEncoder().encode(text).length);
  const data=JSON.parse(text),records=Array.isArray(data)?data:data?.records;
  if(!Array.isArray(records))throw Error('文件里没有 records 数组。');
  if(records.length>MAX_IMPORT_ROWS)throw Error('超过 10000 条数据记录上限。');
  return records;
}
const keyOf=r=>normalizeKey(r.company,r.title);
export function planCsv(existing,candidates,choices={}){
  // Keep a bounded sample per key. A file containing 10000 identical rows must
  // not produce quadratic duplicate arrays or an unbounded preview response.
  const seen=new Map(), relevant=new Set(candidates.filter(c=>!c.error).map(c=>keyOf(c.record)));
  const brief=r=>({id:r.id,company:r.company,title:r.title,status:r.status,appliedAt:r.appliedAt});
  const remember=(key,item)=>{
    const bucket=seen.get(key)||{count:0,samples:[]};bucket.count++;
    if(bucket.samples.length<3)bucket.samples.push(item);seen.set(key,bucket);
  };
  existing.forEach(r=>remember(keyOf(r),brief(r)));
  const rows=candidates.map(c=>{
    if(c.error)return {...c,action:'invalid',duplicates:[],duplicateCount:0};
    const key=keyOf(c.record),bucket=seen.get(key),duplicates=bucket?.samples.slice()||[],duplicateCount=bucket?.count||0;
    const action=choices[c.index]||(duplicateCount?'skip':'add');
    if(!['add','skip','exclude'].includes(action))throw Error('未知导入选择。');
    remember(key,{...brief(c.record),id:`batch:${c.index}`});
    return {...c,action,duplicates,duplicateCount};
  });
  return {rows,added:rows.filter(r=>r.action==='add').length,updated:0,
    skipped:rows.filter(r=>r.action==='skip').length,excluded:rows.filter(r=>r.action==='exclude').length,
    invalid:rows.filter(r=>r.error).length,
    fingerprint:JSON.stringify(existing.filter(r=>relevant.has(keyOf(r))).map(r=>({...brief(r),updatedAt:r.updatedAt})))};
}
export function planJson(existing,incoming){
  const merged=mergeImport(existing,incoming);
  // Full existing snapshot detects edits to same-ID records, not just changed counts.
  return {...merged,excluded:0,invalid:0,fingerprint:JSON.stringify(existing)};
}
