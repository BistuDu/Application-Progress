/**
 * 核对面板：手动新增、图片识别、文件导入、网页框选共用同一套逐条核对。
 *
 * 职责（design.md §6）：
 * - 展示候选、允许修改题目/答案边界、删除候选、逐条选择是否保存；
 * - 对"已有题"与"同批次内重复"逐条给出保留／采用／合并的决定，不静默覆盖；
 * - 未处理的冲突不允许提交；提交前的任何操作都不改动正式库。
 *
 * DOM 是这一层的唯一真相：保存时从输入框读回内容，失败时输入原样保留。
 */

import { candidateCountsText, commitPlan, pendingDecisions, reconcileCandidates, validateCandidates } from '../lib/knowledge-import.js';
import { describeSource } from '../lib/knowledge-store.js';
import { renderMarkdown } from '../lib/markdown.js';
import {
  $,
  bindMarkdownField,
  debounce,
  esc,
  markdownField,
  parseTags,
  qs,
  qsa,
  readSourceEditor,
  sourceEditor,
  toast,
} from './ui.js';

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.intro] 顶部说明（例如"识别出 3 道题"）
 * @param {'technical'|'project'} opts.library
 * @param {string} [opts.projectId]
 * @param {Array} opts.candidates makeCandidate 结果
 * @param {Array} opts.existing 目标库中用于比对范围里的已有题
 * @param {Array} [opts.categories] 八股文库的分类
 * @param {string} [opts.defaultCategoryId]
 * @param {Function} opts.onCreateCategory 可选：按名称新建分类，返回 {id,name}
 * @param {Function} opts.onCommit 提交回调，返回 send() 的结果
 * @param {Function} [opts.onCancel]
 */
export function openReviewPanel(opts) {
  const host = $('review-panel');
  if (!host) return null;
  host.hidden = false;

  let cands = reconcileCandidates(opts.existing || [], opts.candidates || []);
  let categories = [...(opts.categories || [])];
  const defaultCategoryId = opts.defaultCategoryId || '';
  // 文件导入可能带来库里没有的分类名，先记下来，等用户决定是否新建
  const unmatchedCategories = new Set(cands.map((c) => c.categoryName).filter((n) => n && !categories.some((x) => x.name === n)));

  const close = () => {
    host.hidden = true;
    host.innerHTML = '';
    delete host.__JDT_REVIEW_SNAPSHOT__;
  };

  function categoryOptions(selected) {
    return [`<option value="">未分类</option>`]
      .concat(categories.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`))
      .join('');
  }

  function decisionBlock(c, i) {
    if (c.target) {
      const pct = Math.round((c.target.similarity || 1) * 100);
      const isExact = c.target.kind === 'exact';
      return `<div class="conflict">
        <div class="title">${isExact ? '已有完全相同的题目' : `可能重复：与已有题目相似度 ${pct}%`}</div>
        <div class="hint">已有题目：${esc(c.target.question)}</div>
        <details class="existing"${isExact && c.target.answerMarkdown ? ' open' : ''}>
          <summary class="hint">查看已有答案</summary>
          <div class="md-preview">${c.target.answerMarkdown ? renderMarkdown(c.target.answerMarkdown) : '<span class="hint">已有题目还没有答案</span>'}</div>
        </details>
        <div class="opts">
          <label><input type="radio" name="dec-${i}" value="keep"${c.decision === 'keep' ? ' checked' : ''}> 保留已有答案</label>
          <label><input type="radio" name="dec-${i}" value="adopt"${c.decision === 'adopt' ? ' checked' : ''}> 采用这条答案</label>
          <button class="btn btn-sm" data-act="merge">把两份答案都放进编辑框</button>
        </div>
      </div>`;
    }
    if (c.batchOf) {
      const first = cands.findIndex((x) => x.id === c.batchOf);
      return `<div class="conflict">
        <div class="title">与本批第 ${first + 1} 条重复</div>
        <div class="opts">
          <label><input type="radio" name="dec-${i}" value="keep"${c.decision === 'keep' ? ' checked' : ''}> 只保留第 ${first + 1} 条</label>
          <label><input type="radio" name="dec-${i}" value="adopt"${c.decision === 'adopt' ? ' checked' : ''}> 用这条替换第 ${first + 1} 条</label>
          <label><input type="radio" name="dec-${i}" value="merge"${c.decision === 'merge' ? ' checked' : ''}> 合并到第 ${first + 1} 条</label>
        </div>
      </div>`;
    }
    return '';
  }

  function candHTML(c, i) {
    const off = c.selected === false;
    const cid = c.categoryId || (c.categoryName && categories.find((x) => x.name === c.categoryName)?.id) || defaultCategoryId;
    return `<div class="cand${off ? ' off' : ''}" data-i="${i}">
      <div class="cand-head">
        <span class="idx">${i + 1}</span>
        <span class="grow hint">${c.sources.map(describeSource).filter(Boolean).join('；') || '手工录入'}</span>
        <label class="hint"><input type="checkbox" data-f="selected"${off ? '' : ' checked'}> 保存这条</label>
        <button class="icon-btn" data-act="del" title="删除这条候选">✕</button>
      </div>
      <div class="field"><label>题目（不能为空）</label><textarea rows="2" data-f="question" placeholder="例如：数据库索引为什么能加速查询？">${esc(c.question)}</textarea></div>
      <div class="sec" style="margin:10px 0 0">
        ${markdownField({ id: `cand-md-${i}`, value: c.answerMarkdown, rows: 6, placeholder: '答案可以留空，之后在题库里再补' })}
      </div>
      <div class="grid2" style="margin-top:10px">
        ${
          opts.library === 'technical'
            ? `<div class="field"><label>分类</label><select data-f="categoryId">${categoryOptions(cid)}</select></div>
               <div class="field"><label>标签（逗号或空格分隔）</label><input data-f="tags" value="${esc((c.tags || []).join('、'))}" placeholder="索引、性能优化"></div>`
            : ''
        }
      </div>
      <div class="sec" style="margin:10px 0 0">
        <div class="sec-title"><span>来源</span><span class="hint">未知页码留空，不保存原始文件</span></div>
        <div class="sources" style="margin-bottom:6px">${c.sources.length ? c.sources.map((s) => `<span class="chip-src">${esc(describeSource(s))}</span>`).join('') : '<span class="hint">暂无</span>'}</div>
        <details><summary class="hint" style="cursor:pointer">补充或修改来源</summary>${sourceEditor({ id: `cand-src-${i}`, source: c.sources[0] || null })}</details>
      </div>
      ${decisionBlock(c, i)}
    </div>`;
  }

  /** 只刷新某条候选的冲突区：不重建输入框，避免打断正在输入的题目。 */
  function refreshConflict(i) {
    const card = qs(host, `.cand[data-i="${i}"]`);
    if (!card) return;
    const current = qs(card, '.conflict');
    const next = decisionBlock(cands[i], i);
    if (current) {
      if (next) current.outerHTML = next;
      else current.remove();
    } else if (next) {
      card.insertAdjacentHTML('beforeend', next);
    }
    bindConflictActions();
  }

  function bindConflictActions() {
    qsa(host, '[data-act="merge"]').forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = '1';
      b.addEventListener('click', () => {
        const card = b.closest('.cand');
        const i = Number(card.dataset.i);
        const existingAnswer = cands[i].target?.answerMarkdown || '';
        const area = qs(card, `#cand-md-${i}`);
        area.value = `${existingAnswer}\n\n---\n\n${area.value}`.trim();
        const adopt = qs(card, 'input[value="adopt"]');
        if (adopt) adopt.checked = true;
        toast('已把两份答案放入编辑框，请整理后再保存', { ms: 3200 });
      });
    });
  }

  /**
   * 题目被修改后重新比对：手工新增题目时也要能发现与已有题目重复（spec technical-question-bank）。
   * 已做出的决定只在"冲突对象没变"时保留，否则要求重新选择。
   */
  const recheck = debounce((i) => {
    if (!cands.length) return;
    const typed = collect();
    const fresh = reconcileCandidates(opts.existing || [], typed);
    cands = fresh.map((c, idx) => {
      const prev = typed[idx] || {};
      const sameTarget = (c.target?.id || '') === (prev.target?.id || '') && (c.batchOf || '') === (prev.batchOf || '');
      return { ...c, decision: sameTarget ? prev.decision ?? c.decision : c.decision };
    });
    refreshConflict(i);
    updateSummary();
  }, 380);

  function render() {
    const unmatched = [...unmatchedCategories];
    host.innerHTML = `<div class="modal-card wide">
      <div class="m-head">
        <h2>${esc(opts.title || '核对题目')}</h2>
        <span class="chip">${opts.library === 'project' ? '项目问答' : '八股文题库'}</span>
        <button class="icon-btn" data-act="close" title="取消">✕</button>
      </div>
      <div class="m-body">
        <div class="banner banner-info"><span>ℹ️</span><div>
          ${esc(opts.intro || `共 ${cands.length} 条候选，核对后才会写入正式库。`)}
          <div class="hint">图片与上传的文件只在本次识别中使用，不会保存；候选里只保留题目、答案、标签与来源。</div>
        </div></div>
        ${unmatched.length ? `<div class="banner banner-warn"><span>⚠️</span><div>
          文件里的分类「${unmatched.map(esc).join('、')}」在题库里还不存在，候选会先按未分类保存。
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
            ${unmatched.map((n) => `<button class="btn btn-sm" data-act="newcat" data-name="${esc(n)}">新建分类「${esc(n)}」</button>`).join('')}
          </div>
        </div></div>` : ''}
        ${cands.length ? cands.map(candHTML).join('') : '<div class="empty-list">没有候选内容。</div>'}
      </div>
      <div class="m-foot">
        <span class="grow hint" id="rv-summary"></span>
        <button class="btn" data-act="close">取消</button>
        <button class="btn btn-primary" data-act="save">保存到知识库</button>
      </div>
    </div>`;

    cands.forEach((_c, i) => bindMarkdownField(host, `cand-md-${i}`));
    qsa(host, '[data-act="close"]').forEach((b) => b.addEventListener('click', cancel));
    qs(host, '[data-act="save"]').addEventListener('click', save);
    qsa(host, '[data-act="del"]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.closest('.cand').dataset.i);
        cands.splice(i, 1);
        render();
      }),
    );
    bindConflictActions();
    qsa(host, '[data-act="newcat"]').forEach((b) =>
      b.addEventListener('click', async () => {
        const name = b.dataset.name;
        if (!opts.onCreateCategory) return;
        const made = await opts.onCreateCategory(name);
        if (!made) return;
        categories = [...categories, made];
        unmatchedCategories.delete(name);
        cands = cands.map((c) => (c.categoryName === name ? { ...c, categoryId: made.id } : c));
        render();
      }),
    );
    qsa(host, '.cand input[type=checkbox][data-f="selected"]').forEach((box) =>
      box.addEventListener('change', () => {
        box.closest('.cand').classList.toggle('off', !box.checked);
        updateSummary();
      }),
    );
    // 题目改动后重新比对，保证手工新增也能发现重复题
    qsa(host, '.cand [data-f="question"]').forEach((area) =>
      area.addEventListener('input', () => recheck(Number(area.closest('.cand').dataset.i))),
    );
    updateSummary();
  }

  /** 从 DOM 读回当前候选；target / batchOf / id 这些元数据沿用原值。 */
  function collect() {
    const out = [];
    qsa(host, '.cand').forEach((card) => {
      const i = Number(card.dataset.i);
      const base = cands[i] || {};
      const decision = qs(card, '.conflict input[type=radio]:checked')?.value || base.decision || null;
      const src = readSourceEditor(card, `cand-src-${i}`);
      const sources = base.sources || [];
      out.push({
        ...base,
        question: qs(card, '[data-f="question"]').value.trim(),
        answerMarkdown: qs(card, `#cand-md-${i}`).value,
        tags: qs(card, '[data-f="tags"]') ? parseTags(qs(card, '[data-f="tags"]').value) : base.tags || [],
        categoryId: qs(card, '[data-f="categoryId"]') ? qs(card, '[data-f="categoryId"]').value : base.categoryId || '',
        selected: qs(card, '[data-f="selected"]').checked,
        // 只在用户补充了内容时才替换来源，避免把原来的来源数组清空
        sources: src && (src.url || src.fileName || src.pageTitle || src.pageNumbers.length) ? [src] : sources,
        decision,
      });
    });
    return out;
  }

  function updateSummary() {
    const box = qs(host, '#rv-summary');
    if (!box) return;
    const list = collect();
    const active = list.filter((c) => c.selected !== false);
    const pending = pendingDecisions(list);
    if (pending.length) {
      box.innerHTML = `还有 <b>${pending.length}</b> 条重复题没有处理，处理后才能保存。`;
      return;
    }
    if (!active.length) {
      box.textContent = '勾选至少一条要保存的候选。';
      return;
    }
    const problems = validateCandidates(active);
    if (problems.length) {
      box.innerHTML = `有 <b>${problems.length}</b> 条候选缺少题目。`;
      return;
    }
    try {
      const plan = commitPlan(list);
      const counts = plan.counts;
      const add = plan.candidates.filter((c) => c.decision === 'create').length;
      const upd = plan.candidates.filter((c) => c.decision === 'update' && c.mode !== 'keep').length;
      const keep = plan.candidates.filter((c) => c.mode === 'keep').length;
      box.textContent =
        `将写入 ${plan.candidates.length} 条：新增 ${add} 条` +
        (upd ? `，更新 ${upd} 条` : '') +
        (keep ? `，保留原答案 ${keep} 条` : '') +
        (counts.skippedByUser ? `，舍弃 ${counts.skippedByUser} 条` : '') +
        '。';
    } catch (err) {
      box.innerHTML = esc(err?.message || '还有冲突没有处理。');
    }
  }

  function cancel() {
    close();
    opts.onCancel?.();
  }

  async function save() {
    const list = collect();
    const active = list.filter((c) => c.selected !== false);
    if (!active.length) {
      toast('勾选至少一条要保存的候选。', { type: 'err' });
      return;
    }
    const problems = validateCandidates(active);
    if (problems.length) {
      toast(problems[0], { type: 'err' });
      return;
    }
    const pending = pendingDecisions(list);
    if (pending.length) {
      toast(`还有 ${pending.length} 条重复题没有处理，请先选择保留、采用或合并。`, { type: 'err' });
      updateSummary();
      return;
    }
    let plan;
    try {
      plan = commitPlan(list);
    } catch (err) {
      toast(err?.message || '无法提交，请检查候选。', { type: 'err' });
      return;
    }
    const btn = qs(host, '[data-act="save"]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    const res = await opts.onCommit({
      library: opts.library,
      projectId: opts.projectId,
      candidates: plan.candidates,
      counts: plan.counts,
    });
    btn.disabled = false;
    btn.textContent = '保存到知识库';
    if (!res || res.ok === false) {
      // 保存失败时保留全部输入，只提示原因
      const box = qs(host, '#rv-summary');
      if (box) box.innerHTML = `<b style="color:#dc2626">保存失败：</b>${esc(res?.error || '未知错误')}。输入已保留，可直接重试。`;
      toast(`保存失败：${res?.error || '未知错误'}`, { type: 'err', ms: 7000 });
      return;
    }
    const counts = res.result?.counts || plan.counts;
    close();
    toast(`已写入知识库：${candidateCountsText(counts)}`, { type: 'ok' });
    opts.onCommitDone?.(res, counts);
  }

  host.__JDT_REVIEW_SNAPSHOT__=()=>({title:opts.title,intro:opts.intro,library:opts.library,projectId:opts.projectId,candidates:collect()});
  render();
  return { close, getCandidates: () => collect() };
}
