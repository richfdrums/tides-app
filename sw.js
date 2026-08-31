/* Tides — offline shell.
   Predictions are astronomical and never change once published, so a cached
   copy is never stale in the way a weather cache would be. Bump CACHE when
   the app or the baked data is republished. */

var CACHE = "tides-v1";

var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./data/tides.json",
  "./icons/icon.svg",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

/* Cache first. The whole point is that it works at the boat ramp with no
   signal; a network-first strategy would stall exactly when it matters. */
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match("./index.html");
      });
    })
  );
});
