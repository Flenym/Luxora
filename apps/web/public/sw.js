/*
 * Luxora honest PWA shell service worker.
 *
 * Scope of this cache: PUBLIC shell + static presentation assets only
 * (index HTML, JS/CSS chunks, icons, manifest). It exists so the marketing site
 * and the app shell can start offline; it is NOT an offline messenger.
 *
 * Hard rules (do not relax without a security review):
 *   - NEVER cache API traffic: /v1/*, /v2/* (including realtime), /health/*.
 *   - NEVER cache message, attachment, avatar, profile, session or request data.
 *     Luxora Beta-0.1 is a cloud preview and message content is server-readable;
 *     offline message access is not implemented, so caching it would be a
 *     privacy and truthfulness risk, not a feature.
 *   - Only same-origin GET requests are considered; cross-origin requests pass
 *     through untouched.
 *   - Registration is production-HTTPS only (see src/main.tsx): dev, preview and
 *     the headless E2E harness never install this worker.
 */

const CACHE_NAME = "luxora-public-shell-v1";

/** Public shell assets that are safe to precache (no private data). */
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/logo-32.png",
  "/logo-64.png",
  "/logo-192.png",
  "/logo-512.png",
  "/apple-touch-icon.png",
];

/** API/private paths that must never enter Cache Storage. */
const PRIVATE_PREFIXES = ["/v1/", "/v2/", "/health/"];

const STATIC_ASSET_PATTERN = /\.(?:css|js|mjs|png|jpe?g|svg|webp|gif|ico|woff2?|ttf)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isPrivateRequest(url) {
  return PRIVATE_PREFIXES.some((prefix) => url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isPrivateRequest(url)) return;

  // Navigations: network-first so deployments update immediately; fall back to
  // the cached public shell only when the network is unavailable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Static presentation assets only: cache-first, then network with a bounded
  // same-origin static-extension allowlist before writing back to the cache.
  if (!STATIC_ASSET_PATTERN.test(url.pathname) && !url.pathname.startsWith("/assets/")) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      });
    }),
  );
});
