// Minimal service worker: enables PWA installability without caching, so the app
// is always served fresh (no stale-bundle problems). Intentionally no offline cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Pass through to the network. The presence of a fetch handler satisfies
  // installability heuristics; we deliberately don't intercept responses.
});
