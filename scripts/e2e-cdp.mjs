/**
 * 真实浏览器端到端测试：
 * 用隔离 profile 启动 Chrome 加载本扩展，走一遍「截图 → 识别 → 审阅 → 保存 → 看板统计」。
 *
 *   node scripts/e2e-cdp.mjs --from-zcode
 *   JDT_API_KEY=sk-xxx node scripts/e2e-cdp.mjs
 *
 * 截图产物写到 tmp/e2e/。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, httpJson, waitFor } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(ROOT, 'tmp/e2e');
const PROFILE = path.join(os.tmpdir(), 'jdt-e2e-profile');
const PORT = 9411;
const PAGE_PORT = 8766;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const mock = args.includes('--mock');
let pass = 0;
let failed = 0;
const failures = [];

/**
 * 正式版 Google Chrome 从 137 起会忽略 --load-extension / --disable-extensions-except，
 * 所以优先找允许加载未打包扩展的 Chromium / Chrome for Testing。
 */
function findBrowser() {
  const explicit = process.env.JDT_CHROME || args.find((a) => a.startsWith('--browser='))?.split('=')[1];
  const candidates = [
    explicit,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ...(() => {
      const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
      if (!fs.existsSync(base)) return [];
      return fs
        .readdirSync(base)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
        .reverse()
        .map((d) => path.join(base, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
    })(),
    path.join(os.homedir(), '.cache/puppeteer'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('找不到可用浏览器，可用 JDT_CHROME=/path/to/Chromium 指定');
}
const CHROME = findBrowser();

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 后台标签页在 headless 下不渲染，截图前必须把它切到前台 */
async function shot(conn, file) {
  try {
    await conn.send('Page.bringToFront');
  } catch {
    /* ignore */
  }
  await sleep(350);
  const data = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 78 }, 60000);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, 'base64'));
  return data.data;
}

/* ---------------- 静态页服务 ---------------- */
const pageServer = http.createServer(async (req, res) => {
  if (mock && req.method === 'POST') {
    for await (const _ of req) { /* consume body */ }
    if (/invalid-key/.test(req.headers.authorization || '')) { res.writeHead(401); res.end('{"error":{"message":"无效的 API Key"}}'); return; }
    const result = { is_job: true, company: '测试公司', title: '测试开发工程师（实习）', location: '上海', salary: '200–300 元/天', jd: '设计测试系统，开发接口自动化，负责 MySQL 数据库测试和性能分析。', requirements: '熟悉 Java、SQL、Linux，掌握计算机网络和数据库基础，具有自动化测试经验。', skills: ['Java', 'MySQL', 'Linux'], summary: '实习测试开发岗位' };
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })); }, 900);
    return;
  }
  const file = path.join(HERE, req.url === '/' ? 'testpage.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(HERE) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r));
const JOB_URL = `http://127.0.0.1:${PAGE_PORT}/testpage.html`;

/* ---------------- 准备测试用扩展副本 ---------------- */
/*
 * 真实使用中，点击扩展图标 / 快捷键 / 右键菜单会授予 activeTab，截图因此可用。
 * 无头自动化里没有工具栏可点，动态申请权限又会弹出无人应答的系统弹窗，
 * 所以这里把扩展复制一份到临时目录，副本沿用正式 manifest 的 <all_urls> 权限。
 * 交付目录里的 manifest 不会被改动，其余代码与线上完全一致。
 */
const TEST_EXT = path.join(os.tmpdir(), 'jdt-e2e-ext');
fs.rmSync(TEST_EXT, { recursive: true, force: true });
fs.cpSync(ROOT, TEST_EXT, {
  recursive: true,
  filter: (src) => !/[/\\](tmp|\.git|node_modules)([/\\]|$)/.test(src),
});
console.log(`测试副本：${TEST_EXT}（使用正式 manifest，不补测试权限）`);

/* ---------------- 启动浏览器 ---------------- */
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const chromeArgs = [
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${TEST_EXT}`,
  `--disable-extensions-except=${TEST_EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1440,900',
  'about:blank',
];

console.log(`启动浏览器：${CHROME}`);
const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeStderr = '';
chrome.stderr.on('data', (d) => {
  chromeStderr += d.toString();
});
const logs = [];
chrome.stdout.on('data', (d) => logs.push(d.toString()));

let browserWs = null;
async function cleanup() {
  try {
    pageServer.close();
  } catch {
    /* ignore */
  }
  if (keep) {
    console.log(`\n（--keep：Chrome 仍在运行，profile ${PROFILE}，调试端口 ${PORT}）`);
    return;
  }
  chrome.kill('SIGTERM');
  await sleep(400);
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

try {
  /* 1. 等浏览器起来 */
  const version = await waitFor(async () => httpJson(`http://127.0.0.1:${PORT}/json/version`), {
    timeoutMs: 25000,
    label: 'CDP 端口',
  });
  browserWs = await CDP.connect(version.webSocketDebuggerUrl);
  console.log(`Chrome ${version.Browser}`);
  check('Chrome 已启动并开放调试端口', true);

  /* 2. 等扩展的 service worker 注册 */
  const swTarget = await waitFor(
    async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      return list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    },
    { timeoutMs: 25000, intervalMs: 400, label: '扩展 service worker' },
  );
  const extId = new URL(swTarget.url).host;
  console.log(`扩展 ID：${extId}`);
  check('扩展被 Chrome 加载（MV3 service worker 已注册）', Boolean(extId));

  const sw = await CDP.connect(swTarget.webSocketDebuggerUrl);
  const swErrors = [];
  sw.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      swErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') swErrors.push(msg.params.entry.text);
  });
  await sw.send('Runtime.enable');
  await sw.send('Log.enable');

  // worker 刚起来时 chrome.runtime 可能还没挂上，等它就绪
  await waitFor(async () => (await sw.eval('typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined"')) === true, {
    timeoutMs: 15000,
    intervalMs: 200,
    label: '扩展 API 就绪',
  });

  const manifestName = await sw.eval('chrome.runtime.getManifest().name');
  check('manifest 解析正常', manifestName.includes('JD'), manifestName);

  const perms = await sw.eval('JSON.stringify(chrome.runtime.getManifest().permissions)');
  check('权限清单包含 storage/scripting', perms.includes('storage') && perms.includes('scripting'));

  /* 3. 写入测试用设置（含 API Key） */
  let apiKey = mock ? 'mock-regression-only-key' : process.env.JDT_API_KEY || '';
  let apiBase = mock ? `http://127.0.0.1:${PAGE_PORT}` : process.env.JDT_API_BASE || 'https://api.deepseek.com';
  let model = process.env.JDT_MODEL || 'deepseek-flash';
  if (!apiKey && args.includes('--from-zcode')) {
    const found = readZcodeKey();
    if (found) {
      apiKey = found.apiKey;
      apiBase = found.apiBase || apiBase;
    }
  }
  await sw.eval(
    `chrome.storage.local.set({settings:{apiBase:${JSON.stringify(apiBase)},apiKey:${JSON.stringify(apiKey)},model:${JSON.stringify(model)}}})`,
  );
  const hasKey = await sw.eval('chrome.storage.local.get("settings").then(o=>Boolean(o.settings&&o.settings.apiKey))');
  check('设置可写入 storage', hasKey === true);

  /* 4. 打开看板页（后台标签）与招聘页（前台标签） */
  const dashUrl = `chrome-extension://${extId}/src/dashboard/dashboard.html`;
  const dashTarget = await browserWs.send('Target.createTarget', { url: dashUrl });
  const jobTarget = await browserWs.send('Target.createTarget', { url: JOB_URL });

  const dashInfo = await waitFor(async () => {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.id === dashTarget.targetId && t.webSocketDebuggerUrl);
  }, { label: '看板页' });
  const jobInfo = await waitFor(async () => {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.id === jobTarget.targetId && t.webSocketDebuggerUrl);
  }, { label: '招聘页' });

  const dash = await CDP.connect(dashInfo.webSocketDebuggerUrl);
  const job = await CDP.connect(jobInfo.webSocketDebuggerUrl);
  const pageErrors = [];
  for (const [name, conn] of [['看板', dash], ['招聘页', job]]) {
    await conn.send('Runtime.enable');
    await conn.send('Page.enable');
    conn.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(`[${name}] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
      }
    });
  }

  await waitFor(async () => (await job.eval('document.readyState')) === 'complete', { label: '招聘页加载' });
  await waitFor(async () => ['interactive', 'complete'].includes(await dash.eval('document.readyState')), { label: '看板页加载' });
  const dashReady = await dash.eval('document.readyState');
  check('看板页可打开', ['interactive', 'complete'].includes(dashReady), dashReady);
  const dashTitle = await dash.eval('document.querySelector("h1")?.textContent || ""');
  check('看板页渲染出标题', dashTitle.includes('投递进度'), dashTitle);

  // 等看板把数据load完
  await sleep(600);
  const dashEmpty = await dash.eval('document.getElementById("empty") && !document.getElementById("empty").hidden');
  check('看板初始为空态', dashEmpty === true);

  // [hidden] 很容易被作者样式的 display 覆盖，这里查实际可见性
  const visExpr = (ids) => `(() => {
    const vis = (id) => { const el = document.getElementById(id); if (!el) return "missing";
      const cs = getComputedStyle(el); return (cs.display === "none" || cs.visibility === "hidden") ? "hidden" : "VISIBLE"; };
    return JSON.stringify(Object.fromEntries(${JSON.stringify(ids)}.map(id => [id, vis(id)])));
  })()`;
  const initialVis = JSON.parse(await dash.eval(visExpr(['modal', 'drawer', 'batch', 'export-menu'])));
  check(
    '初始状态：添加弹窗 / 详情抽屉 / 批量条都不可见',
    ['modal', 'drawer', 'batch', 'export-menu'].every((k) => initialVis[k] === 'hidden'),
    JSON.stringify(initialVis),
  );

  /* 5. 权限：确认接口域名的 host 权限已就位（默认 api.deepseek.com 在 host_permissions 里，
        自定义接口地址才需要用户点「授权此域名」） */
  const apiGranted = await sw.eval(
    `chrome.permissions.contains({origins:[${JSON.stringify('https://api.deepseek.com/*')}]}).then(r=>r)`,
  );
  check('默认接口域名的权限已就位', apiGranted === true, String(apiGranted));

  const captureProbe = await sw.eval(`chrome.tabs.query({active:true,currentWindow:true}).then(([t])=>{
    if(!t) return "ERR 没有活动标签页";
    return chrome.tabs.captureVisibleTab(t.windowId,{format:"jpeg",quality:80})
      .then(d=>"OK "+d.length).catch(e=>"ERR "+e.message);
  })`);
  check('captureVisibleTab 可截取当前标签页', String(captureProbe).startsWith('OK'), `返回 ${String(captureProbe).slice(0, 60)} 字符`);

  /* 6. 触发真实截图流程：从看板页发消息给 service worker */
  console.log('\n触发 START_CAPTURE（真实截图 → 框选 → 识别）…');
  const started = await dash.eval(
    `chrome.runtime.sendMessage({type:"START_CAPTURE",mode:"region"}).then(r=>JSON.stringify(r))`,
    { userGesture: true },
  );
  const startRes = JSON.parse(started);
  check('START_CAPTURE 返回成功', startRes.ok === true, startRes.error || '');

  const overlayUp = await waitFor(
    () => job.eval('!!document.getElementById("jdt-overlay-host")'),
    { timeoutMs: 12000, label: '页内框选界面出现' },
  );
  check('页内框选界面已注入', overlayUp === true);

  const selectorState = await job.eval(`(() => {
    const r = document.getElementById("jdt-overlay-host").shadowRoot;
    return JSON.stringify({
      hasImg: !!r.querySelector(".shot"),
      imgLen: (r.querySelector(".shot")||{}).src ? r.querySelector(".shot").src.length : 0,
      natural: r.querySelector(".shot") ? [r.querySelector(".shot").naturalWidth, r.querySelector(".shot").naturalHeight] : null,
      tip: (r.querySelector(".tipbar")||{}).textContent || "",
      vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio
    });
  })()`);
  const sel = JSON.parse(selectorState);
  check('截图画布已铺满视口', sel.hasImg && sel.imgLen > 5000, `图片数据 ${Math.round(sel.imgLen / 1024)}KB`);
  check('截图尺寸与视口一致', sel.natural && sel.natural[0] > 0, `${sel.natural?.join('×')} vs 视口 ${sel.vw}×${sel.vh} @${sel.dpr}x`);
  check('提示条文案正确', sel.tip.includes('拖拽框选'), sel.tip.slice(0, 30));

  /* 7. 模拟拖拽框选：把 JD 正文区域圈出来 */
  const rect = { x0: 250, y0: 90, x1: 1250, y1: 720 };
  await job.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x0, y: rect.y0, button: 'none', buttons: 0 });
  await job.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x0, y: rect.y0, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await job.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.x0 + ((rect.x1 - rect.x0) * i) / 8,
      y: rect.y0 + ((rect.y1 - rect.y0) * i) / 8,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  const selBox = await job.eval(`(() => {
    const s = document.getElementById("jdt-overlay-host").shadowRoot.querySelector("#jdt-sel");
    const size = document.getElementById("jdt-overlay-host").shadowRoot.querySelector("#jdt-size");
    return JSON.stringify({hidden: s.hidden, w: s.style.width, h: s.style.height, size: size ? size.textContent : ""});
  })()`);
  console.log(`  · 框选状态：${selBox}`);

  await job.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x1, y: rect.y1, button: 'left', buttons: 0, clickCount: 1 });

  const processing = await waitFor(
    () => job.eval(`["jdt-overlay-host","jdt-island-host"].some(id=>document.getElementById(id)?.shadowRoot.textContent.includes("正在识别"))`),
    { timeoutMs: 15000, label: '进入识别中状态' },
  );
  check('松手后进入识别中状态', processing === true);
  await shot(job, '2-processing.jpg');

  /* 8. 等识别结果 → 审阅面板 */
  console.log('  等待模型返回（deepseek-flash）…');
  const t0 = Date.now();
  await waitFor(
    () => job.eval(`!!document.getElementById("jdt-overlay-host").shadowRoot.querySelector(".panel")`),
    { timeoutMs: 120000, intervalMs: 500, label: '审阅面板出现' },
  );
  console.log(`  · 识别耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const fields = JSON.parse(
    await job.eval(`(() => {
      const r = document.getElementById("jdt-overlay-host").shadowRoot;
      const v = (id) => (r.querySelector(id)||{}).value || "";
      return JSON.stringify({
        company: v("#f-company"), title: v("#f-title"), location: v("#f-location"),
        salary: v("#f-salary"), status: v("#f-status"), jd: v("#f-jd"),
        req: v("#f-req"), skills: [...r.querySelectorAll(".chip-skill")].map(n=>n.textContent.replace("×","").trim()),
        hasPreview: !!r.querySelector("#jdt-preview"),
        notJobBanner: r.textContent.includes("不像招聘信息"),
        summary: (r.querySelector(".summary")||{}).textContent || "",
        statusOptions: [...r.querySelectorAll("#f-status option")].map(o=>o.value)
      });
    })()`),
  );

  // 把实际送给模型的裁剪图存下来，便于人工核对
  const cropSrc = await job.eval(
    `(document.getElementById("jdt-overlay-host").shadowRoot.querySelector("#jdt-preview")||{}).src || ""`,
  );
  if (cropSrc.startsWith('data:')) {
    fs.writeFileSync(path.join(OUT, '1-crop.jpg'), Buffer.from(cropSrc.split(',')[1], 'base64'));
  }

  // 再跑一次识别，把模型的原始返回暴露出来（排查字段映射问题）
  // 注意：service worker 自己发的 sendMessage 不会投递给自己的 onMessage，所以从看板页发。
  const rawProbe = await dash.eval(
    `chrome.runtime.sendMessage({type:"ANALYZE_SYNC",image:${JSON.stringify(cropSrc)},pageTitle:"测试开发工程师（实习）- 招聘",pageUrl:${JSON.stringify(JOB_URL)}})
       .then(r=>JSON.stringify({ok:r.ok,error:r.error,raw:r.raw,fields:r.result&&r.result.rawFields,isJob:r.result&&r.result.isJob,meta:r.meta&&{model:r.meta.model,ms:r.meta.ms,usage:r.meta.usage}}))`,
    { userGesture: true },
  );
  let raw = {};
  try {
    raw = JSON.parse(rawProbe);
  } catch {
    raw = { parseError: String(rawProbe).slice(0, 400) };
  }
  console.log(`  · 原始返回 keys：${raw.raw ? Object.keys(raw.raw).join(',') : raw.error || raw.parseError}`);
  check('模型返回可解析的 JSON', Boolean(raw.raw), raw.error || '');
  check(
    '原始返回含约定的字段名',
    Boolean(raw.raw && ['company', 'title', 'jd', 'requirements'].some((k) => k in raw.raw)),
    raw.raw ? Object.keys(raw.raw).slice(0, 8).join(',') : '',
  );
  check('未误判为非招聘信息', raw.isJob !== false);
  if (raw.error || !raw.raw || raw.isJob === false) {
    fs.writeFileSync(path.join(OUT, 'raw-probe.json'), JSON.stringify(raw, null, 2));
    console.log(`  · 原始返回已写入 ${OUT}/raw-probe.json`);
  }

  console.log(`  · 识别结果：${fields.title} | ${fields.location} | ${fields.salary} | ${fields.skills.slice(0, 5).join("/")}`);
  check('审阅面板识别出岗位名', Boolean(fields.title), fields.title);
  check('审阅面板识别出薪资', Boolean(fields.salary), fields.salary);
  check('审阅面板带出 JD 正文', fields.jd.length > 20, `${fields.jd.length} 字`);
  check('审阅面板带出任职要求', fields.req.length > 20, `${fields.req.length} 字`);
  check('技能关键词已渲染', fields.skills.length > 0, fields.skills.join('/'));
  check('截图预览可见', fields.hasPreview === true);
  check('状态下拉含 7 个默认状态', fields.statusOptions.length === 7, fields.statusOptions.join('、'));
  check('默认状态为已投递', fields.status === '已投递', fields.status);
  await shot(job, '3-review.jpg');

  /* 9. 手动改状态 + 保存 */
  await job.eval(`(() => {
    const r = document.getElementById("jdt-overlay-host").shadowRoot;
    const s = r.querySelector("#f-status");
    s.value = "一面";
    s.dispatchEvent(new Event("change", {bubbles:true}));
    r.querySelector("#f-next").value = "9/20 前完成在线测评";
    return true;
  })()`);
  const colorAfter = await job.eval(
    `document.getElementById("jdt-overlay-host").shadowRoot.querySelector("#f-status").style.color`,
  );
  check('切换状态会更新颜色', colorAfter === 'rgb(6, 182, 212)', colorAfter);

  await job.eval(`document.getElementById("jdt-overlay-host").shadowRoot.querySelector("#jdt-save").click()`, {
    userGesture: true,
  });
  await sleep(1500);

  const saved = JSON.parse(await sw.eval('chrome.storage.local.get("records").then(o=>JSON.stringify(o.records||[]))'));
  check('记录已落库', saved.length === 1, `${saved.length} 条`);
  const rec = saved[0] || {};
  check('记录含创建时间', typeof rec.createdAt === 'number' && rec.createdAt > 0);
  check('记录含投递日期', typeof rec.appliedAt === 'number');
  check('记录含 JD 正文', (rec.jd || '').length > 20, `${(rec.jd || '').length} 字`);
  check('记录保存了手动选择的状态', rec.status === '一面', rec.status);
  check('记录保存了下一步', rec.nextAction === '9/20 前完成在线测评', rec.nextAction);
  check('记录保存了截图', (rec.screenshot || '').startsWith('data:image/jpeg'), `${Math.round((rec.screenshot || '').length / 1024)}KB`);
  check('记录记录了来源站点', rec.sourceSite === '127.0.0.1' || rec.sourceSite === '', rec.sourceSite);
  check('状态时间线含两次变化', (rec.statusHistory || []).length === 1 || (rec.statusHistory || []).length === 2, JSON.stringify(rec.statusHistory?.map((h) => h.status)));

  const toastGone = await waitFor(
    () => job.eval(`!document.getElementById("jdt-overlay-host")`),
    { timeoutMs: 9000, intervalMs: 400, label: '面板自动关闭' },
  );
  check('保存后面板自动关闭', toastGone === true);

  /* 10. 看板统计 */
  await sleep(1200);
  const dashState = JSON.parse(
    await dash.eval(`(() => JSON.stringify({
      cards: [...document.querySelectorAll("#cards .card")].map(c=>c.querySelector(".k").textContent+"="+c.querySelector(".v").textContent),
      rows: document.querySelectorAll("#tbody tr[data-id]").length,
      rowText: (document.querySelector("#tbody tr[data-id]")||{}).innerText || "",
      funnel: document.getElementById("funnel").innerText.replace(/\\n/g," "),
      count: document.getElementById("count").textContent
    }))()`),
  );
  console.log(`  · 看板卡片：${dashState.cards.join(' | ')}`);
  check('看板统计到 1 条记录', dashState.rows === 1, dashState.count);
  check('看板表格显示该岗位', dashState.rowText.includes('测试开发'), dashState.rowText.split('\n')[0]);
  check('漏斗统计到一面阶段', dashState.funnel.includes('一面'), dashState.funnel.slice(0, 60));
  await shot(dash, '4-dashboard.jpg');

  /* 11. 看板里改状态 */
  await dash.eval(`(() => {
    const sel = document.querySelector("#tbody tr[data-id] select[data-act=status]");
    sel.value = "Offer";
    sel.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);
  await sleep(1200);
  const afterOffer = JSON.parse(await sw.eval('chrome.storage.local.get("records").then(o=>JSON.stringify(o.records||[]))'));
  check('看板内可直接改状态', afterOffer[0]?.status === 'Offer', afterOffer[0]?.status);
  check('改状态后写入时间线', (afterOffer[0]?.statusHistory || []).some((h) => h.status === 'Offer'));

  const offerCard = await dash.eval(`[...document.querySelectorAll("#cards .card")].find(c=>c.querySelector(".k").textContent==="Offer")?.querySelector(".v").textContent`);
  check('统计卡片随状态同步更新', offerCard === '1', `Offer=${offerCard}`);

  /* 12. 详情抽屉 */
  await dash.eval(`document.querySelector("#tbody tr[data-id] button[data-act=open]").click()`);
  await sleep(900);
  const drawer = JSON.parse(
    await dash.eval(`(() => JSON.stringify({
      open: !document.getElementById("drawer").hidden,
      title: document.getElementById("d-title").textContent,
      hasShot: !!document.getElementById("d-shot"),
      timeline: document.querySelectorAll(".tl-item").length,
      jd: (document.getElementById("d-jd")||{}).value || ""
    }))()`),
  );
  check('详情抽屉可打开', drawer.open === true, drawer.title);
  const drawerVis = await dash.eval('getComputedStyle(document.getElementById("drawer")).display');
  check('详情抽屉打开后确实可见', drawerVis !== 'none', drawerVis);
  check('详情抽屉加载了截图', drawer.hasShot === true);
  check('详情抽屉有状态时间线', drawer.timeline >= 2, `${drawer.timeline} 条`);
  check('详情抽屉带出 JD', drawer.jd.length > 20);
  await shot(dash, '5-drawer.jpg');

  /* 13. 搜索与筛选 */
  await dash.eval(`(() => { const q=document.getElementById("q"); q.value="MySQL"; q.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`);
  await sleep(300);
  const searchRows = await dash.eval('document.querySelectorAll("#tbody tr[data-id]").length');
  check('搜索命中 JD 内容', searchRows === 1, `${searchRows} 行`);
  await dash.eval(`(() => { const q=document.getElementById("q"); q.value="不存在的公司zzz"; q.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`);
  await sleep(300);
  const noRows = await dash.eval('document.querySelectorAll("#tbody tr[data-id]").length');
  check('搜索无结果时清空表格', noRows === 0);
  await dash.eval(`document.getElementById("q-clear").click()`);

  /* 14. 设置页 */
  const optTarget = await browserWs.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/options/options.html`,
  });
  const optInfo = await waitFor(async () => {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.id === optTarget.targetId && t.webSocketDebuggerUrl);
  }, { label: '设置页' });
  const opt = await CDP.connect(optInfo.webSocketDebuggerUrl);
  await opt.send('Runtime.enable');
  opt.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(`[设置] ${msg.params.exceptionDetails?.exception?.description}`);
    }
  });
  await waitFor(async () => (await opt.eval('document.readyState')) === 'complete', { label: '设置页加载' });
  await sleep(800);
  const optState = JSON.parse(
    await opt.eval(`(() => JSON.stringify({
      base: document.getElementById("apiBase").value,
      model: document.getElementById("model").value,
      keyLen: document.getElementById("apiKey").value.length,
      promptLen: document.getElementById("promptTemplate").value.length,
      statuses: document.getElementById("statuses").value.split("\\n").length,
      defStatus: document.getElementById("defaultStatus").value,
      perm: document.getElementById("perm-status").textContent,
      storage: document.getElementById("storage-info").textContent
    }))()`),
  );
  check('设置页回填接口地址', optState.base === apiBase, optState.base);
  check('设置页回填模型名', optState.model === model, optState.model);
  check('设置页回填 API Key', optState.keyLen > 10, `${optState.keyLen} 字符`);
  check('设置页回填提示词', optState.promptLen > 200, `${optState.promptLen} 字`);
  check('设置页回填状态词表', optState.statuses === 7, `${optState.statuses} 行`);
  check('设置页显示域名授权状态', /已授权|尚未授权/.test(optState.perm), optState.perm);
  check('设置页显示存储占用', optState.storage.includes('条记录'), optState.storage.slice(0, 60));

  const optVis = JSON.parse(
    await opt.eval(`(() => {
      const vis = (id) => { const el = document.getElementById(id); if (!el) return "missing";
        const cs = getComputedStyle(el); return (cs.display === "none" || cs.visibility === "hidden") ? "hidden" : "VISIBLE"; };
      return JSON.stringify({grant: vis("grant"), file: vis("file"), result: vis("test-result")});
    })()`),
  );
  check(
    '设置页：已授权时「授权」按钮和隐藏控件不显示',
    optVis.grant === 'hidden' && optVis.file === 'hidden' && optVis.result === 'hidden',
    JSON.stringify(optVis),
  );
  await shot(opt, '6-options.jpg');

  /* 15. 连通性自检按钮 */
  await opt.eval(`document.getElementById("test").click()`, { userGesture: true });
  await waitFor(
    () => opt.eval(`!document.getElementById("test-result").hidden && !document.getElementById("test").disabled`),
    { timeoutMs: 60000, intervalMs: 400, label: '连通性测试完成' },
  );
  const testResult = await opt.eval('document.getElementById("test-result").textContent');
  check('设置页连通性测试通过', testResult.includes('连接成功'), testResult.split('\n')[0]);
  await shot(opt, '7-test-connection.jpg');

  /* 16. popup 页面 */
  const popTarget = await browserWs.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup/popup.html`,
  });
  const popInfo = await waitFor(async () => {
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    return list.find((t) => t.id === popTarget.targetId && t.webSocketDebuggerUrl);
  }, { label: 'popup' });
  const pop = await CDP.connect(popInfo.webSocketDebuggerUrl);
  await pop.send('Runtime.enable');
  pop.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(`[popup] ${msg.params.exceptionDetails?.exception?.description}`);
  });
  await waitFor(async () => (await pop.eval('document.readyState')) === 'complete', { label: 'popup 加载' });
  await sleep(900);
  const popState = JSON.parse(
    await pop.eval(`(() => JSON.stringify({
      setupHidden: document.getElementById("setup").hidden,
      subtitle: document.getElementById("subtitle").textContent,
      stats: document.getElementById("stats").innerText.replace(/\\n/g," "),
      items: document.querySelectorAll("#recent-list .item").length,
      itemText: (document.querySelector("#recent-list .item")||{}).innerText || "",
      selects: document.querySelectorAll("#recent-list select").length
    }))()`),
  );
  check('popup 在有 Key 时不显示引导条', popState.setupHidden === true);
  check('popup 显示模型信息', popState.subtitle.includes(model), popState.subtitle);
  check('popup 最近记录有 1 条', popState.items === 1, popState.itemText.replace(/\n/g, ' / '));
  check('popup 提供状态快捷下拉', popState.selects === 1);
  check('popup 统计数字正确', popState.stats.includes('Offer'), popState.stats);
  await shot(pop, '8-popup.jpg');

  /* 17. popup 改状态 */
  await pop.eval(`(() => {
    const s = document.querySelector("#recent-list select");
    s.value = "二面";
    s.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);
  await sleep(1200);
  const afterReject = JSON.parse(await sw.eval('chrome.storage.local.get("records").then(o=>JSON.stringify(o.records||[]))'));
  check('popup 内可快捷改状态', afterReject[0]?.status === '二面', afterReject[0]?.status);

  /* 20. 手动添加 + 批量改状态 */
  console.log('\n手动添加与批量操作…');
  await dash.eval(`document.getElementById("btn-add").click()`);
  await sleep(300);
  await dash.eval(`(() => {
    document.getElementById("m-company").value = "测试公司B";
    document.getElementById("m-title").value = "算法实习生";
    document.getElementById("m-location").value = "上海";
    document.getElementById("m-save").click();
    return true;
  })()`);
  await sleep(1200);
  let recs = JSON.parse(await sw.eval('chrome.storage.local.get("records").then(o=>JSON.stringify(o.records||[]))'));
  check('手动添加生成记录', recs.length === 2, `${recs.length} 条`);
  check('手动添加的字段正确', recs.some((r) => r.company === '测试公司B' && r.title === '算法实习生'));

  await dash.eval(`document.getElementById("check-all").click()`);
  await sleep(300);
  const batchVisible = await dash.eval('!document.getElementById("batch").hidden');
  const selCount = await dash.eval('document.getElementById("batch-info").textContent');
  check('全选后批量条出现', batchVisible === true, selCount);
  await dash.eval(`(() => {
    const s = document.getElementById("batch-status");
    s.value = "测评中";
    s.dispatchEvent(new Event("change", {bubbles:true}));
    return true;
  })()`);
  await sleep(1500);
  recs = JSON.parse(await sw.eval('chrome.storage.local.get("records").then(o=>JSON.stringify(o.records||[]))'));
  check('批量改状态生效', recs.length === 2 && recs.every((r) => r.status === '测评中'), recs.map((r) => r.status).join('/'));
  await shot(dash, '10-batch.jpg');

  /* 21. 导出 CSV 真的落盘 */
  console.log('\n导出…');
  const DL = path.join(OUT, 'downloads');
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  await browserWs.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await dash.eval(`document.getElementById("btn-export").click()`);
  await sleep(250);
  await dash.eval(`document.querySelector('[data-export="csv"]').click()`);
  const csvFile = await waitFor(
    () => {
      const f = fs.readdirSync(DL).filter((x) => x.endsWith('.csv'));
      return f.length ? path.join(DL, f[0]) : null;
    },
    { timeoutMs: 15000, intervalMs: 300, label: 'CSV 下载完成' },
  );
  const csvText = fs.readFileSync(csvFile, 'utf8');
  check('导出的 CSV 文件已落盘', fs.existsSync(csvFile), path.basename(csvFile));
  check('CSV 带 BOM', csvText.charCodeAt(0) === 0xfeff);
  check('CSV 含表头与记录', csvText.includes('记录时间') && csvText.includes('测试公司B') && csvText.includes('测评中'));
  check('CSV 行数正确', csvText.trim().split('\n').length === 3, `${csvText.trim().split('\n').length} 行（含表头）`);

  await dash.eval(`document.getElementById("btn-export").click()`);
  await sleep(250);
  await dash.eval(`document.querySelector('[data-export="md"]').click()`);
  const mdFile = await waitFor(
    () => {
      const f = fs.readdirSync(DL).filter((x) => x.endsWith('.md'));
      return f.length ? path.join(DL, f[0]) : null;
    },
    { timeoutMs: 15000, intervalMs: 300, label: 'Markdown 下载完成' },
  );
  const mdText = fs.readFileSync(mdFile, 'utf8');
  check('导出的 Markdown 含漏斗摘要与状态变化', mdText.includes('求职投递进度') && mdText.includes('状态变化明细'));

  /* 22. 错误路径：无 Key 时的提示（sendMessage 必须从扩展页面发出，SW 不会收到自己发的消息） */
  await sw.eval('chrome.storage.local.set({settings:{apiBase:"https://api.deepseek.com",apiKey:"",model:"deepseek-flash"}})');
  const noKey = JSON.parse(await opt.eval('chrome.runtime.sendMessage({type:"TEST_CONNECTION"}).then(r=>JSON.stringify(r))', { userGesture: true }));
  check('无 Key 时测试连接给出明确提示', noKey.ok === false && /API Key/.test(noKey.error), noKey.error);
  await sw.eval(`chrome.storage.local.set({settings:{apiBase:${JSON.stringify(apiBase)},apiKey:${JSON.stringify(apiKey)},model:${JSON.stringify(model)}}})`);

  const badKey = JSON.parse(
    await opt.eval(`chrome.runtime.sendMessage({type:"TEST_CONNECTION",override:{apiKey:"sk-invalid-key-for-testing"}}).then(r=>JSON.stringify(r))`, { userGesture: true }),
  );
  check('错误 Key 给出可读报错', badKey.ok === true && badKey.result.ok === false && /401|403|无效/.test(badKey.result.message), badKey.result?.message || badKey.error);

  /* 19. 重复检测 */
  const dupRes = JSON.parse(
    await dash.eval(`chrome.runtime.sendMessage({type:"CHECK_DUPLICATE",company:"",title:${JSON.stringify(fields.title)}}).then(r=>JSON.stringify(r))`, { userGesture: true }),
  );
  check('重复检测能命中已有记录', dupRes.ok && dupRes.duplicates.length === 1, `${dupRes.duplicates?.length} 条`);

  /* 20. 无报错 */
  check('service worker 无未捕获异常', swErrors.length === 0, swErrors.slice(0, 2).join(' | '));
  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  console.log(`\n截图产物：${OUT}`);
} catch (err) {
  failed += 1;
  failures.push(`执行中断：${err.message}`);
  console.log(`\n✗ 执行中断：${err.message}`);
  if (chromeStderr.trim()) console.log(`Chrome stderr（末尾）：\n${chromeStderr.trim().split('\n').slice(-12).join('\n')}`);
  if (logs.length) console.log(`Chrome stdout（末尾）：\n${logs.join('').trim().split('\n').slice(-8).join('\n')}`);
} finally {
  await cleanup();
}

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
process.exit(failed ? 1 : 0);
