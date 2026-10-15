/**
 * 导入编排：把图片与 Markdown/PDF/DOCX 文件变成"可核对候选"。
 *
 * 分工（design.md §4）：
 * - 解析全在本地完成（pdf.js / mammoth 随扩展分发，不发任何外网请求）；
 * - 模型调用走 background 的 extract-questions / resume-projects 任务；
 * - 清晰 Markdown 与带结构的文档先用确定性分题，没有可识别结构时才调用模型，
 *   因此没有 API Key 也能导入本应用导出的 Markdown。
 *
 * 图片、文件字节与 canvas 只在处理期间存在于内存；处理结束即释放，不写入任何存储。
 */

import { makeCandidate } from '../lib/knowledge-import.js';
import { mergeSources, sanitizeSource } from '../lib/knowledge-store.js';
import { CHUNK_CHARS, DocumentError, chunkText, detectFileKind, loadDocx, loadPdf, splitMarkdownQuestions } from '../lib/knowledge-documents.js';
import { startTask } from './api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 合并模型返回的候选，保持顺序并去掉相同题目。 */
function mergeCandidates(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const c of list || []) {
      const key = String(c.question || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/**
 * 创建一个导入任务。
 * 调用顺序：await job.parse(files, images) → await job.recognize() →
 * 读 job.candidates / job.projects / job.failures；失败单元可用 job.retryFailed() 重试。
 *
 * @param {object} opts
 * @param {'questions'|'resume'} opts.mode
 * @param {'image-upload'|'image-paste'} [opts.imageKind] 图片来源类型
 * @param {function} [opts.onStatus] 进度回调 ({phase, label, page, total})
 */
export function createIngestJob({ mode = 'questions', imageKind = 'image-upload', onStatus = () => {} } = {}) {
  /** 「可重试工作单元」：一次解析结果 + 它负责的识别范围（一页文字块或一张图）。 */
  const tasks = [];
  /** 取消：长任务（多页 PDF、整份文档）随时可以停下来，已保存的问答不受影响。 */
  const controller = new AbortController();
  /** 正在跑的模型任务（用于取消时一起中止请求）。 */
  let activeTask = null;
  let failures = [];
  let candidates = [];
  let projects = [];
  let warnings = [];
  let disposed = false;
  let cancelled = false;

  const assertAlive = () => {
    if (cancelled || controller.signal.aborted) {
      throw new DocumentError('已取消导入。', { code: 'aborted' });
    }
  };

  const status = (payload) => {
    if (disposed) return;
    onStatus(payload);
  };

  /* ---------------- 解析 ---------------- */

  async function addImages(images) {
    images.forEach((img, i) => {
      const source = sanitizeSource({
        type: imageKind,
        pageTitle: img.name || '',
        importedAt: Date.now(),
      });
      tasks.push({
        label: img.name || `图片 ${i + 1}`,
        kind: 'image',
        dataUrl: img.dataUrl,
        sources: [source],
        pageNumbers: [],
      });
    });
  }

  async function addFile(file) {
    const kind = detectFileKind(file.name, file.type);
    const source = (extra = {}) =>
      sanitizeSource({ type: kind === 'markdown' ? 'markdown' : kind, fileName: file.name, importedAt: Date.now(), ...extra });

    if (kind === 'doc') {
      throw new DocumentError(
        `「${file.name}」是旧版 .doc 文件。请在 Word 里另存为 .docx 或导出 PDF 后再导入。`,
        { code: 'legacy-doc' },
      );
    }
    if (kind === 'unknown') {
      throw new DocumentError(`不认识「${file.name}」的格式。支持 Markdown、PDF、DOCX 与图片。`, { code: 'unsupported' });
    }

    if (kind === 'markdown') {
      const text = await file.text();
      tasks.push({ label: file.name, kind: 'text', text, sources: [source()], structured: true, pageNumbers: [] });
      return;
    }

    if (kind === 'pdf') {
      const pdf = await loadPdf(file, {
        signal: controller.signal,
        onProgress: (p) => status({ phase: 'parse', label: file.name, ...p }),
      });
      const textPages = pdf.pages.filter((p) => !p.needsImage && p.text.trim());
      const scanPages = pdf.pages.filter((p) => p.needsImage);
      const firstSource = source({ pageNumbers: [] });
      if (textPages.length) {
        tasks.push({
          label: `${file.name}（文字页）`,
          kind: 'pdf-text',
          pages: textPages,
          pdf,
          sources: [firstSource],
          fileName: file.name,
        });
      }
      for (const page of scanPages) {
        tasks.push({
          label: `${file.name} 第 ${page.pageNumber} 页（扫描页）`,
          kind: 'pdf-scan',
          pdf,
          pageNumber: page.pageNumber,
          sources: [source({ pageNumbers: [page.pageNumber] })],
        });
      }
      if (!textPages.length && !scanPages.length) {
        throw new DocumentError(`「${file.name}」没有可读取的内容。`, { code: 'no-text' });
      }
      warnings.push(
        ...[
          textPages.length ? '' : `「${file.name}」没有可提取的文字，将按扫描页用图像识别。`,
          scanPages.length && textPages.length
            ? `「${file.name}」有 ${scanPages.length} 页没有文字，会按图像识别，页码按原文件记录。`
            : '',
        ].filter(Boolean),
      );
      return;
    }

    if (kind === 'docx') {
      const doc = await loadDocx(file, {
        signal: controller.signal,
        onProgress: (p) => status({ phase: 'parse', label: file.name, ...p }),
      });
      tasks.push({
        label: file.name,
        kind: 'text',
        text: doc.markdown,
        sources: [source()],
        structured: true,
        pageNumbers: [],
      });
      // 正文几乎没有文字、但有嵌入图时，图片才是真正的内容来源
      if (doc.markdown.trim().length < 40 && doc.images.length) {
        for (const img of doc.images.slice(0, 6)) {
          tasks.push({ label: `${file.name}（内嵌图 ${img.name}）`, kind: 'image', dataUrl: img.dataUrl, sources: [source()], pageNumbers: [] });
        }
      }
      warnings.push(...(doc.warnings || []));
    }
  }

  /**
   * 解析文件与图片。单个文件失败只影响它自己，其余照常。
   */
  async function parse(files = [], images = []) {
    warnings = [];
    const problems = [];
    await addImages(images);
    for (const file of files) {
      status({ phase: 'parse', label: file.name, page: 0, total: 0 });
      try {
        await addFile(file);
      } catch (err) {
        problems.push({ label: file.name, message: err?.message || String(err), fatal: err?.code === 'legacy-doc' || err?.code === 'unsupported' });
      }
    }
    failures = problems;
    return { failures, warnings };
  }

  /* ---------------- 识别 ---------------- */

  /**
   * 本地确定性分题：本应用导出的 Markdown 与结构清晰的文档不需要模型。
   * 文件级来源（文件名等）要合并进去，否则本地导入的题会丢掉来源。
   */
  function localSplit(text, baseSources = []) {
    if (!String(text || '').trim()) return [];
    return splitMarkdownQuestions(text).map((c) =>
      makeCandidate({
        question: c.question,
        answerMarkdown: c.answerMarkdown,
        tags: c.tags,
        categoryName: c.categoryName,
        sources: mergeSources(c.sources, baseSources),
      }),
    );
  }

  async function askQuestions({ text, images, fileName, pageNumbers, sources, hint }) {
    assertAlive();
    const task = startTask({
      task: 'extract-questions',
      text: text || '',
      images: images || [],
      fileName: fileName || '',
      pageNumbers: pageNumbers || [],
      sources: sources || [],
      hint: hint || '',
    });
    // 记下正在跑的模型任务：取消导入时要把请求一起中止，否则界面会一直卡着
    activeTask = task;
    try {
      const res = await task.promise;
      return (res.candidates || []).map((c) => makeCandidate(c));
    } finally {
      if (activeTask === task) activeTask = null;
    }
  }

  /**
   * PDF 文字页：先按整篇做确定性分题（跨页题目能合并），
   * 分不出来再分块交给模型，页码按页边界确定。
   */
  async function recognizePdfText(task) {
    const full = task.pages.map((p) => p.text).join('\n\n');
    const local = localSplit(full);
    const offsets = [];
    let cursor = 0;
    for (const p of task.pages) {
      offsets.push({ page: p.pageNumber, start: cursor });
      cursor += p.text.length + 2;
    }
    const pageAt = (idx) => {
      let current = offsets[0]?.page || 1;
      for (const o of offsets) {
        if (idx >= o.start) current = o.page;
        else break;
      }
      return current;
    };
    if (local.length) {
      return local.map((c, i) => {
        const at = full.indexOf(c.question);
        const next = local[i + 1] ? full.indexOf(local[i + 1].question) : full.length;
        const from = pageAt(at === -1 ? 0 : at);
        const to = pageAt(next === -1 ? full.length - 1 : next - 1);
        const pageNumbers = [];
        for (let n = from; n <= to; n += 1) pageNumbers.push(n);
        return {
          ...c,
          sources: mergeSources(c.sources, [
            sanitizeSource({ type: 'pdf', fileName: task.fileName, pageNumbers, importedAt: Date.now() }),
          ]),
        };
      });
    }
    const chunks = chunkText(full, CHUNK_CHARS);
    const out = [];
    for (let i = 0; i < chunks.length; i += 1) {
      status({ phase: 'recognize', label: `${task.label} 第 ${i + 1}/${chunks.length} 块`, page: i + 1, total: chunks.length });
      const pageNumbers = [];
      // 每一块覆盖的页码：按块首尾文字在页里的位置估算
      const from = pageAt(full.indexOf(chunks[i].slice(0, 40)));
      const to = pageAt(full.indexOf(chunks[i].slice(-40)));
      for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) pageNumbers.push(n);
      out.push(
        await askQuestions({
          text: chunks[i],
          sources: [sanitizeSource({ type: 'pdf', fileName: task.fileName, pageNumbers, importedAt: Date.now() })],
          fileName: task.fileName,
          pageNumbers,
          hint: chunks.length > 1 ? `这是一份文档的第 ${i + 1}/${chunks.length} 块，上一块的结尾可能是这段的开头。` : '',
        }),
      );
    }
    return mergeCandidates(out);
  }

  /** 扫描页：渲染成内存图片后交给视觉模型，页码确定。 */
  async function recognizePdfScan(task) {
    const dataUrl = await task.pdf.renderPageImage(task.pageNumber);
    try {
      return await askQuestions({
        images: [dataUrl],
        sources: task.sources,
        fileName: task.label,
        pageNumbers: [task.pageNumber],
        hint: '这是一页扫描的题目图片。',
      });
    } finally {
      // canvas 与 dataURL 都是临时的，识别完立即释放引用
      task.lastRendered = null;
    }
  }

  /** 文字文档（Markdown/DOCX）：先确定性分题，分不出来再交给模型。 */
  async function recognizeText(task) {
    const local = localSplit(task.text, task.sources);
    if (local.length) return local;
    const chunks = chunkText(task.text, CHUNK_CHARS);
    const out = [];
    for (let i = 0; i < chunks.length; i += 1) {
      status({ phase: 'recognize', label: `${task.label} 第 ${i + 1}/${chunks.length} 块`, page: i + 1, total: chunks.length });
      out.push(
        await askQuestions({
          text: chunks[i],
          sources: task.sources,
          fileName: task.label,
          hint: chunks.length > 1 ? `这是一份文档的第 ${i + 1}/${chunks.length} 块。` : '',
        }),
      );
    }
    return mergeCandidates(out);
  }

  async function recognizeImage(task) {
    return askQuestions({
      images: [task.dataUrl],
      sources: task.sources,
      fileName: task.label,
      hint: '这是用户提供的题目图片，一张图里可能有多道题。',
    });
  }

  /** 简历：文字与扫描页一起交给 resume-projects 任务，只产出项目，不产出问答。 */
  async function recognizeResume() {
    const text = tasks
      .filter((t) => t.kind === 'text' || t.kind === 'pdf-text')
      .map((t) => (t.kind === 'text' ? t.text : t.pages.map((p) => p.text).join('\n\n')))
      .join('\n\n');
    const images = [];
    for (const t of tasks) {
      if (t.kind === 'image') images.push(t.dataUrl);
      if (t.kind === 'pdf-scan') images.push(await t.pdf.renderPageImage(t.pageNumber));
    }
    status({ phase: 'recognize', label: '正在提取项目信息', page: 1, total: 1 });
    const task = startTask({
      task: 'resume-projects',
      text,
      images: images.slice(0, 6),
      fileName: tasks.map((t) => t.label).join('、'),
    });
    const res = await task.promise;
    const source = sanitizeSource({ type: 'pdf', fileName: tasks[0]?.label || '', importedAt: Date.now() });
    return (res.projects || []).map((p) => ({
      name: p.name,
      summary: p.summary,
      responsibilities: p.responsibilities,
      sources: [source],
      selected: true,
    }));
  }

  /**
   * 识别所有已解析的单元。失败按单元记录，其它单元的结果照常返回。
   */
  async function recognize() {
    candidates = [];
    projects = [];
    const problems = [];
    if (mode === 'resume') {
      try {
        assertAlive();
        projects = await recognizeResume();
        if (!projects.length) {
          problems.push({ label: '简历', message: '没有从简历里识别到项目信息。可以换一份更完整的简历，或稍后手动新建项目。' });
        }
      } catch (err) {
        problems.push({ label: '简历', message: err?.message || String(err), taskIndex: -1 });
      }
      failures = problems;
      return { candidates, projects, failures };
    }

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      status({ phase: 'recognize', label: task.label, page: i + 1, total: tasks.length });
      try {
        assertAlive();
        let list = [];
        if (task.kind === 'pdf-text') list = await recognizePdfText(task);
        else if (task.kind === 'pdf-scan') list = await recognizePdfScan(task);
        else if (task.kind === 'text') list = await recognizeText(task);
        else if (task.kind === 'image') list = await recognizeImage(task);
        if (!list.length) {
          problems.push({ label: task.label, message: '这一段里没有识别到题目，可以重试或手动录入。', taskIndex: i });
          continue;
        }
        candidates.push(...list);
      } catch (err) {
        problems.push({ label: task.label, message: err?.message || String(err), taskIndex: i, failed: true });
      }
      await sleep(0);
    }
    failures = problems;
    return { candidates, projects, failures };
  }

  /** 只重试上一次识别失败的单元。 */
  async function retryFailed() {
    const retryable = failures.filter((f) => f.taskIndex >= 0);
    if (!retryable.length) return { candidates, failures };
    const problems = failures.filter((f) => f.taskIndex < 0);
    for (const f of retryable) {
      const task = tasks[f.taskIndex];
      status({ phase: 'recognize', label: `重试 ${task.label}`, page: 1, total: 1 });
      try {
        assertAlive();
        let list = [];
        if (task.kind === 'pdf-text') list = await recognizePdfText(task);
        else if (task.kind === 'pdf-scan') list = await recognizePdfScan(task);
        else if (task.kind === 'text') list = await recognizeText(task);
        else if (task.kind === 'image') list = await recognizeImage(task);
        if (!list.length) {
          problems.push({ ...f, message: '重试后仍然没有识别到题目。' });
          continue;
        }
        candidates = mergeCandidates([candidates, list]);
      } catch (err) {
        problems.push({ ...f, message: err?.message || String(err) });
      }
    }
    failures = problems;
    return { candidates, projects, failures };
  }

  /** 取消进行中的解析与识别：正在跑的模型请求也会一起中止，已成功识别的候选仍可单独核对。 */
  function cancel() {
    cancelled = true;
    controller.abort();
    activeTask?.abort();
  }

  /** 释放解析对象（pdf.js 文档句柄）与图片引用。 */
  function dispose() {
    disposed = true;
    cancelled = true;
    controller.abort();
    for (const t of tasks) {
      try {
        t.pdf?.destroy?.();
      } catch {
        /* ignore */
      }
      t.dataUrl = null;
      t.text = '';
      t.pages = null;
    }
    tasks.length = 0;
    candidates = [];
    projects = [];
    failures = [];
  }

  return {
    parse,
    recognize,
    retryFailed,
    cancel,
    dispose,
    get candidates() {
      return candidates;
    },
    get projects() {
      return projects;
    },
    get failures() {
      return failures;
    },
    get warnings() {
      return warnings;
    },
    get taskCount() {
      return tasks.length;
    },
  };
}

/** 网页框选交接过来的候选（纯文本，不带图片）：交给统一的核对界面。 */
export function handoffCandidates(handoff) {
  return (handoff?.candidates || []).map((c) => makeCandidate(c));
}
