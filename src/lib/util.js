/**
 * 通用工具函数：时间、文本、来源识别、导出。不依赖 chrome API 的部分可被 Node 直接测试。
 */

export const DAY_MS = 86400000;

export function uid(prefix = 'r') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 把任意时间输入解析成时间戳；失败返回 null。 */
export function toTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const normalized = s.replace(/[./年]/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const t = Date.parse(normalized.length <= 10 ? `${normalized}T00:00:00` : normalized);
  return Number.isNaN(t) ? null : t;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD */
export function fmtDate(ts) {
  const t = toTs(ts);
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm */
export function fmtDateTime(ts) {
  const t = toTs(ts);
  if (!t) return '';
  const d = new Date(t);
  return `${fmtDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / 3分钟前 / 2小时前 / 昨天 / 2026-09-01 */
export function fmtRelative(ts, now = Date.now()) {
  const t = toTs(ts);
  if (!t) return '';
  const diff = now - t;
  if (diff < 0) return fmtDateTime(t);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3600000)} 小时前`;
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return fmtDate(t);
}

/** 某天的 00:00 时间戳 */
export function startOfDay(ts = Date.now()) {
  const d = new Date(toTs(ts) ?? Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周一 00:00 时间戳 */
export function startOfWeek(ts = Date.now()) {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function startOfMonth(ts = Date.now()) {
  const d = new Date(toTs(ts) ?? Date.now());
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** 用于去重比较的规范化键：去掉空格/标点/大小写差异。 */
export function normalizeKey(...parts) {
  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[\s\u3000·、，,。.()（）\[\]【】/\\|_\-—:：;；'"“”‘’!！?？*#]+/g, '');
}

const SITE_RULES = [
  [/zhipin\.com|boss直聘/i, 'BOSS直聘'],
  [/zhaopin\.com/i, '智联招聘'],
  [/51job\.com|yingjiesheng\.com/i, '前程无忧'],
  [/lagou\.com/i, '拉勾'],
  [/liepin\.com/i, '猎聘'],
  [/nowcoder\.com/i, '牛客网'],
  [/shixiseng\.com/i, '实习僧'],
  [/job\.mioffice|mioffice/i, '实习僧'],
  [/linkedin\./i, 'LinkedIn'],
  [/indeed\./i, 'Indeed'],
  [/glassdoor\./i, 'Glassdoor'],
  [/maimai\.cn/i, '脉脉'],
  [/douban\.com/i, '豆瓣'],
  [/bytedance\.com|jobs\.bytedance/i, '字节跳动官网'],
  [/tencent\.com\/careers|join\.qq\.com/i, '腾讯招聘'],
  [/alibaba\.com|talent\.alibaba/i, '阿里招聘'],
  [/meituan\.com/i, '美团招聘'],
  [/kuaishou\.com/i, '快手招聘'],
  [/xiaohongshu\.com/i, '小红书招聘'],
  [/weixin\.qq\.com|mp\.weixin\.qq\.com/i, '微信公众号'],
  [/wo\.cn|weibo\.com/i, '社交平台'],
  [/(zhihu|xiaohongshu)\./i, '社交平台'],
  [/bilibili\.com/i, 'B站'],
];

/** 从 URL 推断招聘来源站点名。 */
export function siteFromUrl(url) {
  if (!url) return '';
  for (const [re, name] of SITE_RULES) {
    if (re.test(url)) return name;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host;
  } catch {
    return '';
  }
}

/** 从页面标题里剥掉站点后缀，留下更可能的公司/岗位信息。 */
export function cleanTitle(title) {
  if (!title) return '';
  return String(title)
    .replace(/[_\-\|｜—]+\s*(BOSS直聘|智联招聘|前程无忧|51job|拉勾|猎聘|牛客网|实习僧|LinkedIn|Indeed|脉脉|Boss直聘)[^_\-|｜—]*$/i, '')
    .trim();
}

/** 提取技能关键词：给统计和筛选用。 */
export const SKILL_DICT = [
  'Java', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Golang', 'C++', 'C#', 'C', 'Rust', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Scala', 'Objective-C', 'Dart', 'Shell', 'Bash', 'MATLAB', 'R',
  'Spring', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'Django', 'Flask', 'FastAPI', 'Tornado', 'Express', 'NestJS', 'Vue', 'React', 'Angular', 'Next.js', 'Nuxt', 'jQuery', 'Webpack', 'Vite', 'Node.js', 'Bun', 'Deno',
  'MySQL', 'PostgreSQL', 'Oracle', 'SQL Server', 'SQLite', 'Redis', 'MongoDB', 'Elasticsearch', 'ClickHouse', 'HBase', 'Kafka', 'RabbitMQ', 'RocketMQ', 'ZooKeeper', 'Hive', 'Spark', 'Flink', 'Hadoop', 'Doris', 'StarRocks',
  'Docker', 'Kubernetes', 'K8s', 'Jenkins', 'Git', 'GitLab', 'CI/CD', 'Linux', 'Nginx', 'Prometheus', 'Grafana', 'ELK',
  'PyTorch', 'TensorFlow', 'PaddlePaddle', 'MindSpore', 'Transformers', 'vLLM', 'CUDA', 'NLP', 'CV', 'LLM', 'RAG', 'Agent', 'Prompt',
  'Pytest', 'JUnit', 'Selenium', 'Appium', 'JMeter', 'Postman', 'Cypress', 'Playwright', 'LoadRunner',
  'HTML', 'CSS', 'Sass', 'Less', 'Tailwind', 'WebGL', 'Three.js', 'Flutter', 'React Native', 'Uni-app', '微信小程序', 'Android', 'iOS',
  'Figma', 'Axure', 'Sketch', 'Photoshop', 'PR', 'AE', 'SQL', 'Excel', 'Tableau', 'Power BI',
  'HTTP', 'TCP/IP', 'WebSocket', 'gRPC', 'RESTful', 'GraphQL', 'JVM', '多线程', '并发', '数据结构', '算法', '计算机网络', '操作系统', '设计模式', '微服务', '分布式', '高并发', '性能优化', 'DevOps',
  'AIGC', '大模型', '机器学习', '深度学习', '推荐系统', '搜索', '数据挖掘', '数据分析', '数据开发', '风控', '支付', '广告', '电商', '供应链',
];

/** 从文本中匹配技能词，返回去重后的列表（保留词典中的写法）。 */
export function extractSkills(text, limit = 30) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const skill of SKILL_DICT) {
    const key = skill.toLowerCase();
    let idx = lower.indexOf(key);
    while (idx !== -1) {
      const before = lower[idx - 1];
      const after = lower[idx + key.length];
      const boundaryOk =
        !/[a-z0-9+#.]/.test(before || '') && !/[a-z0-9+#]/.test(after || '');
      if (boundaryOk || !/^[a-z0-9+#.]+$/i.test(key)) {
        hits.push(skill);
        break;
      }
      idx = lower.indexOf(key, idx + 1);
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncate(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 多地点单行摘要：青岛、济南… -> { short: '青岛 等 6 地', full: 原文 }。 */
export function locationSummary(value) {
  const text = String(value ?? '').trim();
  if (!text) return { short: '—', full: '' };
  const parts = text.split(/[、,，;；/\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { short: text, full: text };
  return { short: `${parts[0]} 等 ${parts.length} 地`, full: text };
}

export function bytesToSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 估算 dataURL 的字节数。 */
export function dataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const i = String(dataUrl).indexOf(',');
  if (i === -1) return 0;
  const b64 = String(dataUrl).slice(i + 1);
  const padding = (b64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** 生成安全的文件名片段。 */
export function safeFileName(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60) || 'export';
}

/** 触发浏览器下载（仅在扩展页面/内容脚本中可用）。 */
export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** CSV 单元格转义。 */
export function csvCell(v) {
  const s = v == null ? '' : String(v).replace(/\r?\n/g, ' ');
  return /[",;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
