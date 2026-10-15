/**
 * 文档解析层：把 Markdown / PDF / DOCX 文件转成可核对的候选问答（RawCandidate）。
 *
 * 边界（design.md §4）：
 * - 只做「读文件、抽文字、分题」，不碰页面层、不写知识库；原始文件与嵌入图片都不入库。
 * - PDF.js 与 Mammoth 由页面以经典脚本加载，本模块只从 globalThis 懒取，缺库时报 no-lib，绝不访问 CDN。
 * - 旧版 .doc 明确提示转存 DOCX／PDF；损坏、加密、超限文件都不产生候选。
 * - Markdown 分题是纯文本、围栏感知的确定性扫描，可在 Node 里离线测试（不依赖 DOM 与 Markdown 库）。
 *
 * RawCandidate（故意与 knowledge-import.js 的候选模型解耦）：
 *   { question, answerMarkdown, tags: string[], categoryName: string, sources: Source[], group: string }
 * `group` 是最近的分组标题（如「数据库」「项目名称」），没有分组时为 ''。
 */

import { bytesToSize, truncate, uniq } from './util.js';
import { sanitizeSource, sanitizeSources } from './knowledge-store.js';

/* ------------------------------------------------------------------ */
/* 常量与错误                                                          */
/* ------------------------------------------------------------------ */

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_PDF_PAGES = 50; // 单批 50 页
export const CHUNK_CHARS = 12000; // 单次模型输入约 12,000 字符

export class DocumentError extends Error {
  constructor(message, { code = 'unknown', detail = '', retryable = false } = {}) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ */
/* 文件类型与前置校验                                                  */
/* ------------------------------------------------------------------ */

const EXT_KINDS = {
  docx: 'docx',
  doc: 'doc',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'markdown',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
};

const MIME_KINDS = [
  [/^application\/pdf\b/, 'pdf'],
  [/wordprocessingml\.document/, 'docx'],
  [/^application\/msword\b/, 'doc'],
  [/markdown/, 'markdown'],
  [/^text\/(plain|x-markdown)/, 'markdown'],
  [/^image\//, 'image'],
];

/** 按文件名/MIME 判断类型：返回 'pdf' | 'docx' | 'doc' | 'markdown' | 'image' | 'unknown' */
export function detectFileKind(name, mime) {
  const ext = String(name || '')
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && EXT_KINDS[ext]) return EXT_KINDS[ext];
  const m = String(mime || '').toLowerCase();
  for (const [re, kind] of MIME_KINDS) {
    if (re.test(m)) return kind;
  }
  return 'unknown';
}

const KIND_LABELS = {
  pdf: 'PDF',
  docx: 'DOCX',
  doc: '旧版 Word（.doc）',
  markdown: 'Markdown／纯文本',
  image: '图片',
  unknown: '未知类型',
};

const LEGACY_DOC_MESSAGE =
  '这是旧版 .doc 文件，浏览器里无法直接解析。请用 Word 另存为 .docx，或导出成 PDF 后重新导入。';

function assertFilePresent(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new DocumentError('没有拿到文件内容，请重新选择文件后再试。', { code: 'unsupported' });
  }
}

function assertFileSize(file) {
  const size = Number(file.size) || 0;
  if (size === 0) throw new DocumentError('文件是空的，请确认后重新选择。', { code: 'corrupt' });
  if (size > MAX_FILE_BYTES) {
    throw new DocumentError(
      `文件大小 ${bytesToSize(size)}，超过单次导入上限 ${bytesToSize(MAX_FILE_BYTES)}，请拆分文件后再试。`,
      { code: 'too-large', detail: `${size} bytes` },
    );
  }
}

function assertKind(kind, label, expected) {
  if (kind === 'doc') throw new DocumentError(LEGACY_DOC_MESSAGE, { code: 'legacy-doc' });
  if (kind === 'unknown') {
    throw new DocumentError(`无法识别的文件类型，暂时只支持 ${label}。请换成本扩展支持的格式后重试。`, {
      code: 'unsupported',
    });
  }
  if (!expected.includes(kind)) {
    throw new DocumentError(
      `当前入口只接受 ${label}，这个文件看起来是${KIND_LABELS[kind] || '其他类型'}。请选择对应的导入入口。`,
      { code: 'unsupported' },
    );
  }
}

function requireGlobal(name, label) {
  const lib = globalThis?.[name];
  if (!lib) {
    throw new DocumentError(
      `没有找到文档解析组件 ${label}。请确认扩展的 ${label} 脚本已随页面加载（依赖为本地打包，不会联网），然后重新解析。`,
      { code: 'no-lib' },
    );
  }
  return lib;
}

function abortedError() {
  return new DocumentError('已取消导入，未保存任何内容。', { code: 'aborted', retryable: true });
}

function checkAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

/** 只在扩展环境下返回 chrome 扩展内部资源 URL；离线测试返回空串。 */
function extensionUrl(path) {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) return chrome.runtime.getURL(path);
  } catch {
    /* 非扩展环境 */
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 文本分片：跨块保留上下文重叠                                        */
/* ------------------------------------------------------------------ */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** 跟踪围栏代码块状态；返回新的围栏标记（null 表示已闭合）。 */
function nextFence(state, line) {
  const m = line.match(FENCE_RE);
  if (state) {
    // 结束围栏必须同字符且不短于开始围栏
    if (m && m[1][0] === state[0] && m[1].length >= state.length) return null;
    return state;
  }
  return m ? m[1] : null;
}

/** 每一行是否处于围栏代码块内（含围栏分隔行本身）。 */
function fenceMap(lines) {
  const map = new Array(lines.length).fill(false);
  let state = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(FENCE_RE);
    if (state) {
      map[i] = true;
      if (m && m[1][0] === state[0] && m[1].length >= state.length) state = null;
      continue;
    }
    if (m) {
      map[i] = true;
      state = m[1];
    }
  }
  return map;
}

/** 跨块分片：保留上下文重叠，避免题目/答案被切断后无法核对 */
export function chunkText(text, limit = CHUNK_CHARS) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const max = Math.max(200, Math.floor(Number(limit)) || CHUNK_CHARS);
  const lines = src.split('\n');
  const chunks = [];
  let buf = [];
  let bufStates = []; // bufStates[k] = buf[k] 处理完后的围栏状态，null 表示围栏外
  let len = 0;
  let fence = null;
  let overlapCount = 0;

  // 上一块的末尾两行作为下一块的上下文；若含围栏行则放弃，避免破坏围栏配对
  const flushChunk = (emitted) => {
    chunks.push(emitted.join('\n'));
    return emitted.slice(-2).filter((l) => l.trim() && l.length <= 300 && !FENCE_RE.test(l));
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    buf.push(line);
    len += line.length + 1;
    fence = nextFence(fence, line);
    bufStates.push(fence);
    if (fence || len < max) continue; // 围栏内绝不切分

    // 优先在段落后（空行）切，但切点与后面都必须在围栏外；太靠前时退回按行切
    let cut = buf.length;
    for (let j = buf.length - 1; j >= 1; j -= 1) {
      if (buf[j - 1] === '' && bufStates[j - 1] === null) {
        cut = j;
        break;
      }
    }
    let prefix = 0;
    for (let k = 0; k < cut; k += 1) prefix += buf[k].length + 1;
    if (cut < buf.length && prefix < max * 0.4) cut = buf.length;

    const rest = buf.slice(cut);
    const restStates = bufStates.slice(cut);
    const overlap = flushChunk(buf.slice(0, cut));
    // 重叠行本身必定在围栏外，因此状态直接记为 null
    buf = overlap.length ? [...overlap, ...rest] : rest;
    bufStates = overlap.map(() => null).concat(restStates);
    overlapCount = overlap.length;
    len = buf.reduce((n, l) => n + l.length + 1, 0);
  }
  if (buf.length > overlapCount) flushChunk(buf);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Markdown 分题：围栏感知的确定性扫描                                  */
/* ------------------------------------------------------------------ */

const ATX_RE = /^(#{1,6})(?!#)[ \t]*(.*?)[ \t]*$/;
// Q 标记：Q: / Q： / Question: / 问： / 问题：（中文题库常见写法）
const Q_HEAD_RE = /^\s*(?:\*\*)?(?:Q(?:uestion)?|问题|问)(?=[\s:：.、*]|$)/i; // 防止 Qualified 之类被误判
const Q_MARKER_RE = /^\s*(?:\*\*)?(?:Q(?:uestion)?|问题|问)\s*[:：.、]?\s*/i;
const A_MARKER_RE = /^\s*(?:\*\*)?\s*(?:Answer|答案|Ans|答|A)\s*[:：]\s*/i;
const JDT_RE = /^\s*<!--\s*jdt:\s*(\{[\s\S]*\})\s*-->\s*$/;
const EXPORT_HEADER_RE = /^\s*导出于\s.*$/; // 导出抬头行（如「导出于 …，共 12 题。」）属于前言
const NUMBERED_RE = /^(?:(\d{1,3})\s*[.、．)）]|[（(]\s*(\d{1,3})\s*[)）]|第\s*(\d{1,3})\s*题)\s*[:：.、]?\s*/;

const cleanInlineMarker = (s) =>
  String(s)
    .replace(/^[\s*]+/, '')
    .replace(/^[:：.、]\s*/, '')
    .replace(/[\s*]+$/, '')
    .trim();

/** 识别 ATX 标题；返回 { depth, text, hasQ }，hasQ 表示写过 Q 标记（题面里已剥掉）。 */
function parseHeading(line) {
  const m = line.match(ATX_RE);
  if (!m) return null;
  const body = m[2].replace(/[ \t]+#+[ \t]*$/, '').trim(); // 去掉收尾的 ### 序列
  if (!body) return null;
  const stripped = stripQMarker(body);
  return { depth: m[1].length, text: stripped ?? body, hasQ: stripped !== null };
}

function stripQMarker(text) {
  if (!Q_HEAD_RE.test(text)) return null;
  const m = text.match(Q_MARKER_RE);
  if (!m) return null;
  return cleanInlineMarker(text.slice(m[0].length)) || null;
}

function qMarkerText(line) {
  if (!Q_HEAD_RE.test(line)) return null;
  const m = line.match(Q_MARKER_RE);
  if (!m) return null;
  return cleanInlineMarker(line.slice(m[0].length)) || null;
}

function numberedText(line) {
  const m = line.match(NUMBERED_RE);
  return m ? line.slice(m[0].length).trim() : line.trim();
}

/** 编号题只在「整篇没有标题/Q 标记」时启用，且必须是顶格、短、不在答案列表续行里。 */
function isNumberedQuestion(line) {
  if (!line || line.length > 80) return false;
  if (/^\s/.test(line)) return false; // 缩进行视为答案里的列表续行
  const m = line.match(NUMBERED_RE);
  if (!m) return false;
  return line.slice(m[0].length).trim().length > 0;
}

function trimBlankLines(lines) {
  let s = 0;
  let e = lines.length;
  while (s < e && !String(lines[s]).trim()) s += 1;
  while (e > s && !String(lines[e - 1]).trim()) e -= 1;
  return lines.slice(s, e);
}

/** 解析本应用导出的内嵌题面元数据：<!--jdt:{"tags":[],"category":"","sources":[]}--> */
function parseJdtMeta(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null; // 元数据坏了不影响分题
  }
  if (!raw || typeof raw !== 'object') return null;
  const tags = uniq(
    (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t).trim()).filter(Boolean),
  );
  const categoryName = typeof raw.category === 'string' ? raw.category.trim() : '';
  // 逐条收敛来源结构，再去重与截断
  const sources = sanitizeSources(
    (Array.isArray(raw.sources) ? raw.sources : []).map((s) => sanitizeSource(s)).filter(Boolean),
  );
  return { tags, categoryName, sources };
}

/** 新导出使用答案行数框定正文，标题、Q/A 字样和元数据样例都只是答案内容。 */
function splitFramedExport(lines) {
  const out = [];
  let group = '';
  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseHeading(lines[i]);
    if (heading?.depth === 2) group = heading.text;
    const match = lines[i].match(JDT_RE);
    if (!match) continue;
    let raw;
    try { raw = JSON.parse(match[1]); } catch { continue; }
    if (!raw || !Object.hasOwn(raw, 'answerLines')) continue;
    if (!Number.isInteger(raw.answerLines) || raw.answerLines < 0 || typeof raw.question !== 'string' || !raw.question.trim()) {
      throw new DocumentError('导出问答的边界信息无效，请检查文件后重试。', { code: 'corrupt' });
    }
    let start = i + 1;
    while (start < lines.length && !/^A:[ \t]*$/.test(lines[start])) {
      if (parseHeading(lines[start])) break;
      start += 1;
    }
    if (start === lines.length || !/^A:[ \t]*$/.test(lines[start]) || start + raw.answerLines >= lines.length) {
      throw new DocumentError('导出问答的答案边界不完整，请检查文件后重试。', { code: 'corrupt' });
    }
    if (lines[start + 1 + raw.answerLines] !== '<!--jdt:{"kind":"answer-end"}-->') {
      throw new DocumentError('导出答案的长度与边界不一致，请重新导出后重试。', { code: 'corrupt' });
    }
    const meta = parseJdtMeta(match[1]);
    out.push({
      question: raw.question,
      answerMarkdown: lines.slice(start + 1, start + 1 + raw.answerLines).join('\n'),
      tags: meta.tags,
      categoryName: meta.categoryName,
      sources: meta.sources,
      group,
    });
    i = start + 1 + raw.answerLines;
  }
  return out;
}

/**
 * 确定性 Markdown 分题（knowledge-export.js 的输出必须能原样解析回来）。
 *
 * 页面层级约定：
 * - 本应用新导出按元数据中的答案行数读取正文，空项目和空库不产生题目。
 * - 一般文档优先用 Q 标记或紧邻 A 标记的标题识别题目；没有这些标记时，
 *   优先选择重复的最浅标题层，无法确定时使用最深层并交给用户核对。
 *   比题目更深的标题属于答案，不另拆题。
 * - 带 Q 标记（Q: / Q： / 问： / 问题：）的标题在任何层级都算题目。
 * - 独立的 Q 标记行（非标题）同样算题目；编号题只在没有任何标题与 Q 标记时启用。
 * - 题目标题与 A／答：标记之间的内容是前言（内嵌元数据、人类可读的标签/来源行、
 *   分组及项目简介段落），从 answerMarkdown 中丢弃；答案从 A 标记之后开始逐字保留。
 * - 围栏代码块内的一切都不参与分题，也不做任何改写。
 */
export function splitMarkdownQuestions(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const lines = src.split('\n');
  const inFence = fenceMap(lines);
  const framed = lines.some((line, i) => {
    if (inFence[i]) return false;
    const match = line.match(JDT_RE);
    if (!match) return false;
    try { const meta = JSON.parse(match[1]); return meta?.kind === 'library' && meta.version === 1; } catch { return false; }
  });
  if (framed) return splitFramedExport(lines);

  const headings = new Map(); // i → { depth, text, hasQ }
  const qMarkers = new Map(); // i → 题面（独立的 Q 标记行）
  const headingCounts = new Map();
  let maxDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue;
    const heading = parseHeading(lines[i]);
    if (heading) {
      headings.set(i, heading);
      headingCounts.set(heading.depth, (headingCounts.get(heading.depth) || 0) + 1);
      maxDepth = Math.max(maxDepth, heading.depth);
      continue;
    }
    const marked = qMarkerText(lines[i]);
    if (marked) qMarkers.set(i, marked);
  }
  const answerHeadings = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i] || !A_MARKER_RE.test(lines[i])) continue;
    let before = i - 1;
    while (before >= 0 && (!lines[before].trim() || JDT_RE.test(lines[before]) || /^>/.test(lines[before]))) before -= 1;
    if (headings.has(before)) answerHeadings.add(before);
  }
  const hasQuestionMarkers = qMarkers.size > 0 || [...headings.values()].some((h) => h.hasQ);
  const hasExplicitQuestions = hasQuestionMarkers || answerHeadings.size > 0;
  const answerDepths = new Set([...answerHeadings].map((index) => headings.get(index).depth));
  // 兼容旧版空库导出：项目概况和库标题不是问答，也不能进入全文兜底。
  const legacyExport = lines.some((line, i) => !inFence[i] && /^# (?:项目库|八股文题库)\s*$/.test(line)) && lines.some((line, i) => !inFence[i] && EXPORT_HEADER_RE.test(line));
  if (legacyExport && !hasExplicitQuestions) return [];
  const repeatedDepth = [...headingCounts].filter(([, count]) => count > 1).map(([depth]) => depth).sort((a, b) => a - b)[0];
  const questionDepth = repeatedDepth ?? maxDepth;
  const isQuestionHeading = (heading, index) => heading.hasQ || answerHeadings.has(index) || (!hasQuestionMarkers && (answerHeadings.size ? answerDepths.has(heading.depth) : heading.depth === questionDepth));
  const useNumbering = headings.size === 0 && qMarkers.size === 0;

  const groupStack = []; // { depth, text }，保存当前生效的分组标题
  const groupContext = () => {
    const nearest = groupStack.length ? groupStack[groupStack.length - 1].text : '';
    const category = [...groupStack].reverse().find((g) => g.depth === 2)?.text || nearest;
    return { group: nearest, category };
  };

  const finalize = (cur, endIndex) => {
    const rawBody = lines.slice(cur.bodyStart, endIndex);
    let meta = null;
    const kept = [];
    const keptInFence = [];
    for (let k = 0; k < rawBody.length; k += 1) {
      const abs = cur.bodyStart + k;
      const line = rawBody[k];
      if (inFence[abs]) {
        kept.push(line); // 围栏内容逐字保留
        keptInFence.push(true);
        continue;
      }
      const comment = line.match(JDT_RE);
      if (comment) {
        if (!meta) meta = parseJdtMeta(comment[1]);
        continue; // 内嵌元数据既不入答案，也不算正文
      }
      if (EXPORT_HEADER_RE.test(line)) continue; // 导出抬头行属于前言
      kept.push(line);
      keptInFence.push(false);
    }
    // A／答：标记之前都是前言（元数据 + 人类可读的标签/来源行），从答案里丢弃
    let body = kept;
    for (let k = 0; k < kept.length; k += 1) {
      if (keptInFence[k]) continue;
      const marker = kept[k].match(A_MARKER_RE);
      if (!marker) continue;
      const head = cleanInlineMarker(kept[k].slice(marker[0].length));
      body = head ? [head, ...kept.slice(k + 1)] : kept.slice(k + 1);
      break;
    }
    return {
      question: cur.question,
      answerMarkdown: trimBlankLines(body).join('\n'),
      tags: meta?.tags ?? [],
      // 有内嵌元数据就以它为准（哪怕 category 是空串）；没有元数据时才用分组标题兜底
      categoryName: meta ? meta.categoryName : cur.category || '',
      sources: meta?.sources ?? [],
      group: cur.group || '',
    };
  };

  const out = [];
  let cur = null;
  const closeCandidate = (endIndex) => {
    if (cur) out.push(finalize(cur, endIndex));
    cur = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue;
    const heading = headings.get(i);
    if (heading) {
      if (isQuestionHeading(heading, i)) {
        closeCandidate(i);
        const ctx = groupContext();
        cur = { question: heading.text, bodyStart: i + 1, headingDepth: heading.depth, group: ctx.group, category: ctx.category };
      } else {
        if (cur && heading.depth > cur.headingDepth) continue;
        // 显式 Q 模式下，答案里的任意深度标题保留；仅下一行就是新题的分组标题结束上一题。
        let nextIndex = i + 1;
        while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
        const next = lines[nextIndex];
        const nextIsQuestion = next && (parseHeading(next)?.hasQ || qMarkerText(next) || answerHeadings.has(nextIndex));
        const libraryHeading = legacyExport && heading.depth === 1 && /^(?:项目库|八股文题库)$/.test(heading.text);
        if (hasExplicitQuestions && cur && !nextIsQuestion && !libraryHeading) continue;
        // 分组标题：结束上一题，避免分组说明或项目简介混进答案；自身不产生候选
        closeCandidate(i);
        while (groupStack.length && groupStack[groupStack.length - 1].depth >= heading.depth) groupStack.pop();
        groupStack.push({ depth: heading.depth, text: heading.text });
      }
      continue;
    }
    const marked = qMarkers.get(i);
    if (marked) {
      closeCandidate(i);
      const ctx = groupContext();
      cur = { question: marked, bodyStart: i + 1, group: ctx.group, category: ctx.category };
      continue;
    }
    if (useNumbering && isNumberedQuestion(lines[i]) && (i === 0 || !lines[i - 1].trim())) {
      closeCandidate(i);
      const ctx = groupContext();
      cur = { question: numberedText(lines[i]), bodyStart: i + 1, group: ctx.group, category: ctx.category };
    }
  }
  if (cur) out.push(finalize(cur, lines.length));
  if (out.length) return out;

  // 兜底：整篇没有任何可识别标记时，把首个非空行当题目、其余当答案，
  // 让用户至少拿到一块可手工调整边界的内容；绝不在「有标记」时把全文当成一题。
  const first = lines.findIndex((l) => l.trim());
  if (first === -1) return [];
  return [
    {
      question: truncate(lines[first], 200),
      answerMarkdown: trimBlankLines(lines.slice(first + 1)).join('\n'),
      tags: [],
      categoryName: '',
      sources: [],
      group: '',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* PDF：逐页文字提取 + 按需渲染页面图像                                */
/* ------------------------------------------------------------------ */

let pdfWorkerReady = false;

function configurePdfWorker(pdfjsLib) {
  if (pdfWorkerReady) return;
  const url = extensionUrl('src/vendor/pdfjs/pdf.worker.min.js');
  if (!url) return; // 离线测试环境不设置 worker
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = url;
    pdfWorkerReady = true;
  } catch {
    /* worker 设置失败时仍可回退主线程解析 */
  }
}

/** 只注入扩展内部的 cmap／标准字体资源，避免 pdf.js 去联网取字体。 */
function pdfAssetUrls() {
  const cMapUrl = extensionUrl('src/vendor/pdfjs/cmaps/');
  const standardFontDataUrl = extensionUrl('src/vendor/pdfjs/standard_fonts/');
  return cMapUrl ? { cMapUrl, standardFontDataUrl } : {};
}

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 偏低分位数：用来估计「常规行距」，避免少量大段间距把基准抬高。 */
function quantile(list, q) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

/** 同一行的文本片段：按 x 排序且只在间距明显时补空格，避免把词粘在一起。 */
function joinItems(items) {
  let text = '';
  let prev = null;
  for (const item of items) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      if (gap > Math.max(2, prev.height * 0.25) && !/\s$/.test(text)) text += ' ';
    }
    text += item.str;
    prev = item;
  }
  return text.replace(/\s+$/, '');
}

/**
 * 把一页的 textContent 还原成带行与段落的文本。
 * 行按 transform 的 y 分组（容差 ~2 单位），行内按 x 排序；
 * y 间距超过中位行距 1.6 倍时插入空行，明显右移的行按字符宽度还原缩进。
 */
/**
 * 判断一页是不是"看得见却提不出文字"。
 *
 * 用 Chrome 打印出来的中文 PDF 很典型：字体是没有 ToUnicode 映射的子集字体，
 * pdf.js 干脆不返回这些字符，页面上明明有几十行字，getTextContent 只给出零星几十个字符，
 * 靠字符数完全看不出来，直接按文字页处理就会静默丢掉整页内容。
 * 这里去内容流里数字形：字形数远多于能提取到的字符数，就说明这页必须走图像识别。
 */
async function looksUnreadable(page, nonWhitespace) {
  const lib = globalThis.pdfjsLib;
  const OPS = lib?.OPS;
  if (!OPS) return false;
  try {
    // intent: 'any' 避免为了探测而解码页面里的图片
    const opList = await page.getOperatorList({ intent: 'any' });
    let glyphs = 0;
    for (let i = 0; i < opList.fnArray.length; i += 1) {
      const fn = opList.fnArray[i];
      if (fn !== OPS.showText && fn !== OPS.showSpacedText) continue;
      const arg = opList.argsArray[i];
      const seq = Array.isArray(arg) ? arg[0] : null;
      if (Array.isArray(seq)) glyphs += seq.length;
    }
    return glyphs >= 80 && glyphs > nonWhitespace * 3;
  } catch {
    // 拿不到内容流就算了，按原来的字符数规则处理
    return false;
  }
}

function textContentToMarkdown(items) {
  const groups = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || item.str === '') continue;
    const tr = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(tr[4]) || 0;
    const y = Number(tr[5]) || 0;
    const height = Math.abs(Number(item.height)) || Math.abs(Number(tr[3])) || 10;
    const width = Number(item.width) || 0;
    let group = null;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if (Math.abs(groups[i].y - y) <= 2) {
        group = groups[i];
        break;
      }
    }
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push({ x, width, height, str: item.str });
  }
  if (!groups.length) return '';

  for (const group of groups) {
    group.items.sort((a, b) => a.x - b.x);
    group.x0 = group.items[0].x;
    group.widths = group.items.filter((it) => it.str.trim()).map((it) => it.width / Math.max(1, it.str.length));
  }

  const ordered = groups.slice().sort((a, b) => b.y - a.y); // PDF 坐标里 y 越大越靠上
  const charWidth = median(ordered.flatMap((g) => g.widths).filter((w) => w > 0.5));
  const minX = Math.min(...ordered.map((g) => g.x0));

  const gaps = [];
  for (let i = 1; i < ordered.length; i += 1) gaps.push(ordered[i - 1].y - ordered[i].y);
  // 行距取偏低分位：正常行距是多数，少量段间距不能把基准抬高
  const lineGap = quantile(gaps.filter((g) => g > 0), 0.25);
  const paraGap = lineGap > 0 ? lineGap * 1.6 : Infinity;

  const out = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const group = ordered[i];
    if (i > 0 && ordered[i - 1].y - group.y > paraGap) out.push('');
    const units = charWidth > 0 ? (group.x0 - minX) / charWidth : 0;
    const indent = units >= 3 ? ' '.repeat(Math.min(Math.round(units), 8)) : '';
    out.push(indent + joinItems(group.items));
  }
  return out.join('\n').replace(/\s+$/, '');
}

function mapPdfError(err) {
  const name = err?.name || '';
  const detail = String(err?.message || err);
  if (name === 'PasswordException' || /password|encrypt/i.test(detail)) {
    return new DocumentError('这个 PDF 有密码保护，无法读取。请先取消密码保护或另存一份无密码版本后重试。', {
      code: 'encrypted',
      detail,
    });
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException' || /invalid pdf|not a pdf/i.test(detail)) {
    return new DocumentError('PDF 文件已损坏或不是有效的 PDF，无法解析。', { code: 'corrupt', detail });
  }
  return new DocumentError(`PDF 解析失败：${detail.slice(0, 120)}`, { code: 'unknown', detail, retryable: true });
}

function createCanvas() {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return document.createElement('canvas');
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  throw new DocumentError('当前环境不支持 canvas，无法把 PDF 页面渲染成图片。', { code: 'no-lib' });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new DocumentError('页面图像编码失败，请重试。', { code: 'unknown', retryable: true }));
    reader.readAsDataURL(blob);
  });
}

/**
 * pdf.js 的页面渲染是用 requestAnimationFrame 分片调度的（InternalRenderTask）。
 * 标签页在后台时浏览器完全不调用 rAF，渲染 Promise 就永远不 resolve——
 * 用户导入 PDF 时切到别的标签页，导入会静默卡住，连取消都推不动。
 * 渲染期间把 rAF 换成 setTimeout 版本：后台标签页的定时器只是被降频，不会彻底停摆，
 * 渲染因此能跑完（慢一点，但不会卡死），结束后恢复原函数。
 */
async function withAnimationFrameFallback(fn) {
  const original = typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame : null;
  if (!original) return fn();
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  try {
    return await fn();
  } finally {
    globalThis.requestAnimationFrame = original;
  }
}

async function canvasToJpeg(canvas, quality) {
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/jpeg', quality);
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await blobToDataUrl(blob);
  }
  throw new DocumentError('当前环境无法导出页面图像。', { code: 'no-lib' });
}

/** PDF：逐页提取文字；无文字页标记为需要图像识别 */
export async function loadPdf(file, { signal, onProgress } = {}) {
  checkAborted(signal);
  const kind = detectFileKind(file?.name, file?.type);
  assertFilePresent(file);
  assertKind(kind, 'PDF', ['pdf']);
  assertFileSize(file);

  const pdfjsLib = requireGlobal('pdfjsLib', 'PDF.js');
  configurePdfWorker(pdfjsLib);

  const report = (page, total, phase) => {
    if (typeof onProgress === 'function') onProgress({ page, total, phase });
  };

  const arrayBuffer = await file.arrayBuffer();
  checkAborted(signal);

  let task;
  try {
    task = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false, // MV3 CSP 禁止 eval，必须关掉
      cMapPacked: true,
      ...pdfAssetUrls(),
    });
  } catch (err) {
    throw mapPdfError(err);
  }

  const onAbort = () => {
    try {
      task?.destroy?.();
    } catch {
      /* 已经释放 */
    }
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    signal?.removeEventListener?.('abort', onAbort);
    throw signal?.aborted ? abortedError() : mapPdfError(err);
  }
  signal?.removeEventListener?.('abort', onAbort);

  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    signal?.removeEventListener?.('abort', onAbort);
    try {
      await pdf.destroy();
    } catch {
      /* 已释放 */
    }
  };

  const total = pdf.numPages;
  if (total > MAX_PDF_PAGES) {
    await destroy();
    throw new DocumentError(
      `这个 PDF 有 ${total} 页，超过单批 ${MAX_PDF_PAGES} 页的处理上限。请拆成多个文件后再导入。`,
      { code: 'too-many-pages', detail: `${total} pages` },
    );
  }

  const pages = [];
  try {
    for (let n = 1; n <= total; n += 1) {
      checkAborted(signal);
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items = content?.items || [];
      const text = textContentToMarkdown(items);
      const nonWhitespace = text.replace(/\s/g, '').length;
      const unreadablePage = nonWhitespace < 800 ? await looksUnreadable(page, nonWhitespace) : false;
      pages.push({ pageNumber: n, text, needsImage: nonWhitespace < 8 || unreadablePage });
      try {
        page.cleanup();
      } catch {
        /* 忽略 */
      }
      report(n, total, 'text');
    }
  } catch (err) {
    await destroy();
    throw err instanceof DocumentError ? err : mapPdfError(err);
  }
  report(total, total, 'done');

  // 渲染时机由调用方决定：只对有需要的页调用，用完即释放 canvas
  const renderPageImage = async (pageNumber, options = {}) => {
    if (destroyed) throw new DocumentError('文档已释放，请重新导入文件后再试。', { code: 'unknown' });
    checkAborted(signal);
    const maxSide = Math.max(320, Math.floor(Number(options.maxSide)) || 1600);
    const rawQuality = Number(options.quality);
    const quality = Number.isFinite(rawQuality) ? Math.min(1, Math.max(0.3, rawQuality)) : 0.9;

    const page = await pdf.getPage(Math.floor(Number(pageNumber)) || 1);
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height) || 1;
    const viewport = page.getViewport({ scale: maxSide / longest }); // 最长边约 1600px
    const canvas = createCanvas();
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await withAnimationFrameFallback(() => page.render({ canvasContext: context, viewport }).promise);
    const dataUrl = await canvasToJpeg(canvas, quality);
    canvas.width = 0; // 返回值不持有 canvas，让它尽快被回收
    canvas.height = 0;
    try {
      page.cleanup();
    } catch {
      /* 忽略 */
    }
    return dataUrl;
  };

  return { pageCount: total, pages, renderPageImage, destroy };
}

/* ------------------------------------------------------------------ */
/* DOCX：Mammoth 结构 HTML → 受控 Markdown                              */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  laquo: '«',
  raquo: '»',
  shy: '',
};

function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : full;
  });
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const TOKEN_SRC = '<!--[\\s\\S]*?-->|<\\s*\\/\\s*([a-zA-Z][\\w:-]*)\\s*>|<\\s*([a-zA-Z][\\w:-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*?)>';

/** 极简 HTML tokenizer → 树；只认 Mammoth 产出的受控子集。 */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = new RegExp(TOKEN_SRC, 'g');
  let last = 0;
  let m;

  const pushText = (chunk) => {
    if (!chunk) return;
    const text = decodeEntities(chunk);
    if (!text) return;
    const parent = stack[stack.length - 1];
    const prev = parent.children[parent.children.length - 1];
    if (prev && prev.text !== undefined) prev.text += text;
    else parent.children.push({ text });
  };

  while ((m = re.exec(html))) {
    if (m.index > last) pushText(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const name = (m[2] || '').toLowerCase();
    if (!name) continue;
    const attrsRaw = m[3] || '';
    const node = { tag: name, attrs: parseAttrs(attrsRaw), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID_TAGS.has(name) && !/\/\s*$/.test(attrsRaw)) stack.push(node);
  }
  if (last < html.length) pushText(html.slice(last));
  return root;
}

function textContent(node) {
  if (node.text !== undefined) return node.text;
  return node.children.map(textContent).join('');
}

function flattenInline(s) {
  return String(s)
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectLanguage(node) {
  const own = String(node.attrs?.class || '').match(/language-([\w+#.-]+)/i);
  if (own) return own[1];
  for (const child of node.children) {
    const m = String(child?.attrs?.class || '').match(/language-([\w+#.-]+)/i);
    if (m) return m[1];
  }
  return '';
}

function renderCodeBlock(node) {
  const code = textContent(node).replace(/^\n/, '').replace(/\n+$/, '');
  const lang = detectLanguage(node);
  const fence = code.includes('```') ? '````' : '```';
  return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
}

function renderList(node, ctx, ordered) {
  const indent = '  '.repeat(ctx.depth);
  let out = '\n';
  let index = 1;
  for (const li of node.children) {
    if (li.tag !== 'li') continue;
    const marker = ordered ? `${index}. ` : '- ';
    const inner = renderChildren(li.children, { ...ctx, depth: ctx.depth + 1 })
      .replace(/^\n+/, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/\s+$/, '');
    out += `\n${indent}${marker}${inner}`;
    index += 1;
  }
  return `${out}\n\n`;
}

function renderTable(node, ctx) {
  const rows = [];
  const collect = (parent) => {
    for (const child of parent.children) {
      if (child.tag === 'tr') {
        const cells = child.children
          .filter((c) => c.tag === 'td' || c.tag === 'th')
          .map((c) => flattenInline(renderChildren(c.children, ctx)).replace(/\|/g, '\\|'));
        if (cells.length) rows.push(cells);
      } else {
        collect(child);
      }
    }
  };
  collect(node);
  if (!rows.length) return '';
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (rows.some((r) => r.length !== width)) ctx.warnings.add('表格的列数不一致，已按最多列数对齐显示。');
  const line = (cells) => `| ${cells.concat(new Array(Math.max(0, width - cells.length)).fill('')).join(' | ')} |`;
  const body = [line(rows[0]), `| ${new Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)];
  return `\n\n${body.join('\n')}\n\n`;
}

function renderImage(node) {
  const src = String(node.attrs.src || '');
  const found = src.match(/jdt-image:(\d+)/);
  const label = found ? `图片 ${Number(found[1]) + 1}` : '嵌入图片';
  return `\n\n![${label}](${src || 'jdt-image:unknown'})\n\n`;
}

function renderChildren(nodes, ctx) {
  return nodes.map((n) => renderNode(n, ctx)).join('');
}

function renderNode(node, ctx) {
  if (node.text !== undefined) return node.text;
  switch (node.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = flattenInline(renderChildren(node.children, ctx));
      return text ? `\n\n${'#'.repeat(Number(node.tag[1]))} ${text}\n\n` : '';
    }
    case 'p': {
      const text = renderChildren(node.children, ctx).trim();
      return text ? `\n\n${text}\n\n` : '';
    }
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'strong':
    case 'b': {
      const inner = renderChildren(node.children, ctx);
      return inner ? `**${inner}**` : '';
    }
    case 'em':
    case 'i': {
      const inner = renderChildren(node.children, ctx);
      return inner ? `*${inner}*` : '';
    }
    case 'del':
    case 's':
    case 'strike': {
      const inner = renderChildren(node.children, ctx);
      return inner ? `~~${inner}~~` : '';
    }
    case 'code': {
      const text = textContent(node);
      if (!text) return '';
      const tick = text.includes('`') ? '``' : '`';
      return `${tick}${text}${tick}`;
    }
    case 'pre':
      return renderCodeBlock(node);
    case 'ul':
      return renderList(node, ctx, false);
    case 'ol':
      return renderList(node, ctx, true);
    case 'blockquote': {
      const inner = renderChildren(node.children, ctx).trim();
      return inner ? `\n\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : '';
    }
    case 'table':
      return renderTable(node, ctx);
    case 'img':
      return renderImage(node);
    case 'a': {
      const inner = renderChildren(node.children, ctx);
      const href = String(node.attrs.href || '');
      return /^https?:\/\//i.test(href) && inner ? `[${inner}](${href})` : inner;
    }
    case 'div':
    case 'section':
    case 'article':
    case 'header':
    case 'footer':
    case 'main':
    case 'figure':
    case 'figcaption':
    case 'aside':
    case 'dt':
    case 'dd': {
      ctx.warnings.add('文档里的复杂排版（如分栏、文本框、图注）已简化为普通段落，请核对内容顺序。');
      const inner = renderChildren(node.children, ctx).trim();
      return inner ? `\n\n${inner}\n\n` : '';
    }
    default:
      return renderChildren(node.children, ctx);
  }
}

/** 只折叠围栏外的多余空行与行尾空格，围栏内容逐字保留。 */
function normalizeMarkdown(md) {
  const out = [];
  let fence = null;
  let blanks = 0;
  for (const line of String(md).split('\n')) {
    const m = line.match(FENCE_RE);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      blanks = 0;
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      blanks += 1;
      if (blanks > 1) continue;
      out.push('');
      continue;
    }
    blanks = 0;
    out.push(line.replace(/[ \t]+$/, ''));
  }
  return out.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

function htmlToMarkdown(html) {
  const ctx = { depth: 0, warnings: new Set() };
  const markdown = normalizeMarkdown(renderChildren(parseHtml(html).children, ctx));
  return { markdown, warnings: [...ctx.warnings] };
}

function mapDocxError(err) {
  const detail = String(err?.message || err);
  if (/password|encrypt|protected|加密|受保护/i.test(detail)) {
    return new DocumentError('这个 Word 文件有密码保护，无法读取。请先取消保护或另存为无密码的 DOCX 后重试。', {
      code: 'encrypted',
      detail,
    });
  }
  if (/zip|central directory|corrupt|invalid|unexpected end|not a/i.test(detail)) {
    return new DocumentError('DOCX 文件已损坏，或不是有效的 Word 文档，无法解析。', { code: 'corrupt', detail });
  }
  return new DocumentError(`DOCX 解析失败：${detail.slice(0, 120)}`, { code: 'unknown', detail, retryable: true });
}

/** DOCX：受控结构转换 → Markdown 原文；顺带返回临时嵌入图（不入库） */
export async function loadDocx(file, { signal } = {}) {
  checkAborted(signal);
  const kind = detectFileKind(file?.name, file?.type);
  assertFilePresent(file);
  assertKind(kind, 'DOCX', ['docx']);
  assertFileSize(file);

  const mammoth = requireGlobal('mammoth', 'Mammoth');
  const arrayBuffer = await file.arrayBuffer();
  checkAborted(signal);

  const images = [];
  const warnings = [];
  // 嵌入图片只作为临时识别输入：只留占位符，绝不加载远程或内嵌文件
  const convertImage = mammoth.images.imgElement(async (image) => {
    let base64 = '';
    try {
      base64 = await image.read('base64');
    } catch {
      warnings.push('有一张嵌入图片无法读取，已跳过。');
      return { src: 'jdt-image:missing' };
    }
    const index = images.length;
    images.push({ name: `图片 ${index + 1}`, dataUrl: `data:${image.contentType};base64,${base64}` });
    return { src: `jdt-image:${index}` };
  });

  let result;
  try {
    result = await mammoth.convertToHtml({ arrayBuffer }, { convertImage });
  } catch (err) {
    throw mapDocxError(err);
  }
  checkAborted(signal);

  for (const message of Array.isArray(result?.messages) ? result.messages : []) {
    const text = String(message?.message || '').trim();
    if (text) warnings.push(`DOCX 解析提示：${text}`);
  }

  const converted = htmlToMarkdown(String(result?.value || ''));
  warnings.push(...converted.warnings);
  if (images.length) {
    warnings.push(`已提取 ${images.length} 张嵌入图片，仅用于本次识别，不会写入知识库。`);
  }
  if (!converted.markdown.trim()) {
    throw new DocumentError('这个 DOCX 里没有可提取的文字（可能是纯图片文档）。请改用图片或 PDF 方式导入。', {
      code: 'no-text',
    });
  }
  return { markdown: converted.markdown, images, warnings: uniq(warnings) };
}
