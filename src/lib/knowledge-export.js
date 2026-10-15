import { cleanReview, emptyReview } from './knowledge-review.js';
/**
 * 知识库的可携带性：版本化 JSON 完整备份/恢复，以及可阅读的 Markdown 导出。
 *
 * 与岗位记录的数据操作完全隔离（design.md §9）：
 * - 导出只按字段白名单取数，不遍历整个 storage，因此不可能带出 API Key、岗位截图或原始文件。
 * - 恢复先完整解析并严格校验（版本、唯一 ID、必要字段、项目归属、分类引用），
 *   校验通过才允许写入；失败、取消、未知版本都不写库。
 * - Markdown 是给人看的；只有 JSON 是完整恢复格式。
 */

import { fmtDateTime, safeFileName } from './util.js';
import {
  describeSource,
  emptyState,
  normalizeState,
  sanitizeSources,
  stateCounts,
  validateState,
} from './knowledge-store.js';

export const BACKUP_FORMAT = 'interview-knowledge-library';
export const BACKUP_VERSION = 2;

/** 岗位备份的格式标识：用来给出"选错文件"的友好提示。 */
const JOB_FORMAT = 'jd-job-tracker';

/* ------------------------------------------------------------------ */
/* JSON 备份                                                           */
/* ------------------------------------------------------------------ */

/* 逐字段取值而不是展开对象：任何未列入白名单的字段都不会进入备份。 */
const pickSource = (s) => {
  const clean = sanitizeSources([s])[0];
  if (!clean) return null;
  return {
    type: clean.type,
    url: clean.url,
    pageTitle: clean.pageTitle,
    fileName: clean.fileName,
    pageNumbers: clean.pageNumbers,
    importedAt: clean.importedAt,
  };
};

const pickSources = (list) => sanitizeSources(list).map(pickSource).filter(Boolean);

const pickProject = (p) => ({
  id: p.id,
  name: p.name,
  summary: p.summary,
  responsibilities: p.responsibilities,
  sources: pickSources(p.sources),
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const pickProjectQuestion = (q) => ({
  id: q.id,
  projectId: q.projectId,
  question: q.question,
  answerMarkdown: q.answerMarkdown,
  sources: pickSources(q.sources),
  aiReferences: (q.aiReferences || []).map((r) => ({
    technicalQuestionId: r.technicalQuestionId,
    questionTitle: r.questionTitle,
    referencedUpdatedAt: r.referencedUpdatedAt,
    generatedAt: r.generatedAt,
  })),
  createdAt: q.createdAt,
  updatedAt: q.updatedAt,
});

const pickTechnicalQuestion = (q) => ({
  id: q.id,
  question: q.question,
  answerMarkdown: q.answerMarkdown,
  categoryId: q.categoryId || '',
  tags: [...(q.tags || [])],
  sources: pickSources(q.sources),
  createdAt: q.createdAt,
  updatedAt: q.updatedAt,
});

/** 导出完整知识库 JSON（两库、分类、标签、来源与 AI 参考关系）。 */
export function toKnowledgeJson(state, now = Date.now()) {
  const data = {
    review: cleanReview(state.review),
    projects: state.projects.map(pickProject),
    projectQuestions: state.projectQuestions.map(pickProjectQuestion),
    technicalQuestions: state.technicalQuestions.map(pickTechnicalQuestion),
    categories: state.categories.map((c) => ({ id: c.id, name: c.name })),
  };
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(now).toISOString(),
      data,
    },
    null,
    2,
  );
}

/**
 * 恢复预校验：解析 + 版本 + 关系完整性。不做任何写入。
 * @returns {{ok:boolean, errors:string[], data?:object, state?:object, counts?:object}}
 */
export function parseBackup(text) {
  let envelope;
  try {
    envelope = JSON.parse(String(text ?? ''));
  } catch (err) {
    return { ok: false, errors: [`文件不是合法的 JSON：${err?.message || err}`] };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['备份文件的内容不是一个 JSON 对象。'] };
  }
  if (envelope.format === JOB_FORMAT || Array.isArray(envelope.records)) {
    return { ok: false, errors: ['这是岗位记录备份，不是知识库备份。请在进度表里导入岗位备份。'] };
  }
  if (envelope.format !== BACKUP_FORMAT) {
    return {
      ok: false,
      errors: [`无法识别的备份格式：${envelope.format === undefined ? '缺少 format 字段' : envelope.format}（期望 ${BACKUP_FORMAT}）。`],
    };
  }
  if (![1, BACKUP_VERSION].includes(envelope.version)) {
    return {
      ok: false,
      errors: [`不支持的知识库备份版本：${envelope.version === undefined ? '缺失' : envelope.version}（当前支持 ${BACKUP_VERSION}）。`],
    };
  }
  const data = envelope.data;
  if (!data || typeof data !== 'object') return { ok: false, errors: ['备份缺少 data 内容。'] };

  for (const key of ['projects', 'projectQuestions', 'technicalQuestions', 'categories']) {
    if (!Array.isArray(data[key])) return { ok: false, errors: [`备份缺少必要数组：${key}`] };
  }

  // 备份里没有 revision（恢复时重新分配），先补齐再走严格校验
  const prepared = {
    schemaVersion: envelope.version,
    review: envelope.version === 1 ? emptyReview() : data.review,
    revision: 0,
    projects: (Array.isArray(data.projects) ? data.projects : []).map((p) => ({ ...p, revision: 1 })),
    projectQuestions: (Array.isArray(data.projectQuestions) ? data.projectQuestions : []).map((q) => ({ ...q, revision: 1 })),
    technicalQuestions: (Array.isArray(data.technicalQuestions) ? data.technicalQuestions : []).map((q) => ({ ...q, revision: 1 })),
    categories: Array.isArray(data.categories) ? data.categories : [],
  };
  const check = validateState(prepared);
  if (!check.ok) return { ok: false, errors: check.errors };
  const state = normalizeState(prepared);
  return { ok: true, errors: [], data, state, counts: stateCounts(state), version: envelope.version };
}

/**
 * 生成恢复用的容器：保留实体 ID 与引用关系，revision 在运行时重新分配。
 * 容器 revision 从当前值继续增长，避免恢复后旧的编辑请求被误判为最新。
 */
export function backupToState(state, { containerRevision = 0 } = {}) {
  const clean = normalizeState(state);
  clean.review.days.forEach(d => { d.revision = Math.max(d.revision, containerRevision) + 1; });
  clean.revision = Math.max(0, Math.floor(Number(containerRevision)) || 0) + 1;
  return clean;
}

export function restorePreviewText(backupCounts, currentCounts) {
  const line = (label, k) => `${label} ${currentCounts[k] || 0} → ${backupCounts[k] || 0}`;
  return [
    '恢复会用备份完整替换当前知识库：',
    line('项目', 'projects'),
    line('项目问答', 'projectQuestions'),
    line('八股文问答', 'technicalQuestions'),
    line('分类', 'categories'),
    line('学习历史天数', 'reviewDays'),
    line('已打卡天数', 'checkIns'),
    line('学习间隔进度', 'reviewProgress'),
    '学习设置、计划和记录也将完整替换；v1 备份不含学习记录，恢复后将清空当前学习记录。',
    '岗位记录、岗位截图与模型设置不受影响。',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Markdown 导出                                                       */
/* ------------------------------------------------------------------ */

/** 元数据注释：以本应用导出的 Markdown 重新导入时可以恢复标签与来源。 */
function metaComment({ tags = [], category = '', sources = [], question, answerLines } = {}) {
  const payload = {};
  if (question !== undefined) {
    payload.question = question;
    payload.answerLines = answerLines;
  }
  if (tags.length) payload.tags = tags;
  if (category) payload.category = category;
  if (sources.length) payload.sources = sources.map(pickSource).filter(Boolean);
  return `<!--jdt:${JSON.stringify(payload)}-->`;
}

/** 人类可读的标签/来源行，放在题目与答案之间，导入时会被当作前言丢弃。 */
function metaLine({ tags = [], sources = [] } = {}) {
  const parts = [];
  if (tags.length) parts.push(`标签：${tags.join('、')}`);
  const src = sources.map(describeSource).filter(Boolean);
  if (src.length) parts.push(`来源：${src.join('；')}`);
  return parts.length ? `> ${parts.join(' ｜ ')}` : '';
}

function questionBlock(q, { tags = [], category = '', sources = [], references = [] } = {}) {
  const answer = String(q.answerMarkdown ?? '');
  const lines = [`### Q: ${q.question.replace(/\r?\n/g, ' ')}`, metaComment({ tags, category, sources, question: q.question, answerLines: answer ? answer.split('\n').length : 0 })];
  const meta = metaLine({ tags, sources });
  if (meta) {
    lines.push(meta);
    lines.push('');
  }
  if (references.length) lines.push(`> AI 参考：${references.join('；')}`, '');
  lines.push('A:');
  if (answer) lines.push(answer);
  lines.push('<!--jdt:{"kind":"answer-end"}-->');
  lines.push('');
  return lines.join('\n');
}

function projectsMarkdown(state, now) {
  const lines = ['<!--jdt:{"kind":"library","version":1,"library":"projects"}-->', '# 项目库', '', `导出于 ${fmtDateTime(now)}，共 ${state.projects.length} 个项目。`, ''];
  for (const p of state.projects) {
    lines.push(`## ${p.name}`);
    if (p.summary) lines.push(p.summary, '');
    if (p.responsibilities) {
      lines.push('**个人职责**', '');
      lines.push(p.responsibilities, '');
    }
    const src = (p.sources || []).map(describeSource).filter(Boolean);
    if (src.length) lines.push(`> 来源：${src.join('；')}`, '');
    const questions = state.projectQuestions.filter((q) => q.projectId === p.id);
    if (!questions.length) lines.push('_暂无问答_', '');
    for (const q of questions) {
      const references = (q.aiReferences || []).map((r) => {
        const current = state.technicalQuestions.find((t) => t.id === r.technicalQuestionId);
        const status = !current ? '（来源不可用）' : current.updatedAt !== r.referencedUpdatedAt ? '（已更新）' : '';
        return `${r.questionTitle || current?.question || r.technicalQuestionId}${status}`;
      });
      lines.push(questionBlock(q, { sources: q.sources || [], references }));
    }
  }
  return lines.join('\n');
}

function technicalMarkdown(state, now) {
  const lines = ['<!--jdt:{"kind":"library","version":1,"library":"technical"}-->', '# 八股文题库', '', `导出于 ${fmtDateTime(now)}，共 ${state.technicalQuestions.length} 题。`, ''];
  const groupOf = (q) => state.categories.find((c) => c.id === q.categoryId)?.name || '未分类';
  const order = [...state.categories.map((c) => c.name), '未分类'];
  const groups = new Map(order.map((name) => [name, []]));
  for (const q of state.technicalQuestions) {
    const name = groupOf(q);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(q);
  }
  for (const [name, questions] of groups) {
    if (!questions.length) continue;
    lines.push(`## ${name}`, '');
    for (const q of questions) {
      lines.push(questionBlock(q, { tags: q.tags || [], category: name, sources: q.sources || [] }));
    }
  }
  return lines.join('\n');
}

/**
 * Markdown 导出。
 * @param {'projects'|'technical'|'both'} library
 */
export function toKnowledgeMarkdown(state, { library = 'both', now = Date.now() } = {}) {
  if (library === 'projects') return projectsMarkdown(state, now);
  if (library === 'technical') return technicalMarkdown(state, now);
  return `${projectsMarkdown(state, now)}\n---\n\n${technicalMarkdown(state, now)}`;
}

export function knowledgeFileName({ library = 'both', ext = 'json', now = Date.now() } = {}) {
  const label = library === 'projects' ? '项目库' : library === 'technical' ? '八股文题库' : '面试知识库';
  const stamp = fmtDateTime(now).replace(/[-: ]/g, '').slice(0, 12);
  return safeFileName(`${label}_${stamp}.${ext}`);
}

/** 空库时给用户的明确提示（导出/恢复都提示，避免生成一个空文件让人困惑）。 */
export function isEmptyLibrary(state) {
  const c = stateCounts(state || emptyState());
  return c.projects + c.projectQuestions + c.technicalQuestions + c.categories + c.reviewDays + c.reviewProgress === 0;
}
