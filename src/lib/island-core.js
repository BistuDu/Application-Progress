/* Classic script shared by the isolated content world and offline tests. */
(() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const size = { width: 56, height: 36, margin: 16 };
  function area(v) {
    const m = Math.min(size.margin, Math.max(0, (Math.min(v.width, v.height) - size.height) / 2));
    return { m, x: Math.max(0, v.width - size.width - 2 * m), y: Math.max(0, v.height - size.height - 2 * m) };
  }
  function point(p, v) { const a = area(v); return { x: a.m + a.x * clamp(p.x, 0, 1), y: a.m + a.y * clamp(p.y, 0, 1) }; }
  function normalize(p, v) { const a = area(v); return { x: a.x ? clamp((p.x - a.m) / a.x, 0, 1) : 1, y: a.y ? clamp((p.y - a.m) / a.y, 0, 1) : 0 }; }
  function bounds(p, v, requested) {
    const a = area(v), anchor = point(p, v);
    const width = Math.min(requested.width, Math.max(1, v.width - a.m * 2));
    const height = Math.min(requested.height, Math.max(1, v.height - a.m * 2));
    const right = anchor.x + size.width / 2 > v.width / 2, bottom = anchor.y + size.height / 2 > v.height / 2;
    return { width, height, x: clamp(anchor.x - (right ? width - size.width : 0), a.m, v.width - width - a.m), y: clamp(anchor.y - (bottom ? height - size.height : 0), a.m, v.height - height - a.m), right, bottom };
  }
  function popover(anchor, v, requested, prefer = 'below') {
    const m = area(v).m, gap = 8;
    const width = Math.min(requested.width, Math.max(1, v.width - 2 * m));
    const height = Math.min(requested.height, Math.max(1, v.height - 2 * m));
    const below = v.height - m - anchor.y - anchor.height - gap, above = anchor.y - gap - m;
    const down = prefer === 'above' ? above < height && below >= above : below >= height || below >= above;
    return { width, height, x: clamp(anchor.right ? anchor.x + anchor.width - width : anchor.x, m, v.width - width - m), y: clamp(down ? anchor.y + anchor.height + gap : anchor.y - height - gap, m, v.height - height - m) };
  }
  function dragged(start, next) { return Math.hypot(next.x - start.x, next.y - start.y) >= 6; }
  function hide(reasons, reason, enabled) { const next = new Set(reasons); enabled ? next.add(reason) : next.delete(reason); return next; }
  function currentTask(task, id, now = Date.now()) { return !!task && task.id === id && !task.cancelled && now <= task.deadline; }
  globalThis.JDTIslandCore = Object.freeze({ size, area, point, normalize, bounds, popover, dragged, hide, currentTask });
})();
