/**
 * 共享 Markdown 渲染：原文是唯一持久化表示，HTML 只用于预览。
 *
 * - 依赖随扩展分发的 marked（解析）与 DOMPurify（清洗），均为本地 UMD 构建，
 *   由页面用 <script> 引入，模块从 globalThis 取用；不加载任何 CDN。
 * - 清洗规则：只允许文档类标签（标题/列表/表格/代码/链接等）；
 *   禁止脚本、事件属性、style、内联 iframe 等；链接只允许 http(s)/mailto/锚点；
 *   不渲染图片附件（避免预览时自动联网取图）。
 */

import { escapeHtml } from './util.js';
import { createMarkdownParser } from './markdown-parser.js';
let cachedMarked, cachedParser;

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'strong',
  'em',
  'del',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'span',
  'div',
];

const FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'img',
  'picture',
  'source',
  'video',
  'audio',
  'canvas',
  'template',
];

const ALLOWED_ATTR = ['href', 'title', 'class', 'target', 'rel', 'colspan', 'rowspan', 'align'];

/** 只允许 http(s)、mailto 与页内锚点，挡住 javascript: / data: / file: 等。 */
const SAFE_URI = /^(?:https?:|mailto:|#)/i;

let hookInstalled = false;

function libs() {
  const marked = globalThis.marked;
  const purify = globalThis.DOMPurify;
  return { marked, purify };
}

function installHook(purify) {
  if (hookInstalled || !purify?.addHook) return;
  hookInstalled = true;
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
      const href = node.getAttribute('href') || '';
      if (!SAFE_URI.test(href)) node.removeAttribute('href');
    }
  });
  // 任何被解析出的 URL 都再过一次白名单
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'href' && !SAFE_URI.test(data.attrValue || '')) {
      data.forceKeepAttr = false;
      data.attrValue = '';
    }
  });
}

/** 依赖是否就绪（页面加载失败时用于给出可读提示）。 */
export function markdownReady() {
  const { marked, purify } = libs();
  return Boolean(marked?.parse && purify?.sanitize);
}

/**
 * 渲染 Markdown 为可安全插入 innerHTML 的 HTML。
 * 依赖缺失时退回转义后的纯文本，而不是抛错让整页打不开。
 */
export function renderMarkdown(markdown) {
  const src = String(markdown ?? '');
  if (!src.trim()) return '';
  const { marked, purify } = libs();
  if (!marked?.parse || !purify?.sanitize) return `<pre class="md-fallback">${escapeHtml(src)}</pre>`;
  installHook(purify);
  let html;
  try {
    if (cachedMarked !== marked) { cachedParser = createMarkdownParser(marked); cachedMarked = marked; }
    html = cachedParser.parse(src, { gfm: true, breaks: false, async: false });
  } catch {
    return `<pre class="md-fallback">${escapeHtml(src)}</pre>`;
  }
  if (typeof html !== 'string') return `<pre class="md-fallback">${escapeHtml(src)}</pre>`;
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS,
    FORBID_ATTR: [/^on/i, 'style', 'src', 'srcset', 'formaction', 'xlink:href', 'ping', 'srcdoc'],
    ALLOWED_URI_REGEXP: SAFE_URI,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
}

/** 纯文本摘要：给搜索命中、列表预览用，不渲染 HTML。 */
export function markdownPlainText(markdown, limit = 240) {
  const text = String(markdown ?? '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => ` ${body} `)
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (_, body) => ` ${body} `)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s{0,3}(#{1,6})\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, ' / ')
    .replace(/\n/g, ' ')
    .trim();
  return limit && text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
