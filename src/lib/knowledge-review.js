/** Pure daily review rules. Temporary recall text is never accepted here. */
export const INTERVALS = [1, 3, 7, 14, 30];
export const localDay = (now = Date.now()) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function validDay(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T12:00:00`); return Number.isFinite(+d) && localDay(d) === s; }
export function addDays(day, n) { if (!validDay(day)) throw failure('日期无效'); const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate()+n); return localDay(d); }
const failure = (message, code = 'invalid') => Object.assign(new Error(message), {code});
const text = (v, n=2000) => String(v ?? '').slice(0,n);
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const rated = (s) => ['remembered','needs-review'].includes(s);
export const emptyReview = () => ({settings:{dailyLimit:10,categoryId:'',tags:[]},progress:[],days:[]});
export function reviewSettings(input = {}) {
  if (!integer(input.dailyLimit,1,100)) throw failure('每日题量应为 1–100 的整数');
  return {dailyLimit:input.dailyLimit,categoryId:text(input.categoryId,120),tags:[...new Set((Array.isArray(input.tags)?input.tags:[]).map(t=>text(t,40).trim()).filter(Boolean))].slice(0,30)};
}
/** Strict structural validation, allowing historical references to deleted questions. */
export function validateReview(r) {
  const errors=[];
  try {
    if (!r || typeof r !== 'object' || !Array.isArray(r.progress) || !Array.isArray(r.days)) throw failure('学习记录结构无效');
    reviewSettings(r.settings);
    const seen=new Set();
    for(const p of r.progress) {
      if(!p || typeof p.questionId!=='string' || !p.questionId || seen.has(p.questionId) || !integer(p.stage,0,5) || !rated(p.lastResult) || !validDay(p.lastReviewedDay) || !validDay(p.dueDay) || p.dueDay<=p.lastReviewedDay) throw failure('学习间隔进度无效');
      seen.add(p.questionId);
    }
    seen.clear();
    for(const d of r.days) {
      if(!d || !validDay(d.day) || seen.has(d.day) || !integer(d.revision,1,Number.MAX_SAFE_INTEGER) || !Array.isArray(d.items) || d.items.length>100 || !Number.isFinite(d.createdAt) || d.createdAt<=0 || !Number.isFinite(d.completedAt) || d.completedAt<0) throw failure('每日计划日期或版本无效');
      seen.add(d.day); reviewSettings(d.settingsSnapshot); const ids=new Set();
      for(const i of d.items) {
        if(!i || !i.questionId || typeof i.questionId!=='string' || ids.has(i.questionId) || typeof i.questionTitle!=='string' || !['pending','remembered','needs-review','unavailable'].includes(i.status) || !Number.isFinite(i.questionUpdatedAt) || !integer(i.questionRevision,1,Number.MAX_SAFE_INTEGER) || !Number.isFinite(i.ratedAt) || (rated(i.status) ? i.ratedAt<=0 : i.ratedAt!==0)) throw failure('每日题目或自评无效');
        ids.add(i.questionId);
      }
      const c=dayCounts(d); if(d.completedAt && (!c.total || c.done!==c.total)) throw failure('打卡完成状态无效');
    }
  } catch(e) {errors.push(e.message);}
  return {ok:!errors.length,errors};
}
export function cleanReview(raw) {
  const r=raw ?? emptyReview(); const check=validateReview(r); if(!check.ok) throw failure(check.errors.join('；'));
  return {settings:reviewSettings(r.settings),progress:r.progress.map(p=>({questionId:text(p.questionId,120),stage:p.stage,lastResult:p.lastResult,lastReviewedDay:p.lastReviewedDay,dueDay:p.dueDay})),days:r.days.map(d=>({day:d.day,timeZone:text(d.timeZone,100),revision:d.revision,settingsSnapshot:reviewSettings(d.settingsSnapshot),createdAt:d.createdAt,completedAt:d.completedAt,items:d.items.map(i=>({questionId:text(i.questionId,120),questionTitle:text(i.questionTitle),questionUpdatedAt:i.questionUpdatedAt,questionRevision:i.questionRevision,status:i.status,ratedAt:i.ratedAt}))}))};
}
export function dayCounts(d) {const items=d?.items||[];return {done:items.filter(i=>rated(i.status)).length,total:items.filter(i=>i.status!=='unavailable').length,unavailable:items.filter(i=>i.status==='unavailable').length};}
export function streak(review, today=localDay()) {const completed=new Set(review.days.filter(d=>d.completedAt).map(d=>d.day));let day=completed.has(today)?today:addDays(today,-1),n=0;while(completed.has(day)){n++;day=addDays(day,-1);}return n;}
function shuffled(list, random) {const a=[...list]; for(let i=a.length-1;i>0;i--){const j=Math.min(i,Math.floor(random()*(i+1)));[a[i],a[j]]=[a[j],a[i]];}return a;}
export function candidates(state, settings) {return state.technicalQuestions.filter(q=>q.answerMarkdown.trim() && (!settings.categoryId || (settings.categoryId==='__none__' ? !q.categoryId : q.categoryId===settings.categoryId)) && settings.tags.every(t=>q.tags.includes(t)));}
export function selectQuestions(state, settings, day, random=Math.random) {
  const pool=candidates(state,settings),progress=new Map(state.review.progress.map(p=>[p.questionId,p]));
  const due=pool.filter(q=>progress.get(q.id)?.dueDay<=day);
  due.sort((a,b)=>{const p=progress.get(a.id),r=progress.get(b.id);return (p.lastResult==='needs-review'?0:1)-(r.lastResult==='needs-review'?0:1) || p.dueDay.localeCompare(r.dueDay) || p.lastReviewedDay.localeCompare(r.lastReviewedDay);});
  const ids=new Set(due.map(q=>q.id)); return [...due,...shuffled(pool.filter(q=>!ids.has(q.id)),random)].slice(0,settings.dailyLimit);
}
/** Only today's pending entries change. Closed historical days are immutable. */
export function reconcileReview(review, questions, now=Date.now()) {
  const next=cleanReview(review),today=localDay(now); const d=next.days.find(d=>d.day===today);if(!d||d.completedAt)return next;
  const byId=new Map(questions.map(q=>[q.id,q]));let changed=false;
  for(const i of d.items) if(i.status==='pending' && !byId.get(i.questionId)?.answerMarkdown.trim()){i.status='unavailable';changed=true;}
  if(changed){d.revision++;const c=dayCounts(d);if(c.total>0 && c.done===c.total)d.completedAt=now;}
  return next;
}
export function reviewOp(state, op, payload={}, now=Date.now(), random=Math.random) {
  // Reject unrecognized fields, especially temporary recall drafts.
  const allowed={ 'review.settings':['dailyLimit','categoryId','tags'], 'review.start':['day'], 'review.rate':['day','planRevision','questionId','questionRevision','result','revealed','containerRevision'] }[op];
  if(!allowed || Object.keys(payload).some(k=>!allowed.includes(k)))throw failure('学习操作包含不支持的字段');
  const today=localDay(now),next={...state,review:reconcileReview(state.review,state.technicalQuestions,now)};
  const r=next.review;
  if(op==='review.settings') {
    r.settings=reviewSettings(payload);
    if(r.settings.categoryId && r.settings.categoryId!=='__none__' && !state.categories.some(c=>c.id===r.settings.categoryId))throw failure('分类已不存在，请重新选择');
  } else {
    if(payload.day!==today)throw failure('日期已变化，请返回今日复习', 'day-changed');
    let d=r.days.find(d=>d.day===today);
    if(op==='review.start') {
      if(!d){const qs=selectQuestions(next,r.settings,today,random);if(!qs.length)throw failure('没有可复习的题目：请添加非空答案或调整分类标签','empty');
        d={day:today,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,revision:1,settingsSnapshot:{...r.settings,tags:[...r.settings.tags]},createdAt:now,completedAt:0,items:qs.map(q=>({questionId:q.id,questionTitle:q.question,questionUpdatedAt:q.updatedAt,questionRevision:q.revision,status:'pending',ratedAt:0}))};r.days.push(d);}
    } else {
      if(!d)throw failure('今日计划不存在，请重新开始','conflict');
      // Restores invalidate stale views even when the plan happens to have the same revision.
      if(payload.containerRevision!==state.revision)throw failure('知识库已更新，请重新载入后核对','conflict');
      const i=d.items.find(i=>i.questionId===payload.questionId);if(!i)throw failure('题目不在今日计划中');
      if(rated(i.status))return {state,result:{alreadyRated:true}};
      if(payload.planRevision!==d.revision)throw failure('学习进度已更新，请重新载入','conflict');
      const q=state.technicalQuestions.find(q=>q.id===i.questionId);
      if(i.status!=='pending'||!q?.answerMarkdown.trim())throw failure('题目已不可用，请重新载入','conflict');
      if(!payload.revealed || payload.questionRevision!==q.revision)throw failure('题答已变化或尚未揭晓，请重新揭晓后自评','question-changed');
      if(!rated(payload.result))throw failure('请选择有效自评');
      Object.assign(i,{status:payload.result,ratedAt:now,questionTitle:q.question,questionUpdatedAt:q.updatedAt,questionRevision:q.revision});
      const p=r.progress.find(p=>p.questionId===q.id);const stage=payload.result==='needs-review'?0:Math.min((p?.stage||0)+1,5);
      const progress={questionId:q.id,stage,lastResult:payload.result,lastReviewedDay:today,dueDay:addDays(today,stage?INTERVALS[stage-1]:1)};
      r.progress=r.progress.filter(p=>p.questionId!==q.id);r.progress.push(progress);d.revision++;
      const c=dayCounts(d);if(c.total>0 && c.done===c.total && !d.completedAt)d.completedAt=now;
    }
  }
  next.revision=state.revision+1; return {state:next,result:{}};
}
