import { openApplicationImport } from '../shared/application-import.js';
import { registerViewState } from '../workbench/view-state.js';
import { installNavigation, navigate } from '../workbench/navigation.js';
installNavigation('dashboard');
/**
 * 进度表看板：统计、筛选、动态列、表格内改状态、详情编辑、导出导入。
 */

import {
  downloadFile,
  escapeHtml as esc,
  fmtDate,
  fmtDateTime,
  fmtRelative,
  locationSummary,
  safeFileName,
  startOfMonth,
  startOfWeek,
  truncate,
} from '../lib/util.js';
import {
  DASHBOARD_COLUMN_WIDTHS,
  DEFAULT_DASHBOARD_COLUMNS,
  normalizeDashboardColumnWidths,
  normalizeDashboardColumns,
  statusDef,
} from '../lib/settings.js';
import { toCsv, toExportJson, toMarkdown } from '../lib/store.js';
import { bindCompanyTypeField, companyTypeTone } from '../lib/company-type.js';
import { icon, paintIcons } from '../lib/icons.js';

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
  columns: normalizeDashboardColumns(DEFAULT_DASHBOARD_COLUMNS),
  columnWidths: normalizeDashboardColumnWidths(),
  columnSearch: '',
  headKey: null,
  columnsOpen: false,
  columnsAnchor: null,
  modalCompanyType: null,
  columnSaveTimer: null,
};

const COMPANY_TYPE_CHOICES = [
  ['', '未标注'],
  ['央企', '央企'],
  ['国企', '国企'],
  ['私企', '私企'],
  ['其他', '其他'],
];

const compactQuery = window.matchMedia('(max-width: 700px)');

const companyTypeOptions = (current = '') =>
  COMPANY_TYPE_CHOICES.map(
    ([value, label]) => `<option value="${value}"${value === (current || '') ? ' selected' : ''}>${label}</option>`,
  ).join('');

/* ------------------------------------------------------------------ */
/* 列定义                                                              */
/* ------------------------------------------------------------------ */

const textCell = (value, max = 40) => {
  const text = String(value ?? '').trim();
  return text ? `<span class="truncate" title="${esc(text)}">${esc(truncate(text, max))}</span>` : '<span class="muted">—</span>';
};

const dateCell = (value) =>
  value
    ? `<span class="date-main">${fmtDate(value)}</span><span class="date-sub">${fmtRelative(value)}</span>`
    : '<span class="muted">—</span>';

function urlLabel(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    return new URL(text).hostname.replace(/^www\./, '');
  } catch {
    return truncate(text, 32);
  }
}

const OPTIONAL_COLUMNS = {
  createdAt: {
    label: '记录时间',
    className: 'c-time',
    width: DASHBOARD_COLUMN_WIDTHS.createdAt,
    cell: (r) => dateCell(r.createdAt),
  },
  location: {
    label: '地点',
    className: 'c-loc',
    width: DASHBOARD_COLUMN_WIDTHS.location,
    cell: (r) => {
      const summary = locationSummary(r.location);
      return `<span class="truncate" title="${esc(summary.full || '')}">${esc(summary.short)}</span>`;
    },
  },
  salary: {
    label: '薪资',
    className: 'c-salary',
    width: DASHBOARD_COLUMN_WIDTHS.salary,
    cell: (r) => textCell(r.salary, 30),
  },
  status: {
    label: '状态',
    className: 'c-status',
    width: DASHBOARD_COLUMN_WIDTHS.status,
    cell: (r) => {
      const c = color(r.status);
      return `<div class="status-pill" style="--status-color:${esc(c)}"><span class="status-dot"></span><select data-act="status" aria-label="状态">${statusChoices(r.status)
        .map((s) => `<option value="${esc(s.name)}"${s.name === r.status ? ' selected' : ''}>${esc(s.name)}</option>`)
        .join('')}</select></div>`;
    },
  },
  appliedAt: {
    label: '投递日期',
    className: 'c-applied',
    width: DASHBOARD_COLUMN_WIDTHS.appliedAt,
    cell: (r) => `<input type="date" data-act="appliedAt" aria-label="投递日期" value="${r.appliedAt ? fmtDate(r.appliedAt) : ''}">`,
  },
  source: {
    label: '来源',
    className: 'c-source',
    width: DASHBOARD_COLUMN_WIDTHS.source,
    cell: (r) => textCell(r.sourceSite, 24),
  },
  nextAction: {
    label: '下一步',
    className: 'c-next',
    width: DASHBOARD_COLUMN_WIDTHS.nextAction,
    cell: (r) => (r.nextAction ? `<span class="next-tag" title="${esc(r.nextAction)}">${esc(truncate(r.nextAction, 26))}</span>` : '<span class="muted">—</span>'),
  },
  companyType: {
    label: '企业性质',
    className: 'c-type c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.companyType,
    cell: (r) => companyTypeBadge(r.companyType) || '<span class="muted">—</span>',
  },
  jobType: {
    label: '岗位类型',
    className: 'c-jobtype c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.jobType,
    cell: (r) => textCell(r.jobType, 24),
  },
  education: {
    label: '学历要求',
    className: 'c-education c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.education,
    cell: (r) => textCell(r.education, 30),
  },
  experience: {
    label: '经验要求',
    className: 'c-experience c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.experience,
    cell: (r) => textCell(r.experience, 30),
  },
  headcount: {
    label: '招聘人数',
    className: 'c-headcount c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.headcount,
    cell: (r) => textCell(r.headcount, 16),
  },
  deadline: {
    label: '截止时间',
    className: 'c-deadline c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.deadline,
    cell: (r) => textCell(r.deadline, 24),
  },
  contact: {
    label: '投递方式',
    className: 'c-contact c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.contact,
    cell: (r) => textCell(r.contact, 34),
  },
  skills: {
    label: '技能关键词',
    className: 'c-skills c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.skills,
    cell: (r) => {
      const list = r.skills || [];
      if (!list.length) return '<span class="muted">—</span>';
      const shown = list
        .slice(0, 3)
        .map((s) => `<span class="skill-mini">${esc(s)}</span>`)
        .join('');
      const more = list.length > 3 ? `<span class="skill-more">+${list.length - 3}</span>` : '';
      return `<span class="skill-list" title="${esc(list.join('、'))}">${shown}${more}</span>`;
    },
  },
  summary: {
    label: '岗位摘要',
    className: 'c-summary c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.summary,
    cell: (r) => textCell(r.summary, 60),
  },
  notes: {
    label: '备注',
    className: 'c-notes c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.notes,
    cell: (r) => textCell(r.notes, 60),
  },
  updatedAt: {
    label: '最后修改',
    className: 'c-updated c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.updatedAt,
    cell: (r) => dateCell(r.updatedAt || r.createdAt),
  },
  statusChanges: {
    label: '状态变更',
    className: 'c-changes c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.statusChanges,
    cell: (r) => `<span class="count-pill" title="状态时间线条目数">${(r.statusHistory || []).length}</span>`,
  },
  sourceUrl: {
    label: '来源链接',
    className: 'c-url c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.sourceUrl,
    cell: (r) => {
      const url = String(r.sourceUrl || '').trim();
      if (!url) return '<span class="muted">—</span>';
      if (!/^https?:\/\//i.test(url)) return `<span>${esc(url)}</span>`;
      return `<a class="src-link-cell" href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(url)}">${esc(urlLabel(url))}</a>`;
    },
  },
  pageTitle: {
    label: '页面标题',
    className: 'c-pagetitle c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.pageTitle,
    cell: (r) => textCell(r.pageTitle, 50),
  },
  aiModel: {
    label: '识别模型',
    className: 'c-model c-extra',
    width: DASHBOARD_COLUMN_WIDTHS.aiModel,
    cell: (r) => textCell(r.aiMeta?.model, 28),
  },
};

function visibleColumns() {
  return state.columns.order
    .filter((id) => !state.columns.hidden.includes(id))
    .map((id) => ({ id, ...OPTIONAL_COLUMNS[id] }))
    .filter((col) => col.label);
}

function companyTypeBadge(value) {
  const tone = companyTypeTone(value);
  if (!tone) return '';
  return `<span class="type-badge type-${tone}" title="企业性质：${esc(value)}">${esc(value)}</span>`;
}

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

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
const statusChoices = (current) =>
  current && !state.statuses.some((s) => s.name === current)
    ? [...state.statuses, statusDef(current, state.settings)]
    : state.statuses;

/* ------------------------------------------------------------------ */
/* 加载与渲染                                                          */
/* ------------------------------------------------------------------ */

async function load() {
  const res = await send({ type: 'LIST_RECORDS' });
  state.records = res.records || [];
  state.stats = res.stats;
  state.settings = res.settings;
  state.statuses = res.settings.statuses || [];
  state.columns = normalizeDashboardColumns(res.settings.dashboardColumns);
  state.columnWidths = normalizeDashboardColumnWidths(res.settings.dashboardColumnWidths);
  $('brand-sub').textContent = `${state.settings.model} · ${state.settings.apiBase.replace(/^https?:\/\//, '')}`;
  renderAll();
}

function renderAll() {
  renderOverviewSummary();
  renderCards();
  renderPanels();
  renderStatusFilter();
  renderSourceOptions();
  applyOverview();
  renderTable();
}

function renderOverviewSummary() {
  const s = state.stats;
  if (!s) return;
  const items = [
    ['总记录', s.total],
    ['本周新增', s.week],
    ['进行中', s.active],
    ['Offer', s.offerCount],
    ['面试及以后', s.interviewCount + s.offerCount],
    ['拒绝/结束', s.rejected],
  ];
  $('overview-metrics').innerHTML = items
    .map(([k, v]) => `<span class="metric"><span class="mk">${k}</span><b>${v}</b></span>`)
    .join('');
}

function applyOverview() {
  const expanded = Boolean(state.settings?.dashboardOverviewExpanded);
  $('overview').dataset.expanded = String(expanded);
  $('overview-body').hidden = !expanded;
  $('overview-toggle').setAttribute('aria-expanded', String(expanded));
}

async function toggleOverview() {
  const prev = Boolean(state.settings?.dashboardOverviewExpanded);
  const next = !prev;
  if (state.settings) state.settings.dashboardOverviewExpanded = next;
  applyOverview();
  try {
    await send({ type: 'SAVE_SETTINGS', patch: { dashboardOverviewExpanded: next } });
  } catch (err) {
    if (state.settings) state.settings.dashboardOverviewExpanded = prev;
    applyOverview();
    toast(`概览状态保存失败：${err.message}`, 'err');
  }
}

function renderCards() {
  const s = state.stats;
  const items = [
    { k: '总记录', v: s.total, s: '累计识别岗位数', accent: true },
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
    : '<span class="muted small">暂无数据</span>';

  $('skills').innerHTML = s.skills.length
    ? s.skills
        .map((x) => `<span class="chip-skill" data-skill="${esc(x.name)}">${esc(x.name)}<em>${x.count}</em></span>`)
        .join('')
    : '<span class="muted small">暂无关键词</span>';

  $('skills').querySelectorAll('[data-skill]').forEach((node) => {
    node.addEventListener('click', () => {
      $('q').value = node.dataset.skill;
      $('q-clear').hidden = false;
      renderTable();
    });
  });
}

function renderStatusFilter() {
  const list = state.stats.statusList.filter((s) => s.count > 0);
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
  cur.innerHTML = `<option value="">批量改状态…</option>${state.statuses
    .map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`)
    .join('')}`;
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
  const type = $('f-company-type').value;
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
    if (type === '__unset__') {
      if (r.companyType) return false;
    } else if (type && r.companyType !== type) return false;
    if (source && (r.sourceSite || '未识别') !== source) return false;
    if (from && (r.createdAt || 0) < from) return false;
    if (onlyTodo && !r.nextAction) return false;
    if (q) {
      const hay = [
        r.company,
        r.companyType,
        r.title,
        r.location,
        r.salary,
        r.notes,
        r.nextAction,
        r.jd,
        r.requirements,
        r.sourceSite,
        r.contact,
        (r.skills || []).join(' '),
      ]
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

function columnWidth(id, fallback) {
  const value = Number(state.columnWidths[id]);
  return Number.isFinite(value) ? value : fallback;
}

function updateTableMinWidth(cols = visibleColumns()) {
  const table = $('table');
  if (!table) return;
  if (compactQuery.matches) {
    table.style.minWidth = '0';
    return;
  }
  const optional = cols.reduce((sum, c) => sum + columnWidth(c.id, c.width), 0);
  const company = columnWidth('company', 220);
  table.style.minWidth = `${34 + company + optional + 64}px`;
}

function resizeHandle(id, label) {
  return `<span class="col-resizer" role="separator" aria-orientation="vertical" tabindex="0" data-resize-col="${id}" aria-label="调整${esc(label)}列宽" title="拖动调整列宽，双击恢复默认"></span>`;
}

function renderTableHead(cols) {
  const expanded = state.columnsOpen ? 'true' : 'false';
  const compact = compactQuery.matches;
  const companyStyle = !compact && state.columnWidths.company ? ` style="width:${state.columnWidths.company}px"` : '';
  $('thead').innerHTML = `<tr>
    <th class="c-check"><input type="checkbox" id="check-all" aria-label="全选当前结果"></th>
    <th class="c-company" data-col-id="company"${companyStyle}>公司 / 岗位${compact ? '' : resizeHandle('company', '公司/岗位')}</th>
    ${cols
      .map((c) => {
        const style = compact ? '' : ` style="width:${columnWidth(c.id, c.width)}px"`;
        return `<th class="${c.className}" data-col-id="${c.id}"${style}>${esc(c.label)}${compact ? '' : resizeHandle(c.id, c.label)}</th>`;
      })
      .join('')}
    <th class="c-act"><button type="button" class="icon-btn th-btn" id="btn-columns" title="列设置" aria-label="列设置" aria-expanded="${expanded}">${icon('columns', 16)}</button></th>
  </tr>`;
  updateTableMinWidth(cols);
}

function renderTable() {
  const rows = filtered();
  const cols = visibleColumns();
  const key = cols.map((c) => c.id).join(',');
  if (key !== state.headKey) {
    renderTableHead(cols);
    state.headKey = key;
  }
  const tbody = $('tbody');
  $('count').textContent = `显示 ${rows.length} / ${state.records.length} 条`;
  $('empty').hidden = state.records.length > 0;

  if (!rows.length) {
    tbody.innerHTML = state.records.length
      ? `<tr><td colspan="${cols.length + 3}" class="empty-row">当前筛选条件下没有记录</td></tr>`
      : '';
    renderBatch();
    return;
  }

  const showTypeColumn = !state.columns.hidden.includes('companyType');
  const showJobTypeColumn = !state.columns.hidden.includes('jobType');
  tbody.innerHTML = rows
    .map((r) => {
      const checked = state.selected.has(r.id);
      return `<tr data-id="${r.id}" class="${checked ? 'sel' : ''}">
        <td class="c-check"><input type="checkbox" class="row-check" data-id="${r.id}" aria-label="选择这条记录"${checked ? ' checked' : ''}></td>
        <td class="c-company">
          <div class="cell-main">
            <div class="line-1">
              <span class="t" title="${esc(r.company || '未知公司')}">${esc(r.company || '未知公司')}</span>
              ${showTypeColumn ? '' : companyTypeBadge(r.companyType)}
            </div>
            <div class="s" title="${esc(r.title || '')}">${esc(r.title || '未知岗位')}${!showJobTypeColumn && r.jobType ? ` · ${esc(r.jobType)}` : ''}</div>
          </div>
        </td>
        ${cols.map((c) => `<td class="${c.className}">${c.cell(r)}</td>`).join('')}
        <td class="c-act"><div class="row-act">
          <button type="button" data-act="open" title="查看详情" aria-label="查看详情">${icon('eye', 15)}</button>
          <button type="button" data-act="del" class="del" title="删除" aria-label="删除">${icon('trash', 15)}</button>
        </div></td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-act="open"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawer(id);
    });
    tr.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = state.records.find((x) => x.id === id);
      if (!confirm(`删除「${r?.company || ''} ${r?.title || ''}」这条记录？`)) return;
      await deleteOne(id);
    });
    tr.querySelector('[data-act="status"]')?.addEventListener('change', async (e) => {
      const value = e.target.value;
      e.target.closest('.status-pill')?.style.setProperty('--status-color', color(value));
      await patch(id, { status: value }, `状态已改为「${value}」`);
    });
    tr.querySelector('[data-act="appliedAt"]')?.addEventListener('change', async (e) => {
      await patch(id, { appliedAt: e.target.value }, '投递日期已更新');
    });
    tr.querySelector('.row-check')?.addEventListener('change', (e) => {
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
  const rows = filtered();
  const checkAll = $('check-all');
  if (checkAll) checkAll.checked = n > 0 && rows.length > 0 && rows.every((r) => state.selected.has(r.id));
}

/* ------------------------------------------------------------------ */
/* 列设置                                                              */
/* ------------------------------------------------------------------ */

function renderColumnList() {
  const query = state.columnSearch.trim().toLowerCase();
  const items = state.columns.order
    .map((id) => {
      const col = OPTIONAL_COLUMNS[id];
      if (!col) return null;
      if (query && !`${col.label} ${id}`.toLowerCase().includes(query)) return null;
      const hidden = state.columns.hidden.includes(id);
      return `<div class="cp-item" draggable="true" data-id="${id}">
        <span class="cp-grip" aria-hidden="true">${icon('grip', 14)}</span>
        <label class="cp-label"><input type="checkbox" data-col-toggle="${id}"${hidden ? '' : ' checked'}> <span>${esc(col.label)}</span></label>
        <span class="cp-width" title="当前列宽">${columnWidth(id, col.width)}px</span>
        <span class="cp-move">
          <button type="button" class="icon-btn" data-col-up="${id}" title="上移 ${esc(col.label)}" aria-label="上移 ${esc(col.label)}">${icon('arrowUp', 14)}</button>
          <button type="button" class="icon-btn" data-col-down="${id}" title="下移 ${esc(col.label)}" aria-label="下移 ${esc(col.label)}">${icon('arrowDown', 14)}</button>
        </span>
      </div>`;
    })
    .filter(Boolean)
    .join('');
  $('cp-list').innerHTML = items || '<div class="cp-empty">没有匹配的列</div>';
  updateColumnCount();
}

function updateColumnCount() {
  const total = state.columns.order.length;
  const shown = total - state.columns.hidden.length;
  $('cp-count').textContent = `${shown} / ${total} 列显示`;
}

function openColumnPopover(anchor) {
  $('export-menu').hidden = true;
  $('btn-export').setAttribute('aria-expanded', 'false');
  state.columnsOpen = true;
  state.columnsAnchor = anchor;
  const pop = $('column-pop');
  pop.hidden = false;
  renderColumnList();
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.right - popRect.width), innerWidth - popRect.width - 8);
  const top = Math.min(rect.bottom + 6, innerHeight - popRect.height - 8);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  $('btn-columns')?.setAttribute('aria-expanded', 'true');
  $('btn-columns-bar')?.setAttribute('aria-expanded', 'true');
}

function closeColumnPopover({ focus = true } = {}) {
  if (!state.columnsOpen) return;
  state.columnsOpen = false;
  $('column-pop').hidden = true;
  $('btn-columns')?.setAttribute('aria-expanded', 'false');
  $('btn-columns-bar')?.setAttribute('aria-expanded', 'false');
  if (focus) {
    const anchor = state.columnsAnchor?.isConnected ? state.columnsAnchor : $('btn-columns');
    anchor?.focus({ preventScroll: true });
  }
  state.columnsAnchor = null;
}

function scheduleColumnSave({ rerenderList = false } = {}) {
  state.headKey = null;
  renderTable();
  if (rerenderList) renderColumnList();
  else updateColumnCount();
  clearTimeout(state.columnSaveTimer);
  state.columnSaveTimer = setTimeout(async () => {
    const snapshot = { order: [...state.columns.order], hidden: [...state.columns.hidden] };
    const widths = {};
    for (const [id, width] of Object.entries(state.columnWidths)) {
      if (Number.isFinite(width)) widths[id] = width;
    }
    if (state.settings) {
      state.settings.dashboardColumns = snapshot;
      state.settings.dashboardColumnWidths = widths;
    }
    try {
      await send({ type: 'SAVE_SETTINGS', patch: { dashboardColumns: snapshot, dashboardColumnWidths: widths } });
    } catch (err) {
      toast(`列设置保存失败：${err.message}`, 'err');
    }
  }, 140);
}

function moveColumn(id, delta) {
  const order = state.columns.order;
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return;
  [order[from], order[to]] = [order[to], order[from]];
  scheduleColumnSave({ rerenderList: true });
  const selector = delta < 0 ? `[data-col-up="${id}"]` : `[data-col-down="${id}"]`;
  $('cp-list').querySelector(selector)?.focus();
}

function columnBounds(id) {
  return id === 'company' ? { min: 160, max: 600 } : { min: 70, max: 600 };
}

function defaultColumnWidth(id) {
  return id === 'company' ? null : OPTIONAL_COLUMNS[id]?.width || DASHBOARD_COLUMN_WIDTHS[id] || 120;
}

function applyColumnWidth(id, width) {
  const th = $('thead')?.querySelector(`th[data-col-id="${id}"]`) || null;
  if (th) {
    if (width == null) th.style.width = '';
    else th.style.width = `${width}px`;
  }
  updateTableMinWidth();
}

function setColumnWidth(id, width) {
  if (width == null) delete state.columnWidths[id];
  else state.columnWidths[id] = Math.round(width);
  applyColumnWidth(id, width);
  scheduleColumnSave();
}

function resetColumnWidth(id) {
  setColumnWidth(id, defaultColumnWidth(id));
}

function startColumnResize(event, handle) {
  if (compactQuery.matches || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const id = handle.dataset.resizeCol;
  const th = handle.closest('th');
  if (!id || !th) return;
  const { min, max } = columnBounds(id);
  const startX = event.clientX;
  const startWidth = th.getBoundingClientRect().width;
  document.documentElement.classList.add('col-resizing');
  const move = (moveEvent) => {
    const width = Math.min(max, Math.max(min, Math.round(startWidth + moveEvent.clientX - startX)));
    state.columnWidths[id] = width;
    th.style.width = `${width}px`;
    updateTableMinWidth();
  };
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.documentElement.classList.remove('col-resizing');
    scheduleColumnSave();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish, { once: true });
  window.addEventListener('pointercancel', finish, { once: true });
}

/* ------------------------------------------------------------------ */
/* 数据操作                                                            */
/* ------------------------------------------------------------------ */

async function patch(id, patchObj, message) {
  try {
    await send({ type: 'UPDATE_RECORD', id, patch: patchObj });
    const fresh = await send({ type: 'LIST_RECORDS' });
    state.records = fresh.records;
    state.stats = fresh.stats;
    state.settings = fresh.settings;
    state.statuses = fresh.settings.statuses || [];
    // 保留本页正在编辑的列配置，避免防抖保存前被旧设置覆盖。
    state.columns = normalizeDashboardColumns(state.columns);
    state.columnWidths = normalizeDashboardColumnWidths(state.columnWidths);
    renderOverviewSummary();
    renderCards();
    renderPanels();
    renderStatusFilter();
    renderTable();
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
  $('d-body').innerHTML = `<div class="muted small">载入中…</div>`;

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
        <label class="field"><span>企业性质</span><select id="d-company-type">${companyTypeOptions(r.companyType)}</select></label>
        <label class="field"><span>类型</span><input id="d-jobtype" value="${esc(r.jobType)}"></label>
        <label class="field"><span>状态</span><select id="d-status" style="color:${color(r.status)}">${statusChoices(r.status)
          .map((s) => `<option value="${esc(s.name)}"${s.name === r.status ? ' selected' : ''}>${esc(s.name)}</option>`)
          .join('')}</select></label>
        <label class="field"><span>投递日期</span><input id="d-applied" type="date" value="${r.appliedAt ? fmtDate(r.appliedAt) : ''}"></label>
        <label class="field"><span>地点</span><input id="d-location" value="${esc(r.location)}"></label>
        <label class="field"><span>薪资</span><input id="d-salary" value="${esc(r.salary)}"></label>
        <label class="field"><span>学历要求</span><input id="d-education" value="${esc(r.education)}"></label>
        <label class="field"><span>截止时间</span><input id="d-deadline" value="${esc(r.deadline)}"></label>
        <label class="field"><span>投递方式</span><input id="d-contact" value="${esc(r.contact)}"></label>
        <label class="field full"><span>下一步</span><input id="d-next" value="${esc(r.nextAction)}" placeholder="例如：9/20 前完成在线测评"></label>
      </div>
    </div>

    <div class="d-sec">
      <h3>技能关键词</h3>
      <div class="kv" id="d-skills">${(r.skills || []).map((s) => `<span>${esc(s)}</span>`).join('') || '<span class="kv-empty">无</span>'}</div>
    </div>

    <div class="d-sec">
      <h3>岗位职责</h3>
      <textarea class="field-textarea" id="d-jd" rows="6">${esc(r.jd)}</textarea>
    </div>

    <div class="d-sec">
      <h3>任职要求</h3>
      <textarea class="field-textarea" id="d-req" rows="6">${esc(r.requirements)}</textarea>
    </div>

    <div class="d-sec">
      <h3>备注</h3>
      <textarea class="field-textarea" id="d-notes" rows="2">${esc(r.notes)}</textarea>
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
              ${h.note ? `<div class="muted small">${esc(h.note)}</div>` : ''}
            </div>
          </div>`,
            )
            .join('') || '<span class="muted small">暂无</span>'
        }
      </div>
    </div>

    <div class="d-sec">
      <h3>来源信息</h3>
      <div class="meta-list">
        <div>记录时间：${fmtDateTime(r.createdAt)}</div>
        <div>最后修改：${fmtDateTime(r.updatedAt || r.createdAt)}</div>
        <div>来源站点：${esc(r.sourceSite || '—')}</div>
        ${r.pageTitle ? `<div>页面标题：${esc(r.pageTitle)}</div>` : ''}
        ${r.aiMeta ? `<div>识别：${esc(r.aiMeta.model || '')} · ${Math.round((r.aiMeta.ms || 0) / 100) / 10}s${r.aiMeta.usage ? ` · ${r.aiMeta.usage.total_tokens || ''} tokens` : ''}</div>` : ''}
        ${/^https?:\/\//i.test(r.sourceUrl || '') ? `<div><a class="src-link" href="${esc(r.sourceUrl)}" target="_blank" rel="noreferrer">${esc(truncate(r.sourceUrl, 70))}</a></div>` : ''}
      </div>
    </div>`;

  const companyTypeField = bindCompanyTypeField({
    companyInput: $('d-company'),
    select: $('d-company-type'),
    initialType: r.companyType,
  });
  companyTypeField.refresh();

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
  node.innerHTML = `<img src="${esc(src)}" class="zoom-img" alt="">`;
  node.addEventListener('click', () => node.remove());
  document.body.appendChild(node);
}

function closeDrawer() {
  document.documentElement.removeAttribute('data-workbench-dirty');
  state.editingId = null;
  $('drawer').hidden = true;
}

async function saveDrawer() {
  const id = state.editingId;
  if (!id) return;
  const val = (sel) => $(sel)?.value?.trim() ?? '';
  const patchObj = {
    company: val('d-company'),
    companyType: val('d-company-type'),
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
    document.documentElement.removeAttribute('data-workbench-dirty');
    toast('已保存', 'ok');
    $('d-title').textContent = `${res.record.company || '未知公司'} · ${res.record.title || '未知岗位'}`;
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 手动添加                                                            */
/* ------------------------------------------------------------------ */

function initModal() {
  $('m-company-type').innerHTML = companyTypeOptions('');
  state.modalCompanyType = bindCompanyTypeField({
    companyInput: $('m-company'),
    select: $('m-company-type'),
    hint: $('m-company-type-hint'),
  });
}

function openModal() {
  $('modal').hidden = false;
  $('m-status').innerHTML = state.statuses
    .map((s) => `<option value="${esc(s.name)}"${s.name === state.settings.defaultStatus ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  $('m-applied').value = fmtDate(Date.now());
  $('m-company-type').value = '';
  $('m-company-type-hint').textContent = '未识别，可手动选择';
  state.modalCompanyType?.setTouched(false);
  state.modalCompanyType?.refresh();
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
        companyType: val('m-company-type'),
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
    document.documentElement.removeAttribute('data-workbench-dirty');
    ['m-company', 'm-title', 'm-location', 'm-salary', 'm-next', 'm-jd', 'm-notes'].forEach((id) => {
      $(id).value = '';
    });
    $('m-company-type').value = '';
    $('m-company-type-hint').textContent = '未识别，可手动选择';
    state.modalCompanyType?.setTouched(false);
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
  $('btn-export').setAttribute('aria-expanded', 'false');
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


/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

paintIcons();
initModal();

$('q').addEventListener('input', () => {
  $('q-clear').hidden = !$('q').value;
  renderTable();
});
$('q-clear').addEventListener('click', () => {
  $('q').value = '';
  $('q-clear').hidden = true;
  renderTable();
});
['f-company-type', 'f-source', 'f-range', 'f-sort', 'f-todo'].forEach((id) => $(id).addEventListener('change', renderTable));

$('btn-columns-bar').addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.columnsOpen) closeColumnPopover();
  else openColumnPopover(e.currentTarget);
});
$('thead').addEventListener('click', (e) => {
  if (e.target.closest('#btn-columns')) {
    e.stopPropagation();
    if (state.columnsOpen) closeColumnPopover();
    else openColumnPopover(e.target.closest('#btn-columns'));
  }
});
$('thead').addEventListener('change', (e) => {
  if (e.target.id !== 'check-all') return;
  const rows = filtered();
  if (e.target.checked) rows.forEach((r) => state.selected.add(r.id));
  else rows.forEach((r) => state.selected.delete(r.id));
  renderTable();
});
$('thead').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.col-resizer');
  if (handle) startColumnResize(e, handle);
});
$('thead').addEventListener('dblclick', (e) => {
  const handle = e.target.closest('.col-resizer');
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  resetColumnWidth(handle.dataset.resizeCol);
});
$('thead').addEventListener('keydown', (e) => {
  const handle = e.target.closest('.col-resizer');
  if (!handle) return;
  const id = handle.dataset.resizeCol;
  const th = handle.closest('th');
  if (!id || !th) return;
  const { min, max } = columnBounds(id);
  const current = Number(state.columnWidths[id]) || th.getBoundingClientRect().width;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const delta = e.shiftKey ? 32 : 8;
    setColumnWidth(id, Math.min(max, Math.max(min, current + (e.key === 'ArrowRight' ? delta : -delta))));
  } else if (e.key === 'Home') {
    e.preventDefault();
    resetColumnWidth(id);
  }
});

$('overview-toggle').addEventListener('click', toggleOverview);

$('column-pop').addEventListener('click', (e) => e.stopPropagation());
$('cp-close').addEventListener('click', () => closeColumnPopover());
$('cp-reset').addEventListener('click', () => {
  state.columns = normalizeDashboardColumns(DEFAULT_DASHBOARD_COLUMNS);
  state.columnWidths = normalizeDashboardColumnWidths();
  state.columnSearch = '';
  $('cp-search').value = '';
  scheduleColumnSave({ rerenderList: true });
});
$('cp-show-all').addEventListener('click', () => {
  state.columns.hidden = [];
  scheduleColumnSave({ rerenderList: true });
});
$('cp-search').addEventListener('input', (e) => {
  state.columnSearch = e.target.value;
  renderColumnList();
});

$('cp-list').addEventListener('change', (e) => {
  const id = e.target.dataset.colToggle;
  if (!id) return;
  if (e.target.checked) state.columns.hidden = state.columns.hidden.filter((x) => x !== id);
  else if (!state.columns.hidden.includes(id)) state.columns.hidden.push(id);
  scheduleColumnSave();
});

$('cp-list').addEventListener('click', (e) => {
  const up = e.target.closest('[data-col-up]');
  const down = e.target.closest('[data-col-down]');
  if (up) moveColumn(up.dataset.colUp, -1);
  if (down) moveColumn(down.dataset.colDown, 1);
});

let dragColumnId = '';
$('cp-list').addEventListener('dragstart', (e) => {
  const item = e.target.closest('.cp-item');
  if (!item) return;
  dragColumnId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragColumnId);
});
$('cp-list').addEventListener('dragover', (e) => {
  if (!dragColumnId) return;
  const item = e.target.closest('.cp-item');
  if (!item || item.dataset.id === dragColumnId) return;
  e.preventDefault();
  item.classList.add('drag-over');
});
$('cp-list').addEventListener('dragleave', (e) => {
  e.target.closest('.cp-item')?.classList.remove('drag-over');
});
$('cp-list').addEventListener('drop', (e) => {
  const item = e.target.closest('.cp-item');
  if (!item || !dragColumnId) return;
  e.preventDefault();
  item.classList.remove('drag-over');
  const target = item.dataset.id;
  if (target === dragColumnId) return;
  const order = state.columns.order;
  const from = order.indexOf(dragColumnId);
  const to = order.indexOf(target);
  order.splice(from, 1);
  order.splice(to, 0, dragColumnId);
  dragColumnId = '';
  scheduleColumnSave({ rerenderList: true });
});
$('cp-list').addEventListener('dragend', () => {
  dragColumnId = '';
  $('cp-list').querySelectorAll('.dragging,.drag-over').forEach((n) => n.classList.remove('dragging', 'drag-over'));
});

$('table-scroll').addEventListener('scroll', () => closeColumnPopover({ focus: false }), { passive: true });
window.addEventListener('resize', () => closeColumnPopover({ focus: false }));
document.addEventListener('click', (e) => {
  if (!state.columnsOpen) return;
  if (e.target.closest('#column-pop') || e.target.closest('#btn-columns') || e.target.closest('#btn-columns-bar')) return;
  closeColumnPopover({ focus: false });
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
  $('btn-export').setAttribute('aria-expanded', String(!$('export-menu').hidden));
});
$('export-menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-export]')?.dataset.export;
  if (kind) doExport(kind);
});
document.addEventListener('click', () => {
  $('export-menu').hidden = true;
  $('btn-export').setAttribute('aria-expanded', 'false');
});

$('btn-import').addEventListener('click', () => openApplicationImport({ onSuccess: () => load() }));

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

$('btn-options').addEventListener('click', () => navigate('options'));
$('btn-knowledge').addEventListener('click', () => navigate('knowledge'));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('#application-import[open]')) return;
  if (state.columnsOpen) closeColumnPopover();
  else if (!$('modal').hidden) $('modal').hidden = true;
  else if (!$('drawer').hidden) closeDrawer();
});

const applyCompact = () => {
  document.documentElement.classList.toggle('compact-table', compactQuery.matches);
  state.headKey = null;
  if (state.stats) renderTable();
};
applyCompact();
compactQuery.addEventListener?.('change', applyCompact);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.records) {
    load().catch(() => {});
  }
});

load()
  .then(() =>
    registerViewState(
      () => ({
        editingId: state.editingId,
        modal: !$('modal').hidden,
        statusFilter: [...state.statusFilter],
        selected: [...state.selected],
      }),
      async (saved) => {
        if (!saved) return;
        state.statusFilter = new Set(saved.statusFilter || []);
        state.selected = new Set(saved.selected || []);
        renderAll();
        if (saved.editingId) await openDrawer(saved.editingId);
        else closeDrawer();
        if (saved.modal) openModal();
        else $('modal').hidden = true;
      },
      () => renderTable(),
    ),
  )
  .catch((err) => toast(`载入失败：${err.message}`, 'err', [], 0));

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'JDT_DASHBOARD_PING') respond({ dashboard: true });
  return false;
});

for (const id of ['drawer', 'modal']) {
  $(id).addEventListener('input', () => {
    document.documentElement.dataset.workbenchDirty = 'true';
  });
}
