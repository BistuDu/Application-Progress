/**
 * 候选层：把手工输入、图片识别、文件导入统一成"可核对候选"。
 *
 * 职责（design.md §6）：
 * - 题目规范化：只处理首尾空格、全半角、连续空白和编号前缀；
 *   保留关键技术符号（+ # - 等）与否定的中文词，避免把不同题目误判成同题。
 * - 重复判定：与已有题比对（八股文全库、项目题仅同一项目内）以及与同批次内其它候选比对。
 * - 提交计划：把用户的决定折叠成一次性写入的候选列表；未处理的冲突不允许提交。
 */

import { uid, uniq } from './util.js';
import { KnowledgeError, mergeSources, sanitizeSources, sanitizeTags } from './knowledge-store.js';

/** 近似题阈值：达到即提示"可能重复"，由用户判断是否同题。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.72;

/* ------------------------------------------------------------------ */
/* 规范化与相似度                                                      */
/* ------------------------------------------------------------------ */

const FULLWIDTH = /[\uFF01-\uFF5E]/g;

/** 全角转半角：只影响标点、数字与拉丁字母，中文与否定词不受影响。 */
function toHalfWidth(s) {
  return s.replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/** 题目规范化：用于重复判定，绝不用于展示。 */
export function normalizeQuestion(text) {
  let s = toHalfWidth(String(text ?? ''))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉编号与 Q 前缀，让"1. 什么是B+树"与"什么是 B+ 树"能匹配
  s = s.replace(
    /^(?:[（(]\s*\d+\s*[)）]|\d+\s*[.、)）:：]|第\s*[一二三四五六七八九十百千\d]+\s*[题问节]\s*[.、:：]?|(?:q|question|问|题目)\s*[.、:：])\s*/i,
    '',
  );
  // 空白一律视为等价："什么是 B+ 树" 与 "什么是B+树" 是同一道题
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

function latinTokens(s) {
  return (s.match(/[a-z0-9][a-z0-9+#.-]*/g) || []).filter((t) => t.length > 1);
}

/** 0~1 的相似度：中文字符二元组 Dice 与英文技术词 Jaccard 取较大值。 */
export function questionSimilarity(a, b) {
  const x = normalizeQuestion(a);
  const y = normalizeQuestion(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const A = new Set(bigrams(x));
  const B = new Set(bigrams(y));
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const dice = A.size + B.size ? (2 * inter) / (A.size + B.size) : 0;

  const wa = new Set(latinTokens(x));
  const wb = new Set(latinTokens(y));
  let wInter = 0;
  for (const w of wa) if (wb.has(w)) wInter += 1;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = union ? wInter / union : 0;

  return Math.max(dice, jaccard);
}

/* ------------------------------------------------------------------ */
/* 候选模型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 构造一个候选问答。
 * 答案允许为空（图片里只有题目、或用户还没写答案）。
 */
export function makeCandidate(input = {}) {
  const question = String(input.question ?? '').trim();
  return {
    id: input.id || uid('cand'),
    question,
    answerMarkdown: String(input.answerMarkdown ?? ''),
    tags: sanitizeTags(input.tags),
    categoryId: input.categoryId || '',
    categoryName: String(input.categoryName ?? '').trim(),
    sources: sanitizeSources(input.sources),
    selected: input.selected !== false,
    // 与已有题的关系（核对后填入）
    target: input.target || null,
    // 与同批次内更早候选的关系
    batchOf: input.batchOf || null,
    // 用户决定：null 表示尚未处理
    decision: input.decision ?? null,
    note: String(input.note ?? ''),
  };
}

/** 只有题目非空的候选才允许提交。 */
export function validateCandidates(candidates) {
  const problems = [];
  candidates.forEach((c, i) => {
    if (!String(c?.question ?? '').trim()) problems.push(`第 ${i + 1} 条候选题目为空。`);
  });
  return problems;
}

/**
 * 与已有题比对，并在批次内互相比对。
 * @param {Array} existing 目标库里的已有题 [{id, question, answerMarkdown, revision, sources}]
 * @param {Array} candidates makeCandidate 的结果
 * @returns {Array} 带 target / batchOf 的候选（新数组，原对象不被修改）
 */
export function reconcileCandidates(existing = [], candidates = []) {
  const list = existing.map((q) => ({
    id: q.id,
    question: q.question,
    answerMarkdown: String(q.answerMarkdown ?? ''),
    revision: q.revision,
    sources: q.sources || [],
  }));

  const out = [];
  for (const raw of candidates) {
    const c = { ...raw, target: null, batchOf: null, decision: raw.decision ?? null };

    // 1) 与已有题比对
    let best = null;
    for (const q of list) {
      const sim = questionSimilarity(c.question, q.question);
      if (sim === 0) continue;
      const kind = sim === 1 ? 'exact' : sim >= NEAR_DUPLICATE_THRESHOLD ? 'near' : null;
      if (!kind) continue;
      if (!best || sim > best.similarity) {
        best = { id: q.id, question: q.question, answerMarkdown: q.answerMarkdown, revision: q.revision, similarity: sim, kind };
      }
    }
    if (best) {
      c.target = best;
      // 答案完全相同：保留原题是无风险的确定性决定，但仍会在核对界面列出
      if (best.kind === 'exact' && normalizeAnswer(c.answerMarkdown) === normalizeAnswer(best.answerMarkdown)) {
        c.decision = c.decision ?? 'keep';
        c.note = c.note || '答案与已有题目相同，将保留原题答案。';
      }
    }

    // 2) 与同批次内更早的候选比对
    if (!c.batchOf) {
      for (const prev of out) {
        if (prev.batchOf) continue;
        const sim = questionSimilarity(c.question, prev.question);
        if (sim >= NEAR_DUPLICATE_THRESHOLD) {
          c.batchOf = prev.id;
          c.batchSimilarity = sim;
          break;
        }
      }
    }
    out.push(c);
  }
  return out;
}

function normalizeAnswer(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').trim();
}

/** 仍然需要用户决定的候选（已有题冲突或批次内重复）。 */
export function pendingDecisions(candidates = []) {
  return candidates.filter((c) => c.selected !== false && (c.target || c.batchOf) && !c.decision);
}

/* ------------------------------------------------------------------ */
/* 提交计划                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把候选与用户的决定折叠成一次性写入的列表。
 * 任何未处理的冲突都会抛 KnowledgeError（code: 'unresolved'），保证不会部分写入。
 *
 * @returns {{candidates: Array, counts: {skippedByUser:number}}}
 */
export function commitPlan(candidates = []) {
  const pending = pendingDecisions(candidates);
  if (pending.length) {
    throw new KnowledgeError(`还有 ${pending.length} 条重复题没有处理，请先选择保留、采用或合并。`, {
      code: 'unresolved',
      detail: pending.map((c) => c.question).slice(0, 5).join(' / '),
    });
  }

  const effective = [];
  const byId = new Map();
  let skippedByUser = 0;

  for (const raw of candidates) {
    const c = { ...raw };
    if (c.selected === false || c.decision === 'skip') {
      skippedByUser += 1;
      continue;
    }
    if (c.batchOf) {
      const first = byId.get(c.batchOf);
      if (!first) {
        skippedByUser += 1;
        continue;
      }
      // 批次内重复：采用/合并都表示"以这一条的正文为准"，保留也许可
      if (c.decision === 'keep') {
        skippedByUser += 1;
        continue;
      }
      first.answerMarkdown = c.answerMarkdown;
      first.sources = mergeSources(first.sources, c.sources);
      first.tags = sanitizeTags([...first.tags, ...c.tags]);
      first.note = `${first.note || ''} 已并入 1 条重复候选。`.trim();
      skippedByUser += 1;
      continue;
    }
    const entry = {
      question: c.question,
      answerMarkdown: c.answerMarkdown,
      tags: c.tags,
      categoryId: c.categoryId,
      sources: c.sources,
      decision: c.target ? 'update' : 'create',
      mode: c.target ? (c.decision === 'keep' ? 'keep' : 'adopt') : 'adopt',
      targetId: c.target?.id || '',
      targetRevision: c.target?.revision,
      projectId: c.projectId,
      categoryName: c.categoryName,
    };
    byId.set(c.id, entry);
    effective.push(entry);
  }

  return { candidates: effective, counts: { skippedByUser } };
}

export function candidateCountsText(counts = {}) {
  const parts = [`新增 ${counts.added || 0} 条`];
  if (counts.updated) parts.push(`更新 ${counts.updated} 条`);
  if (counts.kept) parts.push(`保留原答案 ${counts.kept} 条`);
  if (counts.skipped) parts.push(`跳过 ${counts.skipped} 条`);
  return `${parts.join('，')}。`;
}

/** 供核对界面复用的"候选是否还有问题"判断。 */
export function candidatesReady(candidates = []) {
  return validateCandidates(candidates.filter((c) => c.selected !== false)).length === 0 && pendingDecisions(candidates).length === 0;
}
