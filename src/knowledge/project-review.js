/**
 * 简历项目核对面板：只保存用户选中并修改过的项目，
 * 不自动生成问答、不补写项目事实、不保存原始简历。
 */

import { $, esc, qs, qsa, toast } from './ui.js';

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.intro]
 * @param {Array} opts.projects [{name, summary, responsibilities, sources, selected}]
 * @param {Function} opts.onCommit 返回 send() 的结果
 * @param {Function} [opts.onCancel]
 * @param {Function} [opts.onCommitDone]
 */
export function openProjectReview(opts) {
  const host = $('review-panel');
  if (!host) return null;
  host.hidden = false;
  let projects = (opts.projects || []).map((p) => ({ ...p, selected: p.selected !== false }));

  const close = () => {
    host.hidden = true;
    host.innerHTML = '';
  };

  function cardHTML(p, i) {
    return `<div class="cand${p.selected === false ? ' off' : ''}" data-i="${i}">
      <div class="cand-head">
        <span class="idx">${i + 1}</span>
        <span class="grow hint">${(p.sources || []).map((s) => s.fileName || s.pageTitle || '').filter(Boolean).join('；') || '手工录入'}</span>
        <label class="hint"><input type="checkbox" data-f="selected"${p.selected === false ? '' : ' checked'}> 保存这个项目</label>
        <button class="icon-btn" data-act="del" title="删除这条候选">✕</button>
      </div>
      <div class="field"><label>项目名称（不能为空）</label><input data-f="name" value="${esc(p.name)}" placeholder="例如：校园二手交易平台"></div>
      <div class="field" style="margin-top:9px"><label>项目简介</label><textarea data-f="summary" rows="3" placeholder="项目是做什么的、面向谁、用了哪些技术">${esc(p.summary)}</textarea></div>
      <div class="field" style="margin-top:9px"><label>个人职责</label><textarea data-f="responsibilities" rows="4" placeholder="你在这个项目里具体做了什么">${esc(p.responsibilities)}</textarea></div>
    </div>`;
  }

  function collect() {
    return qsa(host, '.cand').map((card) => {
      const i = Number(card.dataset.i);
      const base = projects[i] || {};
      return {
        ...base,
        name: qs(card, '[data-f="name"]').value.trim(),
        summary: qs(card, '[data-f="summary"]').value,
        responsibilities: qs(card, '[data-f="responsibilities"]').value,
        selected: qs(card, '[data-f="selected"]').checked,
      };
    });
  }

  function updateSummary() {
    const box = qs(host, '#rv-summary');
    if (!box) return;
    const list = collect();
    const active = list.filter((p) => p.selected !== false);
    if (!active.length) {
      box.textContent = '勾选至少一个要保存的项目。';
      return;
    }
    const missing = active.filter((p) => !p.name).length;
    box.textContent = missing ? `有 ${missing} 个项目缺少名称。` : `将保存 ${active.length} 个项目。`;
  }

  function render() {
    host.innerHTML = `<div class="modal-card">
      <div class="m-head">
        <h2>${esc(opts.title || '核对项目')}</h2>
        <span class="chip">项目库</span>
        <button class="icon-btn" data-act="close" title="取消">✕</button>
      </div>
      <div class="m-body">
        <div class="banner banner-info"><span>ℹ️</span><div>
          ${esc(opts.intro || `共 ${projects.length} 个项目候选，只保存你选中的项目。`)}
          <div class="hint">简历原文与图片不会保存，也不会自动生成面试题。</div>
        </div></div>
        ${projects.length ? projects.map(cardHTML).join('') : '<div class="empty-list">没有项目候选。</div>'}
      </div>
      <div class="m-foot">
        <span class="grow hint" id="rv-summary"></span>
        <button class="btn" data-act="close">取消</button>
        <button class="btn btn-primary" data-act="save">保存到项目库</button>
      </div>
    </div>`;

    qsa(host, '[data-act="close"]').forEach((b) =>
      b.addEventListener('click', () => {
        close();
        opts.onCancel?.();
      }),
    );
    qsa(host, '[data-act="del"]').forEach((b) =>
      b.addEventListener('click', () => {
        projects.splice(Number(b.closest('.cand').dataset.i), 1);
        render();
      }),
    );
    qs(host, '[data-act="save"]').addEventListener('click', save);
    qsa(host, '[data-f]').forEach((node) => node.addEventListener('input', updateSummary));
    qsa(host, '[data-f="selected"]').forEach((box) =>
      box.addEventListener('change', () => {
        box.closest('.cand').classList.toggle('off', !box.checked);
        updateSummary();
      }),
    );
    updateSummary();
  }

  async function save() {
    const list = collect();
    const active = list.filter((p) => p.selected !== false);
    if (!active.length) {
      toast('勾选至少一个要保存的项目。', { type: 'err' });
      return;
    }
    if (active.some((p) => !p.name)) {
      toast('项目名称不能为空。', { type: 'err' });
      return;
    }
    const btn = qs(host, '[data-act="save"]');
    btn.disabled = true;
    btn.textContent = '保存中…';
    const res = await opts.onCommit({ projects: active });
    btn.disabled = false;
    btn.textContent = '保存到项目库';
    if (!res || res.ok === false) {
      const box = qs(host, '#rv-summary');
      if (box) box.innerHTML = `<b style="color:#dc2626">保存失败：</b>${esc(res?.error || '未知错误')}。输入已保留。`;
      return;
    }
    close();
    const added = res.result?.counts?.added ?? active.length;
    toast(`已保存 ${added} 个项目`, { type: 'ok' });
    opts.onCommitDone?.(res);
  }

  render();
  return { close, getProjects: () => collect() };
}
