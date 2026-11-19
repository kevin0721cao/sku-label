/* 表格导入：Excel(.xlsx/.xls) 与 CSV，条码一律按文本处理，保留前导 0 */
const SkuImporter = (() => {
  const SKU_RE = /sku|条码|条形码|barcode|bar\s*code|ean|upc|gtin|编码|编号|货号|code/i;
  const NAME_RE = /名称|品名|商品|产品|name|title|描述|description/i;

  /* 科学计数法字符串 → 整数数字串，如 6.90123456789E+12 → 6901234567890 */
  function sciToDigits(s) {
    const m = /^(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(s);
    if (!m) return null;
    const intp = m[1], frac = m[2] || '', exp = +m[3];
    const digits = intp + frac, point = intp.length + exp;
    if (point < digits.length) {
      const rest = digits.slice(point);
      if (!/^0*$/.test(rest)) return null;
      return digits.slice(0, point);
    }
    return digits + '0'.repeat(point - digits.length);
  }
  function numToDigits(v) {
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return BigInt(v).toString();
    const s = String(v);
    return sciToDigits(s) || s;
  }
  /* 返回 {sku, sci, precision} */
  function normSku(raw, cell) {
    const st = { sku: '', sci: false, precision: false };
    if (cell && cell.t === 'n') {
      const w = cell.w != null ? String(cell.w).trim() : '';
      if (/^\d+$/.test(w)) st.sku = w;               // 自定义格式 000123 → 保留前导 0
      else st.sku = numToDigits(cell.v);
      if (/[eE]/.test(w)) st.sci = true;
      if (Math.abs(cell.v) >= 1e15) st.precision = true;
      return st;
    }
    if (raw == null) return st;
    let s = String(raw).replace(/[\u200b\ufeff\t\r\n]/g, '').trim();
    s = s.replace(/^'+/, '').replace(/^="?|"$/g, '').trim();   // 去掉 ' 前缀、="000123" 写法
    if (/^\d[\d ]*\d$/.test(s)) s = s.replace(/ /g, '');
    if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
    if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {
      const d = sciToDigits(s);
      if (d) { st.sci = true; s = d; if (s.replace(/0+$/, '').length >= 12) st.precision = true; }
    }
    st.sku = s;
    return st;
  }
  function cellText(raw, cell) {
    if (cell) { if (cell.w != null) return String(cell.w).trim(); if (cell.v != null) return String(cell.v).trim(); return ''; }
    return raw == null ? '' : String(raw).trim();
  }

  /* CSV 解析（支持引号、逗号/分号/Tab 分隔） */
  function parseCSV(text) {
    text = text.replace(/^\ufeff/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const cand = [',', ';', '\t'];
    let delim = ',', best = -1;
    for (const d of cand) { const n = firstLine.split(d).length; if (n > best) { best = n; delim = d; } }
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"' && f === '') q = true;
      else if (c === delim) { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8);
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { try { return new TextDecoder('gb18030').decode(u8); } catch (e2) { return new TextDecoder('gbk').decode(u8); } }
  }

  /* rows: 二维数组，元素为 {raw, cell} */
  function rowsToEntries(rows) {
    rows = rows.filter(r => r.some(c => cellText(c.raw, c.cell) !== ''));
    const res = { entries: [], header: false, skuCol: 0, nameCol: 1, skipped: 0, dupes: 0, sciFixed: 0, precisionWarn: 0, totalRows: 0 };
    if (!rows.length) return res;
    const first = rows[0].map(c => cellText(c.raw, c.cell));
    let skuCol = -1, nameCol = -1;
    first.forEach((t, i) => {
      if (skuCol < 0 && SKU_RE.test(t) && !/^\d+$/.test(t)) skuCol = i;
      else if (nameCol < 0 && NAME_RE.test(t)) nameCol = i;
    });
    let header = skuCol >= 0 || nameCol >= 0;
    if (/^\d{4,}$/.test(normSku(rows[0][0] && rows[0][0].raw, rows[0][0] && rows[0][0].cell).sku)) { header = false; skuCol = -1; nameCol = -1; }
    if (!header) {
      // 第一行没有数字条码且不是数字 → 也当表头
      const a = first[0] || '';
      if (a && !/\d/.test(a)) header = true;
    }
    if (skuCol < 0) skuCol = nameCol === 0 ? 1 : 0;
    if (nameCol < 0) { nameCol = 0; while (nameCol === skuCol) nameCol++; }
    res.header = header; res.skuCol = skuCol; res.nameCol = nameCol;
    const map = new Map();
    const body = header ? rows.slice(1) : rows;
    res.totalRows = body.length;
    for (const r of body) {
      const sc = r[skuCol] || {}, nc = r[nameCol] || {};
      const st = normSku(sc.raw, sc.cell);
      const name = cellText(nc.raw, nc.cell).replace(/\s+/g, ' ');
      if (!st.sku) { res.skipped++; continue; }
      if (st.sci) res.sciFixed++;
      if (st.precision) res.precisionWarn++;
      if (map.has(st.sku)) res.dupes++;
      map.set(st.sku, name);
    }
    res.entries = [...map].map(([sku, name]) => ({ sku, name }));
    return res;
  }

  function sheetRows(ws) {
    if (!ws || !ws['!ref']) return [];
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let R = range.s.r; R <= range.e.r; R++) {
      const row = [];
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        row.push(cell ? { raw: cell.v, cell } : { raw: '' });
      }
      rows.push(row);
    }
    return rows;
  }

  async function parseFile(file) {
    const buf = await file.arrayBuffer();
    const name = (file.name || '').toLowerCase();
    const u8 = new Uint8Array(buf);
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;          // xlsx
    const isOle = u8[0] === 0xd0 && u8[1] === 0xcf;          // xls
    if (isZip || isOle || /\.xlsx?$/.test(name)) {
      if (typeof XLSX === 'undefined') throw new Error('Excel 组件未加载，请刷新页面');
      const wb = XLSX.read(buf, { type: 'array', cellNF: true, cellText: true, raw: false });
      // 选第一个有数据的工作表
      for (const sn of wb.SheetNames) {
        const rows = sheetRows(wb.Sheets[sn]);
        if (rows.length) { const r = rowsToEntries(rows); r.sheet = sn; return r; }
      }
      return rowsToEntries([]);
    }
    const text = decodeText(buf);
    return rowsToEntries(parseCSV(text).map(r => r.map(v => ({ raw: v }))));
  }

  function csvEscape(s) { s = String(s ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  /* 导出 CSV：条码写成 ="000123" 形式，Excel 打开不会丢前导 0 */
  function toCSV(items, excelSafe = true) {
    const lines = ['SKU条码,商品名称'];
    for (const it of items) lines.push((excelSafe ? '="' + it.sku + '"' : csvEscape(it.sku)) + ',' + csvEscape(it.name));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  return { parseFile, parseCSV, rowsToEntries, normSku, sciToDigits, toCSV, decodeText };
})();
