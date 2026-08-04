const CACHE_NAME = "rhmra-phone-shell-v9";
const SHELL_FILES = [
  "./", "./index.html", "./privacy.html", "./styles.css", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./config.js", "./src/app.js", "./src/cache.js", "./src/expiry.js", "./src/google-drive.js", "./src/poller.js",
  "./src/platform.js", "./src/protocol.js", "./src/render.js", "./src/storage.js",
];
const SHELL_URLS = new Set(SHELL_FILES.map((path) => new URL(path, self.registration.scope).href));
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...SHELL_URLS])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackUrl = null) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok && SHELL_URLS.has(new URL(request.url).href)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (fallbackUrl) return caches.match(fallbackUrl);
    throw new Error("The application shell is unavailable offline.");
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin ||
      !url.href.startsWith(self.registration.scope)) return;

  if (event.request.mode === "navigate") {
    event.respondWith(networkFirst(event.request, INDEX_URL));
    return;
  }

  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith(networkFirst(event.request));
});
