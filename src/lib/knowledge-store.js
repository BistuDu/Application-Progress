/**
 * 知识库存储层：chrome.storage.local 里的单个版本化容器 `knowledgeLibrary`。
 *
 * 容器结构（design.md §2）：
 *   { schemaVersion, revision, projects[], projectQuestions[], technicalQuestions[], categories[], review }
 *
 * 设计要点：
 * - 独立于岗位记录（records）与设置（settings），互不影响。
 * - 所有写入都经过字段白名单，只保存整理后的文本：模型参数、原文件、base64 图片、
 *   完整响应、临时提示词、API Key 都不可能进入容器。
 * - 每题只保存一份 answerMarkdown；AI 引用只存元数据，不存参考答案副本。
 * - 本模块是纯数据层：读写在 chrome.storage，变更全部由 applyOp 纯函数完成，
 *   便于在 Node 里用 storage 替身做离线验证。
 */

import { uid, uniq } from './util.js';
import { emptyReview, cleanReview, validateReview, reconcileReview, reviewOp } from './knowledge-review.js';

export const KNOWLEDGE_KEY = 'knowledgeLibrary';
export const SCHEMA_VERSION = 2;

/** 只有这些来源类型可以入库。 */
export const SOURCE_TYPES = ['manual', 'web-region', 'image-upload', 'image-paste', 'markdown', 'pdf', 'docx'];

export const MAX_SOURCES = 20;
export const MAX_TAGS = 30;
export const MAX_PAGES = 200;

export class KnowledgeError extends Error {
  constructor(message, { code = 'invalid', detail = '' } = {}) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
    this.detail = detail;
  }
}

export function knowledgeFail(message, code = 'invalid', detail = '') {
  return new KnowledgeError(message, { code, detail });
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const str = (v, max = 0) => {
  const s = String(v ?? '').trim();
  return max && s.length > max ? s.slice(0, max) : s;
};

const ts = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const uniqueId = (taken, prefix) => {
  let id = uid(prefix);
  while (taken.has(id)) id = uid(prefix);
  taken.add(id);
  return id;
};

/* ------------------------------------------------------------------ */
/* 字段白名单                                                          */
/* ------------------------------------------------------------------ */

/** 来源：只记可确定的信息，不存原始附件。未知页码留空。 */
export function sanitizeSource(input) {
  if (!input || typeof input !== 'object') return null;
  const type = SOURCE_TYPES.includes(input.type) ? input.type : 'manual';
  const url = /^https?:\/\//i.test(String(input.url || '')) ? str(input.url, 2000) : '';
  const pageTitle = str(input.pageTitle, 300);
  const fileName = str(input.fileName, 200);
  const pageNumbers = uniq(
    (Array.isArray(input.pageNumbers) ? input.pageNumbers : [])
      .map((n) => Math.floor(Number(n)))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_PAGES),
  )
    .sort((a, b) => a - b)
    .slice(0, MAX_PAGES);
  const source = {
    type,
    url,
    pageTitle,
    fileName,
    pageNumbers,
    importedAt: ts(input.importedAt, Date.now()),
  };
  // 完全空的手工来源没有信息量，但 manual 仍保留（用户可补充）
  if (type === 'manual' && !url && !pageTitle && !fileName && !pageNumbers.length) return source;
  return source;
}

export function sanitizeSources(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = sanitizeSource(raw);
    if (!s) continue;
    const key = sourceKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function sourceKey(s) {
  return [s.type, s.url, s.fileName, s.pageTitle, s.pageNumbers.join(',')].join('|');
}

/** 合并两组来源并去重（重复题更新时保留必要来源）。 */
export function mergeSources(...lists) {
  return sanitizeSources(lists.flat().filter(Boolean));
}

const SOURCE_LABEL = {
  manual: '手工录入',
  'web-region': '网页框选',
  'image-upload': '上传图片',
  'image-paste': '粘贴图片',
  markdown: 'Markdown 文件',
  pdf: 'PDF 文件',
  docx: 'DOCX 文件',
};

/** 来源的一句话描述：列表、核对界面与 Markdown 导出共用。 */
export function describeSource(s) {
  if (!s || typeof s !== 'object') return '';
  const parts = [SOURCE_LABEL[s.type] || s.type || '未知来源'];
  if (s.fileName) parts.push(`《${s.fileName}》`);
  if (s.pageNumbers?.length) parts.push(`第 ${s.pageNumbers.join('、')} 页`);
  if (s.pageTitle) parts.push(s.pageTitle);
  if (s.url) parts.push(s.url);
  return parts.join(' · ');
}

export function sanitizeTags(list) {
  return uniq((Array.isArray(list) ? list : []).map((t) => str(t, 40)).filter(Boolean)).slice(0, MAX_TAGS);
}

export function sanitizeAiReferences(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const technicalQuestionId = str(raw.technicalQuestionId, 120);
    if (!technicalQuestionId || seen.has(technicalQuestionId)) continue;
    seen.add(technicalQuestionId);
    out.push({
      technicalQuestionId,
      questionTitle: str(raw.questionTitle, 300),
      referencedUpdatedAt: ts(raw.referencedUpdatedAt, 0),
      generatedAt: ts(raw.generatedAt, Date.now()),
    });
  }
  return out.slice(0, 50);
}

/* ------------------------------------------------------------------ */
/* 容器与实体                                                          */
/* ------------------------------------------------------------------ */

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    projects: [],
    projectQuestions: [],
    technicalQuestions: [],
    categories: [],
    review: emptyReview(),
  };
}

const emptyArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 宽松归一化：用于读取本地容器。
 * 关系不成立的实体被丢弃（未知 projectId 的项目问答、未知分类）而不是让整个库失效，
 * 这样单条脏数据不会让用户的知识库打不开。恢复备份走严格校验 validateState。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  if (raw.schemaVersion !== undefined && ![1, 2].includes(raw.schemaVersion)) throw knowledgeFail('不支持的知识库版本，请使用兼容的新版扩展。');
  const state = emptyState();
  state.review = cleanReview(raw.review);
  state.revision = Math.max(0, Math.floor(Number(raw.revision)) || 0);

  const projectIds = new Set();
  for (const p of emptyArray(raw.projects)) {
    if (!p || typeof p !== 'object') continue;
    const name = str(p.name, 200);
    const id = str(p.id, 120) || uid('prj');
    if (!name || projectIds.has(id)) continue;
    projectIds.add(id);
    state.projects.push({
      id,
      name,
      summary: str(p.summary, 20000),
      responsibilities: str(p.responsibilities, 20000),
      sources: sanitizeSources(p.sources),
      createdAt: ts(p.createdAt, Date.now()),
      updatedAt: ts(p.updatedAt, ts(p.createdAt, Date.now())),
      revision: Math.max(1, Math.floor(Number(p.revision)) || 1),
    });
  }

  const categoryIds = new Set();
  for (const c of emptyArray(raw.categories)) {
    if (!c || typeof c !== 'object') continue;
    const name = str(c.name, 100);
    const id = str(c.id, 120) || uid('cat');
    if (!name || categoryIds.has(id)) continue;
    categoryIds.add(id);
    state.categories.push({ id, name });
  }

  const questionIds = new Set();
  for (const q of emptyArray(raw.projectQuestions)) {
    if (!q || typeof q !== 'object') continue;
    const question = str(q.question, 2000);
    const id = str(q.id, 120) || uid('pq');
    const projectId = str(q.projectId, 120);
    if (!question || questionIds.has(id) || !projectIds.has(projectId)) continue;
    questionIds.add(id);
    state.projectQuestions.push({
      id,
      projectId,
      question,
      answerMarkdown: String(q.answerMarkdown ?? ''),
      sources: sanitizeSources(q.sources),
      aiReferences: sanitizeAiReferences(q.aiReferences),
      createdAt: ts(q.createdAt, Date.now()),
      updatedAt: ts(q.updatedAt, ts(q.createdAt, Date.now())),
      revision: Math.max(1, Math.floor(Number(q.revision)) || 1),
    });
  }

  for (const q of emptyArray(raw.technicalQuestions)) {
    if (!q || typeof q !== 'object') continue;
    const question = str(q.question, 2000);
    const id = str(q.id, 120) || uid('tq');
    if (!question || questionIds.has(id)) continue;
    questionIds.add(id);
    const categoryId = str(q.categoryId, 120);
    state.technicalQuestions.push({
      id,
      question,
      answerMarkdown: String(q.answerMarkdown ?? ''),
      categoryId: categoryIds.has(categoryId) ? categoryId : '',
      tags: sanitizeTags(q.tags),
      sources: sanitizeSources(q.sources),
      createdAt: ts(q.createdAt, Date.now()),
      updatedAt: ts(q.updatedAt, ts(q.createdAt, Date.now())),
      revision: Math.max(1, Math.floor(Number(q.revision)) || 1),
    });
  }

  state.review = reconcileReview(state.review, state.technicalQuestions);
  return state;
}

/**
 * 严格校验：用于恢复备份前的预校验与自检。
 * 任意一条关系不成立都算失败，不做静默修复。
 */
export function validateState(raw) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['备份内容不是一个 JSON 对象。'], counts: null };
  }
  if (![1, SCHEMA_VERSION].includes(raw.schemaVersion)) {
    fail(`不支持的格式版本：${raw.schemaVersion === undefined ? '缺失' : raw.schemaVersion}（当前支持 ${SCHEMA_VERSION}）。`);
  }
  for (const key of ['projects', 'projectQuestions', 'technicalQuestions', 'categories']) {
    if (!Array.isArray(raw[key])) fail(`缺少或格式不对的字段：${key} 应为数组。`);
  }
  if (errors.length) return { ok: false, errors, counts: null };

  const ids = new Set();
  const claim = (id, where) => {
    if (!id || typeof id !== 'string') {
      fail(`${where} 缺少有效 id。`);
      return false;
    }
    if (ids.has(id)) {
      fail(`id 重复：${id}。`);
      return false;
    }
    ids.add(id);
    return true;
  };

  const projectIds = new Set();
  raw.projects.forEach((p, i) => {
    if (!p || typeof p !== 'object') return fail(`第 ${i + 1} 个项目不是对象。`);
    if (!claim(p.id, `第 ${i + 1} 个项目`)) return;
    projectIds.add(p.id);
    if (!str(p.name)) fail(`项目 ${p.id} 名称为空。`);
    if (!Array.isArray(p.sources)) fail(`项目 ${p.id} 的 sources 应为数组。`);
  });

  const categoryIds = new Set();
  raw.categories.forEach((c, i) => {
    if (!c || typeof c !== 'object') return fail(`第 ${i + 1} 个分类不是对象。`);
    if (!claim(c.id, `第 ${i + 1} 个分类`)) return;
    categoryIds.add(c.id);
    if (!str(c.name)) fail(`分类 ${c.id} 名称为空。`);
  });

  raw.projectQuestions.forEach((q, i) => {
    if (!q || typeof q !== 'object') return fail(`第 ${i + 1} 条项目问答不是对象。`);
    if (!claim(q.id, `第 ${i + 1} 条项目问答`)) return;
    if (!str(q.question)) fail(`项目问答 ${q.id} 题目为空。`);
    if (typeof q.answerMarkdown !== 'string') fail(`项目问答 ${q.id} 的答案必须是字符串。`);
    if (!projectIds.has(str(q.projectId))) fail(`项目问答 ${q.id} 指向不存在的项目 ${q.projectId || '(空)'}。`);
  });

  raw.technicalQuestions.forEach((q, i) => {
    if (!q || typeof q !== 'object') return fail(`第 ${i + 1} 条八股文问答不是对象。`);
    if (!claim(q.id, `第 ${i + 1} 条八股文问答`)) return;
    if (!str(q.question)) fail(`八股文问答 ${q.id} 题目为空。`);
    if (typeof q.answerMarkdown !== 'string') fail(`八股文问答 ${q.id} 的答案必须是字符串。`);
    if (q.categoryId && !categoryIds.has(q.categoryId)) fail(`八股文问答 ${q.id} 指向不存在的分类 ${q.categoryId}。`);
    if (q.tags !== undefined && !Array.isArray(q.tags)) fail(`八股文问答 ${q.id} 的 tags 应为数组。`);
  });

  if (raw.schemaVersion === 2) errors.push(...validateReview(raw.review).errors);
  const counts = {
    projects: raw.projects.length,
    projectQuestions: raw.projectQuestions.length,
    technicalQuestions: raw.technicalQuestions.length,
    categories: raw.categories.length,
  };
  return { ok: errors.length === 0, errors, counts };
}

export function stateCounts(state) {
  return {
    projects: state.projects.length,
    projectQuestions: state.projectQuestions.length,
    technicalQuestions: state.technicalQuestions.length,
    categories: state.categories.length,
    reviewDays: state.review?.days.length || 0,
    checkIns: state.review?.days.filter(d => d.completedAt).length || 0,
    reviewProgress: state.review?.progress.length || 0,
  };
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

/** 首次读取时返回空容器，不写库（只有用户首次保存或确认恢复才写入）。 */
export async function loadState() {
  const { [KNOWLEDGE_KEY]: raw } = await chrome.storage.local.get(KNOWLEDGE_KEY);
  if (raw == null) return emptyState();
  return normalizeState(raw);
}

export async function saveState(state) {
  await chrome.storage.local.set({ [KNOWLEDGE_KEY]: state });
  return state;
}

/* ------------------------------------------------------------------ */
/* 变更（纯函数）                                                      */
/* ------------------------------------------------------------------ */

function bump(state) {
  return { ...state, revision: (Math.floor(Number(state.revision)) || 0) + 1 };
}

function findOrThrow(list, id, label) {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) throw knowledgeFail(`${label}不存在，可能已被删除或尚未同步。`, 'not-found');
  return idx;
}

/** 修改/删除前校验实体 revision，避免两个页面同时编辑时悄悄覆盖新内容。 */
function checkRevision(entity, expected, label) {
  if (expected === undefined || expected === null) return;
  const want = Math.floor(Number(expected));
  if (!Number.isFinite(want)) return;
  if (want !== entity.revision) {
    throw knowledgeFail(`${label}已被其他页面修改，请重新核对后再保存。`, 'conflict', `期望 revision ${want}，当前 ${entity.revision}`);
  }
}

function requireQuestionText(text, label) {
  const q = str(text, 2000);
  if (!q) throw knowledgeFail(`${label}不能为空。`, 'empty-question');
  return q;
}

const projectSources = (input) => sanitizeSources(input?.sources);

/* ---- 项目 ---- */

export function createProject(state, input = {}, now = Date.now()) {
  const name = str(input.name, 200);
  if (!name) throw knowledgeFail('项目名称不能为空。', 'invalid');
  const taken = new Set(state.projects.map((p) => p.id));
  const project = {
    id: uniqueId(taken, 'prj'),
    name,
    summary: str(input.summary, 20000),
    responsibilities: str(input.responsibilities, 20000),
    sources: projectSources(input),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const next = bump(state);
  next.projects = [...next.projects, project];
  return { state: next, project };
}

export function updateProject(state, id, patch = {}, now = Date.now()) {
  const idx = findOrThrow(state.projects, id, '项目');
  const prev = state.projects[idx];
  checkRevision(prev, patch.revision, '该项目');
  const name = patch.name === undefined ? prev.name : str(patch.name, 200);
  if (!name) throw knowledgeFail('项目名称不能为空。', 'invalid');
  const nextProject = {
    ...prev,
    name,
    summary: patch.summary === undefined ? prev.summary : str(patch.summary, 20000),
    responsibilities:
      patch.responsibilities === undefined ? prev.responsibilities : str(patch.responsibilities, 20000),
    sources: patch.sources === undefined ? prev.sources : projectSources(patch),
    updatedAt: now,
    revision: prev.revision + 1,
  };
  const next = bump(state);
  next.projects = state.projects.map((p, i) => (i === idx ? nextProject : p));
  return { state: next, project: nextProject };
}

/** 删除项目：连同其项目问答一起删除，不动其他项目、八股文与岗位记录。 */
export function deleteProject(state, id, { revision } = {}, now = Date.now()) {
  const idx = findOrThrow(state.projects, id, '项目');
  checkRevision(state.projects[idx], revision, '该项目');
  const next = bump(state);
  next.projects = state.projects.filter((p) => p.id !== id);
  const removed = state.projectQuestions.filter((q) => q.projectId === id);
  next.projectQuestions = state.projectQuestions.filter((q) => q.projectId !== id);
  void now;
  return { state: next, removedQuestions: removed.length };
}

/* ---- 项目问答 ---- */

export function createProjectQuestion(state, input = {}, now = Date.now()) {
  const question = requireQuestionText(input.question, '题目');
  const projectId = str(input.projectId, 120);
  if (!state.projects.some((p) => p.id === projectId)) {
    throw knowledgeFail('题目必须归属到已存在的项目。', 'bad-project');
  }
  const taken = new Set(state.projectQuestions.map((q) => q.id));
  const entity = {
    id: uniqueId(taken, 'pq'),
    projectId,
    question,
    answerMarkdown: String(input.answerMarkdown ?? ''),
    sources: sanitizeSources(input.sources),
    aiReferences: sanitizeAiReferences(input.aiReferences),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const next = bump(state);
  next.projectQuestions = [...next.projectQuestions, entity];
  return { state: next, question: entity };
}

export function updateProjectQuestion(state, id, patch = {}, now = Date.now()) {
  const idx = findOrThrow(state.projectQuestions, id, '题目');
  const prev = state.projectQuestions[idx];
  checkRevision(prev, patch.revision, '该题目');
  const question = patch.question === undefined ? prev.question : requireQuestionText(patch.question, '题目');
  const projectId = patch.projectId === undefined ? prev.projectId : str(patch.projectId, 120);
  if (!state.projects.some((p) => p.id === projectId)) {
    throw knowledgeFail('题目必须归属到已存在的项目。', 'bad-project');
  }
  const nextEntity = {
    ...prev,
    projectId,
    question,
    answerMarkdown: patch.answerMarkdown === undefined ? prev.answerMarkdown : String(patch.answerMarkdown ?? ''),
    sources: patch.sources === undefined ? prev.sources : sanitizeSources(patch.sources),
    aiReferences: patch.aiReferences === undefined ? prev.aiReferences : sanitizeAiReferences(patch.aiReferences),
    updatedAt: now,
    revision: prev.revision + 1,
  };
  const next = bump(state);
  next.projectQuestions = state.projectQuestions.map((q, i) => (i === idx ? nextEntity : q));
  return { state: next, question: nextEntity };
}

export function deleteProjectQuestion(state, id, { revision } = {}) {
  const idx = findOrThrow(state.projectQuestions, id, '题目');
  checkRevision(state.projectQuestions[idx], revision, '该题目');
  const next = bump(state);
  next.projectQuestions = state.projectQuestions.filter((q) => q.id !== id);
  return { state: next };
}

/* ---- 八股文问答 ---- */

export function createTechnicalQuestion(state, input = {}, now = Date.now()) {
  const question = requireQuestionText(input.question, '题目');
  const categoryId = str(input.categoryId, 120);
  if (categoryId && !state.categories.some((c) => c.id === categoryId)) {
    throw knowledgeFail('题目引用了不存在的分类。', 'bad-category');
  }
  const taken = new Set(state.technicalQuestions.map((q) => q.id));
  const entity = {
    id: uniqueId(taken, 'tq'),
    question,
    answerMarkdown: String(input.answerMarkdown ?? ''),
    categoryId,
    tags: sanitizeTags(input.tags),
    sources: sanitizeSources(input.sources),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const next = bump(state);
  next.technicalQuestions = [...next.technicalQuestions, entity];
  return { state: next, question: entity };
}

export function updateTechnicalQuestion(state, id, patch = {}, now = Date.now()) {
  const idx = findOrThrow(state.technicalQuestions, id, '题目');
  const prev = state.technicalQuestions[idx];
  checkRevision(prev, patch.revision, '该题目');
  const question = patch.question === undefined ? prev.question : requireQuestionText(patch.question, '题目');
  const categoryId = patch.categoryId === undefined ? prev.categoryId : str(patch.categoryId, 120);
  if (categoryId && !state.categories.some((c) => c.id === categoryId)) {
    throw knowledgeFail('题目引用了不存在的分类。', 'bad-category');
  }
  const nextEntity = {
    ...prev,
    question,
    answerMarkdown: patch.answerMarkdown === undefined ? prev.answerMarkdown : String(patch.answerMarkdown ?? ''),
    categoryId,
    tags: patch.tags === undefined ? prev.tags : sanitizeTags(patch.tags),
    sources: patch.sources === undefined ? prev.sources : sanitizeSources(patch.sources),
    updatedAt: now,
    revision: prev.revision + 1,
  };
  const next = bump(state);
  next.technicalQuestions = state.technicalQuestions.map((q, i) => (i === idx ? nextEntity : q));
  return { state: next, question: nextEntity };
}

export function deleteTechnicalQuestion(state, id, { revision } = {}) {
  const idx = findOrThrow(state.technicalQuestions, id, '题目');
  checkRevision(state.technicalQuestions[idx], revision, '该题目');
  const next = bump(state);
  next.technicalQuestions = state.technicalQuestions.filter((q) => q.id !== id);
  // 已保存的项目答案保留，只是引用变成"不可用"（读取时按 id 查不到即为失效）
  return { state: next };
}

/* ---- 分类 ---- */

export function createCategory(state, input = {}) {
  const name = str(input?.name, 100);
  if (!name) throw knowledgeFail('分类名称不能为空。', 'invalid');
  if (state.categories.some((c) => c.name === name)) {
    throw knowledgeFail('已经有同名分类了。', 'duplicate-category');
  }
  const taken = new Set(state.categories.map((c) => c.id));
  const category = { id: uniqueId(taken, 'cat'), name };
  const next = bump(state);
  next.categories = [...next.categories, category];
  return { state: next, category };
}

export function renameCategory(state, id, name) {
  const idx = findOrThrow(state.categories, id, '分类');
  const nextName = str(name, 100);
  if (!nextName) throw knowledgeFail('分类名称不能为空。', 'invalid');
  if (state.categories.some((c) => c.id !== id && c.name === nextName)) {
    throw knowledgeFail('已经有同名分类了。', 'duplicate-category');
  }
  const next = bump(state);
  next.categories = state.categories.map((c, i) => (i === idx ? { ...c, name: nextName } : c));
  return { state: next, category: next.categories[idx] };
}

/** 删除分类：其题目转为"未分类"，其他分类与标签不变。 */
export function deleteCategory(state, id) {
  findOrThrow(state.categories, id, '分类');
  const next = bump(state);
  next.categories = state.categories.filter((c) => c.id !== id);
  const moved = state.technicalQuestions.filter((q) => q.categoryId === id).length;
  next.technicalQuestions = state.technicalQuestions.map((q) => (q.categoryId === id ? { ...q, categoryId: '' } : q));
  return { state: next, movedToUncategorized: moved };
}

/* ------------------------------------------------------------------ */
/* 批量提交（核对后的候选，一次性写入）                                */
/* ------------------------------------------------------------------ */

/**
 * 简历提取后的项目批量写入：一次容器写入，避免出现"存了一半"的项目列表。
 * 只写用户选中并核对过的项目。
 */
export function commitProjects(state, plan = {}, now = Date.now()) {
  const incoming = Array.isArray(plan.projects) ? plan.projects : [];
  let next = state;
  let added = 0;
  for (const p of incoming) {
    if (p?.selected === false) continue;
    const out = createProject(
      next,
      { name: p?.name, summary: p?.summary, responsibilities: p?.responsibilities, sources: p?.sources },
      now,
    );
    next = out.state;
    added += 1;
  }
  return { state: next, counts: { added } };
}

/**
 * 把已核对、已解决冲突的候选一次性写入正式库。
 * 任何一条未解决的冲突或 revision 不匹配都会让整个提交失败——不产生部分写入。
 *
 * @param {object} state 当前容器
 * @param {object} plan
 * @param {'technical'|'project'} plan.library 写入哪个库
 * @param {string} [plan.projectId] library=project 时的目标项目
 * @param {Array}  plan.candidates [{ question, answerMarkdown, tags, categoryId, sources,
 *                                    decision: 'create'|'update'|'skip',
 *                                    targetId?, targetRevision?, mode?: 'keep'|'adopt'|'merge' }]
 */
export function commitCandidates(state, plan = {}, now = Date.now()) {
  const library = plan.library === 'project' ? 'project' : 'technical';
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const counts = { added: 0, updated: 0, kept: 0, skipped: 0, mergedSources: 0 };
  let next = state;

  for (const c of candidates) {
    const decision = c?.decision || 'create';
    if (decision === 'skip') {
      counts.skipped += 1;
      continue;
    }
    if (decision === 'update') {
      if (!c.targetId) throw knowledgeFail('更新候选缺少目标题目，无法提交。', 'invalid');
      const list = library === 'project' ? next.projectQuestions : next.technicalQuestions;
      const target = list.find((q) => q.id === c.targetId);
      if (!target) throw knowledgeFail('目标题目已不存在，请重新核对。', 'not-found');
      checkRevision(target, c.targetRevision, '目标题目');
      const merged = mergeSources(target.sources, c.sources);
      counts.mergedSources += Math.max(0, merged.length - target.sources.length);

      // 保留原答案：只补来源与标签，不动正文
      const patch =
        c.mode === 'keep'
          ? {
              sources: merged,
              ...(library === 'technical' ? { tags: sanitizeTags([...(target.tags || []), ...(c.tags || [])]) } : {}),
              revision: target.revision,
            }
          : {
              question: requireQuestionText(c.question ?? target.question, '题目'),
              answerMarkdown: String(c.answerMarkdown ?? ''),
              sources: merged,
              ...(library === 'technical'
                ? { tags: sanitizeTags([...(target.tags || []), ...(c.tags || [])]), categoryId: c.categoryId ?? target.categoryId }
                : {}),
              revision: target.revision,
            };
      const out =
        library === 'project'
          ? updateProjectQuestion(next, target.id, patch, now)
          : updateTechnicalQuestion(next, target.id, patch, now);
      next = out.state;
      counts[c.mode === 'keep' ? 'kept' : 'updated'] += 1;
      continue;
    }

    const question = requireQuestionText(c?.question, '候选题目');
    if (library === 'project') {
      const out = createProjectQuestion(
        next,
        {
          projectId: c.projectId || plan.projectId,
          question,
          answerMarkdown: c.answerMarkdown,
          sources: c.sources,
        },
        now,
      );
      next = out.state;
    } else {
      const out = createTechnicalQuestion(
        next,
        { question, answerMarkdown: c.answerMarkdown, tags: c.tags, categoryId: c.categoryId, sources: c.sources },
        now,
      );
      next = out.state;
    }
    counts.added += 1;
  }

  return { state: next, counts };
}

/* ------------------------------------------------------------------ */
/* 统一入口：background 消息路由调用                                    */
/* ------------------------------------------------------------------ */

/**
 * 所有单实体变更的唯一入口。写入串行由调用方（background）保证。
 * @returns {{state: object, result: object}}
 */
export function applyOp(state, action = {}, now = Date.now()) {
  if (action.op?.startsWith('review.')) return reviewOp(state, action.op, action.payload, now);
  const out = applyContentOp(state, action, now);
  out.state.review = reconcileReview(out.state.review, out.state.technicalQuestions, now);
  return out;
}

function applyContentOp(state, { op, payload = {} } = {}, now = Date.now()) {
  switch (op) {
    case 'questions.move': {
      const { library, projectId, id, targetId, side, baseRevision } = payload;
      if (baseRevision !== state.revision) throw knowledgeFail('题库已更新，请刷新后重新拖动。', 'conflict');
      if (!['project', 'technical'].includes(library) || !['before', 'after'].includes(side)) throw knowledgeFail('排序参数无效。');
      const key = library === 'project' ? 'projectQuestions' : 'technicalQuestions';
      const list = [...state[key]], from = list.find(q => q.id === id), target = list.find(q => q.id === targetId);
      if (!from || !target || from.id === target.id) throw knowledgeFail('排序题目已不存在或目标无效。');
      if (library === 'project' && (!projectId || from.projectId !== projectId || target.projectId !== projectId)) throw knowledgeFail('只能调整同一项目内的题目顺序。');
      const ordered = list.filter(q => q.id !== id), at = ordered.findIndex(q => q.id === targetId);
      ordered.splice(at + (side === 'after' ? 1 : 0), 0, from);
      return { state: { ...bump(state), [key]: ordered }, result: {} };
    }
    case 'project.create': {
      const { state: next, project } = createProject(state, payload, now);
      return { state: next, result: { project } };
    }
    case 'project.update': {
      const { state: next, project } = updateProject(state, payload.id, payload, now);
      return { state: next, result: { project } };
    }
    case 'project.delete': {
      const { state: next, removedQuestions } = deleteProject(state, payload.id, payload, now);
      return { state: next, result: { removedQuestions } };
    }
    case 'projectQuestion.create': {
      const { state: next, question } = createProjectQuestion(state, payload, now);
      return { state: next, result: { question } };
    }
    case 'projectQuestion.update': {
      const { state: next, question } = updateProjectQuestion(state, payload.id, payload, now);
      return { state: next, result: { question } };
    }
    case 'projectQuestion.delete': {
      const { state: next } = deleteProjectQuestion(state, payload.id, payload);
      return { state: next, result: {} };
    }
    case 'technicalQuestion.create': {
      const { state: next, question } = createTechnicalQuestion(state, payload, now);
      return { state: next, result: { question } };
    }
    case 'technicalQuestion.update': {
      const { state: next, question } = updateTechnicalQuestion(state, payload.id, payload, now);
      return { state: next, result: { question } };
    }
    case 'technicalQuestion.delete': {
      const { state: next } = deleteTechnicalQuestion(state, payload.id, payload);
      return { state: next, result: {} };
    }
    case 'category.create': {
      const { state: next, category } = createCategory(state, payload);
      return { state: next, result: { category } };
    }
    case 'category.rename': {
      const { state: next, category } = renameCategory(state, payload.id, payload.name);
      return { state: next, result: { category } };
    }
    case 'category.delete': {
      const { state: next, movedToUncategorized } = deleteCategory(state, payload.id);
      return { state: next, result: { movedToUncategorized } };
    }
    case 'candidates.commit': {
      const { state: next, counts } = commitCandidates(state, payload, now);
      return { state: next, result: { counts } };
    }
    case 'projects.commit': {
      const { state: next, counts } = commitProjects(state, payload, now);
      return { state: next, result: { counts } };
    }
    default:
      throw knowledgeFail(`未知的知识库操作：${op}`, 'unknown-op');
  }
}
