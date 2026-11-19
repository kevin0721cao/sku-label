/* 摄像头连续扫一维码
   - 优先原生 BarcodeDetector；否则 ZXing（iPhone / Bluefy）
   - 高分辨率取景，中间区域按原始像素解码（小条码），隔帧再解全画面
   - 连续对焦、变焦、手电筒、点按对焦 */
const CamScanner = (() => {
  let video, stream = null, track = null, running = false, timer = null, detector = null, zx = null, onCode = null, frame = 0;
  let last = { code: '', t: 0 }, pending = { code: '', n: 0 };
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  const NOCHECK = new Set(['code_39', 'itf', 'CODE_39', 'ITF']);
  // 中间解码区域（占画面比例），界面上的框按此显示
  const ROI = { w: 0.8, h: 0.34 };
  const stats = { frames: 0, decodes: 0, lastMs: 0, mode: '' };

  async function initDetector(forceZx = false) {
    if (!forceZx && 'BarcodeDetector' in window) {
      try {
        const sup = await window.BarcodeDetector.getSupportedFormats();
        const f = FORMATS.filter(x => sup.includes(x));
        if (f.length) { detector = new window.BarcodeDetector({ formats: f }); return 'native'; }
      } catch (e) {}
    }
    if (window.ZXing) {
      const Z = window.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
        Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      zx = new Z.MultiFormatReader(); zx.setHints(hints);
      return 'zxing';
    }
    throw new Error('NO_DECODER');
  }
  function decodeCanvas(cv) {
    const Z = window.ZXing;
    const lum = new Z.HTMLCanvasElementLuminanceSource(cv);
    for (const bin of [new Z.HybridBinarizer(lum), new Z.GlobalHistogramBinarizer(lum)]) {
      try { const r = zx.decodeWithState(new Z.BinaryBitmap(bin)); return { text: r.getText(), format: Z.BarcodeFormat[r.getBarcodeFormat()] }; }
      catch (e) { /* 没找到 */ }
    }
    return null;
  }
  // 把视频某区域画到工作画布，scale 为缩放倍数
  function grab(sx, sy, sw, sh, scale) {
    work.width = Math.max(1, Math.round(sw * scale)); work.height = Math.max(1, Math.round(sh * scale));
    wctx.imageSmoothingEnabled = scale < 1;
    wctx.drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);
    return work;
  }
  async function decodeFrame() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (detector) {
      const list = await detector.detect(video);
      if (list && list.length) return { text: list[0].rawValue, format: list[0].format };
      return null;
    }
    // 1) 中间区域：原始像素（小于 1000 宽时放大到约 1000，便于小条码）
    const sw = Math.round(vw * ROI.w), sh = Math.round(vh * ROI.h);
    const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    const up = sw < 1000 ? Math.min(2, 1000 / sw) : 1;
    let r = decodeCanvas(grab(sx, sy, sw, sh, up));
    if (r) return r;
    // 2) 每 3 帧解一次全画面（缩到 1280 宽），条码不在框里也能扫到
    if (frame % 3 === 0) {
      const s = Math.min(1, 1280 / vw);
      r = decodeCanvas(grab(0, 0, vw, vh, s));
    }
    return r;
  }
  async function tick() {
    if (!running) return;
    if (!document.hidden && video.readyState >= 2 && video.videoWidth) {
      const t0 = performance.now();
      try { frame++; stats.frames++; const res = await decodeFrame(); if (res && res.text) { stats.decodes++; handle(res); } } catch (e) { /* 忽略单帧错误 */ }
      stats.lastMs = Math.round(performance.now() - t0);
    }
    if (running) timer = setTimeout(tick, document.hidden ? 300 : (detector ? 60 : 15));
  }
  function handle(res) {
    const code = String(res.text).trim();
    if (NOCHECK.has(res.format)) {                      // 无校验位的码，连续两次一致才算
      if (pending.code === code) pending.n++; else pending = { code, n: 1 };
      if (pending.n < 2) return;
    }
    const now = Date.now();
    if (code === last.code && now - last.t < 2500) return;   // 同一个码 2.5 秒内不重复
    last = { code, t: now }; pending = { code: '', n: 0 };
    if (onCode) onCode(code, res.format);
  }
  function caps() { try { return track && track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { return {}; } }
  async function apply(adv) { try { await track.applyConstraints({ advanced: [adv] }); return true; } catch (e) { return false; } }
  async function start(videoEl, cb) {
    video = videoEl; onCode = cb;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('NO_CAMERA_API');
    stats.mode = await initDetector();
    const want = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: want }); }
    catch (e) {
      if (e.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
      else throw e;
    }
    track = stream.getVideoTracks()[0];
    video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', ''); video.muted = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    const c = caps();
    if (c.focusMode && c.focusMode.includes('continuous')) await apply({ focusMode: 'continuous' });
    if (c.exposureMode && c.exposureMode.includes('continuous')) await apply({ exposureMode: 'continuous' });
    running = true; frame = 0; tick();
    return stats.mode;
  }
  function stop() {
    running = false; clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; if (video) video.srcObject = null;
  }
  function resetLast() { last = { code: '', t: 0 }; pending = { code: '', n: 0 }; }
  async function torch(on) { return caps().torch ? apply({ torch: !!on }) : false; }
  function hasTorch() { return !!caps().torch; }
  function zoomRange() { const z = caps().zoom; return z && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1 } : null; }
  async function setZoom(v) { const z = zoomRange(); if (!z) return false; return apply({ zoom: Math.max(z.min, Math.min(z.max, v)) }); }
  /* 点按对焦：x,y 为 0~1 的画面坐标 */
  async function focusAt(x, y) {
    const c = caps(); let ok = false;
    if (c.focusMode && c.focusMode.includes('single-shot')) ok = await apply({ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] });
    else if (c.pointsOfInterest || c.focusMode) ok = await apply({ pointsOfInterest: [{ x, y }] });
    if (c.focusMode && c.focusMode.includes('continuous')) setTimeout(() => apply({ focusMode: 'continuous' }), 1500);
    return ok;
  }
  /* 测试用：直接解一张 canvas */
  async function decodeForTest(cv) { if (!zx) await initDetector(true); return decodeCanvas(cv); }
  return { start, stop, resetLast, torch, hasTorch, zoomRange, setZoom, focusAt, decodeForTest, ROI, stats, isRunning: () => running, videoSize: () => video ? [video.videoWidth, video.videoHeight] : [0, 0] };
})();
