/* 扫码枪（蓝牙/USB 键盘模式）全局捕获
   - document 级 keydown（捕获阶段），无需输入框获得焦点
   - 回车 / Tab / 停顿超时 都算一次扫描结束
   - 兼容 iOS：隐藏输入框 inputmode="none" 保持焦点（不弹键盘），并处理 input / composition 事件 */
const Wedge = (() => {
  let sink = null, onScan = null, onDebug = null, isActive = () => true, shouldFocus = () => true;
  let buf = '', firstT = 0, lastT = 0, timer = null, sawSuffix = false, lastEmit = { code: '', t: 0 };
  const cfg = { minLen: 3, idleMs: 0, dupMs: 700 };

  // 允许用户正常打字的输入框（除 sink 外的文本框）
  function isUserField(el) {
    if (!el || el === sink) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type) && !el.readOnly;
    return false;
  }
  // 全角转半角，去掉控制字符和空白
  function clean(s) {
    return String(s)
      .replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\ufeff\u3000]/g, '')
      .trim();
  }
  const now = () => (window.performance ? performance.now() : Date.now());
  // 停顿判定：按本次输入的平均字符间隔自适应（慢速蓝牙扫码枪也不会被截断），100~400ms
  function idle() {
    if (cfg.idleMs) return cfg.idleMs;
    const n = buf.length; const avg = n > 1 ? (lastT - firstT) / (n - 1) : 30;
    return Math.max(100, Math.min(400, avg * 4 + 60));
  }
  function push(chars) {
    const t = now();
    if (!buf) firstT = t;
    buf += chars; lastT = t;
    clearTimeout(timer); timer = setTimeout(() => finish('停顿'), idle());
  }
  function finish(why) {
    clearTimeout(timer);
    const raw = buf; buf = '';
    if (!raw) return;
    const code = clean(raw);
    const info = { raw, why, ms: Math.round(lastT - firstT), len: code.length };
    if (code.length < cfg.minLen) { if (onDebug) onDebug(Object.assign(info, { ignored: '太短' })); return; }
    if (why === '回车' || why === 'Tab') sawSuffix = true;
    const t = Date.now();
    if (code === lastEmit.code && t - lastEmit.t < cfg.dupMs) { if (onDebug) onDebug(Object.assign(info, { ignored: '重复' })); return; }
    lastEmit = { code, t };
    if (onDebug) onDebug(info);
    if (onScan) onScan(code, info);
  }
  function onKeyDown(e) {
    if (!isActive()) return;
    const tgt = e.target;
    if (isUserField(tgt)) return;                                   // 用户在别的输入框打字
    if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process') return; // 交给 input 事件
    const k = e.key;
    if (k === 'Enter' || k === 'NumpadEnter' || e.keyCode === 13) {
      if (buf) { e.preventDefault(); e.stopPropagation(); finish('回车'); }
      return;
    }
    if (k === 'Tab') { if (buf) { e.preventDefault(); e.stopPropagation(); finish('Tab'); } return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k && k.length === 1) { e.preventDefault(); e.stopPropagation(); push(k); }
  }
  // iOS 某些扫码枪只触发 input / composition，不给 keydown 键值
  function drainSink(e) {
    if (e && e.isComposing) return;
    const v = sink.value; if (!v) return;
    sink.value = '';
    const parts = v.split(/([\r\n\t])/);
    for (const p of parts) {
      if (p === '\r' || p === '\n') finish('回车');
      else if (p === '\t') finish('Tab');
      else if (p) push(p);
    }
  }
  function focusSink() {
    if (!sink || !isActive() || !shouldFocus()) return;
    const a = document.activeElement;
    if (a && a !== sink && a !== document.body && isUserField(a)) return;
    if (document.querySelector('dialog[open]')) return;
    try { sink.focus({ preventScroll: true }); } catch (e) { sink.focus(); }
  }
  function init(opts) {
    sink = opts.sink; onScan = opts.onScan; onDebug = opts.onDebug; if (opts.isActive) isActive = opts.isActive; if (opts.shouldFocus) shouldFocus = opts.shouldFocus;
    document.addEventListener('keydown', onKeyDown, true);
    sink.addEventListener('input', drainSink);
    sink.addEventListener('compositionend', () => setTimeout(drainSink, 0));
    sink.addEventListener('blur', () => setTimeout(() => { const a = document.activeElement; if (!a || a === document.body) focusSink(); }, 60));
    // 点击空白处 / 按钮后把焦点还给 sink（iOS 只允许在用户手势里 focus）
    document.addEventListener('click', e => { if (!isUserField(e.target)) setTimeout(focusSink, 0); }, true);
    document.addEventListener('touchend', e => { if (!isUserField(e.target)) setTimeout(focusSink, 0); }, true);
    window.addEventListener('focus', () => setTimeout(focusSink, 50));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(focusSink, 50); });
    focusSink();
  }
  return { init, focusSink, clean, cfg, isUserField, _state: () => ({ buf, sawSuffix }) };
})();
