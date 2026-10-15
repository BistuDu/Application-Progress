/**
 * 参考题检索：本地派生轻量索引，不引入嵌入服务或向量库。
 *
 * 检索信号（design.md §7）：
 * - 英文技术 token（含 C++ / Node.js 这类带符号写法）
 * - 中文二元片段 + 技能词典里的中文技术词
 * - 分类与标签
 * 查询词来自当前题目、项目简介与个人职责；题目与标签的权重高于答案正文，
 * 命中词作为"匹配依据"展示给用户，避免把无匹配解释成"没有相关知识"。
 */

import { SKILL_DICT, uniq } from './util.js';

export const MATCH_LIMIT = 8;
export const SUGGEST_LIMIT = 5;

const WEIGHTS = { question: 3, tag: 3, category: 2, answer: 1 };

const CJK_RUN = /[\u4e00-\u9fff]+/g;
const LATIN = /[a-z0-9][a-z0-9+#._-]*/g;
/** 词典里的中文技术词，优先按整词命中，避免二元片段把"并发"切碎。 */
const CN_DICT = SKILL_DICT.filter((s) => /[\u4e00-\u9fff]/.test(s)).map((s) => s.toLowerCase());

/** 中英文混合分词：返回去重后的小写 token 集合。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  if (!s.trim()) return out;

  for (const m of s.match(LATIN) || []) if (m.length > 1) out.add(m);

  for (const run of s.match(CJK_RUN) || []) {
    // 词典整词优先
    for (const word of CN_DICT) {
      if (run.includes(word) || s.includes(word)) out.add(word);
    }
    // 二元片段：中文没有空格，二元组是够用的近似
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
    if (run.length === 1) out.add(run);
  }
  return out;
}

/** 为一批题目建立检索索引。 */
export function buildIndex(questions = [], categories = []) {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  return questions.map((q) => ({
    id: q.id,
    question: q.question,
    answerMarkdown: q.answerMarkdown || '',
    hasAnswer: Boolean(String(q.answerMarkdown || '').trim()),
    tags: q.tags || [],
    categoryName: categoryName.get(q.categoryId) || '',
    tokens: {
      question: tokenize(q.question),
      answer: tokenize(String(q.answerMarkdown || '').slice(0, 4000)),
      tag: tokenize((q.tags || []).join(' ')),
      category: tokenize(categoryName.get(q.categoryId) || ''),
    },
  }));
}

/**
 * 按查询自动匹配参考题。
 * @param {object} opts
 * @param {Array} opts.questions 八股文题库
 * @param {Array} opts.categories 分类
 * @param {object|string} opts.query {question, summary, responsibilities} 或直接一段文本
 * @returns {Array<{id,question,answerMarkdown,hasAnswer,score,evidence,suggested}>}
 */
export function matchReferences({ questions = [], categories = [], query = {}, limit = MATCH_LIMIT, suggestLimit = SUGGEST_LIMIT } = {}) {
  if (!questions.length) return [];
  const text =
    typeof query === 'string'
      ? query
      : [query.question, query.summary, query.responsibilities].filter(Boolean).join('\n');
  const queryTokens = tokenize(text);
  if (!queryTokens.size) return [];

  const scored = [];
  for (const entry of buildIndex(questions, categories)) {
    let score = 0;
    const evidence = [];
    for (const field of ['question', 'tag', 'category', 'answer']) {
      for (const token of entry.tokens[field]) {
        if (!queryTokens.has(token)) continue;
        score += WEIGHTS[field];
        if (field !== 'answer') evidence.push(token);
      }
    }
    if (score <= 0) continue;
    scored.push({
      id: entry.id,
      question: entry.question,
      answerMarkdown: entry.answerMarkdown,
      hasAnswer: entry.hasAnswer,
      score,
      // 依据里去掉被其它词包含的碎片，读起来更像关键词
      evidence: uniq(evidence)
        .sort((a, b) => b.length - a.length)
        .filter((t, _i, arr) => !arr.some((o) => o !== t && o.includes(t) && o.length > t.length))
        .slice(0, 6),
      suggested: false,
    });
  }

  scored.sort((a, b) => b.score - a.score || Number(b.hasAnswer) - Number(a.hasAnswer));
  const top = scored.slice(0, limit);
  // 空答案题不作为默认回答依据，只作为可展开查看的候选
  let suggested = 0;
  for (const item of top) {
    if (item.hasAnswer && suggested < suggestLimit) {
      item.suggested = true;
      suggested += 1;
    }
  }
  return top;
}

/**
 * 手工全库搜索：用于用户主动补充参考题。
 * 题目命中优先，其次是标签、分类和答案正文。
 */
export function searchQuestionBank(questions = [], categories = [], term = '', { limit = 20 } = {}) {
  const q = String(term ?? '').trim().toLowerCase();
  if (!q) return [];
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const hits = [];
  for (const item of questions) {
    const question = String(item.question || '').toLowerCase();
    const answer = String(item.answerMarkdown || '').toLowerCase();
    const tags = (item.tags || []).join(' ').toLowerCase();
    const category = (categoryName.get(item.categoryId) || '').toLowerCase();
    let rank = 0;
    if (question.includes(q)) rank = 4;
    else if (tags.includes(q)) rank = 3;
    else if (category.includes(q)) rank = 2;
    else if (answer.includes(q)) rank = 1;
    if (!rank) continue;
    hits.push({
      id: item.id,
      question: item.question,
      answerMarkdown: item.answerMarkdown || '',
      hasAnswer: Boolean(String(item.answerMarkdown || '').trim()),
      tags: item.tags || [],
      categoryName: categoryName.get(item.categoryId) || '',
      rank,
    });
  }
  hits.sort((a, b) => b.rank - a.rank || a.question.localeCompare(b.question, 'zh-Hans-CN'));
  return hits.slice(0, limit);
}
