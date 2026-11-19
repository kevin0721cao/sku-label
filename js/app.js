/* 主程序 */
(() => {
  const VERSION = '1.0.0';
  const $ = id => document.getElementById(id);
  const DEFAULTS = { wMm: 60, hMm: 40, mode: 'cpcl-cg', offX: 48, offY: 0, density: 0, speed: -1, gapSense: false, rotate: false,
    autoPrint: false, sound: true, chunk: 128, delay: 15, write: 'auto' };
  let S = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sku-label-settings') || '{}'));
  let current = null;            // {sku, name, found}
  const labelCanvas = document.createElement('canvas');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isBluefy = /Bluefy/i.test(navigator.userAgent);

  /* ---------- 小工具 ---------- */
  let toastTimer;
  function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }
  let actx;
  function beep(ok) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const seq = ok ? [[1800, 0, 0.09]] : [[400, 0, 0.15], [400, 0.22, 0.15]];
      for (const [f, at, d] of seq) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = f; o.type = 'square'; g.gain.value = 0.12;
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime + at); o.stop(actx.currentTime + at + d);
      }
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
  }
  function download(name, blob) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function saveSettings() { localStorage.setItem('sku-label-settings', JSON.stringify(S)); }

  /* ---------- 页面切换 ---------- */
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  function showView(v) {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x.dataset.view === v));
    document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
    if (v !== 'scan' && CamScanner.isRunning()) stopCam();
    if (v === 'db') renderList();
    window.scrollTo(0, 0);
  }

  /* ---------- 标签预览 ---------- */
  function renderPreview() {
    const item = current ? { sku: current.sku, name: current.name } : { sku: '6901234567890', name: '示例商品名称（扫描后显示）' };
    LabelRenderer.render(labelCanvas, item, S);
    LabelRenderer.monoPreview(labelCanvas, $('preview'));
    $('previewSize').textContent = `${S.wMm}×${S.hMm}mm · ${labelCanvas.width}×${labelCanvas.height}点`;
  }

  /* ---------- 查询结果 ---------- */
  function showResult(code, fromScan) {
    code = String(code || '').trim();
    if (!code) return;
    const it = SkuDB.lookup(code);
    const card = $('resultCard');
    if (it) {
      current = { sku: it.sku, name: it.name, found: true };
      card.className = 'card result hit';
      card.innerHTML = `<div class="sku">${esc(it.sku)}${it.sku !== code ? ` <small>(扫到 ${esc(code)})</small>` : ''}</div><div class="name">${esc(it.name || '（无名称）')}</div>`;
      beep(true);
      $('btnPrint').disabled = false;
      renderPreview();
      if (fromScan && S.autoPrint && BlePrinter.state().connected) doPrint();
    } else {
      current = { sku: code, name: '', found: false };
      card.className = 'card result miss';
      card.innerHTML = `<div class="miss-title">未找到</div><div class="sku">${esc(code)}</div>
        <div class="quick-add"><textarea id="quickName" rows="2" placeholder="输入商品名称，快速加入商品库"></textarea>
        <button id="quickAdd" class="btn primary" type="button">加入商品库</button></div>`;
      beep(false);
      $('btnPrint').disabled = true;
      renderPreview();
      $('quickAdd').onclick = async () => {
        const name = $('quickName').value.trim();
        if (!name) { toast('请先输入商品名称'); return; }
        await SkuDB.put(code, name); updateCount();
        toast('已加入商品库'); CamScanner.resetLast(); showResult(code, false);
      };
    }
  }

  /* ---------- 摄像头 ---------- */
  async function startCam() {
    try {
      $('btnCam').disabled = true;
      await CamScanner.start($('video'), code => {
        $('camWrap').classList.add('flash'); setTimeout(() => $('camWrap').classList.remove('flash'), 300);
        $('manualInput').value = code; showResult(code, true);
      });
      $('camIdle').classList.add('hidden'); $('btnCamStop').classList.remove('hidden');
      $('btnTorch').classList.toggle('hidden', !CamScanner.hasTorch());
    } catch (e) {
      console.error(e);
      let msg = '无法打开摄像头：' + (e.message || e.name);
      if (e.name === 'NotAllowedError') msg = '摄像头权限被拒绝。\n请在手机设置里允许此浏览器使用相机，再刷新页面。';
      else if (!window.isSecureContext) msg = '必须用 https:// 网址打开才能使用摄像头。';
      else if (e.message === 'NO_CAMERA_API') msg = '此浏览器不支持摄像头。可用手动输入或扫码枪。';
      toast(msg, 5000);
    } finally { $('btnCam').disabled = false; }
  }
  function stopCam() { CamScanner.stop(); $('camIdle').classList.remove('hidden'); $('btnCamStop').classList.add('hidden'); $('btnTorch').classList.add('hidden'); }
  $('btnCam').onclick = startCam;
  $('btnCamStop').onclick = stopCam;
  let torchOn = false;
  $('btnTorch').onclick = async () => { torchOn = !torchOn; await CamScanner.torch(torchOn); };

  /* ---------- 手动输入 / 扫码枪 ---------- */
  $('manualForm').addEventListener('submit', e => { e.preventDefault(); CamScanner.resetLast(); showResult($('manualInput').value, true); $('manualInput').select(); });
  // 扫码枪（键盘模式）：焦点不在输入框时，快速连续输入并以回车结束
  let wedge = '', wedgeT = 0;
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || $('editDialog').open) return;
    const now = Date.now();
    if (now - wedgeT > 100) wedge = '';
    wedgeT = now;
    if (e.key === 'Enter') {
      if (wedge.length >= 4) { showView('scan'); $('manualInput').value = wedge; CamScanner.resetLast(); showResult(wedge, true); }
      wedge = ''; return;
    }
    if (e.key.length === 1) wedge += e.key;
  });

  /* ---------- 张数 ---------- */
  const copiesVal = () => Math.max(1, Math.min(999, parseInt($('copies').value, 10) || 1));
  $('copiesMinus').onclick = () => { $('copies').value = Math.max(1, copiesVal() - 1); };
  $('copiesPlus').onclick = () => { $('copies').value = Math.min(999, copiesVal() + 1); };

  /* ---------- 打印 ---------- */
  async function doPrint(testItem) {
    if (!testItem && (!current || !current.found)) return;
    if (!BlePrinter.supported()) { btGuide(true); return; }
    if (!BlePrinter.state().connected && !BlePrinter.state().name) {
      try { await BlePrinter.connect(false); } catch (e) { btError(e); return; }
    }
    const item = testItem || current;
    LabelRenderer.render(labelCanvas, item, S);
    const prog = $('printProgress'); prog.classList.remove('hidden'); prog.firstElementChild.style.width = '0';
    $('btnPrint').disabled = true;
    try {
      const n = await BlePrinter.printCanvas(labelCanvas, Object.assign({}, S, { copies: testItem ? 1 : copiesVal() }), p => { prog.firstElementChild.style.width = Math.round(p * 100) + '%'; });
      toast(`已发送打印 ${testItem ? 1 : copiesVal()} 张（${Math.round(n / 1024)}KB）`);
    } catch (e) { btError(e); }
    finally { setTimeout(() => prog.classList.add('hidden'), 600); $('btnPrint').disabled = !(current && current.found); renderPreview(); }
  }
  $('btnPrint').onclick = () => doPrint();
  $('btnTestPrint').onclick = () => doPrint({ test: true, sku: 'TEST' });
  function btError(e) {
    console.error(e);
    const m = e && (e.message || e.name) || '';
    if (m === 'NO_BT') return btGuide(true);
    if (e && e.name === 'NotFoundError') return toast('没有选择打印机。\n找不到时到「设置」点“显示全部设备”。', 4000);
    if (m === 'NO_CHAR') return toast('已连接，但没找到可写入的通道。\n请把打印机型号截图发给管理员。', 5000);
    if (m === 'NOT_CONNECTED') return toast('打印机未连接');
    toast('打印失败：' + m + '\n请确认打印机开机、在附近，再试一次。', 5000);
  }
  function btGuide(popup) {
    const box = $('btSupport');
    let html;
    if (isIOS && !isBluefy) html = '📱 iPhone 的 Safari 不能连蓝牙打印机。<br>请在 App Store 安装免费的 <b>Bluefy</b> 浏览器，用它打开本网址：<br><a href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055" target="_blank" rel="noopener">去下载 Bluefy</a>。<br>暂时也可以在扫描页点“保存图片”。';
    else if (!window.isSecureContext) html = '必须用 https:// 网址打开，才能连接蓝牙打印机。';
    else html = '此浏览器不支持蓝牙打印。安卓请用 <b>Chrome</b>，iPhone 请用 <b>Bluefy</b>。<br>暂时可以在扫描页点“保存图片”。';
    box.innerHTML = html; box.classList.remove('hidden');
    if (popup) { showView('settings'); toast('当前浏览器不能连蓝牙打印机，请看设置页说明', 4000); }
  }

  /* ---------- 连接打印机 ---------- */
  async function connect(all) {
    if (!BlePrinter.supported()) return btGuide(true);
    try { await BlePrinter.connect(all); toast('打印机已连接：' + BlePrinter.state().name); }
    catch (e) { btError(e); }
  }
  $('printerPill').onclick = () => { const st = BlePrinter.state(); if (st.connected) showView('settings'); else connect(false); };
  $('btnConnect').onclick = () => connect(false);
  $('btnConnectAll').onclick = () => connect(true);
  $('btnDisconnect').onclick = () => { BlePrinter.disconnect(); toast('已断开'); };
  BlePrinter.onChange(updatePrinterUI);
  function updatePrinterUI(st) {
    st = st || BlePrinter.state();
    const pill = $('printerPill');
    pill.classList.toggle('on', st.connected); pill.classList.toggle('off', !st.connected); pill.classList.toggle('busy', st.busy);
    $('printerPillText').textContent = st.busy ? '传输中…' : st.connected ? (st.name || '已连接') : '连接打印机';
    $('printerInfo').textContent = st.connected ? `已连接：${st.name}（通道 ${st.charInfo}）` : (st.name ? `已断开：${st.name}，打印时自动重连` : '未连接');
  }

  /* ---------- 保存 PNG ---------- */
  $('btnSavePng').onclick = async () => {
    renderPreview();
    const blob = await new Promise(r => $('preview').toBlob(r, 'image/png'));
    const name = `label-${current ? current.sku : 'sample'}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    download(name, blob);
  };

  /* ---------- 商品库 ---------- */
  function updateCount() { $('dbCount').textContent = SkuDB.count(); }
  function renderList() {
    const { items, total } = SkuDB.search($('dbSearch').value, 200);
    $('dbList').innerHTML = items.map(it => `<div class="item" data-sku="${esc(it.sku)}"><span class="s">${esc(it.sku)}</span><span class="n">${esc(it.name)}</span></div>`).join('')
      || '<div class="result-empty">还没有商品，请先导入表格</div>';
    $('dbMore').textContent = total > items.length ? `共 ${total} 条，只显示前 ${items.length} 条，请用搜索` : (total ? `共 ${total} 条` : '');
    updateCount();
  }
  $('dbSearch').addEventListener('input', () => renderList());
  $('dbList').addEventListener('click', e => { const el = e.target.closest('.item'); if (el) openEdit(el.dataset.sku); });

  $('fileInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      toast('正在读取 ' + f.name + ' …', 10000);
      const r = await SkuImporter.parseFile(f);
      if (!r.entries.length) { toast('表格里没有读到数据。\n请确认第一列是条码、第二列是商品名称。', 5000); return; }
      const mode = document.querySelector('input[name=importMode]:checked').value;
      if (mode === 'replace' && SkuDB.count() && !confirm(`覆盖模式会先清空现有 ${SkuDB.count()} 条商品，确定吗？`)) { toast('已取消'); return; }
      if (mode === 'replace') await SkuDB.clear();
      await SkuDB.putMany(r.entries);
      let msg = `导入成功 ${r.entries.length} 条`;
      if (r.skipped) msg += `\n跳过空条码 ${r.skipped} 行`;
      if (r.dupes) msg += `\n表内重复 ${r.dupes} 条（以最后一条为准）`;
      if (r.sciFixed) msg += `\n已修正科学计数法条码 ${r.sciFixed} 个`;
      if (r.precisionWarn) msg += `\n⚠️ ${r.precisionWarn} 个条码超过15位或被Excel改过，请抽查（建议把条码列设为“文本”）`;
      toast(msg, 6000); renderList();
    } catch (err) { console.error(err); toast('导入失败：' + (err.message || err), 5000); }
  });
  $('btnTemplate').onclick = () => {
    const csv = '\ufeffSKU条码,商品名称\r\n="0012345678905",示例：黄油捏捏乐 减压玩具 黄色\r\n="6901234567892",示例：商品名称可以很长，标签上会自动换行\r\n';
    download('SKU模板.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  };
  $('btnExport').onclick = () => {
    const items = SkuDB.all().sort((a, b) => a.sku.localeCompare(b.sku));
    if (!items.length) { toast('商品库是空的'); return; }
    const d = new Date(); const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    download(`SKU备份-${ds}.csv`, new Blob([SkuImporter.toCSV(items)], { type: 'text/csv;charset=utf-8' }));
  };
  $('btnClear').onclick = async () => {
    if (!SkuDB.count()) { toast('商品库已是空的'); return; }
    if (!confirm(`确定清空全部 ${SkuDB.count()} 条商品？建议先“导出备份”。`)) return;
    await SkuDB.clear(); renderList(); toast('已清空');
  };
  $('btnAdd').onclick = () => openEdit(null);
  let editing = null;
  function openEdit(sku) {
    editing = sku;
    const it = sku ? SkuDB.lookup(sku) : null;
    $('editTitle').textContent = sku ? '编辑商品' : '新增商品';
    $('editSku').value = it ? it.sku : ''; $('editName').value = it ? it.name : '';
    $('editDelete').classList.toggle('hidden', !sku);
    $('editDialog').returnValue = ''; $('editDialog').showModal();
  }
  $('editDialog').addEventListener('close', async () => {
    const v = $('editDialog').returnValue;
    if (v === 'save') {
      const st = SkuImporter.normSku($('editSku').value); const name = $('editName').value.trim();
      if (!st.sku || !name) { toast('条码和名称都要填'); return; }
      if (editing && editing !== st.sku) await SkuDB.del(editing);
      await SkuDB.put(st.sku, name); toast('已保存');
    } else if (v === 'delete' && editing) {
      if (confirm('确定删除这条？')) { await SkuDB.del(editing); toast('已删除'); }
    }
    renderList();
  });

  /* ---------- 设置 ---------- */
  const fields = { setW: 'wMm', setH: 'hMm', setMode: 'mode', setOffX: 'offX', setOffY: 'offY', setDensity: 'density', setSpeed: 'speed',
    setGapSense: 'gapSense', setRotate: 'rotate', setAutoPrint: 'autoPrint', setSound: 'sound', setChunk: 'chunk', setDelay: 'delay', setWrite: 'write' };
  function fillSettings() {
    for (const [id, k] of Object.entries(fields)) { const el = $(id); if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k]; }
  }
  for (const [id, k] of Object.entries(fields)) {
    $(id).addEventListener('change', e => {
      const el = e.target;
      S[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      saveSettings(); renderPreview();
    });
  }
  $('btnResetSettings').onclick = () => { S = Object.assign({}, DEFAULTS); saveSettings(); fillSettings(); renderPreview(); toast('已恢复默认'); };

  /* ---------- 启动 ---------- */
  async function init() {
    $('appVersion').textContent = `版本 ${VERSION} · 数据只保存在本手机`;
    fillSettings();
    try { await SkuDB.load(); } catch (e) { toast('本地数据库打开失败：' + e.message); }
    updateCount(); renderPreview(); updatePrinterUI();
    if (!BlePrinter.supported()) btGuide(false);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }
  // 测试钩子
  window.__app = { showResult, renderPreview, labelCanvas, get current() { return current; }, S, showView };
  init();
})();
