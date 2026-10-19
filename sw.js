// Service Worker: macht die App installierbar und offline lesbar.
// - App-Dateien: Netzwerk zuerst, Cache als Rückfall.
// - Daten von Supabase (Lesezugriffe): Netzwerk zuerst; ohne Netz die letzte Antwort, und
//   die App bekommt Bescheid, von wann sie ist.
// - Bilder und die Supabase-Bibliothek von esm.sh: aus dem Cache, wenn schon da. Dieser
//   Cache bleibt bei Updates der App erhalten.
const CACHE = 'kochbuch-v35';
const DATA = 'kochbuch-daten';
const MEDIA = 'kochbuch-bilder';
const SUPABASE = 'https://rgjwlpxrzfcrjyzxetyy.supabase.co';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/supabase.js', 'js/config.js', 'js/ingredients.js', 'js/pantry.js', 'js/shopping.js', 'js/season.js', 'js/video.js', 'js/categories.js', 'js/places.js', 'js/links.js',
  'js/alternatives.js', 'js/combine.js', 'js/sorting.js', 'js/help.js', 'js/news.js', 'js/cooking.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  const keep = new Set([CACHE, DATA, MEDIA]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Meldet der Seite, dass sie gerade Daten von früher sieht.
async function tellOffline(clientId, at) {
  const client = clientId && await self.clients.get(clientId);
  client?.postMessage({ type: 'kochbuch-offline', at });
}

// Lesezugriffe auf die Datenbank: Antwort merken (mit Zeitpunkt), ohne Netz die gemerkte.
async function dataFirst(event) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(event.request);
    if (res.ok) {
      const body = await res.clone().blob();
      const headers = new Headers(res.headers);
      headers.set('x-kochbuch-saved', new Date().toISOString());
      cache.put(event.request, new Response(body, { status: res.status, statusText: res.statusText, headers }));
    }
    return res;
  } catch (err) {
    const hit = await cache.match(event.request, { ignoreVary: true });
    if (!hit) throw err;
    tellOffline(event.clientId, hit.headers.get('x-kochbuch-saved'));
    return hit;
  }
}

// Bilder und Bibliotheken ändern sich unter derselben Adresse nicht: Cache zuerst.
async function cacheFirst(event, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(event.request, { ignoreVary: true });
  if (hit) return hit;
  // Bilder kommen per <img> ohne CORS; mit CORS geholt, belegen sie im Speicher nur ihre echte
  // Größe statt eines Aufschlags für undurchsichtige Antworten. Supabase erlaubt das.
  let res;
  try { res = await fetch(new Request(event.request.url, { mode: 'cors', credentials: 'omit' })); } catch { res = null; }
  if (!res?.ok) res = await fetch(event.request);
  if (res.ok) cache.put(event.request, res.clone());
  return res;
}

// Netzwerk zuerst, damit Updates sofort ankommen; Cache nur als Rückfall.
// "no-cache" fragt bei GitHub Pages nach, ob sich die Datei geändert hat, statt
// bis zu 10 Minuten eine alte Fassung aus dem Browser-Cache zu nehmen.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin === SUPABASE) {
    if (url.pathname.startsWith('/rest/v1/')) event.respondWith(dataFirst(event));
    else if (url.pathname.startsWith('/storage/v1/object/public/')) event.respondWith(cacheFirst(event, MEDIA));
    return;
  }
  if (url.origin === 'https://esm.sh') { event.respondWith(cacheFirst(event, MEDIA)); return; }
  if (url.origin !== self.location.origin) return;
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
