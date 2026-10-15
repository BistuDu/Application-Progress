/** 独立偏好；读取不写默认值，所有字段更新在同一队列内读改写。 */
export const ISLAND_KEY = 'islandPreferences';
export function hostname(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : ''; } catch { return ''; }
}
export function normalizePreferences(raw) {
  const unit = (v, fallback) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
  const disabledHosts = [...new Set((Array.isArray(raw?.disabledHosts) ? raw.disabledHosts : [])
    .filter((h) => typeof h === 'string' && h && hostname(`https://${h}`) === h.toLowerCase() && !/[/?#@\s]/.test(h))
    .map((h) => h.toLowerCase()))].sort();
  return { schemaVersion: 1, position: { x: unit(raw?.position?.x, 1), y: unit(raw?.position?.y, 0) }, disabledHosts };
}
export function createPreferenceStore(storage) {
  let chain = Promise.resolve();
  const read = async () => normalizePreferences((await storage.get(ISLAND_KEY))[ISLAND_KEY]);
  const update = (patch) => {
    const run = chain.then(async () => {
      const cur = await read();
      if (patch.position) {
        if (!Number.isFinite(patch.position.x) || !Number.isFinite(patch.position.y)) throw new Error('位置必须是有效数值。');
        cur.position = patch.position;
      }
      if (patch.reset) cur.position = { x: 1, y: 0 };
      if (patch.host !== undefined) {
        const h = patch.host;
        if (!h || hostname(`https://${h}`) !== h || /[/?#@\s]/.test(h)) throw new Error('无效的网站名称。');
        cur.disabledHosts = cur.disabledHosts.filter((x) => x !== h);
        if (!patch.enabled) cur.disabledHosts.push(h);
      }
      const next = normalizePreferences(cur);
      await storage.set({ [ISLAND_KEY]: next });
      return next;
    });
    chain = run.catch(() => {});
    return run;
  };
  return { read, update };
}
