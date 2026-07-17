// Hand-rolled service worker — venue-wifi resilience (read-only cache scope)
// PLUS Web Push delivery.
//
// The CACHE side stays read-only: NO write queueing/replay. It only makes
// already-loaded data survive a dropped connection: cache-first for hashed
// build assets, network-first-with-cache-fallback for the app shell and
// idempotent GET /api/* JSON calls. Registered prod-only from
// src/web/client.tsx.
//
// The PUSH side (see the `push` / `notificationclick` listeners at the bottom)
// shows OS-level notifications sent from the server via `createNotification`.
// Payloads are privacy-safe (names/titles only) and carry a hash deep-link the
// click handler focuses/opens.
//
// Bump CACHE_VERSION whenever this file's caching behavior changes so
// `activate` drops the previous version's caches instead of serving stale
// data forever.
const CACHE_VERSION = "v2";
const SHELL_CACHE = `uncon-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `uncon-assets-${CACHE_VERSION}`;
const API_CACHE = `uncon-api-${CACHE_VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE, API_CACHE];

// Vite's built index.html is served at root scope in production.
const SHELL_URL = "/";

const API_TIMEOUT_MS = 4000;

// Dumb-but-safe cap on the API cache: we don't track real usage recency, so
// once we cross this many entries we just drop the oldest-inserted handful.
// `Cache.keys()` returns entries in insertion order in every engine that
// implements the Cache API today, so this approximates LRU without any
// bookkeeping — not a true LRU, just enough to bound growth.
const API_CACHE_MAX_ENTRIES = 80;
const API_CACHE_TRIM_COUNT = 10;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(SHELL_URL).catch(() => {})),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !CURRENT_CACHES.includes(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isHashedAsset(url) {
  return url.pathname.startsWith("/assets/");
}

// Never intercept the SSE streams: they're long-lived and not cacheable
// request/response pairs, and a fetch handler racing them would break
// realtime delivery.
function isRealtimeStream(url) {
  return url.pathname.startsWith("/api/realtime") || /^\/api\/board\/[^/]+\/stream$/.test(url.pathname);
}

async function trimApiCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= API_CACHE_MAX_ENTRIES) return;
  const excess = keys.length - API_CACHE_MAX_ENTRIES + API_CACHE_TRIM_COUNT;
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sw_fetch_timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = timeoutMs ? await withTimeout(fetch(request), timeoutMs) : await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      if (cacheName === API_CACHE) trimApiCache(cache);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("sw_offline_no_cache");
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (isRealtimeStream(url)) return;

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(SHELL_URL, response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match(SHELL_URL);
          if (cached) return cached;
          throw new Error("sw_offline_no_shell");
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const accept = request.headers.get("accept") || "";
    // Only idempotent JSON reads — this also excludes EventSource requests
    // (Accept: text/event-stream) as a second layer of defense beyond the
    // explicit isRealtimeStream() path check above.
    if (!accept.includes("application/json")) return;
    event.respondWith(networkFirst(request, API_CACHE, API_TIMEOUT_MS));
  }
});

// --- Web Push -------------------------------------------------------------
//
// The server sends a JSON payload of `{ title, body, url }` (privacy-safe —
// names/titles only, never emails). Show it as an OS notification; `data.url`
// is the hash deep-link the click handler focuses/opens.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON / empty payload — fall back to a generic notification below.
  }
  const title = payload.title || "Unconf";
  const body = typeof payload.body === "string" ? payload.body : "";
  const url = typeof payload.url === "string" ? payload.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Coalesce repeat pushes about the same thing (the server already
      // dedupes bell rows) so a burst doesn't stack the OS shade.
      tag: url,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing tab on this origin and route it to the deep link,
      // rather than opening a duplicate window.
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try { await client.navigate(target); } catch { /* cross-origin guard */ }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
