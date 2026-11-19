/* 离线缓存：先用缓存，后台更新 */
const CACHE = 'sku-label-v1.0.0';
const ASSETS = ['./', './index.html', './styles.css', './manifest.webmanifest',
  './js/db.js', './js/importer.js', './js/label.js', './js/printer.js', './js/scanner.js', './js/app.js',
  './vendor/JsBarcode.all.min.js', './vendor/zxing.min.js', './vendor/xlsx.full.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './sku-template.csv'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || (e.request.mode === 'navigate' ? c.match('./index.html') : Response.error());
  }));
});
