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
    cache.clear(); zIndex = null;
    for (const it of all) cache.set(it.sku, it);
    return cache.size;
  }
  async function putMany(items) {
    const now = Date.now();
    await tx('readwrite', st => { for (const it of items) st.put({ sku: it.sku, name: it.name, t: now }); });
    for (const it of items) cache.set(it.sku, { sku: it.sku, name: it.name, t: now });
    zIndex = null;
  }
  async function put(sku, name) { return putMany([{ sku, name }]); }
  async function del(sku) { await tx('readwrite', st => st.delete(sku)); cache.delete(sku); zIndex = null; }
  async function clear() { await tx('readwrite', st => st.clear()); cache.clear(); zIndex = null; }
  /* ---------- 查找：容错 ---------- */
  // GTIN 校验位（适用于 EAN-8 / UPC-A / EAN-13 / GTIN-14 的前 n-1 位）
  function gtinCheck(body) {
    let sum = 0;
    for (let i = body.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += (+body[i]) * w;
    return String((10 - (sum % 10)) % 10);
  }
  const validGtin = c => /^\d{8}$|^\d{12,14}$/.test(c) && gtinCheck(c.slice(0, -1)) === c.slice(-1);
  // UPC-E(8位) → UPC-A(12位)
  function upcEtoA(e) {
    if (!/^[01]\d{7}$/.test(e)) return null;
    const ns = e[0], d = e.slice(1, 7), ck = e[7], l = d[5];
    let body;
    if ('012'.includes(l)) body = d.slice(0, 2) + l + '0000' + d.slice(2, 5);
    else if (l === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (l === '4') body = d.slice(0, 4) + '00000' + d[4];
    else body = d.slice(0, 5) + '0000' + l;
    return ns + body + ck;
  }
  const stripZ = c => c.replace(/^0+(?=.)/, '');
  function variants(code) {
    const out = [];
    const add = v => { if (v && !out.includes(v)) out.push(v); };
    add(code); add(code.toUpperCase());
    if (!/^\d+$/.test(code)) return out;
    const base = [code];
    const a = code.length === 8 ? upcEtoA(code) : null; if (a) base.push(a);
    for (const c of base) {
      add(c);
      const z = stripZ(c); add(z);
      for (const L of [8, 12, 13, 14]) if (z.length < L) add(z.padStart(L, '0'));
      if (validGtin(c)) add(c.slice(0, -1)), add(stripZ(c.slice(0, -1)));     // 去掉校验位
      if ([7, 11, 12, 13].includes(c.length)) add(c + gtinCheck(c));         // 补上校验位
    }
    return out;
  }
  let zIndex = null;          // 去前导0后的索引
  function buildIndex() {
    zIndex = new Map();
    for (const it of cache.values()) {
      const k = stripZ(it.sku);
      if (!zIndex.has(k)) zIndex.set(k, it);
      if (validGtin(it.sku)) { const k2 = stripZ(it.sku.slice(0, -1)); if (!zIndex.has(k2)) zIndex.set(k2, it); }
    }
  }
  function lookup(code) {
    code = String(code || '').replace(/[\s\u0000-\u001f]/g, '').trim();
    if (!code) return null;
    if (cache.has(code)) return cache.get(code);
    const vs = variants(code);
    for (const v of vs) if (cache.has(v)) return cache.get(v);
    if (!/^\d+$/.test(code)) return null;
    if (!zIndex) buildIndex();
    for (const v of vs) { const it = zIndex.get(stripZ(v)); if (it) return it; }
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
  return { variants, gtinCheck, load, put, putMany, del, clear, lookup, search, all: () => [...cache.values()], count: () => cache.size };
})();
