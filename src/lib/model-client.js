/**
 * 通用模型客户端：知识库的文本/图像任务共用一条请求链路。
 *
 * 与 JD 的 `vision.js` 的关系（design.md §7）：
 * - 复用同一套设置（接口地址候选、Key、模型、超时）与同一种请求容错策略（地址与 JSON 模式降级）；
 * - 但请求体、提示词与输出校验都是任务专属的，绝不改写 JD 的字段与提示词；
 * - 只在 background 里调用，页面与内容脚本拿不到 API Key。
 */

import { chatUrlCandidates } from './settings.js';
import { sleep } from './util.js';

export class ModelError extends Error {
  constructor(message, { code = 'unknown', status = 0, endpoint = '', detail = '', retryable = false } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** 把 HTTP 错误翻译成用户看得懂的中文提示（与 JD 识别保持一致的措辞风格）。 */
export function describeHttpError(status, bodyText) {
  const body = String(bodyText || '');
  if (status === 401 || status === 403) {
    return { code: 'auth', msg: 'API Key 无效或没有该模型权限，请在设置里检查 Key（401/403）。', retryable: false };
  }
  if (status === 402) return { code: 'quota', msg: '账户余额不足（402），请先充值。', retryable: false };
  if (status === 404) return { code: 'notfound', msg: '接口地址或模型名不存在（404），请检查「接口地址」与「模型名」。', retryable: false };
  if (status === 413) return { code: 'toolarge', msg: '这次输入太大了（413），请减少参考题或分批导入。', retryable: false };
  if (status === 429) return { code: 'ratelimit', msg: '触发限流（429），稍后重试即可。', retryable: true };
  if (status >= 500) return { code: 'server', msg: `模型服务端错误（${status}），可重试。`, retryable: true };
  if (/response_format|json_object/i.test(body)) {
    return { code: 'jsonmode', msg: '该接口不支持 JSON 模式，已自动降级重试。', retryable: true };
  }
  if (/(does not|doesn't|not)\s+support[^.]{0,40}(image|vision|multimodal)|vision|multimodal|modality/i.test(body)) {
    return { code: 'novision', msg: '当前模型不接受图片输入，请在设置里换成支持视觉的模型。', retryable: false };
  }
  if (/image[^.]{0,40}(too small|invalid|decode|corrupt|format|size|unsupported)/i.test(body)) {
    return { code: 'badimage', msg: '接口无法解析这张图片，换一张更清晰的截图（或先另存为 JPG/PNG）再试。', retryable: true };
  }
  if (/context length|too many tokens|maximum context/i.test(body)) {
    return { code: 'toolarge', msg: '输入超过了模型的上下文长度，请减少参考题或缩短文档后重试。', retryable: false };
  }
  return { code: 'http', msg: `请求失败（${status}）：${body.slice(0, 200)}`, retryable: status >= 500 };
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

/** 兼容 content 为数组、或只有 reasoning_content 的网关。 */
function pickContent(message) {
  if (!message) return { content: '', reasoning: '' };
  let content = message.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return { content: content || '', reasoning: message.reasoning_content || '' };
}

function buildBody({ settings, messages, images, jsonMode, temperature, maxTokens }) {
  const list = messages.map((m) => ({ ...m }));
  if (images?.length) {
    const idx = list.findIndex((m) => m.role === 'user');
    const target = idx === -1 ? list.length : idx;
    const base = list[target] || { role: 'user', content: '' };
    const text = typeof base.content === 'string' ? base.content : '';
    list[target] = {
      role: 'user',
      content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
    };
  }
  const body = {
    model: settings.model || 'deepseek-flash',
    messages: list,
    max_tokens: Number(maxTokens ?? settings.maxTokens) || 4096,
    temperature,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

function assertReady(settings, { hasInput }) {
  if (!settings?.apiKey) {
    throw new ModelError('还没有配置 API Key。请打开扩展设置，填入 Key 后重试。', { code: 'nokey' });
  }
  if (!hasInput) throw new ModelError('没有可发送的内容。', { code: 'noinput' });
  const urls = chatUrlCandidates(settings.apiBase);
  if (!urls.length) throw new ModelError('接口地址为空，请在设置里填写。', { code: 'nobase' });
  return urls;
}

/**
 * 发一次对话请求，返回正文与元信息。地址/JSON 模式不支持时自动降级重试。
 * @returns {Promise<{text:string, json:object|null, meta:object}>}
 */
export async function chatComplete({
  settings,
  messages,
  images = [],
  jsonMode = false,
  temperature = 0.2,
  maxTokens,
  signal,
  keepalive,
}) {
  const hasInput = (Array.isArray(messages) && messages.some((m) => String(m?.content ?? '').trim() || m?.parts)) || images.length > 0;
  const urls = assertReady(settings, { hasInput });

  const controller = new AbortController();
  const timeout = Number(settings.timeoutMs) || 120000;
  const started = Date.now();
  const stopKeepalive = keepalive?.(() => controller.abort());
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  const attempts = [];
  let lastError = null;
  let timer = null;

  try {
    for (const url of urls) {
      for (const withJson of jsonMode ? [true, false] : [false]) {
        const key = `${url}|${withJson}`;
        if (attempts.includes(key)) continue;
        attempts.push(key);
        const body = buildBody({ settings, messages, images, jsonMode: withJson, temperature, maxTokens });
        timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
        let text = '';
        let res = null;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          text = await res.text();
        } catch (err) {
          clearTimeout(timer);
          const aborted = controller.signal.aborted;
          const reason = controller.signal.reason;
          const isTimeout = aborted && reason?.message === 'timeout';
          lastError = new ModelError(
            isTimeout
              ? `请求超时（超过 ${Math.round(timeout / 1000)} 秒）。`
              : aborted
                ? '已取消。'
                : `网络请求失败：${err?.message || err}`,
            { code: isTimeout ? 'timeout' : aborted ? 'aborted' : 'network', retryable: true, endpoint: url },
          );
          if (isTimeout || aborted) throw lastError;
          continue; // 网络问题换下一个地址试
        }
        clearTimeout(timer);

        if (res.ok) {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            lastError = new ModelError('接口返回的不是合法 JSON。', {
              code: 'badjson',
              status: res.status,
              endpoint: url,
              detail: text.slice(0, 300),
            });
            continue;
          }
          const choice = data?.choices?.[0];
          const { content, reasoning } = pickContent(choice?.message);
          const meta = {
            model: data.model || settings.model,
            endpoint: url,
            ms: Date.now() - started,
            usage: data.usage || null,
            finishReason: choice?.finish_reason || '',
            usedJsonMode: withJson,
          };
          const json = withJson || jsonMode ? extractJson(content) || extractJson(reasoning) : null;
          return { text: content || reasoning || '', json, meta };
        }

        const info = describeHttpError(res.status, text);
        lastError = new ModelError(info.msg, {
          code: info.code,
          status: res.status,
          endpoint: url,
          detail: text.slice(0, 400),
          retryable: info.retryable,
        });
        if (info.code === 'notfound' || info.code === 'jsonmode') continue;
        throw lastError;
      }
    }
    throw lastError || new ModelError('请求失败，请稍后重试。', { code: 'unknown' });
  } finally {
    if (timer) clearTimeout(timer);
    stopKeepalive?.();
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * 要求结构化 JSON 的任务。空返回会重试一次（模型偶发空壳响应），
 * 两次都空则抛出可读错误，由调用方决定如何提示。
 *
 * @param {function} [isEmpty] 判断解析结果是否等于"什么都没提取到"
 */
export async function chatJson(opts) {
  const { isEmpty, retryDelayMs = 250 } = opts;
  const first = await chatComplete({ ...opts, jsonMode: true });
  const firstJson = first.json;
  const useless = firstJson == null || (typeof isEmpty === 'function' && isEmpty(firstJson));
  if (!useless) return { json: firstJson, raw: first.text, meta: first.meta, retriedForEmpty: false };

  if (firstJson == null) {
    // 连 JSON 都没解析出来：换一次普通模式（有些网关在 JSON 模式下会返回空壳）
    try {
      const retry = await chatComplete({ ...opts, jsonMode: false });
      const json = extractJson(retry.text);
      if (json && (!isEmpty || !isEmpty(json))) {
        return { json, raw: retry.text, meta: retry.meta, retriedForEmpty: true };
      }
    } catch (err) {
      if (err instanceof ModelError && ['nokey', 'nobase', 'aborted', 'auth', 'quota'].includes(err.code)) throw err;
    }
  } else {
    await sleep(retryDelayMs);
    try {
      const retry = await chatComplete({ ...opts, jsonMode: true });
      const json = retry.json;
      if (json && (!isEmpty || !isEmpty(json))) {
        return { json, raw: retry.text, meta: retry.meta, retriedForEmpty: true };
      }
    } catch (err) {
      if (err instanceof ModelError && ['nokey', 'nobase', 'aborted', 'auth', 'quota'].includes(err.code)) throw err;
    }
  }

  throw new ModelError('模型没有返回可用的内容，可能是截图不清晰或这次是偶发空返回，请重试一次。', {
    code: 'empty',
    endpoint: first.meta?.endpoint || '',
    detail: (first.text || '').slice(0, 300),
    retryable: true,
  });
}

/** 只要一段 Markdown 文本的任务（例如生成回答草稿）。 */
export async function chatText(opts) {
  const out = await chatComplete({ ...opts, jsonMode: false });
  const text = String(out.text || '').trim();
  if (!text) {
    throw new ModelError('模型返回了空内容，请重试一次。', {
      code: 'empty',
      endpoint: out.meta?.endpoint || '',
      detail: '',
      retryable: true,
    });
  }
  return { text, meta: out.meta };
}
