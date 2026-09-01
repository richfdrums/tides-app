/* Tides — offline shell.

   Caching strategy, and why:

   The first version of this file was cache-first for every request with a fixed
   cache name. That meant a deployed change could never reach a phone that had
   already installed the app: index.html was served from cache forever, and the
   activate handler that purges old caches never fired, because the cache name
   never changed. Freshness depended on remembering to bump a constant on every
   deploy, which is exactly the kind of discipline that fails silently.

   So freshness is no longer anyone's responsibility to remember:

     Navigations (index.html — the app itself)
         NETWORK FIRST, falling back to cache. The app is a few KB, so the
         round trip is imperceptible online, and offline still works. This is
         what makes a deploy show up.

     Everything else (tide data, icons, manifest)
         STALE WHILE REVALIDATE. Serve the cached copy instantly, fetch a fresh
         one in the background for next time. Nothing blocks on the network, and
         nothing can go stale for more than one load.

   VERSION only needs bumping to force-purge every client's cache — a change to
   this strategy, or bad data shipped by mistake. Routine deploys do not need it.
*/

var VERSION = "2026-09-01";
var CACHE = "tides-" + VERSION;

var PRECACHE = [
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
      .then(function (c) { return c.addAll(PRECACHE); })
      // Take over immediately rather than waiting for every tab to close —
      // otherwise a fixed bug sits unused behind an old worker.
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

function putIfOk(request, response) {
  if (response && response.status === 200 && response.type === "basic") {
    var copy = response.clone();
    caches.open(CACHE).then(function (c) { c.put(request, copy); });
  }
  return response;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;

  if (req.method !== "GET") return;

  // Leave cross-origin requests alone entirely — the Google Maps link, and
  // anything else off-site, is none of this worker's business.
  var sameOrigin = new URL(req.url).origin === self.location.origin;
  if (!sameOrigin) return;

  var isNavigation =
    req.mode === "navigate" ||
    (req.destination === "" && (req.headers.get("accept") || "").indexOf("text/html") !== -1);

  if (isNavigation) {
    // Network first. `cache: "no-cache"` forces revalidation against the server
    // rather than letting the HTTP cache serve a stale copy — GitHub Pages sets
    // a ten-minute max-age, which would otherwise blunt the whole point.
    e.respondWith(
      fetch(req, { cache: "no-cache" })
        .then(function (res) { return putIfOk(req, res); })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match("./index.html");
          });
        })
    );
    return;
  }

  // Stale while revalidate: answer from cache at once, refresh underneath.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req)
        .then(function (res) { return putIfOk(req, res); })
        .catch(function () { return hit; });
      return hit || network;
    })
  );
});

// Lets the page ask which build is actually running, and force an update.
self.addEventListener("message", function (e) {
  if (!e.data) return;
  if (e.data === "version" && e.source) {
    e.source.postMessage({ version: VERSION });
  }
  if (e.data === "skipWaiting") {
    self.skipWaiting();
  }
});
