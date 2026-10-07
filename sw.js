/* Net Pulse service worker — caches the app shell for offline UI.
   URLs are resolved from the registration scope so a GitHub Pages project
   site (https://windigo98.github.io/Net-pulse/) caches /Net-pulse/ assets. */
const CACHE = 'net-pulse-v9';
const SHELL_PATHS = [
  './',
  './index.html',
  './styles.css',
  './history.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

function shellUrls() {
  const scope = self.registration ? self.registration.scope : new URL('./', self.location).href;
  return SHELL_PATHS.map((path) => new URL(path, scope).href);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(shellUrls())).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache live connectivity / speed probes — always hit the network
  if (
    url.hostname.includes('cloudflare') ||
    url.hostname.includes('httpbin') ||
    url.hostname.includes('gstatic') ||
    url.hostname.includes('google') ||
    url.hostname.includes('detectportal.firefox.com') ||
    url.hostname.includes('firefox.com') ||
    url.searchParams.has('np_probe')
  ) {
    return;
  }

  // App shell: network-first with cache fallback so updates land quickly
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match(new URL('./index.html', self.registration.scope).href)))
  );
});
