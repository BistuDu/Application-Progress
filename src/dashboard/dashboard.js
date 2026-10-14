/**
 * 进度表看板：统计、筛选、表格内改状态、详情编辑、导出导入。
 */

import {
  downloadFile,
  escapeHtml as esc,
  fmtDate,
  fmtDateTime,
  fmtRelative,
  safeFileName,
  startOfMonth,
  startOfWeek,
  truncate,
} from '../lib/util.js';
import { statusDef } from '../lib/settings.js';
import { toCsv, toExportJson, toMarkdown } from '../lib/store.js';

const $ = (id) => document.getElementById(id);

const state = {
  records: [],
  stats: null,
  settings: null,
  statuses: [],
  statusFilter: new Set(),
  selected: new Set(),
  editingId: null,
  shotCache: new Map(),
};

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res) throw new Error('扩展没有响应。');
  if (!res.ok) throw new Error(res.error || '操作失败');
  return res;
}

function toast(message, kind = '', actions = [], ms = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<span>${esc(message)}</span>`;
  for (const a of actions) {
    const link = document.createElement('a');
    link.textContent = a.label;
    link.addEventListener('click', () => {
      a.onClick();
      node.remove();
    });
    node.appendChild(link);
  }
  $('toasts').appendChild(node);
  if (ms) setTimeout(() => node.remove(), ms);
}

const color = (name) => statusDef(name, { statuses: state.statuses }).color;

/* ------------------------------------------------------------------ */
/* 加载与渲染                                                          */
/* ------------------------------------------------------------------ */

async function load() {
  const res = await send({ type: 'LIST_RECORDS' });
  state.records = res.records || [];
  state.stats = res.stats;
  state.settings = res.settings;
  state.statuses = res.settings.statuses || [];
  $('brand-sub').textContent = `${state.settings.model} · ${state.settings.apiBase.replace(/^https?:\/\//, '')}`;
  renderAll();
}

function renderAll() {
  renderCards();
  renderPanels();
  renderStatusFilter();
  renderSourceOptions();
  renderTable();
}

function renderCards() {
  const s = state.stats;
  const items = [
    { k: '总记录', v: s.total, s: `累计识别岗位数`, accent: true },
    { k: '本周新增', v: s.week, s: `今日 ${s.today} 条` },
    { k: '进行中', v: s.active, s: '未出结果的在跑流程' },
    { k: '面试及以后', v: s.interviewCount + s.offerCount, s: `面试率 ${(s.interviewRate * 100).toFixed(0)}%` },
    { k: 'Offer', v: s.offerCount, s: `转化率 ${(s.offerRate * 100).toFixed(0)}%` },
    { k: '拒绝/结束', v: s.rejected, s: s.needAction ? `有 ${s.needAction} 条待跟进` : '暂无待跟进' },
  ];
  $('cards').innerHTML = items
    .map(
      (it) => `<div class="card${it.accent ? ' accent' : ''}">
        <div class="k">${esc(it.k)}</div>
        <div class="v">${it.v}</div>
        <div class="s">${esc(it.s)}</div>
      </div>`,
    )
    .join('');
}

function renderPanels() {
  const s = state.stats;
  const max = Math.max(1, ...s.funnel.map((f) => f.count));
  const currentOf = (name) => s.statusList.find((x) => x.name === name)?.count || 0;

  $('funnel').innerHTML = s.funnel
    .map((f) => {
      const w = (f.count / max) * 100;
      const rate = s.total ? ((f.count / s.total) * 100).toFixed(0) : 0;
      return `<div class="row">
        <span class="name">${esc(f.name)}</span>
        <div class="bar-bg"><div class="bar" style="width:${w}%;background:${f.color}"></div></div>
        <span class="num"><b>${f.count}</b> · ${rate}% · 当前 ${currentOf(f.name)}</span>
      </div>`;
    })
    .join('');

  const tmax = Math.max(1, ...s.weeks.map((w) => w.count));
  $('trend').innerHTML = s.weeks
    .map(
      (w) => `<div class="col${w.current ? ' now' : ''}" title="${fmtDate(w.from)} 起这一周：${w.count} 条">
        <span class="n">${w.count || ''}</span>
        <div class="b" style="height:${Math.max(3, (w.count / tmax) * 84)}px"></div>
        <span class="l">${w.label}</span>
      </div>`,
    )
    .join('');

  const smax = Math.max(1, ...s.sites.map((x) => x.count));
  $('sites').innerHTML = s.sites.length
    ? s.sites
        .slice(0, 8)
        .map(
          (x) => `<div class="row">
            <span class="name" title="${esc(x.name)}">${esc(x.name)}</span>
            <div class="bar-bg"><div class="bar" style="width:${(x.count / smax) * 100}%"></div></div>
            <span class="num">${x.count}</span>
          </div>`,
        )
        .join('')
    : '<span style="color:var(--faint);font-size:12px">暂无数据</span>';

  $('skills').innerHTML = s.skills.length
    ? s.skills
        .map((x) => `<span class="chip-skill" data-skill="${esc(x.name)}">${esc(x.name)}<em>${x.count}</em></span>`)
        .join('')
    : '<span style="color:var(--faint);font-size:12px">暂无关键词</span>';

  $('skills').querySelectorAll('[data-skill]').forEach((node) => {
    node.addEventListener('click', () => {
      $('q').value = node.dataset.skill;
      renderTable();
    });
  });
}

function renderStatusFilter() {
  const list = state.statuses.filter((s) => (state.stats.statusList.find((x) => x.name === s.name)?.count || 0) > 0);
  $('status-filter').innerHTML = [
    `<button class="f-chip${state.statusFilter.size === 0 ? ' on' : ''}" data-status="">全部 <span class="n">${state.stats.total}</span></button>`,
    ...list.map((s) => {
      const n = state.stats.statusList.find((x) => x.name === s.name)?.count || 0;
      return `<button class="f-chip${state.statusFilter.has(s.name) ? ' on' : ''}" data-status="${esc(s.name)}">
        <span class="dot" style="background:${s.color}"></span>${esc(s.name)} <span class="n">${n}</span>
      </button>`;
    }),
  ].join('');
  $('status-filter')
    .querySelectorAll('.f-chip')
    .forEach((node) => {
      node.addEventListener('click', () => {
        const name = node.dataset.status;
        if (!name) state.statusFilter.clear();
        else if (state.statusFilter.has(name)) state.statusFilter.delete(name);
        else state.statusFilter.add(name);
        renderStatusFilter();
        renderTable();
      });
    });

  const cur = $('batch-status');
  cur.innerHTML = `<option value="">批量改状态…</option>${state.statuses.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}`;
}

function renderSourceOptions() {
  const sel = $('f-source');
  const cur = sel.value;
  const list = state.stats.sites.map((s) => s.name);
  sel.innerHTML = `<option value="">全部来源</option>${list.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
  if (list.includes(cur)) sel.value = cur;
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const source = $('f-source').value;
  const range = $('f-range').value;
  const [sortKey, dir] = $('f-sort').value.split('-');
  const onlyTodo = $('f-todo').checked;
  const now = Date.now();

  let from = 0;
  if (range === '7') from = now - 7 * 86400000;
  else if (range === '30') from = now - 30 * 86400000;
  else if (range === '90') from = now - 90 * 86400000;
  else if (range === 'week') from = startOfWeek(now);
  else if (range === 'month') from = startOfMonth(now);

  const out = state.records.filter((r) => {
    if (state.statusFilter.size && !state.statusFilter.has(r.status)) return false;
    if (source && (r.sourceSite || '未识别') !== source) return false;
    if (from && (r.createdAt || 0) < from) return false;
    if (onlyTodo && !r.nextAction) return false;
    if (q) {
      const hay = [r.company, r.title, r.location, r.salary, r.notes, r.nextAction, r.jd, r.requirements, r.sourceSite, r.contact, (r.skills || []).join(' ')]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sign = dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    if (sortKey === 'company' || sortKey === 'status') {
      return String(a[sortKey] || '').localeCompare(String(b[sortKey] || ''), 'zh-Hans-CN') * sign;
    }
    return ((a[sortKey] || 0) - (b[sortKey] || 0)) * sign;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

function renderTable() {
  const rows = filtered();
  const tbody = $('tbody');
  $('count').textContent = `显示 ${rows.length} / ${state.records.length} 条`;
  $('empty').hidden = state.records.length > 0;

  if (!rows.length) {
    tbody.innerHTML = state.records.length
      ? '<tr><td colspan="9" style="text-align:center;color:var(--faint);padding:34px">当前筛选条件下没有记录</td></tr>'
      : '';
    renderBatch();
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const c = color(r.status);
      const checked = state.selected.has(r.id);
      return `<tr data-id="${r.id}" class="${checked ? 'sel' : ''}">
        <td class="c-check"><input type="checkbox" class="row-check" data-id="${r.id}"${checked ? ' checked' : ''}></td>
        <td class="mono">${fmtDate(r.createdAt)}<br><span style="font-size:11px">${fmtRelative(r.createdAt)}</span></td>
        <td>
          <div class="cell-main">
            <div class="t" title="${esc(r.company || '未知公司')}">${esc(r.company || '未知公司')}</div>
            <div class="s" title="${esc(r.title || '')}">${esc(r.title || '未知岗位')}${r.jobType ? ` · ${esc(r.jobType)}` : ''}</div>
            ${r.nextAction ? `<div><span class="next-tag">${esc(truncate(r.nextAction, 34))}</span></div>` : ''}
          </div>
        </td>
        <td class="mono">${esc(r.location || '—')}</td>
        <td class="mono">${esc(r.salary || '—')}</td>
        <td class="td-sel"><select data-act="status" style="color:${c}">${state.statuses
          .map((s) => `<option value="${esc(s.name)}"${s.name === r.status ? ' selected' : ''}>${esc(s.name)}</option>`)
          .join('')}</select></td>
        <td class="td-date"><input type="date" data-act="appliedAt" value="${r.appliedAt ? fmtDate(r.appliedAt) : ''}"></td>
        <td class="t-src">${esc(r.sourceSite || '—')}</td>
        <td><div class="row-act">
          <button data-act="open" title="查看详情">👁</button>
          <button data-act="del" class="del" title="删除">🗑</button>
        </div></td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-act="open"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawer(id);
    });
    tr.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = state.records.find((x) => x.id === id);
      if (!confirm(`删除「${r?.company || ''} ${r?.title || ''}」这条记录？`)) return;
      await deleteOne(id);
    });
    tr.querySelector('[data-act="status"]').addEventListener('change', async (e) => {
      const value = e.target.value;
      e.target.style.color = color(value);
      await patch(id, { status: value }, `状态已改为「${value}」`);
    });
    tr.querySelector('[data-act="appliedAt"]').addEventListener('change', async (e) => {
      await patch(id, { appliedAt: e.target.value }, '投递日期已更新');
    });
    tr.querySelector('.row-check').addEventListener('change', (e) => {
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      tr.classList.toggle('sel', e.target.checked);
      renderBatch();
    });
    tr.addEventListener('dblclick', () => openDrawer(id));
  });

  renderBatch();
}

function renderBatch() {
  const n = state.selected.size;
  $('batch').hidden = n === 0;
  $('batch-info').textContent = `已选 ${n} 条`;
  $('check-all').checked = n > 0 && n === filtered().length;
}

/* ------------------------------------------------------------------ */
/* 数据操作                                                            */
/* ------------------------------------------------------------------ */

async function patch(id, patchObj, message) {
  try {
    await send({ type: 'UPDATE_RECORD', id, patch: patchObj });
    const r = state.records.find((x) => x.id === id);
    if (r) {
      Object.assign(r, patchObj);
      if (patchObj.status) {
        r.statusHistory = [...(r.statusHistory || []), { status: patchObj.status, at: Date.now() }];
      }
    }
    const fresh = await send({ type: 'LIST_RECORDS' });
    state.records = fresh.records;
    state.stats = fresh.stats;
    renderCards();
    renderPanels();
    renderStatusFilter();
    if (message) toast(message, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteOne(id) {
  try {
    await send({ type: 'DELETE_RECORDS', ids: [id] });
    state.selected.delete(id);
    if (state.editingId === id) closeDrawer();
    await load();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 详情抽屉                                                            */
/* ------------------------------------------------------------------ */

async function openDrawer(id) {
  const r = state.records.find((x) => x.id === id);
  if (!r) return;
  state.editingId = id;
  $('drawer').hidden = false;
  $('d-title').textContent = `${r.company || '未知公司'} · ${r.title || '未知岗位'}`;
  $('d-body').innerHTML = `<div style="color:var(--faint);font-size:12.5px">载入中…</div>`;

  let shot = state.shotCache.get(id);
  if (shot === undefined) {
    try {
      const res = await send({ type: 'GET_SCREENSHOT', id });
      shot = res.screenshot || '';
      state.shotCache.set(id, shot);
    } catch {
      shot = '';
    }
  }
  if (state.editingId !== id) return;

  const hist = (r.statusHistory || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  $('d-body').innerHTML = `
    ${shot ? `<img class="d-shot" id="d-shot" src="${esc(shot)}" alt="截图">` : '<div class="prewrap">这条记录没有保存截图。</div>'}
    <div class="d-sec">
      <div class="grid">
        <label class="field full"><span>公司名称</span><input id="d-company" value="${esc(r.company)}"></label>
        <label class="field full"><span>岗位名称</span><input id="d-title2" value="${esc(r.title)}"></label>
        <label class="field"><span>状态</span><select id="d-status" style="color:${color(r.status)}">${state.statuses
          .map((s) => `<option value="${esc(s.name)}"${s.name === r.status ? ' selected' : ''}>${esc(s.name)}</option>`)
          .join('')}</select></label>
        <label class="field"><span>投递日期</span><input id="d-applied" type="date" value="${r.appliedAt ? fmtDate(r.appliedAt) : ''}"></label>
        <label class="field"><span>地点</span><input id="d-location" value="${esc(r.location)}"></label>
        <label class="field"><span>薪资</span><input id="d-salary" value="${esc(r.salary)}"></label>
        <label class="field"><span>类型</span><input id="d-jobtype" value="${esc(r.jobType)}"></label>
        <label class="field"><span>学历要求</span><input id="d-education" value="${esc(r.education)}"></label>
        <label class="field"><span>截止时间</span><input id="d-deadline" value="${esc(r.deadline)}"></label>
        <label class="field"><span>投递方式</span><input id="d-contact" value="${esc(r.contact)}"></label>
        <label class="field full"><span>下一步</span><input id="d-next" value="${esc(r.nextAction)}" placeholder="例如：9/20 前完成在线测评"></label>
      </div>
    </div>

    <div class="d-sec">
      <h3>技能关键词</h3>
      <div class="kv" id="d-skills">${(r.skills || []).map((s) => `<span>${esc(s)}</span>`).join('') || '<span style="background:none;color:var(--faint)">无</span>'}</div>
    </div>

    <div class="d-sec">
      <h3>岗位职责</h3>
      <textarea class="field" id="d-jd" rows="6" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12.5px">${esc(r.jd)}</textarea>
    </div>

    <div class="d-sec">
      <h3>任职要求</h3>
      <textarea id="d-req" rows="6" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12.5px">${esc(r.requirements)}</textarea>
    </div>

    <div class="d-sec">
      <h3>备注</h3>
      <textarea id="d-notes" rows="2" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:12.5px">${esc(r.notes)}</textarea>
    </div>

    <div class="d-sec">
      <h3>状态时间线</h3>
      <div class="timeline">
        ${
          hist
            .map(
              (h, i) => `${i ? '<div class="tl-line"></div>' : ''}
          <div class="tl-item">
            <span class="tl-dot" style="background:${color(h.status)}"></span>
            <div class="tl-txt">${esc(h.status)}<span class="w">${fmtDateTime(h.at)} · ${fmtRelative(h.at)}</span>
              ${h.note ? `<div style="color:var(--muted);font-size:11.5px">${esc(h.note)}</div>` : ''}
            </div>
          </div>`,
            )
            .join('') || '<span style="color:var(--faint);font-size:12.5px">暂无</span>'
        }
      </div>
    </div>

    <div class="d-sec">
      <h3>来源信息</h3>
      <div style="font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:4px">
        <div>记录时间：${fmtDateTime(r.createdAt)}</div>
        <div>最后修改：${fmtDateTime(r.updatedAt || r.createdAt)}</div>
        <div>来源站点：${esc(r.sourceSite || '—')}</div>
        ${r.pageTitle ? `<div>页面标题：${esc(r.pageTitle)}</div>` : ''}
        ${r.aiMeta ? `<div>识别：${esc(r.aiMeta.model || '')} · ${Math.round((r.aiMeta.ms || 0) / 100) / 10}s${r.aiMeta.usage ? ` · ${r.aiMeta.usage.total_tokens || ''} tokens` : ''}</div>` : ''}
        ${r.sourceUrl ? `<div><a class="src-link" href="${esc(r.sourceUrl)}" target="_blank" rel="noreferrer">${esc(truncate(r.sourceUrl, 70))}</a></div>` : ''}
      </div>
    </div>`;

  $('d-status').addEventListener('change', (e) => {
    e.target.style.color = color(e.target.value);
  });
  $('d-shot')?.addEventListener('click', () => {
    openZoom(shot);
  });
}

function openZoom(src) {
  const node = document.createElement('div');
  node.className = 'modal';
  node.innerHTML = `<img src="${esc(src)}" style="max-width:92vw;max-height:92vh;border-radius:10px">`;
  node.addEventListener('click', () => node.remove());
  document.body.appendChild(node);
}

function closeDrawer() {
  state.editingId = null;
  $('drawer').hidden = true;
}

async function saveDrawer() {
  const id = state.editingId;
  if (!id) return;
  const val = (sel) => $(sel)?.value?.trim() ?? '';
  const patchObj = {
    company: val('d-company'),
    title: val('d-title2'),
    status: val('d-status'),
    appliedAt: val('d-applied'),
    location: val('d-location'),
    salary: val('d-salary'),
    jobType: val('d-jobtype'),
    education: val('d-education'),
    deadline: val('d-deadline'),
    contact: val('d-contact'),
    nextAction: val('d-next'),
    jd: val('d-jd'),
    requirements: val('d-req'),
    notes: val('d-notes'),
  };
  try {
    const res = await send({ type: 'UPDATE_RECORD', id, patch: patchObj });
    state.shotCache.delete(id);
    await load();
    toast('已保存', 'ok');
    $('d-title').textContent = `${res.record.company || '未知公司'} · ${res.record.title || '未知岗位'}`;
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 手动添加                                                            */
/* ------------------------------------------------------------------ */

function openModal() {
  $('modal').hidden = false;
  $('m-status').innerHTML = state.statuses
    .map((s) => `<option value="${esc(s.name)}"${s.name === state.settings.defaultStatus ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  $('m-applied').value = fmtDate(Date.now());
}

async function submitModal() {
  const val = (id) => $(id).value.trim();
  const company = val('m-company');
  const title = val('m-title');
  if (!company && !title) {
    toast('公司和岗位至少填一个', 'err');
    return;
  }
  try {
    const res = await send({
      type: 'SAVE_RECORD',
      input: {
        company,
        title,
        location: val('m-location'),
        salary: val('m-salary'),
        status: val('m-status'),
        appliedAt: val('m-applied') || Date.now(),
        nextAction: val('m-next'),
        jd: val('m-jd'),
        notes: val('m-notes'),
        sourceUrl: '',
      },
    });
    $('modal').hidden = true;
    ['m-company', 'm-title', 'm-location', 'm-salary', 'm-next', 'm-jd', 'm-notes'].forEach((id) => {
      $(id).value = '';
    });
    await load();
    const dup = res.duplicates?.length ? `（注意：已有 ${res.duplicates.length} 条相似记录）` : '';
    toast(`已添加${dup}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入                                                         */
/* ------------------------------------------------------------------ */

async function doExport(kind) {
  $('export-menu').hidden = true;
  const all = await (async () => {
    const res = await send({ type: 'LIST_RECORDS', withScreenshots: true });
    return res.records;
  })();
  const stamp = fmtDate(Date.now()).replace(/-/g, '');
  if (kind === 'csv') {
    downloadFile(`求职进度_${stamp}.csv`, toCsv(all), 'text/csv;charset=utf-8');
    toast(`已导出 ${all.length} 条 CSV`, 'ok');
  } else if (kind === 'md') {
    downloadFile(`求职进度_${stamp}.md`, toMarkdown(all, state.settings), 'text/markdown;charset=utf-8');
    toast(`已导出 Markdown，可直接交给 /offer 技能整理`, 'ok');
  } else if (kind === 'json') {
    downloadFile(`求职进度备份_${stamp}.json`, toExportJson(all, state.settings), 'application/json;charset=utf-8');
    toast(`已导出 JSON 备份（含截图）`, 'ok');
  } else if (kind === 'clip') {
    const md = toMarkdown(all, state.settings);
    await navigator.clipboard.writeText(md);
    toast('Markdown 已复制到剪贴板', 'ok');
  }
  void safeFileName;
}

async function doImport(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const records = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(records)) throw new Error('文件里没有 records 数组。');
    const res = await send({ type: 'IMPORT_RECORDS', records });
    await load();
    toast(res.message || '导入完成', 'ok', [], 5000);
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err', [], 6000);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

$('q').addEventListener('input', () => {
  $('q-clear').hidden = !$('q').value;
  renderTable();
});
$('q-clear').addEventListener('click', () => {
  $('q').value = '';
  $('q-clear').hidden = true;
  renderTable();
});
['f-source', 'f-range', 'f-sort', 'f-todo'].forEach((id) => $(id).addEventListener('change', renderTable));

$('check-all').addEventListener('change', (e) => {
  const rows = filtered();
  if (e.target.checked) rows.forEach((r) => state.selected.add(r.id));
  else rows.forEach((r) => state.selected.delete(r.id));
  renderTable();
});

$('batch-clear').addEventListener('click', () => {
  state.selected.clear();
  renderTable();
});

$('batch-status').addEventListener('change', async (e) => {
  const value = e.target.value;
  if (!value || !state.selected.size) return;
  const ids = [...state.selected];
  for (const id of ids) {
    await send({ type: 'UPDATE_RECORD', id, patch: { status: value } });
  }
  e.target.value = '';
  state.selected.clear();
  await load();
  toast(`已把 ${ids.length} 条改为「${value}」`, 'ok');
});

$('batch-delete').addEventListener('click', async () => {
  if (!state.selected.size) return;
  if (!confirm(`确定删除选中的 ${state.selected.size} 条记录？不可撤销。`)) return;
  const ids = [...state.selected];
  await send({ type: 'DELETE_RECORDS', ids });
  state.selected.clear();
  await load();
  toast(`已删除 ${ids.length} 条`, 'ok');
});

$('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  $('export-menu').hidden = !$('export-menu').hidden;
});
$('export-menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (kind) doExport(kind);
});
document.addEventListener('click', () => {
  $('export-menu').hidden = true;
});

$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) doImport(file);
  e.target.value = '';
});

$('btn-add').addEventListener('click', openModal);
$('m-cancel').addEventListener('click', () => {
  $('modal').hidden = true;
});
$('m-close').addEventListener('click', () => {
  $('modal').hidden = true;
});
$('m-save').addEventListener('click', submitModal);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) $('modal').hidden = true;
});

$('d-close').addEventListener('click', closeDrawer);
$('d-save').addEventListener('click', saveDrawer);
$('d-delete').addEventListener('click', async () => {
  const r = state.records.find((x) => x.id === state.editingId);
  if (!r) return;
  if (!confirm(`删除「${r.company || ''} ${r.title || ''}」这条记录？`)) return;
  await deleteOne(r.id);
});

$('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('modal').hidden) $('modal').hidden = true;
    else if (!$('drawer').hidden) closeDrawer();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.records) {
    load().catch(() => {});
  }
});

load().catch((err) => toast(`载入失败：${err.message}`, 'err', [], 0));
