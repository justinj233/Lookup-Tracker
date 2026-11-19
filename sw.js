/*
 * Service worker: lets the app open with no connection.
 *   - The page's own files: fetched from the network when there is one (so a
 *     new version arrives as soon as it is published), otherwise from the
 *     copy kept from last time. "From the network" means asking the server
 *     every time (cache: 'no-cache'): GitHub Pages lets browsers reuse a file
 *     for 10 minutes, and in LT 998 the iPhone ran a new index.html with an
 *     old app.js because of it.
 *   - The dictionary (data/dict.txt): served from the copy the page stored;
 *     the page itself decides when to download a newer one.
 *   - data/version.json: always the network, so "is there a newer
 *     dictionary?" is never answered from an old copy.
 * It stores nothing of the user's log.
 */
const SHELL_CACHE = 'lookup-tracker-shell-v2';
const DATA_CACHE = 'lookup-tracker-data-v1';
const SHELL = ['./', 'index.html', 'app.js', 'sources.html', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('lookup-tracker-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/data/version.json')) return;
  if (url.pathname.endsWith('/data/dict.txt')) {
    if (req.cache === 'reload') return;
    event.respondWith(caches.open(DATA_CACHE).then(c => c.match('data/dict.txt')).then(hit => hit || fetch(req)));
    return;
  }
  event.respondWith(
    // A new Request from the URL: a navigation request can't be re-fetched with other options.
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, copy)); }
      return resp;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
