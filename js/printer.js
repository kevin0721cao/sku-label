/* 蓝牙打印：Web Bluetooth (BLE) + CPCL / TSPL 位图指令 */
const BlePrinter = (() => {
  // 候选服务 UUID（Web Bluetooth 必须预先声明才能访问）
  const SERVICES = [
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip/ISSC 透传串口（汉印等常见）
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // 常见国产打印机透传
    '000018f0-0000-1000-8000-00805f9b34fb', // 0x18F0 打印服务
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb',
    '0000ae30-0000-1000-8000-00805f9b34fb',
    '0000ae00-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffb0-0000-1000-8000-00805f9b34fb',
    '0000ff12-0000-1000-8000-00805f9b34fb'
  ];
  const PREFERRED_CHARS = ['49535343-8841-43f4-a8d4-ecbe34729bb3', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', '00002af1-0000-1000-8000-00805f9b34fb'];
  const NAME_PREFIXES = ['HM-', 'HM', 'HPRT', 'A300', 'Printer'];
  let device = null, ch = null, busy = false;
  const listeners = new Set();
  const emit = () => listeners.forEach(f => { try { f(state()); } catch (e) {} });
  const state = () => ({ supported: supported(), connected: !!(device && device.gatt && device.gatt.connected && ch), name: device && (device.name || '未命名设备'), busy, charInfo: ch ? `${ch.service.uuid.slice(0, 8)} / ${ch.uuid.slice(0, 8)}` : '' });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }

  async function connect(showAll = false) {
    if (!supported()) throw new Error('NO_BT');
    const opts = showAll ? { acceptAllDevices: true, optionalServices: SERVICES }
      : { filters: [...NAME_PREFIXES.map(p => ({ namePrefix: p })), ...SERVICES.map(s => ({ services: [s] }))], optionalServices: SERVICES };
    const d = await navigator.bluetooth.requestDevice(opts);
    device = d;
    device.addEventListener('gattserverdisconnected', () => { ch = null; emit(); });
    await attach();
    return state();
  }
  async function attach() {
    busy = true; emit();
    try {
      const server = await device.gatt.connect();
      let services = [];
      try { services = await server.getPrimaryServices(); } catch (e) {
        for (const s of SERVICES) { try { services.push(await server.getPrimaryService(s)); } catch (e2) {} }
      }
      // 按候选顺序排序
      services.sort((a, b) => idx(a.uuid) - idx(b.uuid));
      let pick = null, fallback = null;
      for (const s of services) {
        let chars = [];
        try { chars = await s.getCharacteristics(); } catch (e) { continue; }
        for (const c of chars) {
          const p = c.properties;
          if (!(p.write || p.writeWithoutResponse)) continue;
          if (PREFERRED_CHARS.includes(c.uuid)) { pick = c; break; }
          if (!fallback) fallback = c;
        }
        if (pick) break;
      }
      ch = pick || fallback;
      if (!ch) { try { device.gatt.disconnect(); } catch (e) {} throw new Error('NO_CHAR'); }
    } finally { busy = false; emit(); }
  }
  function idx(u) { const i = SERVICES.indexOf(u); return i < 0 ? 99 : i; }
  async function ensure() {
    if (device && device.gatt && device.gatt.connected && ch) return;
    if (device) { await attach(); return; }  // 已授权设备可直接重连
    throw new Error('NOT_CONNECTED');
  }
  function disconnect() { if (device && device.gatt.connected) device.gatt.disconnect(); ch = null; device = null; emit(); }

  async function writeOne(chunk, mode) {
    for (let tries = 0; ; tries++) {
      try {
        if (mode === 'noresp') {
          if (ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(chunk); else await ch.writeValue(chunk);
        } else {
          if (ch.writeValueWithResponse) await ch.writeValueWithResponse(chunk); else await ch.writeValue(chunk);
        }
        return;
      } catch (e) {
        if (tries >= 5) throw e;
        await sleep(60 * (tries + 1));     // GATT 忙时重试
      }
    }
  }
  /* 分包发送 */
  async function send(bytes, cfg = {}, onProgress) {
    await ensure();
    const size = Math.max(20, Math.min(512, cfg.chunk || 128));
    const delay = cfg.delay == null ? 15 : cfg.delay;
    let mode = cfg.write || 'auto';
    if (mode === 'auto') mode = ch.properties.writeWithoutResponse ? 'noresp' : 'resp';
    if (mode === 'noresp' && !ch.properties.writeWithoutResponse) mode = 'resp';
    if (mode === 'resp' && !ch.properties.write) mode = 'noresp';
    busy = true; emit();
    try {
      for (let i = 0; i < bytes.length; i += size) {
        await writeOne(bytes.slice(i, i + size), mode);
        if (onProgress) onProgress(Math.min(1, (i + size) / bytes.length));
        if (delay && mode === 'noresp') await sleep(delay);
        else if (delay) await sleep(Math.min(delay, 5));
      }
    } finally { busy = false; emit(); }
  }

  /* ---------- 指令生成 ---------- */
  const enc = s => new TextEncoder().encode(s);
  function concat(parts) {
    const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  /* CPCL（汉印 HM-A300 系列编程手册）
     ! {offset} 200 200 {height} {qty}
     CG {字节宽} {点高} {x} {y} {二进制数据}   / EG 为十六进制
     FORM  PRINT */
  function buildCPCL(img, s) {
    const hDots = Math.round(s.hMm * 8) - 12;      // 手册：最大高度 = 标签间距 - 12 点
    const h = Math.min(img.h, hDots);
    const x = Math.max(0, s.offX | 0), y = Math.max(0, s.offY | 0);
    const head = [`! 0 200 200 ${hDots} ${Math.max(1, Math.min(1024, s.copies | 0 || 1))}`, 'PAGE-WIDTH 576'];
    if (s.gapSense) head.push('GAP-SENSE');
    if (s.speed >= 0) head.push(`SPEED ${s.speed}`);
    if (s.density > 0) head.push(`CONTRAST ${Math.min(3, Math.round(s.density / 5))}`);
    const data = img.bits.subarray(0, img.wb * h);
    if (s.mode === 'cpcl-eg') {
      let hex = ''; const H = '0123456789ABCDEF';
      for (const b of data) hex += H[b >> 4] + H[b & 15];
      return enc(head.join('\r\n') + '\r\n' + `EG ${img.wb} ${h} ${x} ${y} ${hex}\r\nFORM\r\nPRINT\r\n`);
    }
    return concat([enc(head.join('\r\n') + '\r\n' + `CG ${img.wb} ${h} ${x} ${y} `), data, enc('\r\nFORM\r\nPRINT\r\n')]);
  }
  /* TSPL：BITMAP x,y,字节宽,高,0,数据（TSPL 中 0=打印黑点，所以取反） */
  function buildTSPL(img, s) {
    const inv = new Uint8Array(img.bits.length);
    for (let i = 0; i < inv.length; i++) inv[i] = ~img.bits[i] & 0xff;
    const lines = [`SIZE ${s.wMm} mm,${s.hMm} mm`, 'GAP 2 mm,0 mm', 'DIRECTION 1', `REFERENCE ${s.offX | 0},${s.offY | 0}`];
    if (s.density > 0) lines.push(`DENSITY ${Math.min(15, s.density)}`);
    if (s.speed >= 0) lines.push(`SPEED ${Math.max(1, s.speed)}`);
    lines.push('CLS');
    return concat([enc(lines.join('\r\n') + '\r\n' + `BITMAP 0,0,${img.wb},${img.h},0,`), inv, enc(`\r\nPRINT 1,${Math.max(1, s.copies | 0 || 1)}\r\n`)]);
  }
  function build(canvas, s) {
    const img = LabelRenderer.toBits(canvas);
    return s.mode === 'tspl' ? buildTSPL(img, s) : buildCPCL(img, s);
  }
  async function printCanvas(canvas, s, onProgress) {
    const bytes = build(canvas, s);
    await send(bytes, s, onProgress);
    return bytes.length;
  }
  return { connect, disconnect, printCanvas, build, supported, state, onChange: f => listeners.add(f), SERVICES };
})();
