/**
 * 设置项：默认值、读写、状态词表。所有扩展页面与 service worker 共用。
 */

export const SETTINGS_KEY = 'settings';
export const RECORDS_KEY = 'records';

/** 默认状态词表，与 /offer 技能的状态规范保持一致。 */
export const DEFAULT_STATUSES = [
  { name: '已投递', color: '#3b82f6', kind: 'applied', desc: '已提交申请，等待回复' },
  { name: '筛选中', color: '#8b5cf6', kind: 'progress', desc: '简历/笔试筛选中' },
  { name: '测评中', color: '#f59e0b', kind: 'progress', desc: '在线测评或笔试进行中' },
  { name: '面试', color: '#06b6d4', kind: 'progress', desc: '已进入面试环节' },
  { name: 'Offer', color: '#10b981', kind: 'offer', desc: '已收到录用意向' },
  { name: '拒绝/已结束', color: '#ef4444', kind: 'closed', desc: '被拒、流程终止或主动放弃' },
  { name: '待确认', color: '#94a3b8', kind: 'unknown', desc: '信息不足，需要进一步确认' },
];

export const DEFAULT_PROMPT = `你是求职进度管理助手。请阅读这张招聘信息截图，提取结构化信息。
只输出一个 JSON 对象，不要输出解释、markdown 代码块或多余文字。

字段定义：
{
  "is_job": true,
  "company": "公司名称",
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
};

/** 读取设置，缺失字段用默认值补齐。 */
export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  if (!Array.isArray(merged.statuses) || merged.statuses.length === 0) {
    merged.statuses = DEFAULT_STATUSES;
  }
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
    list.find((s) => s.name === name) || {
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
