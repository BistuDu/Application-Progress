#!/usr/bin/env node
/**
 * 自检脚本：在 Node 里用 chrome API 的极简替身跑通核心链路
 *   vision 识别 → 记录构造 → 统计 → 导出 → 导入去重
 *
 * 用法：
 *   node scripts/selftest.mjs --from-zcode           # 从 ~/.zcode/v2/config.json 里找 deepseek-flash 的 key
 *   JDT_API_KEY=sk-xxx node scripts/selftest.mjs
 *   node scripts/selftest.mjs --image ./shot.jpg     # 用自己的截图测试
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

/* ---------------- chrome.storage 替身 ---------------- */
const memory = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key == null) return { ...memory };
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (k in memory) out[k] = memory[k];
        return out;
      },
      async set(obj) {
        Object.assign(memory, obj);
      },
      async remove(key) {
        delete memory[key];
      },
    },
  },
};

const { DEFAULT_SETTINGS } = await import(path.join(ROOT, 'src/lib/settings.js'));
const { chatUrlCandidates, originPattern, statusColor } = await import(path.join(ROOT, 'src/lib/settings.js'));
const { analyzeScreenshot, extractJson, isEffectivelyEmpty, normalizeResult, testConnection } = await import(
  path.join(ROOT, 'src/lib/vision.js'),
);
const { addRecord, computeStats, findDuplicates, listRecords, mergeImport, toCsv, toMarkdown, toExportJson, updateRecord } = await import(
  path.join(ROOT, 'src/lib/store.js')
);
const { fmtDate, siteFromUrl, extractSkills } = await import(path.join(ROOT, 'src/lib/util.js'));

/* ---------------- 参数 ---------------- */
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? true;
};

function readZcodeKey() {
  const p = path.join(os.homedir(), '.zcode/v2/config.json');
  if (!fs.existsSync(p)) return null;
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  let found = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || found) return;
    if (o.options?.apiKey && o.models && Object.keys(o.models).some((m) => /deepseek-flash/i.test(m))) {
      found = { apiKey: o.options.apiKey, apiBase: o.options.baseURL };
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(cfg);
  return found;
}

let apiKey = process.env.JDT_API_KEY || '';
let apiBase = process.env.JDT_API_BASE || DEFAULT_SETTINGS.apiBase;
let model = process.env.JDT_MODEL || DEFAULT_SETTINGS.model;

if (!apiKey && args.includes('--from-zcode')) {
  const found = readZcodeKey();
  if (found) {
    apiKey = found.apiKey;
    apiBase = process.env.JDT_API_BASE || found.apiBase || apiBase;
    console.log(`· 已从 ZCode 配置读取密钥（端点 ${apiBase}）`);
  } else {
    console.log('· 没在 ZCode 配置里找到 deepseek-flash 的密钥');
  }
}

const settings = { ...DEFAULT_SETTINGS, apiKey, apiBase, model };

/* ---------------- 断言 ---------------- */
let pass = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------- 纯函数测试 ---------------- */
console.log('\n[1] URL 归一化与来源识别');
check('根地址补 /chat/completions', chatUrlCandidates('https://api.deepseek.com')[0] === 'https://api.deepseek.com/chat/completions');
check('带 v1 的地址不重复补', chatUrlCandidates('https://api.deepseek.com/v1')[0] === 'https://api.deepseek.com/v1/chat/completions');
check('完整地址原样使用', chatUrlCandidates('https://x.cc/v1/chat/completions').length === 1);
check('缺协议自动补 https', chatUrlCandidates('api.deepseek.com')[0].startsWith('https://'));
check('权限域名为站点根', originPattern('https://api.deepseek.com/v1') === 'https://api.deepseek.com/*');
check('BOSS直聘识别', siteFromUrl('https://www.zhipin.com/job_detail/abc.html') === 'BOSS直聘');
check('牛客识别', siteFromUrl('https://www.nowcoder.com/job/1') === '牛客网');

console.log('\n[2] JSON 抽取容错');
check('直接 JSON', extractJson('{"a":1}')?.a === 1);
check('代码块围栏', extractJson('```json\n{"a":2}\n```')?.a === 2);
check('前后有解释文字', extractJson('好的，结果如下：{"a":3} 完毕')?.a === 3);
check('嵌套对象', extractJson('前言 {"a":{"b":[1,2]}} 后语')?.a?.b?.[1] === 2);
check('字符串里的大括号', extractJson('{"a":"x{y}z"}')?.a === 'x{y}z');
check('非法输入返回 null', extractJson('完全不是 JSON') === null);

console.log('\n[3] 结果归一化');
const norm = normalizeResult(
  {
    is_job: true,
    company_name: '某某科技',
    position: '测试开发实习生',
    city: '杭州',
    jd: '负责自动化测试脚本开发，熟悉 Python 与 MySQL。',
    skills: ['Python', 'pytest'],
  },
  { pageTitle: '测试开发 - 某站', sourceUrl: 'https://www.zhipin.com/x' },
);
check('别名字段 company_name 生效', norm.company === '某某科技');
check('别名字段 position 生效', norm.title === '测试开发实习生');
check('别名字段 city 生效', norm.location === '杭州');
check('技能自动补充词典命中', norm.skills.includes('MySQL'));
check('来源站点自动推导', norm.sourceSite === 'BOSS直聘');
check('技能词典提取', extractSkills('熟悉 Java、Redis 和 Kafka').length >= 3);

/* ---------------- 空返回重试（打桩 fetch，不联网） ---------------- */
console.log('\n[4] 空返回自动重试');
{
  const realFetch = globalThis.fetch;
  const emptyBody = {
    choices: [{ message: { content: '{"is_job":true,"company":"","title":"","jd":"","requirements":"","skills":[]}' }, finish_reason: 'stop' }],
    model: 'stub',
    usage: { total_tokens: 10 },
  };
  const fullBody = {
    choices: [{ message: { content: '{"is_job":true,"company":"某公司","title":"某岗位","jd":"负责xx","requirements":"要求yy"}' }, finish_reason: 'stop' }],
    model: 'stub',
    usage: { total_tokens: 10 },
  };
  const stub = (bodies) => {
    let calls = 0;
    globalThis.fetch = async () => {
      const body = bodies[Math.min(calls, bodies.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return () => calls;
  };
  const probe = { image: 'data:image/jpeg;base64,AAAA', settings: { ...settings, apiKey: 'sk-stub' } };

  check('isEffectivelyEmpty 识别空返回', isEffectivelyEmpty({ isJob: true, company: '', title: '', jd: '' }) === true);
  check('isEffectivelyEmpty 不误判正常返回', isEffectivelyEmpty({ isJob: true, title: '某岗位' }) === false);
  check('isEffectivelyEmpty 不把"非招聘信息"当空返回', isEffectivelyEmpty({ isJob: false }) === false);

  let calls = stub([emptyBody, fullBody]);
  const out = await analyzeScreenshot(probe);
  check('第一次返回空 → 自动重试', calls() === 2, `请求 ${calls()} 次`);
  check('重试后拿到真实内容', out.result.title === '某岗位', out.result.title);
  check('标记了重试过', out.meta.retriedForEmpty === true);

  calls = stub([emptyBody]);
  const out2 = await analyzeScreenshot(probe);
  check('两次都空 → 不会无限重试', calls() === 2, `请求 ${calls()} 次`);
  check('两次都空时标记 emptyResult', out2.meta.emptyResult === true);

  calls = stub([fullBody]);
  const out3 = await analyzeScreenshot(probe);
  check('正常返回不触发重试', calls() === 1, `请求 ${calls()} 次`);
  check('正常返回不带 emptyResult 标记', !out3.meta.emptyResult);

  globalThis.fetch = async () => new Response('{"error":"invalid api key"}', { status: 401 });
  let threw = '';
  try {
    await analyzeScreenshot(probe);
  } catch (e) {
    threw = e.message;
  }
  check('401 直接报错，不做无意义重试', /API Key/.test(threw), threw);

  globalThis.fetch = realFetch;
}

/* ---------------- 真实接口测试 ---------------- */
console.log('\n[5] 真实接口（截图识别）');
let imageB64 = '';
const customImage = flag('--image');
if (customImage) {
  imageB64 = `data:image/jpeg;base64,${fs.readFileSync(customImage).toString('base64')}`;
  console.log(`· 使用指定截图 ${customImage}`);
} else {
  const sample = path.join(ROOT, 'docs', 'sample-jd.jpg');
  if (fs.existsSync(sample)) {
    imageB64 = `data:image/jpeg;base64,${fs.readFileSync(sample).toString('base64')}`;
    console.log('· 使用内置样例截图 docs/sample-jd.jpg');
  }
}

if (!apiKey) {
  console.log('  ⚠ 未提供 API Key，跳过联网测试（用 --from-zcode 或 JDT_API_KEY=… 重跑）');
} else if (!imageB64) {
  console.log('  ⚠ 没有可用截图，跳过识别测试');
} else {
  try {
    const started = Date.now();
    const { result, meta } = await analyzeScreenshot({
      image: imageB64,
      settings,
      pageTitle: '测试开发工程师（实习）- 招聘',
      pageUrl: 'https://www.zhipin.com/job_detail/test.html',
    });
    const ms = Date.now() - started;
    console.log(`  · ${meta.endpoint} · ${ms} ms · ${meta.usage?.total_tokens ?? '?'} tokens`);
    check('接口返回成功', true);
    check('is_job 为真', result.isJob === true);
    check('识别出岗位名', Boolean(result.title), result.title);
    check('识别出薪资', Boolean(result.salary), result.salary);
    check('JD 正文非空', result.jd.length > 20, `${result.jd.length} 字`);
    check('任职要求非空', result.requirements.length > 20, `${result.requirements.length} 字`);
    check('技能关键词非空', result.skills.length > 0, result.skills.slice(0, 8).join('/'));
    check('公司名未编造（样例图无公司名则为空）', !result.company || result.company.length < 30, result.company || '(空)');

    console.log('\n[6] 落库 · 统计 · 导出');
    const rec = await addRecord(
      {
        company: result.company || '示例公司',
        title: result.title,
        location: result.location,
        salary: result.salary,
        jd: result.jd,
        requirements: result.requirements,
        skills: result.skills,
        status: '已投递',
        appliedAt: Date.now() - 3 * 86400000,
        nextAction: '等待简历筛选',
        sourceUrl: 'https://www.zhipin.com/job_detail/test.html',
        screenshot: imageB64,
        aiRaw: JSON.stringify(result.rawFields),
        aiMeta: { model: meta.model, ms, usage: meta.usage },
      },
      { settings: { ...settings, keepScreenshot: true } },
    );
    check('记录已写入 storage', (await listRecords()).length === 1);
    check('记录带创建时间', typeof rec.createdAt === 'number' && rec.createdAt > 0, fmtDate(rec.createdAt));
    check('初始状态历史已记录', rec.statusHistory?.[0]?.status === '已投递');
    check('来源站点已补全', rec.sourceSite === 'BOSS直聘');
    check('截图已保存', rec.screenshot.startsWith('data:image/jpeg'));

    const dup = findDuplicates(await listRecords(), { company: rec.company, title: rec.title });
    check('重复检测命中同一条', dup.length === 1, `${dup.length} 条`);

    await updateRecord(rec.id, { status: '面试' });
    const after = (await listRecords())[0];
    check('状态可手动修改', after.status === '面试');
    check('状态变化写入时间线', after.statusHistory.length === 2 && after.statusHistory[1].status === '面试');

    const stats = computeStats(await listRecords(), { ...settings, statuses: DEFAULT_SETTINGS.statuses });
    check('统计总数正确', stats.total === 1);
    check('统计本周新增正确', stats.week === 1);
    check('漏斗已推进到面试', stats.funnel.find((f) => f.name === '面试').count === 1);
    check('漏斗未越过面试', stats.funnel.find((f) => f.name === 'Offer').count === 0);
    check('面试率正确', stats.interviewRate === 1);
    check('来源统计命中', stats.sites[0].name === 'BOSS直聘');
    check('状态颜色可取', statusColor('面试', { statuses: DEFAULT_SETTINGS.statuses }) === '#06b6d4');

    const csv = toCsv(await listRecords());
    check('CSV 带 BOM 且含表头', csv.startsWith('\uFEFF') && csv.includes('公司') && csv.includes('示例'));
    const md = toMarkdown(await listRecords(), settings);
    check('Markdown 含状态变化明细', md.includes('状态变化明细') && md.includes('已投递') && md.includes('面试') && md.includes('→'));
    check('Markdown 含岗位详情', md.includes('岗位职责') && md.includes('任职要求'));
    const json = JSON.parse(toExportJson(await listRecords(), settings));
    check('JSON 备份含 records 与状态词表', Array.isArray(json.records) && json.records.length === 1 && Array.isArray(json.statuses));

    const existing = await listRecords();
    const { added, updated, skipped } = mergeImport(existing, [
      json.records[0], // 同 id → 覆盖更新
      { company: result.company || '示例公司', title: result.title }, // 同公司同岗位、无 id → 跳过
      { company: '另一家', title: '前端实习' }, // 新记录 → 新增
    ]);
    check('导入同 id 记录走更新', updated === 1, `updated=${updated}`);
    check('导入同公司同岗位被去重跳过', skipped === 1, `skipped=${skipped}`);
    check('导入新记录被追加', added === 1, `added=${added}`);

    fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'tmp/export-sample.csv'), csv, 'utf8');
    fs.writeFileSync(path.join(ROOT, 'tmp/export-sample.md'), md, 'utf8');
    console.log('  · 导出样例写入 tmp/export-sample.{csv,md}');
  } catch (err) {
    failCount += 1;
    console.log(`  ✗ 识别失败：${err.message}`);
    if (err.detail) console.log(`    detail: ${err.detail}`);
  }
}

console.log(`\n结果：${pass} 项通过，${failCount} 项失败`);
process.exit(failCount ? 1 : 0);
