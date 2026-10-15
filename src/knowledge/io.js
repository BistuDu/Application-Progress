/**
 * 导入 / 导出 / 恢复的编排：知识库页面里所有"与外界交换数据"的动作都收在这里。
 *
 * - 导入：解析在页面（本地依赖），识别在 background（模型）；
 * - 导出：内容由 background 按白名单生成，页面只负责下载；
 * - 恢复：先预校验 + 展示替换范围，确认后才单次写入。
 */

import { downloadFile } from '../lib/util.js';
import { createIngestJob } from './ingest.js';
import { send } from './api.js';
import { $, clearBanner, esc, qs, setStatus, showBanner, toast } from './ui.js';

/**
 * @param {object} deps
 * @param {Function} deps.getState
 * @param {Function} deps.getSettings
 * @param {Function} deps.reload
 * @param {Function} deps.reviewTechnicalCandidates
 * @param {Function} deps.openProjectReview
 * @param {Function} deps.afterProjectsSaved
 */
export function createIo({ getState, getSettings, reload, reviewTechnicalCandidates, openProjectReview, afterProjectsSaved }) {
  let activeJob = null;

  /* ---------------- 进度与失败提示 ---------------- */

  function updateProgress(s) {
    const detail = $('io-detail');
    const text = describeProgress(s);
    setStatus(text);
    if (detail) detail.textContent = text;
  }

  function describeProgress(s = {}) {
    if (!s.phase) return '';
    if (s.phase === 'parse') return s.total ? `解析 ${s.label} 第 ${s.page}/${s.total} 页` : `解析 ${s.label}`;
    if (s.phase === 'recognize') return `识别 ${s.label}`;
    return s.label || '';
  }

  function startProgress(text) {
    setStatus(text);
    showBanner('info', `${esc(text)} <span class="hint" id="io-detail"></span>`, {
      actions: [
        {
          label: '取消',
          onClick: () => {
            activeJob?.cancel();
            toast('正在取消导入…', { ms: 2500 });
          },
        },
      ],
    });
  }

  function endProgress() {
    clearBanner();
    setStatus('');
  }

  /** 失败提示：可重试的给一个「重试失败页」按钮，不静默截断。 */
  function showFailures(failures, retry) {
    if (!failures.length) return;
    const lines = failures.slice(0, 3).map((f) => `${f.label}：${f.message}`);
    const more = failures.length > 3 ? ` 等 ${failures.length} 项` : '';
    const retryable = failures.some((f) => f.taskIndex >= 0);
    showBanner('err', `${esc(lines.join('；'))}${esc(more)}${retryable ? ' 已成功的部分仍可单独核对保存。' : ''}`, {
      actions: retryable
        ? [
            {
              label: '重试失败页',
              onClick: async () => {
                startProgress('正在重试失败页');
                try {
                  const out = await activeJob?.retryFailed();
                  endProgress();
                  if (out?.candidates?.length) {
                    reviewTechnicalCandidates(out.candidates, {
                      title: '重试结果核对',
                      intro: `重试后共 ${out.candidates.length} 条候选。`,
                    });
                  }
                  showFailures(out?.failures || [], retry);
                } catch (err) {
                  endProgress();
                  showBanner('err', `重试失败：${esc(err?.message || String(err))}`);
                }
              },
            },
          ]
        : [],
    });
  }

  /* ---------------- 导入 ---------------- */

  let warnings = [];

  async function runIngest({ mode, files = [], images = [], imageKind = 'image-upload', label }) {
    if (activeJob) {
      toast('上一个导入还在进行中，请等它结束或先取消。', { type: 'err' });
      return;
    }
    const job = createIngestJob({ mode, imageKind, onStatus: updateProgress });
    activeJob = job;
    startProgress(`正在读取 ${label}`);

    let parseFailures = [];
    try {
      const parsed = await job.parse(files, images);
      parseFailures = parsed.failures || [];
      // 解析提示攒着一起在结束后展示：中途换掉进度条会丢掉「取消」按钮，长任务就没法中止了
      warnings = (parsed.warnings || []).filter(Boolean);
      if (!job.taskCount) {
        endProgress();
        showBanner('err', `${esc(parseFailures.map((f) => `${f.label}：${f.message}`).join('；') || '没有可导入的内容。')}`);
        job.dispose();
        activeJob = null;
        return;
      }
      if (warnings.length) setStatus(warnings.join(' '));

      let result;
      try {
        result = await job.recognize();
      } catch (err) {
        endProgress();
        const partial = job.candidates || [];
        if (partial.length) {
          showBanner('warn', `导入已取消，但已经识别出 ${partial.length} 条候选，可以单独核对保存。`);
          reviewTechnicalCandidates(partial, {
            title: '已识别候选核对',
            intro: '导入被取消，这里是取消前已经识别成功的候选。',
          });
        } else {
          showBanner('warn', `导入已停止：${esc(err?.message || String(err))}`);
        }
        job.dispose();
        activeJob = null;
        return;
      }
      endProgress();

      if (mode === 'resume') {
        if (result.projects.length) {
          openProjectReviewInternal(result.projects);
        } else {
          showBanner('err', '没有从简历里识别到项目信息。可以换一份更完整的 PDF／DOCX 简历，或手动新建项目。');
        }
      } else if (result.candidates.length) {
        const mustReview = '识别结果需要逐条核对后才会写入题库；重复题会让你选择保留、采用或合并。';
        reviewTechnicalCandidates(result.candidates, {
          title: '核对导入的题目',
          intro: `从 ${label} 得到 ${result.candidates.length} 条候选。${mustReview}`,
        });
      } else {
        showBanner('warn', `没有从 ${esc(label)} 里识别到题目。可以换一份文件，或手动录入。`);
      }
      if (warnings.length && !result.candidates.length && !result.projects.length) {
        showBanner('warn', esc(warnings.join(' ')));
      }
      showFailures([...parseFailures, ...result.failures], null);
    } catch (err) {
      endProgress();
      showBanner('err', `导入失败：${esc(err?.message || String(err))}`);
    } finally {
      activeJob = null;
      // 处理结束即释放文件句柄、canvas 与 dataURL 引用
      job.dispose();
    }
  }

  function openProjectReviewInternal(projects) {
    openProjectReview({
      title: '核对简历提取的项目',
      intro: `从简历里提取到 ${projects.length} 个项目候选，只会保存你选中的项目。`,
      projects,
      onCommit: (payload) => send({ type: 'KNOWLEDGE_APPLY', op: 'projects.commit', payload }),
      onCommitDone: async () => {
        await afterProjectsSaved?.();
      },
    });
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`读取图片失败：${file.name || ''}`));
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片无法解码，可能是文件损坏或格式不支持。'));
      img.src = src;
    });
  }

  /**
   * 上传/粘贴的图片先按设置里的「最长边 / 质量」压缩再送识别：
   * 手机原图动辄好几 MB，直接发又慢又贵；压缩只发生在内存里，不写任何存储。
   */
  async function fileToImage(file, { maxSide, quality } = {}) {
    const name = file?.name || '粘贴的图片';
    const raw = await readAsDataUrl(file);
    if (!/^data:image\//i.test(raw)) return { name, dataUrl: raw };
    try {
      const img = await loadImageElement(raw);
      const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
      const limit = Number(maxSide) || 1800;
      if (longest <= limit) return { name, dataUrl: raw };
      const scale = limit / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', Number(quality) || 0.9);
      canvas.width = 0;
      canvas.height = 0;
      return { name, dataUrl: out, compressed: true };
    } catch {
      // 解不开的图片交给识别流程报错，不在这里吞掉
      return { name, dataUrl: raw };
    }
  }

  /* ---------------- 导出 ---------------- */

  async function exportLibrary(library) {
    const res = await send({ type: 'KNOWLEDGE_EXPORT', library });
    if (!res.ok) {
      toast(res.error || '导出失败。', { type: 'err', ms: 5000 });
      return;
    }
    downloadFile(res.filename, res.content, res.mime);
    toast(`已导出 ${res.filename}`, { type: 'ok' });
  }

  /* ---------------- 恢复 ---------------- */

  async function restoreFromFile(file) {
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      toast(`读取文件失败：${err?.message || err}`, { type: 'err' });
      return;
    }
    const res = await send({ type: 'KNOWLEDGE_RESTORE', text, confirm: false });
    if (!res.ok) {
      showBanner('err', `无法恢复：${esc(res.error || '备份内容无效')}`);
      toast('备份文件无法恢复，当前知识库没有变化。', { type: 'err', ms: 6000 });
      return;
    }
    openRestorePanel({ preview: res.preview, counts: res.counts, currentCounts: res.currentCounts, containerRevision: res.containerRevision, text });
  }

  function openRestorePanel({ preview, counts, currentCounts, containerRevision, text }) {
    const host = $('restore-panel');
    host.hidden = false;
    const stat = (label, k) => `${label}：${currentCounts?.[k] ?? 0} → ${counts?.[k] ?? 0}`;
    host.innerHTML = `<div class="modal-card narrow">
      <div class="m-head"><h2>恢复知识库</h2><span class="chip">完整替换</span></div>
      <div class="m-body">
        <div class="banner banner-warn"><span>⚠️</span><div>
          恢复会用备份完整替换当前知识库（${esc(stat('项目', 'projects'))}；${esc(stat('项目问答', 'projectQuestions'))}；${esc(stat('八股文问答', 'technicalQuestions'))}；${esc(stat('分类', 'categories'))}）。
          岗位记录、岗位截图与模型设置不会被修改。
        </div></div>
        <div class="sec"><div class="sec-title"><span>将恢复的内容</span></div>
          <div class="hint" style="white-space:pre-wrap">${esc(preview || '')}</div></div>
        <div class="sec"><div class="sec-title"><span>建议</span></div>
          <button class="btn btn-sm" id="rs-download">先下载当前知识库备份</button>
          <span class="hint">恢复前先留一份当前内容的 JSON，万一选错文件也能回来。</span></div>
        <div class="hint" id="rs-hint"></div>
      </div>
      <div class="m-foot"><span class="grow"></span>
        <button class="btn" id="rs-cancel">取消</button>
        <button class="btn btn-primary" id="rs-confirm">确认恢复</button>
      </div>
    </div>`;

    qs(host, '#rs-cancel').addEventListener('click', () => {
      host.hidden = true;
      host.innerHTML = '';
      toast('已取消恢复，当前知识库保持不变。');
    });
    qs(host, '#rs-download').addEventListener('click', () => exportLibrary('json'));
    qs(host, '#rs-confirm').addEventListener('click', async () => {
      const btn = qs(host, '#rs-confirm');
      btn.disabled = true;
      btn.textContent = '恢复中…';
      const res = await send({ type: 'KNOWLEDGE_RESTORE', text, confirm: true, baseRevision: containerRevision });
      btn.disabled = false;
      btn.textContent = '确认恢复';
      if (!res.ok) {
        qs(host, '#rs-hint').innerHTML = `<b style="color:#dc2626">恢复失败：</b>${esc(res.error || '未知错误')}。当前知识库保持不变。`;
        toast(`恢复失败：${res.error || '未知错误'}`, { type: 'err', ms: 6000 });
        return;
      }
      host.hidden = true;
      host.innerHTML = '';
      await reload();
      toast(`已恢复知识库：${res.counts.projects} 个项目、${res.counts.technicalQuestions} 道八股文`, { type: 'ok' });
    });
  }

  /* ---------------- 统一入口 ---------------- */

  async function run(kind) {
    if (kind === 'json') return exportLibrary('json');
    if (kind === 'md-projects') return exportLibrary('projects');
    if (kind === 'md-technical') return exportLibrary('technical');
    if (kind === 'md-both') return exportLibrary('both');
    if (kind === 'restore') {
      $('file-restore').click();
      return undefined;
    }
    return undefined;
  }

  async function importDocuments(files) {
    await runIngest({ mode: 'questions', files, label: files.map((f) => f.name).join('、') });
  }

  async function importImages(files, imageKind = 'image-upload') {
    let images = [];
    try {
      const settings = getSettings() || {};
      images = [];
      for (const file of files) {
        images.push(await fileToImage(file, { maxSide: settings.cropMaxSide, quality: settings.cropQuality }));
      }
    } catch (err) {
      toast(err?.message || '图片读取失败。', { type: 'err' });
      return;
    }
    if (!images.length) {
      toast('没有读到图片内容，请重新选择或粘贴。', { type: 'err' });
      return;
    }
    await runIngest({ mode: 'questions', images, imageKind, label: `${images.length} 张图片` });
  }

  async function importResume(file) {
    await runIngest({ mode: 'resume', files: [file], label: file.name });
  }

  return {
    run,
    importDocuments,
    importImages,
    importResume,
    restoreFromFile,
    exportLibrary,
    cancel: () => activeJob?.cancel(),
    get job() {
      return activeJob;
    },
  };
}
