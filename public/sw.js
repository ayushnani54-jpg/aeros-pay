// Aeros Pay service worker — app-shell caching + a small, explicit set of
// offline-capable pages. Nothing else is intercepted, on purpose.
//
// SCOPE (deliberately narrow — see the offline-payments spec):
//
//   1. STATIC, CONTENT-HASHED BUILD ASSETS (/_next/static/**, /manifest.json,
//      /pwa-icon.svg): cache-first. A hashed URL never changes its bytes, so
//      once fetched once it never needs the network again — this is "the app
//      shell".
//
//   2. A SMALL, EXPLICIT SET OF READ-ONLY PAGES — the dashboard, the
//      recipient-independent Pay screen, and Transactions history, plus the
//      root ("/", which just redirects to the dashboard) — network-first,
//      with the LAST successful response cached and served back only when
//      the network genuinely fails. This is what lets a full reload while
//      offline still show the last-synchronized dashboard/balance/recent-
//      activity state.
//
//   Everything else (marketplace, company pages, invoices, Government
//   pages, ...) is NOT intercepted at all: a fetch failure surfaces the
//   browser's ordinary offline error, exactly like today. There is no
//   attempt to special-case those pages here.
//
// This file is plain JS with no build step (it is served as-is from
// `public/`), and uses only the standard Cache API — no library.

const CACHE_VERSION = "aeros-pay-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const KNOWN_CACHES = [SHELL_CACHE, PAGE_CACHE];

// The only navigations that get an offline fallback. Everything else that
// isn't a static asset passes straight through to the network, unintercepted.
const OFFLINE_PAGES = new Set(["/", "/dashboard", "/pay", "/transactions"]);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("aeros-pay-") && !KNOWN_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.json" ||
    url.pathname === "/pwa-icon.svg"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept a write

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // --- static, content-hashed build assets: cache-first ---------------------
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // --- the small explicit set of offline-capable pages: network-first ------
  if (req.mode === "navigate" && OFFLINE_PAGES.has(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          const cached = await cache.match(req);
          if (cached) return cached;
          // Nothing cached yet for this page (first-ever visit happened
          // offline) — let the browser show its normal offline error, same
          // as any page this worker does not intercept.
          throw new Error("offline and nothing cached for this page yet");
        }
      })(),
    );
  }

  // Everything else: not intercepted.
});
