/**
 * Popup：快捷入口 + 最近记录 + 状态快改。
 * 截图识别会在页面里继续，所以点击后立刻关闭弹窗。
 */

import { fmtRelative } from '../lib/util.js';

const $ = (id) => document.getElementById(id);

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: '扩展没有响应。' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function toast(message, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.appendChild(node);
  if (ms) setTimeout(() => node.remove(), ms);
}

function statusOptions(statuses, selected) {
  const choices = selected && !statuses.some((s) => s.name === selected) ? [...statuses, { name: selected }] : statuses;
  return choices
    .map((s) => `<option value="${s.name}"${s.name === selected ? ' selected' : ''}>${s.name}</option>`)
    .join('');
}

async function render() {
  const res = await send({ type: 'GET_RECENT', limit: 8 });
  if (!res.ok) {
    toast(`读取失败：${res.error || ''}`);
    return;
  }
  const { records, stats, statuses } = res;
  const settings = (await send({ type: 'GET_STATE' })).settings || {};

  // 未配置 Key 时的引导
  const needsSetup = !settings.hasApiKey;
  $('setup').hidden = !needsSetup;
  $('main').style.opacity = needsSetup ? '0.55' : '1';

  $('subtitle').textContent = needsSetup
    ? '先配置 API Key 才能识别截图'
    : `${settings.model} · ${settings.apiBase.replace(/^https?:\/\//, '')}`;

  const cards = [
    { label: '今日新增', value: stats.today },
    { label: '本周', value: stats.week },
    { label: '面试中', value: stats.interviewCount },
    { label: 'Offer', value: stats.offerCount },
  ];
  $('stats').innerHTML = cards.map((c) => `<div class="stat"><b>${c.value}</b><span>${c.label}</span></div>`).join('');

  const list = $('recent-list');
  if (!records.length) {
    list.innerHTML = '<div class="empty">还没有记录，去招聘页面点「框选识别 JD」试试</div>';
    $('foot-tip').textContent = `累计 0 条 · 累计记录会显示在这里`;
    return;
  }
  list.innerHTML = records
    .map(
      (r) => `
    <div class="item">
      <div class="meta">
        <div class="t">${escapeHtml(r.company || '未知公司')} · ${escapeHtml(r.title || '未知岗位')}</div>
        <div class="s">${escapeHtml(r.status)} · ${fmtRelative(r.createdAt)}${r.location ? ` · ${escapeHtml(r.location)}` : ''}</div>
      </div>
      <select data-id="${r.id}">${statusOptions(statuses, r.status)}</select>
    </div>`,
    )
    .join('');

  list.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const res2 = await send({ type: 'UPDATE_RECORD', id: sel.dataset.id, patch: { status: sel.value } });
      sel.disabled = false;
      if (res2.ok) {
        toast(`状态已更新为「${sel.value}」`);
        const s = await send({ type: 'GET_RECENT', limit: 8 });
        if (s.ok) renderStatsOnly(s.stats);
      } else {
        toast(`更新失败：${res2.error || ''}`);
      }
    });
  });

  $('foot-tip').textContent = `累计 ${stats.total} 条 · 今日新增 ${stats.today} 条`;
}

function renderStatsOnly(stats) {
  const cards = [
    { label: '今日新增', value: stats.today },
    { label: '本周', value: stats.week },
    { label: '面试中', value: stats.interviewCount },
    { label: 'Offer', value: stats.offerCount },
  ];
  $('stats').innerHTML = cards.map((c) => `<div class="stat"><b>${c.value}</b><span>${c.label}</span></div>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 先把结果写进 storage，再由页面侧读取——弹窗关闭后流程继续在页面里跑 */
async function startCapture(mode, target = 'job') {
  const res = await send({ type: 'START_CAPTURE', mode, target });
  if (!res.ok) {
    toast(res.error || '无法开始截图', 4000);
    return;
  }
  window.close();
}

$('btn-region').addEventListener('click', () => startCapture('region'));
$('btn-viewport').addEventListener('click', () => startCapture('viewport'));
$('btn-region-question').addEventListener('click', () => startCapture('region', 'technical-question'));
$('btn-dashboard').addEventListener('click', async () => {
  await send({ type: 'OPEN_DASHBOARD' });
  window.close();
});
$('btn-knowledge').addEventListener('click', async () => {
  await send({ type: 'OPEN_KNOWLEDGE' });
  window.close();
});
$('btn-options').addEventListener('click', async () => {
  await send({ type: 'OPEN_OPTIONS' });
  window.close();
});
$('btn-goto-options').addEventListener('click', async () => {
  await send({ type: 'OPEN_OPTIONS' });
  window.close();
});

render();

async function renderIsland() {
  const res = await send({ type: 'ISLAND_GET_STATE' });
  const usable = res.ok && res.available && res.permission;
  $('island-toggle').disabled = !usable;
  $('island-reset').disabled = !res.ok;
  $('island-status').textContent = !res.ok ? res.error : !res.available ? '此页面不支持胶囊，请在普通 HTTP／HTTPS 网页使用。' : !res.permission ? '缺少网站权限，请在扩展管理中允许访问网站。' : `${res.host} · ${res.enabled ? '已开启' : '此网站已关闭'}`;
  $('island-toggle').textContent = res.enabled ? '在此网站关闭' : '在此网站开启';
  $('island-toggle').onclick = async () => {
    const r = await send({ type: 'ISLAND_SET_SITE', enabled: !res.enabled });
    if (!r.ok) toast(r.error); await renderIsland();
  };
}
$('island-reset').addEventListener('click', async () => {
  const r = await send({ type: 'ISLAND_RESET_POSITION' }); toast(r.ok ? '胶囊位置已重置' : r.error); await renderIsland();
});
chrome.storage.onChanged.addListener((c) => { if (c.islandPreferences) renderIsland(); });
renderIsland();
