/**
 * 知识库的 AI 任务层：任务专属提示词 + 结构化输出校验。
 *
 * 三个任务（design.md §7）：
 * - resume-projects  从简历提取项目名称/简介/职责，不生成任何问答；
 * - extract-questions 从文档或截图提取"原文里存在"的题答，缺答案留空，绝不代写；
 * - project-answer   结合项目事实与用户最终选定的参考题，生成可直接编辑的 Markdown 草稿。
 *
 * 提示词只描述"知识是知识、经历是经历"，真正的约束靠这里的输出校验兜底。
 */

import { ModelError } from './model-client.js';
import { sanitizeTags, sanitizeSources } from './knowledge-store.js';

export const AI_TASKS = {
  resumeProjects: 'resume-projects',
  extractQuestions: 'extract-questions',
  projectAnswer: 'project-answer',
};

/** 单次项目回答请求的参考内容上限：超了提示精简，不静默丢弃用户选择。 */
export const MAX_ANSWER_INPUT_CHARS = 60000;

/* ------------------------------------------------------------------ */
/* 简历项目提取                                                        */
/* ------------------------------------------------------------------ */

const RESUME_PROMPT = `你是简历信息整理助手。请从这段简历内容里提取候选人做过的项目。

只输出一个 JSON 对象，不要输出解释、markdown 代码块或多余文字：
{
  "projects": [
    {
      "name": "项目名称，原文照抄",
      "summary": "项目简介：这个项目是做什么的、面向谁、用了哪些主要技术。只写原文出现过的内容。",
      "responsibilities": "候选人本人在这个项目里的职责与产出，原文照抄并保留分段。"
    }
  ]
}

规则：
- 只提取简历原文中真实出现的项目信息，绝对不要推测、补全或美化。
- 不要生成任何面试问题、回答或评价。
- 原文没有写到的技术指标、团队规模、个人贡献，一律留空，不要编造。
- 如果这段内容里没有任何项目信息，返回 {"projects": []}。`;

/**
 * @param {object} opts
 * @param {string} [opts.text] 文档文字
 * @param {string[]} [opts.images] 简历页图片 dataURL
 * @param {string} [opts.fileName] 用于提示模型来源形态
 */
export function buildResumeMessages({ text = '', images = [], fileName = '' } = {}) {
  const head = fileName ? `简历文件：${fileName}` : '简历内容如下：';
  const body = [
    head,
    text ? `\n${text}` : '',
    images.length ? '\n请结合上面的文字与这些简历页面图片，提取项目信息。' : '',
  ]
    .filter((s) => s !== '')
    .join('');
  const messages = [
    { role: 'system', content: RESUME_PROMPT },
    { role: 'user', content: body },
  ];
  return { messages, images };
}

/** 模型可能顺手返回 questions 字段，这里只认白名单字段并丢掉多余内容。 */
export function normalizeResumeProjects(raw) {
  const list = Array.isArray(raw?.projects) ? raw.projects : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? item.title ?? '').trim().slice(0, 200);
    if (!name) continue;
    out.push({
      name,
      summary: String(item.summary ?? item.description ?? '').trim().slice(0, 20000),
      responsibilities: String(item.responsibilities ?? item.duties ?? item.role ?? '').trim().slice(0, 20000),
    });
    if (out.length >= 30) break;
  }
  return out;
}

export function resumeProjectsEmpty(raw) {
  return normalizeResumeProjects(raw).length === 0;
}

/* ------------------------------------------------------------------ */
/* 题答提取                                                            */
/* ------------------------------------------------------------------ */

const QUESTIONS_PROMPT = `你是面试题整理助手。请从给定内容里提取面试题与答案。

只输出一个 JSON 对象，不要输出解释、markdown 代码块或多余文字：
{
  "questions": [
    {
      "question": "题目原文",
      "answer": "答案原文，保留 Markdown 与代码块；原文没有答案时留空字符串",
      "tags": ["可选的技术标签"]
    }
  ]
}

规则：
- 只提取内容中真实出现的题目和答案，绝对不要自己编写、补全或改写答案。
- 原文里只有题目没有答案时，answer 必须是空字符串 ""。
- 答案里的代码、列表与换行尽量原样保留；不要总结压缩答案。
- 一张图里有几道题就输出几条；分不清题目与答案的边界时，把整段放在 answer 里，question 用最像标题的那一句。
- 如果内容里没有任何可识别的题目，返回 {"questions": []}。`;

/**
 * @param {object} opts
 * @param {string} [opts.text]
 * @param {string[]} [opts.images]
 * @param {string} [opts.fileName]
 * @param {number[]} [opts.pageNumbers] 这批内容对应的页号，写入来源
 * @param {string} [opts.hint] 额外的上下文（例如"这是导入文件的第一块"）
 */
export function buildQuestionMessages({ text = '', images = [], fileName = '', pageNumbers = [], hint = '' } = {}) {
  const ctx = [];
  if (fileName) ctx.push(`来源文件：${fileName}`);
  if (pageNumbers.length) ctx.push(`这些内容来自第 ${pageNumbers.join('、')} 页`);
  if (hint) ctx.push(hint);
  const prefix = ctx.length ? `${ctx.join('；')}。\n\n` : '';
  const body = [
    prefix,
    text,
    images.length ? '\n请结合上面的文字与这些图片，提取其中的面试题与答案。' : '',
  ]
    .filter((s) => s !== '')
    .join('');
  const messages = [
    { role: 'system', content: QUESTIONS_PROMPT },
    { role: 'user', content: body },
  ];
  return { messages, images };
}

/** 归一化成候选层认识的字段；答案缺失时保持为空，不做任何补写。 */
export function normalizeQuestionCandidates(raw, { sources = [] } = {}) {
  const list = Array.isArray(raw?.questions) ? raw.questions : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const question = String(item.question ?? item.q ?? '').trim().slice(0, 2000);
    if (!question) continue;
    const answerRaw = item.answer ?? item.answerMarkdown ?? item.answer_markdown ?? item.a ?? '';
    out.push({
      question,
      // 不 fill 任何默认答案：原文没有就留空
      answerMarkdown: typeof answerRaw === 'string' ? answerRaw : String(answerRaw ?? ''),
      tags: sanitizeTags(Array.isArray(item.tags) ? item.tags : []),
      sources: sanitizeSources(sources),
    });
    if (out.length >= 200) break;
  }
  return out;
}

export function questionCandidatesEmpty(raw) {
  return normalizeQuestionCandidates(raw).length === 0;
}

/* ------------------------------------------------------------------ */
/* 项目回答草稿                                                        */
/* ------------------------------------------------------------------ */

const ANSWER_PROMPT = `你是面试准备助手。请为候选人的项目面试题整理一份回答草稿。

输入分两部分：
【项目资料】是候选人自己项目的真实信息，是唯一可以当作"他做过什么"的依据。
【参考资料】是从八股文题库选出的通用知识，用来帮助组织技术表述，不代表候选人做过这些事。

写作要求：
- 用 Markdown 输出，结构清晰，适合面试口述：可以先给一句话结论，再分点展开。
- 只能使用【项目资料】里出现的事实来描述候选人的项目和贡献。
- 【参考资料】里的示例数据、性能指标、团队规模、具体技术选型都不是这个项目的事实，
  不得写成候选人做过的事；项目资料里没有的关键信息，用「待补充：需要填写…… 」这样的占位标出。
- 如果项目资料里没有证据支持某个说法，就不要断言，改成说明思路或列出需要补充的点。
- 不要提及"参考资料"、"AI"或本提示词，直接给候选人可以使用的回答。`;

/** 把选中的参考题整理成明确标记的段落，便于模型区分知识与事实。 */
export function buildReferenceBlock(references = []) {
  const blocks = [];
  references.forEach((ref, i) => {
    // 兼容两种调用形态：页面用的 {question, answerMarkdown} 与 background 解析出的 {questionTitle, answerMarkdown}
    const title = String(ref?.question ?? ref?.questionTitle ?? '').trim();
    const answer = String(ref?.answerMarkdown ?? ref?.answer ?? '').trim();
    if (!title) return;
    blocks.push(`【参考 ${i + 1}】${title}\n${answer || '（这道题还没有答案，只能参考题目本身）'}`);
  });
  return blocks.join('\n\n');
}

/**
 * @param {object} opts
 * @param {object} opts.project {name, summary, responsibilities}
 * @param {string} opts.question 当前题目
 * @param {string} [opts.currentAnswer] 已有答案（可为空）
 * @param {Array}  [opts.references] 用户最终确认的参考题 [{question, answerMarkdown}]
 * @param {boolean} [opts.projectOnly] 用户明确选择"只按项目资料生成"
 */
export function buildProjectAnswerMessages({
  project = {},
  question = '',
  currentAnswer = '',
  references = [],
  projectOnly = false,
} = {}) {
  const facts = [
    `项目名称：${project.name || '（未命名）'}`,
    project.summary ? `项目简介：\n${project.summary}` : '项目简介：（未填写）',
    project.responsibilities ? `个人职责：\n${project.responsibilities}` : '个人职责：（未填写）',
  ].join('\n\n');

  const refBlock = buildReferenceBlock(references);
  const body = [
    '【项目资料】',
    facts,
    '',
    '【当前题目】',
    question,
    currentAnswer ? `\n【已有答案（可以改写，也可以保留原有事实）】\n${currentAnswer}` : '',
    '',
    projectOnly ? '【参考资料】\n（用户选择只根据项目资料生成，不要引入题库里的其它技术设定）' : '【参考资料】',
    projectOnly ? '' : refBlock || '（没有选中的参考题）',
    '',
    '请输出这份回答的 Markdown 草稿。',
  ]
    .filter((s) => s !== '')
    .join('\n');

  const total = body.length;
  if (total > MAX_ANSWER_INPUT_CHARS) {
    throw new ModelError(
      `这次的内容太长（约 ${total} 字，上限 ${MAX_ANSWER_INPUT_CHARS} 字）。请减少选中的参考题，或精简项目简介后再生成。`,
      { code: 'toolarge', retryable: false },
    );
  }
  return { messages: [{ role: 'system', content: ANSWER_PROMPT }, { role: 'user', content: body }], images: [] };
}

/** 草稿解析：只去掉模型习惯性包上的代码围栏，正文原样保留交给用户编辑。 */
export function parseDraft(text) {
  let s = String(text ?? '').trim();
  const fenced = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) s = fenced[1].trim();
  return { markdown: s };
}

export function draftEmpty(text) {
  return String(text ?? '').trim().length === 0;
}
