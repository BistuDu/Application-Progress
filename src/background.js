/**
 * Service worker：扩展的编排层。
 * 负责截图 → 交给内容脚本框选 → 调用识别接口 → 回传结果 → 落库。
 * 所有需要联网和密钥的事情都放在这里，内容脚本保持"哑"的，避免密钥接触页面。
 */

import {
  getSettings,
  maskKey,
  originPattern,
  setSettings,
  statusNames,
} from './lib/settings.js';
import {
  addRecord,
  clearAll,
  computeStats,
  deleteRecords,
  findDuplicates,
  importSummaryText,
  listRecords,
  mergeImport,
  saveRecords,
  updateRecord,
} from './lib/store.js';
import { analyzeScreenshot, testConnection, VisionError } from './lib/vision.js';
import {
  applyOp,
  KnowledgeError,
  loadState,
  saveState,
  stateCounts,
} from './lib/knowledge-store.js';
import {
  backupToState,
  isEmptyLibrary,
  knowledgeFileName,
  parseBackup,
  restorePreviewText,
  toKnowledgeJson,
  toKnowledgeMarkdown,
} from './lib/knowledge-export.js';
import { chatJson, chatText, ModelError } from './lib/model-client.js';
import {
  AI_TASKS,
  buildProjectAnswerMessages,
  buildQuestionMessages,
  buildResumeMessages,
  normalizeQuestionCandidates,
  normalizeResumeProjects,
  parseDraft,
  questionCandidatesEmpty,
  resumeProjectsEmpty,
} from './lib/knowledge-ai.js';
import { createPreferenceStore, hostname } from './lib/island-preferences.js';
import { siteFromUrl, startOfDay } from './lib/util.js';

const BLOCKED_URL = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted):/i;
const STORE_URL = /^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i;

/** 网页框选得到的候选问答，暂存在 session 里等知识库页面取走（纯文本，处理完即删）。 */
const PENDING_KEY = 'knowledgePending';
/** 单次请求最多携带的图片数（多张扫描页）。 */
const MAX_TASK_IMAGES = 6;

/** 进行中的识别任务：requestId → AbortController */
const pending = new Map();
const captureLocks = new Set();
const islandPreferences = createPreferenceStore(chrome.storage.local);
/** 每个标签页最近一次的截图，供"重新截图/重新识别"复用 */
const lastCapture = new Map();

/** 知识库写入串行队列：所有写入都排在同一条链上，避免读改写竞争。 */
let knowledgeWriteChain = Promise.resolve();
/** 知识库模型任务：requestId → { controller, task, tabId } */
const knowledgeTasks = new Map();
/** 任务结果保留一小段时间，页面重开或消息丢失时可以补取。 */
const knowledgeResults = new Map();


/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(message, extra = {}) {
  return { ok: false, error: message, ...extra };
}

function startKeepalive() {
  const id = setInterval(() => {
    // 调用任意扩展 API 可以让 service worker 在长请求期间不被回收
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  return () => clearInterval(id);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function assertCapturable(tab) {
  if (!tab?.id || tab.id === chrome.tabs.TAB_ID_NONE) {
    return '没有找到可操作的标签页。';
  }
  const url = tab.url || tab.pendingUrl || '';
  if (url.startsWith('file://')) {
    return '无法截取本地文件页面：请在 chrome://extensions 里为本扩展开启「允许访问文件网址」。';
  }
  if (BLOCKED_URL.test(url)) {
    return '浏览器内置页面不允许截图，请在普通网页上使用。';
  }
  if (STORE_URL.test(url)) {
    return 'Chrome 应用商店页面不允许截图，请换一个页面。';
  }
  return '';
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: message || '',
      priority: 1,
    });
  } catch {
    /* 通知失败不影响主流程 */
  }
}

async function refreshBadge() {
  try {
    const records = await listRecords();
    const today = records.filter((r) => (r.createdAt || 0) >= startOfDay()).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    await chrome.action.setBadgeText({ text: today ? String(today) : '' });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 内容脚本注入                                                        */
/* ------------------------------------------------------------------ */

async function ensureOverlay(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'JDT_PING' });
    if (res?.pong) return;
  } catch {
    /* 未注入，走下面的注入流程 */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/overlay.js'] });
  await new Promise((r) => setTimeout(r, 30));
}

/* ------------------------------------------------------------------ */
/* 截图流程                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {'region'|'viewport'} mode
 * @param {'job'|'technical-question'} target 识别目标；缺省为岗位，旧快捷键与菜单行为不变
 */
async function startCapture(mode, target = 'job', source = null) {
  const goal = target === 'technical-question' ? 'technical-question' : 'job';
  const tab = source?.tabId != null ? await chrome.tabs.get(source.tabId) : await getActiveTab();
  const problem = assertCapturable(tab);
  if (problem) { await notify('无法截图', problem); return fail(problem); }
  if (source?.frameId && source.frameId !== 0) return fail('请在网页顶层使用。');
  if (captureLocks.has(tab.id) || [...pending.values()].some((c) => c.tabId === tab.id)) return fail('此页面已有采集任务，请先结束。');
  captureLocks.add(tab.id);
  const token = `capture_${Date.now()}_${Math.random()}`;
  let prepared = false;
  const url = tab.url;
  let documentId;
  const checkSource = async () => {
    if (source?.url && source.url !== url) throw new Error('网页已导航，请重新截图。');
    if (source?.documentId) {
      const doc = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [source.documentId] }, func: () => location.href });
      if (!doc.length || doc[0].result !== url) throw new Error('发起截图的文档已失效，请重试。');
    }
    const current = await chrome.tabs.get(tab.id);
    const win = await chrome.windows.get(tab.windowId);
    if (!current.active || !win.focused || current.url !== url || current.pendingUrl && current.pendingUrl !== url) throw new Error('网页或活动窗口已切换，请回到原网页重试。');
    if (documentId) {
      const ping = await chrome.tabs.sendMessage(tab.id, { type: 'JDT_ISLAND_PING' }, { frameId: 0 });
      if (ping.documentId !== documentId) throw new Error('网页已导航，请重新截图。');
    }
  };
  try {
    const settings = await getSettings();
    if (!settings.apiKey) { await openOptions(); return fail('还没有配置 API Key，请先打开扩展设置填写。', { needSetup: true }); }
    await checkSource();
    let ping;
    try { ping = await chrome.tabs.sendMessage(tab.id, { type: 'JDT_ISLAND_PING' }, { frameId: 0 }); } catch {}
    if (ping?.busy) return fail('此页面已有采集任务，请先结束。');
    documentId = ping?.documentId;
    if (documentId) {
      prepared = true;
      let waitTimer;
      const result = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: 'JDT_ISLAND_PREPARE', token }, { frameId: 0 }), new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error('网页准备截图超时，请重试。')), 600); })]).finally(() => clearTimeout(waitTimer));
      if (!result?.ok || result.documentId !== documentId) throw new Error(result?.error || '网页已导航，请重新截图。');
    }
    await checkSource();
    let captureTimer;
    const dataUrl = await Promise.race([chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 }), new Promise((_, reject) => { captureTimer = setTimeout(() => reject(new Error('截图超时，请重试。')), 3000); })]).finally(() => clearTimeout(captureTimer));
    await checkSource();
    await ensureOverlay(tab.id);
    await checkSource();
    lastCapture.set(tab.id, { dataUrl, at: Date.now() });
    await chrome.tabs.sendMessage(tab.id, {
      type: 'JDT_SHOW_SELECTOR', dataUrl, mode: mode === 'viewport' ? 'viewport' : 'region', target: goal,
      statuses: settings.statuses, defaultStatus: settings.defaultStatus,
      cropMaxSide: settings.cropMaxSide, cropQuality: settings.cropQuality,
      warnDuplicate: settings.warnDuplicate, closePanelAfterSave: settings.closePanelAfterSave,
      autoOpenDashboard: settings.autoOpenDashboard, model: settings.model, timeoutMs: settings.timeoutMs,
    }, { frameId: 0 });
    return ok({ target: goal });
  } catch (err) {
    const error = `无法开始截图：${err?.message || err}`;
    await chrome.tabs.sendMessage(tab.id, { type: 'JDT_ISLAND_FEEDBACK', error }, { frameId: 0 }).catch(() => {});
    await notify('无法截图', error);
    return fail(error);
  }
  finally {
    captureLocks.delete(tab.id);
    if (prepared) await chrome.tabs.sendMessage(tab.id, { type: 'JDT_ISLAND_RELEASE', token }, { frameId: 0 }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 识别流程                                                            */
/* ------------------------------------------------------------------ */

async function runAnalysis({ requestId, image, pageTitle, pageUrl, sourceSite, tabId }) {
  const controller = new AbortController();
  controller.tabId = tabId;
  pending.set(requestId, controller);
  const stopKeepalive = startKeepalive();
  try {
    const settings = await getSettings();
    if (controller.signal.aborted) return;
    const payload = {
      settings,
      pageTitle,
      pageUrl,
      sourceSite: sourceSite || siteFromUrl(pageUrl),
      externalSignal: controller.signal,
    };
    const out = await analyzeScreenshot({ ...payload, image });
    if (controller.signal.aborted) return;
    await deliver(tabId, { type: 'JDT_ANALYZE_RESULT', requestId, ok: true, ...out }, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return;
    const isVision = err instanceof VisionError;
    await deliver(tabId, {
      type: 'JDT_ANALYZE_RESULT',
      requestId,
      ok: false,
      error: err?.message || String(err),
      code: isVision ? err.code : 'unknown',
      retryable: isVision ? err.retryable : true,
      detail: isVision ? err.detail : '',
      endpoint: isVision ? err.endpoint : '',
    }, controller.signal);
  } finally {
    pending.delete(requestId);
    stopKeepalive();
  }
}

async function deliver(tabId, message, signal) {
  try {
    if (tabId != null) await chrome.tabs.sendMessage(tabId, message);
  } catch {
    if (signal?.aborted) return;
    /* 页面可能已关闭，落在 storage 里等下次打开 */
    const history = (await chrome.storage.local.get('lastResult')).lastResult || [];
    await chrome.storage.local.set({ lastResult: [message, ...history].slice(0, 5) });
  }
}

/* ------------------------------------------------------------------ */
/* 知识库：写入队列、任务编排、跨页交接                                 */
/* ------------------------------------------------------------------ */

/**
 * 知识库写入串行化：一次写入 = 读 → 纯函数变更 → 写回，全部排在同一条链上。
 * 前一次失败不会卡住后面的写入，但成功响应只在存储 Promise 成功后返回。
 */
function withKnowledgeWrite(fn) {
  const run = knowledgeWriteChain.then(fn, fn);
  knowledgeWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function knowledgeErrorPayload(err) {
  const isKnown = err instanceof KnowledgeError || err instanceof ModelError;
  return {
    ok: false,
    error: err?.message || String(err),
    code: isKnown ? err.code : 'unknown',
    retryable: isKnown ? Boolean(err.retryable) : true,
    detail: isKnown ? err.detail || '' : '',
    needPermission: isKnown && err.code === 'permission',
  };
}

const knowledgePageUrl = () => chrome.runtime.getURL('src/knowledge/knowledge.html');

/**
 * 找出已经打开的知识库页面。
 * 先按 URL 前缀筛（快路径）；Chrome 在没有 tabs 权限时可能读不到 tab.url，
 * 这时逐个标签页 ping 一次，只有知识库页面会回应，避免每次框选都再开一个新标签。
 */
async function findKnowledgeTabs() {
  const base = knowledgePageUrl();
  let all = [];
  try {
    all = await chrome.tabs.query({});
  } catch {
    return [];
  }
  const byUrl = all.filter((t) => (t.url || '').startsWith(base) || (t.pendingUrl || '').startsWith(base));
  if (byUrl.length) return byUrl;

  const alive = [];
  for (const tab of all) {
    if (tab.id == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'JDT_KNOWLEDGE_PING' });
      if (res?.knowledge) alive.push(tab);
    } catch {
      /* 不是知识库页面（没有监听或页面已关闭） */
    }
  }
  return alive;
}

async function openKnowledge(signal) {
  const existing = await findKnowledgeTabs();
  if (signal?.aborted) return fail('已取消识别');
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) await chrome.windows.update(existing[0].windowId, { focused: true });
    return ok({ tabId: existing[0].id, reused: true });
  }
  const tab = await chrome.tabs.create({ url: knowledgePageUrl() });
  return ok({ tabId: tab.id, reused: false });
}

/** 已经开着的知识库页面需要知道有新候选可取。 */
async function notifyKnowledgePages(message) {
  try {
    const tabs = await findKnowledgeTabs();
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => {})));
  } catch {
    /* 没有打开的页面就算了，页面下次加载会自己取 */
  }
}

/**
 * 推送知识库任务结果。
 * 与岗位结果不同：这里绝不写入 lastResult（那是岗位结果的持久化兜底，会留下图片）。
 */
async function deliverKnowledgeResult(tabId, payload) {
  knowledgeResults.set(payload.requestId, payload);
  while (knowledgeResults.size > 20) knowledgeResults.delete(knowledgeResults.keys().next().value);
  try {
    if (tabId != null) await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    /* 页面可能已关闭：结果留在内存里，页面重开可用 requestId 补取 */
  }
  return payload;
}

/** 单个知识库模型任务的执行体：只负责构造请求与校验输出。 */
async function executeKnowledgeTask(msg, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new ModelError('还没有配置 API Key。请打开扩展设置，填入 Key 后再试。', { code: 'nokey' });
  }
  if (!(await hasHostPermission(settings.apiBase))) {
    throw new ModelError('还没有授权访问该接口域名，请到设置页点「授权此域名」后重试。', { code: 'permission' });
  }
  const images = (Array.isArray(msg.images) ? msg.images : []).filter(Boolean).slice(0, MAX_TASK_IMAGES);

  if (msg.task === AI_TASKS.resumeProjects) {
    const { messages, images: payloadImages } = buildResumeMessages({
      text: msg.text || '',
      images,
      fileName: msg.fileName || '',
    });
    const out = await chatJson({ settings, messages, images: payloadImages, signal, isEmpty: resumeProjectsEmpty });
    return { projects: normalizeResumeProjects(out.json), meta: out.meta };
  }

  if (msg.task === AI_TASKS.extractQuestions) {
    const { messages, images: payloadImages } = buildQuestionMessages({
      text: msg.text || '',
      images,
      fileName: msg.fileName || '',
      pageNumbers: Array.isArray(msg.pageNumbers) ? msg.pageNumbers : [],
      hint: msg.hint || '',
    });
    const out = await chatJson({ settings, messages, images: payloadImages, signal, isEmpty: questionCandidatesEmpty });
    return {
      candidates: normalizeQuestionCandidates(out.json, { sources: Array.isArray(msg.sources) ? msg.sources : [] }),
      meta: out.meta,
    };
  }

  if (msg.task === AI_TASKS.projectAnswer) {
    const state = await loadState();
    const project = state.projects.find((p) => p.id === msg.projectId);
    if (!project) throw new KnowledgeError('项目不存在，可能已被删除或替换。', { code: 'not-found' });
    // 参考题按 ID 从正式库解析：请求里只会出现用户最终选定的内容，未被选中的题不会进入请求
    const ids = Array.isArray(msg.referenceIds) ? msg.referenceIds : [];
    const selected = ids.map((id) => state.technicalQuestions.find((q) => q.id === id)).filter(Boolean);
    const missingReferences = msg.projectOnly ? [] : ids.filter((id) => !state.technicalQuestions.some((q) => q.id === id));
    // 用户明确选择「只按项目资料生成」时，不把任何参考题写进请求，也不在答案上记录参考来源
    const references = msg.projectOnly
      ? []
      : selected.map((q) => ({
        technicalQuestionId: q.id,
        questionTitle: q.question,
        referencedUpdatedAt: q.updatedAt,
        answerMarkdown: q.answerMarkdown,
      }));
    const { messages } = buildProjectAnswerMessages({
      project,
      question: msg.question || '',
      currentAnswer: msg.currentAnswer || '',
      references,
      projectOnly: Boolean(msg.projectOnly),
    });
    const out = await chatText({ settings, messages, signal });
    return {
      draft: parseDraft(out.text).markdown,
      references: references.map((r) => ({
        technicalQuestionId: r.technicalQuestionId,
        questionTitle: r.questionTitle,
        referencedUpdatedAt: r.referencedUpdatedAt,
      })),
      missingReferences,
      projectRevision: project.revision,
      meta: out.meta,
    };
  }

  throw new ModelError(`未知的知识库任务：${msg.task}`, { code: 'unknown' });
}

async function runKnowledgeTask(msg) {
  const requestId = msg.requestId;
  const controller = new AbortController();
  knowledgeTasks.set(requestId, { controller, task: msg.task, tabId: msg.tabId ?? null });
  const stopKeepalive = startKeepalive();
  try {
    const payload = await executeKnowledgeTask(msg, controller.signal);
    await deliverKnowledgeResult(msg.tabId ?? null, {
      type: 'JDT_KNOWLEDGE_RESULT',
      requestId,
      task: msg.task,
      ok: true,
      ...payload,
    });
  } catch (err) {
    await deliverKnowledgeResult(msg.tabId ?? null, {
      type: 'JDT_KNOWLEDGE_RESULT',
      requestId,
      task: msg.task,
      ...knowledgeErrorPayload(err),
    });
  } finally {
    knowledgeTasks.delete(requestId);
    stopKeepalive();
  }
}

/**
 * 网页框选 → 提取候选问答 → session 交接 + 打开知识库页面核对。
 * 图片只在内存里流转：识别结束（成功/失败/取消）后清掉截图缓存，
 * 也绝不写 lastResult 或 storage.local。
 */
async function runWebQuestionAnalysis({ requestId, image, pageTitle, pageUrl, tabId }) {
  const controller = new AbortController();
  controller.tabId = tabId;
  pending.set(requestId, controller);
  const stopKeepalive = startKeepalive();
  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new ModelError('还没有配置 API Key，请先打开扩展设置填写。', { code: 'nokey' });
    if (!(await hasHostPermission(settings.apiBase))) {
      throw new ModelError('还没有授权访问该接口域名，请到设置页点「授权此域名」后重试。', { code: 'permission' });
    }
    const sources = [{ type: 'web-region', url: pageUrl || '', pageTitle: pageTitle || '', importedAt: Date.now() }];
    const { messages } = buildQuestionMessages({ images: [image], hint: '这是用户在网页上框选的题目区域截图。' });
    const out = await chatJson({
      settings,
      messages,
      images: [image],
      signal: controller.signal,
      isEmpty: questionCandidatesEmpty,
    });
    if (controller.signal.aborted) return;
    const candidates = normalizeQuestionCandidates(out.json, { sources });
    if (!candidates.length) {
      throw new ModelError('没有从框选区域里识别到题目，换一个范围再试试。', { code: 'empty', retryable: true });
    }
    await chrome.storage.session.set({
      [PENDING_KEY]: {
        id: requestId,
        createdAt: Date.now(),
        source: 'web-region',
        origin: { pageTitle: pageTitle || '', url: pageUrl || '' },
        candidates,
      },
    });
    if (controller.signal.aborted) { await chrome.storage.session.remove(PENDING_KEY); return; }
    await deliverKnowledgeResult(tabId, {
      type: 'JDT_ANALYZE_RESULT',
      requestId,
      ok: true,
      target: 'technical-question',
      handedOff: true,
      count: candidates.length,
    });
    if (controller.signal.aborted) { await chrome.storage.session.remove(PENDING_KEY); return; }
    await openKnowledge(controller.signal);
    if (controller.signal.aborted) { await chrome.storage.session.remove(PENDING_KEY); return; }
    await notifyKnowledgePages({ type: 'JDT_KNOWLEDGE_PENDING' });
  } catch (err) {
    if (controller.signal.aborted) return;
    await deliverKnowledgeResult(tabId, {
      type: 'JDT_ANALYZE_RESULT',
      requestId,
      ok: false,
      target: 'technical-question',
      ...knowledgeErrorPayload(err),
    });
  } finally {
    pending.delete(requestId);
    stopKeepalive();
    lastCapture.delete(tabId);
  }
}

/* ------------------------------------------------------------------ */
/* 设置与权限                                                          */
/* ------------------------------------------------------------------ */

async function publicSettings() {
  const s = await getSettings();
  return { ...s, apiKeyMasked: maskKey(s.apiKey), hasApiKey: Boolean(s.apiKey) };
}

/** 列表场景不带截图，几百条记录也能秒开；截图按 id 单独取。 */
function stripScreenshots(records) {
  return records.map((r) => (r.screenshot ? { ...r, screenshot: '' } : r));
}

async function hasHostPermission(apiBase) {
  const pattern = originPattern(apiBase || (await getSettings()).apiBase);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function requestHostPermission(apiBase) {
  const pattern = originPattern(apiBase || (await getSettings()).apiBase);
  if (!pattern) return false;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function openOptions() {
  await chrome.runtime.openOptionsPage();
}

async function openDashboard() {
  const url = chrome.runtime.getURL('src/dashboard/dashboard.html');
  const all = await chrome.tabs.query({});
  const existing = all.filter((tab) => tab.url === url);
  if (!existing.length) {
    for (const tab of all) {
      try { if ((await chrome.tabs.sendMessage(tab.id, { type: 'JDT_DASHBOARD_PING' }))?.dashboard) { existing.push(tab); break; } } catch {}
    }
  }
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) await chrome.windows.update(existing[0].windowId, { focused: true });
    return ok({ tabId: existing[0].id, reused: true });
  }
  const tab = await chrome.tabs.create({ url });
  return ok({ tabId: tab.id, reused: false });
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function islandContext(msg, allowHost = false) {
  if (msg.source) {
    if (msg.source.frameId !== 0 || !hostname(msg.source.url)) throw new Error('仅支持普通网页的顶层入口。');
    const tab = await chrome.tabs.get(msg.source.tabId);
    if (tab.url !== msg.source.url) throw new Error('网页已导航，请刷新后重试。');
    return { host: hostname(tab.url), available: !assertCapturable(tab) };
  }
  if (!msg.extensionSender) throw new Error('不允许访问入口偏好。');
  if (allowHost && msg.host) return { host: String(msg.host).toLowerCase(), available: true };
  const tab = await getActiveTab();
  return { host: hostname(tab?.url), available: !!hostname(tab?.url) && !assertCapturable(tab) };
}
const handlers = {
  async ISLAND_GET_STATE(msg) {
    const context = await islandContext(msg);
    const permission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const preferences = await islandPreferences.read();
    return ok({ preferences, ...context, permission, enabled: !preferences.disabledHosts.includes(context.host) });
  },
  async ISLAND_SET_POSITION(msg) { await islandContext(msg); return ok({ preferences: await islandPreferences.update({ position: msg.position }) }); },
  async ISLAND_RESET_POSITION(msg) { await islandContext(msg); return ok({ preferences: await islandPreferences.update({ reset: true }) }); },
  async ISLAND_SET_SITE(msg) {
    const context = await islandContext(msg, true);
    if (!context.available) return fail('此页面不支持常驻入口。');
    return ok({ preferences: await islandPreferences.update({ host: context.host, enabled: msg.enabled === true }) });
  },
  async GET_STATE({ withScreenshots = false } = {}) {
    const settings = await publicSettings();
    const records = await listRecords();
    return ok({
      settings,
      records: withScreenshots ? records : stripScreenshots(records),
      stats: computeStats(records, settings),
    });
  },

  async LIST_RECORDS({ withScreenshots = false } = {}) {
    const settings = await publicSettings();
    const records = await listRecords();
    return ok({
      settings,
      records: withScreenshots ? records : stripScreenshots(records),
      stats: computeStats(records, settings),
    });
  },

  async GET_SCREENSHOT({ id }) {
    const records = await listRecords();
    const found = records.find((r) => r.id === id);
    return ok({ screenshot: found?.screenshot || '' });
  },

  async GET_RECENT({ limit = 8 } = {}) {
    const records = await listRecords();
    const settings = await getSettings();
    const sorted = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
    return ok({
      records: stripScreenshots(sorted),
      statuses: settings.statuses,
      stats: computeStats(records, settings),
    });
  },

  async SAVE_SETTINGS({ patch }) {
    const next = await setSettings(patch || {});
    return ok({ settings: { ...next, apiKeyMasked: maskKey(next.apiKey), hasApiKey: Boolean(next.apiKey) } });
  },

  async CHECK_PERMISSION({ apiBase }) {
    return ok({ granted: await hasHostPermission(apiBase) });
  },

  async REQUEST_PERMISSION({ apiBase }) {
    return ok({ granted: await requestHostPermission(apiBase) });
  },

  async TEST_CONNECTION({ override } = {}) {
    const settings = { ...(await getSettings()), ...(override || {}) };
    if (!settings.apiKey) return fail('请先填写 API Key。');
    const granted = await hasHostPermission(settings.apiBase);
    if (!granted) return fail('还没有授权访问该接口域名，点「授权此域名」后再测试。', { needPermission: true });
    return ok({ result: await testConnection(settings) });
  },

  async START_CAPTURE({ mode, target, source }) {
    return startCapture(mode, target, source);
  },

  async RECAPTURE({ mode, target, source }) {
    return startCapture(mode || 'region', target, source);
  },

  async ANALYZE(msg) {
    const requestId = msg.requestId || `req_${Date.now()}`;
    if (pending.has(requestId) || [...pending.values()].some((c) => c.tabId === msg.tabId)) return fail('该页面已有识别请求正在处理中。');
    // 显式目标决定走岗位流程还是八股文题目流程，缺省仍是岗位
    const target = msg.target === 'technical-question' ? 'technical-question' : 'job';
    if (target === 'technical-question') runWebQuestionAnalysis({ ...msg, requestId });
    else runAnalysis({ ...msg, requestId });
    // 立即回执，结果通过 JDT_ANALYZE_RESULT 推送，避免长请求期间连接被回收
    return ok({ accepted: true, requestId, target });
  },

  async ANALYZE_ABORT({ requestId, source }) {
    const c = pending.get(requestId);
    if (c && (!source || c.tabId === source.tabId)) {
      c.abort();
      pending.delete(requestId);
      return ok();
    }
    return fail('没有进行中的识别任务。');
  },

  async ANALYZE_SYNC(msg) {
    // 供 popup / 无内容脚本场景直接拿结果
    const settings = await getSettings();
    try {
      const out = await analyzeScreenshot({
        image: msg.image,
        settings,
        pageTitle: msg.pageTitle,
        pageUrl: msg.pageUrl,
        sourceSite: msg.sourceSite || siteFromUrl(msg.pageUrl),
        keepalive: startKeepalive,
      });
      return ok(out);
    } catch (err) {
      return fail(err?.message || String(err), { code: err?.code, retryable: err?.retryable });
    }
  },

  async CHECK_DUPLICATE({ company, title }) {
    const records = await listRecords();
    const settings = await getSettings();
    return ok({ duplicates: findDuplicates(records, { company, title }).slice(0, 5), statuses: settings.statuses });
  },

  async SAVE_RECORD({ input }) {
    const settings = await getSettings();
    const records = await listRecords();
    const dupes = settings.warnDuplicate
      ? findDuplicates(records, { company: input.company, title: input.title, id: input.id })
      : [];
    if (input.mergeInto) {
      const updated = await updateRecord(input.mergeInto, input);
      await refreshBadge();
      return ok({ record: updated, merged: true });
    }
    const record = await addRecord(input, { settings });
    await refreshBadge();
    return ok({ record, duplicates: dupes.map((d) => ({ id: d.id, company: d.company, title: d.title, status: d.status })) });
  },

  async UPDATE_RECORD({ id, patch }) {
    const record = await updateRecord(id, patch);
    if (!record) return fail('记录不存在，可能已被删除。');
    await refreshBadge();
    return ok({ record });
  },

  async DELETE_RECORDS({ ids }) {
    const n = await deleteRecords(ids);
    await refreshBadge();
    return ok({ deleted: n });
  },

  async CLEAR_ALL() {
    await clearAll();
    await refreshBadge();
    return ok();
  },

  async IMPORT_RECORDS({ records: incoming }) {
    if (!Array.isArray(incoming)) return fail('导入内容格式不对。');
    const existing = await listRecords();
    const { records, added, updated, skipped } = mergeImport(existing, incoming);
    await saveRecords(records);
    await refreshBadge();
    return ok({ added, updated, skipped, message: importSummaryText({ added, updated, skipped }) });
  },

  async STATS() {
    const records = await listRecords();
    const settings = await getSettings();
    return ok({ stats: computeStats(records, settings), statuses: settings.statuses });
  },

  async GET_STATUSES() {
    const settings = await getSettings();
    return ok({ statuses: settings.statuses, names: statusNames(settings), defaultStatus: settings.defaultStatus });
  },

  /* ---------------- 知识库 ---------------- */

  /** 只返回页面需要的设置摘要：知识库相关的消息从不携带 API Key 原文。 */
  async KNOWLEDGE_GET() {
    const state = await loadState();
    const settings = await getSettings();
    return ok({
      state,
      counts: stateCounts(state),
      settings: { model: settings.model, apiBase: settings.apiBase, hasApiKey: Boolean(settings.apiKey) },
    });
  },

  /** 单实体/批量候选变更：串行写入 + revision 校验，失败不返回成功。 */
  async KNOWLEDGE_APPLY({ op, payload, extensionSender }) {
    if (op?.startsWith('review.') && !extensionSender) return fail('学习记录只允许扩展页面访问。');
    try {
      const out = await withKnowledgeWrite(async () => {
        const state = await loadState();
        const { state: next, result } = applyOp(state, { op, payload });
        await saveState(next);
        return { next, result };
      });
      return ok({ state: out.next, counts: stateCounts(out.next), result: out.result });
    } catch (err) {
      return knowledgeErrorPayload(err);
    }
  },

  /**
   * 恢复知识库：confirm=false 只做预校验与替换范围预览；
   * confirm=true 才单次写入，失败/取消/未知版本都不改变当前库。
   */
  async KNOWLEDGE_RESTORE({ text, confirm, baseRevision }) {
    const parsed = parseBackup(text);
    if (!parsed.ok) return fail(parsed.errors.join(' '), { code: 'invalid-backup', errors: parsed.errors });
    const current = await loadState();
    const preview = restorePreviewText(parsed.counts, stateCounts(current));
    if (baseRevision !== undefined && Number(baseRevision) !== current.revision) {
      return fail('知识库已被其他页面修改，请重新选择备份文件再恢复。', { code: 'conflict' });
    }
    if (!confirm) {
      return ok({ counts: parsed.counts, currentCounts: stateCounts(current), preview, containerRevision: current.revision });
    }
    try {
      const next = await withKnowledgeWrite(async () => {
        const latest = await loadState();
        if (baseRevision === undefined || Number(baseRevision) !== latest.revision) throw Object.assign(new Error('知识库已更新，请重新预览后恢复。'), { code: 'conflict' });
        const state = backupToState(parsed.state, { containerRevision: latest.revision });
        await saveState(state);
        return state;
      });
      return ok({ state: next, counts: stateCounts(next), preview });
    } catch (err) {
      return knowledgeErrorPayload(err);
    }
  },

  async KNOWLEDGE_EXPORT({ library = 'json' }) {
    const state = await loadState();
    if (isEmptyLibrary(state)) return fail('知识库还是空的，先添加项目或题目再导出。', { code: 'empty' });
    if (library === 'json') {
      return ok({
        content: toKnowledgeJson(state),
        filename: knowledgeFileName({ library: 'both', ext: 'json' }),
        mime: 'application/json',
      });
    }
    const target = library === 'projects' || library === 'technical' ? library : 'both';
    return ok({
      content: toKnowledgeMarkdown(state, { library: target }),
      filename: knowledgeFileName({ library: target, ext: 'md' }),
      mime: 'text/markdown',
    });
  },

  async KNOWLEDGE_AI_RUN(msg) {
    const requestId = msg.requestId || `kt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (knowledgeTasks.has(requestId)) return fail('该任务正在处理中。');
    runKnowledgeTask({ ...msg, requestId });
    return ok({ accepted: true, requestId });
  },

  async KNOWLEDGE_TASK_ABORT({ requestId }) {
    const entry = knowledgeTasks.get(requestId);
    if (!entry) return fail('没有进行中的任务。');
    entry.controller.abort();
    return ok();
  },

  async KNOWLEDGE_TASK_POLL({ requestId }) {
    const found = knowledgeResults.get(requestId);
    if (!found) return ok({ pending: knowledgeTasks.has(requestId), result: null });
    return ok({ pending: false, result: found });
  },

  /** 取走网页框选交接过来的纯文本候选（取走即删，不含图片与文件字节）。 */
  async KNOWLEDGE_PENDING_TAKE() {
    const { [PENDING_KEY]: handoff } = await chrome.storage.session.get(PENDING_KEY);
    if (!handoff) return ok({ handoff: null });
    await chrome.storage.session.remove(PENDING_KEY);
    return ok({ handoff });
  },

  async KNOWLEDGE_PENDING_CLEAR() {
    await chrome.storage.session.remove(PENDING_KEY);
    return ok();
  },

  async OPEN_KNOWLEDGE() {
    return openKnowledge();
  },

  async OPEN_DASHBOARD() {
    return openDashboard();
  },

  async OPEN_OPTIONS() {
    await openOptions();
    return ok();
  },

  /** 内容脚本上报"已保存"，用于可选地打开进度表 */
  async AFTER_SAVE({ openDashboard: shouldOpen }) {
    if (shouldOpen) await openDashboard();
    return ok();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!type || type.startsWith('JDT_')) return false;
  const handler = handlers[type];
  if (!handler) {
    sendResponse(fail(`未知消息类型：${type}`));
    return false;
  }
  // 内容脚本发来的消息补上标签页信息
  const isExtensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  const source = sender?.tab && !isExtensionPage ? { tabId: sender.tab.id, frameId: sender.frameId, url: sender.url, documentId: sender.documentId } : null;
  const enriched = { ...msg, tabId: sender?.tab?.id ?? msg.tabId ?? null, senderUrl: sender?.tab?.url || '', source, extensionSender: !!isExtensionPage };
  Promise.resolve(handler(enriched))
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse(fail(err?.message || String(err))));
  return true; // 异步响应
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'jdt-capture-region',
    title: '记录这个岗位（框选截图识别 JD）',
    contexts: ['page', 'image', 'selection'],
  });
  chrome.contextMenus.create({
    id: 'jdt-capture-viewport',
    title: '记录这个岗位（整屏截图识别）',
    contexts: ['page', 'image'],
  });
  chrome.contextMenus.create({
    id: 'jdt-capture-question',
    title: '提取八股文题目（框选截图识别）',
    contexts: ['page', 'image', 'selection'],
  });
  chrome.contextMenus.create({
    id: 'jdt-open-dashboard',
    title: '打开投递进度表',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'jdt-open-knowledge',
    title: '打开面试知识库',
    contexts: ['page'],
  });
  await Promise.allSettled((await chrome.tabs.query({})).filter((t) => hostname(t.url) && !assertCapturable(t)).map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/lib/island-core.js', 'src/content/island.js'] })));
  await refreshBadge();
  const settings = await getSettings();
  if (details.reason === 'install' || !settings.apiKey) {
    await openOptions();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'jdt-open-dashboard') {
    await openDashboard();
    return;
  }
  if (info.menuItemId === 'jdt-open-knowledge') {
    await openKnowledge();
    return;
  }
  if (
    info.menuItemId === 'jdt-capture-region' ||
    info.menuItemId === 'jdt-capture-viewport' ||
    info.menuItemId === 'jdt-capture-question'
  ) {
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    // 题目框选同样从原网页发起：避免在扩展页面上调用 activeTab 截图
    const target = info.menuItemId === 'jdt-capture-question' ? 'technical-question' : 'job';
    await startCapture(info.menuItemId === 'jdt-capture-viewport' ? 'viewport' : 'region', target, tab?.id != null ? { tabId: tab.id, frameId: 0 } : null);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-region') await startCapture('region');
  else if (command === 'capture-viewport') await startCapture('viewport');
  else if (command === 'open-dashboard') await openDashboard();
});

chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.records) refreshBadge();
});

refreshBadge();

chrome.tabs.onRemoved.addListener((tabId) => { lastCapture.delete(tabId); for (const c of pending.values()) if (c.tabId === tabId) c.abort(); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') { lastCapture.delete(tabId); for (const c of pending.values()) if (c.tabId === tabId) c.abort(); } });
