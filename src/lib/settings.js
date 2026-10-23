/**
 * 设置项：默认值、读写、状态词表。所有扩展页面与 service worker 共用。
 */

export const SETTINGS_KEY = 'settings';
export const RECORDS_KEY = 'records';

/** 旧默认词表仅用于识别未定制的设置和显示历史记录。 */
const LEGACY_STATUSES = [
  { name: '已投递', color: '#3b82f6', kind: 'applied', desc: '已提交申请，等待回复' },
  { name: '筛选中', color: '#8b5cf6', kind: 'progress', desc: '简历/笔试筛选中' },
  { name: '测评中', color: '#f59e0b', kind: 'progress', desc: '在线测评或笔试进行中' },
  { name: '面试', color: '#06b6d4', kind: 'progress', desc: '已进入面试环节' },
  { name: 'Offer', color: '#10b981', kind: 'offer', desc: '已收到录用意向' },
  { name: '拒绝/已结束', color: '#ef4444', kind: 'closed', desc: '被拒、流程终止或主动放弃' },
  { name: '待确认', color: '#94a3b8', kind: 'unknown', desc: '信息不足，需要进一步确认' },
];

/** 默认投递流程。 */
export const DEFAULT_STATUSES = [
  { name: '已投递', color: '#3b82f6', kind: 'applied', desc: '已提交申请，等待回复' },
  { name: '测评中', color: '#f59e0b', kind: 'progress', desc: '在线测评或笔试进行中' },
  { name: '一面', color: '#06b6d4', kind: 'progress', desc: '第一轮面试' },
  { name: '二面', color: '#0891b2', kind: 'progress', desc: '第二轮面试' },
  { name: '三面', color: '#0e7490', kind: 'progress', desc: '第三轮面试' },
  { name: 'HR面', color: '#14b8a6', kind: 'progress', desc: 'HR 面试' },
  { name: 'Offer', color: '#10b981', kind: 'offer', desc: '已收到录用意向' },
];

/** 投递表格的可选列；公司/岗位、勾选和操作列固定，不在此列表。 */
export const DASHBOARD_COLUMN_IDS = [
  'createdAt',
  'location',
  'salary',
  'status',
  'appliedAt',
  'source',
  'nextAction',
  'companyType',
  'jobType',
  'education',
  'experience',
  'headcount',
  'deadline',
  'contact',
  'skills',
  'summary',
  'notes',
  'updatedAt',
  'statusChanges',
  'sourceUrl',
  'pageTitle',
  'aiModel',
];

/** 新增的扩展列默认不显示，保持原有首屏清爽；用户可在列设置里打开。 */
export const DEFAULT_HIDDEN_DASHBOARD_COLUMNS = [
  'companyType',
  'jobType',
  'education',
  'experience',
  'headcount',
  'deadline',
  'contact',
  'skills',
  'summary',
  'notes',
  'updatedAt',
  'statusChanges',
  'sourceUrl',
  'pageTitle',
  'aiModel',
];

/** 可选列的默认宽度（px）；用户拖拽后的值保存在 dashboardColumnWidths。 */
export const DASHBOARD_COLUMN_WIDTHS = {
  createdAt: 108,
  location: 104,
  salary: 96,
  status: 118,
  appliedAt: 116,
  source: 92,
  nextAction: 150,
  companyType: 90,
  jobType: 100,
  education: 100,
  experience: 100,
  headcount: 80,
  deadline: 110,
  contact: 130,
  skills: 180,
  summary: 200,
  notes: 180,
  updatedAt: 108,
  statusChanges: 90,
  sourceUrl: 140,
  pageTitle: 180,
  aiModel: 120,
};

export const DEFAULT_DASHBOARD_COLUMNS = {
  order: [...DASHBOARD_COLUMN_IDS],
  hidden: [...DEFAULT_HIDDEN_DASHBOARD_COLUMNS],
};

/** 过滤未知/重复列，补齐新增列；老配置里的新增列默认隐藏。 */
export function normalizeDashboardColumns(value) {
  const known = new Set(DASHBOARD_COLUMN_IDS);
  const sourceOrder = Array.isArray(value?.order) ? value.order : [];
  const sourceHidden = new Set(Array.isArray(value?.hidden) ? value.hidden : []);
  const order = [];
  for (const id of sourceOrder) {
    if (known.has(id) && !order.includes(id)) order.push(id);
  }
  for (const id of DASHBOARD_COLUMN_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  const hidden = new Set([...sourceHidden].filter((id) => known.has(id)));
  for (const id of DEFAULT_HIDDEN_DASHBOARD_COLUMNS) {
    if (!sourceOrder.includes(id) && !sourceHidden.has(id)) hidden.add(id);
  }
  return { order, hidden: [...hidden] };
}

/** 把用户拖拽的列宽限制在可读范围内；缺失项回退默认。 */
export function normalizeDashboardColumnWidths(value) {
  const out = {};
  for (const id of DASHBOARD_COLUMN_IDS) {
    const raw = value?.[id];
    const n = Number(raw);
    out[id] = raw != null && Number.isFinite(n) ? Math.min(600, Math.max(70, Math.round(n))) : DASHBOARD_COLUMN_WIDTHS[id];
  }
  const rawCompany = value?.company;
  const company = Number(rawCompany);
  if (rawCompany != null && Number.isFinite(company)) {
    out.company = Math.min(600, Math.max(160, Math.round(company)));
  }
  return out;
}

export const DEFAULT_PROMPT = `你是求职进度管理助手。请阅读这张招聘信息截图，提取结构化信息。
只输出一个 JSON 对象，不要输出解释、markdown 代码块或多余文字。

字段定义：
{
  "is_job": true,
  "company": "公司名称",
  "company_type": "企业性质：央企/国企/私企/其他；仅当截图明确写出时填写，否则空字符串",
  "title": "岗位名称",
  "location": "工作地点",
  "salary": "薪资待遇，原文照抄",
  "job_type": "实习/校招/社招/兼职/未知",
  "education": "学历要求",
  "experience": "经验要求",
  "headcount": "招聘人数",
  "deadline": "截止时间",
  "jd": "岗位职责与工作内容，完整原文，保留分段",
  "requirements": "任职要求，完整原文，保留分段",
  "skills": ["技能关键词"],
  "contact": "投递方式或邮箱或链接",
  "summary": "一句话概括这个岗位"
}

规则：
- 只提取图片中真实出现的信息，绝对不要编造或推测；图片里没有的字段填空字符串或空数组。
- company_type 只在截图明确出现企业性质（如“央企”“国企”“民营企业”“外资企业”）时填写；不得根据公司名猜测，无法确定时填空字符串。
- 截图中若出现多个岗位，只提取最主要的那一个。
- jd 与 requirements 尽量完整保留原文措辞和换行，不要总结压缩。
- 如果图片不是招聘信息，is_job 设为 false，其余字段留空。
- 页面标题、网址等上下文信息仅供参考，用于补全公司名；无法确定时留空，不要臆造。`;

export const DEFAULT_SETTINGS = {
  // —— 模型接口 ——
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  maxTokens: 4096,
  timeoutMs: 120000,
  promptTemplate: DEFAULT_PROMPT,

  // —— 截图 ——
  cropMaxSide: 1800,
  cropQuality: 0.9,
  keepScreenshot: true,
  maxStoredScreenshots: 300,

  // —— 记录行为 ——
  statuses: DEFAULT_STATUSES,
  defaultStatus: '已投递',
  autoOpenDashboard: false,
  closePanelAfterSave: true,
  warnDuplicate: true,

  // —— 界面 ——
  lastView: 'table',
  dashboardColumns: {
    order: [...DASHBOARD_COLUMN_IDS],
    hidden: [...DEFAULT_HIDDEN_DASHBOARD_COLUMNS],
  },
  dashboardColumnWidths: { ...DASHBOARD_COLUMN_WIDTHS },
  dashboardOverviewExpanded: false,
};

/** 读取设置，缺失字段用默认值补齐。 */
export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  const legacyDefaults = Array.isArray(saved?.statuses) && saved.statuses.length === LEGACY_STATUSES.length && saved.statuses.every((s, i) => s.name === LEGACY_STATUSES[i].name && s.color === LEGACY_STATUSES[i].color);
  if (!Array.isArray(merged.statuses) || merged.statuses.length === 0 || legacyDefaults) {
    merged.statuses = DEFAULT_STATUSES;
  }
  if (legacyDefaults && !merged.statuses.some((s) => s.name === merged.defaultStatus)) merged.defaultStatus = '已投递';
  merged.dashboardColumns = normalizeDashboardColumns(merged.dashboardColumns);
  merged.dashboardColumnWidths = normalizeDashboardColumnWidths(merged.dashboardColumnWidths);
  if (typeof merged.dashboardOverviewExpanded !== 'boolean') merged.dashboardOverviewExpanded = false;
  return merged;
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** 状态名列表。 */
export function statusNames(settings) {
  return (settings?.statuses || DEFAULT_STATUSES).map((s) => s.name);
}

/** 取状态定义，未知状态返回一个灰色的兜底定义。 */
export function statusDef(name, settings) {
  const list = settings?.statuses || DEFAULT_STATUSES;
  return (
    list.find((s) => s.name === name) || LEGACY_STATUSES.find((s) => s.name === name) || {
      name: name || '待确认',
      color: '#94a3b8',
      kind: 'unknown',
      desc: '',
    }
  );
}

export function statusColor(name, settings) {
  return statusDef(name, settings).color;
}

/**
 * 把接口地址归一化成可用的 chat/completions 候选地址。
 * 兼容 https://host 、https://host/v1 、https://host/v1/chat/completions 等写法。
 */
export function chatUrlCandidates(apiBase) {
  let base = String(apiBase || '').trim().replace(/\s+/g, '');
  if (!base) return [];
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  const out = [];
  const push = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  if (/\/chat\/completions$/i.test(base)) {
    push(base);
    return out;
  }
  push(`${base}/chat/completions`);
  if (!/\/v\d+$/i.test(base)) push(`${base}/v1/chat/completions`);
  return out;
}

/** 站点根地址，用于申请 host 权限。 */
export function originPattern(apiBase) {
  let base = String(apiBase || '').trim();
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return '';
  }
}

export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return '••••••';
  return `${s.slice(0, 5)}••••••${s.slice(-4)}`;
}
