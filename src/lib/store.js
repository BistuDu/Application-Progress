/**
 * 记录存储层：chrome.storage.local 里的 records 数组 + 派生统计。
 * 记录模型（一条 = 一次岗位记录）：
 * {
 *   id, createdAt, appliedAt, company, title, location, salary, jobType,
 *   education, experience, deadline, jd, requirements, skills[], contact,
 *   summary, status, statusHistory[{status,at,note}], nextAction, notes,
 *   sourceUrl, sourceSite, pageTitle, screenshot, aiRaw, aiMeta{model,ms,usage}
 * }
 */

import {
  DAY_MS,
  dataUrlBytes,
  fmtDate,
  fmtDateTime,
  normalizeKey,
  siteFromUrl,
  startOfMonth,
  startOfWeek,
  startOfDay,
  toTs,
  uid,
  uniq,
} from './util.js';
import { RECORDS_KEY, getSettings, statusDef } from './settings.js';

export async function listRecords() {
  const { [RECORDS_KEY]: records } = await chrome.storage.local.get(RECORDS_KEY);
  return Array.isArray(records) ? records : [];
}

export async function saveRecords(records) {
  await chrome.storage.local.set({ [RECORDS_KEY]: records });
  return records;
}

export function sortRecords(records, key = 'createdAt', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    if (key === 'company' || key === 'title' || key === 'status') {
      return String(a[key] || '').localeCompare(String(b[key] || ''), 'zh-Hans-CN') * sign;
    }
    return ((toTs(a[key]) ?? 0) - (toTs(b[key]) ?? 0)) * sign;
  });
}

/** 用识别结果 + 用户编辑构造一条完整记录。 */
export async function buildRecord(input, { settings } = {}) {
  const s = settings || (await getSettings());
  const now = Date.now();
  const status = input.status || s.defaultStatus;
  const skills = uniq([...(input.skills || []), ...(input.extraSkills || [])]).slice(0, 40);
  return {
    id: input.id || uid('job'),
    createdAt: input.createdAt || now,
    updatedAt: now,
    appliedAt: toTs(input.appliedAt) ?? now,
    company: (input.company || '').trim(),
    title: (input.title || '').trim(),
    location: (input.location || '').trim(),
    salary: (input.salary || '').trim(),
    jobType: (input.jobType || '').trim(),
    education: (input.education || '').trim(),
    experience: (input.experience || '').trim(),
    deadline: (input.deadline || '').trim(),
    jd: (input.jd || '').trim(),
    requirements: (input.requirements || '').trim(),
    skills,
    contact: (input.contact || '').trim(),
    summary: (input.summary || '').trim(),
    status,
    statusHistory: input.statusHistory || [{ status, at: now, note: '创建记录' }],
    nextAction: (input.nextAction || '').trim(),
    notes: (input.notes || '').trim(),
    sourceUrl: input.sourceUrl || '',
    sourceSite: input.sourceSite || siteFromUrl(input.sourceUrl || ''),
    pageTitle: input.pageTitle || '',
    screenshot: s.keepScreenshot ? input.screenshot || '' : '',
    aiRaw: input.aiRaw || '',
    aiMeta: input.aiMeta || null,
  };
}

export async function addRecord(input, { settings } = {}) {
  const s = settings || (await getSettings());
  const records = await listRecords();
  const record = await buildRecord(input, { settings: s });
  records.unshift(record);
  await saveRecords(enforceScreenshotBudget(records, s));
  return record;
}

/**
 * 更新记录。状态变化会写入 statusHistory，便于复盘节奏。
 */
export async function updateRecord(id, patch) {
  const records = await listRecords();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const prev = records[idx];
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  if (patch.appliedAt !== undefined) next.appliedAt = toTs(patch.appliedAt);
  if (patch.status && patch.status !== prev.status) {
    next.statusHistory = [
      ...(prev.statusHistory || []),
      { status: patch.status, at: Date.now(), note: patch.statusNote || '' },
    ];
  }
  if (next.screenshot === undefined) next.screenshot = '';
  records[idx] = next;
  await saveRecords(records);
  return next;
}

export async function deleteRecords(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const records = await listRecords();
  const next = records.filter((r) => !set.has(r.id));
  await saveRecords(next);
  return records.length - next.length;
}

export async function clearAll() {
  await saveRecords([]);
}

/** 只保留最近 N 张截图，记录本身不删。 */
export function enforceScreenshotBudget(records, settings) {
  const max = Number(settings?.maxStoredScreenshots) || 0;
  if (!max || !settings?.keepScreenshot) return records;
  const withShot = records.filter((r) => r.screenshot);
  if (withShot.length <= max) return records;
  const keep = new Set(
    [...withShot].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, max).map((r) => r.id),
  );
  return records.map((r) => (r.screenshot && !keep.has(r.id) ? { ...r, screenshot: '' } : r));
}

/** 查找疑似重复记录：公司 + 岗位相近。 */
export function findDuplicates(records, { company, title, id }) {
  const ck = normalizeKey(company);
  const tk = normalizeKey(title);
  if (!ck && !tk) return [];
  return records.filter((r) => {
    if (id && r.id === id) return false;
    const rc = normalizeKey(r.company);
    const rt = normalizeKey(r.title);
    if (ck && rc && tk && rt) return ck === rc && (rt === tk || rt.includes(tk) || tk.includes(rt));
    if (tk && rt) return tk === rt;
    if (ck && rc) return ck === rc;
    return false;
  });
}

/** 统计：总览、漏斗、趋势、来源、技能。 */
export function computeStats(records, settings) {
  const now = Date.now();
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);
  const todayStart = startOfDay(now);

  const byStatus = new Map();
  for (const r of records) {
    const k = r.status || '待确认';
    byStatus.set(k, (byStatus.get(k) || 0) + 1);
  }

  const statusList = (settings?.statuses || []).map((s) => ({ ...s, count: byStatus.get(s.name) || 0 }));
  for (const [name, count] of byStatus) {
    if (!statusList.some((s) => s.name === name)) {
      statusList.push({ ...statusDef(name, settings), count });
    }
  }

  const total = records.length;
  const offerCount = byStatus.get('Offer') || 0;
  const interviewCount = byStatus.get('面试') || 0;
  const rejected = byStatus.get('拒绝/已结束') || 0;
  const active = total - offerCount - rejected;

  const createdIn = (from) => records.filter((r) => (r.createdAt || 0) >= from).length;

  // 漏斗：按"是否到达过该阶段"统计，比只按当前状态更能反映真实进度
  const reached = { 已投递: 0, 筛选中: 0, 测评中: 0, 面试: 0, Offer: 0 };
  const order = ['已投递', '筛选中', '测评中', '面试', 'Offer'];
  const rank = (name) => {
    const i = order.indexOf(name);
    if (i !== -1) return i;
    if (name === '拒绝/已结束' || name === '待确认') return 0;
    return 0;
  };
  for (const r of records) {
    const best = Math.max(rank(r.status), ...(r.statusHistory || []).map((h) => rank(h.status)));
    for (let i = 0; i <= best; i += 1) reached[order[i]] += 1;
  }

  // 近 8 周新增趋势
  const weeks = [];
  for (let i = 7; i >= 0; i -= 1) {
    const from = weekStart - i * 7 * DAY_MS;
    const to = from + 7 * DAY_MS;
    const count = records.filter((r) => (r.createdAt || 0) >= from && (r.createdAt || 0) < to).length;
    weeks.push({ from, label: fmtDate(from).slice(5), count, current: i === 0 });
  }

  const sites = new Map();
  for (const r of records) {
    const k = r.sourceSite || '未识别';
    sites.set(k, (sites.get(k) || 0) + 1);
  }

  const skills = new Map();
  for (const r of records) {
    for (const sk of r.skills || []) skills.set(sk, (skills.get(sk) || 0) + 1);
  }

  // 最近状态变化
  const events = [];
  for (const r of records) {
    for (const h of r.statusHistory || []) {
      events.push({ at: h.at, status: h.status, company: r.company, title: r.title, id: r.id, note: h.note || '' });
    }
  }
  events.sort((a, b) => (b.at || 0) - (a.at || 0));

  const needAction = records.filter((r) => r.nextAction && r.status !== 'Offer' && r.status !== '拒绝/已结束');

  return {
    total,
    today: createdIn(todayStart),
    week: createdIn(weekStart),
    month: createdIn(monthStart),
    offerCount,
    interviewCount,
    rejected,
    active,
    offerRate: total ? offerCount / total : 0,
    interviewRate: total ? (interviewCount + offerCount) / total : 0,
    statusList: statusList.filter((s) => s.count > 0 || (settings?.statuses || []).includes(s)),
    reached,
    funnel: order.map((name) => ({ name, ...statusDef(name, settings), count: reached[name] })),
    weeks,
    sites: [...sites.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    skills: [...skills.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 24),
    events: events.slice(0, 30),
    needAction: needAction.length,
    storageBytes: records.reduce((n, r) => n + dataUrlBytes(r.screenshot), 0),
  };
}

/** JSON 全量导出。 */
export function toExportJson(records, settings) {
  return JSON.stringify(
    {
      app: 'jd-job-tracker',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: records.length,
      statuses: settings?.statuses || [],
      records,
    },
    null,
    2,
  );
}

/** CSV 导出（带 BOM，Excel 直接打开不乱码）。 */
export function toCsv(records) {
  const cols = [
    ['记录时间', (r) => fmtDateTime(r.createdAt)],
    ['投递时间', (r) => (r.appliedAt ? fmtDate(r.appliedAt) : '')],
    ['公司', (r) => r.company],
    ['岗位', (r) => r.title],
    ['状态', (r) => r.status],
    ['地点', (r) => r.location],
    ['薪资', (r) => r.salary],
    ['类型', (r) => r.jobType],
    ['学历', (r) => r.education],
    ['经验', (r) => r.experience],
    ['截止时间', (r) => r.deadline],
    ['技能关键词', (r) => (r.skills || []).join('/')],
    ['投递方式', (r) => r.contact],
    ['下一步', (r) => r.nextAction],
    ['备注', (r) => r.notes],
    ['来源', (r) => r.sourceSite],
    ['链接', (r) => r.sourceUrl],
    ['岗位职责', (r) => r.jd],
    ['任职要求', (r) => r.requirements],
    ['状态变更次数', (r) => String((r.statusHistory || []).length)],
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
    return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.map(([n]) => n).join(',');
  const body = records.map((r) => cols.map(([, fn]) => esc(fn(r))).join(',')).join('\r\n');
  return `\uFEFF${head}\r\n${body}\r\n`;
}

/** Markdown 导出：可直接喂给 /offer 技能做进一步整理。 */
export function toMarkdown(records, settings) {
  const lines = [];
  lines.push(`# 求职投递进度（导出时间 ${fmtDateTime(Date.now())}）`);
  lines.push('');
  const stats = computeStats(records, settings);
  lines.push(`共 ${stats.total} 条记录；本周新增 ${stats.week} 条；面试/Offer ${stats.interviewCount + stats.offerCount} 条。`);
  lines.push('');
  lines.push('| 公司 | 岗位 | 状态 | 投递时间 | 记录时间 | 地点 | 薪资 | 下一步 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const r of records) {
    lines.push(
      `| ${cell(r.company) || '—'} | ${cell(r.title)} | ${cell(r.status)} | ${r.appliedAt ? fmtDate(r.appliedAt) : '—'} | ${fmtDate(r.createdAt)} | ${cell(r.location)} | ${cell(r.salary)} | ${cell(r.nextAction)} | ${cell(r.notes)} |`,
    );
  }
  lines.push('');
  lines.push('## 状态变化明细');
  for (const r of records) {
    const hist = (r.statusHistory || [])
      .map((h) => `${fmtDate(h.at)} ${h.status}${h.note ? `(${h.note})` : ''}`)
      .join(' → ');
    if (hist) lines.push(`- **${r.company || '未知公司'} · ${r.title || '未知岗位'}**：${hist}`);
  }
  lines.push('');
  lines.push('## 岗位详情');
  for (const r of records) {
    lines.push('');
    lines.push(`### ${r.company || '未知公司'} · ${r.title || '未知岗位'}（${r.status}）`);
    if (r.sourceUrl) lines.push(`- 来源：${r.sourceSite || ''} ${r.sourceUrl}`);
    if (r.skills?.length) lines.push(`- 关键词：${r.skills.join('、')}`);
    if (r.contact) lines.push(`- 投递方式：${r.contact}`);
    if (r.jd) {
      lines.push('');
      lines.push('岗位职责：');
      lines.push(r.jd);
    }
    if (r.requirements) {
      lines.push('');
      lines.push('任职要求：');
      lines.push(r.requirements);
    }
  }
  return lines.join('\n');
}

/** 导入 JSON 备份；按 id 覆盖、按 公司+岗位 去重。 */
export function mergeImport(existing, incoming) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const byKey = new Map(existing.map((r) => [normalizeKey(r.company, r.title), r]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const out = [...existing];
  for (const rec of incoming) {
    if (!rec || typeof rec !== 'object') {
      skipped += 1;
      continue;
    }
    const key = normalizeKey(rec.company, rec.title);
    if (rec.id && byId.has(rec.id)) {
      const i = out.findIndex((r) => r.id === rec.id);
      out[i] = { ...out[i], ...rec };
      updated += 1;
      continue;
    }
    if (key && byKey.has(key)) {
      skipped += 1;
      continue;
    }
    const withId = { ...rec, id: rec.id || uid('job') };
    out.push(withId);
    byId.set(withId.id, withId);
    if (key) byKey.set(key, withId);
    added += 1;
  }
  return { records: out, added, updated, skipped };
}

export function importSummaryText({ added, updated, skipped }) {
  return `导入完成：新增 ${added} 条，更新 ${updated} 条，跳过重复 ${skipped} 条。`;
}
