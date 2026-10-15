/** 常驻磨砂入口。桥接仅存在于扩展 isolated world，全部资源随扩展分发。 */
(() => {
  if (globalThis.__JDT_ISLAND__) { globalThis.__JDT_ISLAND__.mount(); return; }
  if (window.top !== window || !globalThis.JDTIslandCore) return;
  const C = globalThis.JDTIslandCore;
  const coarsePointer = matchMedia('(pointer: coarse)');
  const documentId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let prefs = { position: { x: 1, y: 0 }, disabledHosts: [] };
  let reasons = new Set(), mode = 'collapsed', host, shadow, surface, drag, task, deferred;
  let timer, terminalTimer, tipTimer, panelTimer, lastRenderMode, observer, mountAbort;
  let bounds, menuOpen = false, tipTarget = null, dead = false, suppressClick = false, capturing = false;
  const captureTimers = new Map();
  const abort = new AbortController(), listeners = { signal: abort.signal };
  const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  // 本地单色线条图标；不加载字体、图标库或远程脚本。
  const icons = {
    island: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M8 12h8"/>'),
    job: svg('<path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M3 11c5 4 13 4 18 0M10 12v2h4v-2"/><rect x="3" y="7" width="18" height="13" rx="3"/>'),
    question: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3M8 8h8M8 12h8M8 16h5"/>'),
    dashboard: svg('<path d="M4 20v-5m5 5v-7m5 7v-4m5 4V9M3 10l6-6 5 5 7-7m-5 0h5v5"/>'),
    knowledge: svg('<path d="M12 6v14M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2Z"/>'),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    reset: svg('<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>'),
    hide: svg('<path d="m3 3 18 18M10 5c5-1 9 3 11 7a19 19 0 0 1-4 5M7 7a20 20 0 0 0-4 5c3 6 9 8 14 5M10 10a3 3 0 0 0 4 4"/>'),
    check: svg('<path d="m6 12 4 4 8-8"/>'),
    error: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>'),
    cancel: svg('<path d="m7 7 10 10M7 17 17 7"/>'),
  };
  const css = `
    :host {
      all:initial;
      --ink:#252b34;--secondary:#626d7d;--line:#dfe5ed;--solid:#f9fbfe;
      --glass:rgba(250,252,255,.78);--edge:rgba(255,255,255,.93);
      --hover:rgba(33,49,75,.065);--shadow:rgba(24,39,64,.13);--inner:rgba(255,255,255,.9);
      --focus:#386edf;--ok:#278262;--error:#b14843;
    }
    @media(prefers-color-scheme:dark) {
      :host {--ink:#eceef4;--secondary:#b0b8c5;--line:#444b58;--solid:#252a33;
        --glass:rgba(35,39,48,.78);--edge:rgba(255,255,255,.17);--hover:rgba(255,255,255,.085);
        --shadow:rgba(0,0,0,.3);--inner:rgba(255,255,255,.09);--focus:#91b7ff;--ok:#8fd8ba;--error:#ffb6ad;}
    }
    *{box-sizing:border-box}[hidden]{display:none!important}
    button{font:inherit;color:inherit;cursor:pointer;border:0;margin:0;appearance:none;-webkit-tap-highlight-color:transparent}
    button:focus-visible{outline:2px solid var(--focus);outline-offset:-3px}
    svg{width:18px;height:18px;flex:none;pointer-events:none}
    .surface,.more-menu,.tip{position:fixed;pointer-events:auto;color:var(--ink);background:var(--glass);
      border:1px solid var(--edge);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);
      box-shadow:0 3px 7px rgba(25,38,60,.045),0 9px 24px var(--shadow),inset 0 .5px 0 var(--inner);
      font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;}
    .surface{overflow:hidden;isolation:isolate;touch-action:none;transition:width .28s cubic-bezier(.22,.85,.25,1),height .28s cubic-bezier(.22,.85,.25,1),border-radius .28s cubic-bezier(.22,.85,.25,1),left .28s cubic-bezier(.22,.85,.25,1),right .28s cubic-bezier(.22,.85,.25,1),top .28s cubic-bezier(.22,.85,.25,1),bottom .28s cubic-bezier(.22,.85,.25,1)}
    .surface.dragging{transition:none;cursor:grabbing}
    .toggle{position:absolute;inset:0;width:100%;height:100%;background:transparent;display:grid;place-items:center;touch-action:none;cursor:grab}
    .toggle svg{width:19px;height:19px}.toggle:hover{background:var(--hover)}
    .panel{height:100%;padding:5px 9px;opacity:0;pointer-events:none}
    .expanded .panel{opacity:1;pointer-events:auto}
    .actions{height:100%;display:flex;align-items:center;justify-content:space-between;gap:4px}
    .action,.more{background:transparent;padding:0;display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:11px;transition:background .14s,transform .14s}
    .action:hover,.more:hover,.more[aria-expanded=true]{background:var(--hover)}
    .action:active,.more:active{transform:scale(.94)}
    .separator{width:1px;height:15px;background:var(--line);flex:none;margin:0 1px}
    .compact .panel{padding:5px}.compact .actions{gap:1px}.compact .action,.compact .more{width:28px}
    .touch .action,.touch .more{width:44px;height:44px}.touch .panel{padding:4px 9px}
    .more-menu{padding:5px;border-radius:14px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--secondary) transparent;animation:menu-in .13s ease-out}
    .menu-action{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:8px 10px;border-radius:9px;background:transparent;text-align:left;white-space:nowrap;font-size:12px}
    .menu-action:hover{background:var(--hover)}.menu-action svg{width:15px;height:15px;color:var(--secondary)}
    .status{height:100%;display:flex;align-items:center;gap:9px;padding:0 12px;opacity:0;transition:opacity .14s}
    .processing .status,.success .status,.error .status{opacity:1}.status-text{min-width:0;flex:1}
    .status-text b{display:block;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .elapsed{font-size:11px;color:var(--secondary)}
    .cancel{background:transparent;width:26px;height:26px;flex:none;display:grid;place-items:center;border-radius:50%}.cancel:hover{background:var(--hover)}.cancel svg{width:14px;height:14px}
    .orb{width:16px;height:16px;border:1.5px solid var(--line);border-top-color:var(--ink);border-radius:50%;animation:orbit 1s linear infinite;flex:none}
    .success .status>svg{color:var(--ok)}.error .status>svg{color:var(--error)}
    .tip{pointer-events:none;font-size:11px;border-radius:8px;padding:6px 10px;max-width:calc(100vw - 16px);overflow-wrap:anywhere}
    @keyframes orbit{to{transform:rotate(360deg)}}
    @keyframes menu-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
    @supports not ((backdrop-filter:blur(24px)) or (-webkit-backdrop-filter:blur(24px))){.surface,.more-menu,.tip{background:var(--solid)}}
    @media(prefers-reduced-motion:reduce){.surface,.panel,.status,.action,.more{transition:none}.more-menu,.orb{animation:none}}
    @media(forced-colors:active){.surface,.more-menu,.tip{background:Canvas;color:CanvasText;border-color:CanvasText;box-shadow:none;backdrop-filter:none}.action,.more,.cancel,.menu-action{color:ButtonText}}
  `;
  const viewport = () => ({ width: document.documentElement.clientWidth || innerWidth, height: document.documentElement.clientHeight || innerHeight });
  const enabled = () => !prefs.disabledHosts.includes(location.hostname.toLowerCase());
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function mount() {
    if (dead || host?.isConnected) return;
    mountAbort?.abort(); mountAbort = new AbortController();
    const localListeners = { signal: mountAbort.signal };
    document.querySelectorAll('#jdt-island-host').forEach((node) => node.remove());
    lastRenderMode = undefined; menuOpen = false;
    host = document.createElement('div'); host.id = 'jdt-island-host';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${css}</style><div class="surface collapsed"><button class="toggle" aria-label="打开 JD 追踪快捷入口" aria-expanded="false" data-tip="JD 追踪 · 点击展开，拖动移动">${icons.island}</button><div class="panel" hidden><div class="actions">${[['job','框选 JD'],['question','框选题目'],['dashboard','投递进度'],['knowledge','面试知识库']].map(([key,label]) => `<button class="action" data-action="${key}" aria-label="${label}" data-tip="${label}">${icons[key]}</button>`).join('')}<span class="separator" aria-hidden="true"></span><button class="more" aria-label="更多" aria-haspopup="menu" aria-expanded="false" aria-controls="jdt-island-more" data-tip="更多">${icons.more}</button></div></div><div class="status" role="status" aria-live="polite" hidden></div></div><div class="more-menu" id="jdt-island-more" role="menu" aria-label="更多操作" hidden><button class="menu-action" role="menuitem" data-action="reset">${icons.reset}<span>重置位置</span></button><button class="menu-action" role="menuitem" data-action="disable">${icons.hide}<span>在此网站关闭</span></button></div><div class="tip" id="jdt-island-tooltip" role="tooltip" hidden></div>`;
    surface = shadow.querySelector('.surface');
    shadow.addEventListener('keydown', onKeyDown, localListeners);
    shadow.addEventListener('click', click, localListeners);
    shadow.addEventListener('pointerover', (e) => { const b = e.target.closest('button[data-tip]'); if (b && !b.contains(e.relatedTarget)) tip(b); }, localListeners);
    shadow.addEventListener('pointerout', (e) => { const b = e.target.closest('button[data-tip]'); if (b && !b.contains(e.relatedTarget)) clearTip(); }, localListeners);
    shadow.addEventListener('focusin', (e) => { const b = e.target.closest('button[data-tip]'); if (b) tip(b); }, localListeners);
    shadow.addEventListener('focusout', (e) => { clearTip(); if (menuOpen && !shadow.querySelector('.more-menu').contains(e.relatedTarget) && e.relatedTarget !== shadow.querySelector('.more')) setMenu(false); }, localListeners);
    surface.addEventListener('pointerdown', down, localListeners);
    surface.addEventListener('pointermove', move, localListeners);
    surface.addEventListener('pointerup', up, localListeners);
    surface.addEventListener('pointercancel', cancelDrag, localListeners);
    surface.addEventListener('lostpointercapture', () => { if (drag) cancelDrag(); }, localListeners);
    document.documentElement.appendChild(host); render();
  }
  function setMenu(open, focus = false) {
    menuOpen = !!open && mode === 'expanded' && !reasons.size;
    clearTip();
    shadow.querySelector('.more').setAttribute('aria-expanded', String(menuOpen));
    const menu = shadow.querySelector('.more-menu'); menu.hidden = !menuOpen; menu.inert = !menuOpen;
    if (menuOpen) {
      const b = C.popover(bounds, viewport(), { width: 178, height: 94 });
      Object.assign(menu.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, maxHeight: `${b.height}px` });
      if (focus) menu.querySelector('button').focus();
    }
  }
  function render() {
    if (!surface || dead) return;
    reasons = C.hide(reasons, 'site-disabled', !enabled());
    host.style.setProperty('visibility', reasons.size ? 'hidden' : 'visible', 'important');
    const expanded = mode === 'expanded', processing = mode === 'processing', v = viewport();
    const touch = coarsePointer.matches && v.width >= 302;
    const dims = expanded ? { width: touch ? 270 : 212, height: touch ? 54 : 44 } : processing ? { width: 220, height: 44 } : mode === 'success' || mode === 'error' ? { width: mode === 'error' ? 240 : 200, height: 40 } : C.size;
    bounds = C.bounds(prefs.position, v, dims);
    const b = bounds;
    // 形变期间固定同一侧的边缘，避免 left 与 width 同时改变导致图标跳位。
    Object.assign(surface.style, { left: b.right ? 'auto' : `${b.x}px`, right: b.right ? `${v.width - b.x - b.width}px` : 'auto', top: b.bottom ? 'auto' : `${b.y}px`, bottom: b.bottom ? `${v.height - b.y - b.height}px` : 'auto', width: `${b.width}px`, height: `${b.height}px`, borderRadius: `${dims.height / 2}px` });
    surface.className = `surface ${mode}${drag?.moved ? ' dragging' : ''}${b.width < 204 ? ' compact' : ''}${touch && expanded ? ' touch' : ''}`;
    const toggle = shadow.querySelector('.toggle'); toggle.hidden = mode !== 'collapsed'; toggle.setAttribute('aria-expanded', String(expanded));
    const panel = shadow.querySelector('.panel'); panel.inert = !expanded;
    if (lastRenderMode !== mode) {
      clearTimeout(panelTimer); clearTip();
      if (expanded) {
        panel.hidden = false;
        if (!reducedMotion()) panel.animate([{ opacity: 0, transform: `translateX(${b.right ? 5 : -5}px)` }, { opacity: 1, transform: 'none' }], { duration: 140, delay: 80, fill: 'backwards', easing: 'ease-out' });
      } else if (lastRenderMode === 'expanded' && !reducedMotion()) {
        panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100 });
        panelTimer = setTimeout(() => { if (mode !== 'expanded') panel.hidden = true; }, 100);
      } else panel.hidden = true;
      lastRenderMode = mode;
    }
    shadow.querySelector('.status').hidden = ['collapsed','expanded'].includes(mode);
    if (!expanded || reasons.size || drag) setMenu(false);
    else if (menuOpen) setMenu(true);
    if (reasons.size) clearTip();
  }
  function clearTip() {
    clearTimeout(tipTimer); tipTarget?.removeAttribute('aria-describedby'); tipTarget = null;
    if (shadow) shadow.querySelector('.tip').hidden = true;
  }
  function tip(button) {
    clearTip(); if (reasons.size || drag || button.closest('[hidden]')) return;
    tipTarget = button;
    tipTimer = setTimeout(() => {
      if (dead || reasons.size || drag || tipTarget !== button || !button.isConnected || button.closest('[hidden]')) return;
      const t = shadow.querySelector('.tip'); t.textContent = button.dataset.tip; t.hidden = false;
      const r = button.getBoundingClientRect();
      const b = C.popover({ x: r.x, y: r.y, width: r.width, height: r.height, right: bounds.right }, viewport(), { width: t.offsetWidth, height: t.offsetHeight }, 'above');
      Object.assign(t.style, { left: `${b.x}px`, top: `${b.y}px` }); button.setAttribute('aria-describedby', t.id);
    }, 450);
  }
  function onKeyDown(e) {
    const button = e.target.closest('button');
    if ((e.key === 'Enter' || e.key === ' ') && button) { e.preventDefault(); button.click(); return; }
    if (e.key === 'ArrowDown' && button?.classList.contains('more')) { e.preventDefault(); setMenu(true, true); return; }
    if (menuOpen && e.target.closest('.more-menu') && ['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
      e.preventDefault(); const items = [...shadow.querySelectorAll('.menu-action')], i = items.indexOf(button);
      items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (menuOpen) { setMenu(false); shadow.querySelector('.more').focus(); }
    else if (mode === 'processing') task?.cancel();
    else { mode = 'collapsed'; render(); shadow.querySelector('.toggle').focus(); }
  }
  async function send(msg) {
    try { const r = await chrome.runtime.sendMessage(msg); if (!r) throw new Error('扩展没有响应'); return r; }
    catch(e) { if (/context invalidated/i.test(e.message)) destroy(); return { ok: false, error: e.message }; }
  }
  async function click(e) {
    if (suppressClick && e.detail !== 0) { suppressClick = false; e.preventDefault(); return; }
    const button = e.target.closest('button'); if (!button) return;
    clearTip();
    if (button.classList.contains('toggle')) { mode = 'expanded'; render(); if (e.detail === 0) shadow.querySelector('.action').focus(); return; }
    if (button.classList.contains('more')) { setMenu(!menuOpen, e.detail === 0); return; }
    if (button.classList.contains('cancel')) { task?.cancel(); return; }
    const action = button.dataset.action;
    if (!action || capturing || task) return;
    setMenu(false);
    if (action === 'disable' || action === 'reset') {
      const r = await send(action === 'disable' ? { type: 'ISLAND_SET_SITE', enabled: false } : { type: 'ISLAND_RESET_POSITION' });
      if (r.ok) { prefs = r.preferences; render(); if (action === 'reset') shadow.querySelector('.more').focus(); }
      else terminal(r.error || '偏好保存失败，请重试', false);
      return;
    }
    mode = 'collapsed'; render();
    capturing = ['job','question'].includes(action);
    const r = await send(capturing ? { type: 'START_CAPTURE', mode: 'region', target: action === 'question' ? 'technical-question' : 'job' } : { type: action === 'dashboard' ? 'OPEN_DASHBOARD' : 'OPEN_KNOWLEDGE' });
    capturing = false;
    if (!r.ok) terminal(r.error || '操作失败，请重试', false);
  }
  function down(e) {
    if (e.button !== 0 || !['collapsed','expanded'].includes(mode)) return;
    if (e.target.closest('button') && !e.target.closest('.toggle')) return;
    clearTip(); setMenu(false); suppressClick = false;
    const r = surface.getBoundingClientRect();
    drag = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, origin: { x: bounds.right ? r.right - C.size.width : r.left, y: bounds.bottom ? r.bottom - C.size.height : r.top }, previous: { ...prefs.position }, moved: false };
    (e.target.closest('.toggle') || surface).setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!drag.moved && !C.dragged(drag.start, p)) return;
    drag.moved = true; mode = 'collapsed'; suppressClick = true;
    prefs.position = C.normalize({ x: drag.origin.x + p.x - drag.start.x, y: drag.origin.y + p.y - drag.start.y }, viewport()); render();
  }
  async function up(e) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const d = drag, position = { ...prefs.position }; drag = null; render();
    if (d.moved) {
      deferred = null; const r = await send({ type: 'ISLAND_SET_POSITION', position });
      if (!r.ok) { prefs.position = d.previous; terminal('位置保存失败，请重试', false); }
      else { prefs = r.preferences; render(); }
    } else if (deferred) { prefs = deferred; deferred = null; render(); }
  }
  function cancelDrag() { if (!drag) return; prefs.position = drag.previous; drag = null; suppressClick = true; if (deferred) { prefs = deferred; deferred = null; } render(); }
  function terminal(message, success = true) {
    if (dead) return;
    clearInterval(timer); clearTimeout(terminalTimer); clearTip(); task = null; mode = success ? 'success' : 'error';
    const s = shadow.querySelector('.status'); s.innerHTML = `${success ? icons.check : icons.error}<div class="status-text"><b></b></div>`; s.querySelector('b').textContent = message; s.title = message;
    render(); terminalTimer = setTimeout(() => { mode = 'collapsed'; render(); }, 1800);
  }
  function phase(p, details = {}) {
    if (dead) return false;
    clearTimeout(terminalTimer); reasons = C.hide(reasons, 'selecting', p === 'selecting'); reasons = C.hide(reasons, 'review', p === 'review');
    if (p === 'processing') {
      task = details; mode = 'processing';
      const s = shadow.querySelector('.status'); s.innerHTML = `<span class="orb"></span><div class="status-text"><b></b><span class="elapsed"></span></div><button class="cancel" aria-label="取消识别" data-tip="取消识别">${icons.cancel}</button>`;
      s.querySelector('b').textContent = details.target === 'technical-question' ? '正在识别题目' : '正在识别 JD';
      const tick = () => { if (task) s.querySelector('.elapsed').textContent = `已用 ${((Date.now() - details.startedAt) / 1000).toFixed(1)} 秒`; };
      clearInterval(timer); tick(); timer = setInterval(tick, 200);
    } else { clearInterval(timer); task = null; mode = 'collapsed'; }
    render(); return visible();
  }
  function visible() { return !dead && enabled() && !reasons.size && host?.isConnected; }
  const bridge = { mount, phase, terminal, visible, documentId, busy: () => capturing || !!task };
  globalThis.__JDT_ISLAND__ = bridge;
  function storage(changes, area) {
    if (area !== 'local' || !changes.islandPreferences) return;
    const next = changes.islandPreferences.newValue || { position: { x: 1, y: 0 }, disabledHosts: [] };
    if (drag) { deferred = next; prefs.disabledHosts = next.disabledHosts; } else prefs = next;
    render(); globalThis.__JDT_OVERLAY_BRIDGE__?.refreshProcessing();
  }
  function message(msg, sender, respond) {
    if (msg.type === 'JDT_ISLAND_FEEDBACK') { terminal(msg.error || '操作失败', false); respond({ ok: true }); return false; }
    if (msg.type === 'JDT_ISLAND_PING') { respond({ pong: true, documentId, busy: !!task || !!globalThis.__JDT_OVERLAY_BRIDGE__?.busy() }); return false; }
    if (msg.type === 'JDT_ISLAND_PREPARE') {
      reasons = C.hide(reasons, `capture:${msg.token}`, true); render();
      clearTimeout(captureTimers.get(msg.token));
      captureTimers.set(msg.token, setTimeout(() => { captureTimers.delete(msg.token); reasons = C.hide(reasons, `capture:${msg.token}`, false); render(); if (mode === 'collapsed') terminal('截图已中断，请重试', false); }, 6000));
      let sent = false;
      const done = () => { if (sent) return; sent = true; clearTimeout(limit); respond({ ok: true, documentId }); };
      const limit = setTimeout(() => { if (!sent) { sent = true; respond({ ok: false, error: '页面未完成绘制，请在当前网页重试。' }); } }, 350);
      requestAnimationFrame(() => requestAnimationFrame(done)); return true;
    }
    if (msg.type === 'JDT_ISLAND_RELEASE') { clearTimeout(captureTimers.get(msg.token)); captureTimers.delete(msg.token); reasons = C.hide(reasons, `capture:${msg.token}`, false); render(); respond({ ok: true }); return false; }
    return false;
  }
  function destroy() {
    dead = true; for (const timer of captureTimers.values()) clearTimeout(timer); captureTimers.clear(); clearTimeout(panelTimer); clearInterval(timer); clearTimeout(terminalTimer); clearTip(); abort.abort(); observer?.disconnect(); mountAbort?.abort();
    try { chrome.storage.onChanged.removeListener(storage); chrome.runtime.onMessage.removeListener(message); } catch {}
    host?.remove(); delete globalThis.__JDT_ISLAND__;
  }
  mount();
  document.addEventListener('pointerdown', (e) => { if (mode === 'expanded' && !e.composedPath().includes(host)) { mode = 'collapsed'; clearTip(); render(); } }, listeners);

  coarsePointer.addEventListener('change', render, listeners);
  window.addEventListener('resize', () => { clearTip(); cancelDrag(); render(); }, listeners);
  window.addEventListener('blur', cancelDrag, listeners); window.addEventListener('pagehide', (e) => { if (e.persisted) { reasons = C.hide(reasons, 'bfcache', true); clearInterval(timer); render(); } else destroy(); }, listeners);
  window.addEventListener('pageshow', () => { reasons = C.hide(reasons, 'bfcache', false); render(); }, listeners);
  chrome.storage.onChanged.addListener(storage); chrome.runtime.onMessage.addListener(message);
  observer = new MutationObserver(() => { if (!chrome.runtime?.id) { destroy(); return; } if (!host?.isConnected) mount(); });
  observer.observe(document.documentElement, { childList: true });
  send({ type: 'ISLAND_GET_STATE' }).then((r) => { if (r.ok && !dead) { prefs = r.preferences; render(); } else if (!dead) terminal(r.error || '无法读取入口设置', false); });
})();
