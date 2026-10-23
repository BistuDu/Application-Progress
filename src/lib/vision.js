/**
 * 识别层：把截图交给兼容 OpenAI 协议的视觉模型，拿回结构化 JD。
 * 默认对接 https://api.deepseek.com 的 deepseek-flash（已实测支持图片输入）。
 */

import { DEFAULT_PROMPT, chatUrlCandidates, originPattern } from './settings.js';
import { normalizeCompanyType } from './company-type.js';
import { extractSkills, siteFromUrl, sleep, toTs, uniq } from './util.js';

const RESULT_FIELDS = [
  'company',
  'company_type',
  'title',
  'location',
  'salary',
  'job_type',
  'education',
  'experience',
  'headcount',
  'deadline',
  'jd',
  'requirements',
  'contact',
  'summary',
];

export class VisionError extends Error {
  constructor(message, { code = 'unknown', status = 0, endpoint = '', detail = '', retryable = false } = {}) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
    this.retryable = retryable;
  }
}

function buildPrompt(settings, { pageTitle, pageUrl, sourceSite }) {
  const tpl = (settings?.promptTemplate || '').trim() || DEFAULT_PROMPT;
  const ctx = [];
  if (pageTitle) ctx.push(`页面标题：${pageTitle}`);
  if (pageUrl) ctx.push(`页面网址：${pageUrl}`);
  if (sourceSite) ctx.push(`来源站点：${sourceSite}`);
  if (!ctx.length) return tpl;
  return `${tpl}\n\n【辅助上下文，仅在图片信息不足时用于补全，不得据此编造】\n${ctx.join('\n')}`;
}

export function buildRequestBody({ settings, image, pageTitle, pageUrl, sourceSite, withJsonMode = true }) {
  const body = {
    model: settings.model || 'deepseek-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(settings, { pageTitle, pageUrl, sourceSite }) },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ],
    max_tokens: Number(settings.maxTokens) || 4096,
    temperature: 0.1,
    stream: false,
  };
  if (withJsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/** 有些网关（含带思维链的模型）会把 JSON 包在围栏或解释里，这里做容错抽取。 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试 */
  }
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 从接口返回里取出正文（兼容 content 为数组、只有 reasoning_content 的网关）。 */
function pickContent(message) {
  if (!message) return { content: '', reasoning: '' };
  let content = message.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return { content: content || '', reasoning: message.reasoning_content || '' };
}

/** 归一化模型输出为记录可用的字段。 */
export function normalizeResult(raw, fallback = {}) {
  const get = (k) => {
    const v = raw?.[k];
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join('、');
    return '';
  };
  const jd = get('jd') || get('job_description') || get('responsibilities') || get('duties');
  const requirements = get('requirements') || get('qualifications') || get('requirement');
  const company = get('company') || get('company_name') || '';
  const title = get('title') || get('position') || get('job_title') || '';
  const skills = uniq([
    ...(Array.isArray(raw?.skills) ? raw.skills.map((s) => String(s).trim()) : []),
    ...(Array.isArray(raw?.keywords) ? raw.keywords.map((s) => String(s).trim()) : []),
    ...extractSkills([title, jd, requirements, get('summary')].join('\n')),
  ]).slice(0, 40);

  return {
    isJob: raw?.is_job === undefined ? true : Boolean(raw.is_job),
    company,
    companyType: normalizeCompanyType(get('company_type') || get('companyType')),
    title,
    location: get('location') || get('city') || '',
    salary: get('salary') || get('compensation') || '',
    jobType: get('job_type') || '',
    education: get('education') || '',
    experience: get('experience') || '',
    headcount: get('headcount') || '',
    deadline: get('deadline') || '',
    jd,
    requirements,
    skills,
    contact: get('contact') || get('apply') || '',
    summary: get('summary') || '',
    rawFields: RESULT_FIELDS.reduce((o, k) => {
      o[k] = raw?.[k] ?? '';
      return o;
    }, {}),
    pageTitle: fallback.pageTitle || '',
    sourceUrl: fallback.sourceUrl || '',
    sourceSite: fallback.sourceSite || siteFromUrl(fallback.sourceUrl || ''),
  };
}

/** 死信映射：把 HTTP 错误翻译成用户看得懂的中文提示。 */
function describeHttpError(status, bodyText) {
  const body = String(bodyText || '');
  if (status === 401 || status === 403) {
    return { code: 'auth', msg: 'API Key 无效或没有该模型权限，请在设置里检查 Key（401/403）。', retryable: false };
  }
  if (status === 402) return { code: 'quota', msg: '账户余额不足（402），请先充值。', retryable: false };
  if (status === 404) return { code: 'notfound', msg: '接口地址或模型名不存在（404），请检查「接口地址」与「模型名」。', retryable: false };
  if (status === 429) return { code: 'ratelimit', msg: '触发限流（429），稍后重试即可。', retryable: true };
  if (status >= 500) return { code: 'server', msg: `模型服务端错误（${status}），可重试。`, retryable: true };
  if (/response_format|json_object/i.test(body)) {
    return { code: 'jsonmode', msg: '该接口不支持 JSON 模式，已自动降级重试。', retryable: true };
  }
  if (/(does not|doesn't|not)\s+support[^.]{0,40}(image|vision|multimodal)|vision|multimodal|modality/i.test(body)) {
    return { code: 'novision', msg: '当前模型不接受图片输入，请在设置里换成支持视觉的模型。', retryable: false };
  }
  if (/image[^.]{0,40}(too small|invalid|decode|corrupt|format|size)/i.test(body)) {
    return { code: 'badimage', msg: '接口无法解析这张截图，换一张更清晰的图试试。', retryable: true };
  }
  return { code: 'http', msg: `请求失败（${status}）：${body.slice(0, 200)}`, retryable: status >= 500 };
}

async function doFetch(url, { settings, body, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  return { res, text };
}

/** 模型偶尔会返回"字段都在、值全空"的合法 JSON，这种结果等于没识别出来。 */
export function isEffectivelyEmpty(result) {
  if (!result) return true;
  if (result.isJob === false) return false; // 明确判定为非招聘信息，不算空
  return (
    !result.company &&
    !result.title &&
    !result.jd &&
    !result.requirements &&
    !result.summary &&
    !result.contact &&
    !(result.skills || []).length
  );
}

/**
 * 调用识别接口；遇到空返回会自动重试一次。
 * @returns {Promise<{ok:true, result:object, raw:object, meta:object}>}
 */
export async function analyzeScreenshot(opts) {
  let payload = await attemptVision(opts);
  if (isEffectivelyEmpty(payload.result)) {
    // 空返回通常是一次偶发，重试一次基本都能拿到内容
    await sleep(250);
    try {
      const retry = await attemptVision(opts);
      retry.meta.retriedForEmpty = true;
      retry.meta.emptyResult = isEffectivelyEmpty(retry.result);
      payload = retry;
    } catch {
      payload.meta.emptyResult = true;
    }
  }
  return payload;
}

async function attemptVision({ image, settings, pageTitle = '', pageUrl = '', sourceSite = '', keepalive, externalSignal }) {
  if (!settings?.apiKey) {
    throw new VisionError('还没有配置 API Key。请打开扩展设置，填入 Key 后即可识别。', { code: 'nokey' });
  }
  if (!image) throw new VisionError('截图内容为空，请重新截图。', { code: 'noimage' });

  const urls = chatUrlCandidates(settings.apiBase);
  if (!urls.length) throw new VisionError('接口地址为空，请在设置里填写。', { code: 'nobase' });

  const controller = new AbortController();
  const timeout = Number(settings.timeoutMs) || 120000;
  let timer = null;
  const started = Date.now();
  const stopKeepalive = keepalive?.(() => controller.abort());

  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });

  const attempts = [];
  let lastError = null;

  try {
    for (const url of urls) {
      for (const withJsonMode of [true, false]) {
        if (attempts.includes(`${url}|${withJsonMode}`)) continue;
        attempts.push(`${url}|${withJsonMode}`);
        const body = buildRequestBody({ settings, image, pageTitle, pageUrl, sourceSite, withJsonMode });
        timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
        let text = '';
        let res = null;
        try {
          ({ res, text } = await doFetch(url, { settings, body, signal: controller.signal }));
        } catch (err) {
          clearTimeout(timer);
          const aborted = controller.signal.aborted;
          const reason = controller.signal.reason;
          const isTimeout = aborted && reason?.message === 'timeout';
          lastError = new VisionError(
            isTimeout ? `识别超时（超过 ${Math.round(timeout / 1000)} 秒）。` : aborted ? '已取消识别。' : `网络请求失败：${err?.message || err}`,
            { code: isTimeout ? 'timeout' : aborted ? 'aborted' : 'network', retryable: true, endpoint: url },
          );
          if (!isTimeout && !aborted) continue; // 网络问题换下一个地址试
          throw lastError;
        }
        clearTimeout(timer);

        if (res.ok) {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            lastError = new VisionError('接口返回的不是合法 JSON。', { code: 'badjson', status: res.status, endpoint: url, detail: text.slice(0, 300) });
            continue;
          }
          const choice = data?.choices?.[0];
          const { content, reasoning } = pickContent(choice?.message);
          let raw = extractJson(content);
          let usedReasoning = false;
          if (!raw && reasoning) {
            raw = extractJson(reasoning);
            usedReasoning = Boolean(raw);
          }
          if (!raw) {
            lastError = new VisionError('模型没有返回可解析的 JSON 结果，可点「重新识别」再试一次。', {
              code: 'nojson',
              status: res.status,
              endpoint: url,
              detail: (content || reasoning || '').slice(0, 300),
              retryable: true,
            });
            continue;
          }
          const result = normalizeResult(raw, { pageTitle, pageUrl, sourceSite });
          return {
            ok: true,
            result,
            raw,
            meta: {
              model: data.model || settings.model,
              endpoint: url,
              ms: Date.now() - started,
              usage: data.usage || null,
              finishReason: choice?.finish_reason || '',
              usedReasoningFallback: usedReasoning,
            },
          };
        }

        const info = describeHttpError(res.status, text);
        lastError = new VisionError(info.msg, {
          code: info.code,
          status: res.status,
          endpoint: url,
          detail: text.slice(0, 400),
          retryable: info.retryable,
        });
        // 地址 404 / JSON 模式不支持 → 换下一个候选地址或降级重试
        if (info.code === 'notfound' || info.code === 'jsonmode') continue;
        throw lastError;
      }
    }
    throw lastError || new VisionError('识别失败，请稍后重试。', { code: 'unknown' });
  } finally {
    if (timer) clearTimeout(timer);
    stopKeepalive?.();
    externalSignal?.removeEventListener('abort', abort);
  }
}

/**
 * 设置页的连通性自检：发一张小图，确认地址、Key、模型、视觉、JSON 四项都通。
 * 图片不能太小（部分接口对 1×1 会直接报错），这里用 96×96 的简单图形。
 */
export async function testConnection(settings) {
  const probe =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABqklEQVR42u3cwW3DMAyFYYXIvUPkkAG6/wgZIIcOkXsAZ4EWla0nUqR/nQOE/PJkw0LMy7ZtjfX3MggAAggggAACCCCAWL+ta+zX/9zvPR+7PZ9RFV78HzU6URbB8gMadImS8gCS03gyzQWaSuPDNAvIjWY2kx4ohGYekxXTkddgxXTklWi22Do08u1mhXUktVlhHUmFVltnvE4rrzNYLccdc4ByxWekZjuJzuHK7Tw6x+rnGiQFyh6fA12QIB1Qjfjs7YUEiYAqxWdXRyRIAVQvPv19kSCA2uQjV/n++n4N/SHg8fVujseyJIgtBlAkUNUbfH+PJIgtBhBAAAEEEEAAsQACCKDlgALfImlr/I+RBLHFAGrhL7MUPjb79yJLgthiDkBVb/Y9fZEgEVC9EHV2RIJ0QJVC1N8LCZIC1QjRri5IkBooe4j21m/rT8+IfYXVUkwYCXzBl2vQNKBcITpcrSUa5RNSp6UY4hNYoWUZdBRVm3L6y1Ins6qfzdLNzHKuxDLOFfOsgQlUzDBjCl5jjmLxOYpM4mSWK0/zLIAAAggggAAC6HTrA/r4wHuCApJgAAAAAElFTkSuQmCC';
  const started = Date.now();
  try {
    const { raw, meta } = await analyzeScreenshot({
      image: probe,
      settings: { ...settings, promptTemplate: '这张图里有一个圆形和一个方块。只输出 JSON：{"shape":"图中最大图形的形状","color":"该图形的颜色"}' },
      pageTitle: '连通性测试',
    });
    return {
      ok: true,
      ms: Date.now() - started,
      model: meta.model,
      endpoint: meta.endpoint,
      usage: meta.usage,
      // 直接回显模型原始返回，方便确认它真的"看"到了图，而不是只返回了一个空壳
      sample: JSON.stringify(raw).slice(0, 300),
      // 连通性探针的字段名和 JD 字段不同，这里只看原始返回里有没有任何非空内容
      emptyResult: !Object.values(raw || {}).some(
        (v) => (typeof v === 'string' && v.trim()) || typeof v === 'number' || (Array.isArray(v) && v.length),
      ),
    };
  } catch (err) {
    if (err instanceof VisionError) {
      return { ok: false, code: err.code, message: err.message, status: err.status, endpoint: err.endpoint, detail: err.detail };
    }
    return { ok: false, code: 'unknown', message: String(err?.message || err) };
  }
}

export { originPattern, toTs };
