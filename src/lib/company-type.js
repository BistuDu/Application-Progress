/**
 * 企业性质：常量、归一化、基于公司名的保守建议，以及表单绑定。
 * 只做高置信匹配；无法判断时保持未标注，绝不默认猜成私企。
 */

export const COMPANY_TYPES = [
  { value: '央企', label: '央企', tone: 'central' },
  { value: '国企', label: '国企', tone: 'state' },
  { value: '私企', label: '私企', tone: 'private' },
  { value: '其他', label: '其他', tone: 'other' },
];

export const COMPANY_TYPE_VALUES = COMPANY_TYPES.map((t) => t.value);

/** 央企及其常见简称；宁可少匹配，也不要把地方国企误标成央企。 */
const CENTRAL_SOE_NAMES = [
  '中国石化',
  '中国石油化工',
  '中石化',
  '中国石油',
  '中国石油天然气',
  '中石油',
  '中国海油',
  '中国海洋石油',
  '中海油',
  '国家电网',
  '南方电网',
  '中国华能',
  '中国大唐',
  '中国华电',
  '国家能源集团',
  '国家电投',
  '中国三峡',
  '三峡集团',
  '中国移动',
  '中国电信',
  '中国联通',
  '中国铁塔',
  '中国广电',
  '中国商飞',
  '中国航天',
  '航天科技',
  '航天科工',
  '中国航空工业',
  '中国航发',
  '中国兵器',
  '中国兵器装备',
  '中国电子',
  '中国电科',
  '中国信科',
  '中国普天',
  '中国中车',
  '中国铁建',
  '中国中铁',
  '中国交建',
  '中国建筑',
  '中国电建',
  '中国能建',
  '中国核工业',
  '中核集团',
  '中广核',
  '中国船舶',
  '中远海运',
  '中国远洋',
  '中粮',
  '招商局',
  '华润',
  '中国五矿',
  '中国铝业',
  '中国黄金',
  '中国建材',
  '中国医药',
  '国药',
  '中国旅游',
  '中国中化',
  '中国化工',
  '中国诚通',
  '中国国新',
  '中国保利',
  '中国中煤',
  '中国煤炭',
  '中国稀土',
  '中国有研',
  '中国邮政',
  '中国烟草',
  '中国国航',
  '东方航空',
  '南方航空',
  '中国东航',
  '中国工商银行',
  '中国农业银行',
  '中国银行',
  '中国建设银行',
  '交通银行',
  '中国邮储银行',
  '邮储银行',
  '国家开发银行',
  '中国进出口银行',
  '中国农业发展银行',
  '中储粮',
  '中国盐业',
  '中国节能',
  '中国环保',
  '中国物流',
  '中国安能',
  '中国融通',
  '中国电气装备',
  '中国航油',
  '中国航信',
  '中国航材',
];

/** 常见民营企业；同样只收录高置信名称。 */
const PRIVATE_COMPANY_NAMES = [
  '字节跳动',
  '腾讯',
  '阿里巴巴',
  '蚂蚁集团',
  '美团',
  '京东',
  '百度',
  '网易',
  '小米',
  '华为',
  '拼多多',
  '快手',
  '滴滴',
  '小红书',
  '哔哩哔哩',
  'B站',
  '携程',
  '去哪儿',
  '贝壳',
  '链家',
  '作业帮',
  '猿辅导',
  '好未来',
  '新东方',
  '高途',
  '理想汽车',
  '蔚来',
  '小鹏汽车',
  '比亚迪',
  '宁德时代',
  '大疆',
  '商汤',
  '旷视',
  '科大讯飞',
  '顺丰',
  '三一重工',
  '美的',
  'vivo',
  'OPPO',
  '荣耀',
  '奇虎360',
  '新浪',
  '微博',
  '搜狐',
  '爱奇艺',
  '优酷',
  '芒果TV',
  '得物',
  '唯品会',
  'SHEIN',
  'Shein',
  '米哈游',
  '莉莉丝',
  '叠纸',
  '鹰角',
  '深信服',
  '用友',
  '金蝶',
];

/** 地方国资/城投类名称特征。单独使用「投资集团」太宽，必须带行业或国资词。 */
const LOCAL_SOE_PATTERNS = [
  /(省|市|区|县)(国有|国资|城投|交投|建投|产投|水务|燃气|公交|地铁|轨道|供水|排水|文旅|旅游集团|产业发展|发展集团|投资集团|控股集团)/,
  /城市投资|交通投资|建设投资|产业投资|国有资产|国有资本|水务集团|燃气集团|公共交通|地铁集团|轨道交通|城建集团|交投集团|城投集团|建投集团|产投集团/,
];

const EXPLICIT_PATTERNS = [
  { value: '央企', re: /中央企业|央企|中央直属企业/ },
  { value: '国企', re: /国有企业|国企|国有控股|地方国企|省属国企|市属国企/ },
  { value: '私企', re: /民营企业|私营企业|私企|民营控股/ },
  { value: '其他', re: /外资企业|外企|外商独资|中外合资|合资企业|事业单位/ },
];

/** 把各种写法归一到四个正式值；未知或空值返回空字符串。 */
export function normalizeCompanyType(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, '');
  if (!text) return '';
  if (COMPANY_TYPE_VALUES.includes(text)) return text;
  if (/中央企业|央企|中央直属/.test(text)) return '央企';
  if (/国有企业|国企|国有控股|地方国企|省属|市属/.test(text)) return '国企';
  if (/民营企业|私营企业|私企|民营控股|民营/.test(text)) return '私企';
  if (/外资|外企|合资|外商独资|事业单位|其他/.test(text)) return '其他';
  return '';
}

/** 去掉括号补充、空白和公司后缀，便于和词典别名做包含匹配。 */
export function normalizeCompanyName(value) {
  return String(value ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司|集团|分公司|公司)$/g, '');
}

export function companyTypeLabel(value) {
  const normalized = normalizeCompanyType(value);
  return normalized || '未标注';
}

export function companyTypeTone(value) {
  return COMPANY_TYPES.find((t) => t.value === normalizeCompanyType(value))?.tone || '';
}

/**
 * 返回 { value, reason }：
 * - explicit：截图/模型明确写出的性质
 * - dictionary：命中高置信公司名词典
 * - keyword：命中地方国资关键词
 * - ''：无法判断
 */
export function suggestCompanyType({ company = '', explicitType = '' } = {}) {
  const explicit = normalizeCompanyType(explicitType) || matchExplicit(explicitType);
  if (explicit) return { value: explicit, reason: 'explicit' };

  const name = normalizeCompanyName(company);
  if (!name) return { value: '', reason: '' };

  if (CENTRAL_SOE_NAMES.some((alias) => name.includes(alias))) {
    return { value: '央企', reason: 'dictionary' };
  }
  if (PRIVATE_COMPANY_NAMES.some((alias) => name.includes(alias))) {
    return { value: '私企', reason: 'dictionary' };
  }
  if (LOCAL_SOE_PATTERNS.some((re) => re.test(name))) {
    return { value: '国企', reason: 'keyword' };
  }
  return { value: '', reason: '' };
}

function matchExplicit(value) {
  const text = String(value ?? '');
  if (!text.trim()) return '';
  for (const item of EXPLICIT_PATTERNS) {
    if (item.re.test(text)) return item.value;
  }
  return '';
}

/**
 * 把公司输入框、企业性质下拉和建议提示绑定在一起。
 * 用户手动改过 select 后，后续公司名变化不再覆盖其选择。
 */
export function bindCompanyTypeField({ companyInput, select, hint, initialType = '', explicitType = '' }) {
  if (!select) return { refresh() {}, isTouched: () => false };
  let touched = Boolean(initialType || explicitType);
  let lastReason = touched ? 'explicit' : '';

  const writeHint = (value, reason) => {
    if (!hint) return;
    if (!value) hint.textContent = '未识别，可手动选择';
    else if (reason === 'explicit') hint.textContent = '来自截图';
    else if (reason === 'dictionary') hint.textContent = '根据公司名建议，可修改';
    else if (reason === 'keyword') hint.textContent = '根据公司名关键词建议，可修改';
    else hint.textContent = '手动选择';
  };

  const suggest = () => {
    if (touched) return;
    const result = suggestCompanyType({ company: companyInput?.value || '', explicitType });
    select.value = result.value;
    lastReason = result.reason;
    writeHint(result.value, result.reason);
  };

  const initial = normalizeCompanyType(initialType || explicitType);
  if (initial) select.value = initial;
  writeHint(select.value, lastReason);

  companyInput?.addEventListener('input', suggest);
  companyInput?.addEventListener('blur', suggest);
  select.addEventListener('change', () => {
    touched = true;
    lastReason = 'manual';
    writeHint(select.value, lastReason);
  });

  return {
    refresh: suggest,
    isTouched: () => touched,
    setTouched(value) {
      touched = Boolean(value);
    },
  };
}
