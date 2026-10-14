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
import { siteFromUrl, startOfDay } from './lib/util.js';

const BLOCKED_URL = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted):/i;
const STORE_URL = /^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/i;

/** 进行中的识别任务：requestId → AbortController */
const pending = new Map();
/** 每个标签页最近一次的截图，供"重新截图/重新识别"复用 */
const lastCapture = new Map();

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

async function startCapture(mode) {
  const tab = await getActiveTab();
  const problem = assertCapturable(tab);
  if (problem) {
    await notify('无法截图', problem);
    return fail(problem);
  }
  const settings = await getSettings();
  if (!settings.apiKey) {
    const msg = '还没有配置 API Key，请先打开扩展设置填写。';
    await notify('需要先配置', msg);
    await openOptions();
    return fail(msg, { needSetup: true });
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 });
  } catch (err) {
    const msg = `截图失败：${err?.message || err}`;
    await notify('截图失败', '如果是浏览器内置页面或本地文件页面，请换普通网页再试。');
    return fail(msg);
  }

  try {
    await ensureOverlay(tab.id);
  } catch (err) {
    const msg = `无法在此页面注入界面：${err?.message || err}`;
    await notify('注入失败', msg);
    return fail(msg);
  }

  lastCapture.set(tab.id, { dataUrl, at: Date.now() });

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'JDT_SHOW_SELECTOR',
      dataUrl,
      mode: mode === 'viewport' ? 'viewport' : 'region',
      statuses: settings.statuses,
      defaultStatus: settings.defaultStatus,
      cropMaxSide: settings.cropMaxSide,
      cropQuality: settings.cropQuality,
      warnDuplicate: settings.warnDuplicate,
      closePanelAfterSave: settings.closePanelAfterSave,
      autoOpenDashboard: settings.autoOpenDashboard,
      model: settings.model,
    });
  } catch (err) {
    return fail(`页面没有响应：${err?.message || err}`);
  }
  return ok();
}

/* ------------------------------------------------------------------ */
/* 识别流程                                                            */
/* ------------------------------------------------------------------ */

async function runAnalysis({ requestId, image, pageTitle, pageUrl, sourceSite, tabId }) {
  const settings = await getSettings();
  const controller = new AbortController();
  pending.set(requestId, controller);
  const stopKeepalive = startKeepalive();
  try {
    const payload = {
      settings,
      pageTitle,
      pageUrl,
      sourceSite: sourceSite || siteFromUrl(pageUrl),
      externalSignal: controller.signal,
    };
    const out = await analyzeScreenshot({ ...payload, image });
    await deliver(tabId, { type: 'JDT_ANALYZE_RESULT', requestId, ok: true, ...out });
  } catch (err) {
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
    });
  } finally {
    pending.delete(requestId);
    stopKeepalive();
  }
}

async function deliver(tabId, message) {
  try {
    if (tabId != null) await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* 页面可能已关闭，落在 storage 里等下次打开 */
    const history = (await chrome.storage.local.get('lastResult')).lastResult || [];
    await chrome.storage.local.set({ lastResult: [message, ...history].slice(0, 5) });
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
  const existing = await chrome.tabs.query({ url });
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

const handlers = {
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

  async START_CAPTURE({ mode }) {
    return startCapture(mode);
  },

  async RECAPTURE({ mode }) {
    return startCapture(mode || 'region');
  },

  async ANALYZE(msg) {
    const requestId = msg.requestId || `req_${Date.now()}`;
    if (pending.has(requestId)) return fail('该请求正在处理中。');
    // 立即回执，结果通过 JDT_ANALYZE_RESULT 推送，避免长请求期间连接被回收
    runAnalysis({ ...msg, requestId });
    return ok({ accepted: true, requestId });
  },

  async ANALYZE_ABORT({ requestId }) {
    const c = pending.get(requestId);
    if (c) {
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
  const enriched = { ...msg, tabId: msg.tabId ?? sender?.tab?.id ?? null, senderUrl: sender?.tab?.url || '' };
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
    id: 'jdt-open-dashboard',
    title: '打开投递进度表',
    contexts: ['page'],
  });
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
  if (info.menuItemId === 'jdt-capture-region' || info.menuItemId === 'jdt-capture-viewport') {
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    await startCapture(info.menuItemId === 'jdt-capture-viewport' ? 'viewport' : 'region');
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
