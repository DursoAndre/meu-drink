// service-worker.js
// Offline app-shell cache for Meus Drinks. Scope-prefixed so multiple
// catalog apps under the same GitHub Pages account never collide.

const scopeKey = new URL(self.registration.scope).pathname.replace(/[^a-z0-9]/gi, "-");
const CACHE_PREFIX = `meus-drinks-${scopeKey}-`;
// Bump this suffix (v1 -> v2 -> ...) on every deployment that changes the shell.
const CACHE_NAME = `${CACHE_PREFIX}v4`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./backup.js",
  "./validation.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Precache the whole shell atomically: if any asset fails, the
      // install fails rather than leaving a half-cached shell.
      await cache.addAll(APP_SHELL);
    })()
  );
  // Do NOT self.skipWaiting() here — an update is only applied once the
  // user approves it via the in-app "Atualizar" banner.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never proxy cross-origin
  if (!url.pathname.startsWith(self.registration.scope.replace(self.location.origin, ""))) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: false });
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Only cache genuinely successful, same-origin responses, and only
        // for requests that are part of the app shell scope (avoids
        // silently growing the cache with unrelated runtime data).
        if (response.ok && APP_SHELL.includes(toShellKey(url))) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        if (request.mode === "navigate") {
          const fallback = await cache.match("./index.html");
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});

function toShellKey(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  let rel = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : url.pathname;
  if (rel === "") rel = "./";
  else if (!rel.startsWith("./")) rel = `./${rel}`;
  return rel;
}
