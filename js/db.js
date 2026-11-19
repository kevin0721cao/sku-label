/* 商品库：IndexedDB 持久化 + 内存缓存 */
const SkuDB = (() => {
  const DB_NAME = 'sku-label-db', STORE = 'items';
  let dbp = null;
  const cache = new Map();
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'sku' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      const out = fn(st);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  async function load() {
    const all = await tx('readonly', st => st.getAll());
    cache.clear();
    for (const it of all) cache.set(it.sku, it);
    return cache.size;
  }
  async function putMany(items) {
    const now = Date.now();
    await tx('readwrite', st => { for (const it of items) st.put({ sku: it.sku, name: it.name, t: now }); });
    for (const it of items) cache.set(it.sku, { sku: it.sku, name: it.name, t: now });
  }
  async function put(sku, name) { return putMany([{ sku, name }]); }
  async function del(sku) { await tx('readwrite', st => st.delete(sku)); cache.delete(sku); }
  async function clear() { await tx('readwrite', st => st.clear()); cache.clear(); }
  /* 查找：精确匹配，兼容 UPC-A(12位) 与 EAN-13(前置0) 互转 */
  function lookup(code) {
    code = String(code || '').trim();
    if (!code) return null;
    if (cache.has(code)) return cache.get(code);
    const alts = [];
    if (/^0\d{12}$/.test(code)) alts.push(code.slice(1));
    if (/^\d{12}$/.test(code)) alts.push('0' + code);
    for (const a of alts) if (cache.has(a)) return cache.get(a);
    return null;
  }
  function search(q, limit = 200) {
    q = String(q || '').trim().toLowerCase();
    const out = [];
    let total = 0;
    for (const it of cache.values()) {
      if (!q || it.sku.toLowerCase().includes(q) || String(it.name).toLowerCase().includes(q)) {
        total++;
        if (out.length < limit) out.push(it);
      }
    }
    out.sort((a, b) => b.t - a.t || a.sku.localeCompare(b.sku));
    return { items: out, total };
  }
  return { load, put, putMany, del, clear, lookup, search, all: () => [...cache.values()], count: () => cache.size };
})();
