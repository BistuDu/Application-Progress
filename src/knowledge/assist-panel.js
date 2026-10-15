/**
 * AI 参考面板：自动匹配参考题 → 用户增删参考 → 生成 Markdown 草稿 → 编辑并选择是否采用。
 *
 * 约束（design.md §7、spec project-answer-assistance）：
 * - 自动候选只作为建议；空答案题不作为默认依据，但可以展开查看后手动选中；
 * - 生成请求只包含用户最终选定的参考（由 background 按 ID 从正式库解析）；
 * - 草稿与已有答案并列展示，只有「保存采用」才会更新唯一答案；
 * - 输入在生成期间发生变化时阻止无核对覆盖。
 */

import { matchReferences, searchQuestionBank } from '../lib/knowledge-match.js';
import { renderMarkdown } from '../lib/markdown.js';
import { startTask } from './api.js';
import { $, bindMarkdownField, esc, fmtTime, markdownField, qs, qsa, toast } from './ui.js';

/**
 * @param {object} opts
 * @param {object} opts.project {id, name, summary, responsibilities, revision}
 * @param {string} opts.question 当前题目
 * @param {string} opts.currentAnswer
 * @param {number} opts.entityRevision 当前题目的 revision（用于过期检测）
 * @param {Array} opts.questions 八股文题库
 * @param {Array} opts.categories
 * @param {boolean} opts.hasApiKey
 * @param {Function} opts.stillValid 返回 false 表示输入已被修改，必须重新核对
 * @param {Function} opts.onAccept {markdown, references}
 * @param {Function} [opts.onCancel]
 * @param {Function} [opts.onNeedSetup]
 */
export function openAssistPanel(opts) {
  const host = $('assist-panel');
  if (!host) return null;
  host.hidden = false;

  const selected = new Set();
  let step = 'refs';
  let draft = '';
  let usedReferences = [];
  let missingReferences = [];
  let projectOnly = false;
  let errorText = '';
  let busyText = '';
  let progress = { page: 0, total: 0 };
  let task = null;
  let cancelled = false;
  let searchTerm = '';

  const candidates = matchReferences({
    questions: opts.questions,
    categories: opts.categories,
    query: { question: opts.question, summary: opts.project?.summary, responsibilities: opts.project?.responsibilities },
    limit: 8,
  });
  for (const c of candidates) if (c.suggested) selected.add(c.id);

  const close = () => {
    task?.abort();
    host.hidden = true;
    host.innerHTML = '';
  };

  const byId = new Map((opts.questions || []).map((q) => [q.id, q]));

  function refRow(c, i) {
    const q = byId.get(c.id) || {};
    const picked = selected.has(c.id);
    return `<div class="ref-row${picked ? ' picked' : ''}" data-id="${esc(c.id)}">
      <input type="checkbox" data-act="pick"${picked ? ' checked' : ''}>
      <div class="grow">
        <div class="t">${esc(c.question)} ${c.hasAnswer ? '' : '<span class="chip-src">无答案</span>'}
          ${c.suggested ? '<span class="pick-badge">建议参考</span>' : ''}</div>
        <div class="chips" style="margin-top:5px">${(c.evidence || []).map((e) => `<span class="chip-evi">${esc(e)}</span>`).join('')}
          ${(q.tags || []).map((t) => `<span class="chip-tag">${esc(t)}</span>`).join('')}
          <span class="hint">匹配分 ${c.score}</span></div>
        ${
          c.hasAnswer
            ? `<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">查看答案</summary>
                 <div class="a md-preview">${renderMarkdown(c.answerMarkdown)}</div></details>`
            : '<div class="hint" style="margin-top:5px">这道题还没有答案，可以作为方向参考。</div>'
        }
        ${i === 0 ? '' : ''}
      </div>
    </div>`;
  }

  function searchResults() {
    if (!searchTerm.trim()) return '';
    const hits = searchQuestionBank(opts.questions, opts.categories, searchTerm, { limit: 12 });
    if (!hits.length) return '<div class="hint" style="margin-top:6px">题库里没有匹配的题目。</div>';
    return `<div style="margin-top:8px">${hits
      .map(
        (h) => `<div class="ref-row" data-id="${esc(h.id)}">
          <button class="btn btn-sm" data-act="add">${selected.has(h.id) ? '已加入' : '加入参考'}</button>
          <div class="grow"><div class="t">${esc(h.question)}</div>
          <div class="hint">${esc(h.categoryName || '未分类')}${h.tags?.length ? ` · ${esc(h.tags.join('、'))}` : ''}${h.hasAnswer ? '' : ' · 暂无答案'}</div></div>
        </div>`,
      )
      .join('')}</div>`;
  }

  function refsStep() {
    const selectedList = [...selected].map((id) => byId.get(id)).filter(Boolean);
    return `
      <div class="m-head">
        <h2>项目回答辅助</h2>
        <span class="chip">${esc(opts.project?.name || '')}</span>
        <button class="icon-btn" data-act="close" title="取消">✕</button>
      </div>
      <div class="m-body">
        <div class="sec">
          <div class="sec-title"><span>当前题目</span></div>
          <div class="md-preview">${renderMarkdown(opts.question) || '<span class="hint">（尚未填写题目）</span>'}</div>
        </div>
        ${errorText ? `<div class="banner banner-err"><span>⚠️</span><div>${esc(errorText)}</div></div>` : ''}
        <div class="sec">
          <div class="sec-title"><span>参考题（可增删，生成时只使用你勾选的）</span><span class="grow"></span>
            <span class="hint">已选 ${selectedList.length} 条</span></div>
          ${opts.questions?.length ? '' : '<div class="banner banner-warn"><span>⚠️</span><div>八股文题库还是空的，你可以直接勾选下面的「只按项目资料生成」。</div></div>'}
          ${candidates.length ? candidates.map(refRow).join('') : opts.questions?.length ? '<div class="hint">没有匹配到相关题目。你可以在下面搜索整库，或选择只按项目资料生成。</div>' : ''}
        </div>
        <div class="sec">
          <div class="sec-title"><span>搜索整个八股文题库</span></div>
          <div style="display:flex;gap:8px">
            <input id="as-search" style="flex:1;padding:7px 10px;border:1px solid #e6ecf4;border-radius:9px" placeholder="例如：索引 优化 并发" value="${esc(searchTerm)}">
            <button class="btn" data-act="dosearch">搜索</button>
          </div>
          <div id="as-results">${searchResults()}</div>
        </div>
        <div class="sec">
          <label class="hint" style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" data-act="projectonly"${projectOnly ? ' checked' : ''}>
            只按项目资料生成（明确不使用任何参考题）
          </label>
        </div>
      </div>
      <div class="m-foot">
        <span class="grow hint">参考资料只作为技术表达参考，不代表你在项目里做过这些事。</span>
        <button class="btn" data-act="close">取消</button>
        <button class="btn btn-primary" data-act="generate"${selected.size || projectOnly ? '' : ' disabled'}>生成回答草稿</button>
      </div>`;
  }

  function generatingStep() {
    return `<div class="m-head"><h2>项目回答辅助</h2><span class="chip">${esc(opts.project?.name || '')}</span></div>
      <div class="m-body">
        <div class="progress-line"><span class="spinner"></span><span>${esc(busyText || '正在生成草稿…')}</span></div>
        <div class="hint" style="margin-top:8px">已选 ${selected.size} 条参考${projectOnly ? '（只按项目资料生成）' : ''}。生成期间可以取消。</div>
      </div>
      <div class="m-foot"><span class="grow"></span><button class="btn" data-act="abort">取消生成</button></div>`;
  }

  function draftStep() {
    return `<div class="m-head">
        <h2>AI 草稿（尚未保存）</h2>
        <span class="chip">${esc(opts.project?.name || '')}</span>
        <button class="icon-btn" data-act="close" title="取消">✕</button>
      </div>
      <div class="m-body">
        ${missingReferences.length ? `<div class="banner banner-warn"><span>⚠️</span><div>有 ${missingReferences.length} 条参考题在生成时已不存在，本次草稿没有使用它们。</div></div>` : ''}
        <div class="sec">
          <div class="sec-title"><span>草稿内容（可编辑，Markdown）</span><span class="grow"></span>
            <span class="hint">只有点「保存采用」才会更新当前答案</span></div>
          ${markdownField({ id: 'as-draft', value: draft, rows: 14 })}
        </div>
        <div class="sec">
          <div class="sec-title"><span>已有答案（不会被自动覆盖）</span></div>
          <div class="md-preview">${opts.currentAnswer ? renderMarkdown(opts.currentAnswer) : '<span class="hint">当前题目还没有答案</span>'}</div>
        </div>
        <div class="sec">
          <div class="sec-title"><span>本次使用的参考题</span></div>
          ${
            usedReferences.length
              ? usedReferences
                  .map(
                    (r) => `<div class="ref-line">📎 ${esc(r.questionTitle)} <span class="hint">使用于 ${esc(fmtTime(r.referencedUpdatedAt))}</span></div>`,
                  )
                  .join('')
              : `<div class="hint">${projectOnly ? '按你的选择，只使用了项目资料。' : '没有使用参考题。'}</div>`
          }
        </div>
      </div>
      <div class="m-foot">
        <span class="grow hint">保存后会在项目答案上记录这些参考题，参考题之后被修改或删除不会改写这份答案。</span>
        <button class="btn" data-act="back">返回参考题</button>
        <button class="btn" data-act="close">取消</button>
        <button class="btn btn-primary" data-act="accept">保存采用</button>
      </div>`;
  }

  function render() {
    host.innerHTML = `<div class="modal-card wide">${
      step === 'refs' ? refsStep() : step === 'generating' ? generatingStep() : draftStep()
    }</div>`;
    if (step === 'draft') bindMarkdownField(host, 'as-draft');

    qsa(host, '[data-act="close"]').forEach((b) => b.addEventListener('click', () => {
      close();
      opts.onCancel?.();
    }));

    if (step === 'refs') {
      qsa(host, '[data-act="pick"]').forEach((box) =>
        box.addEventListener('change', () => {
          const id = box.closest('.ref-row').dataset.id;
          if (box.checked) selected.add(id);
          else selected.delete(id);
          render();
        }),
      );
      qsa(host, '[data-act="add"]').forEach((b) =>
        b.addEventListener('click', () => {
          selected.add(b.closest('.ref-row').dataset.id);
          render();
        }),
      );
      qs(host, '[data-act="dosearch"]').addEventListener('click', () => {
        searchTerm = qs(host, '#as-search').value;
        render();
      });
      qs(host, '#as-search').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          searchTerm = e.target.value;
          render();
        }
      });
      qs(host, '[data-act="projectonly"]').addEventListener('change', (e) => {
        projectOnly = e.target.checked;
        render();
      });
      qs(host, '[data-act="generate"]').addEventListener('click', generate);
    } else if (step === 'generating') {
      qs(host, '[data-act="abort"]').addEventListener('click', () => {
        cancelled = true;
        task?.abort();
        step = 'refs';
        errorText = '已取消生成，草稿没有保存。';
        render();
      });
    } else {
      qs(host, '[data-act="back"]').addEventListener('click', () => {
        step = 'refs';
        render();
      });
      qs(host, '[data-act="accept"]').addEventListener('click', accept);
    }
  }

  async function generate() {
    errorText = '';
    if (!opts.hasApiKey) {
      errorText = '还没有配置 API Key，请先在设置里填写后再生成。';
      render();
      opts.onNeedSetup?.();
      return;
    }
    if (!selected.size && !projectOnly) {
      errorText = '请至少选择一条参考题，或勾选「只按项目资料生成」。';
      render();
      return;
    }
    step = 'generating';
    busyText = '正在生成回答草稿…';
    progress = { page: 0, total: 0 };
    cancelled = false;
    render();
    task = startTask({
      task: 'project-answer',
      projectId: opts.project?.id,
      question: opts.question,
      currentAnswer: opts.currentAnswer,
      referenceIds: [...selected],
      projectOnly,
    });
    try {
      const res = await task.promise;
      if (cancelled) return;
      draft = res.draft || '';
      usedReferences = res.references || [];
      missingReferences = res.missingReferences || [];
      step = 'draft';
      render();
    } catch (err) {
      if (cancelled) return;
      step = 'refs';
      errorText = err?.message || '生成失败。';
      if (err?.needPermission) errorText += '（可在设置页点「授权此域名」后重试）';
      render();
    } finally {
      task = null;
    }
  }

  function accept() {
    draft = qs(host, '#as-draft').value;
    if (!draft.trim()) {
      toast('草稿是空的，先写点内容再保存。', { type: 'err' });
      return;
    }
    if (opts.stillValid && !opts.stillValid()) {
      errorText = '题目或答案在生成期间被修改过，请重新核对后再决定是否采用这份草稿。';
      render();
      toast('输入已变化：请重新核对后再保存草稿。', { type: 'err', ms: 6000 });
      return;
    }
    close();
    opts.onAccept?.({ markdown: draft, references: usedReferences, projectOnly });
  }

  render();
  void progress;
  return { close };
}
