/* 离线缓存：页面走网络优先（拿最新版），其余资源缓存优先 + 后台更新 */
const VERSION = '1.1.0';
const CACHE = 'sku-label-v' + VERSION;
const ASSETS = ['./', './index.html', './styles.css', './manifest.webmanifest',
  './js/db.js', './js/importer.js', './js/label.js', './js/printer.js', './js/scanner.js', './js/wedge.js', './js/app.js',
  './vendor/JsBarcode.all.min.js', './vendor/zxing.min.js', './vendor/xlsx.full.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './sku-template.csv'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ASSETS.map(a => fetch(new Request(a, { cache: 'reload' })).then(r => { if (r.ok) return c.put(a, r); }).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('sku-label-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); } return r; })
      .catch(() => caches.match('./index.html', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req.url, { cache: 'no-cache' }).then(r => { if (r && r.ok) { const copy = r.clone(); c.put(req.url.split('?')[0], copy); } return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  }));
});
