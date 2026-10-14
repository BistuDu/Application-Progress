/**
 * 设置页：接口配置、测试连接、截图参数、状态词表、提示词、数据管理。
 */

import { DEFAULT_PROMPT, DEFAULT_STATUSES, chatUrlCandidates } from '../lib/settings.js';
import { bytesToSize, downloadFile, fmtDate } from '../lib/util.js';
import { toCsv, toExportJson, toMarkdown } from '../lib/store.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let recordsCache = null;

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res) throw new Error('扩展没有响应。');
  return res;
}

function toast(message, kind = '', ms = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('toasts').appendChild(node);
  if (ms) setTimeout(() => node.remove(), ms);
}

function setStatus(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `status ${kind}`;
}

/* ------------------------------------------------------------------ */
/* 读写表单                                                            */
/* ------------------------------------------------------------------ */

function fillForm(s) {
  $('apiBase').value = s.apiBase;
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model;
  $('maxTokens').value = s.maxTokens;
  $('timeoutMs').value = Math.round((s.timeoutMs || 120000) / 1000);
  $('cropMaxSide').value = s.cropMaxSide;
  $('cropQuality').value = s.cropQuality;
  $('maxStoredScreenshots').value = s.maxStoredScreenshots;
  $('keepScreenshot').checked = !!s.keepScreenshot;
  $('warnDuplicate').checked = !!s.warnDuplicate;
  $('closePanelAfterSave').checked = !!s.closePanelAfterSave;
  $('autoOpenDashboard').checked = !!s.autoOpenDashboard;
  $('promptTemplate').value = s.promptTemplate || DEFAULT_PROMPT;
  $('statuses').value = (s.statuses || DEFAULT_STATUSES).map((x) => `${x.name}|${x.color}`).join('\n');
  $('defaultStatus').innerHTML = (s.statuses || DEFAULT_STATUSES)
    .map((x) => `<option value="${x.name}"${x.name === s.defaultStatus ? ' selected' : ''}>${x.name}</option>`)
    .join('');
}

function parseStatuses(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [name, color] = t.split('|').map((x) => (x || '').trim());
    if (!name) continue;
    out.push({ name, color: /^#[0-9a-f]{3,8}$/i.test(color || '') ? color : '#94a3b8' });
  }
  return out;
}

function collect() {
  const statuses = parseStatuses($('statuses').value);
  const raw = {
    apiBase: $('apiBase').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'deepseek-flash',
    maxTokens: Number($('maxTokens').value) || 4096,
    timeoutMs: Math.round((Number($('timeoutMs').value) || 120) * 1000),
    cropMaxSide: Number($('cropMaxSide').value) || 1800,
    cropQuality: Math.min(1, Math.max(0.4, Number($('cropQuality').value) || 0.9)),
    maxStoredScreenshots: Number($('maxStoredScreenshots').value) || 0,
    keepScreenshot: $('keepScreenshot').checked,
    warnDuplicate: $('warnDuplicate').checked,
    closePanelAfterSave: $('closePanelAfterSave').checked,
    autoOpenDashboard: $('autoOpenDashboard').checked,
    promptTemplate: $('promptTemplate').value,
    statuses: statuses.length ? statuses : DEFAULT_STATUSES,
    defaultStatus: $('defaultStatus').value,
  };
  if (!raw.statuses.some((s) => s.name === raw.defaultStatus)) {
    raw.defaultStatus = raw.statuses[0].name;
  }
  return raw;
}

async function save({ silent = false } = {}) {
  const patch = collect();
  const res = await send({ type: 'SAVE_SETTINGS', patch });
  if (!res.ok) {
    toast(res.error || '保存失败', 'err');
    return null;
  }
  settings = res.settings;
  if ($('apiKey').value !== (settings.apiKey || '')) $('apiKey').value = settings.apiKey || '';
  fillForm(settings);
  if (!silent) toast('已保存', 'ok');
  $('save-hint').textContent = `已保存 · ${new Date().toLocaleTimeString('zh-CN')}`;
  await refreshPermStatus();
  return settings;
}

/* ------------------------------------------------------------------ */
/* 权限与连通性                                                        */
/* ------------------------------------------------------------------ */

async function refreshPermStatus() {
  const apiBase = $('apiBase').value.trim();
  const res = await send({ type: 'CHECK_PERMISSION', apiBase });
  const granted = res.ok && res.granted;
  setStatus('perm-status', granted ? '✓ 已授权访问该域名' : '⚠ 尚未授权访问该域名', granted ? 'ok' : 'err');
  $('grant').hidden = granted;
}

$('grant').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim();
  const res = await send({ type: 'REQUEST_PERMISSION', apiBase });
  if (res.ok && res.granted) {
    toast('已授权', 'ok');
    await refreshPermStatus();
  } else {
    toast('授权被取消', 'err');
  }
});

$('test').addEventListener('click', async () => {
  const btn = $('test');
  const box = $('test-result');
  const override = collect();
  if (!override.apiKey) {
    box.hidden = false;
    box.className = 'result err';
    box.textContent = '请先填写 API Key。';
    return;
  }
  btn.disabled = true;
  btn.textContent = '测试中…';
  box.hidden = false;
  box.className = 'result';
  box.textContent = '正在向接口发送一张测试图片，验证地址 / Key / 模型 / 读图能力…';
  try {
    const res = await send({ type: 'TEST_CONNECTION', override });
    if (!res.ok) {
      box.className = 'result err';
      box.textContent = `✗ ${res.error}${res.needPermission ? '\n\n点上方「授权访问该域名」后再试。' : ''}`;
    } else {
      const r = res.result;
      if (r.ok) {
        box.className = 'result ok';
        box.textContent = [
          '✓ 连接成功，模型能读图并返回 JSON',
          `接口：${r.endpoint}`,
          `模型：${r.model}`,
          `耗时：${r.ms} ms`,
          r.usage ? `用量：${r.usage.total_tokens} tokens（含推理 ${r.usage.completion_tokens_details?.reasoning_tokens ?? 0}）` : '',
          `模型原始返回：${r.sample}`,
          r.emptyResult ? '⚠ 接口通了，但这次返回的内容是空的，建议点「测试连接」再试一次。' : '',
        ]
          .filter(Boolean)
          .join('\n');
      } else {
        box.className = 'result err';
        box.textContent = [`✗ ${r.message}`, r.endpoint ? `接口：${r.endpoint}` : '', r.detail ? `详情：${r.detail}` : '']
          .filter(Boolean)
          .join('\n');
      }
    }
  } catch (err) {
    box.className = 'result err';
    box.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
});

/* ------------------------------------------------------------------ */
/* 数据                                                                */
/* ------------------------------------------------------------------ */

async function allRecords() {
  const res = await send({ type: 'LIST_RECORDS', withScreenshots: true });
  return res.records || [];
}

async function refreshStorageInfo() {
  const records = await allRecords();
  const bytes = records.reduce((n, r) => {
    const i = (r.screenshot || '').indexOf(',');
    return n + (i === -1 ? 0 : Math.floor((r.screenshot.length - i - 1) * 0.75));
  }, 0);
  let used = 0;
  try {
    used = await chrome.storage.local.getBytesInUse(null);
  } catch {
    used = bytes;
  }
  const withShot = records.filter((r) => r.screenshot).length;
  $('storage-info').textContent = `共 ${records.length} 条记录，其中 ${withShot} 条带截图；截图占用约 ${bytesToSize(bytes)}，浏览器存储总占用 ${bytesToSize(used)}。`;
}

$('export-json').addEventListener('click', async () => {
  const records = await allRecords();
  downloadFile(`求职进度备份_${fmtDate(Date.now()).replace(/-/g, '')}.json`, toExportJson(records, settings), 'application/json');
  toast('已导出 JSON', 'ok');
});
$('export-csv').addEventListener('click', async () => {
  const records = await allRecords();
  downloadFile(`求职进度_${fmtDate(Date.now()).replace(/-/g, '')}.csv`, toCsv(records), 'text/csv;charset=utf-8');
  toast('已导出 CSV', 'ok');
});
$('export-md').addEventListener('click', async () => {
  const records = await allRecords();
  downloadFile(`求职进度_${fmtDate(Date.now()).replace(/-/g, '')}.md`, toMarkdown(records, settings), 'text/markdown;charset=utf-8');
  toast('已导出 Markdown', 'ok');
});

$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const records = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(records)) throw new Error('文件里没有 records 数组。');
    const res = await send({ type: 'IMPORT_RECORDS', records });
    toast(res.ok ? res.message : res.error, res.ok ? 'ok' : 'err', 5000);
    await refreshStorageInfo();
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err', 5000);
  }
});

$('clear').addEventListener('click', async () => {
  const first = confirm('这会删除全部投递记录（含截图），不可恢复。\n建议先「导出全部数据」备份。确定继续？');
  if (!first) return;
  const typed = prompt('请输入「清空」两个字确认：');
  if (typed !== '清空') {
    toast('已取消', '');
    return;
  }
  await send({ type: 'CLEAR_ALL' });
  await refreshStorageInfo();
  toast('已清空', 'ok');
});

/* ------------------------------------------------------------------ */
/* 其它按钮                                                            */
/* ------------------------------------------------------------------ */

$('toggle-key').addEventListener('click', () => {
  const input = $('apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? '隐藏' : '显示';
});

$('reset-statuses').addEventListener('click', () => {
  $('statuses').value = DEFAULT_STATUSES.map((x) => `${x.name}|${x.color}`).join('\n');
  setStatus('statuses-hint', '已填入默认状态，记得点保存', 'ok');
});

$('reset-prompt').addEventListener('click', () => {
  $('promptTemplate').value = DEFAULT_PROMPT;
  setStatus('prompt-hint', '已填入默认提示词，记得点保存', 'ok');
});

$('save').addEventListener('click', () => save());
$('open-dashboard').addEventListener('click', () => send({ type: 'OPEN_DASHBOARD' }));

$('apiBase').addEventListener('change', () => {
  const candidates = chatUrlCandidates($('apiBase').value);
  if (candidates.length) $('apiBase').title = `实际请求：${candidates[0]}`;
  refreshPermStatus();
});

$('statuses').addEventListener('input', () => {
  const list = parseStatuses($('statuses').value);
  const cur = $('defaultStatus').value;
  $('defaultStatus').innerHTML = list.map((x) => `<option value="${x.name}">${x.name}</option>`).join('');
  if (list.some((x) => x.name === cur)) $('defaultStatus').value = cur;
  setStatus('statuses-hint', `已识别 ${list.length} 个状态`, '');
});

// 自动保存：输入框失焦即存，避免用户忘记点保存
document.querySelectorAll('input, select, textarea').forEach((node) => {
  node.addEventListener('change', (e) => {
    if (e.target.id === 'file') return;
    save({ silent: true }).catch(() => {});
  });
});

(async () => {
  const res = await send({ type: 'GET_STATE' });
  if (!res.ok) {
    toast(res.error || '读取设置失败', 'err');
    return;
  }
  settings = res.settings;
  recordsCache = res.records;
  fillForm(settings);
  await refreshPermStatus();
  await refreshStorageInfo();
  $('apiBase').title = `实际请求：${chatUrlCandidates(settings.apiBase)[0] || ''}`;
  void recordsCache;
})();
