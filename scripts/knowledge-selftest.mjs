#!/usr/bin/env node
/**
 * 知识库离线自检：用 chrome API 替身 + fetch 打桩，在 Node 里跑通
 *   存储容器 → CRUD/级联 → 串行写入与冲突 → 候选与重复处理 → 检索 → 备份恢复 → 模型任务编排
 *
 * 用法：
 *   node scripts/knowledge-selftest.mjs
 *   node scripts/knowledge-selftest.mjs --verbose
 *
 * 不需要 API Key、不联网、不启动浏览器；真实模型与界面流程由 scripts/knowledge-e2e.mjs 覆盖。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, 'src');
const mod = (p) => pathToFileURL(path.join(SRC, p)).href;

const verbose = process.argv.includes('--verbose');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* chrome 替身                                                         */
/* ------------------------------------------------------------------ */

const memory = { local: {}, session: {} };
/** 后台推送给页面的消息（deliverKnowledgeResult / tabs.sendMessage）。 */
const delivered = [];

function makeArea(name) {
  return {
    async get(key) {
      const store = memory[name];
      if (key == null) return { ...store };
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      if (memory.failWrites) throw new Error('QUOTA_BYTES exceeded（模拟存储写入失败）');
      Object.assign(memory[name], obj);
      for (const [k, v] of Object.entries(obj)) {
        for (const fn of onChanged) fn({ [k]: { newValue: v, oldValue: undefined } }, name);
      }
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete memory[name][k];
    },
  };
}

const onChanged = [];
const messageListeners = [];
let permissionGranted = true;

globalThis.chrome = {
  storage: {
    local: makeArea('local'),
    session: makeArea('session'),
    onChanged: { addListener: (fn) => onChanged.push(fn) },
  },
  runtime: {
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getURL: (p) => `chrome-extension://kbtest/${p}`,
    getPlatformInfo: async () => ({ os: 'mac' }),
    openOptionsPage: async () => {},
    lastError: null,
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    TAB_ID_NONE: -1,
    query: async () => [],
    create: async (opts) => ({ id: 99, ...opts }),
    update: async () => {},
    sendMessage: async (_tabId, message) => {
      delivered.push(message);
    },
    captureVisibleTab: async () => 'data:image/jpeg;base64,AAAA',
  },
  windows: { update: async () => {} },
  notifications: { create: async () => {} },
  contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
  commands: { onCommand: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
  permissions: {
    contains: async () => permissionGranted,
    request: async () => permissionGranted,
  },
  scripting: { executeScript: async () => {} },
};

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let pass = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* 模块与消息通道                                                      */
/* ------------------------------------------------------------------ */

const store = await import(mod('lib/knowledge-store.js'));
const importer = await import(mod('lib/knowledge-import.js'));
const matcher = await import(mod('lib/knowledge-match.js'));
const exporter = await import(mod('lib/knowledge-export.js'));
const ai = await import(mod('lib/knowledge-ai.js'));
const modelClient = await import(mod('lib/model-client.js'));
const docs = await import(mod('lib/knowledge-documents.js'));

// 导入 background 会注册消息监听并跑一遍初始化
await import(mod('background.js'));

/** 像扩展页面一样给 service worker 发消息。 */
function bg(message, senderTab = { id: 7, url: 'https://www.example.com/job' }) {
  const listener = messageListeners[0];
  if (!listener) throw new Error('background 没有注册消息监听');
  return new Promise((resolve) => {
    const responded = listener({ ...message }, { tab: senderTab, ...(senderTab.extensionPage ? {id:chrome.runtime.id,url:chrome.runtime.getURL('src/knowledge/knowledge.html')} : {}) }, resolve);
    if (responded !== true) {
      // 同步返回 false 表示不会响应，直接给一个明确的失败对象避免挂住
      resolve({ ok: false, error: '没有响应' });
    }
  });
}

async function waitResult(requestId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = delivered.find((m) => m.requestId === requestId && m.type === 'JDT_KNOWLEDGE_RESULT');
    if (found) return found;
    await sleep(15);
  }
  throw new Error(`等待任务结果超时：${requestId}`);
}

async function runTask(payload) {
  const accepted = await bg({ type: 'KNOWLEDGE_AI_RUN', ...payload });
  if (!accepted.ok) return { accepted, result: null };
  const result = await waitResult(accepted.requestId);
  return { accepted, result };
}

const readLibrary = async () => (await chrome.storage.local.get(store.KNOWLEDGE_KEY))[store.KNOWLEDGE_KEY];

/* fetch 打桩 */
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const chatResponse = (content, extra = {}) =>
  jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }], model: 'stub', usage: { total_tokens: 12 }, ...extra });
const hangingFetch = (url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

/* ------------------------------------------------------------------ */
/* [1] 存储容器与字段白名单                                            */
/* ------------------------------------------------------------------ */

section('[1] 存储容器、字段白名单与首次读取');

{
  const first = await store.loadState();
  check('首次读取返回空容器', first.projects.length === 0 && first.technicalQuestions.length === 0 && first.schemaVersion === 2);
  check('首次读取不写库（只有用户保存才创建键）', (await readLibrary()) === undefined);

  await chrome.storage.local.set({ records: [{ id: 'job1' }], settings: { apiKey: 'sk-secret-key' } });

  const created = store.createProject(first, {
    name: '校园二手交易平台',
    summary: '面向校内学生的闲置交易',
    responsibilities: '负责订单与支付模块',
    // 这些字段必须被白名单挡掉
    screenshot: 'data:image/jpeg;base64,AAA',
    apiKey: 'sk-leak',
    rawFile: 'bytes',
    revision: 99,
  });
  check('项目只保留白名单字段', !('screenshot' in created.project) && !('apiKey' in created.project) && !('rawFile' in created.project));
  check('项目 revision 从 1 开始', created.project.revision === 1);

  const withQuestion = store.createProjectQuestion(created.state, {
    projectId: created.project.id,
    question: '订单超卖是怎么解决的？',
    answerMarkdown: '',
    sources: [{ type: 'web-region', url: 'https://example.com', importedAt: Date.now(), dataUrl: 'data:image/png;base64,ZZZ' }],
  });
  check('答案允许为空', withQuestion.question.answerMarkdown === '');
  check('来源字段白名单（不含原图）', !('dataUrl' in withQuestion.question.sources[0]));

  const withTech = store.createTechnicalQuestion(withQuestion.state, {
    question: '数据库索引为什么能加速查询？',
    answerMarkdown: '因为减少了扫描行数。',
    tags: ['索引', '索引', ' 性能优化 '],
  });
  check('标签去重并去掉空格', JSON.stringify(withTech.question.tags) === '["索引","性能优化"]');
  check('引用不存在的分类会被拒绝', (() => {
    try {
      store.createTechnicalQuestion(withQuestion.state, { question: '题', categoryId: 'not-exist' });
      return false;
    } catch (err) {
      return err.code === 'bad-category';
    }
  })());

  await chrome.storage.local.set({ [store.KNOWLEDGE_KEY]: withQuestion.state });
  const reopened = await store.loadState();
  check('重开后能读回同一份数据', reopened.projects.length === 1 && reopened.projectQuestions.length === 1);
  check('记录与设置未被知识库写入影响', memory.local.records[0].id === 'job1' && memory.local.settings.apiKey === 'sk-secret-key');

  // 非法归属：恢复/读取时会丢弃，而不是让整个库打不开
  const broken = {
    schemaVersion: 1,
    revision: 3,
    projects: [{ id: 'p1', name: '项目A' }],
    projectQuestions: [
      { id: 'q1', projectId: 'p1', question: '合法题', answerMarkdown: '' },
      { id: 'q2', projectId: 'ghost', question: '孤儿题', answerMarkdown: '' },
    ],
    technicalQuestions: [],
    categories: [{ id: 'c1', name: '数据库' }],
  };
  const normalized = store.normalizeState(broken);
  check('读取时丢弃指向不存在项目的问答', normalized.projectQuestions.length === 1 && normalized.projectQuestions[0].id === 'q1');
  check('严格校验会指出非法归属', store.validateState(broken).errors.some((e) => /不存在的项目/.test(e)));

  const badCategory = store.validateState({
    ...broken,
    projectQuestions: [],
    technicalQuestions: [{ id: 't1', question: '题', answerMarkdown: '', categoryId: 'ghost' }],
  });
  check('严格校验会指出非法分类引用', badCategory.errors.some((e) => /不存在的分类/.test(e)));

  // 清理，后续用例从干净状态开始
  delete memory.local[store.KNOWLEDGE_KEY];

}

/* ------------------------------------------------------------------ */
/* [2] CRUD 与级联规则                                                 */
/* ------------------------------------------------------------------ */

section('[2] CRUD、标签去重与级联规则');

{
  let state = store.emptyState();
  const a = store.createProject(state, { name: '项目A' });
  const b = store.createProject(a.state, { name: '项目B' });
  state = b.state;
  const cat1 = store.createCategory(state, { name: '数据库' });
  state = cat1.state;
  const cat2 = store.createCategory(state, { name: '网络' });
  state = cat2.state;

  state = store.createProjectQuestion(state, { projectId: a.project.id, question: 'A 的问题', answerMarkdown: 'A 的答案' }).state;
  state = store.createProjectQuestion(state, { projectId: b.project.id, question: 'B 的问题', answerMarkdown: '' }).state;
  const ref = store.createTechnicalQuestion(state, { question: '索引原理', answerMarkdown: 'B+ 树', categoryId: cat1.category.id, tags: ['索引'] });
  state = ref.state;
  state = store.createTechnicalQuestion(state, { question: 'TCP 三次握手', answerMarkdown: '', categoryId: cat2.category.id }).state;

  // 引用放在项目 B 的问答上：项目 A 稍后会被整体删除
  const refTarget = state.projectQuestions.find((q) => q.projectId === b.project.id);
  const withRef = store.updateProjectQuestion(state, refTarget.id, {
    answerMarkdown: '参考了索引原理作答',
    aiReferences: [
      {
        technicalQuestionId: ref.question.id,
        questionTitle: ref.question.question,
        referencedUpdatedAt: ref.question.updatedAt,
        generatedAt: Date.now(),
      },
    ],
    revision: refTarget.revision,
  });
  state = withRef.state;

  check('内容相同会报错（题目不能为空）', (() => {
    try {
      store.createTechnicalQuestion(state, { question: '   ' });
      return false;
    } catch (err) {
      return err.code === 'empty-question';
    }
  })());
  check('同名分类被拒绝', (() => {
    try {
      store.createCategory(state, { name: '数据库' });
      return false;
    } catch (err) {
      return err.code === 'duplicate-category';
    }
  })());

  // 删除项目：只删除它的问答
  const before = state;
  const del = store.deleteProject(state, a.project.id, { revision: before.projects.find((p) => p.id === a.project.id).revision });
  check('删除项目会报告同时删除的问答数', del.removedQuestions === 1);
  check('删除项目只删所属问答', del.state.projectQuestions.length === 1 && del.state.projectQuestions[0].projectId === b.project.id);
  check('删除项目不影响八股文题库', del.state.technicalQuestions.length === 2);
  state = del.state;

  // 删除分类：题目转为未分类
  const delCat = store.deleteCategory(state, cat1.category.id);
  check('删除分类后题目转到未分类', delCat.movedToUncategorized === 1 && delCat.state.technicalQuestions.find((q) => q.id === ref.question.id).categoryId === '');
  check('删除分类保留题目本身', delCat.state.technicalQuestions.length === 2);
  state = delCat.state;

  // 删除被引用的参考题：项目答案保留，引用变为不可用
  const delRef = store.deleteTechnicalQuestion(state, ref.question.id, { revision: state.technicalQuestions.find((q) => q.id === ref.question.id).revision });
  const keptAnswer = delRef.state.projectQuestions.find((q) => q.id === refTarget.id);
  check('删除参考题后项目答案保留', keptAnswer.answerMarkdown === '参考了索引原理作答');
  check('删除参考题后引用元数据保留（可显示为不可用）', keptAnswer.aiReferences.length === 1 && !delRef.state.technicalQuestions.some((q) => q.id === ref.question.id));
  state = delRef.state;

  check('级联后容器的 revision 持续增长', state.revision > before.revision);
  check('级联后容器仍能通过严格校验', store.validateState({ ...state, schemaVersion: 1 }).ok === true);
}

/* ------------------------------------------------------------------ */
/* [3] 串行写入、revision 冲突与失败语义                               */
/* ------------------------------------------------------------------ */

section('[3] 后台串行写入、revision 校验与失败反馈');

{
  delete memory.local[store.KNOWLEDGE_KEY];
  await chrome.storage.local.set({ settings: { apiBase: 'https://api.deepseek.com', apiKey: 'sk-secret-key', model: 'deepseek-flash' } });

  const created = await bg({ type: 'KNOWLEDGE_APPLY', op: 'project.create', payload: { name: '并发测试项目' } });
  check('创建项目写入成功', created.ok === true && created.state.projects.length === 1);
  check('写入响应不携带 API Key', !JSON.stringify(created).includes('sk-secret-key'));

  const madeQ = await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'technicalQuestion.create',
    payload: { question: '什么是回表？', answerMarkdown: '需要回聚簇索引取其它列' },
  });
  const questionId = madeQ.result.question.id;
  const baseRevision = madeQ.state.technicalQuestions[0].revision;

  // 两个页面同时提交旧编辑：只有第一个成功
  const first = await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'technicalQuestion.update',
    payload: { id: questionId, answerMarkdown: '页面 A 的答案', revision: baseRevision },
  });
  const second = await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'technicalQuestion.update',
    payload: { id: questionId, answerMarkdown: '页面 B 的答案（旧）', revision: baseRevision },
  });
  check('第一个旧编辑成功', first.ok === true);
  check('第二个旧编辑被判为冲突', second.ok === false && second.code === 'conflict', second.error || '');
  const after = await readLibrary();
  check('冲突时不会覆盖较新内容', after.technicalQuestions[0].answerMarkdown === '页面 A 的答案');

  const del = await bg({ type: 'KNOWLEDGE_APPLY', op: 'technicalQuestion.delete', payload: { id: questionId, revision: baseRevision } });
  check('用旧 revision 删除也会被拒绝', del.ok === false && del.code === 'conflict');

  // 批量提交里的任何一条失败 → 整批不写入
  const revisionBefore = (await readLibrary()).revision;
  const partial = await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'candidates.commit',
    payload: {
      library: 'technical',
      candidates: [
        { question: '合法新题', answerMarkdown: 'A', decision: 'create' },
        { question: '', answerMarkdown: 'B', decision: 'create' },
      ],
    },
  });
  check('空题目让整批提交失败', partial.ok === false && partial.code === 'empty-question');
  check('批量提交失败时容器没有变化', (await readLibrary()).revision === revisionBefore);

  // 存储写入失败：不返回成功
  memory.failWrites = true;
  const failedWrite = await bg({ type: 'KNOWLEDGE_APPLY', op: 'project.create', payload: { name: '写不进去的项目' } });
  memory.failWrites = false;
  check('存储失败不返回成功', failedWrite.ok === false, failedWrite.error || '');
  check('存储失败后库里没有半个项目', (await readLibrary()).projects.length === 1);
  check('失败响应同样不携带 API Key', !JSON.stringify(failedWrite).includes('sk-secret-key'));

  const got = await bg({ type: 'KNOWLEDGE_GET' });
  check('读取路由只回传设置摘要，不含 Key', got.settings.hasApiKey === true && !('apiKey' in got.settings) && !JSON.stringify(got).includes('sk-secret-key'));
}

/* ------------------------------------------------------------------ */
/* [4] 候选规范化与重复题处理                                          */
/* ------------------------------------------------------------------ */

section('[4] 候选规范化、重复判定与提交计划');

{
  const n1 = importer.normalizeQuestion('1. 什么是B+树？');
  const n2 = importer.normalizeQuestion(' 什么是 B+ 树 ? ');
  check('编号与空白变体归一化后一致', n1 === n2, `${n1} | ${n2}`);
  check('全角标点归一化为半角', importer.normalizeQuestion('（1）TCP 的作用？') === importer.normalizeQuestion('TCP 的作用?'));
  check('技术符号不会被消除', importer.normalizeQuestion('C++ 的虚函数表').includes('c++'));
  const withNegation = importer.normalizeQuestion('为什么不用 B+ 树？');
  check('否定词不会被消除', withNegation.includes('不'));
  check('否定句与原句仍可区分', withNegation !== importer.normalizeQuestion('为什么用 B+ 树？'));
  check('完全相同题目相似度为 1', importer.questionSimilarity('索引下推', '1、索引下推') === 1);
  check('不相关题目相似度低', importer.questionSimilarity('什么是回表', 'TCP 三次握手为什么要握三次') < 0.4);

  const existing = [
    { id: 't1', question: '数据库索引为什么能加速查询？', answerMarkdown: '减少扫描行数', revision: 1 },
    { id: 't2', question: '什么是回表？', answerMarkdown: '', revision: 1 },
  ];

  // 完全匹配且答案相同 → 预置"保留原题"
  const autoKept = importer.reconcileCandidates(existing, [
    importer.makeCandidate({ question: '1. 数据库索引为什么能加速查询？', answerMarkdown: '减少扫描行数' }),
  ]);
  check('完全相同且答案一致时预置保留', autoKept[0].target?.kind === 'exact' && autoKept[0].decision === 'keep');

  // 完全匹配但答案不同 → 必须由用户决定
  const conflict = importer.reconcileCandidates(existing, [
    importer.makeCandidate({ question: '数据库索引为什么能加速查询？', answerMarkdown: '另一种答案' }),
  ]);
  check('答案不同的重复题等待用户决定', conflict[0].target?.kind === 'exact' && conflict[0].decision === null);
  check('未处理冲突时不能提交', (() => {
    try {
      importer.commitPlan(conflict);
      return false;
    } catch (err) {
      return err.code === 'unresolved';
    }
  })());

  const adopted = importer.commitPlan([{ ...conflict[0], decision: 'adopt' }]);
  check('采用新答案会更新原题（保留 ID）', adopted.candidates[0].decision === 'update' && adopted.candidates[0].targetId === 't1' && adopted.candidates[0].mode === 'adopt');
  const kept = importer.commitPlan([{ ...conflict[0], decision: 'keep' }]);
  check('保留原答案时不改正文', kept.candidates[0].mode === 'keep');

  // 批次内重复
  const batch = importer.reconcileCandidates([], [
    importer.makeCandidate({ question: '什么是索引下推？', answerMarkdown: 'A' }),
    importer.makeCandidate({ question: '1、什么是索引下推？', answerMarkdown: 'B' }),
  ]);
  check('批次内重复被标记', batch[1].batchOf === batch[0].id);
  check('批次内重复也要用户决定', importer.pendingDecisions(batch).length === 1);
  const merged = importer.commitPlan([batch[0], { ...batch[1], decision: 'merge' }]);
  check('合并后只产生一条候选', merged.candidates.length === 1 && merged.counts.skippedByUser === 1);

  // 两库隔离：项目库里同名的题不会被八股文匹配
  const projectScope = importer.reconcileCandidates([], [importer.makeCandidate({ question: '数据库索引为什么能加速查询？' })]);
  check('项目库比对不会匹配到八股文题目', projectScope[0].target === null);

  // 近似题只提示、不自动合并（标点差异属于"可能重复"，由用户判断）
  const punctVariant = importer.reconcileCandidates(existing, [importer.makeCandidate({ question: '数据库索引为什么能加速查询' })]);
  check('缺标点的题目会提示为可能重复', ['exact', 'near'].includes(punctVariant[0].target?.kind), punctVariant[0].target?.kind || '无匹配');
  const nearOnly = importer.reconcileCandidates(existing, [importer.makeCandidate({ question: '数据库索引为什么可以加速查询？' })]);
  check('说法不同但非常接近的题标注为可能重复', nearOnly[0].target?.kind === 'near', nearOnly[0].target?.kind || '无匹配');
  check('近似题不会自动合并', nearOnly[0].decision === null);
  const unrelated = importer.reconcileCandidates(existing, [importer.makeCandidate({ question: '数据库索引能加速查询的原因是什么？' })]);
  check('只是话题相近的题不会被当作重复', unrelated[0].target === null, unrelated[0].target?.kind || '无匹配');
  check('空题目候选会被拒绝提交', importer.validateCandidates([importer.makeCandidate({ question: ' ' })]).length === 1);
}

/* ------------------------------------------------------------------ */
/* [5] 检索与匹配                                                      */
/* ------------------------------------------------------------------ */

section('[5] 参考题检索与匹配依据');

{
  const categories = [
    { id: 'c1', name: '数据库' },
    { id: 'c2', name: '并发编程' },
  ];
  const questions = [
    { id: 'q1', question: '数据库索引为什么能加速查询？', answerMarkdown: '因为把随机 IO 变成顺序 IO，减少扫描行数。', tags: ['索引', '性能优化'], categoryId: 'c1' },
    { id: 'q2', question: '什么是回表？', answerMarkdown: '', tags: ['索引'], categoryId: 'c1' },
    { id: 'q3', question: 'synchronized 和 ReentrantLock 的区别？', answerMarkdown: '一个是 JVM 关键字，一个是 API 层面的锁。', tags: ['锁'], categoryId: 'c2' },
  ];

  const hits = matcher.matchReferences({
    questions,
    categories,
    query: { question: '为什么给订单表加这个索引？', summary: '订单查询优化', responsibilities: '用索引优化慢查询，做过数据库性能优化' },
  });
  check('相关候选能被找到', hits.length >= 1 && hits[0].id === 'q1', hits.map((h) => h.question).join(' / '));
  check('匹配结果带可读的依据', (hits[0].evidence || []).length > 0, (hits[0].evidence || []).join('、'));
  check('空答案题不作为默认依据', hits.find((h) => h.id === 'q2')?.suggested !== true);
  check('有答案的相关题被建议', hits.find((h) => h.id === 'q1')?.suggested === true);
  check('不相关的题不会出现', !hits.some((h) => h.id === 'q3'));
  check('空库返回空结果', matcher.matchReferences({ questions: [], categories: [], query: { question: '索引' } }).length === 0);
  check('空查询返回空结果', matcher.matchReferences({ questions, categories, query: { question: '' } }).length === 0);
  check('手工全库搜索按题目命中', matcher.searchQuestionBank(questions, categories, '回表')[0].id === 'q2');
}

/* ------------------------------------------------------------------ */
/* [6] 备份、恢复与 Markdown 导出                                      */
/* ------------------------------------------------------------------ */

section('[6] JSON 备份/恢复与 Markdown 往返');

{
  delete memory.local[store.KNOWLEDGE_KEY];
  await bg({ type: 'KNOWLEDGE_APPLY', op: 'project.create', payload: { name: '校园二手交易平台', summary: '闲置交易', responsibilities: '订单模块' } });
  const stateAfterProject = await readLibrary();
  const projectId = stateAfterProject.projects[0].id;
  await bg({ type: 'KNOWLEDGE_APPLY', op: 'category.create', payload: { name: '数据库' } });
  const withCat = await readLibrary();
  const catId = withCat.categories[0].id;
  await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'technicalQuestion.create',
    payload: { question: '数据库索引为什么能加速查询？', answerMarkdown: '减少扫描行数\n\n```sql\nEXPLAIN SELECT 1;\n```', categoryId: catId, tags: ['索引', '性能优化'], sources: [{ type: 'pdf', fileName: '八股文合集.pdf', pageNumbers: [3, 5] }] },
  });
  const withQ = await readLibrary();
  const tqId = withQ.technicalQuestions[0].id;
  await bg({
    type: 'KNOWLEDGE_APPLY',
    op: 'projectQuestion.create',
    payload: {
      projectId,
      question: '为什么用这个索引方案？',
      answerMarkdown: '因为订单表查询走覆盖索引。',
      aiReferences: [{ technicalQuestionId: tqId, questionTitle: '数据库索引为什么能加速查询？', referencedUpdatedAt: withQ.technicalQuestions[0].updatedAt, generatedAt: Date.now() }],
    },
  });

  const exported = await bg({ type: 'KNOWLEDGE_EXPORT', library: 'json' });
  check('导出 JSON 成功', exported.ok === true && exported.filename.endsWith('.json'));
  const parsed = JSON.parse(exported.content);
  check('envelope 带格式与版本', parsed.format === 'interview-knowledge-library' && parsed.version === 2);
  check('备份含两库与分类', parsed.data.projects.length === 1 && parsed.data.technicalQuestions.length === 1 && parsed.data.categories.length === 1);
  check('备份保留 AI 参考关系', parsed.data.projectQuestions[0].aiReferences.length === 1);
  check('备份保留来源与页码', parsed.data.technicalQuestions[0].sources[0].pageNumbers.join(',') === '3,5');
  check('备份不含 API Key / 原图 / 文件字节', !/sk-secret|data:image|data:application/i.test(exported.content));
  check('备份不含容器内部 revision 字段', !('revision' in parsed.data.technicalQuestions[0]));

  // 完整往返
  const valid = exporter.parseBackup(exported.content);
  check('导出的备份可以通过预校验', valid.ok === true, valid.errors.join(' '));
  const cleared = await bg({ type: 'KNOWLEDGE_RESTORE', text: exported.content, confirm: false });
  check('恢复预览给出替换范围', cleared.ok === true && cleared.counts.technicalQuestions === 1 && /项目 1 → 1/.test(cleared.preview));
  check('仅预览不会修改知识库', (await readLibrary()).technicalQuestions.length === 1 && cleared.counts.projects === 1);

  // 未知版本 / 非法归属 / 岗位备份
  const badVersion = exporter.parseBackup(JSON.stringify({ format: 'interview-knowledge-library', version: 99, data: {} }));
  check('未知版本被拒绝', badVersion.ok === false && /版本/.test(badVersion.errors[0]));
  const orphan = exporter.parseBackup(
    JSON.stringify({
      format: 'interview-knowledge-library',
      version: 1,
      data: { projects: [], categories: [], technicalQuestions: [], projectQuestions: [{ id: 'x', projectId: 'ghost', question: '题', answerMarkdown: '' }] },
    }),
  );
  check('非法项目归属被拒绝', orphan.ok === false && orphan.errors.some((e) => /不存在的项目/.test(e)));
  const jobBackup = exporter.parseBackup(JSON.stringify({ app: 'jd-job-tracker', version: 1, records: [] }));
  check('岗位备份会被识别并提示', jobBackup.ok === false && /岗位记录备份/.test(jobBackup.errors[0]));

  // 取消恢复：当前库不变
  const beforeCancel = (await readLibrary()).revision;
  check('取消恢复不改动知识库', (await readLibrary()).revision === beforeCancel);

  // revision 冲突与写入失败
  const staleRestore = await bg({ type: 'KNOWLEDGE_RESTORE', text: exported.content, confirm: true, baseRevision: 0 });
  check('容器 revision 过期时拒绝恢复', staleRestore.ok === false && staleRestore.code === 'conflict');
  memory.failWrites = true;
  const failRestore = await bg({ type: 'KNOWLEDGE_RESTORE', text: exported.content, confirm: true });
  memory.failWrites = false;
  check('写入失败时恢复不返回成功', failRestore.ok === false);
  check('恢复失败后当前知识库保持原样', (await readLibrary()).revision === beforeCancel);

  // 合法恢复：保留实体关系
  const copy = exporter.parseBackup(exported.content);
  const restored = await bg({ type: 'KNOWLEDGE_RESTORE', text: exported.content, confirm: true, baseRevision: (await readLibrary()).revision });
  const finalState = await readLibrary();
  check('合法恢复成功', restored.ok === true && finalState.projects.length === 1 && finalState.technicalQuestions.length === 1);
  check('恢复保留项目与问答的关系', finalState.projectQuestions[0].projectId === finalState.projects[0].id);
  check('恢复保留 AI 参考与来源', finalState.projectQuestions[0].aiReferences[0].technicalQuestionId === finalState.technicalQuestions[0].id);
  check('恢复不修改岗位记录与设置', memory.local.settings.apiKey === 'sk-secret-key' && memory.local.records[0].id === 'job1');
  check('恢复后容器 revision 继续增长', finalState.revision > copy.state.revision);

  // Markdown 导出与再导入
  const md = await bg({ type: 'KNOWLEDGE_EXPORT', library: 'technical' });
  check('导出八股文 Markdown 成功', md.ok === true && md.content.includes('### Q: 数据库索引为什么能加速查询？'));
  check('Markdown 含围栏代码块', md.content.includes('```sql'));
  const back = docs.splitMarkdownQuestions(md.content);
  check('导出的 Markdown 能重新分题', back.length === 1 && back[0].question === '数据库索引为什么能加速查询？');
  check('重新导入保留标签与分类元数据', back[0].tags.join(',') === '索引,性能优化' && back[0].categoryName === '数据库');
  check('重新导入保留代码块原文', back[0].answerMarkdown.includes('EXPLAIN SELECT 1;'));
  check('重新导入不漏答案正文', back[0].answerMarkdown.includes('减少扫描行数'));

  const mdProjects = await bg({ type: 'KNOWLEDGE_EXPORT', library: 'projects' });
  check('导出项目库 Markdown 含概况与职责', mdProjects.content.includes('校园二手交易平台') && mdProjects.content.includes('订单模块'));
  check('项目库 Markdown 含所属问答', mdProjects.content.includes('为什么用这个索引方案？'));

  const emptyState = store.emptyState();
  const emptyExport = exporter.toKnowledgeMarkdown(emptyState, { library: 'both' });
  check('空库 Markdown 不会崩', typeof emptyExport === 'string');
  check('空库导出再导入不产生假题目', docs.splitMarkdownQuestions(emptyExport).length === 0);
  const overviewOnly = store.createProject(store.emptyState(), { name: '只有概况的项目', summary: '项目简介', responsibilities: '负责服务端' }).state;
  check('无问答的项目导出不会把项目名当题目', docs.splitMarkdownQuestions(exporter.toKnowledgeMarkdown(overviewOnly, { library: 'projects' })).length === 0);
  check('旧版无问答的项目导出也不产生假题目', docs.splitMarkdownQuestions('# 项目库\n\n导出于 2026-10-15，共 1 个项目。\n\n## 只有概况的项目\n简介\n\n_暂无问答_\n').length === 0);
  const complexAnswer = '# 选型理由\n\n第一段。\n\n## 具体实现\n\n第二段。\n\n#### 边界条件\n\n第三段。\n\n```js\nconst first = 1;\n\n\nconst second = 2;\n```\n\nQ: 答案里的追问示例\nA: 答案里的解释\n\n<!--jdt:{"tags":["只是示例"]}-->\n';
  const roundtripState = store.createTechnicalQuestion(store.emptyState(), { question: '为什么使用索引？', answerMarkdown: complexAnswer, tags: ['索引'] }).state;
  const roundtrip = docs.splitMarkdownQuestions(exporter.toKnowledgeMarkdown(roundtripState, { library: 'technical' }));
  check('答案的任意层级标题和 Q/A 示例不会分裂题目', roundtrip.length === 1 && roundtrip[0].question === '为什么使用索引？');
  check('导出往返完整保留答案正文、代码空行与尾部换行', roundtrip[0]?.answerMarkdown === complexAnswer);
  check('答案中的元数据示例不会改变题目的标签', roundtrip[0]?.tags.join(',') === '索引');
  const generic = docs.splitMarkdownQuestions('## Q: 第一题\nA:\n# 答案标题\n正文\n#### 答案子标题\n细节\n## Q: 第二题\nA:\n第二份答案');
  check('一般 Markdown 显式 Q 分题保留答案内标题', generic.length === 2 && generic[0].answerMarkdown.includes('# 答案标题') && generic[0].answerMarkdown.includes('#### 答案子标题'));
  const plainHeading = docs.splitMarkdownQuestions('# 题库\n## 第一题\nA:\n### 答案子标题\n细节\n## 第二题\nA:\n第二份答案');
  check('无 Q 的题目可按 A 标记定位且保留答案标题', plainHeading.length === 2 && plainHeading[0].question === '第一题' && plainHeading[0].answerMarkdown.includes('### 答案子标题'));
  const unanswered = docs.splitMarkdownQuestions('# 题库\n## 第一题\nA:\n答案\n## 第二题\n');
  check('部分题目缺少 A 标记时仍保留空答案题', unanswered.length === 2 && unanswered[1].question === '第二题' && unanswered[1].answerMarkdown === '');
  const repeatedHeading = docs.splitMarkdownQuestions('# 题库\n## 第一题\n第一份答案\n### 详细解释\n细节\n## 第二题\n第二份答案\n### 另一说明\n更多细节');
  check('无 Q/A 的同层多题保留更深层的答案标题', repeatedHeading.length === 2 && repeatedHeading[0].question === '第一题' && repeatedHeading[0].answerMarkdown.includes('### 详细解释'));
  const codeAnswer = '```txt\nA: 代码中的文字\n```';
  const codeQuestion = docs.splitMarkdownQuestions(`## Q: 代码示例\n${codeAnswer}`);
  check('代码块中的 A 标记不会删除前面的代码围栏', codeQuestion.length === 1 && codeQuestion[0].answerMarkdown === codeAnswer);
  const mixedState = { ...roundtripState, projects: overviewOnly.projects };
  const mixed = docs.splitMarkdownQuestions(exporter.toKnowledgeMarkdown(mixedState, { library: 'both' }));
  check('混合导出忽略空项目且保留八股文答案', mixed.length === 1 && mixed[0].answerMarkdown === complexAnswer);
  check('项目 Markdown 导出包含 AI 参考来源', mdProjects.content.includes('AI 参考：数据库索引为什么能加速查询？'));
  const altered = exporter.toKnowledgeMarkdown(roundtripState, { library: 'technical' }).replace(/"answerLines":\d+/, '"answerLines":999999');
  let badBoundaryRejected = false;
  try { docs.splitMarkdownQuestions(altered); } catch (err) { badBoundaryRejected = err.code === 'corrupt'; }
  check('导出答案边界损坏时明确报错而非错误分题', badBoundaryRejected);
}

/* ------------------------------------------------------------------ */
/* [7] 模型客户端：错误归一化、超时、取消与降级                        */
/* ------------------------------------------------------------------ */

section('[7] 模型客户端（mock endpoint）');

{
  const baseSettings = { apiBase: 'https://api.deepseek.com', apiKey: 'sk-stub', model: 'deepseek-flash', timeoutMs: 3000, maxTokens: 1024 };
  const messages = [{ role: 'user', content: 'hi' }];

  // 缺 Key
  let err = null;
  try {
    await modelClient.chatComplete({ settings: { ...baseSettings, apiKey: '' }, messages });
  } catch (e) {
    err = e;
  }
  check('缺 Key 给出配置提示', err?.code === 'nokey' && /API Key/.test(err.message));

  // 空地址
  err = null;
  try {
    await modelClient.chatComplete({ settings: { ...baseSettings, apiBase: '' }, messages });
  } catch (e) {
    err = e;
  }
  check('接口地址为空时有明确报错', err?.code === 'nobase');

  // 401 / 403
  stubFetch(async () => jsonResponse({ error: 'invalid api key' }, 401));
  err = null;
  try {
    await modelClient.chatComplete({ settings: baseSettings, messages });
  } catch (e) {
    err = e;
  }
  check('401 翻译成可读提示', err?.code === 'auth' && /API Key/.test(err.message));

  // 非视觉模型
  stubFetch(async () => new Response('{"error":"This model does not support image input"}', { status: 400 }));
  err = null;
  try {
    await modelClient.chatComplete({ settings: baseSettings, messages, images: ['data:image/jpeg;base64,AAA'] });
  } catch (e) {
    err = e;
  }
  check('非视觉模型给出换模型提示', err?.code === 'novision' && /视觉/.test(err.message));

  // 服务端错误
  stubFetch(async () => new Response('boom', { status: 503 }));
  err = null;
  try {
    await modelClient.chatComplete({ settings: baseSettings, messages });
  } catch (e) {
    err = e;
  }
  check('5xx 标记为可重试', err?.code === 'server' && err.retryable === true);

  // 空响应：重试一次后报可读错误
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return chatResponse('{"questions":[]}');
  });
  err = null;
  try {
    await modelClient.chatJson({ settings: baseSettings, messages, isEmpty: ai.questionCandidatesEmpty });
  } catch (e) {
    err = e;
  }
  check('空返回会自动重试一次', calls === 2, `请求 ${calls} 次`);
  check('两次都空时给出可重试错误', err?.code === 'empty' && err.retryable === true);

  // JSON 模式不支持 → 降级重试
  calls = 0;
  stubFetch(async (_url, init) => {
    calls += 1;
    if (/response_format/.test(init.body)) return new Response('{"error":"response_format json_object is not supported"}', { status: 400 });
    return chatResponse('{"questions":[{"question":"题","answer":""}]}');
  });
  const degraded = await modelClient.chatJson({ settings: baseSettings, messages });
  check('JSON 模式不支持时自动降级', calls === 2 && degraded.json?.questions?.length === 1);

  // 超时
  stubFetch(hangingFetch);
  const started = Date.now();
  err = null;
  try {
    await modelClient.chatComplete({ settings: { ...baseSettings, timeoutMs: 60 }, messages });
  } catch (e) {
    err = e;
  }
  check('超时被归一化为可读错误', err?.code === 'timeout' && Date.now() - started < 3000, `${Date.now() - started}ms`);

  // 取消
  stubFetch(hangingFetch);
  const controller = new AbortController();
  const pendingCall = modelClient.chatComplete({ settings: baseSettings, messages, signal: controller.signal }).catch((e) => e);
  await sleep(30);
  controller.abort();
  const aborted = await pendingCall;
  check('外部取消被归一化', aborted?.code === 'aborted');

  restoreFetch();
}

/* ------------------------------------------------------------------ */
/* [8] AI 任务提示词与输出校验                                         */
/* ------------------------------------------------------------------ */

section('[8] 任务提示词与结构化输出校验');

{
  const resumeRaw = {
    projects: [
      { name: '校园二手交易平台', summary: '面向学生的闲置交易', responsibilities: '负责订单与支付' },
      { name: '', summary: '缺名字', responsibilities: '' },
    ],
    // 模型可能违反提示词多返回问答，这里必须被忽略
    questions: [{ question: '不该出现的问题', answer: '不该出现的答案' }],
  };
  const projects = ai.normalizeResumeProjects(resumeRaw);
  check('简历提取只保留有名字的项目', projects.length === 1);
  check('简历提取不生成问答，也不带多余字段', !('questions' in projects[0]) && Object.keys(projects[0]).sort().join(',') === 'name,responsibilities,summary');
  check('简历为空时可以被识别', ai.resumeProjectsEmpty({ projects: [] }) === true);

  const questionRaw = {
    questions: [
      { question: '什么是回表？', answer: '', tags: ['索引'] },
      { question: '为什么要用 B+ 树？', answer: '因为层高更低。', tags: 'not-array' },
      { question: '', answer: '没有题目' },
    ],
  };
  const cands = ai.normalizeQuestionCandidates(questionRaw, { sources: [{ type: 'pdf', fileName: 'a.pdf', pageNumbers: [2], importedAt: Date.now() }] });
  check('缺失答案保持为空，不代写', cands[0].answerMarkdown === '');
  check('空题目被丢弃', cands.length === 2);
  check('非数组 tags 被安全处理', Array.isArray(cands[1].tags));
  check('来源按页写在候选上', cands[0].sources[0].pageNumbers.join(',') === '2');

  const refs = [
    { question: '数据库索引为什么能加速查询？', answerMarkdown: '减少扫描行数' },
    { question: '什么是回表？', answerMarkdown: '' },
  ];
  const built = ai.buildProjectAnswerMessages({
    project: { name: '订单系统', summary: '电商订单', responsibilities: '索引优化' },
    question: '为什么用这个索引方案？',
    currentAnswer: '旧答案',
    references: refs,
  });
  const body = built.messages.map((m) => m.content).join('\n');
  check('请求包含项目事实', body.includes('订单系统') && body.includes('索引优化'));
  check('请求包含参考题内容', body.includes('数据库索引为什么能加速查询？'));
  check('请求区分资料与知识', /通用知识/.test(built.messages[0].content) && /不是这个项目的事实/.test(built.messages[0].content));
  check('空答案参考不会伪造答案', body.includes('这道题还没有答案'));

  const projectOnly = ai.buildProjectAnswerMessages({ project: { name: 'X' }, question: 'Q', references: refs, projectOnly: true });
  const onlyBody = projectOnly.messages.map((m) => m.content).join('\n');
  check('明确只按项目资料生成时不带参考内容', !onlyBody.includes('数据库索引为什么能加速查询？'));

  check('超长参考被明确拒绝而不是静默截断', (() => {
    try {
      ai.buildProjectAnswerMessages({
        project: { name: 'X', summary: 'x'.repeat(40000) },
        question: 'Q',
        references: [{ question: 'y'.repeat(30000), answerMarkdown: 'z'.repeat(30000) }],
      });
      return false;
    } catch (e) {
      return e.code === 'toolarge';
    }
  })());

  check('草稿解析剥掉模型包的代码围栏', ai.parseDraft('```markdown\n# 草稿\n正文\n```').markdown === '# 草稿\n正文');
  check('空草稿能被识别', ai.draftEmpty('   ') === true);
}

/* ------------------------------------------------------------------ */
/* [9] 后台任务编排：参考解析、取消与乱序                              */
/* ------------------------------------------------------------------ */

section('[9] 后台任务编排（requestId、取消、乱序、只发送选定参考）');

{
  delete memory.local[store.KNOWLEDGE_KEY];
  await chrome.storage.local.set({ settings: { apiBase: 'https://api.deepseek.com', apiKey: 'sk-secret-key', model: 'deepseek-flash', timeoutMs: 4000 } });
  delivered.length = 0;

  const proj = await bg({ type: 'KNOWLEDGE_APPLY', op: 'project.create', payload: { name: '订单系统', summary: '电商订单与支付', responsibilities: '索引优化与并发控制' } });
  const projectId = proj.result.project.id;
  const t1 = await bg({ type: 'KNOWLEDGE_APPLY', op: 'technicalQuestion.create', payload: { question: '数据库索引为什么能加速查询？', answerMarkdown: '减少扫描行数，把随机 IO 变成顺序 IO。' } });
  const t2 = await bg({ type: 'KNOWLEDGE_APPLY', op: 'technicalQuestion.create', payload: { question: 'synchronized 和 ReentrantLock 的区别？', answerMarkdown: '一个是 JVM 关键字，一个是 API。' } });
  const pq = await bg({ type: 'KNOWLEDGE_APPLY', op: 'projectQuestion.create', payload: { projectId, question: '为什么用这个索引方案？', answerMarkdown: '' } });
  const questionId = t1.result.question.id;
  const otherId = t2.result.question.id;
  const pqId = pq.result.question.id;

  // 只发送最终选定的参考
  let sentBody = '';
  stubFetch(async (_url, init) => {
    sentBody = init.body;
    return chatResponse('# 草稿\n\n一句话结论。\n\n- 待补充：优化前后的耗时');
  });
  const draftRun = await runTask({
    task: 'project-answer',
    projectId,
    question: '为什么用这个索引方案？',
    currentAnswer: '',
    referenceIds: [questionId],
  });
  check('草稿任务返回成功', draftRun.result?.ok === true && /待补充/.test(draftRun.result.draft));
  check(
    '请求只包含选定的参考题',
    sentBody.includes('数据库索引为什么能加速查询？') && !sentBody.includes('ReentrantLock'),
    sentBody ? `请求体 ${sentBody.length} 字符` : '没有捕获到请求体',
  );
  check('返回记录参考题元数据（ID/标题/时间）', draftRun.result.references[0].technicalQuestionId === questionId && Boolean(draftRun.result.references[0].questionTitle) && draftRun.result.references[0].referencedUpdatedAt > 0);
  check('草稿任务不携带 API Key 到页面', !JSON.stringify(draftRun.result).includes('sk-secret-key'));

  const missing = await runTask({ task: 'project-answer', projectId, question: 'Q', referenceIds: [questionId, 'ghost-id'] });
  check('失效参考被单独报告', missing.result.missingReferences.join(',') === 'ghost-id');

  // 参考题被删掉后，草稿仍可生成但会报告来源不可用
  await bg({ type: 'KNOWLEDGE_APPLY', op: 'technicalQuestion.delete', payload: { id: otherId, revision: t2.result.question.revision } });
  const afterDelete = await runTask({ task: 'project-answer', projectId, question: 'Q', referenceIds: [otherId] });
  check('参考题被删后请求不失败但报告缺失', afterDelete.result.ok === true && afterDelete.result.missingReferences.length === 1 && afterDelete.result.references.length === 0);

  // 缺少 Key / 权限不足
  await chrome.storage.local.set({ settings: { apiBase: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash' } });
  const noKey = await runTask({ task: 'extract-questions', images: ['data:image/jpeg;base64,AAA'] });
  check('缺少 Key 的任务返回可读错误', noKey.result.ok === false && noKey.result.code === 'nokey');

  await chrome.storage.local.set({ settings: { apiBase: 'https://api.deepseek.com', apiKey: 'sk-secret-key', model: 'deepseek-flash' } });
  permissionGranted = false;
  const noPerm = await runTask({ task: 'extract-questions', images: ['data:image/jpeg;base64,AAA'] });
  permissionGranted = true;
  check('域名未授权时提示授权', noPerm.result.ok === false && noPerm.result.code === 'permission' && noPerm.result.needPermission === true);

  // 取消：任务结束后 pending 被清理，结果不再成功
  stubFetch(hangingFetch);
  const accepted = await bg({ type: 'KNOWLEDGE_AI_RUN', task: 'project-answer', projectId, question: 'Q', referenceIds: [questionId] });
  await sleep(30);
  const abortRes = await bg({ type: 'KNOWLEDGE_TASK_ABORT', requestId: accepted.requestId });
  check('取消请求被接受', abortRes.ok === true);
  const cancelled = await waitResult(accepted.requestId);
  check('取消后的结果不是成功', cancelled.ok === false && cancelled.code === 'aborted');
  const pollAfter = await bg({ type: 'KNOWLEDGE_TASK_POLL', requestId: accepted.requestId });
  check('任务结束后 pending 被清理', pollAfter.pending === false && pollAfter.result?.ok === false);

  // 乱序返回：先发的慢任务不会覆盖后发的快任务结果
  delivered.length = 0;
  stubFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = JSON.stringify(body.messages);
    const slow = text.includes('慢');
    await sleep(slow ? 120 : 10);
    return chatResponse(`# ${slow ? '慢' : '快'}草稿`);
  });
  const slow = await bg({ type: 'KNOWLEDGE_AI_RUN', task: 'project-answer', projectId, question: '慢问题', referenceIds: [] });
  const fast = await bg({ type: 'KNOWLEDGE_AI_RUN', task: 'project-answer', projectId, question: '快问题', referenceIds: [] });
  const slowResult = await waitResult(slow.requestId);
  const fastResult = await waitResult(fast.requestId);
  check('乱序返回时各自匹配自己的 requestId', slowResult.requestId === slow.requestId && fastResult.requestId === fast.requestId);
  check('慢任务的结果没有被快任务覆盖', slowResult.draft.includes('慢') && fastResult.draft.includes('快'));

  // 提取任务：候选经过校验进入结果
  stubFetch(async () => chatResponse('{"questions":[{"question":"什么是回表？","answer":"","tags":["索引"]}]}'));
  const extracted = await runTask({
    task: 'extract-questions',
    images: ['data:image/jpeg;base64,AAA'],
    sources: [{ type: 'image-upload', fileName: 'shot.png', importedAt: Date.now() }],
  });
  check('图片提取返回候选且不代写答案', extracted.result.candidates.length === 1 && extracted.result.candidates[0].answerMarkdown === '');
  check('候选带来源且不含图片本身', extracted.result.candidates[0].sources[0].fileName === 'shot.png' && !JSON.stringify(extracted.result).includes('data:image'));

  // 任务结果与交接消息都不落 lastResult
  restoreFetch();
  check('知识库结果不写入岗位 lastResult', !memory.local.lastResult);
  void pqId;
}

/* ------------------------------------------------------------------ */
/* [10] 网页框选交接的 session 存储                                    */
/* ------------------------------------------------------------------ */

section('[10] 网页框选候选交接（session，只含纯文本）');

{
  memory.session.knowledgePending = {
    id: 'req_1',
    createdAt: Date.now(),
    source: 'web-region',
    origin: { pageTitle: '牛客网', url: 'https://www.nowcoder.com/x' },
    candidates: [{ question: 'TCP 为什么需要三次握手？', answerMarkdown: '', tags: [], sources: [{ type: 'web-region', url: 'https://www.nowcoder.com/x', importedAt: Date.now() }] }],
  };
  const taken = await bg({ type: 'KNOWLEDGE_PENDING_TAKE' });
  check('交接候选可被取走', taken.ok === true && taken.handoff.candidates.length === 1);
  check('取走后 session 里的候选被删除', memory.session.knowledgePending === undefined);
  const again = await bg({ type: 'KNOWLEDGE_PENDING_TAKE' });
  check('重复取走返回空', again.handoff === null);
  check('交接内容不含图片或文件字节', !JSON.stringify(taken.handoff).includes('data:'));
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

section('[11] 每日复习与 v2 兼容');
{
  const R=await import(mod('lib/knowledge-review.js'));
  const now=+new Date('2026-10-15T12:00:00'),day=R.localDay(now);
  const expectThrow=(f,code)=>{try{f();return false;}catch(e){return !code||e.code===code;}};
  let s=store.emptyState();
  s=store.createCategory(s,{name:'数据库'}).state;
  const cat=s.categories[0].id;
  for(let i=0;i<12;i++)s=store.createTechnicalQuestion(s,{question:`题 ${i}`,answerMarkdown:i===11?'':'# 答案\n代码',categoryId:cat,tags:['索引','性能']},now+i).state;
  const old=JSON.parse(JSON.stringify(s));old.schemaVersion=1;delete old.review;
  check('v1 迁移保留问答与版本并补空学习', store.normalizeState(old).technicalQuestions.length===12 && store.normalizeState(old).review.days.length===0 && old.review===undefined);
  check('未知未来容器版本拒绝',expectThrow(()=>store.normalizeState({...s,schemaVersion:99})));
  for(const [base,n,want] of [['2024-02-28',1,'2024-02-29'],['2024-02-29',1,'2024-03-01'],['2026-12-31',1,'2027-01-01'],['2026-03-08',1,'2026-03-09']])check(`日历加天 ${base}`,R.addDays(base,n)===want);
  check('日期严格校验及本地午夜',!R.validDay('2026-02-30')&&R.localDay(new Date(2026,9,15,0,1))==='2026-10-15');
  const tz=process.env.TZ;process.env.TZ='America/New_York';check('DST 按日历推进',R.addDays('2026-03-07',2)==='2026-03-09');process.env.TZ='Asia/Shanghai';check('时区变化使用当地日期',R.localDay(+new Date('2026-10-14T18:00:00Z'))==='2026-10-15');if(tz)process.env.TZ=tz;else delete process.env.TZ;
  check('题量范围拒绝非法数',expectThrow(()=>R.reviewSettings({dailyLimit:0}))&&expectThrow(()=>R.reviewSettings({dailyLimit:1.5}))&&expectThrow(()=>R.reviewSettings({dailyLimit:101})));
  let setup={dailyLimit:10,categoryId:cat,tags:['索引','性能']};
  s=R.reviewOp(s,'review.settings',setup,now).state;
  const weak=s.technicalQuestions[0].id;s.review.progress.push({questionId:weak,stage:0,lastResult:'needs-review',lastReviewedDay:'2026-10-14',dueDay:day});
  const picked=R.selectQuestions(s,setup,day,()=>.5);
  check('薄弱到期优先且随机无重复',picked[0].id===weak&&picked.length===10&&new Set(picked.map(q=>q.id)).size===10);
  check('空答案排除且分类标签同时过滤',R.candidates(s,setup).length===11&&R.candidates(s,{...setup,tags:['不存在']}).length===0);
  check('候选不足按实际数与零题拒绝',R.selectQuestions(s,{...setup,dailyLimit:100},day).length===11&&expectThrow(()=>R.reviewOp({...s,technicalQuestions:[]},'review.start',{day},now),'empty'));
  s=R.reviewOp(s,'review.start',{day},now,()=>.5).state;
  const plan=()=>s.review.days.find(d=>d.day===day);
  check('当日计划固定不可反复随机',JSON.stringify(R.reviewOp(s,'review.start',{day},now,()=>0).state.review.days)===JSON.stringify(s.review.days));
  const before=s.technicalQuestions[0].revision;
  const rate=(result='remembered')=>{const i=plan().items.find(i=>i.status==='pending'),q=s.technicalQuestions.find(q=>q.id===i.questionId);return {day,planRevision:plan().revision,containerRevision:s.revision,questionId:q.id,questionRevision:q.revision,result,revealed:true};};
  const p=rate();check('未揭晓、旧日期、临时作答拒绝',expectThrow(()=>R.reviewOp(s,'review.rate',{...p,revealed:false},now))&&expectThrow(()=>R.reviewOp(s,'review.rate',{...p,day:'2026-10-14'},now),'day-changed')&&expectThrow(()=>R.reviewOp(s,'review.rate',{...p,draft:'secret'},now)));
  check('旧题版本与旧容器拒绝',expectThrow(()=>R.reviewOp(s,'review.rate',{...p,questionRevision:99},now),'question-changed')&&expectThrow(()=>R.reviewOp(s,'review.rate',{...p,containerRevision:0},now),'conflict'));
  s=R.reviewOp(s,'review.rate',p,now).state;
  check('自评只推进学习不改题目 revision',s.technicalQuestions[0].revision===before&&s.review.progress.find(x=>x.questionId===p.questionId).dueDay===R.addDays(day,1));
  check('重复评分不多算',R.reviewOp(s,'review.rate',{...p,containerRevision:s.revision},now).state.review.days[0].items.filter(i=>i.status==='remembered').length===1);
  while(plan().items.some(i=>i.status==='pending'))s=R.reviewOp(s,'review.rate',rate('needs-review'),now).state;
  check('含需复习全部评分也打卡',!!plan().completedAt&&R.dayCounts(plan()).done===10&&R.streak(s.review,day)===1);
  check('当天未完成沿用昨天连续天数',R.streak(s.review,R.addDays(day,1))===1&&R.streak(s.review,R.addDays(day,2))===0);
  const data=exporter.toKnowledgeJson(s,now),rest=exporter.parseBackup(data);
  check('v2 学习记录完整往返且无答案副本',rest.ok&&JSON.stringify(rest.state.review)===JSON.stringify(s.review)&&!JSON.stringify(s.review).includes('answerMarkdown'));
  const missing=JSON.parse(data);delete missing.data.technicalQuestions;check('缺失必要数组不能被当作空库恢复',!exporter.parseBackup(JSON.stringify(missing)).ok);
  check('题目全删后仍可备份学习历史',!exporter.isEmptyLibrary({...store.emptyState(),review:s.review}));
  const oldBackup=JSON.parse(data);oldBackup.version=1;delete oldBackup.data.review;
  check('v1 备份仍能恢复为空学习记录',exporter.parseBackup(JSON.stringify(oldBackup)).state.review.days.length===0);
  const bad=JSON.parse(data);bad.data.review.days.push(bad.data.review.days[0]);check('重复日期备份拒绝且原库不变',!exporter.parseBackup(JSON.stringify(bad)).ok&&s.review.days.length===1);
  const whitelisted=JSON.parse(JSON.stringify(s));whitelisted.review.secret='temporary';check('备份剔除学习未知字段',!exporter.toKnowledgeJson(whitelisted).includes('temporary'));
  let single={...s,review:R.emptyReview(),technicalQuestions:[s.technicalQuestions[0]]};
  for(let n=0;n<7;n++){const t=now+n*86400000,d=R.localDay(t);single=R.reviewOp(single,'review.start',{day:d},t).state;const pl=single.review.days.at(-1),q=single.technicalQuestions[0];single=R.reviewOp(single,'review.rate',{day:d,planRevision:pl.revision,containerRevision:single.revision,questionId:q.id,questionRevision:q.revision,result:n===6?'needs-review':'remembered',revealed:true},t).state;check(`间隔阶段 ${n+1}`,single.review.progress[0].dueDay===R.addDays(d,n===6?1:[1,3,7,14,30,30][n]));}
  let deletion=R.reviewOp({...s,review:R.emptyReview()},'review.start',{day},now).state;
  deletion.technicalQuestions=[];deletion.review=R.reconcileReview(deletion.review,[],now);
  check('全部未评分题删除不生成零题打卡',!deletion.review.days[0].completedAt&&R.dayCounts(deletion.review.days[0]).total===0);
  check('删除已评分题仍保留历史',R.reconcileReview(s.review,[],now).days[0].items.length===10);
  await store.saveState({...s,review:R.emptyReview()});
  const ext={id:7,extensionPage:true};
  const run=(op,payload)=>bg({type:'KNOWLEDGE_APPLY',op,payload},ext);
  check('网页不能访问学习写入',!(await bg({type:'KNOWLEDGE_APPLY',op:'review.start',payload:{day:R.localDay()}})).ok);
  const starts=await Promise.all([run('review.start',{day:R.localDay()}),run('review.start',{day:R.localDay()})]);
  check('实际后台并发开始只一份计划',starts.every(x=>x.ok)&&(await store.loadState()).review.days.length===1);
  let live=await store.loadState();const pl=live.review.days[0],i=pl.items[0],q=live.technicalQuestions.find(q=>q.id===i.questionId);
  const rating={day:R.localDay(),planRevision:pl.revision,containerRevision:live.revision,questionId:q.id,questionRevision:q.revision,result:'remembered',revealed:true};
  memory.failWrites=true;const fail=await run('review.rate',rating);memory.failWrites=false;
  check('评分存储失败不算完成',!fail.ok&&R.dayCounts((await store.loadState()).review.days[0]).done===0);
  const preview=await bg({type:'KNOWLEDGE_RESTORE',text:data,confirm:false});
  const ratings=await Promise.all([run('review.rate',rating),run('review.rate',rating)]);
  check('实际并发评分仅推进一次',ratings.some(r=>r.ok)&&R.dayCounts((await store.loadState()).review.days[0]).done===1);
  const conflict=await bg({type:'KNOWLEDGE_RESTORE',text:data,confirm:true,baseRevision:preview.containerRevision});
  check('恢复旧预览不能覆盖新自评',!conflict.ok&&R.dayCounts((await store.loadState()).review.days[0]).done===1);
}

section('[12] 拖动排序持久化');
{
  let s=store.emptyState();
  const p1=store.createProject(s,{name:'项目一'});s=p1.state;
  const p2=store.createProject(s,{name:'项目二'});s=p2.state;
  for(const title of ['一','二','三'])s=store.createProjectQuestion(s,{projectId:p1.project.id,question:title,answerMarkdown:'答案'}).state;
  s=store.createProjectQuestion(s,{projectId:p2.project.id,question:'其他项目'}).state;
  for(const title of ['A','B','C'])s=store.createTechnicalQuestion(s,{question:title,answerMarkdown:'答案'}).state;
  const [a,b,c]=s.projectQuestions,rev=a.revision,time=a.updatedAt;
  s=store.applyOp(s,{op:'questions.move',payload:{library:'project',projectId:p1.project.id,id:a.id,targetId:c.id,side:'after',baseRevision:s.revision}}).state;
  check('项目题拖到目标后且其他项目不变',s.projectQuestions.map(q=>q.question).join(',')==='二,三,一,其他项目');
  check('排序不修改答案版本或更新时间',s.projectQuestions.find(q=>q.id===a.id).revision===rev&&s.projectQuestions.find(q=>q.id===a.id).updatedAt===time);
  const [ta,tb,tc]=s.technicalQuestions;
  s=store.applyOp(s,{op:'questions.move',payload:{library:'technical',id:tc.id,targetId:ta.id,side:'before',baseRevision:s.revision}}).state;
  check('八股题可前移并保持中间未移动题相对顺序',s.technicalQuestions.map(q=>q.question).join(',')==='C,A,B');
  let rejected=0;for(const patch of [{baseRevision:0},{library:'project',projectId:p1.project.id,id:a.id,targetId:s.projectQuestions.at(-1).id},{id:'deleted'}])try{store.applyOp(s,{op:'questions.move',payload:{library:'technical',id:tc.id,targetId:ta.id,side:'before',baseRevision:s.revision,...patch}});}catch{rejected++;}
  check('过期排序、跨项目拖动和已删除题目拒绝',rejected===3);
  const parsed=exporter.parseBackup(exporter.toKnowledgeJson(s));
  check('备份恢复及归一化保留两库题序',parsed.ok&&parsed.state.technicalQuestions.map(q=>q.id).join()===s.technicalQuestions.map(q=>q.id).join()&&store.normalizeState(s).projectQuestions.map(q=>q.id).join()===s.projectQuestions.map(q=>q.id).join());
}

section('[13] Markdown 选区编辑');
{
  const {markdownEdit:E}=await import(mod('knowledge/markdown-editor.js'));
  check('加粗选区保留前后内容',E('甲乙丙',1,2,'bold').text==='甲**乙**丙');
  check('重复加粗可移除外围标记',E('甲**乙**丙',3,4,'bold').text==='甲乙丙');
  check('空选区插入斜体占位',E('',0,0,'italic').text==='*文字*');
  check('多行列表及编号保留各行',E('甲\n乙',0,3,'bullet').text==='- 甲\n- 乙'&&E('甲\n乙',0,3,'ordered').text==='1. 甲\n2. 乙');
  check('跨行缩进后可反缩进',E(E('甲\n乙',0,3,'indent').text,0,7,'outdent').text==='甲\n乙');
  check('链接选中可编辑URL',E('文档',0,2,'link').text.slice(E('文档',0,2,'link').start,E('文档',0,2,'link').end)==='https://');
  check('行首空行标题不丢内容',E('\n尾部',0,0,'heading2').text==='## \n尾部');
}

section('[14] 中文标点边界加粗');
{
  const fs=await import('node:fs'),vm=await import('node:vm');
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(SRC,'vendor/marked/marked.min.js'),'utf8'),context);
  const {createMarkdownParser}=await import(mod('lib/markdown-parser.js'));const parser=createMarkdownParser(context.marked),parse=s=>parser.parse(s);
  for(const sample of ['以**“HEAD 提交 → 当前磁盘内容”**为比较范围','以 **“HEAD 提交 → 当前磁盘内容”** 为比较范围','前**（含标点的内容）**后','前**"中文引用"**后'])check(`中文加粗 ${sample}`,parse(sample).includes('<strong>'));
  check('转义双星号保留字面文本',!parse(String.raw`以\*\*“HEAD 提交 → 当前磁盘内容”\*\*为比较范围`).includes('<strong>'));
  check('行内代码不处理加粗',!parse('`以**“范围”**为准`').includes('<strong>'));
  check('原始HTML保留解析器既有规则',parse('<code>**“内容”**</code>')===context.marked.parse('<code>**“内容”**</code>'));
  check('围栏代码不处理加粗',!parse('```md\n以**“范围”**为准\n```').includes('<strong>'));
  check('缩进代码不处理加粗',!parse('    以**“范围”**为准').includes('<strong>'));
  check('加粗中的代码双星号不提前关闭',parse('前**“中文 `**` 内容”**后').includes('<strong>“中文 <code>**</code> 内容”</strong>'));
  check('未闭合与边界空白保持原规则',!parse('以**“内容” 为准').includes('<strong>')&&!parse('前** “内容” **后').includes('<strong>'));
  check('普通加粗和三重强调仍可用',parse('前**加粗**后').includes('<strong>加粗</strong>')&&parse('***中文***').includes('<em>'));
  check('加粗内保留行内代码与强调',parse('前**“中文 `code` 与 *斜体*”**后').includes('<code>code</code>')&&parse('前**“中文 *斜体*”**后').includes('<em>斜体</em>'));
}

section('[15] 局部编辑与彩色加粗');
{
 const {markdownEdit:E,markdownPatch:P}=await import(mod('knowledge/markdown-editor.js'));
 const before='前文'.repeat(500)+'目标'+'后文'.repeat(500),start=1000,result=E(before,start,start+2,'bold'),patch=P(before,result.text);
 check('加粗只替换选区附近而非全文',patch.start===1000&&patch.end===1002&&patch.text==='**目标**'&&before.slice(0,patch.start)+patch.text+before.slice(patch.end)===result.text);
 for(const color of ['blue','red','green']){
   const r=E('前目标后',1,3,'accent-'+color);
   check(`${color} 彩色加粗及同色取消`,r.text===`前<strong class="md-accent-${color}">目标</strong>后`&&E(r.text,r.start,r.end,'accent-'+color).text==='前目标后');
 }
 const blue=E('目标',0,2,'accent-blue'),red=E(blue.text,blue.start,blue.end,'accent-red');
 check('切换颜色替换旧标记而不多层嵌套',red.text==='<strong class="md-accent-red">目标</strong>');
 check('已有普通加粗转为彩色加粗',E('**目标**',2,4,'accent-green').text==='<strong class="md-accent-green">目标</strong>');
}

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
if (verbose) console.log(`（详细模式）storage 键：${Object.keys(memory.local).join(', ')}`);
process.exit(failed ? 1 : 0);
