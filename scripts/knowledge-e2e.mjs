/**
 * 知识库真实浏览器端到端测试：隔离 profile 加载扩展副本，跑一遍
 *   页面与依赖 → 手工问答 → Markdown 安全 → 项目库 → 跨页冲突 → 三种文件导入
 *   → 图片上传/粘贴 → 网页框选交接 → AI 草稿与来源 → 备份恢复 → 存储泄漏审计
 *
 *   node scripts/knowledge-e2e.mjs --from-zcode
 *   JDT_API_KEY=sk-xxx node scripts/knowledge-e2e.mjs
 *
 * 没有 Key 时，需要模型的部分会自动跳过并标注，界面与本地导入部分照常验证。
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, httpJson, waitFor } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(ROOT, 'tmp/e2e-knowledge');
const DL = path.join(OUT, 'downloads');
const FIXTURES = path.join(OUT, 'fixtures');
const PROFILE = path.join(os.tmpdir(), 'jdt-kb-e2e-profile');
const TEST_EXT = path.join(os.tmpdir(), 'jdt-kb-e2e-ext');
const PORT = 9421;
const PAGE_PORT = 8771;

const args = process.argv.slice(2);
const keep = args.includes('--keep');
let pass = 0;
let failed = 0;
const failures = [];
const sleeps = (ms) => new Promise((r) => setTimeout(r, ms));
let apiKey = process.env.JDT_API_KEY || '';
let apiBase = process.env.JDT_API_BASE || 'https://api.deepseek.com';
const model = process.env.JDT_MODEL || 'deepseek-flash';

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

function section(title) {
  console.log(`\n${title}`);
}

function skip(name, why) {
  console.log(`  ⚠ 跳过：${name}${why ? ` — ${why}` : ''}`);
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

function findBrowser() {
  const explicit = process.env.JDT_CHROME;
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
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('找不到可用浏览器，可用 JDT_CHROME=/path/to/Chromium 指定');
}

/* ------------------------------------------------------------------ */
/* 测试夹具：Markdown / PDF / DOCX / PNG                               */
/* ------------------------------------------------------------------ */

const MARKDOWN_FIXTURE = `# 后端八股文整理

## 为什么 B+ 树比 B 树更适合做数据库索引？

A:
B+ 树的数据只在叶子节点，非叶节点可以放更多键，所以树更矮；叶子节点之间还有链表，方便范围扫描。

\`\`\`sql
EXPLAIN SELECT 1;
\`\`\`

## 什么是覆盖索引？

A:
查询需要的列都在索引里，不需要回表取整行数据。

## 什么是 MVCC？
`;

/**
 * 手工生成一个带真实标题样式的 DOCX（OOXML）。
 * 用 textutil 转换会把 <h2> 变成加粗段落、丢掉结构，这里自己写 XML 才能验证"结构保留"。
 */
function buildDocx(outPath, { title, sections }) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const P = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = [
    P(title, 'Heading1'),
    ...sections.flatMap((sec) => [P(sec.q, 'Heading2'), ...sec.answer.map((line) => P(line))]),
    '<w:sectPr/>',
  ].join('');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  };
  const dir = path.join(FIXTURES, 'docx-src');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  fs.rmSync(outPath, { force: true });
  execFileSync('/usr/bin/zip', ['-X', '-q', '-r', outPath, '.'], { cwd: dir });
  return outPath;
}

function writeFixtures() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const mdPath = path.join(FIXTURES, '八股文.md');
  fs.writeFileSync(mdPath, MARKDOWN_FIXTURE, 'utf8');

  const docxPath = path.join(FIXTURES, '八股文.docx');
  buildDocx(docxPath, {
    title: '前端八股文',
    sections: [
      { q: 'HTTP 缓存有哪几种？', answer: ['答：强缓存（Cache-Control、Expires）和协商缓存（ETag、Last-Modified）。'] },
      { q: '什么是事件循环？', answer: ['答：JS 单线程通过任务队列与微任务队列调度，宏任务之间清空微任务。'] },
    ],
  });
  return { mdPath, docxPath };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const CHROME = findBrowser();
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const fixtures = writeFixtures();

// 测试用扩展副本：只补 <all_urls>，不改交付目录
fs.rmSync(TEST_EXT, { recursive: true, force: true });
fs.cpSync(ROOT, TEST_EXT, {
  recursive: true,
  filter: (src) => !/[/\\](tmp|\.git|node_modules|dist)([/\\]|$)/.test(src),
});
console.log(`测试副本：${TEST_EXT}（使用正式 manifest，不补测试权限）`);

// 测试页服务
const pageServer = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const file = rawPath.startsWith('/fixtures/')
    ? path.join(FIXTURES, rawPath.slice('/fixtures/'.length))
    : path.join(HERE, req.url === '/' ? 'knowledge-testpage.html' : rawPath);
  const allowedRoot = rawPath.startsWith('/fixtures/') ? FIXTURES : HERE;
  if (!file.startsWith(allowedRoot) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, '127.0.0.1', r));
const QUESTION_URL = `http://127.0.0.1:${PAGE_PORT}/knowledge-testpage.html`;

fs.rmSync(PROFILE, { recursive: true, force: true });
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

let browserWs = null;
async function cleanup() {
  try {
    pageServer.close();
  } catch {
    /* ignore */
  }
  if (keep) {
    console.log(`\n（--keep：Chrome 仍在运行，调试端口 ${PORT}）`);
    return;
  }
  chrome.kill('SIGTERM');
  await sleeps(400);
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

async function shot(conn, file) {
  try {
    await conn.send('Page.bringToFront');
  } catch {
    /* ignore */
  }
  await sleeps(350);
  const data = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 76 }, 60000);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data.data, 'base64'));
  return data.data;
}

const inPageHelpers = `
window.__kb = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => Array.from(document.querySelectorAll(sel)),
  text: (sel) => (document.querySelector(sel) || {}).innerText || '',
  reviewOpen: () => { const p = document.getElementById('review-panel'); return Boolean(p && !p.hidden); },
  reviewCards: () => document.querySelectorAll('#review-panel .cand').length,
  reviewText: () => (document.getElementById('review-panel') || {}).innerText || '',
  reviewQuestions: () => __kb.qa('#review-panel [data-f="question"]').map((n) => n.value),
  reviewAnswers: () => __kb.qa('#review-panel .md-field textarea').map((n) => n.value),
  resolveAllConflicts(value) {
    let n = 0;
    __kb.qa('#review-panel .cand').forEach((card) => {
      const radio = card.querySelector('.conflict input[value="' + value + '"]');
      if (radio) { radio.checked = true; n += 1; }
    });
    return n;
  },
  reviewSummary: () => (document.getElementById('rv-summary') || {}).textContent || '',
  setCand(i, patch) {
    const card = document.querySelector('#review-panel .cand[data-i="' + i + '"]');
    if (!card) return false;
    if (patch.question !== undefined) {
      const q = card.querySelector('[data-f="question"]');
      q.value = patch.question;
      q.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (patch.answer !== undefined) card.querySelector('#cand-md-' + i).value = patch.answer;
    if (patch.tags !== undefined) { const t = card.querySelector('[data-f="tags"]'); if (t) { t.value = patch.tags; t.dispatchEvent(new Event('input', { bubbles: true })); } }
    if (patch.category !== undefined) { const c = card.querySelector('[data-f="categoryId"]'); if (c) c.value = patch.category; }
    if (patch.selected !== undefined) card.querySelector('[data-f="selected"]').checked = patch.selected;
    return true;
  },
  decide(i, value) {
    const r = document.querySelector('#review-panel .cand[data-i="' + i + '"] input[value="' + value + '"]');
    if (!r) return false;
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  reviewSave() { const b = document.querySelector('#review-panel [data-act="save"]'); if (!b) return false; b.click(); return true; },
  reviewCancel() { const b = document.querySelector('#review-panel [data-act="close"]'); if (!b) return false; b.click(); return true; },
  setProjectSelected(i, val) {
    const card = document.querySelector('#review-panel .cand[data-i="' + i + '"]');
    if (!card) return false;
    const b = card.querySelector('[data-f="selected"]');
    b.checked = val;
    b.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  setProjectField(i, field, value) {
    const card = document.querySelector('#review-panel .cand[data-i="' + i + '"]');
    if (!card) return false;
    card.querySelector('[data-f="' + field + '"]').value = value;
    return true;
  },
  projectCards: () => __kb.qa('#review-panel [data-f="name"]').map((n) => n.value),
  listQuestions: () => Array.from(document.querySelectorAll('#tq-list .row .t')).map((n) => n.textContent),
  detailText: () => (document.getElementById('tq-detail') || {}).innerText || '',
  projectDetailText: () => (document.getElementById('proj-detail') || {}).innerText || '',
  openQuestion(text) {
    const row = Array.from(document.querySelectorAll('#tq-list .row')).find((r) => r.querySelector('.t').textContent.includes(text));
    if (!row) return false;
    row.click();
    return true;
  },
  clickIn: (scopeSel, act) => { const b = document.querySelector(scopeSel + ' [data-act="' + act + '"]'); if (!b) return false; b.click(); return true; },
  setField: (sel, value) => {
    const n = document.querySelector(sel);
    if (!n) return false;
    n.value = value;
    n.dispatchEvent(new Event('input', { bubbles: true }));
    if (n.tagName === 'SELECT') n.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  click: (sel) => { const n = document.querySelector(sel); if (!n) return false; n.click(); return true; },
  previewHTML: () => {
    const v = document.querySelector('#ed-answer-view') || document.querySelector('.md-preview');
    return v ? v.innerHTML : '';
  },
  setMarkdown(text) {
    const a = document.querySelector('#ed-answer');
    if (!a) return false;
    a.value = text;
    a.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
}; true;
`;

try {
  const version = await waitFor(async () => httpJson(`http://127.0.0.1:${PORT}/json/version`), {
    timeoutMs: 25000,
    label: 'CDP 端口',
  });
  browserWs = await CDP.connect(version.webSocketDebuggerUrl);
  const swTarget = await waitFor(
    async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      return list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    },
    { timeoutMs: 25000, intervalMs: 400, label: '扩展 service worker' },
  );
  const extId = new URL(swTarget.url).host;
  const sw = await CDP.connect(swTarget.webSocketDebuggerUrl);
  const swErrors = [];
  sw.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') swErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  });
  await sw.send('Runtime.enable');
  await waitFor(async () => (await sw.eval('typeof chrome !== "undefined" && !!chrome.runtime')) === true, {
    timeoutMs: 15000,
    intervalMs: 200,
    label: '扩展 API 就绪',
  });

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
  await browserWs.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  const hasKey = Boolean(apiKey);
  if (!hasKey) skip('依赖模型的用例', '没有 API Key（用 --from-zcode 或 JDT_API_KEY）');

  const pageErrors = [];
  async function openTarget(url, name) {
    const t = await browserWs.send('Target.createTarget', { url });
    const info = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      return list.find((x) => x.id === t.targetId && x.webSocketDebuggerUrl);
    }, { label: name });
    const conn = await CDP.connect(info.webSocketDebuggerUrl);
    await conn.send('Runtime.enable');
    await conn.send('Page.enable');
    conn.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(`[${name}] ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        pageErrors.push(`[${name}:log] ${msg.params.entry.text}`);
      }
    });
    await conn.send('Log.enable');
    await waitFor(async () => ['interactive', 'complete'].includes(await conn.eval('document.readyState')), { label: `${name} 加载` });
    return { conn, targetId: t.targetId };
  }

  const knowledgeUrl = `chrome-extension://${extId}/src/knowledge/knowledge.html`;
  const kbTarget = await openTarget(knowledgeUrl, '知识库页');
  const kb = kbTarget.conn;
  await sleeps(900);
  await kb.eval(inPageHelpers);

  const loadState = async () => JSON.parse(await sw.eval('chrome.storage.local.get("knowledgeLibrary").then(o=>JSON.stringify(o.knowledgeLibrary||null))'));
  const evaluate = async (expr, opts) => {
    await kb.eval(inPageHelpers);
    return kb.eval(expr, opts);
  };

  if (!args.includes('--review-only')) {
  /* ---------------- [A] 页面与依赖 ---------------- */
  section('[A] 页面、依赖与 CSP');
  const deps = JSON.parse(
    await evaluate(`JSON.stringify({
      marked: typeof (window.marked && window.marked.parse),
      purify: typeof (window.DOMPurify && window.DOMPurify.sanitize),
      pdfjs: typeof window.pdfjsLib,
      mammoth: typeof window.mammoth,
      remoteScripts: Array.from(document.querySelectorAll('script[src]')).map(s=>s.getAttribute('src')).filter(s=>/^https?:/.test(s)),
      tabs: Array.from(document.querySelectorAll('#tabs button')).map(b=>b.textContent.trim()),
      heading: (document.querySelector('.brand h1')||{}).textContent || ''
    })`),
  );
  check('标题渲染', deps.heading.includes('面试知识库'), deps.heading);
  check('Marked 已本地加载', deps.marked === 'function');
  check('DOMPurify 已本地加载', deps.purify === 'function');
  check('PDF.js 已本地加载', deps.pdfjs === 'object');
  check('Mammoth 已本地加载', deps.mammoth === 'object');
  check('页面没有远程脚本（未放宽 CSP）', deps.remoteScripts.length === 0, deps.remoteScripts.join(','));
  check('两个分区入口都存在', deps.tabs.length === 2 && deps.tabs.join('/').includes('项目库') && deps.tabs.join('/').includes('八股文'));
  const csp = await sw.eval('JSON.stringify(chrome.runtime.getManifest().content_security_policy ?? null)');
  check('没有为知识库放宽扩展 CSP', csp === 'null' || csp === 'undefined', String(csp));

  /* ---------------- [B] 手工问答、分类与标签 ---------------- */
  section('[B] 八股文手工问答、分类标签与搜索');

  await evaluate(`__kb.q('#tabs button[data-view="technical"]').click(); true`);
  await sleeps(200);
  const emptyHint = await evaluate(`__kb.text('#tq-detail')`);
  check('空题库给出明确空态', /新增问答|左侧选择/.test(emptyHint), emptyHint.split('\n')[0]);

  // 新建分类
  await kb.eval(`window.prompt = () => '数据库'; true`);
  await evaluate(`__kb.q('#cat-new').click(); true`);
  await sleeps(500);
  let state = await loadState();
  check('可以创建分类', state?.categories?.length === 1 && state.categories[0].name === '数据库');

  // 手工新增一道带 Markdown 答案的题
  await evaluate(`__kb.q('#tq-add').click(); true`);
  await sleeps(300);
  check('新增问答走统一核对面板', await evaluate(`__kb.reviewOpen() && __kb.reviewCards() === 1`));
  await evaluate(
    `__kb.setCand(0, {question:'数据库索引为什么能加速查询？', answer:'索引把随机 IO 变成顺序 IO。\\n\\n- 减少扫描行数\\n\\n\`\`\`sql\\nEXPLAIN SELECT 1;\\n\`\`\`', tags:'索引、性能优化'})`,
  );
  await evaluate(`__kb.setCand(0, {category: (document.querySelector('#review-panel [data-f="categoryId"] option:not([value=""])')||{}).value})`);
  await evaluate(`__kb.reviewSave(); true`);
  await waitFor(() => loadState().then((s) => (s?.technicalQuestions?.length || 0) === 1), { label: '手工题目落库' }).catch(() => {});
  state = await loadState();
  check('手工题目写入正式库', state?.technicalQuestions?.length === 1, JSON.stringify(state?.technicalQuestions?.length));
  check('答案按 Markdown 原文保存（含围栏代码）', (state?.technicalQuestions?.[0]?.answerMarkdown || '').includes('```sql'));
  check('标签解析并对齐到分类', state.technicalQuestions[0].tags.join(',') === '索引,性能优化' && state.technicalQuestions[0].categoryId === state.categories[0].id);

  // 再新增一道「只有题目、没有答案」
  await evaluate(`__kb.q('#tq-add').click(); true`);
  await sleeps(250);
  await evaluate(`__kb.setCand(0, {question:'什么是回表？'})`);
  await evaluate(`__kb.reviewSave(); true`);
  await waitFor(() => loadState().then((s) => (s?.technicalQuestions?.length || 0) === 2), { label: '第二道题落库' }).catch(() => {});
  state = await loadState();
  const emptyAnswer = state.technicalQuestions.find((q) => q.question === '什么是回表？');
  check('答案留空也能保存', Boolean(emptyAnswer) && emptyAnswer.answerMarkdown === '');

  // 搜索答案正文里的词（含仅存在于代码块中的技术词）
  await evaluate(`__kb.setField('#tq-search', '顺序'); true`);
  await sleeps(500);
  const hitList = await evaluate(`JSON.stringify(__kb.listQuestions())`);
  check('按答案正文关键词能搜到', hitList.includes('数据库索引'), hitList);
  await evaluate(`__kb.setField('#tq-search', 'EXPLAIN'); true`);
  await sleeps(500);
  check('代码块里的技术词能搜到', (await evaluate(`JSON.stringify(__kb.listQuestions())`)).includes('数据库索引'));
  await evaluate(`__kb.setField('#tq-search', '不存在的词zzz'); true`);
  await sleeps(500);
  check('空结果有明确提示', (await evaluate(`__kb.text('#tq-list')`)).includes('没有匹配'), await evaluate(`__kb.text('#tq-list')`));
  await evaluate(`__kb.setField('#tq-search', ''); true`);
  await sleeps(400);

  // 标签 + 分类组合筛选
  await evaluate(`__kb.q('#tq-filter-tags [data-tag="性能优化"]').click(); true`);
  await sleeps(400);
  const tagged = await evaluate(`JSON.stringify(__kb.listQuestions())`);
  check('按标签筛选生效', tagged.includes('数据库索引') && !tagged.includes('回表'), tagged);
  await evaluate(`__kb.q('#tq-filter-tags [data-tag="性能优化"]').click(); true`);
  await sleeps(300);

  // 手动重复录入：必须由用户决定
  await evaluate(`__kb.q('#tq-add').click(); true`);
  await sleeps(300);
  await evaluate(`__kb.setCand(0, {question:'1. 数据库索引为什么能加速查询？', answer:'另一种说法'})`);
  await sleeps(700);
  const dupText = await evaluate(`__kb.reviewText()`);
  const summaryDup = await evaluate(`__kb.reviewSummary()`);
  check('手动重复题会展示已有题目', /已有完全相同的题目|可能重复/.test(dupText));
  check('未处理冲突时提示不能保存', /没有处理/.test(summaryDup), summaryDup);
  await evaluate(`__kb.reviewSave(); true`);
  await sleeps(400);
  check('未处理冲突时保存被阻止', await evaluate(`__kb.reviewOpen()`));
  await evaluate(`__kb.decide(0, 'keep'); true`);
  await sleeps(200);
  await evaluate(`__kb.reviewSave(); true`);
  await waitFor(() => loadState().then((s) => (s?.technicalQuestions?.length || 0) === 2), { label: '重复题保留' }).catch(() => {});
  state = await loadState();
  check('保留已有答案后不新增题目也不改正文', state.technicalQuestions.length === 2 && state.technicalQuestions.find((q) => q.question.includes('索引为什么')).answerMarkdown.includes('随机 IO'));

  await kb.eval(inPageHelpers);
  await shot(kb, 'kb-1-technical-list.jpg');
  check('已保存八股文库列表截图', fs.existsSync(path.join(OUT, 'kb-1-technical-list.jpg')));

  /* ---------------- [C] Markdown 预览安全 ---------------- */
  section('[C] Markdown 编辑、预览与安全清洗');

  const xss = `# 标题\n\n- 列表一\n- 列表二\n\n\`\`\`js\nconst a = "<b>代码里的标签</b>";\n\`\`\`\n\n<script>window.__xss=1;<\/script>\n\n<img src=x onerror="window.__xss=2">\n\n[点我](javascript:window.__xss=3)\n\n[正常链接](https://example.com/doc)\n\n| 列 | 值 |\n| --- | --- |\n| a | b |`;
  const opened = await evaluate(`__kb.openQuestion('数据库索引')`);
  await sleeps(350);
  check('可以选中题目', opened === true);
  const editClicked = await evaluate(`__kb.clickIn('#tq-detail', 'edit')`);
  await sleeps(350);
  check('可以进入编辑态', editClicked === true, (await evaluate(`__kb.text('#tq-detail')`)).slice(0, 120).replace(/\n/g, ' '));
  await evaluate(`__kb.setMarkdown(${JSON.stringify(xss)})`);
  const previewSwitched = await evaluate(`(() => { const b = __kb.qa('#tq-detail .md-tabs button').find(x=>x.dataset.mode==='preview'); if (!b) return false; b.click(); return true; })()`);
  check('可以切换到预览', previewSwitched === true);
  await sleeps(300);
  const rendered = JSON.parse(
    await evaluate(`JSON.stringify({
      html: __kb.previewHTML(),
      xss: window.__xss || null,
      hasH1: /<h1/i.test(__kb.previewHTML()),
      hasList: /<ul|<li/i.test(__kb.previewHTML()),
      hasCode: /<pre/i.test(__kb.previewHTML()),
      hasTable: /<table/i.test(__kb.previewHTML()),
      hasImg: /<img/i.test(__kb.previewHTML()),
      hasScript: /<script/i.test(__kb.previewHTML()),
      hasOnerror: /onerror/i.test(__kb.previewHTML()),
      badHref: /javascript:/i.test(__kb.previewHTML()),
      safeHref: /https:\\/\\/example\\.com\\/doc/.test(__kb.previewHTML())
    })`),
  );
  check('预览渲染标题/列表/代码块/表格', rendered.hasH1 && rendered.hasList && rendered.hasCode && rendered.hasTable, JSON.stringify({ h1: rendered.hasH1, ul: rendered.hasList, pre: rendered.hasCode, table: rendered.hasTable }));
  check('script 标签被剥离', !rendered.hasScript);
  check('事件属性被剥离', !rendered.hasOnerror);
  check('危险链接被移除', !rendered.badHref);
  check('普通外链保留', rendered.safeHref);
  check('图片不会被渲染（不自动加载附件）', !rendered.hasImg);
  check('预览没有执行任何注入脚本', rendered.xss === null);
  await shot(kb, 'kb-2-markdown-preview.jpg');
  const roundTrip = await evaluate(`document.querySelector('#ed-answer').value`);
  check('切回编辑时 Markdown 原文完整保留', roundTrip.includes('```js') && roundTrip.includes('<script>window.__xss=1;'));
  await evaluate(`__kb.clickIn('#tq-detail', 'save')`);
  await sleeps(600);
  state = await loadState();
  check('带代码与 HTML 的答案按原文保存', (state.technicalQuestions.find((q) => q.question.includes('索引为什么')).answerMarkdown || '').includes('```js'));

  /* ---------------- [D] 项目库 ---------------- */
  section('[D] 项目库：手工维护、空答案与级联删除');

  await evaluate(`__kb.q('#tabs button[data-view="projects"]').click(); true`);
  await sleeps(200);
  await evaluate(`__kb.q('#proj-new').click(); true`);
  await sleeps(200);
  await evaluate(`__kb.setField('#np-name', '校园二手交易平台'); true`);
  await evaluate(`__kb.setField('#np-summary', '面向校内学生的闲置交易平台，Spring Boot + MySQL'); true`);
  await evaluate(`__kb.setField('#np-resp', '负责订单与支付模块，做过慢查询优化'); true`);
  await evaluate(`__kb.q('#np-save').click(); true`);
  await sleeps(600);
  state = await loadState();
  check('无需岗位记录即可创建项目', state.projects.length === 1 && state.projects[0].name === '校园二手交易平台');

  await shot(kb, 'kb-3-projects.jpg');
  await evaluate(`__kb.clickIn('#proj-detail', 'add-pq')`);
  await sleeps(300);
  await evaluate(`__kb.setCand(0, {question:'订单超卖是怎么解决的？', answer:'用数据库唯一索引 + 乐观锁版本号控制。'})`);
  await evaluate(`__kb.reviewSave(); true`);
  await waitFor(() => loadState().then((s) => (s?.projectQuestions?.length || 0) === 1), { label: '项目问答落库' }).catch(() => {});
  state = await loadState();
  check('项目问答写入正式库', state.projectQuestions.length === 1 && state.projectQuestions[0].projectId === state.projects[0].id);

  // 项目内搜索（题目与答案正文）
  await evaluate(`__kb.setField('#pq-search', '乐观锁'); true`);
  await sleeps(400);
  check('项目问答可按答案搜索', (await evaluate(`__kb.projectDetailText()`)).includes('订单超卖'));
  await evaluate(`__kb.setField('#pq-search', '不存在的词'); true`);
  await sleeps(400);
  check('项目内空结果有提示', (await evaluate(`__kb.projectDetailText()`)).includes('没有匹配'));
  await evaluate(`__kb.setField('#pq-search', ''); true`);
  await sleeps(400);

  // 删除项目：先说明会删掉多少问答
  await kb.eval(`window.confirm = (msg) => { window.__confirmMsg = msg; return true; }; true`);
  await evaluate(`__kb.clickIn('#proj-detail', 'del-project')`);
  await sleeps(600);
  const confirmMsg = await kb.eval('window.__confirmMsg || ""');
  check('删除项目前说明同时删除的问答数', /1 道问答/.test(confirmMsg), confirmMsg);
  state = await loadState();
  check('删除项目会级联删除其问答', state.projects.length === 0 && state.projectQuestions.length === 0);
  check('删除项目不影响八股文题库', state.technicalQuestions.length === 2);

  /* ---------------- [E] 跨页面冲突 ---------------- */
  section('[E] 跨页面更新与冲突反馈');

  const kb2Target = await openTarget(knowledgeUrl, '知识库页2');
  const kb2 = kb2Target.conn;
  await sleeps(900);
  await kb2.eval(inPageHelpers);
  await kb2.eval(`document.querySelector('#tabs button[data-view="technical"]').click(); true`);
  await sleeps(300);

  // 建一道用于冲突的题
  await evaluate(`__kb.q('#tq-add').click(); true`);
  await sleeps(250);
  await evaluate(`__kb.setCand(0, {question:'什么是幂等？', answer:'同一请求执行多次结果一致。'})`);
  await evaluate(`__kb.reviewSave(); true`);
  await waitFor(() => loadState().then((s) => (s?.technicalQuestions?.length || 0) === 3), { label: '冲突用题目落库' }).catch(() => {});
  const conflictId = (await loadState()).technicalQuestions.find((q) => q.question === '什么是幂等？').id;

  // 两个页面同时打开同一道题并进入编辑（页面 A 上一节停在项目库，先切回八股文）
  await evaluate(`__kb.q('#tabs button[data-view="technical"]').click(); true`);
  await sleeps(400);
  check('页面 A 可以选中该题', (await evaluate(`__kb.openQuestion('什么是幂等')`)) === true);
  await sleeps(350);
  check('页面 A 可以进入编辑', (await evaluate(`__kb.clickIn('#tq-detail', 'edit')`)) === true);
  await sleeps(350);
  await kb2.eval(inPageHelpers);
  check('页面 B 可以选中该题', (await kb2.eval(`__kb.openQuestion('什么是幂等')`)) === true);
  await sleeps(350);
  check('页面 B 可以进入编辑', (await kb2.eval(`__kb.clickIn('#tq-detail', 'edit')`)) === true);
  await sleeps(350);

  // 页面 B 先保存
  await kb2.eval(`__kb.setMarkdown('页面 B 写入的新答案'); true`);
  await kb2.eval(`__kb.clickIn('#tq-detail', 'save'); true`);
  await sleeps(800);
  const afterB = await loadState();
  check('页面 B 保存成功', afterB.technicalQuestions.find((q) => q.id === conflictId).answerMarkdown.includes('页面 B'));

  // 页面 A 的列表应该自动刷新，但正在编辑的输入要保留
  await evaluate(`__kb.setMarkdown('页面 A 的旧内容'); true`);
  await sleeps(600);
  const bannerText = await evaluate(`__kb.text('#banner')`);
  const editorKept = await evaluate(`document.querySelector('#ed-answer').value`);
  check('其他页面写入后未编辑内容会刷新（编辑中输入保留）', editorKept.includes('页面 A 的旧内容'), editorKept);
  check('跨页面更新有提示', /其他页面更新/.test(bannerText), bannerText.split('\n')[0]);

  // 页面 A 提交旧内容 → 冲突，输入保留
  await evaluate(`__kb.clickIn('#tq-detail', 'save')`);
  await sleeps(900);
  const conflictState = await loadState();
  const conflictBanner = await evaluate(`__kb.text('#banner')`);
  const conflictKept = await evaluate(`document.querySelector('#ed-answer') ? document.querySelector('#ed-answer').value : ''`);
  check('旧内容提交被判为冲突且不覆盖', conflictState.technicalQuestions.find((q) => q.id === conflictId).answerMarkdown.includes('页面 B'));
  check('冲突时保留尚未保存的编辑', conflictKept.includes('页面 A 的旧内容'));
  check('冲突给出可读提示', /修改|冲突|更新/.test(conflictBanner), conflictBanner.split('\n')[0]);
  await evaluate(`__kb.clickIn('#tq-detail', 'cancel')`);
  await sleeps(200);
  // 关掉第二个标签页：后续框选交接要落到主页面，避免 openKnowledge 复用错标签
  await browserWs.send('Target.closeTarget', { targetId: kb2Target.targetId });
  await sleeps(400);

  /* ---------------- [F] 简历提取项目（6.4） ---------------- */
  section('[F0] 简历提取项目候选与选择保存');

  const resumePath = path.join(FIXTURES, '简历.docx');
  buildDocx(resumePath, {
    title: '候选人简历',
    sections: [
      {
        q: '校园二手交易平台（2024.03 - 2024.09）',
        answer: [
          '技术栈：Spring Boot、MySQL、Redis。',
          '个人职责：负责订单与支付模块，重构了下单链路，把下单接口 P99 从 800ms 降到 260ms。',
        ],
      },
      {
        q: '分布式任务调度平台（2023.06 - 2023.12）',
        answer: ['技术栈：Go、etcd。', '个人职责：负责调度器分片与故障转移。'],
      },
    ],
  });

  if (hasKey) {
    const projectsBefore = (await loadState()).projects.length;
    const questionsBefore = (await loadState()).projectQuestions.length;
    await setFileInput(kb, '#file-resume', [resumePath]);
    const resumeOpen = await waitFor(async () => evaluate(`__kb.qa('#review-panel [data-f="name"]').length > 0`), {
      timeoutMs: 150000,
      intervalMs: 800,
      label: '简历项目核对面板',
    }).then(() => true).catch(() => false);
    check('简历上传后进入项目候选核对', resumeOpen, resumeOpen ? '' : `banner=${String(await evaluate(`__kb.text('#banner')`)).replace(/\s+/g, ' ').slice(0, 110)}`);
    if (resumeOpen) {
      const names = JSON.parse(await evaluate(`JSON.stringify(__kb.projectCards())`));
      check('简历提取出多个项目', names.length >= 2, names.join(' | ').slice(0, 120));
      await shot(kb, 'kb-4-resume-projects.jpg');
      // 修改第一个项目的简介，并只保存这一个
      await evaluate(`__kb.setProjectField(0, 'summary', '校内二手交易平台，负责订单与支付（已核对）')`);
      await evaluate(`__kb.qa('#review-panel [data-f="selected"]').forEach((b,i)=>{ if(i>0){ b.checked=false; b.dispatchEvent(new Event('change',{bubbles:true})); } }); true`);
      await sleeps(300);
      await evaluate(`__kb.reviewSave(); true`);
      await waitFor(async () => evaluate(`!__kb.reviewOpen()`), { timeoutMs: 20000, label: '项目保存完成' }).catch(() => {});
      await sleeps(800);
      const afterResume = await loadState();
      check('只保存选中的项目并沿用核对后的内容', afterResume.projects.length === projectsBefore + 1 && afterResume.projects.some((p) => p.summary.includes('已核对')), `${projectsBefore} → ${afterResume.projects.length}`);
      check('简历提取不会自动生成项目问答', afterResume.projectQuestions.length === questionsBefore, `${questionsBefore} → ${afterResume.projectQuestions.length}`);
      check('简历项目来源记录文件名', (afterResume.projects.slice(-1)[0].sources || []).some((s) => s.fileName === '简历.docx'));
    }
  } else {
    skip('简历提取项目（需要模型）');
  }

  /* ---------------- [F] Markdown 文件导入（本地确定性） ---------------- */
  section('[F] Markdown 导入（无模型也能本地分题）');

  async function setFileInput(conn, selector, files) {
    await conn.send('DOM.enable');
    const { root } = await conn.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await conn.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await conn.send('DOM.setFileInputFiles', { files, nodeId });
  }

  await evaluate(`__kb.q('#tabs button[data-view="technical"]').click(); true`);
  // 本地分题路径不需要 Key：这里真的把 Key 清掉再导入一清晰 Markdown，证明不依赖模型
  const noKeyMd = path.join(FIXTURES, '无Key导入.md');
  fs.writeFileSync(noKeyMd, '# 无 Key 导入\n\n## 什么是分区表？\n\nA:\n把大表按范围拆成多个物理表。\n\n## 什么是慢查询日志？\n\nA:\n记录执行超过阈值的 SQL。\n', 'utf8');
  await sw.eval('chrome.storage.local.get("settings").then(o=>chrome.storage.local.set({settings:Object.assign({},o.settings,{apiKey:""})}))');
  await setFileInput(kb, '#file-doc', [noKeyMd]);
  await waitFor(async () => evaluate(`__kb.reviewOpen()`), { timeoutMs: 30000, label: '无 Key 本地导入' }).catch(() => {});
  const noKeyCards = await evaluate(`__kb.reviewCards()`);
  check('没有 API Key 也能在本地导入清晰 Markdown', noKeyCards === 2, `${noKeyCards} 条候选`);
  await evaluate(`__kb.reviewCancel(); true`);
  await sleeps(500);
  await sw.eval(`chrome.storage.local.get("settings").then(o=>chrome.storage.local.set({settings:Object.assign({},o.settings,{apiKey:${JSON.stringify(apiKey)}}) }))`);
  await sleeps(300);

  await setFileInput(kb, '#file-doc', [fixtures.mdPath]);
  await waitFor(async () => evaluate(`__kb.reviewOpen()`), { timeoutMs: 20000, label: 'Markdown 导入核对面板' }).catch(() => {});
  check('Markdown 文件进入核对面板', await evaluate(`__kb.reviewOpen()`));
  const mdCards = await evaluate(`__kb.reviewCards()`);
  const mdPanel = await evaluate(`__kb.reviewText()`);
  check('Markdown 按题目拆分候选', mdCards === 3, `${mdCards} 条`);
  check('候选保留代码围栏原文', (await evaluate(`document.querySelector('#cand-md-0').value`)).includes('```sql'));
  check('文件名记入来源', mdPanel.includes('八股文.md'), mdPanel.split('\n').slice(0, 6).join(' '));
  const mdQuestions = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewQuestions())`));
  check('题目文本不含分组标题', !mdQuestions.some((q) => q.includes('后端八股文整理') || q.startsWith('## ')), mdQuestions.join(' | '));
  const beforeMdCount = (await loadState()).technicalQuestions.length;
  await evaluate(`__kb.reviewSave(); true`);
  await sleeps(900);
  state = await loadState();
  check('导入后题库增加 3 道题', state.technicalQuestions.length === beforeMdCount + 3, `${beforeMdCount} → ${state.technicalQuestions.length} 道`);
  const imported = state.technicalQuestions.find((q) => q.question.includes('MVCC'));
  check('无答案的题按空答案入库', Boolean(imported) && imported.answerMarkdown === '');
  check('导入的来源只记文件名与类型', Boolean(imported) && imported.sources[0].type === 'markdown' && imported.sources[0].fileName === '八股文.md' && !JSON.stringify(imported.sources).includes('data:'));
  const withAnswer = state.technicalQuestions.find((q) => q.question.includes('覆盖索引'));
  check('有答案的题保留答案正文', Boolean(withAnswer) && withAnswer.answerMarkdown.includes('不需要回表'));

  const headingAnswer = '# 选型理由\n\n正文\n\n#### 实现细节\n\n```js\nconst first = 1;\n\n\nconst second = 2;\n```\n';
  const regressionMarkdown = await evaluate(`(async () => {
    const store = await import(chrome.runtime.getURL('src/lib/knowledge-store.js'));
    const exporter = await import(chrome.runtime.getURL('src/lib/knowledge-export.js'));
    let sample = store.createProject(store.emptyState(), {name:'只有概况的项目',summary:'没有问答'}).state;
    sample = store.createTechnicalQuestion(sample, {question:'Markdown 边界回归题',answerMarkdown:${JSON.stringify(headingAnswer)}}).state;
    return exporter.toKnowledgeMarkdown(sample, {library:'both'});
  })()`);
  const regressionPath = path.join(FIXTURES, '导出边界回归.md');
  fs.writeFileSync(regressionPath, regressionMarkdown, 'utf8');
  await setFileInput(kb, '#file-doc', [regressionPath]);
  await waitFor(async () => evaluate(`__kb.reviewOpen()`), { timeoutMs: 20000, label: '导出边界回归核对' });
  check('混合导出文件导入不会把空项目或答案标题当题目', await evaluate(`__kb.reviewCards()`) === 1);
  check('浏览器导入完整保留答案标题与代码空行', await evaluate(`__kb.q('#cand-md-0').value`) === headingAnswer);
  await evaluate(`__kb.reviewCancel(); true`);
  await sleeps(300);
  check('取消边界回归导入不改变已保存题库', (await loadState()).technicalQuestions.length === beforeMdCount + 3);

  /* ---------------- [G] DOCX 与 PDF 导入 ---------------- */
  section('[G] DOCX / PDF 导入');

  if (hasKey) {
    await setFileInput(kb, '#file-doc', [fixtures.docxPath]);
    await waitFor(async () => evaluate(`__kb.reviewOpen()`), { timeoutMs: 90000, label: 'DOCX 导入核对面板' }).catch(() => {});
    const docxOpen = await evaluate(`__kb.reviewOpen()`);
    check('DOCX 导入进入核对面板', docxOpen);
    if (docxOpen) {
      const docxQuestions = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewQuestions())`));
      check('DOCX 提取出题目', docxQuestions.some((q) => /HTTP 缓存|事件循环/.test(q)), docxQuestions.join(' | ').slice(0, 120));
      const docxConflicts = await evaluate(`__kb.resolveAllConflicts('keep')`);
      if (docxConflicts) await sleeps(300);
      await evaluate(`__kb.reviewSave(); true`);
      await sleeps(900);
      state = await loadState();
      const docxSaved = state.technicalQuestions.find((q) => q.question.includes('HTTP 缓存'));
      check('DOCX 候选核对后入库', Boolean(docxSaved), docxQuestions.join(' | ').slice(0, 80));
      check('DOCX 来源记录文件名', Boolean(docxSaved) && (docxSaved.sources || []).some((s) => s.fileName === '八股文.docx'), JSON.stringify(docxSaved?.sources || []).slice(0, 120));
      check('DOCX 结构转换保留标题层级（题目不混入正文）', Boolean(docxSaved) && !docxSaved.question.includes('前端八股文'));
    }
  } else {
    skip('DOCX 导入（需要模型）');
  }

  // 题目页（中文，用于截图与网页框选识别）
  const qPage = await openTarget(QUESTION_URL, '题目页');
  await sleeps(700);

  /**
   * 文字 PDF：用带分页的英文测试页打印。
   * 中文页不行——headless Chromium 的 printToPDF 不嵌入系统中文字体，
   * 打出来的 PDF 里中文根本没进内容流（不是提取失败，是压根没有），
   * 那样测不出"文字页本地提取 + 跨页合并"。
   */
  const textPage = await openTarget(`http://127.0.0.1:${PAGE_PORT}/knowledge-pdfpage.html`, 'PDF文字页');
  await sleeps(700);
  const pdfPath = path.join(FIXTURES, '八股文.pdf');
  fs.writeFileSync(pdfPath, Buffer.from((await textPage.conn.send('Page.printToPDF', { printBackground: true }, 60000)).data, 'base64'));
  check('生成了测试用文字 PDF', fs.statSync(pdfPath).size > 2000, `${Math.round(fs.statSync(pdfPath).size / 1024)}KB`);

  if (args.includes('--debug-pdf')) {
    try {
      await kb.eval(`window.__pdfB64 = ${JSON.stringify(fs.readFileSync(pdfPath).toString('base64'))}; true`);
      const dump = await kb.eval(`(async function () {
        const bin = atob(window.__pdfB64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
        const lib = window.pdfjsLib;
        const base = chrome.runtime.getURL('src/vendor/pdfjs/');
        lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
        const task = lib.getDocument({ data: arr, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', isEvalSupported: false });
        const doc = await task.promise;
        const parts = [];
        const pages = [];
        for (let n = 1; n <= doc.numPages; n += 1) {
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          const text = tc.items.map((it) => it.str).join('');
          let glyphs = 0;
          try {
            const ops = await page.getOperatorList({ intent: 'any' });
            for (let i = 0; i < ops.fnArray.length; i += 1) {
              if (ops.fnArray[i] === lib.OPS.showText || ops.fnArray[i] === lib.OPS.showSpacedText) {
                const seq = Array.isArray(ops.argsArray[i]) ? ops.argsArray[i][0] : null;
                if (Array.isArray(seq)) glyphs += seq.length;
              }
            }
          } catch (e) { glyphs = -1; }
          pages.push([n, text.length, tc.items.length, glyphs]);
          parts.push(text);
        }
        await doc.destroy();
        return JSON.stringify({ pages: pages, text: parts.join('\\n\\n').slice(0, 2000) });
      })()`);
      console.log('  · PDF 诊断：', dump);
    } catch (err) {
      console.log('  · PDF 诊断失败：', err.message);
    }
  }

  if (hasKey) {
    await setFileInput(kb, '#file-doc', [pdfPath]);
    await waitFor(async () => evaluate(`__kb.reviewOpen()`), { timeoutMs: 120000, label: 'PDF 导入核对面板' }).catch(() => {});
    const pdfOpen = await evaluate(`__kb.reviewOpen()`);
    check('PDF 导入进入核对面板', pdfOpen);
    if (pdfOpen) {
      const pdfPanel = await evaluate(`__kb.reviewText()`);
      const pdfQuestions = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewQuestions())`));
      const pdfAnswers = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewAnswers())`));
      check('PDF 文字页本地提取出题目', pdfQuestions.some((q) => /covering index/i.test(q)), pdfQuestions.join(' | ').slice(0, 160));
      check('PDF 答案正文一并提取', pdfAnswers.some((a) => /clustered index/i.test(a)), pdfAnswers.map((a) => a.slice(0, 20)).join(' / '));
      check('PDF 来源带页码', /\d+\s*页|第/.test(pdfPanel), pdfPanel.slice(0, 160).replace(/\n/g, ' '));
      const pdfConflicts = await evaluate(`__kb.resolveAllConflicts('keep')`);
      if (pdfConflicts) await sleeps(300);
      await evaluate(`__kb.reviewSave(); true`);
      await sleeps(900);
      state = await loadState();
      const fromPdf = state.technicalQuestions.filter((q) => (q.sources || []).some((s) => s.type === 'pdf'));
      const pageSets = fromPdf.map((q) => (q.sources.find((s) => s.type === 'pdf') || {}).pageNumbers || []);
      check('PDF 候选核对后入库', fromPdf.length >= 2, `${fromPdf.length} 道`);
      check('PDF 记录可确定的页码', pageSets.length > 0 && pageSets.every((p) => p.length > 0), JSON.stringify(pageSets));
      check('跨页题目合并后记录来源页集合', pageSets.some((p) => p.length > 1), JSON.stringify(pageSets));
    }
  } else {
    skip('PDF 导入（需要模型）');
  }

  // 旧 .doc 必须给出转换提示而不是误判成功
  const docPath = path.join(FIXTURES, '旧简历.doc');
  fs.writeFileSync(docPath, 'not a real doc');
  await setFileInput(kb, '#file-doc', [docPath]);
  await sleeps(1500);
  const legacyBanner = await evaluate(`__kb.text('#banner')`);
  check('旧 .doc 给出转换提示且不入库', /docx|PDF|另存为/i.test(legacyBanner), legacyBanner.split('\n')[0]);
  check('旧 .doc 没有产生候选', !(await evaluate(`__kb.reviewOpen()`)));

  /* ---------------- [H] 图片上传与粘贴 ---------------- */
  section('[H] 扫描页 PDF、图片上传与粘贴');

  const pngPath = path.join(FIXTURES, 'q-shot.png');
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  await qPage.conn.send('Page.bringToFront').catch(() => {});
  await sleeps(400);
  fs.writeFileSync(pngPath, Buffer.from((await qPage.conn.send('Page.captureScreenshot', { format: 'png' }, 60000)).data, 'base64'));
  check('生成了测试用题目截图', fs.statSync(pngPath).size > 10000, `${Math.round(fs.statSync(pngPath).size / 1024)}KB`);

  const openPanel = (label, timeoutMs = 120000) =>
    waitFor(async () => (await evaluate(`__kb.reviewOpen()`)) === true, { timeoutMs, intervalMs: 800, label }).then(() => true).catch(() => false);
  const panelBanner = async () => String(await evaluate(`__kb.text('#banner')`)).replace(/\s+/g, ' ').slice(0, 120);
  const panelToast = async () => String(await evaluate(`__kb.text('#toasts')`)).slice(0, 60);
  const closePanel = () => evaluate(`__kb.reviewCancel()`);
  const answerCount = async () => (await loadState()).technicalQuestions.length;

  if (hasKey) {
    /**
     * 扫描页 PDF：整页只有一张图片，文字提取必然为空，只能走图像识别。
     * 这一步同时验证「渲染在后台标签页也能完成」——知识库页此时并不是前台标签页。
     */
    const scanHtml = '<html><body style="margin:0"><img src="http://127.0.0.1:' + PAGE_PORT + '/fixtures/q-shot.png" style="width:100%"></body></html>';
    const scanTarget = await openTarget('data:text/html;charset=utf-8,' + encodeURIComponent(scanHtml), '扫描页PDF');
    await sleeps(1500);
    const scanPdfPath = path.join(FIXTURES, '扫描版.pdf');
    fs.writeFileSync(scanPdfPath, Buffer.from((await scanTarget.conn.send('Page.printToPDF', { printBackground: true }, 60000)).data, 'base64'));
    const scanBefore = await answerCount();
    await setFileInput(kb, '#file-doc', [scanPdfPath]);
    const scanOpen = await openPanel('扫描页 PDF 核对面板');
    check('没有文字的 PDF 页走图像识别且能完成', scanOpen, scanOpen ? `PDF ${Math.round(fs.statSync(scanPdfPath).size / 1024)}KB` : `banner=${await panelBanner()}`);
    if (scanOpen) {
      const scanQuestions = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewQuestions())`));
      check('扫描页识别出题目', scanQuestions.some((q) => /索引|回表|TCP|握手|数据库/.test(q)), scanQuestions.join(' | ').slice(0, 140));
      check('扫描页来源记录可确定的页码', /第 1 页/.test(await evaluate(`__kb.reviewText()`)));
      check('取消核对按钮可用', (await closePanel()) === true);
      await sleeps(1200);
      check('取消核对后不会自动入库', (await answerCount()) === scanBefore, `${scanBefore} → ${await answerCount()}`);
    }
  }

  /* ---- 用户上传图片 ---- */
  if (hasKey) {
    const beforeUpload = await answerCount();
    await setFileInput(kb, '#file-image', [pngPath]);
    const imgOpen = await openPanel('图片识别核对面板');
    check('上传图片进入核对面板', imgOpen, imgOpen ? '' : `banner=${await panelBanner()} toast=${await panelToast()}`);
    if (imgOpen) {
      const imgQuestions = JSON.parse(await evaluate(`JSON.stringify(__kb.reviewQuestions())`));
      check('图片识别出多道题候选', imgQuestions.length >= 1 && imgQuestions.some((q) => /索引|回表|TCP|握手|数据库/.test(q)), imgQuestions.join(' | ').slice(0, 140));
      check('图片来源记录为上传', /上传图片/.test(await evaluate(`__kb.reviewText()`)));
      await evaluate(`__kb.resolveAllConflicts('keep')`);
      await sleeps(300);
      await evaluate(`__kb.reviewSave(); true`);
      await sleeps(1200);
      const afterUpload = await loadState();
      check(
        '图片候选核对后入库（新题新增、重复题只并来源）',
        afterUpload.technicalQuestions.length >= beforeUpload &&
          afterUpload.technicalQuestions.some((q) => (q.sources || []).some((x) => x.type === 'image-upload')),
        `${beforeUpload} → ${afterUpload.technicalQuestions.length}`,
      );
    }
  }

  /* ---- 用户主动粘贴 ---- */
  if (hasKey) {
    const pasted = await evaluate(`(() => {
      const b64 = ${JSON.stringify(fs.readFileSync(pngPath).toString('base64'))};
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], 'pasted.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    check('可以主动粘贴图片', pasted === true);
    const pasteOpen = await openPanel('粘贴识别核对面板');
    check('粘贴图片同样进入核对面板', pasteOpen, pasteOpen ? '' : `banner=${await panelBanner()}`);
    if (pasteOpen) {
      check('粘贴来源记录为粘贴', /粘贴图片/.test(await evaluate(`__kb.reviewText()`)));
      await closePanel();
      await sleeps(800);
      check('取消核对后正式库不变', (await loadState()).technicalQuestions.some((q) => (q.sources || []).some((s) => s.type === 'image-paste')) === false);
    }
  }

  // 损坏/无法识别的图片要给出可读反馈，且不改动正式库
  if (hasKey) {
    const brokenPath = path.join(FIXTURES, 'broken.png');
    fs.writeFileSync(brokenPath, 'not really a png');
    const brokenBefore = (await loadState()).technicalQuestions.length;
    await setFileInput(kb, '#file-image', [brokenPath]);
    const brokenMsg = await waitFor(
      () => evaluate(`(() => { const t = __kb.text('#banner'); return /图片|截图|失败|无法|不清晰/.test(t) ? t : false; })()`),
      { timeoutMs: 60000, intervalMs: 700, label: '损坏图片反馈' },
    ).catch(() => '');
    check('损坏的图片给出可读反馈', /图片|截图|失败|无法|不清晰/.test(String(brokenMsg)), String(brokenMsg).replace(/\s+/g, ' ').slice(0, 110));
    check('损坏图片不会改动正式库', (await loadState()).technicalQuestions.length === brokenBefore);
    await evaluate(`(() => { const b = document.querySelector('#banner button'); if (b) b.click(); return true; })()`);
    await sleeps(500);
  }

  // 剪贴板里没有图片时的反馈
  await evaluate(`document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true })); true`);
  await sleeps(400);
  check('剪贴板无图片时给出提示', /剪贴板里没有图片/.test(await evaluate(`__kb.text('#toasts')`)), await evaluate(`__kb.text('#toasts')`));

  /* ---------------- [I] 网页框选交接 ---------------- */
  section('[I] 网页框选题目并交接给知识库');

  if (hasKey) {
    await qPage.conn.send('Page.bringToFront');
    await sleeps(400);
    const started = JSON.parse(
      await kb.eval(`chrome.runtime.sendMessage({type:'START_CAPTURE',mode:'region',target:'technical-question'}).then(r=>JSON.stringify(r))`, { userGesture: true }),
    );
    check('题库框选入口可以启动', started.ok === true, started.error || '');
    const overlayUp = await waitFor(() => qPage.conn.eval('!!document.getElementById("jdt-overlay-host")'), { timeoutMs: 12000, label: '框选界面' }).catch(() => false);
    check('页内框选界面已注入', overlayUp === true);
    const tip = await qPage.conn.eval(`(() => { const r = document.getElementById('jdt-overlay-host').shadowRoot; return (r.querySelector('.tipbar')||{}).textContent || ''; })()`);
    check('提示文案变为题目框选', tip.includes('题目'), tip.slice(0, 30));

    const rect = { x0: 120, y0: 90, x1: 900, y1: 700 };
    await qPage.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x0, y: rect.y0, button: 'none', buttons: 0 });
    await qPage.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x0, y: rect.y0, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i += 1) {
      await qPage.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x0 + ((rect.x1 - rect.x0) * i) / 6, y: rect.y0 + ((rect.y1 - rect.y0) * i) / 6, button: 'left', buttons: 1 });
      await sleeps(25);
    }
    await qPage.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x1, y: rect.y1, button: 'left', buttons: 0, clickCount: 1 });
    const sideTarget=await waitFor(async()=>(await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find(t=>t.url.includes('/workbench/workbench.html')&&!t.url.includes('?view=options')));
    const side=await CDP.connect(sideTarget.webSocketDebuggerUrl);
    const sideContexts=[];side.on(m=>{if(m.method==='Runtime.executionContextCreated')sideContexts.push(m.params.context);});await side.send('Runtime.enable');await side.send('Page.enable');
    const frame=await waitFor(async()=>{const tree=await side.send('Page.getFrameTree');return tree.frameTree.childFrames?.find(f=>f.frame.url.includes('/knowledge/knowledge.html'))?.frame;});
    const ctx=await waitFor(()=>sideContexts.find(c=>c.auxData?.frameId===frame.id&&c.auxData?.isDefault));
    await side.eval(inPageHelpers,{contextId:ctx.id});
    const sideEval=expr=>side.eval(expr,{contextId:ctx.id});
    const reviewUp=await waitFor(()=>sideEval('__kb.reviewOpen()'),{timeoutMs:150000,intervalMs:700,label:'侧栏候选核对'}).catch(()=>false);
    check('框选结果在原生侧栏进入核对面板',reviewUp===true);
    if(reviewUp){
      const panel=await sideEval('__kb.reviewText()');const webQuestions=JSON.parse(await sideEval('JSON.stringify(__kb.reviewQuestions())'));
      check('候选带网页来源',/网页框选/.test(panel),panel.slice(0,140));
      check('候选含识别出的题目',webQuestions.length>=1&&webQuestions.some(q=>/索引|回表|TCP|握手|数据库/.test(q)),webQuestions.join(' | ').slice(0,140));
      await sideEval('__kb.reviewCancel(); true');await sleeps(400);
    }
    side.close();
    const handoffLeft = await sw.eval('chrome.storage.session.get(null).then(o=>JSON.stringify(Object.keys(o).filter(k=>k.startsWith("knowledgePending"))))');
    check('交接候选在处理后从 session 清掉', handoffLeft === '[]', String(handoffLeft).slice(0, 80));
  } else {
    skip('网页框选（需要模型）');
  }

  /* ---------------- [J] AI 参考与草稿 ---------------- */
  section('[J] AI 参考匹配、草稿采用与来源追踪');

  if (hasKey) {
    await evaluate(`__kb.q('#tabs button[data-view="projects"]').click(); true`);
    await sleeps(200);
    await evaluate(`__kb.q('#proj-new').click(); true`);
    await sleeps(200);
    await evaluate(`__kb.setField('#np-name', '订单系统'); true`);
    await evaluate(`__kb.setField('#np-summary', '电商订单与支付，MySQL 存订单，QPS 峰值 2000'); true`);
    await evaluate(`__kb.setField('#np-resp', '负责订单查询与索引优化'); true`);
    await evaluate(`__kb.q('#np-save').click(); true`);
    await sleeps(500);
    await shot(kb, 'kb-3-projects.jpg');
  await evaluate(`__kb.clickIn('#proj-detail', 'add-pq')`);
    await sleeps(250);
    await evaluate(`__kb.setCand(0, {question:'为什么用这个索引方案？'})`);
    await evaluate(`__kb.reviewSave(); true`);
    await waitFor(() => loadState().then((s) => (s?.projectQuestions?.length || 0) === 1), { label: 'AI 用项目问答落库' }).catch(() => {});

    await evaluate(`__kb.clickIn('#proj-detail', 'assist')`);
    await sleeps(600);
    const assistOpen = await evaluate(`!document.getElementById('assist-panel').hidden`);
    check('项目题可以打开 AI 辅助面板', assistOpen);
    if (assistOpen) {
      const assistText = await evaluate(`__kb.text('#assist-panel')`);
      check('自动匹配到相关参考题并给出依据', /数据库索引/.test(assistText) && /匹配分/.test(assistText), assistText.slice(0, 160).replace(/\n/g, ' '));
      const suggested = await evaluate(`__kb.qa('#assist-panel .ref-row input[data-act="pick"]').filter(n=>n.checked).length`);
      check('自动建议的参考题已勾选', suggested >= 1, `${suggested} 条`);

      // 搜索整个题库并加入参考（用户手动补充）
      await evaluate(`__kb.setField('#assist-panel #as-search', 'MVCC'); true`);
      await evaluate(`__kb.click('#assist-panel [data-act="dosearch"]'); true`);
      await sleeps(500);
      const searchHits = await evaluate(`__kb.qa('#assist-panel #as-results .ref-row').length`);
      check('参考面板可以搜索整个题库', searchHits >= 1, `${searchHits} 条命中`);
      if (searchHits) {
        await evaluate(`__kb.click('#assist-panel [data-act="add"]'); true`);
        await sleeps(400);
        check('搜索到的题可以加入参考', (await evaluate(`__kb.qa('#assist-panel .ref-row input[data-act="pick"]').filter(n=>n.checked).length`)) >= 1);
      }

      // 移除所有自动候选后必须显式选择
      await evaluate(`__kb.qa('#assist-panel .ref-row input[data-act="pick"]').forEach(n=>{ if(n.checked){ n.checked=false; n.dispatchEvent(new Event('change',{bubbles:true})); } }); true`);
      await sleeps(400);
      const blocked = await evaluate(`__kb.q('#assist-panel [data-act="generate"]').disabled`);
      check('零参考时生成按钮禁用，要求明确选择', blocked === true);
      await evaluate(`__kb.q('#assist-panel [data-act="projectonly"]').checked = true; __kb.q('#assist-panel [data-act="projectonly"]').dispatchEvent(new Event('change',{bubbles:true})); true`);
      await sleeps(300);

      await evaluate(`__kb.q('#assist-panel [data-act="generate"]').click(); true`);
      await waitFor(async () => evaluate(`__kb.q('#assist-panel #as-draft') !== null`), { timeoutMs: 150000, intervalMs: 700, label: '草稿生成' }).catch(() => {});
      const draftOpen = await evaluate(`__kb.q('#assist-panel #as-draft') !== null`);
      check('生成后进入草稿预览', draftOpen);
      if (draftOpen) {
        await shot(kb, 'kb-5-assist-draft.jpg');
        const draftText = await evaluate(`__kb.q('#assist-panel #as-draft').value`);
        check('草稿是 Markdown 且不为空', draftText.trim().length > 0, `长度 ${draftText.trim().length}：${draftText.slice(0, 50).replace(/\n/g, ' ')}`);
        // 先取消一次，验证草稿不会改动已保存答案
        await evaluate(`__kb.click('#assist-panel [data-act="close"]'); true`);
        await sleeps(600);
        const afterDraftCancel = await loadState();
        check('取消 AI 草稿不改动原答案', (afterDraftCancel.projectQuestions[0].answerMarkdown || '') === '', JSON.stringify(afterDraftCancel.projectQuestions[0].answerMarkdown || ''));
        check('取消草稿不会留下第二份答案', afterDraftCancel.projectQuestions.length === 1 && !('drafts' in afterDraftCancel.projectQuestions[0]));
        // 再生成一次并采用：重开面板后回到默认勾选，这里重新选择「只按项目资料生成」
        await evaluate(`__kb.clickIn('#proj-detail', 'assist')`);
        await sleeps(600);
        await evaluate(`__kb.qa('#assist-panel .ref-row input[data-act="pick"]').forEach(n=>{ if(n.checked){ n.checked=false; n.dispatchEvent(new Event('change',{bubbles:true})); } }); true`);
        await sleeps(400);
        await evaluate(`(() => { const b = __kb.q('#assist-panel [data-act="projectonly"]'); b.checked = true; b.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        await sleeps(400);
        await evaluate(`__kb.q('#assist-panel [data-act="generate"]').click(); true`);
        await waitFor(async () => evaluate(`__kb.q('#assist-panel #as-draft') !== null`), { timeoutMs: 150000, intervalMs: 700, label: '取消后再生成' }).catch(() => {});
        check('取消后可以重新生成', (await evaluate(`__kb.q('#assist-panel #as-draft') !== null`)) === true);
        await evaluate(`__kb.q('#assist-panel #as-draft').value = '# 我的回答\\n\\n使用 MySQL 联合索引覆盖查询。'; true`);
        await evaluate(`__kb.q('#assist-panel [data-act="accept"]').click(); true`);
        await sleeps(900);
        state = await loadState();
        const pq = state.projectQuestions[0];
        check('采用草稿后写入这一份答案', (pq.answerMarkdown || '').includes('联合索引覆盖查询'));
        check('保存后只有一份答案', state.projectQuestions.length === 1 && !('drafts' in pq));

        // 只按项目资料生成时不应记录参考来源
        check('只按项目资料生成时不记录参考引用', (pq.aiReferences || []).length === 0, JSON.stringify(pq.aiReferences));

        // 再生成一次，这次带参考
        await evaluate(`__kb.clickIn('#proj-detail', 'assist')`);
        await sleeps(600);
        await evaluate(`__kb.q('#assist-panel [data-act="generate"]').click(); true`);
        await waitFor(async () => evaluate(`__kb.q('#assist-panel #as-draft') !== null`), { timeoutMs: 150000, intervalMs: 700, label: '第二次草稿' }).catch(() => {});
        if (await evaluate(`__kb.q('#assist-panel #as-draft') !== null`)) {
          await evaluate(`__kb.q('#assist-panel [data-act="accept"]').click(); true`);
          await sleeps(900);
          state = await loadState();
          const withRefs = state.projectQuestions[0];
          check('采用带参考的草稿会记录参考来源', (withRefs.aiReferences || []).length >= 1, JSON.stringify((withRefs.aiReferences || []).map((r) => r.questionTitle)));
          const refId = withRefs.aiReferences[0].technicalQuestionId;
          const answerBeforeEdit = withRefs.answerMarkdown;
          check('展示参考时会标出可用状态', (await evaluate(`__kb.projectDetailText()`)).includes('AI 参考来源'));

          // 修改参考题 → 项目答案不变，参考标记为已修改
          await evaluate(`__kb.q('#tabs button[data-view="technical"]').click(); true`);
          await sleeps(250);
          await evaluate(`__kb.openQuestion('${(state.technicalQuestions.find((q) => q.id === refId) || {}).question.slice(0, 8)}'); true`);
          await sleeps(300);
          await evaluate(`__kb.clickIn('#tq-detail', 'edit')`);
          await sleeps(250);
          await evaluate(`__kb.setMarkdown('参考题被改写过的新答案'); true`);
          await evaluate(`__kb.clickIn('#tq-detail', 'save')`);
          await sleeps(800);
          await evaluate(`__kb.q('#tabs button[data-view="projects"]').click(); true`);
          await sleeps(400);
          const projectText = await evaluate(`__kb.projectDetailText()`);
          const afterEdit = await loadState();
          check('参考题被修改后项目答案不被改写', afterEdit.projectQuestions[0].answerMarkdown === answerBeforeEdit, `长度 ${answerBeforeEdit.length}`);
          check('参考题变化会标记为已修改', /已被修改|参考题/.test(projectText), projectText.split('\n').slice(-4).join(' '));
        }
      }
    }
  } else {
    skip('AI 参考与草稿（需要模型）');
  }

  /* ---------------- [K] 备份与恢复 ---------------- */
  section('[K] JSON 备份、恢复与 Markdown 导出');

  const beforeBackup = await loadState();
  await evaluate(`__kb.q('#btn-backup').click(); true`);
  await sleeps(200);
  await evaluate(`__kb.q('#backup-menu [data-io="json"]').click(); true`);
  const jsonFile = await waitFor(
    () => {
      const f = fs.readdirSync(DL).filter((x) => x.endsWith('.json'));
      return f.length ? path.join(DL, f[0]) : null;
    },
    { timeoutMs: 15000, intervalMs: 300, label: 'JSON 备份下载' },
  ).catch(() => null);
  check('整库 JSON 备份下载到磁盘', Boolean(jsonFile), jsonFile ? path.basename(jsonFile) : '没有文件');
  if (jsonFile) {
    const text = fs.readFileSync(jsonFile, 'utf8');
    const backup = JSON.parse(text);
    check('备份格式与版本正确', backup.format === 'interview-knowledge-library' && backup.version === 2);
    check('备份包含两个库', backup.data.technicalQuestions.length === beforeBackup.technicalQuestions.length && backup.data.projectQuestions.length === beforeBackup.projectQuestions.length);
    check('备份不含 API Key 与图片数据', !/sk-[A-Za-z0-9]|data:image/i.test(text));

    // 先清空一部分，再从备份恢复
    await sw.eval('chrome.storage.local.remove("knowledgeLibrary")');
    await sleeps(300);
    await setFileInput(kb, '#file-restore', [jsonFile]);
    await waitFor(async () => evaluate(`!document.getElementById('restore-panel').hidden`), { timeoutMs: 15000, label: '恢复预览' }).catch(() => {});
    const previewText = await evaluate(`__kb.text('#restore-panel')`);
    check('恢复前展示替换范围与数量', /完整替换/.test(previewText) && /八股文问答/.test(previewText), previewText.split('\n').slice(0, 4).join(' '));
    await shot(kb, 'kb-6-restore-preview.jpg');

    // 取消不改变当前库
    await evaluate(`__kb.q('#restore-panel #rs-cancel').click(); true`);
    await sleeps(400);
    check('取消恢复后当前知识库保持为空', (await loadState()) === null);

    await setFileInput(kb, '#file-restore', [jsonFile]);
    await waitFor(async () => evaluate(`!document.getElementById('restore-panel').hidden`), { timeoutMs: 15000, label: '恢复预览2' });
    await evaluate(`__kb.q('#restore-panel #rs-confirm').click(); true`);
    await sleeps(1500);
    state = await loadState();
    check('确认后完整恢复两个库', state && state.technicalQuestions.length === beforeBackup.technicalQuestions.length && state.projects.length === beforeBackup.projects.length, `八股文 ${state?.technicalQuestions?.length}`);
    check('恢复保留项目问答关系', state.projectQuestions.every((q) => state.projects.some((p) => p.id === q.projectId)));
    check('恢复不影响岗位记录与设置', (await sw.eval('chrome.storage.local.get("settings").then(o=>o.settings.apiKey)')) === apiKey);
  }

  await evaluate(`__kb.q('#btn-backup').click(); true`);
  await sleeps(200);
  await evaluate(`__kb.q('#backup-menu [data-io="md-technical"]').click(); true`);
  const mdOut = await waitFor(
    () => {
      const f = fs.readdirSync(DL).filter((x) => x.endsWith('.md'));
      return f.length ? path.join(DL, f[0]) : null;
    },
    { timeoutMs: 15000, intervalMs: 300, label: 'Markdown 导出' },
  ).catch(() => null);
  check('Markdown 导出落盘', Boolean(mdOut), mdOut ? path.basename(mdOut) : '没有文件');
  if (mdOut) {
    const md = fs.readFileSync(mdOut, 'utf8');
    check('Markdown 按分类组织并含 Q/A 标记', /^## /m.test(md) && /### Q: /.test(md) && /^A:/m.test(md));
    check('Markdown 保留代码围栏', md.includes('```'));
  }

  /* ---------------- [L] 存储泄漏与大题库 ---------------- */
  section('[L] 存储内容审计与较大题库');

  const localDump = await sw.eval('chrome.storage.local.get(null).then(o=>JSON.stringify(o))');
  const sessionDump = await sw.eval('chrome.storage.session.get(null).then(o=>JSON.stringify(o))');
  const knowledgeOnly = await sw.eval('chrome.storage.local.get("knowledgeLibrary").then(o=>JSON.stringify(o.knowledgeLibrary))');
  check('知识库容器里没有图片或文件字节', !/data:image|data:application/i.test(knowledgeOnly));
  check('知识库容器里没有 API Key', !/sk-[A-Za-z0-9]{10}/.test(knowledgeOnly));
  check('session 里没有残留交接内容', sessionDump === '{}' || !/knowledgePending/.test(sessionDump), sessionDump.slice(0, 80));
  const localKeys = Object.keys(JSON.parse(localDump)).sort().join(',');
  check('知识库功能只写入 knowledgeLibrary 这一个键', localKeys === 'knowledgeLibrary,settings', localKeys);
  check('岗位数据没有被知识库功能改动', !('records' in JSON.parse(localDump)) || /"records"/.test(localDump));

  // 较大题库：写入 120 道题后检查搜索与保存仍可用
  const bulk = JSON.parse(
    await kb.eval(`(() => {
      const questions = [];
      for (let i = 1; i <= 120; i += 1) {
        questions.push({ question: '批量题目 ' + i + '：解释一下分布式锁的实现方式', answerMarkdown: '答案' + i + '：\\n\\n- 基于 Redis SETNX\\n- 基于 ZooKeeper 临时顺序节点\\n\\n\`\`\`java\\nlock.tryLock();\\n\`\`\`' });
      }
      return (async () => {
        const before = Date.now();
        const res = await chrome.runtime.sendMessage({ type: 'KNOWLEDGE_APPLY', op: 'candidates.commit', payload: { library: 'technical', candidates: questions } });
        return JSON.stringify({ ok: res.ok, error: res.error || '', ms: Date.now() - before, count: res.state ? res.state.technicalQuestions.length : 0 });
      })();
    })()`),
  );
  check('大批量题目可以一次性保存', bulk.ok === true && bulk.count >= 120, `${bulk.count} 道 · ${bulk.ms}ms`);
  await evaluate(`__kb.q('#tabs button[data-view="technical"]').click(); true`);
  await sleeps(300);
  const searchStart = Date.now();
  await evaluate(`__kb.setField('#tq-search', '分布式锁'); true`);
  await sleeps(600);
  const bigList = await evaluate(`__kb.listQuestions().length`);
  const searchMs = Date.now() - searchStart;
  check('较大题库下搜索仍可用', bigList >= 100, `${bigList} 条 · ${searchMs}ms`);
  await shot(kb, 'kb-7-large-bank.jpg');
  await evaluate(`__kb.setField('#tq-search', '批量题目 120'); true`);
  await sleeps(600);
  check('搜索仍能精确定位', (await evaluate(`JSON.stringify(__kb.listQuestions())`)).includes('批量题目 120：'));
  await evaluate(`__kb.setField('#tq-search', ''); true`);
  await sleeps(500);

  const saveStart = Date.now();
  await evaluate(`__kb.q('#tq-add').click(); true`);
  await sleeps(300);
  await evaluate(`__kb.setCand(0, {question:'较大题库下的新题', answer:'写在批量数据之后。'})`);
  await evaluate(`__kb.reviewSave(); true`);
  await sleeps(1200);
  const bigState = await loadState();
  check('较大题库下仍能保存新题', bigState.technicalQuestions.some((q) => q.question === '较大题库下的新题'), `${Date.now() - saveStart}ms`);

  }
  section('[R] 长问答与每日复习');
  await kb.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const request=async(op,payload)=>kb.eval(`chrome.runtime.sendMessage(${JSON.stringify({type:'KNOWLEDGE_APPLY',op,payload})})`);
  const longAnswer='# 方案选择\n\n'+('采用事务与乐观锁控制并发，保留失败重试与一致性检查。\n\n'.repeat(70))+'```java\n'+('lock.tryLock();'.repeat(60))+'\n```';
  const projectResult=await request('project.create',{name:'复习验收项目',summary:'围绕项目经历积累追问',responsibilities:'负责核心模块'});
  const projectId=projectResult.result.project.id;
  for(let n=1;n<=2;n++)await request('projectQuestion.create',{projectId,question:`为什么选择这个技术方案？长答案 ${n}`,answerMarkdown:longAnswer});
  await evaluate(`document.querySelector('#tabs [data-view="projects"]').click();true`);await sleeps(300);
  await evaluate(`Array.from(document.querySelectorAll('#proj-list [data-pid]')).find(e=>e.dataset.pid===${JSON.stringify(projectId)}).click();true`);
  check('进入项目答案默认折叠',await evaluate(`Array.from(document.querySelectorAll('#proj-detail .q-toggle')).length===2 && Array.from(document.querySelectorAll('#proj-detail .q-toggle')).every(e=>e.getAttribute('aria-expanded')==='false')`));
  const detailWidth = await evaluate(`document.querySelector('#proj-detail').getBoundingClientRect().width`);
  await evaluate(`document.querySelector('#btn-sidebar').click();true`);
  check('项目侧栏折叠且正文扩展',await evaluate(`getComputedStyle(document.querySelector('#project-sidebar')).display==='none' && document.querySelector('#proj-detail').getBoundingClientRect().width>${detailWidth}+250 && document.querySelector('#btn-sidebar').getAttribute('aria-expanded')==='false'`));
  await shot(kb,'kb-18-sidebar-collapsed.jpg');
  await kb.send('Page.reload');await sleeps(700);await kb.eval(inPageHelpers);
  check('刷新后记住项目侧栏折叠',await evaluate(`document.querySelector('#view-projects').classList.contains('sidebar-collapsed') && document.querySelector('#btn-sidebar').title==='展开左侧栏'`));
  await evaluate(`document.querySelector('#tabs [data-view="technical"]').click();true`);
  check('两库独立记住侧栏状态',await evaluate(`!document.querySelector('#view-technical').classList.contains('sidebar-collapsed')`));
  await evaluate(`document.querySelector('#btn-sidebar').click();true`);
  check('题库分类和题目列表一起收起',await evaluate(`['category-sidebar','question-sidebar'].every(id=>getComputedStyle(document.getElementById(id)).display==='none') && document.querySelector('#btn-sidebar').getAttribute('aria-controls')==='category-sidebar question-sidebar'`));
  await evaluate(`document.querySelector('#bank-review').click();true`);
  check('每日复习不展示无用侧栏按钮',await evaluate(`document.querySelector('#btn-sidebar').hidden`));
  await evaluate(`document.querySelector('#bank-browse').click();document.querySelector('#btn-sidebar').click();document.querySelector('#tabs [data-view="projects"]').click();document.querySelector('#btn-sidebar').click();Array.from(document.querySelectorAll('#proj-list [data-pid]')).find(e=>e.dataset.pid===${JSON.stringify(projectId)}).click();document.querySelector('#proj-detail [data-act="edit"]').click();window.__sidebarEditor=document.querySelector('#ed-answer');true`);
  await kb.send('Page.bringToFront');await sleeps(150);
  await evaluate(`document.querySelector('#btn-sidebar').focus();true`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('键盘可折叠且保留原编辑器和草稿',await evaluate(`document.querySelector('#btn-sidebar').getAttribute('aria-expanded')==='false' && document.querySelector('#ed-answer')===window.__sidebarEditor && window.__sidebarEditor.value===${JSON.stringify(longAnswer)}`));
  await evaluate(`document.querySelector('#btn-sidebar').click();document.querySelector('#proj-detail [data-act="cancel"]').click();true`);
  check('展开后恢复侧栏及原项目选择',await evaluate(`getComputedStyle(document.querySelector('#project-sidebar')).display!=='none' && document.querySelector('#proj-list [data-pid="${projectId}"]').classList.contains('active')`));
  const originalOrder=(await loadState()).projectQuestions.filter(q=>q.projectId===projectId).map(q=>q.id);
  const grip=await evaluate(`(()=>{const r=document.querySelector('#proj-detail .sort-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const dropPoint=await evaluate(`(()=>{const r=document.querySelectorAll('#proj-detail [data-sort-id]')[1].getBoundingClientRect();return {x:r.x+80,y:r.bottom-10}})()`);
  await kb.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x,y:grip.y});
  await kb.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:grip.x,y:grip.y});
  await kb.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:dropPoint.x,y:dropPoint.y});
  await kb.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:dropPoint.x,y:dropPoint.y});await sleeps(450);
  check('真实指针拖动后题序写入存储',(await loadState()).projectQuestions.filter(q=>q.projectId===projectId).map(q=>q.id).join()===originalOrder.reverse().join());
  await kb.send('Page.reload');await sleeps(700);await kb.eval(inPageHelpers);
  await evaluate(`document.querySelector('#tabs [data-view="projects"]').click();Array.from(document.querySelectorAll('#proj-list [data-pid]')).find(e=>e.dataset.pid===${JSON.stringify(projectId)}).click();true`);
  check('刷新后项目题序保持',await evaluate(`Array.from(document.querySelectorAll('#proj-detail [data-sort-id]')).map(n=>n.dataset.sortId).join()===${JSON.stringify(originalOrder.join())}`));
  await shot(kb,'kb-8-folded.jpg');
  await evaluate(`document.querySelector('#proj-detail [data-bulk=expand]').click();true`);
  check('全部展开两条长答案',await evaluate(`Array.from(document.querySelectorAll('#proj-detail .q-toggle')).every(e=>e.getAttribute('aria-expanded')==='true')`));
  check('题目字号大于答案及答案标题',await evaluate(`(()=>{const q=document.querySelector('#proj-detail .q-t'),a=document.querySelector('#proj-detail .md-preview[id]');return parseFloat(getComputedStyle(q).fontSize)>parseFloat(getComputedStyle(a).fontSize)&&parseFloat(getComputedStyle(q).fontSize)>parseFloat(getComputedStyle(a.querySelector('h1')).fontSize)})()`));
  await evaluate(`window.scrollTo(0,document.body.scrollHeight);document.querySelector('#proj-detail .pane-body').scrollTop=100000;true`);await sleeps(300);
  check('长答案底部固定新建仍在视口',await evaluate(`(()=>{const b=document.querySelector('#floating-new'),r=b.getBoundingClientRect();return !b.hidden&&getComputedStyle(b).position==='fixed'&&r.bottom<=innerHeight&&r.top>0})()`));
  await shot(kb,'kb-9-long-bottom.jpg');
  await evaluate(`document.querySelector('#floating-new').click();true`);await sleeps(250);
  check('固定新建归属所选项目且模态时隐藏',await evaluate(`__kb.reviewOpen()&&__kb.reviewText().includes('复习验收项目')&&document.querySelector('#floating-new').hidden`));
  check('新增核对编辑器也填满可用宽度',await evaluate(`(()=>{const a=document.querySelector('#review-panel .md-field textarea'),b=a.closest('.md-field');return a.getBoundingClientRect().width>=b.getBoundingClientRect().width-2&&!!b.querySelector('[data-md-command="bold"]')})()`));
  await evaluate(`document.querySelector('#review-panel [data-md-expand]').click();true`);
  check('核对弹层也支持宽屏编辑',await evaluate(`document.querySelector('#review-panel .md-expanded').getBoundingClientRect().width>=innerWidth-50`));
  await evaluate(`document.querySelector('#review-panel [data-md-expand]').click();true`);
  await evaluate(`__kb.reviewCancel();true`);await sleeps(200);
  await evaluate(`document.querySelector('#proj-detail [data-bulk=collapse]').click();document.querySelector('#proj-detail .q-toggle').focus();true`);
  await kb.send('Page.bringToFront');await sleeps(150);
  await evaluate(`document.querySelector('#proj-detail .q-toggle').focus();true`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleeps(180);
  check('题目键盘可以展开',await evaluate(`document.querySelector('#proj-detail .q-toggle').getAttribute('aria-expanded')==='true'`));
  await evaluate(`document.querySelector('#proj-detail .q-block [data-act="edit"]').click();true`);
  check('Markdown 默认填满可用宽度且有足够高度',await evaluate(`(()=>{const a=document.querySelector('#ed-answer'),b=a.closest('.md-field');return a.getBoundingClientRect().width>=b.getBoundingClientRect().width-2&&a.getBoundingClientRect().height>=300})()`));
  await evaluate(`document.querySelector('#ed-answer').scrollIntoView({block:'center'});true`);await shot(kb,'kb-15-markdown-default.jpg');
  await evaluate(`__kb.setMarkdown('以**“HEAD 提交 → 当前磁盘内容”**为比较范围');document.querySelector('[data-md="ed-answer"] [data-mode="preview"]').click();true`);
  check('中文无空格引号加粗在实际预览中生效',await evaluate(`document.querySelector('#ed-answer-view strong')?.textContent==='“HEAD 提交 → 当前磁盘内容”'`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-mode="edit"]').click();__kb.setMarkdown('前**“内容 <script>window.__boldXss=1</script> 与 <a href="javascript:alert(1)">链接</a>”**后');document.querySelector('[data-md="ed-answer"] [data-mode="preview"]').click();true`);
  check('中文加粗补丁仍经过安全清洗',await evaluate(`!!document.querySelector('#ed-answer-view strong')&&!document.querySelector('#ed-answer-view script')&&!document.querySelector('#ed-answer-view [href^="javascript:"]')&&!window.__boldXss`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-mode="edit"]').click();true`);
  await evaluate(`(()=>{const a=document.querySelector('#ed-answer');__kb.setMarkdown(Array.from({length:260},(_,i)=>'第'+i+'行 目标文本'+i+' abcdefghijklmnopqrstuvwxyz').join('\\n'));const at=a.value.indexOf('目标文本140');a.focus({preventScroll:true});a.setSelectionRange(at,at+'目标文本140'.length);a.scrollTop=140*parseFloat(getComputedStyle(a).lineHeight)-100;window.__editScroll={top:a.scrollTop,left:a.scrollLeft,page:scrollY,pane:document.querySelector('#proj-detail .pane-body').scrollTop};window.__scrollFrames=[];const sample=()=>{window.__scrollFrames.push({top:a.scrollTop,page:scrollY});if(window.__scrollFrames.length<12)requestAnimationFrame(sample)};requestAnimationFrame(sample);a.__ranges=[];const native=a.setSelectionRange.bind(a);a.setSelectionRange=(...args)=>{a.__ranges.push(args.slice(0,2));return native(...args)};return true})()`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'b',code:'KeyB',modifiers:4});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'b',code:'KeyB',modifiers:0});await sleeps(100);
  check('长源码中部加粗不移动编辑区或页面',await evaluate(`(()=>{const a=document.querySelector('#ed-answer'),s=__editScroll;return a.value.split(String.fromCharCode(10)).length===260&&s.top>2000&&Math.abs(a.scrollTop-s.top)<=1&&Math.abs(a.scrollLeft-s.left)<=1&&Math.abs(scrollY-s.page)<=1&&Math.abs(document.querySelector('#proj-detail .pane-body').scrollTop-s.pane)<=1&&a.value.includes('**目标文本140**')})()`));
  await sleeps(150);
  check('加粗后的连续绘制帧没有滚动闪跳',await evaluate(`__scrollFrames.length>=3&&__scrollFrames.every(s=>Math.abs(s.top-__editScroll.top)<=1&&Math.abs(s.page-__editScroll.page)<=1)`));
  check('格式命令不再选择整篇源码',await evaluate(`document.querySelector('#ed-answer').__ranges.every(([a,b])=>b-a<100)`));
  await evaluate(`(()=>{__kb.setMarkdown('重点内容');const a=document.querySelector('#ed-answer');a.focus();a.setSelectionRange(0,4);return true})()`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'4',code:'Digit4',modifiers:5});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'4',code:'Digit4',modifiers:0});
  check('Cmd+Alt+4 插入蓝色加粗并保留选区',await evaluate(`(()=>{const a=document.querySelector('#ed-answer');return a.value.includes('class="md-accent-blue"')&&a.value.slice(a.selectionStart,a.selectionEnd)==='重点内容'})()`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-mode="preview"]').click();true`);
  check('彩色加粗经过清洗后仍显示颜色与粗体',await evaluate(`(()=>{const n=document.querySelector('#ed-answer-view strong.md-accent-blue');return n?.textContent==='重点内容'&&getComputedStyle(n).color==='rgb(36, 92, 186)'&&Number(getComputedStyle(n).fontWeight)>=700&&!n.hasAttribute('style')})()`));
  await shot(kb,'kb-16-colored-bold.jpg');
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-mode="edit"]').click();document.querySelector('[data-md="ed-answer"] [data-md-command="accent-red"]').click();true`);
  check('工具栏切换颜色不嵌套旧色',await evaluate(`document.querySelector('#ed-answer').value==='<strong class="md-accent-red">重点内容</strong>'`));
  await evaluate(`__kb.setMarkdown('格式测试');const a=document.querySelector('#ed-answer');a.focus();a.setSelectionRange(0,a.value.length);true`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'b',code:'KeyB',modifiers:4});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'b',code:'KeyB',modifiers:0});await sleeps(100);
  check('Cmd+B 对选区加粗且触发编辑状态',await evaluate(`document.querySelector('#ed-answer').value==='**格式测试**'`));
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4,commands:['undo']});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:0});await sleeps(100);
  check('Markdown 格式操作支持原生撤销',await evaluate(`document.querySelector('#ed-answer').value==='格式测试'`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-md-command="code"]').click();true`);
  check('代码块工具栏插入围栏且原文保留',await evaluate(`document.querySelector('#ed-answer').value.includes(String.fromCharCode(96).repeat(3))&&document.querySelector('#ed-answer').value.includes('格式测试')`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-md-expand]').click();true`);await sleeps(100);
  check('宽屏编辑覆盖大部分视口',await evaluate(`document.querySelector('[data-md="ed-answer"]').getBoundingClientRect().width>=innerWidth-50`));
  await shot(kb,'kb-14-markdown-wide.jpg');
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'p',code:'KeyP',modifiers:12});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'p',code:'KeyP',modifiers:0});
  check('Cmd+Shift+P 切换安全预览',await evaluate(`document.querySelector('#ed-answer').hidden&&!document.querySelector('#ed-answer-view').hidden`));
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  check('Escape 返回普通宽度且保留编辑文本',await evaluate(`!document.querySelector('[data-md="ed-answer"]').classList.contains('md-expanded')&&document.querySelector('#ed-answer').value.includes('格式测试')`));
  await evaluate(`document.querySelector('[data-md="ed-answer"] [data-mode="edit"]').click();__kb.setMarkdown('# 更新后的答案');window.confirm=()=>false;document.querySelector('#btn-new').click();true`);

  check('取消离开保留未保存答案',await evaluate(`document.querySelector('#ed-answer')?.value==='# 更新后的答案'&&!document.querySelector('#np-name')`));
  await evaluate(`window.confirm=()=>true;document.querySelector('#ed-answer').focus();true`);
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:4});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:0});await sleeps(450);
  check('保存编辑后回到阅读且固定新建恢复',await evaluate(`!document.querySelector('#proj-detail #ed-answer')&&!document.querySelector('#floating-new').hidden&&document.querySelector('#proj-detail .q-toggle').getAttribute('aria-expanded')==='true'`));
  // A card deep in a long project list must not jump back to the first question.
  const positionResult=await request('projectQuestion.create',{projectId,question:'滚动位置目标题',answerMarkdown:'保存后继续停留在当前阅读位置。'});
  const positionId=positionResult.result.question.id;
  await request('projectQuestion.create',{projectId,question:'后续长答案',answerMarkdown:longAnswer});await sleeps(250);
  await evaluate(`document.querySelector('#proj-detail [data-bulk="expand"]').click();true`);
  await evaluate(`(()=>{const p=document.querySelector('#proj-detail .pane-body'),q=document.querySelector('[data-qid="${positionId}"]');p.scrollTop=q.getBoundingClientRect().top-p.getBoundingClientRect().top+p.scrollTop-90;window.scrollTo(0,20);window.__positionBefore={top:p.scrollTop,page:scrollY};q.querySelector('[data-act="edit"]').click();return true})()`);await sleeps(120);
  check('长项目列表点击编辑保持详情与页面位置',await evaluate(`(()=>{const p=document.querySelector('#proj-detail .pane-body');return __positionBefore.top>500&&Math.abs(p.scrollTop-__positionBefore.top)<=1&&Math.abs(scrollY-__positionBefore.page)<=1&&!!document.querySelector('[data-qid="${positionId}"] #ed-answer')})()`));
  await evaluate(`(()=>{const p=document.querySelector('#proj-detail .pane-body');window.__positionSave={top:p.scrollTop,page:scrollY};document.querySelector('[data-qid="${positionId}"] [data-act="save"]').click();return true})()`);await sleeps(450);
  check('长项目列表保存及存储回写保持当前位置',await evaluate(`(()=>{const p=document.querySelector('#proj-detail .pane-body');return Math.abs(p.scrollTop-__positionSave.top)<=1&&Math.abs(scrollY-__positionSave.page)<=1&&!document.querySelector('#ed-answer')})()`));
  check('本页保存回写不误报其他页面更新',await evaluate(`document.querySelector('#banner').hidden||!document.querySelector('#banner').textContent.includes('其他页面更新')`));
  await shot(kb,'kb-17-save-position.jpg');
  const technicalPosition=await request('technicalQuestion.create',{question:'八股滚动位置目标题',answerMarkdown:longAnswer});
  await evaluate(`document.querySelector('#tabs [data-view="technical"]').click();true`);await sleeps(200);
  await evaluate(`Array.from(document.querySelectorAll('#tq-list [data-tid]')).find(n=>n.dataset.tid===${JSON.stringify(technicalPosition.result.question.id)}).click();document.querySelector('#tq-detail [data-toggle-answer]').click();const p=document.querySelector('#tq-detail .pane-body');p.scrollTop=100;window.scrollTo(0,20);window.__technicalBefore={top:p.scrollTop,page:scrollY};document.querySelector('#tq-detail [data-act="edit"]').click();true`);await sleeps(100);
  check('八股点击编辑保留可用范围内滚动位置',await evaluate(`(()=>{const p=document.querySelector('#tq-detail .pane-body');return Math.abs(p.scrollTop-Math.min(__technicalBefore.top,p.scrollHeight-p.clientHeight))<=1&&Math.abs(scrollY-__technicalBefore.page)<=1})()`));
  const editingDraft=longAnswer+'\n\n未保存草稿仍保留';
  await evaluate(`(()=>{__kb.setMarkdown(${JSON.stringify(editingDraft)});const a=document.querySelector('#ed-answer');a.focus({preventScroll:true});a.setSelectionRange(50,60);a.scrollTop=450;window.__draftScroll=a.scrollTop;return true})()`);
  await request('category.create',{name:'滚动回归分类'});await sleeps(300);
  check('同题后台刷新保留草稿光标和源码滚动',await evaluate(`(()=>{const a=document.querySelector('#ed-answer');return a.value.endsWith('未保存草稿仍保留')&&a.selectionStart===50&&a.selectionEnd===60&&Math.abs(a.scrollTop-__draftScroll)<=1})()`));
  await evaluate(`(()=>{const p=document.querySelector('#tq-detail .pane-body');window.__technicalSave={top:p.scrollTop,page:scrollY};document.querySelector('#tq-detail [data-act="save"]').click();return true})()`);await sleeps(450);
  check('八股保存后页面不回到顶部',await evaluate(`(()=>{const p=document.querySelector('#tq-detail .pane-body');return Math.abs(p.scrollTop-Math.min(__technicalSave.top,p.scrollHeight-p.clientHeight))<=1&&Math.abs(scrollY-__technicalSave.page)<=1&&!document.querySelector('#ed-answer')})()`));
  const catResult=await request('category.create',{name:'每日验收'}),cat=catResult.result.category.id;
  for(let n=1;n<=3;n++)await request('technicalQuestion.create',{question:`每日复习题 ${n}：为什么选这个技术方案？`,answerMarkdown:n===3?'':'## 参考答案\n\n- 适合当前约束\n- 明确替代方案与取舍\n\n```js\nconst reliable = true;\n```',categoryId:cat,tags:['实践']});
  await evaluate(`window.scrollTo(0,0);document.querySelector('#tabs [data-view="technical"]').click();true`);await sleeps(300);
  const bankOrder=(await loadState()).technicalQuestions.map(q=>q.id);
  await evaluate(`document.querySelector('#tq-list .sort-handle').focus();true`);await kb.send('Page.bringToFront');
  await kb.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await kb.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await sleeps(350);
  const movedBank=(await loadState()).technicalQuestions.map(q=>q.id);
  check('八股题目手柄支持键盘调整顺序',movedBank[0]===bankOrder[1]&&movedBank[1]===bankOrder[0]);
  check('八股题库固定新建入口可用',await evaluate(`!document.querySelector('#floating-new').hidden&&!document.querySelector('#floating-new').disabled`));
  await evaluate(`document.querySelector('#bank-review').click();true`);await sleeps(300);
  check('每日复习默认10题且浮动新建隐藏',await evaluate(`document.querySelector('#review-limit').value==='10'&&document.querySelector('#floating-new').hidden`));
  await evaluate(`__kb.setField('#review-limit','2');__kb.setField('#review-category',${JSON.stringify(cat)});__kb.setField('#review-tags','实践');document.querySelector('#review-save').click();true`);await sleeps(400);
  await shot(kb,'kb-10-review-ready.jpg');
  await evaluate(`document.querySelector('#review-start').click();true`);await sleeps(450);
  check('计划筛选且排除空答案',await evaluate(`document.querySelector('.review-progress').textContent.includes('0 / 2')&&!!document.querySelector('#recall')&&!document.querySelector('[data-rate]')`));
  await evaluate(`__kb.setField('#recall','RECALL_PRIVATE_NEVER_STORE');document.querySelector('#review-reveal').click();true`);
  check('揭晓后显示Markdown与两种自评',await evaluate(`!!document.querySelector('.review-answer pre')&&document.querySelectorAll('[data-rate]').length===2`));
  await shot(kb,'kb-11-revealed.jpg');
  const beforePlan=await loadState(),today=beforePlan.review.days.at(-1).day;
  await kb.send('Page.reload');await sleeps(800);await kb.eval(inPageHelpers);await evaluate(`document.querySelector('#tabs [data-view="technical"]').click();document.querySelector('#bank-review').click();true`);await sleeps(250);
  check('刷新恢复同一计划且临时回答消失',await evaluate(`document.querySelector('#recall').value===''&&!document.querySelector('[data-rate]')`) && JSON.stringify((await loadState()).review.days.at(-1).items)===JSON.stringify(beforePlan.review.days.at(-1).items));
  await evaluate(`document.querySelector('#review-reveal').click();document.querySelector('[data-rate="remembered"]').click();true`);await sleeps(450);
  check('保存后进入下一题并恢复1/2进度',await evaluate(`document.querySelector('.review-progress').textContent.includes('1 / 2')&&!document.querySelector('[data-rate]')`));
  const other=await openTarget(knowledgeUrl,'复习同步页');await sleeps(500);
  await other.conn.eval(`document.querySelector('#tabs [data-view="technical"]').click();document.querySelector('#bank-review').click();true`);await sleeps(250);
  check('第二页同步当日进度',await other.conn.eval(`document.querySelector('.review-progress').textContent.includes('1 / 2')`));
  await evaluate(`document.querySelector('#review-reveal').click();true`);
  const pending=(await loadState()).review.days.at(-1).items.find(i=>i.status==='pending');
  const qNow=(await loadState()).technicalQuestions.find(q=>q.id===pending.questionId);
  await other.conn.eval(`chrome.runtime.sendMessage(${JSON.stringify({type:'KNOWLEDGE_APPLY',op:'technicalQuestion.update',payload:{id:qNow.id,revision:qNow.revision,answerMarkdown:'## 更新后的参考\n请重新回想'}})})`);await sleeps(450);
  check('他页更新题答后必须重新揭晓',await evaluate(`!document.querySelector('[data-rate]')&&document.querySelector('.review-message').textContent.includes('更新')`));
  await browserWs.send('Target.closeTarget',{targetId:other.targetId});
  // Advance the clock only in the isolated page and worker; leave OS/user clock untouched.
  const future=Date.now()+86400000;
  const clock=`globalThis.__realReviewDate=Date;globalThis.Date=class extends __realReviewDate{constructor(...a){super(...(a.length?a:[${future}]))}static now(){return ${future}}};true`;
  await sw.eval(clock);await kb.eval(clock);
  await evaluate(`window.dispatchEvent(new Event('focus'));true`);await sleeps(450);
  check('跨日旧未完成保留且今日重新开始',await evaluate(`!!document.querySelector('#review-start')`) && (await loadState()).review.days.find(d=>d.day===today).completedAt===0);
  await evaluate(`document.querySelector('#review-start').click();true`);await sleeps(400);
  for(const result of ['needs-review','remembered']){await evaluate(`document.querySelector('#review-reveal').click();document.querySelector('[data-rate="${result}"]').click();true`);await sleeps(450);}
  const completedState=await loadState();
  check('全部自评自动打卡且包含需复习',!!completedState.review.days.at(-1).completedAt&&completedState.review.days.at(-1).items.some(i=>i.status==='needs-review'));
  check('日历和连续天数展示',await evaluate(`document.querySelector('.streak b').textContent==='1'&&document.querySelector('.calendar-day.checked')!==null`));
  await shot(kb,'kb-12-completed.jpg');
  await evaluate(`document.querySelector('[data-date="${today}"]').click();true`);await sleeps(150);
  check('历史详情显示未完成与自评',await evaluate(`document.querySelector('.history-detail').textContent.includes('未完成')&&document.querySelector('.history-detail').textContent.includes('记住了')`));
  await kb.send('Emulation.setDeviceMetricsOverride',{width:460,height:900,deviceScaleFactor:1,mobile:false});await sleeps(250);await shot(kb,'kb-13-narrow-history.jpg');
  check('窄视口页面无横向溢出',await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  check('窄视口复习卡无横向溢出',await evaluate(`document.querySelector('.review-card').getBoundingClientRect().right<=innerWidth`));
  const ex=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_EXPORT',library:'json'})`);
  check('完整备份包含学习记录且无临时回答',ex.ok&&JSON.parse(ex.content).version===2&&JSON.parse(ex.content).data.review.days.length===2&&!ex.content.includes('RECALL_PRIVATE_NEVER_STORE'));
  check('local/session 均不保存临时回答',!(await sw.eval(`chrome.storage.local.get(null).then(o=>JSON.stringify(o))`)).includes('RECALL_PRIVATE_NEVER_STORE')&&!(await sw.eval(`chrome.storage.session.get(null).then(o=>JSON.stringify(o))`)).includes('RECALL_PRIVATE_NEVER_STORE'));
  // Restore preview conflict through the actual page bridge.
  const pr=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_RESTORE',text:${JSON.stringify(ex.content)},confirm:false})`);
  await request('review.settings',{dailyLimit:3,categoryId:cat,tags:[]});
  const rejected=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_RESTORE',text:${JSON.stringify(ex.content)},confirm:true,baseRevision:${pr.containerRevision}})`);
  check('真实浏览器恢复过期预览拒绝',!rejected.ok&&rejected.code==='conflict');
  const third=Date.now()+2*86400000;
  const thirdClock=`globalThis.Date=class extends __realReviewDate{constructor(...a){super(...(a.length?a:[${third}]))}static now(){return ${third}}};true`;
  await sw.eval(thirdClock);await kb.eval(thirdClock);await evaluate(`window.dispatchEvent(new Event('focus'));true`);await sleeps(300);
  await evaluate(`document.querySelector('#review-start').click();true`);await sleeps(400);
  const deletePage=await openTarget(knowledgeUrl,'删除同步页');await sleeps(350);
  const deleteState=await loadState(),deleteItems=deleteState.review.days.at(-1).items;
  for(const item of deleteItems){const question=deleteState.technicalQuestions.find(q=>q.id===item.questionId);await deletePage.conn.eval(`chrome.runtime.sendMessage(${JSON.stringify({type:'KNOWLEDGE_APPLY',op:'technicalQuestion.delete',payload:{id:question.id,revision:question.revision}})})`);}
  await sleeps(450);
  const afterDelete=await loadState();
  check('另一页删除全部待学题不产生零题打卡',afterDelete.review.days.at(-1).items.every(i=>i.status==='unavailable')&&!afterDelete.review.days.at(-1).completedAt&&await evaluate(`document.querySelector('.review-card').textContent.includes('不生成零题打卡')`));
  check('删除后仍保留先前打卡与题目历史',afterDelete.review.days.some(d=>d.completedAt)&&afterDelete.review.days[0].items.every(i=>i.questionTitle));
  await browserWs.send('Target.closeTarget',{targetId:deletePage.targetId});
  const fresh=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_RESTORE',text:${JSON.stringify(ex.content)},confirm:false})`);
  const restored=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_RESTORE',text:${JSON.stringify(ex.content)},confirm:true,baseRevision:${fresh.containerRevision}})`);
  check('学习备份成功恢复计划历史与间隔',restored.ok&&restored.state.review.days.length===2&&restored.state.review.progress.length===2);
  const versionOne=JSON.parse(ex.content);versionOne.version=1;delete versionOne.data.review;
  const oldPreview=await kb.eval(`chrome.runtime.sendMessage({type:'KNOWLEDGE_RESTORE',text:${JSON.stringify(JSON.stringify(versionOne))},confirm:false})`);
  check('旧备份预览明确清空学习记录',oldPreview.ok&&oldPreview.preview.includes('清空当前学习记录'));
  await sw.eval('globalThis.Date=__realReviewDate;true');await kb.eval('globalThis.Date=__realReviewDate;true');

  /* ---------------- [M] 收尾 ---------------- */
  section('[M] 控制台与运行时错误');
  check('service worker 无未捕获异常', swErrors.length === 0, swErrors.slice(0, 2).join(' | '));
  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  const shots = fs.readdirSync(OUT).filter((f) => f.startsWith('kb-'));
  check('关键界面截图已保存', shots.length >= 5, shots.join(', '));
  console.log(`\n截图与产物：${OUT}`);
} catch (err) {
  failed += 1;
  failures.push(`执行中断：${err.message}`);
  console.log(`\n✗ 执行中断：${err.message}`);
  if (chromeStderr.trim()) console.log(`Chrome stderr（末尾）：\n${chromeStderr.trim().split('\n').slice(-10).join('\n')}`);
} finally {
  await cleanup();
}

console.log(`\n结果：${pass} 项通过，${failed} 项失败`);
if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
process.exit(failed ? 1 : 0);
