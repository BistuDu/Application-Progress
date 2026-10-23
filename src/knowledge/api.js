import { navigate } from '../workbench/navigation.js';
/**
 * 知识库页面 ↔ background 的消息桥。
 *
 * 所有存储写入、模型调用都在 background 完成（页面拿不到 API Key），
 * 这里只做：发消息、等待 JDT_KNOWLEDGE_RESULT、取消任务、取走网页框选交接的候选。
 */

const RESULT_TYPE = 'JDT_KNOWLEDGE_RESULT';
const pendingTasks = new Map();
const listeners = new Set();
let installed = false;

export async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: '扩展没有响应。' };
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Extension context invalidated|Receiving end does not exist|message channel closed/i.test(msg)) {
      return { ok: false, error: '扩展已更新或已卸载，请刷新页面后重试。', fatal: true };
    }
    return { ok: false, error: msg };
  }
}

function install() {
  if (installed) return;
  installed = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === RESULT_TYPE) {
      const task = pendingTasks.get(msg.requestId);
      if (task) {
        pendingTasks.delete(msg.requestId);
        task.settle(msg);
      }
      listeners.forEach((fn) => fn(msg));
      return false;
    }
    if (msg.type === 'JDT_KNOWLEDGE_PENDING') {
      listeners.forEach((fn) => fn(msg));
      return false;
    }
    return false;
  });
}

/** 订阅后台推送（任务结果与"有新候选"通知）。返回取消订阅函数。 */
export function onMessage(handler) {
  install();
  listeners.add(handler);
  return () => listeners.delete(handler);
}

install();

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // 后台用它确认"这个标签页就是知识库页面"，避免重复开标签
  if (msg?.type === 'JDT_KNOWLEDGE_PING') {
    respond({ knowledge: true });
    return false;
  }
  return false;
});

export class TaskError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TaskError';
    this.code = detail.code || 'unknown';
    this.retryable = detail.retryable !== false;
    this.needPermission = Boolean(detail.needPermission);
    this.detail = detail.detail || '';
  }
}

/**
 * 发起一个知识库模型任务并等待结果。
 *
 * 后台有请求超时，但如果结果消息因为页面休眠、service worker 被回收等原因没送到，
 * 页面侧的 Promise 会永远悬着（导入/生成就卡住了）。这里加一个兜底看门狗，
 * 超时后按可重试错误结束，让用户看到"重试"而不是一个没反应的界面。
 *
 * @param {object} payload {task, text?, images?, fileName?, pageNumbers?, sources?, projectId?, question?, currentAnswer?, referenceIds?, projectOnly?}
 * @returns {{promise: Promise<object>, requestId: string, abort: Function}}
 */
export function startTask(payload, { watchdogMs = 180000 } = {}) {
  install();
  const requestId = `kt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const promise = new Promise((resolve, reject) => {
    pendingTasks.set(requestId, {
      settle: (msg) => {
        if (msg.ok) resolve(msg);
        else reject(new TaskError(msg.error || '任务失败。', msg));
      },
    });
  });
  promise.catch(() => {
    /* 由调用方处理，避免 unhandled rejection */
  });

  const watchdog = setTimeout(() => {
    const entry = pendingTasks.get(requestId);
    if (!entry) return;
    pendingTasks.delete(requestId);
    entry.settle({
      ok: false,
      requestId,
      error: '等待模型返回超时，任务已经结束。可以重试，或先换成更小的图片/更少的页数。',
      code: 'timeout',
      retryable: true,
    });
  }, watchdogMs);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const abort = async () => {
    if (!pendingTasks.has(requestId)) return;
    await send({ type: 'KNOWLEDGE_TASK_ABORT', requestId });
  };

  send({ type: 'KNOWLEDGE_AI_RUN', ...payload, requestId }).then((res) => {
    if (!res.ok) {
      const entry = pendingTasks.get(requestId);
      if (entry) {
        pendingTasks.delete(requestId);
        entry.settle({ ok: false, requestId, error: res.error || '任务无法启动。', code: res.code, needPermission: res.needPermission });
      }
    }
  });

  return { promise, requestId, abort };
}

/** 取走网页框选交接过来的候选（取走即删）。 */
export async function takePendingHandoff() {
  const windowId = (await chrome.windows.getCurrent()).id;
  const res = await send({ type: 'KNOWLEDGE_PENDING_TAKE', windowId, embedded: window.parent !== window && new URLSearchParams(location.search).get('surface') === 'panel' });
  return res.ok ? res.handoff : null;
}

export async function clearPendingHandoff() {
  await send({ type: 'KNOWLEDGE_PENDING_CLEAR', windowId: (await chrome.windows.getCurrent()).id });
}

export async function openKnowledge() {
  return navigate('knowledge');
}

export async function openDashboard() {
  return navigate('dashboard');
}

export function openOptions() {
  return navigate('options');
}
