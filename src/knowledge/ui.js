import { bindEditorTools } from './markdown-editor.js';
/**
 * 知识库页面的共享 UI 小件：转义、toast、状态条、Markdown 编辑/预览组件、来源展示。
 * 面板与主页面都从这里取，保证两处交互一致（design.md §1「共享编辑与核对组件」）。
 */

import { renderMarkdown } from '../lib/markdown.js';
import { describeSource } from '../lib/knowledge-store.js';

export const $ = (id) => document.getElementById(id);
export const qs = (root, sel) => root?.querySelector(sel);
export const qsa = (root, sel) => Array.from(root?.querySelectorAll(sel) || []);

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Toast 与状态条                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {string} message
 * @param {{type?: 'info'|'ok'|'err', actions?: Array<{label:string,onClick:Function}>, ms?: number}} opts
 */
export function toast(message, { type = 'info', actions = [], ms = 4200 } = {}) {
  const wrap = $('toasts');
  if (!wrap) return;
  const node = document.createElement('div');
  node.className = `toast${type === 'err' ? ' err' : type === 'ok' ? ' ok' : ''}`;
  node.innerHTML = `<span>${esc(message)}</span>`;
  for (const a of actions) {
    const link = document.createElement('a');
    link.textContent = a.label;
    link.addEventListener('click', () => {
      node.remove();
      a.onClick?.();
    });
    node.appendChild(link);
  }
  wrap.appendChild(node);
  if (ms > 0) setTimeout(() => node.remove(), ms);
  return node;
}

/** 顶部状态条：保存失败、冲突与提示都走这里，避免只靠一闪而过的 toast。 */
export function showBanner(kind, html, { actions = [] } = {}) {
  const host = $('banner');
  if (!host) return;
  host.hidden = false;
  const cls = { info: 'banner-info', warn: 'banner-warn', err: 'banner-err', ok: 'banner-ok' }[kind] || 'banner-info';
  host.innerHTML = `<div class="banner ${cls}"><span>${kind === 'err' ? '⚠️' : kind === 'ok' ? '✓' : 'ℹ️'}</span>
    <div class="grow">${html}</div>
    <button class="x" title="关闭">✕</button></div>`;
  qs(host, '.x').addEventListener('click', clearBanner);
  actions.forEach((a, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    qs(host, '.grow').appendChild(document.createTextNode(' '));
    qs(host, '.grow').appendChild(btn);
    void i;
  });
}

export function clearBanner() {
  const host = $('banner');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
}

export function setStatus(text) {
  const node = $('io-status');
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
}

/* ------------------------------------------------------------------ */
/* Markdown 编辑 / 预览                                                */
/* ------------------------------------------------------------------ */

/**
 * 渲染一个 Markdown 编辑组件。原文只存在于 textarea 里，
 * 预览是单向派生，切回编辑永远不会改变用户输入的 Markdown。
 */
export function markdownField({ id, value = '', rows = 8, placeholder = '' } = {}) {
  return `<div class="md-field" data-md="${esc(id)}">
    <div class="md-tabs">
      <button type="button" data-mode="edit" class="active">编辑</button>
      <button type="button" data-mode="preview">预览</button>
    </div>
    <div class="md-toolbar" role="toolbar" aria-label="Markdown 格式">
      ${[["bold","粗体","⌘/Ctrl+B"],["italic","斜体","⌘/Ctrl+I"],["accent-blue","蓝色加粗","⌘/Ctrl+Alt+4"],["accent-red","红色加粗","⌘/Ctrl+Alt+5"],["accent-green","绿色加粗","⌘/Ctrl+Alt+6"],["heading2","标题","⌘/Ctrl+Alt+2"],["bullet","列表","⌘/Ctrl+Shift+8"],["ordered","编号","⌘/Ctrl+Shift+7"],["quote","引用",""],["inline","行内代码","⌘/Ctrl+E"],["code","代码块","⌘/Ctrl+Shift+K"],["link","链接","⌘/Ctrl+K"]].map(([command,label,key])=>`<button type="button" data-md-command="${command}" title="${label}${key ? ` · ${key}` : ""}" aria-label="${label}">${label}</button>`).join('')}
      <button type="button" data-md-expand aria-pressed="false">宽屏编辑</button>
    </div>
    <details class="md-shortcuts"><summary>快捷键说明</summary><p>Mac 使用 ⌘，Windows／Linux 使用 Ctrl：B 粗体，I 斜体，K 链接，E 行内代码；Shift+K 代码块，Shift+7 编号，Shift+8 列表；Alt+1／2／3 标题；Alt+4／5／6 蓝／红／绿色加粗（再次使用同色取消）；Shift+P 切换预览，S 保存（沿用当前保存／核对）。Tab 缩进、Shift+Tab 反缩进；Esc 后按 Tab 离开输入框。宽屏中 Esc 返回。撤销／重做沿用系统快捷键。</p></details>
    <textarea id="${esc(id)}" rows="${rows}" aria-label="Markdown 答案" placeholder="${esc(placeholder)}" spellcheck="false">${esc(value)}</textarea>
    <div class="md-preview" id="${esc(id)}-view" hidden></div>
    <div class="hint" id="${esc(id)}-note" hidden>预览由 Markdown 原文生成；脚本、事件属性与危险链接不会执行，图片附件不会自动加载。</div>
  </div>`;
}

/** 绑定 markdownField 的标签切换与实时预览。 */
export function bindMarkdownField(root, id) {
  const box = qs(root, `[data-md="${id}"]`);
  if (!box) return;
  const area = qs(box, `#${id}`);
  const view = qs(box, `#${id}-view`);
  const note = qs(box, `#${id}-note`);
  const paint = () => {
    view.innerHTML = renderMarkdown(area.value);
  };
  if (box.dataset.bound) return;
  box.dataset.bound = 'true';
  const switchMode = (mode) => {
    qsa(box, '.md-tabs [data-mode]').forEach(b => {b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode));});
    area.hidden = mode !== 'edit';view.hidden = mode !== 'preview';
    if(note)note.hidden = mode !== 'preview';
    if(mode==='preview'){paint();view.tabIndex=0;view.focus();}else area.focus({preventScroll:true});
  };
  qsa(box, '.md-tabs [data-mode]').forEach(btn => btn.addEventListener('click',()=>switchMode(btn.dataset.mode)));
  bindEditorTools(box,area,{switchMode});
  area.addEventListener('input', () => {
    if (!view.hidden) paint();
  });
}

/* ------------------------------------------------------------------ */
/* 来源                                                                */
/* ------------------------------------------------------------------ */

export function sourceChips(sources = []) {
  if (!sources.length) return '<span class="hint">暂无来源</span>';
  return sources
    .map((s) => {
      const text = describeSource(s);
      return s.url
        ? `<span class="chip-src"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a></span>`
        : `<span class="chip-src">${esc(text)}</span>`;
    })
    .join('');
}

/** 来源编辑行：类型 + 可确定的信息，未知页码留空，不伪造。 */
export function sourceEditor({ id, source = null } = {}) {
  const types = [
    ['manual', '手工录入'],
    ['web-region', '网页框选'],
    ['image-upload', '上传图片'],
    ['image-paste', '粘贴图片'],
    ['markdown', 'Markdown 文件'],
    ['pdf', 'PDF 文件'],
    ['docx', 'DOCX 文件'],
  ];
  return `<div class="grid2" data-src="${esc(id)}">
    <div class="field"><label>来源类型</label><select data-src-type>
      ${types.map(([v, t]) => `<option value="${v}"${source?.type === v ? ' selected' : ''}>${t}</option>`).join('')}
    </select></div>
    <div class="field"><label>文件名 / 页面标题</label><input data-src-name value="${esc(source?.fileName || source?.pageTitle || '')}" placeholder="可留空"></div>
    <div class="field"><label>页码（逗号分隔，未知留空）</label><input data-src-pages value="${esc((source?.pageNumbers || []).join(','))}" placeholder="例如 3,5"></div>
    <div class="field"><label>链接（可选）</label><input data-src-url value="${esc(source?.url || '')}" placeholder="https://…"></div>
  </div>`;
}

/** 从 sourceEditor 的 DOM 读回一个来源对象；信息全空时返回 null。 */
export function readSourceEditor(root, id) {
  const box = qs(root, `[data-src="${id}"]`);
  if (!box) return null;
  const type = qs(box, '[data-src-type]').value;
  const name = qs(box, '[data-src-name]').value.trim();
  const pages = qs(box, '[data-src-pages]')
    .value.split(/[,，\s]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  const url = qs(box, '[data-src-url]').value.trim();
  const isFile = ['markdown', 'pdf', 'docx'].includes(type);
  const source = {
    type,
    url: /^https?:\/\//i.test(url) ? url : '',
    fileName: isFile ? name : '',
    pageTitle: isFile ? '' : name,
    pageNumbers: pages,
    importedAt: Date.now(),
  };
  if (!source.url && !source.fileName && !source.pageTitle && !pages.length) return null;
  return source;
}

/* ------------------------------------------------------------------ */
/* 其它小件                                                            */
/* ------------------------------------------------------------------ */

export function parseTags(text) {
  return String(text || '')
    .split(/[,，、;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function field({ label, id, value = '', placeholder = '', rows = 0, type = 'text' }) {
  const inner =
    rows > 0
      ? `<textarea id="${esc(id)}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input id="${esc(id)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
  return `<div class="field"><label>${esc(label)}</label>${inner}</div>`;
}

export function confirmDialog(message) {
  return window.confirm(message);
}

/** 输入防抖：保存按钮与搜索都不该在每次按键时立刻打满存储。 */
export function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
