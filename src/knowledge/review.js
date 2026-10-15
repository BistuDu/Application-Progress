import { localDay, dayCounts, streak, candidates } from '../lib/knowledge-review.js';
import { renderMarkdown } from '../lib/markdown.js';
import { send } from './api.js';
import { esc } from './ui.js';

/** All recall text lives only in this view closure, never in messages. */
export function createReview({host,getState,setState,reload}) {
  let day=localDay(),month=day.slice(0,7),selected=day,current='',draft='',revealed=0,busy=false,message='';
  const labels={pending:'未完成',remembered:'记住了','needs-review':'需复习',unavailable:'题目不可用'};
  function clear(){current='';draft='';revealed=0;message='';}
  async function act(op,payload) {
    if(busy)return;busy=true;const active=host.querySelector('#recall');if(active)draft=active.value;
    host.querySelectorAll('button').forEach(b=>b.disabled=true);
    const res=await send({type:'KNOWLEDGE_APPLY',op,payload});busy=false;
    if(res.ok){setState(res.state);message='';}
    else {message=res.error||'保存失败，请重试';if(['conflict','question-changed','day-changed'].includes(res.code)){revealed=0;await reload();}}
    render();
  }
  function render() {
    if(host.hidden)return;
    const now=localDay();if(day!==now){day=now;selected=now;month=now.slice(0,7);clear();message='新的一天，今天的复习已准备好。';}
    const state=getState(),r=state.review,plan=r.days.find(d=>d.day===day),c=dayCounts(plan),settings=r.settings;
    const item=plan?.items.find(i=>i.status==='pending'),q=state.technicalQuestions.find(q=>q.id===item?.questionId);
    if(current!==(q?.id||'')){clear();current=q?.id||'';}
    if(revealed && revealed!==q?.revision){revealed=0;message='题目内容已更新，请重新揭晓后自评。';}
    const available=candidates(state,settings).length;
    const stamp=new Date(`${month}-01T12:00:00`),offset=(stamp.getDay()+6)%7; const cells=[];
    const last=new Date(stamp.getFullYear(),stamp.getMonth()+1,0).getDate();
    for(let n=0;n<offset;n++)cells.push('<span></span>');
    for(let n=1;n<=last;n++){const date=`${month}-${String(n).padStart(2,'0')}`,d=r.days.find(d=>d.day===date);cells.push(`<button class="calendar-day${d?.completedAt?' checked':d?' partial':''}${date===selected?' selected':''}" data-date="${date}" aria-label="${date} ${d?.completedAt?'已打卡':d?'未完成':'无记录'}" aria-pressed="${date===selected}">${n}${d?'<i></i>':''}</button>`);}
    const history=r.days.find(d=>d.day===selected),hc=dayCounts(history);
    host.innerHTML=`<div class="review-shell"><div class="review-main"><header class="review-heading"><div><span class="eyebrow">DAILY PRACTICE</span><h2>每天一点，让知识留下来</h2><p>${day} · 先回想，再对照答案</p></div><div class="streak"><b>${streak(r,day)}</b><span>连续学习 / 天</span></div></header>
      <div class="review-settings"><label>每日题量<input id="review-limit" type="number" min="1" max="100" value="${settings.dailyLimit}"></label><label>分类<select id="review-category"><option value="">全部分类</option><option value="__none__">未分类</option>${state.categories.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label><label>标签（逗号分隔，同时匹配）<input id="review-tags" value="${esc(settings.tags.join(', '))}" placeholder="如 Java, 并发"></label><button class="btn" id="review-save">保存设置</button></div>
      <p class="hint">${plan?'今日计划已固定，设置修改明日生效。':'到期薄弱题优先，不足时随机补充。'} 当前范围 ${available} 道有答案的题；空答案不参与。</p>
      <div class="review-progress"><span>今日进度 <b>${c.done} / ${c.total}</b></span><span>${plan?.completedAt?'今日已打卡':plan?'逐题自评后自动打卡':'尚未开始'}</span></div><progress max="${c.total||1}" value="${c.done}"></progress>
      ${plan && plan.items.length<plan.settingsSnapshot.dailyLimit?`<p class="hint">候选不足目标 ${plan.settingsSnapshot.dailyLimit} 题，今天按实际 ${plan.items.length} 题安排。</p>`:''}${c.unavailable?`<p class="hint">${c.unavailable} 题已删除或答案清空，已从目标中排除。</p>`:''}
      <p class="review-message" role="status">${esc(message)}</p>
      <article class="review-card">${!plan?`<span class="review-symbol">✦</span><h3>给自己几分钟，回想一下</h3><p>不必写得完整。先尝试回答，再揭晓题库中的答案。</p><button class="btn btn-primary" id="review-start" ${available?'':'disabled'}>开始今日复习</button>${!available?'<p class="hint">先补充题目答案，或调整分类与标签。</p>':''}`:q?`<div class="eyebrow">第 ${c.done+1} 题 · 剩余 ${c.total-c.done} 题</div><h3 class="review-question">${esc(q.question)}</h3><label class="recall-label" for="recall">先回想，也可以随手写几句 · 不会保存</label><textarea id="recall" placeholder="在脑海中回答也可以…" rows="4">${esc(draft)}</textarea>${!revealed?'<button class="btn btn-primary" id="review-reveal">揭晓答案</button>':`<div class="review-answer md-preview">${renderMarkdown(q.answerMarkdown)}</div><div class="review-rating"><button class="btn" data-rate="needs-review">还需复习</button><button class="btn btn-primary" data-rate="remembered">记住了，下一题 →</button></div><p class="hint">自评只影响后续复习安排，不修改题目答案。</p>`}`:`<span class="review-symbol">${plan.completedAt?'✓':'○'}</span><h3>${plan.completedAt?'今日学习完成':'暂无可继续的题目'}</h3><p>${plan.completedAt?'今天的努力已记录，明天继续。':'未评分题目均已不可用，本日不生成零题打卡。'}</p>`}</article>
      </div><aside class="review-history"><div class="calendar-head"><button class="icon-btn" id="month-prev" aria-label="上个月">‹</button><b>${month.replace('-',' / ')}</b><button class="icon-btn" id="month-next" aria-label="下个月">›</button></div><div class="calendar-grid">${['一','二','三','四','五','六','日'].map(s=>`<span class="weekday">${s}</span>`).join('')}${cells.join('')}</div><p class="hint">实色：已打卡 · 圆点：未完成</p><div class="history-detail"><h3>${selected}</h3><p class="hint">${history?`${history.completedAt?'已打卡':'未完成'} · ${hc.done}/${hc.total}`:'这一天没有学习记录'}</p>${history?.items.map(i=>`<div class="history-item"><span>${esc(i.questionTitle)}</span><small>${labels[i.status]}${!state.technicalQuestions.some(q=>q.id===i.questionId)?' · 原题已删除':''}</small></div>`).join('')||''}</div></aside></div>`;
    const $=s=>host.querySelector(s);$('#review-category').value=settings.categoryId;
    $('#review-save').onclick=()=>act('review.settings',{dailyLimit:Number($('#review-limit').value),categoryId:$('#review-category').value,tags:$('#review-tags').value.split(/[,，、]/).map(s=>s.trim()).filter(Boolean)});
    $('#review-start')?.addEventListener('click',()=>act('review.start',{day}));
    $('#recall')?.addEventListener('input',e=>{draft=e.target.value;});
    $('#review-reveal')?.addEventListener('click',()=>{revealed=q.revision;render();host.querySelector('.review-answer')?.scrollIntoView({block:'nearest'});});
    host.querySelectorAll('[data-rate]').forEach(b=>b.onclick=()=>act('review.rate',{day,planRevision:plan.revision,containerRevision:state.revision,questionId:q.id,questionRevision:revealed,result:b.dataset.rate,revealed:true}));
    host.querySelectorAll('[data-date]').forEach(b=>b.onclick=()=>{selected=b.dataset.date;render();host.querySelector(`[data-date="${selected}"]`)?.focus();});
    const changeMonth=n=>{const d=new Date(`${month}-01T12:00:00`);d.setMonth(d.getMonth()+n);month=localDay(d).slice(0,7);render();};
    $('#month-prev').onclick=()=>changeMonth(-1);$('#month-next').onclick=()=>changeMonth(1);
  }
  const check=()=>{if(!host.hidden && localDay()!==day){clear();reload();}};
  window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);setInterval(check,15000);
  return {render,clear};
}
