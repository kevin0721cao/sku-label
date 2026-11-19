/* 标签渲染：整张标签画在 canvas 上（203dpi ≈ 8 点/mm），再转 1-bit 位图发给打印机 */
const LabelRenderer = (() => {
  const DPMM = 8;
  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC",sans-serif';

  function tokenize(text) {
    // 中文逐字断行，英文/数字按单词
    const out = []; const re = /[A-Za-z0-9_.\-\/#%+&]+\s*|\s+|./gu; let m;
    while ((m = re.exec(text))) out.push(m[0]);
    return out;
  }
  function wrap(ctx, text, maxW) {
    const lines = []; let cur = '';
    for (let tk of tokenize(text)) {
      if (ctx.measureText(cur + tk).width <= maxW) { cur += tk; continue; }
      if (cur.trim()) { lines.push(cur.trimEnd()); cur = ''; }
      tk = tk.replace(/^\s+/, '');
      if (ctx.measureText(tk).width <= maxW) { cur = tk; continue; }
      for (const ch of tk) {           // 超长单词逐字拆
        if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ''; }
        cur += ch;
      }
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    return lines;
  }
  function fitName(ctx, name, maxW, maxH, maxLines) {
    for (let size = 46; size >= 18; size -= 2) {
      ctx.font = `bold ${size}px ${FONT}`;
      const lines = wrap(ctx, name, maxW);
      const lh = Math.round(size * 1.18);
      if (lines.length <= maxLines && lines.length * lh <= maxH) return { size, lines, lh };
    }
    const size = 18; ctx.font = `bold ${size}px ${FONT}`;
    let lines = wrap(ctx, name, maxW);
    const lh = Math.round(size * 1.18);
    const n = Math.max(1, Math.min(maxLines, Math.floor(maxH / lh)));
    if (lines.length > n) {
      lines = lines.slice(0, n);
      let last = lines[n - 1];
      while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[n - 1] = last + '…';
    }
    return { size, lines, lh };
  }
  function drawBarcode(ctx, sku, x, y, maxW, h) {
    if (typeof JsBarcode === 'undefined' || !/^[\x20-\x7e]+$/.test(sku)) return false;
    const tmp = document.createElement('canvas');
    for (let mw = 4; mw >= 1; mw--) {
      try {
        JsBarcode(tmp, sku, { format: 'CODE128', displayValue: false, margin: 0, width: mw, height: h, background: '#ffffff', lineColor: '#000000' });
      } catch (e) { return false; }
      if (tmp.width <= maxW || mw === 1) {
        const dw = Math.min(tmp.width, maxW);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, Math.round(x + (maxW - dw) / 2), y, dw, h);
        return true;
      }
    }
    return false;
  }
  /* 画标签；返回 canvas。opts: {wMm,hMm,rotate} */
  function render(canvas, item, opts = {}) {
    const W = Math.round((opts.wMm || 60) * DPMM), H = Math.round((opts.hMm || 40) * DPMM);
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (opts.rotate) { ctx.translate(W, H); ctx.rotate(Math.PI); }
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    if (item && item.test) { drawTest(ctx, W, H); ctx.restore(); return canvas; }
    const pad = Math.round(W * 0.035), bottomPad = 18;   // 底部留出 CPCL 需要扣除的 1.5mm
    const sku = String(item && item.sku || '');
    const name = String(item && item.name || '');
    const innerW = W - pad * 2;
    // 区域划分：名称 45% / 条码 33% / 数字 剩余
    const nameH = Math.round(H * 0.44), barH = Math.round(H * 0.28), digitsH = Math.round(H * 0.12);
    let y = pad - 4;
    if (name) {
      const f = fitName(ctx, name, innerW, nameH - pad + 4, 3);
      ctx.font = `bold ${f.size}px ${FONT}`; ctx.textAlign = 'center';
      const blockH = f.lines.length * f.lh;
      let ty = y + Math.max(0, (nameH - pad - blockH) / 2);
      for (const ln of f.lines) { ctx.fillText(ln, W / 2, ty); ty += f.lh; }
    }
    y = nameH + 4;
    if (sku) {
      const okBar = drawBarcode(ctx, sku, pad + 12, y, innerW - 24, barH);   // 两侧留静区
      y += okBar ? barH + 6 : 0;
      let ds = Math.min(40, Math.round(H - bottomPad - y));
      ctx.textAlign = 'center';
      do { ctx.font = `bold ${ds}px ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace`; ds -= 2; }
      while (ctx.measureText(sku).width > innerW && ds > 14);
      ctx.fillText(sku, W / 2, y);
    }
    ctx.restore();
    return canvas;
  }
  function drawTest(ctx, W, H) {
    ctx.lineWidth = 4; ctx.strokeRect(2, 2, W - 4, H - 16);
    ctx.lineWidth = 2;
    for (let x = 0; x <= W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, x % 80 ? 18 : 30); ctx.stroke(); }
    ctx.textAlign = 'center';
    ctx.font = `bold 40px ${FONT}`; ctx.fillText('测试标签 TEST', W / 2, 60);
    ctx.font = `24px ${FONT}`; ctx.fillText(`${W / DPMM}×${H / DPMM}mm  每格 5mm`, W / 2, 120);
    ctx.fillText('四边框线完整 = 位置正确', W / 2, 160);
    drawBarcode(ctx, '1234567890', 40, 200, W - 80, 70);
  }
  /* 转 1-bit：返回 {wb, h, bits}，bits 中 1=黑 */
  function toBits(canvas, threshold = 150, cropBottom = 0) {
    const W = canvas.width, H = canvas.height - cropBottom;
    const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const wb = Math.ceil(W / 8), bits = new Uint8Array(wb * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (data[i + 3] > 0 && lum < threshold) bits[y * wb + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return { wb, h: H, w: W, bits };
  }
  /* 预览按打印效果显示黑白 */
  function monoPreview(src, dst) {
    const { wb, h, w, bits } = toBits(src);
    dst.width = src.width; dst.height = src.height;
    const ctx = dst.getContext('2d');
    const img = ctx.createImageData(src.width, src.height);
    for (let y = 0; y < src.height; y++) for (let x = 0; x < w; x++) {
      const on = y < h && (bits[y * wb + (x >> 3)] & (0x80 >> (x & 7)));
      const i = (y * w + x) * 4; const v = on ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return { render, toBits, monoPreview, DPMM };
})();
