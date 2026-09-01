# Tides

High and low tide times for **Port Royal, Virginia** (NOAA station 8635299), as an
installable iPhone web app.

Opens to today, highlights the next tide with a live countdown, and lets you jump to
any date through the end of 2030. Works with no signal.

---

## How it works

Tide predictions are **astronomical computations**, not observations. NOAA publishes
them years ahead and they do not change — the value for 08:31 on 2030-07-04 is
already fixed. So this app **bakes the data in** rather than calling an API at
runtime.

That buys a lot: instant load, no backend, no API key, no CORS, no failure mode at
the boat ramp with one bar of signal. The cost is a republish sometime in 2029 to
extend the range.

## Layout

```
index.html              the whole app — inline CSS and JS, no build step
manifest.webmanifest    PWA manifest (name, icons, standalone display)
sw.js                   service worker; cache-first so it works offline
data/
  tides.json            baked predictions, 2026-08-31 .. 2030-12-31
  part1.txt part2.txt   source day-strings the JSON is assembled from
icons/                  wave mark, SVG + rasterised PNGs
tools/
  build_data.py         assembles + verifies data/tides.json
  test_app.js           Playwright verification suite
```

## Data format

`data/tides.json` holds one string per day, indexed by day offset from `start`:

```
days[0] = "L148:345,H503:2200,L870:251,H1238:2343"
           │  │   │
           │  │   └── height in THOUSANDTHS of a foot above MLLW
           │  └────── minutes after local midnight (148 = 02:28)
           └───────── H high, L low
```

**Heights are stored in thousandths — NOAA's full published precision.** This is
load-bearing, not fussiness. An earlier build stored hundredths, and rounding twice
(`0.345 → 0.35 → 0.4 ft`) disagreed with NOAA's own `0.3 ft`. Store exactly what NOAA
published; round exactly once, at display time.

Times come from NOAA with `time_zone=lst_ldt`, which is **station local time with DST
already applied**. That removes all timezone arithmetic from the app. "Today" is
computed in `America/New_York` regardless of where the phone is, so the app shows Port
Royal's day even if you're reading it from another timezone.

## Things the data actually does

Verified across all 1,584 days:

| | |
|---|---|
| Days with 4 tides | 1,370 |
| Days with **3** tides | **214** — the row count is never fixed |
| Days starting with a **High** | 723 — never assume the day opens on a Low |
| **Negative** heights (below MLLW) | 826 — signed formatting is required |
| Missing days | 0 |

DST transition days show times that jump backward relative to the previous day. That
is correct, not a bug — the clock moved, the moon did not.

## Regenerating the data

NOAA is not reachable from every environment, so the raw pull happens separately (see
the project spec). The pull produces `data/part*.txt`; then:

```sh
python3 tools/build_data.py
```

It refuses to write unless every invariant holds: contiguous dates, 3–5 tides per day,
times ascending within a day, highs and lows strictly alternating, plausible heights.

Source request:

```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
  ?product=predictions&interval=hilo&station=8635299
  &datum=MLLW&units=english&time_zone=lst_ldt
  &begin_date=YYYYMMDD&end_date=YYYYMMDD&format=json&application=tides-app
```

Note that NOAA returns errors with **HTTP 200** and an `{"error": {...}}` body, so
checking the status code alone is not enough.

## Running locally

`fetch()` is blocked on `file://` origins, so opening `index.html` straight off disk
will always fail to load `data/tides.json` (and service workers won't register).
Serve it over http instead:

```sh
cd ~/Code/tides-app
python3 -m http.server 8000
```

Then open <http://localhost:8000>. The app detects the `file://` case and says this
on screen rather than showing a bare network error.

## Tests

```sh
node tools/test_app.js
```

Serves the site and drives it in an iPhone-sized Chromium with the station's timezone.
Covers formatting against known-good values, the 3-tide day, negative heights never
rendering as `-0.0`, the rollover when every tide today has passed, range bounds,
timezone independence, horizontal overflow at four phone widths, and 44pt tap targets.

## Deploying

GitHub Pages, from the repository root. No build step — it is static files.

```sh
git add -A && git commit -m "..." && git push
```

Bump `BUILD` in `index.html` when you want to be able to confirm what's live — it
prints in the footer, so "did my deploy land?" is answered by looking at the app.

## Caching, and why a deploy actually shows up

The first service worker was cache-first for every request with a fixed cache name.
That combination is a trap: `index.html` was served from cache forever, and the
`activate` handler that purges old caches never ran, because the cache name never
changed. A shipped fix could not reach a phone that had already installed the app.

Freshness is no longer anyone's job to remember:

| Request | Strategy | Why |
|---|---|---|
| Navigations (`index.html`) | **Network first**, cache fallback | The app is a few KB — the round trip is imperceptible online, and offline still works. This is what makes a deploy show up. |
| Tide data, icons, manifest | **Stale while revalidate** | Instant from cache, refreshed underneath. Nothing blocks on the network; nothing is stale for more than one load. |

The navigation fetch uses `cache: "no-cache"` to force revalidation against the
server — GitHub Pages sets a ten-minute `max-age` that would otherwise blunt the
whole point.

The page side re-checks for a new worker on load and whenever the app returns to the
foreground, and reloads once a newer worker takes control — guarded so the very first
install doesn't reload the app in the user's face.

`VERSION` in `sw.js` only needs bumping to force-purge every client's cache: a change
to this strategy, or bad data shipped by mistake. **Routine deploys do not need it.**

`tools/test_app.js` covers this directly — it installs the worker, changes
`index.html` the way a deploy would, reloads, and demands to see the new build (then
checks it still works offline). That test fails against the old cache-first worker,
which is the point of having it.

### If a client is still stuck

An install that already has the old worker needs to fetch the new `sw.js` once.
Browsers re-check it on navigation, and GitHub Pages caps its `max-age` at ten
minutes, so reopening the app a few minutes after a deploy is normally enough. To
force it:

- **iPhone** — open the site in Safari (not the home-screen icon) and reload, which
  updates the worker for both. If it is truly wedged: Settings → Safari → Advanced →
  Website Data → remove the entry, then reopen.
- **Desktop Chrome** — DevTools → Application → Service Workers → *Unregister*, then
  hard reload. *Update on reload* in that panel is worth ticking while developing.

## Why no tide curve

Port Royal is a **subordinate** station (type `S`). NOAA publishes only highs and lows
for it; requests for 6-minute or hourly data return *"No Predictions data was found."*
A curve, a current-height readout, or a "rising / falling" indicator would therefore be
our own interpolation between the hi/lo points, presented as if it were NOAA's.
Deliberately left out.

## Credits

Tide predictions: [NOAA CO-OPS](https://tidesandcurrents.noaa.gov/), public domain.
