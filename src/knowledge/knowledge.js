import { registerViewState } from '../workbench/view-state.js';
import { installNavigation, navigate } from '../workbench/navigation.js';
installNavigation('knowledge');
import { installQuestionOrder } from './question-order.js';
import { createReview } from './review.js';
/**
 * 面试知识库页面：项目库 + 八股文题库的手工维护界面。
 *
 * 页面只负责展示与编辑；所有写入都通过 background 的知识库路由串行完成（api.js），
 * 因此两个窗口同时编辑同一道题时不会互相覆盖，失败也不会保留"看起来成功"的状态。
 *
 * 分区（design.md §1）：
 *   项目库   左侧项目列表，右侧项目概况与该项目问答；
 *   八股文   左侧分类，中间搜索/标签/题目列表，右侧题目详情与 Markdown 编辑。
 */

import { emptyState } from '../lib/knowledge-store.js';
import { markdownPlainText, renderMarkdown } from '../lib/markdown.js';
import { fmtRelative } from '../lib/util.js';
import { onMessage, openDashboard, openOptions, send, takePendingHandoff } from './api.js';
import { handoffCandidates } from './ingest.js';
import { openAssistPanel } from './assist-panel.js';
import { openProjectReview } from './project-review.js';
import { openReviewPanel } from './review-panel.js';
import { createIo } from './io.js';
import {
  $,
  bindMarkdownField,
  clearBanner,
  debounce,
  esc,
  fmtTime,
  markdownField,
  parseTags,
  qsa,
  qs,
  readSourceEditor,
  setStatus,
  showBanner,
  sourceChips,
  sourceEditor,
  toast,
} from './ui.js';

const app = {
  state: emptyState(),
  settings: { model: '', apiBase: '', hasApiKey: false },
  view: 'projects',
  technicalView: 'browse',
  expanded: new Set(),
  selectedProjectId: '',
  selectedTechnicalId: '',
  projSearch: '',
  pqSearch: '',
  tqSearch: '',
  tqCategoryId: '',
  tqTags: [],
  editor: null, // {kind:'project'|'pq'|'tq', id, mode, draft, revision, dirty}
  newProject: null,
  loading: true,
};

// 阅读偏好独立于知识库数据；折叠不重绘编辑器，也不改变当前选择。
const sidebarKey = 'knowledgeSidebarCollapsed';
let sidebarCollapsed = {};
try {
  const saved = JSON.parse(localStorage.getItem(sidebarKey) || '{}');
  sidebarCollapsed = { projects: saved?.projects === true, technical: saved?.technical === true };
} catch { /* 存储不可用时仍可在当前页面折叠。 */ }
function updateSidebar() {
  const collapsed = sidebarCollapsed[app.view] === true;
  for (const view of ['projects', 'technical']) {
    $(`view-${view}`).classList.toggle('sidebar-collapsed', sidebarCollapsed[view] === true);
  }
  const button = $('btn-sidebar');
  button.hidden = app.view === 'technical' && app.technicalView === 'review';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-controls', app.view === 'projects' ? 'project-sidebar' : 'category-sidebar question-sidebar');
  button.setAttribute('aria-label', collapsed ? '展开左侧栏' : '收起左侧栏');
  button.title = collapsed ? '展开左侧栏' : '收起左侧栏';
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/**
 * 唯一的写入入口。成功时用返回的容器整体替换本地状态；
 * 冲突（其他页面已修改）与失败都只提示，不丢失当前输入。
 */
let localWriteDepth = 0, pendingLibraryRevision = 0;
async function apply(op, payload, { onOk } = {}) {
  localWriteDepth++;
  try {
    const res = await send({ type: 'KNOWLEDGE_APPLY', op, payload });
    if (!res.ok) {
      if (res.code === 'conflict') {
        showBanner('warn', `${esc(res.error)} 你正在编辑的内容已保留，请重新核对后再保存。`);
      } else {
        toast(`保存失败：${res.error || '未知错误'}`, { type: 'err', ms: 6000 });
        showBanner('err', `保存失败：${esc(res.error || '未知错误')}。输入没有丢失，可以直接重试。`);
      }
      return res;
    }
    if (res.state.revision >= app.state.revision) app.state = res.state;
    onOk?.(res);
    render();
    return res;
  } finally {
    localWriteDepth--;
    if (!localWriteDepth) {
      const shouldReload = pendingLibraryRevision > app.state.revision;
      pendingLibraryRevision = 0;
      if (shouldReload) void reload({ silent: true });
    }
  }
}

async function reload({ silent = false } = {}) {
  const res = await send({ type: 'KNOWLEDGE_GET' });
  if (!res.ok) {
    showBanner('err', `读取知识库失败：${esc(res.error || '扩展没有响应')}`);
    return;
  }
  app.state = res.state;
  app.settings = res.settings || app.settings;
  app.loading = false;
  if (!app.selectedProjectId && app.state.projects.length) app.selectedProjectId = app.state.projects[0].id;
  if (app.selectedProjectId && !app.state.projects.some((p) => p.id === app.selectedProjectId)) app.selectedProjectId = '';
  if (app.selectedTechnicalId && !app.state.technicalQuestions.some((q) => q.id === app.selectedTechnicalId)) {
    app.selectedTechnicalId = '';
  }
  render();
  if (!silent) setStatus('');
}

/* ------------------------------------------------------------------ */
/* 数据查询                                                            */
/* ------------------------------------------------------------------ */

const projectQuestions = (projectId) => app.state.projectQuestions.filter((q) => q.projectId === projectId);
const categoryName = (id) => app.state.categories.find((c) => c.id === id)?.name || '未分类';

/** 题目/答案/标签/分类的全文匹配：只用于展示，不改动数据。 */
function matches(query, ...fields) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f ?? '').toLowerCase().includes(q));
}

function filteredProjects() {
  const q = app.projSearch;
  if (!q.trim()) return app.state.projects;
  return app.state.projects.filter(
    (p) =>
      matches(q, p.name, p.summary, p.responsibilities) ||
      projectQuestions(p.id).some((item) => matches(q, item.question, item.answerMarkdown)),
  );
}

function filteredTechnical() {
  return app.state.technicalQuestions.filter((item) => {
    if (app.tqCategoryId === '__none__' && item.categoryId) return false;
    if (app.tqCategoryId && app.tqCategoryId !== '__none__' && item.categoryId !== app.tqCategoryId) return false;
    if (app.tqTags.length && !app.tqTags.every((t) => (item.tags || []).includes(t))) return false;
    return matches(app.tqSearch, item.question, item.answerMarkdown, (item.tags || []).join(' '), categoryName(item.categoryId));
  });
}

function allTags() {
  const set = new Set();
  for (const item of app.state.technicalQuestions) for (const t of item.tags || []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/* ------------------------------------------------------------------ */
/* 通用片段                                                            */
/* ------------------------------------------------------------------ */

function answerHTML(md) {
  const text = String(md ?? '');
  if (!text.trim()) return '<span class="hint">还没有答案，点「编辑」补上（答案允许暂时为空）。</span>';
  return renderMarkdown(text);
}

/** 保存过的 AI 参考：显示 ID/标题/使用时间，并标出参考题已更新或已删除。 */
function aiReferencesHTML(q) {
  const refs = q.aiReferences || [];
  if (!refs.length) return '';
  const rows = refs
    .map((r) => {
      const cur = app.state.technicalQuestions.find((t) => t.id === r.technicalQuestionId);
      const state = !cur
        ? '<span class="bad">参考题已删除，来源不可用</span>'
        : cur.updatedAt !== r.referencedUpdatedAt
          ? '<span class="bad">参考题已被修改</span>'
          : '<span class="hint">可用</span>';
      return `<div class="ref-line">📎 ${esc(cur?.question || r.questionTitle || r.technicalQuestionId)}
        <span class="hint">使用于 ${esc(fmtTime(r.generatedAt))}</span>${state}</div>`;
    })
    .join('');
  return `<div class="sec" style="margin-top:10px"><div class="sec-title"><span>AI 参考来源</span>
    <span class="hint">参考题变化不会自动改写这份答案</span></div>${rows}</div>`;
}

function tagsHTML(tags = []) {
  return tags.length ? tags.map((t) => `<span class="chip-tag">${esc(t)}</span>`).join('') : '<span class="hint">无标签</span>';
}

function sortAttributes(item, library) {
  if (app.editor) return '';
  return `data-sort-id="${esc(item.id)}" data-sort-library="${library}" data-sort-scope="${library === 'project' ? esc(item.projectId) : 'technical'}" data-sort-project="${esc(item.projectId || '')}"`;
}
function sortHandle(item) {
  return app.editor ? '' : `<button class="sort-handle" aria-label="调整题目顺序：${esc(item.question)}" title="拖动调整顺序，也可聚焦后按 ↑ / ↓" type="button"><span aria-hidden="true">⠿</span></button>`;
}
function questionViewHTML(item, { library }) {
  const isProject = library === 'project';
  return `<div class="q-block" data-qid="${esc(item.id)}" ${isProject ? sortAttributes(item, library) : ""}>
    ${isProject ? sortHandle(item) : ""}
    <button class="q-t q-toggle" data-toggle-answer="${esc(item.id)}" aria-expanded="${app.expanded.has(item.id)}" aria-controls="answer-${esc(item.id)}">${esc(item.question)}<span>${app.expanded.has(item.id) ? "收起答案 −" : "展开答案 ＋"}</span></button>
    <div class="md-preview" id="answer-${esc(item.id)}" ${app.expanded.has(item.id)?"":"hidden"}>${answerHTML(item.answerMarkdown)}</div>
    <div class="q-meta">
      ${isProject ? '' : `<span>${esc(categoryName(item.categoryId))}</span>`}
      ${isProject ? '' : tagsHTML(item.tags)}
      <span class="hint">更新于 ${esc(fmtRelative(item.updatedAt))}</span>
      <span style="flex:1"></span>
      ${isProject ? '<button class="btn btn-sm" data-act="assist">AI 参考生成</button>' : ''}
      <button class="btn btn-sm" data-act="edit">编辑</button>
      <button class="btn btn-sm btn-danger" data-act="del">删除</button>
    </div>
    ${isProject ? aiReferencesHTML(item) : ''}
  </div>`;
}

/** 题目编辑器：题目 / Markdown 答案 / 分类标签 / 来源，一次保存。 */
function questionEditorHTML({ library, item, categories }) {
  const draft = app.editor.draft;
  return `<div class="q-block" data-qid="${esc(item?.id || '')}">
    <div class="field"><label>题目（不能为空）</label><textarea data-f="question" rows="2">${esc(draft.question)}</textarea></div>
    <div class="sec" style="margin:10px 0 0">
      <div class="sec-title"><span>答案（Markdown）</span><span class="hint">答案允许留空</span></div>
      ${markdownField({ id: 'ed-answer', value: draft.answerMarkdown, rows: 12, placeholder: '用 Markdown 写答案，支持标题、列表与围栏代码块' })}
    </div>
    ${
      library === 'technical'
        ? `<div class="grid2" style="margin-top:10px">
             <div class="field"><label>分类</label><select data-f="categoryId">
               <option value="">未分类</option>
               ${categories.map((c) => `<option value="${esc(c.id)}"${c.id === draft.categoryId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
             </select></div>
             <div class="field"><label>标签（逗号或空格分隔）</label><input data-f="tags" value="${esc((draft.tags || []).join('、'))}"></div>
           </div>`
        : ''
    }
    <div class="sec" style="margin-top:10px">
      <div class="sec-title"><span>来源</span><span class="hint">未知页码留空；不保存原始文件与图片</span></div>
      <div style="margin-bottom:6px">${sourceChips(draft.sources || [])}</div>
      <details><summary class="hint" style="cursor:pointer">修改来源（填写后会替换现有来源）</summary>
        ${sourceEditor({ id: 'ed-source', source: (draft.sources || [])[0] || null })}</details>
    </div>
    <div class="q-meta">
      <button class="btn btn-sm btn-primary" data-act="save">保存</button>
      <button class="btn btn-sm" data-act="cancel">取消</button>
      <span class="hint" id="ed-hint"></span>
    </div>
  </div>`;
}

function emptyBlock(text) {
  return `<div class="empty-list">${esc(text)}</div>`;
}

/**
 * 绑定题目/项目编辑器里的 Markdown 预览与"已修改"标记。
 * 标记用于告诉用户"输入已保留"：其他页面写入时不清空正在编辑的内容。
 */
function wireEditor(pane) {
  if (!app.editor) return;
  bindMarkdownField(pane, 'ed-answer');
  qsa(pane, '[data-f], #ed-answer').forEach((node) =>
    node.addEventListener('input', () => {
      if (app.editor) {
        app.editor.dirty = true;
        document.documentElement.dataset.workbenchDirty = 'true';
        if (node.id === 'ed-answer') app.editor.draft.answerMarkdown = node.value;
        else if (node.dataset.f) app.editor.draft[node.dataset.f] = node.dataset.f === 'tags' ? parseTags(node.value) : node.value;
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 项目库                                                              */
/* ------------------------------------------------------------------ */

function renderProjects() {
  const list = filteredProjects();
  const host = $('proj-list');
  host.innerHTML = list.length
    ? list
        .map(
          (p) => `<div class="row${p.id === app.selectedProjectId ? ' active' : ''}" data-pid="${esc(p.id)}">
            <div class="grow">
              <div class="t">${esc(p.name)}</div>
              <div class="s">${projectQuestions(p.id).length} 道问答 · ${esc(markdownPlainText(p.summary, 40) || '暂无简介')}</div>
            </div>
          </div>`,
        )
        .join('')
    : emptyBlock(app.projSearch ? '没有匹配的项目。' : '还没有项目，点「＋ 新建项目」开始。');
  qsa(host, '.row').forEach((row) =>
    row.addEventListener('click', () => {
      if (!leaveEditor()) return;
      if (app.selectedProjectId !== row.dataset.pid) app.expanded.clear();
      app.selectedProjectId = row.dataset.pid;
      app.editor = null;
      render();
    }),
  );

  const pane = $('proj-detail');
  const project = app.state.projects.find((p) => p.id === app.selectedProjectId);
  if (app.newProject) {
    pane.innerHTML = `<div class="d-head"><h2>新建项目</h2><span class="chip">无需关联岗位</span></div>
      <div class="pane-body">
        <div class="field"><label>项目名称</label><input id="np-name" placeholder="例如：校园二手交易平台"></div>
        <div class="field" style="margin-top:10px"><label>项目简介</label><textarea id="np-summary" rows="4" placeholder="项目是做什么的、面向谁、用了哪些技术"></textarea></div>
        <div class="field" style="margin-top:10px"><label>个人职责</label><textarea id="np-resp" rows="5" placeholder="你在这个项目里具体做了什么"></textarea></div>
        <div class="q-meta"><button class="btn btn-primary" id="np-save">创建项目</button>
        <button class="btn" id="np-cancel">取消</button><span class="hint" id="np-hint"></span></div>
      </div>`;
    $('np-save').addEventListener('click', async () => {
      const name = $('np-name').value.trim();
      if (!name) {
        $('np-hint').textContent = '项目名称不能为空。';
        return;
      }
      const summary = $('np-summary').value;
      const responsibilities = $('np-resp').value;
      const res = await apply('project.create', { name, summary, responsibilities });
      if (res.ok) {
        app.newProject = null;
        app.selectedProjectId = res.result.project.id;
        toast('项目已创建，可以开始添加面试问答', { type: 'ok' });
        render();
      }
    });
    $('np-cancel').addEventListener('click', () => {
      app.newProject = null;
      render();
    });
    return;
  }
  if (!project) {
    pane.innerHTML = `<div class="empty-pane">${app.state.projects.length ? '左侧选择或新建一个项目。<br>项目不需要关联任何岗位记录。' : '还没有项目。<br>可以「新建项目」，也可以上传 PDF／DOCX 简历自动提取项目后核对保存。'}</div>`;
    return;
  }

  const editing = app.editor?.kind === 'project' && app.editor.id === project.id;
  const questions = projectQuestions(project.id).filter((q) => matches(app.pqSearch, q.question, q.answerMarkdown));
  const searchable = projectQuestions(project.id).length > 0;
  pane.innerHTML = `<div class="d-head">
      <h2>${esc(project.name)}</h2>
      <span class="chip">${projectQuestions(project.id).length} 道问答</span>
      ${editing ? '' : '<button class="btn btn-sm" data-act="edit-project">编辑概况</button>'}
      <button class="btn btn-sm btn-danger" data-act="del-project">删除项目</button>
    </div>
    <div class="pane-body">
      ${
        editing
          ? `<div class="field"><label>项目名称</label><input data-f="name" value="${esc(app.editor.draft.name)}"></div>
             <div class="field" style="margin-top:9px"><label>项目简介</label><textarea data-f="summary" rows="4">${esc(app.editor.draft.summary)}</textarea></div>
             <div class="field" style="margin-top:9px"><label>个人职责</label><textarea data-f="responsibilities" rows="5">${esc(app.editor.draft.responsibilities)}</textarea></div>
             <div class="sec" style="margin-top:10px">
               <div class="sec-title"><span>来源</span></div>
               <div style="margin-bottom:6px">${sourceChips(app.editor.draft.sources || [])}</div>
               <details><summary class="hint" style="cursor:pointer">修改来源</summary>${sourceEditor({ id: 'ed-source', source: (app.editor.draft.sources || [])[0] || null })}</details>
             </div>
             <div class="q-meta"><button class="btn btn-primary" data-act="save-project">保存修改</button>
               <button class="btn" data-act="cancel-project">取消</button><span class="hint" id="ed-hint"></span></div>`
          : `<div class="sec"><div class="sec-title"><span>项目简介</span></div>
               <div class="md-preview">${project.summary ? renderMarkdown(project.summary) : '<span class="hint">还没写简介，点「编辑概况」补充。</span>'}</div></div>
             <div class="sec"><div class="sec-title"><span>个人职责</span></div>
               <div class="md-preview">${project.responsibilities ? renderMarkdown(project.responsibilities) : '<span class="hint">还没写职责。</span>'}</div></div>
             <div class="sec"><div class="sec-title"><span>来源</span></div>${sourceChips(project.sources || [])}</div>`
      }
      <div class="sec">
        <div class="sec-title"><span>项目问答</span><button data-bulk="expand">全部展开</button><button data-bulk="collapse">全部折叠</button><span class="grow"></span>
          ${searchable ? '<input id="pq-search" type="search" style="width:180px;padding:5px 8px;border:1px solid #e6ecf4;border-radius:8px" placeholder="搜索题目或答案" value="' + esc(app.pqSearch) + '">' : ''}
          <button class="btn btn-sm" data-act="add-pq">＋ 新增问答</button></div>
        <div class="hint" style="margin:-2px 0 8px">项目问答只在同一个项目内比对重复；和八股文题库互不影响。</div>
        ${
          questions.length
            ? questions
                .map((item) =>
                  app.editor?.kind === 'pq' && app.editor.id === item.id
                    ? questionEditorHTML({ library: 'project', item, categories: [] })
                    : questionViewHTML(item, { library: 'project' }),
                )
                .join('')
            : emptyBlock(searchable && app.pqSearch ? '没有匹配的问答。' : '还没有问答。点「＋ 新增问答」记录面试追问。')
        }
      </div>
    </div>`;

  bindProjectPane(project);
}

function bindProjectPane(project) {
  const pane = $('proj-detail');
  $('pq-search')?.addEventListener(
    'input',
    debounce((e) => {
      app.pqSearch = e.target.value;
      render();
    }, 180),
  );
  qs(pane, '[data-act="edit-project"]')?.addEventListener('click', () => {
    app.editor = {
      kind: 'project',
      id: project.id,
      mode: 'edit',
      revision: project.revision,
      draft: { name: project.name, summary: project.summary, responsibilities: project.responsibilities, sources: project.sources || [] },
      dirty: false,
    };
    render();
  });
  qs(pane, '[data-act="cancel-project"]')?.addEventListener('click', () => {
    app.editor = null;
    render();
  });
  qs(pane, '[data-act="save-project"]')?.addEventListener('click', async () => {
    const draft = app.editor.draft;
    const src = readSourceEditor(pane, 'ed-source');
    const sources = src && (src.url || src.fileName || src.pageTitle || src.pageNumbers.length) ? [src] : draft.sources;
    await apply('project.update', {
      id: project.id,
      name: qs(pane, '[data-f="name"]').value.trim(),
      summary: qs(pane, '[data-f="summary"]').value,
      responsibilities: qs(pane, '[data-f="responsibilities"]').value,
      sources,
      revision: app.editor.revision,
    }, {
      onOk: () => {
        app.editor = null;
        toast('项目已保存', { type: 'ok' });
      },
    });
  });
  qs(pane, '[data-act="del-project"]')?.addEventListener('click', async () => {
    const n = projectQuestions(project.id).length;
    const ok = window.confirm(
      n ? `删除项目「${project.name}」会同时删除它的 ${n} 道问答，其他项目、八股文与岗位记录不受影响。确定删除？` : `确定删除项目「${project.name}」？`,
    );
    if (!ok) return;
    const res = await apply('project.delete', { id: project.id, revision: project.revision });
    if (res.ok) {
      app.selectedProjectId = '';
      toast('项目已删除', { type: 'ok' });
      render();
    }
  });
  qs(pane, '[data-act="add-pq"]')?.addEventListener('click', () => {
    if (!leaveEditor()) return;
    openReviewPanel({
      title: `新增项目问答 · ${project.name}`,
      intro: '填写题目与答案（答案可以留空）。如果项目里已有相同题目，会先让你决定保留哪一份。',
      library: 'project',
      projectId: project.id,
      candidates: [{ question: '', answerMarkdown: '', sources: [{ type: 'manual', importedAt: Date.now() }] }],
      existing: projectQuestions(project.id),
      onCommit: (plan) => apply('candidates.commit', plan),
      onCommitDone: () => reload({ silent: true }),
    });
  });
  bindQuestionActions(pane, 'project');
  wireEditor(pane);
}

/* ------------------------------------------------------------------ */
/* 八股文题库                                                          */
/* ------------------------------------------------------------------ */

function renderTechnical() {
  const catHost = $('cat-list');
  const uncategorized = app.state.technicalQuestions.filter((q) => !q.categoryId).length;
  const rows = [
    `<div class="row${app.tqCategoryId === '' ? ' active' : ''}" data-cat=""><div class="grow"><div class="t">全部题目</div>
      <div class="s">${app.state.technicalQuestions.length} 题</div></div></div>`,
    `<div class="row${app.tqCategoryId === '__none__' ? ' active' : ''}" data-cat="__none__"><div class="grow"><div class="t">未分类</div>
      <div class="s">${uncategorized} 题</div></div></div>`,
  ];
  for (const c of app.state.categories) {
    const n = app.state.technicalQuestions.filter((q) => q.categoryId === c.id).length;
    rows.push(`<div class="row${app.tqCategoryId === c.id ? ' active' : ''}" data-cat="${esc(c.id)}">
      <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${n} 题</div></div>
      <button class="x" data-act="rename-cat" title="改名">✎</button>
      <button class="x" data-act="del-cat" title="删除分类">✕</button>
    </div>`);
  }
  catHost.innerHTML = rows.join('');
  qsa(catHost, '.row').forEach((row) =>
    row.addEventListener('click', (e) => {
      if (e.target.dataset.act) return;
      app.tqCategoryId = row.dataset.cat;
      render();
    }),
  );
  qsa(catHost, '[data-act="rename-cat"]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.closest('.row').dataset.cat;
      const cur = app.state.categories.find((c) => c.id === id);
      const name = window.prompt('分类名称', cur?.name || '');
      if (!name || name === cur?.name) return;
      await apply('category.rename', { id, name });
    }),
  );
  qsa(catHost, '[data-act="del-cat"]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = b.closest('.row').dataset.cat;
      const cur = app.state.categories.find((c) => c.id === id);
      const n = app.state.technicalQuestions.filter((q) => q.categoryId === id).length;
      if (!window.confirm(n ? `删除分类「${cur?.name}」会把它的 ${n} 道题移到未分类，题目本身不会删除。继续？` : `删除分类「${cur?.name}」？`)) return;
      const res = await apply('category.delete', { id });
      if (res.ok) toast(`分类已删除${n ? `，${n} 道题已移到未分类` : ''}`, { type: 'ok' });
    }),
  );

  const catSelect = $('tq-filter-cat');
  catSelect.innerHTML = `<option value="">全部分类</option><option value="__none__">未分类</option>${app.state.categories
    .map((c) => `<option value="${esc(c.id)}"${c.id === app.tqCategoryId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('')}`;
  catSelect.value = app.tqCategoryId;

  const tags = allTags();
  $('tq-filter-tags').innerHTML = tags
    .map((t) => `<button class="chip-tag pick${app.tqTags.includes(t) ? ' on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join('');
  qsa($('tq-filter-tags'), '[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.tag;
      app.tqTags = app.tqTags.includes(t) ? app.tqTags.filter((x) => x !== t) : [...app.tqTags, t];
      render();
    }),
  );

  const list = filteredTechnical();
  $('tq-count').textContent = `显示 ${list.length} / ${app.state.technicalQuestions.length} 题`;
  const listHost = $('tq-list');
  listHost.innerHTML = list.length
    ? list
        .map(
          (item) => `<div class="row${item.id === app.selectedTechnicalId ? ' active' : ''}" data-tid="${esc(item.id)}" ${sortAttributes(item, 'technical')}>${sortHandle(item)}
            <div class="grow">
              <div class="t">${esc(item.question)}</div>
              <div class="s">${esc(categoryName(item.categoryId))}${(item.tags || []).length ? ` · ${esc(item.tags.join('、'))}` : ''}${String(item.answerMarkdown || '').trim() ? '' : ' · 暂无答案'}</div>
            </div>
          </div>`,
        )
        .join('')
    : emptyBlock(app.state.technicalQuestions.length ? '没有匹配的题目。' : '题库还是空的，点「＋ 新增问答」或导入文件开始整理。');
  qsa(listHost, '.row').forEach((row) =>
    row.addEventListener('click', () => {
      if (!leaveEditor()) return;
      app.selectedTechnicalId = row.dataset.tid;
      app.editor = null;
      render();
    }),
  );

  const pane = $('tq-detail');
  const item = app.state.technicalQuestions.find((q) => q.id === app.selectedTechnicalId);
  if (!item) {
    pane.innerHTML = `<div class="empty-pane">${
      app.tqSearch || app.tqCategoryId || app.tqTags.length
        ? `当前筛选没有结果。<br>可以清除筛选后查看全部 ${app.state.technicalQuestions.length} 道题。`
        : '左侧选择一道题查看答案，或点「新增问答」。'
    }</div>`;
    return;
  }
  pane.innerHTML = `<div class="d-head"><h2>题目详情</h2><button class="btn btn-sm" data-bulk="expand">全部展开</button><button class="btn btn-sm" data-bulk="collapse">全部折叠</button>
      <span class="chip">${esc(categoryName(item.categoryId))}</span>
      ${String(item.answerMarkdown || '').trim() ? '' : '<span class="chip">暂无答案</span>'}
    </div>
    <div class="pane-body">${
      app.editor?.kind === 'tq' && app.editor.id === item.id
        ? questionEditorHTML({ library: 'technical', item, categories: app.state.categories })
        : questionViewHTML(item, {library:'technical'}) + `<div class="sec"><div class="sec-title">来源</div>${sourceChips(item.sources || [])}</div><div class="sec">${referencingProjects(item.id)}</div>`
    }</div>`;
  bindQuestionActions(pane, 'technical');
  wireEditor(pane);
}

function referencingProjects(technicalId) {
  const rows = [];
  for (const q of app.state.projectQuestions) {
    if ((q.aiReferences || []).some((r) => r.technicalQuestionId === technicalId)) {
      const p = app.state.projects.find((x) => x.id === q.projectId);
      rows.push(`<div class="ref-line">📎 ${esc(p?.name || '未知项目')} · ${esc(q.question)}</div>`);
    }
  }
  return rows.join('');
}

/* ------------------------------------------------------------------ */
/* 题目操作                                                            */
/* ------------------------------------------------------------------ */

function bindQuestionActions(pane, library) {
  const findItem = (id) =>
    library === 'project'
      ? app.state.projectQuestions.find((q) => q.id === id)
      : app.state.technicalQuestions.find((q) => q.id === id);
  /**
   * 取题目 id：优先用所在题目块的 data-qid；题目详情页的按钮不在块内，
   * 这时回落到当前选中的题目，避免按钮点了没反应。
   */
  const idAt = (node) => node.closest('[data-qid]')?.dataset.qid || (library === 'technical' ? app.selectedTechnicalId : '');

  qsa(pane, '[data-act="edit"]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = findItem(idAt(b));
      if (!item) return;
      app.editor = {
        kind: library === 'project' ? 'pq' : 'tq',
        id: item.id,
        mode: 'edit',
        revision: item.revision,
        draft: {
          question: item.question,
          answerMarkdown: item.answerMarkdown || '',
          tags: item.tags || [],
          categoryId: item.categoryId || '',
          sources: item.sources || [],
        },
        dirty: false,
      };
      render();
    }),
  );

  qsa(pane, '[data-act="del"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const item = findItem(idAt(b));
      if (!item) return;
      const refs = library === 'technical' ? referencingProjects(item.id) : '';
      const warn = refs
        ? '\n\n已有项目答案把它作为 AI 参考：删除后这些答案会保留，参考项会标记为不可用。'
        : '';
      if (!window.confirm(`确定删除「${item.question}」？${warn}`)) return;
      const op = library === 'project' ? 'projectQuestion.delete' : 'technicalQuestion.delete';
      const res = await apply(op, { id: item.id, revision: item.revision });
      if (res.ok) {
        if (app.selectedTechnicalId === item.id) app.selectedTechnicalId = '';
        toast('已删除', { type: 'ok' });
        render();
      }
    }),
  );

  qsa(pane, '[data-act="cancel"]').forEach((b) =>
    b.addEventListener('click', () => {
      app.editor = null;
      render();
    }),
  );

  qsa(pane, '[data-act="save"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const block = b.closest('[data-qid]');
      const id = block?.dataset.qid || app.editor?.id || '';
      if (!id) return;
      const question = qs(block || pane, '[data-f="question"]').value.trim();
      const hint = qs(block || pane, '#ed-hint');
      if (!question) {
        hint.textContent = '题目不能为空。';
        return;
      }
      const scope = block || pane;
      const src = readSourceEditor(pane, 'ed-source');
      const sources = src && (src.url || src.fileName || src.pageTitle || src.pageNumbers.length) ? [src] : app.editor.draft.sources;
      const payload = {
        id,
        question,
        answerMarkdown: qs(scope, '#ed-answer').value,
        sources,
        revision: app.editor.revision,
      };
      if (library === 'technical') {
        payload.tags = parseTags(qs(scope, '[data-f="tags"]').value);
        payload.categoryId = qs(scope, '[data-f="categoryId"]').value;
      }
      b.disabled = true;
      const op = library === 'project' ? 'projectQuestion.update' : 'technicalQuestion.update';
      const res = await apply(op, payload, {
        onOk: () => {
          app.editor = null;
          if (library === 'technical' && payload.answerMarkdown.trim()) app.selectedTechnicalId = id;
          toast('已保存', { type: 'ok' });
        },
      });
      b.disabled = false;
      if (!res.ok && hint) hint.textContent = res.error || '保存失败，输入已保留。';
    }),
  );

  qsa(pane, '[data-act="assist"]').forEach((b) =>
    b.addEventListener('click', () => {
      const item = findItem(idAt(b));
      const project = app.state.projects.find((p) => p.id === item?.projectId);
      if (!item || !project) return;
      openAssistPanel({
        project,
        question: item.question,
        currentAnswer: item.answerMarkdown || '',
        entityRevision: item.revision,
        questions: app.state.technicalQuestions,
        categories: app.state.categories,
        hasApiKey: Boolean(app.settings.hasApiKey),
        stillValid: () => {
          const cur = app.state.projectQuestions.find((q) => q.id === item.id);
          return Boolean(cur) && cur.revision === item.revision;
        },
        onNeedSetup: openOptions,
        onAccept: async ({ markdown, references }) => {
          const cur = app.state.projectQuestions.find((q) => q.id === item.id);
          if (!cur) {
            toast('题目已被删除，草稿没有保存。', { type: 'err' });
            return;
          }
          const res = await apply('projectQuestion.update', {
            id: cur.id,
            answerMarkdown: markdown,
            aiReferences: references.map((r) => ({
              technicalQuestionId: r.technicalQuestionId,
              questionTitle: r.questionTitle,
              referencedUpdatedAt: r.referencedUpdatedAt,
              generatedAt: Date.now(),
            })),
            revision: cur.revision,
          });
          if (res.ok) toast('已采用 AI 草稿，成为这道题的唯一答案', { type: 'ok' });
        },
      });
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 导入 / 备份                                                         */
/* ------------------------------------------------------------------ */

/** 打开八股文候选核对面板（文件导入、图片、网页框选共用）。 */
function reviewTechnicalCandidates(candidates, { title, intro, onDone }) {
  if (!candidates.length) {
    showBanner('warn', '没有识别到可保存的题目，可以换一张更清晰的图片或手动录入。');
    return;
  }
  openReviewPanel({
    title,
    intro,
    library: 'technical',
    candidates,
    existing: app.state.technicalQuestions,
    categories: app.state.categories,
    onCreateCategory: async (name) => {
      const res = await apply('category.create', { name });
      return res.ok ? res.result.category : null;
    },
    onCommit: (plan) => apply('candidates.commit', plan),
    onCommitDone: async () => {
      await reload({ silent: true });
      onDone?.();
    },
  });
}

const io = createIo({
  getState: () => app.state,
  getSettings: () => app.settings,
  reload: () => reload({ silent: true }),
  reviewTechnicalCandidates,
  openProjectReview,
  afterProjectsSaved: () => reload({ silent: true }),
});

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function leaveEditor() {
  if (app.editor?.dirty && !window.confirm('当前修改尚未保存，确定放弃并离开？')) return false;
  app.editor = null; return true;
}
const reviewView = createReview({host:$('view-review'),getState:()=>app.state,setState:(s)=>{if(s.revision>=app.state.revision)app.state=s;},reload:()=>reload({silent:true})});
function updateFloating() {
  const b=$('floating-new'); const hidden=app.loading || app.technicalView==='review' && app.view==='technical' || !!app.editor || !!app.newProject || [...document.querySelectorAll('.modal')].some(m=>!m.hidden);
  if(b.hidden!==hidden)b.hidden=hidden;
  b.disabled=app.view==='projects' && !app.selectedProjectId; b.title=b.disabled?'先选择或新建项目':'新建问答';
}
// Keep position only within the same detail. Explicit library/item navigation starts fresh.
let renderedPositionContext = null, positionRenderVersion = 0;
function preserveRenderPosition() {
  const library = app.view === 'projects' ? 'projects' : app.technicalView === 'review' ? 'review' : 'technical';
  const detail = library === 'projects' ? `${app.selectedProjectId}:${Boolean(app.newProject)}` : app.selectedTechnicalId;
  const previous = renderedPositionContext;
  renderedPositionContext = { library, detail };
  const version = ++positionRenderVersion;
  if (!previous || previous.library !== library || library === 'review') return () => {};
  const sameDetail = previous.detail === detail;
  const selectors = library === 'projects' ? ['#proj-list'] : ['#cat-list', '#tq-list'];
  if (sameDetail) selectors.push(library === 'projects' ? '#proj-detail .pane-body' : '#tq-detail .pane-body');
  const points = selectors.map(selector => {
    const node = document.querySelector(selector);
    return node ? { selector, top: node.scrollTop, left: node.scrollLeft } : null;
  }).filter(Boolean);
  const page = { x: scrollX, y: scrollY };
  const active = document.activeElement;
  const editing = sameDetail && active?.id && /^(INPUT|TEXTAREA)$/.test(active.tagName)
    ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd, top: active.scrollTop, left: active.scrollLeft } : null;
  return () => {
    const restore = () => {
      if (version !== positionRenderVersion) return;
      for (const point of points) {
        const node = document.querySelector(point.selector);
        if (node) { node.scrollTop = point.top; node.scrollLeft = point.left; }
      }
      if (sameDetail) window.scrollTo(page.x, page.y);
    };
    if (editing) {
      const node = document.getElementById(editing.id);
      if (node && node.value === editing.value) {
        node.focus({ preventScroll: true });
        if (typeof editing.start === 'number') node.setSelectionRange(editing.start, editing.end);
        node.scrollTop = editing.top; node.scrollLeft = editing.left;
      }
    }
    restore();
    requestAnimationFrame(restore);
  };
}
function render() {
  document.documentElement.dataset.workbenchDirty = String(Boolean(app.editor?.dirty));
  const restorePosition = preserveRenderPosition();
  $('pill-projects').textContent = String(app.state.projects.length);
  $('pill-technical').textContent = String(app.state.technicalQuestions.length);
  $('brand-sub').textContent = app.loading
    ? '正在读取本地知识库…'
    : `${app.state.projects.length} 个项目 · ${app.state.technicalQuestions.length} 道八股文 · 保存在当前浏览器`;
  qsa($('tabs'), 'button').forEach((b) => b.classList.toggle('active', b.dataset.view === app.view));
  $('view-projects').hidden = app.view !== 'projects';
  $('knowledge-subnav').hidden = app.view !== 'technical';
  const reviewing = app.view === 'technical' && app.technicalView === 'review';
  $('view-review').hidden = !reviewing;
  $('view-technical').hidden = app.view !== 'technical' || reviewing;
  updateSidebar();
  $('bank-browse').classList.toggle('btn-primary', !reviewing);
  $('bank-review').classList.toggle('btn-primary', reviewing);
  if (app.view === 'projects') renderProjects();
  else if (reviewing) reviewView.render();
  else renderTechnical();
  updateFloating();
  restorePosition();
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

$('btn-sidebar').addEventListener('click', () => {
  sidebarCollapsed[app.view] = !sidebarCollapsed[app.view];
  try { localStorage.setItem(sidebarKey, JSON.stringify(sidebarCollapsed)); } catch { /* 当前页面仍生效。 */ }
  updateSidebar();
});

qsa($('tabs'), 'button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!leaveEditor()) return;
    if (app.view !== b.dataset.view) app.expanded.clear();
    reviewView.clear();
    app.view = b.dataset.view;
    clearBanner();
    render();
  }),
);
$('proj-search').addEventListener(
  'input',
  debounce((e) => {
    app.projSearch = e.target.value;
    render();
  }, 180),
);
$('tq-search').addEventListener(
  'input',
  debounce((e) => {
    app.tqSearch = e.target.value;
    render();
  }, 180),
);
$('tq-filter-cat').addEventListener('change', (e) => {
  app.tqCategoryId = e.target.value;
  render();
});
$('proj-new').addEventListener('click', () => {
  if (!leaveEditor()) return;
  app.newProject = true;
  app.view = 'projects';
  render();
});
$('proj-resume').addEventListener('click', () => $('file-resume').click());
$('cat-new').addEventListener('click', async () => {
  const name = window.prompt('新分类名称，例如：数据库 / 计算机网络');
  if (!name) return;
  await apply('category.create', { name });
});
$('tq-add').addEventListener('click', () => {
  if (!leaveEditor()) return;
  reviewTechnicalCandidates([{ question: '', answerMarkdown: '', categoryId: app.tqCategoryId === '__none__' ? '' : app.tqCategoryId, sources: [{ type: 'manual', importedAt: Date.now() }] }], {
    title: '新增八股文问答',
    intro: '填写题目与答案。如果题库里已有相同题目，会先让你决定保留哪一份，绝不会自动覆盖。',
  });
});
$('btn-new').addEventListener('click', () => {
  if (app.view === 'technical') $('tq-add').click();
  else $('proj-new').click();
});
$('floating-new').addEventListener('click',()=>{if(!leaveEditor())return;if(app.view==='technical')$('tq-add').click();else document.querySelector('#proj-detail [data-act="add-pq"]')?.click();});
$('bank-review').addEventListener('click',()=>{if(!leaveEditor())return;app.technicalView='review';render();});
$('bank-browse').addEventListener('click',()=>{reviewView.clear();app.technicalView='browse';render();});
installQuestionOrder({root:document.querySelector('main'),getRevision:()=>app.state.revision,move:(payload)=>apply('questions.move',payload),onError:(message)=>toast(message,{type:'err'})});
new MutationObserver(updateFloating).observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden'],childList:true});
document.addEventListener('click',(e)=>{
 const toggle=e.target.closest('[data-toggle-answer]');
 if(toggle){const id=toggle.dataset.toggleAnswer;app.expanded.has(id)?app.expanded.delete(id):app.expanded.add(id);const answer=document.getElementById(`answer-${id}`);answer.hidden=!app.expanded.has(id);toggle.setAttribute('aria-expanded',String(app.expanded.has(id)));toggle.querySelector('span').textContent=app.expanded.has(id)?'收起答案 −':'展开答案 ＋';}
 const bulk=e.target.closest('[data-bulk]');if(bulk){const list=app.view==='projects'?projectQuestions(app.selectedProjectId).filter(q=>matches(app.pqSearch,q.question,q.answerMarkdown)):filteredTechnical();for(const q of list)bulk.dataset.bulk==='expand'?app.expanded.add(q.id):app.expanded.delete(q.id);render();}
});
$('btn-options').addEventListener('click', () => navigate('options'));
$('btn-dashboard').addEventListener('click', () => navigate('dashboard'));
$('btn-add-image').addEventListener('click', () => $('file-image').click());
$('btn-add-file').addEventListener('click', () => $('file-doc').click());
$('btn-backup').addEventListener('click', () => {
  const menu = $('backup-menu');
  menu.hidden = !menu.hidden;
});
qsa($('backup-menu'), '[data-io]').forEach((b) =>
  b.addEventListener('click', () => {
    $('backup-menu').hidden = true;
    io.run(b.dataset.io);
  }),
);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) $('backup-menu').hidden = true;
});

$('file-image').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await io.importImages(files, 'image-upload');
});
$('file-doc').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await io.importDocuments(files);
});
$('file-resume').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await io.importResume(file);
});
$('file-restore').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await io.restoreFromFile(file);
});

/** 用户主动粘贴题目截图（剪贴板里没有图片时给出可读提示）。 */
document.addEventListener('paste', async (e) => {
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const items = [...(e.clipboardData?.items || [])];
  const images = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (!images.length) {
    if (e.clipboardData?.getData('text')) return; // 正常粘贴文字，不打扰
    toast('剪贴板里没有图片。可以先用系统截图工具截图，再回到本页粘贴。', { type: 'err', ms: 5000 });
    return;
  }
  e.preventDefault();
  await io.importImages(images, 'image-paste');
});

window.addEventListener('beforeunload', (e) => {
  if (!app.editor?.dirty || window.parent.__JDT_MODE_TRANSFERRING__) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ------------------------------------------------------------------ */
/* 跨页面同步与网页框选交接                                            */
/* ------------------------------------------------------------------ */

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.knowledgeLibrary) return;
  const incoming = changes.knowledgeLibrary.newValue;
  const incomingRevision = Math.floor(Number(incoming?.revision)) || 0;
  // 自己写入触发的回声：状态已经是新的了，不用重绘
  if (incomingRevision <= (Math.floor(Number(app.state.revision)) || 0)) return;
  if (localWriteDepth) {
    pendingLibraryRevision = Math.max(pendingLibraryRevision, incomingRevision);
    return;
  }
  const wasEditing = Boolean(app.editor);
  await reload({ silent: true });
  if (wasEditing) {
    showBanner(
      'warn',
      '其他页面更新了知识库。你正在编辑的内容已保留，请重新核对后再保存（保存时会提示冲突）。',
    );
  }
});

onMessage((msg) => {
  if (msg.type === 'JDT_KNOWLEDGE_PENDING') void takeHandoff();
});

/** 网页框选识别完成后交接过来的候选：打开核对面板。 */
async function takeHandoff() {
  const handoff = await takePendingHandoff();
  if (!handoff?.candidates?.length) return;
  app.view = 'technical';
  render();
  const origin = handoff.origin?.pageTitle || handoff.origin?.url || '网页';
  reviewTechnicalCandidates(handoffCandidates(handoff), {
    title: '核对网页框选提取的题目',
    intro: `从 ${origin} 框选识别出 ${handoff.candidates.length} 道候选。网页截图不会保存。`,
  });
}

await reload();
await takeHandoff();
setStatus('');

registerViewState(() => {
  const keys=['view','technicalView','selectedProjectId','selectedTechnicalId','projSearch','pqSearch','tqSearch','tqCategoryId','tqTags','editor','newProject'];
  const result=Object.fromEntries(keys.map(key=>[key,structuredClone(app[key])]));
  result.expanded=[...app.expanded];
  result.review=$('review-panel').hidden?null:$('review-panel').__JDT_REVIEW_SNAPSHOT__?.();
  if(!$('review-panel').hidden&&!result.review)throw new Error('请先完成当前简历核对，再切换显示模式。');
  return result;
}, async saved => {
  if(!saved)return;
  const {expanded,review,...rest}=saved;Object.assign(app,rest);app.expanded=new Set(expanded||[]);
  $('proj-search').value=app.projSearch;$('tq-search').value=app.tqSearch;render();
  if(review)openReviewPanel({...review,
    existing:review.library==='project'?projectQuestions(review.projectId):app.state.technicalQuestions,
    categories:app.state.categories,
    onCreateCategory:async name=>{const res=await apply('category.create',{name});return res.ok?res.result.category:null;},
    onCommit:plan=>apply('candidates.commit',plan),onCommitDone:()=>reload({silent:true})});
});
