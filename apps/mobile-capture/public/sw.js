// Offline shell only. Relay API calls always go to the network.
const CACHE = "capture-shell-v4";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function remember(key, response) {
  if (response.ok) {
    const copy = response.clone();
    void caches.open(CACHE).then((cache) => cache.put(key, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) return;
  // The page asks the server directly whether a newer version is deployed.
  if (url.searchParams.has("update-check")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => remember("/", response)).catch(() => caches.match("/")));
    return;
  }

  // Hashed assets never change; the manifest and icons do, so they go to the
  // network first and fall back to the cache offline.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request).then((response) => remember(request, response))));
    return;
  }
  event.respondWith(fetch(request).then((response) => remember(request, response)).catch(() => caches.match(request)));
});
