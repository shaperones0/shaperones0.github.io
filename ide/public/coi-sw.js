// Adds the headers GitHub Pages can't set, so pages under /ide/ get SharedArrayBuffer.
// Served from /ide/, so its default scope leaves the tutorial pages alone.
// Also keeps the versioned Python runtime permanently, since Pages only allows 10 minutes.
const RUNTIME_VERSION = "314.0.7";
const RUNTIME_CACHE = `pyodide-${RUNTIME_VERSION}`;
const RUNTIME_PATH = new URL(`pyodide/${RUNTIME_VERSION}/`, self.location).pathname;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("pyodide-") && name !== RUNTIME_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

function withIsolationHeaders(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchRuntimeFile(event) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(event.request.url);
  if (cached) return cached;
  const response = withIsolationHeaders(await fetch(event.request));
  if (response.ok) event.waitUntil(cache.put(event.request.url, response.clone()));
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(RUNTIME_PATH)) {
    event.respondWith(fetchRuntimeFile(event));
  } else {
    event.respondWith(fetch(request).then(withIsolationHeaders));
  }
});
