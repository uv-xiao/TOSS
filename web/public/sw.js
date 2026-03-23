const STATIC_CACHE = "typst-static-v1";
const TYPST_CACHE = "typst-runtime-v1";
const PROJECT_CACHE = "typst-project-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(["/", "/index.html"]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => ![STATIC_CACHE, TYPST_CACHE, PROJECT_CACHE].includes(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isTypstRuntimePath(pathname) {
  return pathname.startsWith("/typst-wasm/") || pathname.startsWith("/v1/typst/packages/");
}

function isProjectMetadataPath(pathname) {
  if (!pathname.startsWith("/v1/projects/")) return false;
  return (
    pathname.includes("/documents") ||
    pathname.endsWith("/tree") ||
    pathname.includes("/assets/") && pathname.endsWith("/raw")
  );
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const network = await fetch(request);
  if (network.ok) {
    cache.put(request, network.clone()).catch(() => undefined);
  }
  return network;
}

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const network = await fetch(request);
    if (network.ok) {
      cache.put(request, network.clone()).catch(() => undefined);
    }
    return network;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("offline");
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isTypstRuntimePath(url.pathname)) {
    event.respondWith(cacheFirst(TYPST_CACHE, request));
    return;
  }
  if (isProjectMetadataPath(url.pathname)) {
    event.respondWith(networkFirst(PROJECT_CACHE, request));
  }
});
