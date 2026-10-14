/**
 * 页内交互层（内容脚本，纯 IIFE，无模块依赖，可安全重复注入）。
 * 三个状态：框选截图 → 识别中 → 结果审阅面板。
 * 全部 UI 放在 Shadow DOM 里，宿主节点设 pointer-events:none，只有交互元素接管事件，
 * 这样面板存在时页面依然可以正常点击。
 */

(() => {
  if (window.__JDT_OVERLAY_LOADED__) return;
  window.__JDT_OVERLAY_LOADED__ = true;

  const HOST_ID = 'jdt-overlay-host';
  const Z = 2147483647;

  const state = {
    phase: 'idle', // idle | selecting | processing | review | done
    mode: 'region',
    dataUrl: '',
    settings: {},
    statuses: [],
    crop: '',
    result: null,
    meta: null,
    requestId: '',
    duplicates: [],
    timer: null,
    startedAt: 0,
    drag: null,
    skills: [],
  };

  let host = null;
  let root = null;
  let img = null;

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const el = (sel) => root?.querySelector(sel);
  const els = (sel) => Array.from(root?.querySelectorAll(sel) || []);

  function fmtDateInput(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function send(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res || { ok: false, error: '扩展没有响应。' };
    } catch (err) {
      const msg = String(err?.message || err);
      if (/Extension context invalidated|Receiving end does not exist|message channel closed/i.test(msg)) {
        return { ok: false, error: '扩展已更新或已卸载，请刷新页面后重试。', fatal: true };
      }
      return { ok: false, error: msg };
    }
  }

  const STATUS_FALLBACK = [
    { name: '已投递', color: '#3b82f6' },
    { name: '筛选中', color: '#8b5cf6' },
    { name: '测评中', color: '#f59e0b' },
    { name: '面试', color: '#06b6d4' },
    { name: 'Offer', color: '#10b981' },
    { name: '拒绝/已结束', color: '#ef4444' },
    { name: '待确认', color: '#94a3b8' },
  ];

  function statusColor(name) {
    const list = state.statuses.length ? state.statuses : STATUS_FALLBACK;
    return list.find((s) => s.name === name)?.color || '#94a3b8';
  }

  /* ---------------------------------------------------------------- */
  /* 挂载 / 卸载                                                       */
  /* ---------------------------------------------------------------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .wrap {
      position: fixed; inset: 0; z-index: ${Z};
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif;
      font-size: 13px; line-height: 1.5; color: #0f172a; color-scheme: light;
      -webkit-font-smoothing: antialiased;
    }
    .wrap > * { pointer-events: auto; }
    button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
    input, textarea, select { font: inherit; color: inherit; }

    /* ---------- 框选 ---------- */
    .shot { position: fixed; inset: 0; width: 100vw; height: 100vh; user-select: none; -webkit-user-drag: none; }
    .veil { position: fixed; inset: 0; background: rgba(15,23,42,.45); }
    .cursor-cross { position: fixed; inset: 0; cursor: crosshair; }
    .sel {
      position: fixed; border: 2px solid #60a5fa; border-radius: 2px;
      box-shadow: 0 0 0 9999px rgba(15,23,42,.55); background: rgba(96,165,250,.06);
      pointer-events: none;
    }
    .sel-size {
      position: absolute; right: -1px; bottom: -24px; background: #1e293b; color: #fff;
      font-size: 11px; padding: 2px 7px; border-radius: 5px; white-space: nowrap;
    }
    .tipbar {
      position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 14px;
      background: rgba(15,23,42,.94); color: #f8fafc; border-radius: 12px;
      padding: 10px 14px; box-shadow: 0 12px 32px rgba(0,0,0,.4); max-width: 92vw;
    }
    .tipbar .kbd { background: #334155; border-radius: 4px; padding: 1px 6px; font-size: 11px; margin: 0 2px; }
    .tipbar .btn-lite { color: #cbd5e1; padding: 4px 10px; border-radius: 8px; }
    .tipbar .btn-lite:hover { background: #334155; color: #fff; }

    /* ---------- 识别中 ---------- */
    .center { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(15,23,42,.42); }
    .card {
      background: #fff; border-radius: 16px; padding: 20px 22px; width: 340px;
      box-shadow: 0 24px 64px rgba(15,23,42,.34); text-align: center;
    }
    .spinner {
      width: 34px; height: 34px; margin: 2px auto 12px; border-radius: 50%;
      border: 3px solid #dbeafe; border-top-color: #2563eb; animation: jdt-spin .8s linear infinite;
    }
    @keyframes jdt-spin { to { transform: rotate(360deg); } }
    .card h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .card p { margin: 0; color: #64748b; font-size: 12.5px; }
    .thumb-sm { max-width: 100%; max-height: 92px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 12px; object-fit: contain; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 8px 14px; border-radius: 9px; font-weight: 500; transition: .15s;
      background: #f1f5f9; color: #334155;
    }
    .btn:hover { background: #e2e8f0; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-ghost { background: transparent; color: #64748b; }
    .btn-ghost:hover { background: #f1f5f9; }
    .btn[disabled] { opacity: .55; cursor: not-allowed; }
    .mt10 { margin-top: 10px; }
    .mt14 { margin-top: 14px; }

    /* ---------- 审阅面板 ---------- */
    .panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: 428px; max-width: 96vw;
      background: #fff; box-shadow: -18px 0 48px rgba(15,23,42,.22);
      display: flex; flex-direction: column; animation: jdt-slide .22s ease-out;
    }
    @keyframes jdt-slide { from { transform: translateX(24px); opacity: .4; } }
    .p-head {
      display: flex; align-items: center; gap: 8px; padding: 13px 14px;
      border-bottom: 1px solid #eef2f7; flex-shrink: 0;
    }
    .p-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
    .p-head h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .p-head .chip { font-size: 11px; color: #475569; background: #f1f5f9; border-radius: 20px; padding: 2px 9px; }
    .icon-btn { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; color: #64748b; font-size: 15px; line-height: 1; }
    .icon-btn:hover { background: #f1f5f9; color: #0f172a; }
    .p-body { flex: 1; overflow-y: auto; padding: 14px; }
    .p-body::-webkit-scrollbar { width: 9px; }
    .p-body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 9px; border: 3px solid #fff; }
    .shot-preview { width: 100%; border-radius: 10px; border: 1px solid #e2e8f0; cursor: zoom-in; display: block; }
    .banner { border-radius: 10px; padding: 9px 11px; font-size: 12.5px; margin-bottom: 12px; display: flex; gap: 8px; align-items: flex-start; }
    .banner-warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
    .banner-err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .banner-info { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
    .banner strong { font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .field.full { grid-column: 1 / -1; }
    .field label { font-size: 11.5px; color: #64748b; font-weight: 500; }
    .field input, .field select, .field textarea {
      width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; padding: 7px 9px;
      background: #fff; outline: none; transition: .15s; font-size: 13px;
    }
    .field input:focus, .field select:focus, .field textarea:focus {
      border-color: #93c5fd; box-shadow: 0 0 0 3px rgba(59,130,246,.14);
    }
    .field textarea { resize: vertical; min-height: 74px; line-height: 1.6; font-size: 12.5px; }
    .field select.s-status { font-weight: 600; }
    .sec { margin-top: 14px; }
    .sec-title { font-size: 11.5px; color: #64748b; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
    .sec-title button { font-size: 11.5px; color: #2563eb; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip-skill { background: #eff6ff; color: #1d4ed8; border-radius: 6px; padding: 3px 8px; font-size: 11.5px; }
    .p-foot { border-top: 1px solid #eef2f7; padding: 11px 14px; display: flex; gap: 9px; align-items: center; flex-shrink: 0; }
    .p-foot .grow { flex: 1; }
    .p-foot .hint { font-size: 11.5px; color: #94a3b8; }
    .summary { background: #f8fafc; border-radius: 9px; padding: 9px 11px; font-size: 12.5px; color: #475569; margin-top: 12px; }
    .cuetoast {
      position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
      background: #0f172a; color: #f8fafc; border-radius: 11px; padding: 10px 15px;
      box-shadow: 0 14px 36px rgba(0,0,0,.34); display: flex; align-items: center; gap: 11px;
      font-size: 13px; max-width: 90vw; animation: jdt-pop .2s ease-out;
    }
    @keyframes jdt-pop { from { transform: translate(-50%, 10px); opacity: 0; } }
    .cuetoast a { color: #93c5fd; text-decoration: underline; cursor: pointer; }
    .cuetoast .ok { color: #4ade80; }
    .zoom { position: fixed; inset: 0; background: rgba(2,6,23,.9); display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
    .zoom img { max-width: 94vw; max-height: 94vh; border-radius: 8px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  `;

  function mount() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = `all: initial; position: fixed; inset: 0; width: 0; height: 0; z-index: ${Z};`;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    root = wrap;
  }

  function unmount() {
    clearInterval(state.timer);
    state.timer = null;
    if (host?.parentNode) host.parentNode.removeChild(host);
    host = null;
    root = null;
    img = null;
    document.removeEventListener('keydown', onKeyDown, true);
    state.phase = 'idle';
  }

  function setPhase(p) {
    state.phase = p;
  }

  /* ---------------------------------------------------------------- */
  /* 框选                                                              */
  /* ---------------------------------------------------------------- */

  function showSelector({ dataUrl, mode }) {
    mount();
    setPhase('selecting');
    state.dataUrl = dataUrl;

    if (mode === 'viewport') {
      state.crop = dataUrl;
      startAnalysis(dataUrl);
      return;
    }

    root.innerHTML = `
      <img class="shot" src="${esc(dataUrl)}" alt="">
      <div class="veil" hidden></div>
      <div class="cursor-cross" id="jdt-cross"></div>
      <div class="sel" id="jdt-sel" hidden><div class="sel-size" id="jdt-size"></div></div>
      <div class="tipbar">
        <span>拖拽框选 JD 区域</span>
        <span><span class="kbd">Enter</span> 整屏</span>
        <span><span class="kbd">Esc</span> 取消</span>
        <button class="btn-lite" id="jdt-full">使用整屏</button>
      </div>`;

    img = el('.shot');
    const cross = el('#jdt-cross');
    const sel = el('#jdt-sel');
    const size = el('#jdt-size');

    const rectOf = (e) => {
      const x = Math.max(0, Math.min(e.clientX, window.innerWidth));
      const y = Math.max(0, Math.min(e.clientY, window.innerHeight));
      return { x, y };
    };

    const draw = () => {
      const d = state.drag;
      if (!d) return;
      const left = Math.min(d.x0, d.x1);
      const top = Math.min(d.y0, d.y1);
      const w = Math.abs(d.x1 - d.x0);
      const h = Math.abs(d.y1 - d.y0);
      const disp = window.devicePixelRatio || 1;
      sel.hidden = false;
      sel.style.left = `${left}px`;
      sel.style.top = `${top}px`;
      sel.style.width = `${w}px`;
      sel.style.height = `${h}px`;
      const sx = (img?.naturalWidth || window.innerWidth * disp) / Math.max(1, window.innerWidth);
      const sy = (img?.naturalHeight || window.innerHeight * disp) / Math.max(1, window.innerHeight);
      size.textContent = `${Math.round(w * sx)} × ${Math.round(h * sy)} px`;
    };

    const finish = async (rect) => {
      if (rect.w < 12 || rect.h < 12) {
        state.drag = null;
        sel.hidden = true;
        return;
      }
      document.removeEventListener('keydown', onKeyDown, true);
      setPhase('processing');
      root.innerHTML = `<div class="center"><div class="card">
        <div class="spinner"></div>
        <h3>正在裁剪…</h3>
        <p>马上交给模型识别</p>
      </div></div>`;
      const cropped = await cropToDataUrl(rect);
      state.crop = cropped;
      startAnalysis(cropped);
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      const p = rectOf(e);
      state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      cross.setPointerCapture?.(e.pointerId);
      draw();
    };
    const onMove = (e) => {
      if (!state.drag) return;
      const p = rectOf(e);
      state.drag.x1 = p.x;
      state.drag.y1 = p.y;
      draw();
    };
    const onUp = () => {
      const d = state.drag;
      if (!d) return;
      const rect = {
        x: Math.min(d.x0, d.x1),
        y: Math.min(d.y0, d.y1),
        w: Math.abs(d.x1 - d.x0),
        h: Math.abs(d.y1 - d.y0),
      };
      state.drag = null;
      finish(rect);
    };

    cross.addEventListener('pointerdown', onDown);
    cross.addEventListener('pointermove', onMove);
    cross.addEventListener('pointerup', onUp);
    el('#jdt-full').addEventListener('click', () => {
      document.removeEventListener('keydown', onKeyDown, true);
      state.crop = dataUrl;
      startAnalysis(dataUrl);
    });

    document.addEventListener('keydown', onKeyDown, true);
    window.__JDT_CANCEL__ = () => unmount();
  }

  async function cropToDataUrl(rect) {
    const image = await loadImage(state.dataUrl);
    const sx = image.naturalWidth / Math.max(1, window.innerWidth);
    const sy = image.naturalHeight / Math.max(1, window.innerHeight);
    const pad = 6; // 稍微外扩，避免把边界文字切掉
    const x = Math.max(0, Math.floor(rect.x * sx) - pad);
    const y = Math.max(0, Math.floor(rect.y * sy) - pad);
    const w = Math.min(image.naturalWidth - x, Math.ceil(rect.w * sx) + pad * 2);
    const h = Math.min(image.naturalHeight - y, Math.ceil(rect.h * sy) + pad * 2);

    const maxSide = Number(state.settings.cropMaxSide) || 1800;
    const quality = Number(state.settings.cropQuality) || 0.9;
    const scale = Math.min(1, maxSide / Math.max(w, h));

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('截图载入失败'));
      im.src = src;
    });
  }

  /* ---------------------------------------------------------------- */
  /* 识别中                                                            */
  /* ---------------------------------------------------------------- */

  async function startAnalysis(image) {
    mount();
    setPhase('processing');
    state.startedAt = Date.now();
    state.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    state.crop = image;

    root.innerHTML = `
      <div class="center"><div class="card">
        <div class="spinner"></div>
        <h3>${esc(state.settings.model || 'deepseek-flash')} 正在识别 JD 截图</h3>
        <p id="jdt-elapsed">已用 0.0 秒 · 通常 3-10 秒</p>
        <img class="thumb-sm" src="${esc(image)}" alt="">
        <div class="mt14"><button class="btn btn-ghost" id="jdt-abort">取消识别</button></div>
      </div></div>`;

    const elapsed = el('#jdt-elapsed');
    state.timer = setInterval(() => {
      if (!elapsed) return;
      const s = ((Date.now() - state.startedAt) / 1000).toFixed(1);
      elapsed.textContent = `已用 ${s} 秒 · 通常 3-10 秒`;
    }, 200);

    el('#jdt-abort').addEventListener('click', abortAnalysis);

    const res = await send({
      type: 'ANALYZE',
      requestId: state.requestId,
      image,
      pageTitle: document.title,
      pageUrl: location.href,
    });
    if (!res.ok) showError(res.error || '识别失败。', res);
  }

  async function abortAnalysis() {
    const id = state.requestId;
    clearInterval(state.timer);
    state.timer = null;
    if (id) await send({ type: 'ANALYZE_ABORT', requestId: id });
    toast('已取消识别', []);
  }

  function onResult(msg) {
    if (msg.requestId && state.requestId && msg.requestId !== state.requestId) return;
    if (state.phase === 'done' || state.phase === 'idle') return;
    clearInterval(state.timer);
    state.timer = null;
    if (!msg.ok) {
      showError(msg.error || '识别失败。', msg);
      return;
    }
    state.result = msg.result;
    state.meta = msg.meta;
    state.skills = [...(msg.result.skills || [])];
    showReview();
  }

  function showError(message, meta = {}) {
    mount();
    setPhase('processing');
    const canRetry = meta.retryable !== false;
    const detail = meta.detail ? `<div class="summary" style="text-align:left;word-break:break-all;max-height:90px;overflow:auto">${esc(meta.detail)}</div>` : '';
    root.innerHTML = `
      <div class="center"><div class="card">
        <h3 style="color:#b91c1c">识别失败</h3>
        <p style="text-align:left;margin-top:8px">${esc(message)}</p>
        ${detail}
        <div class="mt14" style="display:flex;gap:8px;justify-content:center">
          ${canRetry ? '<button class="btn btn-primary" id="jdt-retry">重试</button>' : ''}
          <button class="btn" id="jdt-codeset">检查设置</button>
          <button class="btn btn-ghost" id="jdt-close">关闭</button>
        </div>
      </div></div>`;
    el('#jdt-retry')?.addEventListener('click', () => startAnalysis(state.crop));
    el('#jdt-codeset').addEventListener('click', () => send({ type: 'OPEN_OPTIONS' }));
    el('#jdt-close').addEventListener('click', unmount);
  }

  /* ---------------------------------------------------------------- */
  /* 审阅面板                                                          */
  /* ---------------------------------------------------------------- */

  function statusOptions(selected) {
    const list = state.statuses.length ? state.statuses : STATUS_FALLBACK;
    return list
      .map((s) => `<option value="${esc(s.name)}"${s.name === selected ? ' selected' : ''}>${esc(s.name)}</option>`)
      .join('');
  }

  function showReview() {
    mount();
    setPhase('review');
    const r = state.result || {};
    const status = state.settings.defaultStatus || '已投递';
    const color = statusColor(status);
    const emptyResult = r.isJob !== false && !r.company && !r.title && !r.jd && !r.requirements;

    root.innerHTML = `
      <div class="panel">
        <div class="p-head">
          <span class="dot"></span>
          <h3>记录这次投递</h3>
          <span class="chip">${esc(state.meta?.model || state.settings.model || '')} · ${Math.round((state.meta?.ms || 0) / 100) / 10}s</span>
          <button class="icon-btn" id="jdt-recapture" title="重新截图">⟳</button>
          <button class="icon-btn" id="jdt-close2" title="关闭">✕</button>
        </div>
        <div class="p-body">
          ${
            emptyResult
              ? '<div class="banner banner-warn"><span>⚠️</span><div><strong>没能从截图里读出内容。</strong><br>可能是圈选范围里没有文字，或遇到模型偶发空返回。点右上角 ⟳ 重新框选一次。</div></div>'
              : ''
          }
          ${r.isJob === false ? '<div class="banner banner-warn"><span>⚠️</span><div><strong>这张截图看起来不像招聘信息。</strong><br>仍可手动补全字段后保存。</div></div>' : ''}
          <div id="jdt-dup"></div>
          ${state.crop ? `<img class="shot-preview" id="jdt-preview" src="${esc(state.crop)}" alt="截图预览" title="点击放大">` : ''}
          ${r.summary ? `<div class="summary">${esc(r.summary)}</div>` : ''}

          <div class="sec">
            <div class="grid">
              <div class="field full"><label>公司名称</label><input id="f-company" value="${esc(r.company)}" placeholder="例如：字节跳动"></div>
              <div class="field full"><label>岗位名称</label><input id="f-title" value="${esc(r.title)}" placeholder="例如：后端开发实习生"></div>
              <div class="field"><label>工作地点</label><input id="f-location" value="${esc(r.location)}" placeholder="北京"></div>
              <div class="field"><label>薪资</label><input id="f-salary" value="${esc(r.salary)}" placeholder="300-400/天"></div>
              <div class="field"><label>类型</label><input id="f-jobtype" value="${esc(r.jobType)}" placeholder="实习/校招/社招"></div>
              <div class="field"><label>学历要求</label><input id="f-education" value="${esc(r.education)}" placeholder="本科及以上"></div>
              <div class="field"><label>截止时间</label><input id="f-deadline" value="${esc(r.deadline)}" placeholder="2026-11-30"></div>
              <div class="field"><label>投递方式</label><input id="f-contact" value="${esc(r.contact)}" placeholder="邮箱 / 链接"></div>
              <div class="field"><label>状态</label>
                <select id="f-status" class="s-status" style="color:${color}">${statusOptions(status)}</select>
              </div>
              <div class="field"><label>投递日期</label><input id="f-applied" type="date" value="${fmtDateInput(Date.now())}"></div>
              <div class="field full"><label>下一步</label><input id="f-next" placeholder="例如：9/20 前完成在线测评"></div>
            </div>
          </div>

          <div class="sec">
            <div class="sec-title"><span>技能关键词</span><button id="jdt-addskill">+ 添加</button></div>
            <div class="chips" id="jdt-skills"></div>
          </div>

          <div class="sec">
            <div class="sec-title"><span>岗位职责</span><button data-toggle="jd">收起</button></div>
            <textarea id="f-jd" rows="6">${esc(r.jd)}</textarea>
          </div>

          <div class="sec">
            <div class="sec-title"><span>任职要求</span><button data-toggle="req">收起</button></div>
            <textarea id="f-req" rows="6">${esc(r.requirements)}</textarea>
          </div>

          <div class="sec">
            <div class="field"><label>备注</label><textarea id="f-notes" rows="2" placeholder="内推人、笔试时间、面试轮次…"></textarea></div>
          </div>

          <div class="sec">
            <div class="field full"><label>来源</label><input id="f-source" value="${esc(r.sourceSite || '')}" placeholder="站点"></div>
          </div>
        </div>
        <div class="p-foot">
          <span class="hint">${esc((location.hostname || '').replace(/^www\./, ''))}</span>
          <span class="grow"></span>
          <button class="btn btn-ghost" id="jdt-cancel">取消</button>
          <button class="btn btn-primary" id="jdt-save">保存记录</button>
        </div>
      </div>`;

    renderSkills();
    bindReview(status);
    checkDuplicate(r.company, r.title);
  }

  function renderSkills() {
    const box = el('#jdt-skills');
    if (!box) return;
    box.innerHTML =
      state.skills.length === 0
        ? '<span style="color:#94a3b8;font-size:12px">暂无，点「+ 添加」补充</span>'
        : state.skills.map((s, i) => `<span class="chip-skill" data-i="${i}" title="点击删除">${esc(s)}<span style="opacity:.55;margin-left:4px">×</span></span>`).join('');
    box.querySelectorAll('.chip-skill').forEach((node) => {
      node.addEventListener('click', () => {
        state.skills.splice(Number(node.dataset.i), 1);
        renderSkills();
      });
    });
  }

  async function checkDuplicate(company, title) {
    if (!state.settings.warnDuplicate) return;
    if (!company && !title) return;
    const res = await send({ type: 'CHECK_DUPLICATE', company, title });
    const box = el('#jdt-dup');
    if (!box) return;
    if (!res.ok || !res.duplicates?.length) {
      box.innerHTML = '';
      state.duplicates = [];
      return;
    }
    state.duplicates = res.duplicates;
    const first = res.duplicates[0];
    box.innerHTML = `
      <div class="banner banner-info"><span>🔁</span><div>
        <strong>已有一条相似记录：</strong>${esc(first.company || '未知公司')} · ${esc(first.title || '未知岗位')}（${esc(first.status)}）
        <div class="mt10" style="display:flex;gap:8px">
          <button class="btn" id="jdt-merge" style="padding:4px 10px">仍然保存为新记录</button>
          <button class="btn btn-primary" id="jdt-goto" style="padding:4px 10px">打开进度表查看</button>
        </div>
      </div></div>`;
    el('#jdt-merge')?.addEventListener('click', () => {
      box.innerHTML = '';
      state.duplicates = [];
    });
    el('#jdt-goto')?.addEventListener('click', () => send({ type: 'OPEN_DASHBOARD' }));
  }

  function bindReview(initialStatus) {
    el('#jdt-close2').addEventListener('click', unmount);
    el('#jdt-cancel').addEventListener('click', unmount);
    el('#jdt-recapture').addEventListener('click', async () => {
      unmount();
      await send({ type: 'RECAPTURE', mode: 'region' });
    });
    el('#jdt-preview')?.addEventListener('click', () => {
      root.insertAdjacentHTML('beforeend', `<div class="zoom" id="jdt-zoom"><img src="${esc(state.crop)}" alt=""></div>`);
      el('#jdt-zoom').addEventListener('click', () => el('#jdt-zoom')?.remove());
    });
    el('#f-status').addEventListener('change', (e) => {
      e.target.style.color = statusColor(e.target.value);
    });
    el('#jdt-addskill').addEventListener('click', () => {
      const v = prompt('添加技能关键词（多个用逗号分隔）');
      if (!v) return;
      v.split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => {
          if (!state.skills.includes(s)) state.skills.push(s);
        });
      renderSkills();
    });
    els('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ta = btn.dataset.toggle === 'jd' ? el('#f-jd') : el('#f-req');
        const hidden = ta.style.display === 'none';
        ta.style.display = hidden ? '' : 'none';
        btn.textContent = hidden ? '收起' : '展开';
      });
    });
    el('#jdt-save').addEventListener('click', save);
    void initialStatus;
  }

  async function save() {
    const btn = el('#jdt-save');
    const val = (id) => el(id)?.value?.trim() || '';
    const input = {
      company: val('#f-company'),
      title: val('#f-title'),
      location: val('#f-location'),
      salary: val('#f-salary'),
      jobType: val('#f-jobtype'),
      education: val('#f-education'),
      deadline: val('#f-deadline'),
      contact: val('#f-contact'),
      status: val('#f-status'),
      appliedAt: val('#f-applied') || Date.now(),
      nextAction: val('#f-next'),
      jd: val('#f-jd'),
      requirements: val('#f-req'),
      notes: val('#f-notes'),
      sourceSite: val('#f-source'),
      skills: state.skills,
      sourceUrl: location.href,
      pageTitle: document.title,
      screenshot: state.crop,
      aiRaw: state.result ? JSON.stringify(state.result.rawFields || {}) : '',
      aiMeta: state.meta || null,
    };
    if (!input.company && !input.title) {
      const go = confirm('公司名称和岗位名称都是空的，仍然保存吗？');
      if (!go) return;
    }
    btn.disabled = true;
    btn.textContent = '保存中…';
    const res = await send({ type: 'SAVE_RECORD', input });
    btn.disabled = false;
    btn.textContent = '保存记录';
    if (!res.ok) {
      toast(`保存失败：${res.error || ''}`, []);
      return;
    }
    setPhase('done');
    const dupNote = res.duplicates?.length ? `（已有 ${res.duplicates.length + 1} 条相似记录）` : '';
    const openDash = async () => {
      await send({ type: 'AFTER_SAVE', openDashboard: true });
      unmount();
    };
    if (state.settings.autoOpenDashboard) {
      await openDash();
      return;
    }
    toast(`已记录 ${input.company || ''} ${input.title || ''}${dupNote}`, [
      { label: '打开进度表', onClick: openDash },
      { label: '撤销', onClick: async () => { await send({ type: 'DELETE_RECORDS', ids: [res.record.id] }); unmount(); } },
    ], state.settings.closePanelAfterSave ? 4200 : 0);
    if (state.settings.closePanelAfterSave) {
      setTimeout(() => {
        if (state.phase === 'done') unmount();
      }, 4200);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 提示条                                                            */
  /* ---------------------------------------------------------------- */

  function toast(message, actions = [], autoHide = 3600) {
    if (!root) return;
    el('.cuetoast')?.remove();
    const node = document.createElement('div');
    node.className = 'cuetoast';
    node.innerHTML = `<span class="ok">✓</span><span>${esc(message)}</span>`;
    for (const a of actions) {
      const b = document.createElement('a');
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      node.appendChild(b);
    }
    root.appendChild(node);
    if (autoHide > 0) setTimeout(() => node.remove(), autoHide);
  }

  /* ---------------------------------------------------------------- */
  /* 键盘                                                              */
  /* ---------------------------------------------------------------- */

  function onKeyDown(e) {
    if (state.phase === 'selecting') {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        unmount();
      } else if (e.key === 'Enter' && !state.drag) {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', onKeyDown, true);
        state.crop = state.dataUrl;
        startAnalysis(state.dataUrl);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (state.phase === 'processing') {
        e.preventDefault();
        abortAnalysis();
      } else if (state.phase === 'review') {
        e.preventDefault();
        e.stopPropagation();
        unmount();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 消息                                                              */
  /* ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'JDT_PING') {
      respond({ pong: true });
      return false;
    }
    if (msg.type === 'JDT_SHOW_SELECTOR') {
      state.settings = {
        ...state.settings,
        statuses: msg.statuses,
        defaultStatus: msg.defaultStatus,
        model: msg.model,
        cropMaxSide: msg.cropMaxSide,
        cropQuality: msg.cropQuality,
        warnDuplicate: msg.warnDuplicate,
        closePanelAfterSave: msg.closePanelAfterSave,
        autoOpenDashboard: msg.autoOpenDashboard,
      };
      state.statuses = msg.statuses?.length ? msg.statuses : state.statuses;
      showSelector(msg);
      respond({ ok: true });
      return false;
    }
    if (msg.type === 'JDT_ANALYZE_RESULT') {
      onResult(msg);
      respond({ ok: true });
      return false;
    }
    return false;
  });
})();
