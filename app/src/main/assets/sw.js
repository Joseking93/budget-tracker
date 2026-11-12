// Service worker — makes the app installable and usable with no connection.
//
// It caches the app's CODE only. Your transactions are never here: they live in
// localStorage on the device, and nothing in this file reads or transmits them.
//
// Strategy is network-first with a cache fallback. Cache-first would be faster, but
// it's how a PWA ends up quietly running last week's code — the exact failure that
// already bit us once with browser caching, and far harder to spot on a phone where
// there's no obvious way to hard-refresh.

// Bump when the shell list changes so the old cache is dropped on activate.
const VERSION = 'budget-tracker-v24';

const SHELL = [
  './',
  './index.html',
  './basket.html',
  './css/styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/basket.js',
  './js/decal.js',
  './js/balance.js',
  './js/bank.js',
  './js/budgets.js',
  './js/config.js',
  './js/dashboard.js',
  './js/icons.js',
  './js/identify.js',
  './js/import.js',
  './js/kcb.js',
  './js/monthly.js',
  './js/ncba.js',
  './js/parser.js',
  './js/payables.js',
  './js/reconcile.js',
  './js/recurring.js',
  './js/rules.js',
  './js/salary.js',
  './js/statement.js',
  './js/store.js',
  './fonts/inter-var-latin.woff2',
  './fonts/nunito-var-latin.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// pdf.js is 1.7MB and only needed when importing a statement — something you'd do on
// a laptop, not standing at a till. Left out of the shell so installing stays light;
// it's cached on first use instead.
const LAZY = /vendor\/pdf/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(request)
      .then((res) => {
        // Only cache real successes; a 404 cached is a 404 forever.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: LAZY.test(url.pathname) }).then(
          (hit) =>
            hit ||
            // A share-target launch arrives as "./?text=…", which was never cached
            // under that URL. Fall back to the app shell so sharing works offline.
            (request.mode === 'navigate' ? caches.match('./index.html') : undefined)
        )
      )
  );
});
