// Einfacher Service Worker: macht die App installierbar und hält die App-Dateien
// für schlechte Verbindungen vor. Daten von Supabase werden nicht zwischengespeichert.
const CACHE = 'kochbuch-v13';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/supabase.js', 'js/config.js', 'js/ingredients.js', 'js/pantry.js', 'js/shopping.js', 'js/season.js', 'js/video.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Netzwerk zuerst, damit Updates sofort ankommen; Cache nur als Rückfall.
// "no-cache" fragt bei GitHub Pages nach, ob sich die Datei geändert hat, statt
// bis zu 10 Minuten eine alte Fassung aus dem Browser-Cache zu nehmen.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request.mode === 'navigate' ? url.href : event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
