/* Keeps the app working offline once it has been opened. Bump VERSION after changing any file.
   App files are fetched fresh from the network when online (so updates show on the next open)
   and served from the saved copy only when offline. The large text recognition files are
   served from the saved copy first, since they rarely change. */
const VERSION = "erc-v1.4.2";
const CORE = [
  "./", "index.html", "css/app.css", "js/assays.js", "js/engine.js", "js/parse.js", "js/ocr.js", "js/app.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"
];
const OCR = [
  "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js", "vendor/tesseract/core/tesseract-core-lstm.wasm.js",
  "vendor/tesseract/lang/eng.traineddata.gz"
];
const fresh = u => new Request(u, { cache: "reload" });
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(fresh)).then(() => c.addAll(OCR.map(fresh)).catch(() => {}))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const isVendor = new URL(req.url).pathname.includes("/vendor/");
  const save = res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; };
  if (isVendor) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(save)));
    return;
  }
  // App files: network first (revalidated), saved copy when offline
  e.respondWith(fetch(req, { cache: "no-cache" }).then(save).catch(() =>
    caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("index.html"))));
});
