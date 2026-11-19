/* 摄像头连续扫一维码：优先 BarcodeDetector，否则用 ZXing（iPhone / Bluefy） */
const CamScanner = (() => {
  let video, stream = null, running = false, timer = null, detector = null, zx = null, onCode = null;
  let last = { code: '', t: 0 }, pending = { code: '', n: 0 };
  const work = document.createElement('canvas');
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  const NOCHECK = new Set(['code_39', 'itf', 'codabar', 'CODE_39', 'ITF', 'CODABAR']);

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
        Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93, Z.BarcodeFormat.ITF, Z.BarcodeFormat.CODABAR]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      zx = new Z.MultiFormatReader(); zx.setHints(hints);
      return 'zxing';
    }
    throw new Error('NO_DECODER');
  }
  /* 用 ZXing 解一个 canvas，返回 {text, format} 或 null */
  function decodeCanvas(cv) {
    const Z = window.ZXing;
    const lum = new Z.HTMLCanvasElementLuminanceSource(cv);
    for (const bin of [new Z.HybridBinarizer(lum), new Z.GlobalHistogramBinarizer(lum)]) {
      try { const r = zx.decodeWithState(new Z.BinaryBitmap(bin)); return { text: r.getText(), format: Z.BarcodeFormat[r.getBarcodeFormat()] }; }
      catch (e) { /* 没找到 */ }
    }
    return null;
  }
  async function tick() {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        let res = null;
        if (detector) {
          const list = await detector.detect(video);
          if (list && list.length) res = { text: list[0].rawValue, format: list[0].format };
        } else if (zx) {
          // 只取画面中间一条带，速度快
          const vw = video.videoWidth, vh = video.videoHeight;
          const cropH = Math.round(vh * 0.4), sy = Math.round((vh - cropH) / 2);
          const scale = Math.min(1, 960 / vw);
          work.width = Math.round(vw * scale); work.height = Math.round(cropH * scale);
          const ctx = work.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, sy, vw, cropH, 0, 0, work.width, work.height);
          res = decodeCanvas(work);
        }
        if (res && res.text) handle(res);
      }
    } catch (e) { /* 忽略单帧错误 */ }
    if (running) timer = setTimeout(tick, detector ? 120 : 80);
  }
  function handle(res) {
    const code = String(res.text).trim();
    if (NOCHECK.has(res.format)) {                      // 无校验位的码，连续两次一致才算
      if (pending.code === code) pending.n++; else pending = { code, n: 1 };
      if (pending.n < 2) return;
    }
    const now = Date.now();
    if (code === last.code && now - last.t < 3000) return;   // 同一个码 3 秒内不重复
    last = { code, t: now }; pending = { code: '', n: 0 };
    if (onCode) onCode(code, res.format);
  }
  async function start(videoEl, cb) {
    video = videoEl; onCode = cb;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('NO_CAMERA_API');
    const mode = await initDetector();
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    video.srcObject = stream;
    video.setAttribute('playsinline', ''); video.muted = true;
    await video.play().catch(() => {});
    try {   // 尽量开连续对焦
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (e) {}
    running = true; tick();
    return mode;
  }
  function stop() {
    running = false; clearTimeout(timer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; if (video) video.srcObject = null;
  }
  function resetLast() { last = { code: '', t: 0 }; }
  async function torch(on) {
    try { const t = stream && stream.getVideoTracks()[0]; const c = t.getCapabilities ? t.getCapabilities() : {}; if (!c.torch) return false; await t.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch (e) { return false; }
  }
  function hasTorch() { try { const t = stream && stream.getVideoTracks()[0]; return !!(t && t.getCapabilities && t.getCapabilities().torch); } catch (e) { return false; } }
  /* 测试用：直接解一张 canvas */
  async function decodeForTest(cv) { if (!zx) await initDetector(true); return decodeCanvas(cv); }
  return { start, stop, resetLast, torch, hasTorch, decodeForTest, isRunning: () => running };
})();
