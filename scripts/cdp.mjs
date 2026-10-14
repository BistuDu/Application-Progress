/**
 * 极简 CDP 客户端：只依赖 Node 24 自带的 WebSocket，用来在真实 Chrome 里验证扩展。
 */

export async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(t);
        reject(new Error(`WebSocket 连接失败：${e?.message || 'unknown'}`));
      });
    });
    return new CDP(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(payload);
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 在页面/worker 里求值；userGesture 让 chrome.permissions 等 API 可用 */
  async eval(expression, { awaitPromise = true, userGesture = false, contextId } = {}) {
    const params = {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture,
      allowUnsafeEvalBlockedByCSP: true,
    };
    if (contextId != null) params.contextId = contextId;
    const out = await this.send('Runtime.evaluate', params, 120000);
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error(`页面内异常：${d.exception?.description || d.text}`);
    }
    return out.result?.value;
  }

  /** 截图，返回 base64（不含 data: 前缀） */
  async screenshot({ format = 'jpeg', quality = 80 } = {}) {
    const out = await this.send('Page.captureScreenshot', { format, quality, captureBeyondViewport: false });
    return out.data;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 250, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待「${label}」超时${lastErr ? `：${lastErr.message}` : ''}`);
}

/** 起一个只服务静态文件的小 HTTP 服务 */
export async function startStaticServer(rootDir, port = 8765) {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const types = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(rootDir, urlPath === '/' ? 'testpage.html' : urlPath);
    if (!file.startsWith(rootDir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    url: (p = '/testpage.html') => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
