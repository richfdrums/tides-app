# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a PWA (Progressive Web App) that displays tide predictions for Port Royal, Virginia (NOAA station 8635299). The app is designed for offline use at boat ramps with minimal signal. It's an installable iPhone web app with no build step.

**Core principle:** Tide predictions are astronomical computations published years ahead by NOAA and never change. The app bakes all data in rather than calling an API at runtime.

## Commands

### Development Server
```sh
python3 -m http.server 8000
```
Then open http://localhost:8000

**Important:** Opening `index.html` directly via `file://` protocol will fail because browsers block `fetch()` on file origins.

### Data Generation
```sh
python3 tools/build_data.py
```
Assembles `data/tides.json` from `data/part*.txt` files and verifies all invariants before writing. The script will refuse to write unless every invariant holds (contiguous dates, 3-5 tides per day, times ascending within a day, highs and lows strictly alternating, plausible heights).

### Running Tests
```sh
node tools/test_app.js
```
Runs Playwright verification suite in iPhone-sized Chromium with the station's timezone. Covers formatting, edge cases, negative heights, range bounds, timezone independence, overflow, and tap targets.

### Deployment
```sh
git add -A && git commit -m "..." && git push
```
GitHub Pages serves from repository root. No build step required.

## Architecture

### Single-File Design
The entire app is in `index.html` with inline CSS and JavaScript. No build step, no bundler, no dependencies. This is intentional for simplicity and reliability.

### Data Format
`data/tides.json` contains:
- One string per day indexed by day offset from `start` date
- Format: `L148:345,H503:2200,L870:251,H1238:2343`
  - `L`/`H` = Low/High tide
  - `148` = minutes after local midnight (02:28)
  - `345` = height in THOUSANDTHS of a foot above MLLW

**Critical:** Heights are stored in thousandths (NOAA's full precision) and rounded to tenths exactly ONCE at display time. Rounding twice causes disagreements with NOAA's published values (e.g., 0.345 → 0.35 → 0.4 vs NOAA's 0.3).

Times are NOAA `lst_ldt` (local station time with DST already applied), so no timezone arithmetic is needed in the app.

### Timezone Handling
The app always shows Port Royal's day and times (`America/New_York`), regardless of where the phone is located. "Today" is computed in the station's timezone, not the viewer's.

### Service Worker
`sw.js` provides offline functionality with cache-first strategy. Since tide predictions never change once published, cached data is never stale. Bump `CACHE` version when republishing data.

### State Management
All state lives in closures within the IIFE in `index.html`:
- `viewDate` - currently displayed date (ISO string)
- `DATA` - loaded JSON from `data/tides.json`
- `tickTimer` - interval for re-rendering countdown

## Critical Edge Cases (Verified by Tests)

### Variable Tide Counts
- 214 days have 3 tides (not 4)
- Never assume fixed row count or that days start with a Low tide
- 723 days start with a High tide

### Negative Heights
- 826 tides have negative heights (below MLLW)
- Must format as signed values
- **Critical:** Prevent `-0.0 ft` display (values like -0.04 must show as `0.0 ft`)

### Next Tide Rollover
When viewing today and all tides have passed, the "next" indicator rolls to tomorrow's first tide. The countdown calculation is `(1440 - now.minutes) + tomorrow[0].mins`.

### DST Transitions
On DST transition days, times may jump backward relative to the previous day. This is correct - the clock moved, the moon did not.

### Date Picker
Safari opens the native date picker on tap. Chrome/Firefox require explicit `showPicker()` call. The transparent input sits above the button and handles both cases.

## Data Integrity

The `build_data.py` script enforces:
- Contiguous date range (currently 2026-08-31 to 2030-12-31)
- 3-5 tides per day
- Times ascending within each day
- Highs and lows strictly alternating
- Heights in plausible range (-3.000 to 9.000 ft)

NOAA API returns errors with HTTP 200 and `{"error": {...}}` body, so checking status code alone is insufficient.

## Design Constraints

### No Tide Curve
Port Royal is a subordinate station (type S). NOAA publishes only highs and lows - no 6-minute or hourly data. A tide curve would be our interpolation, not NOAA's data, so it's deliberately excluded.

### Single Dark Theme
The app uses only a dark theme because it's read at dawn and dusk on the water. All colors are explicitly painted to avoid inheriting host styles.

### iOS Design Language
- 44pt minimum tap targets
- Large title date display
- Native date picker via `<input type="date">`
- Safe area insets for notched devices
- Prevents zoom-on-focus (16px font on inputs)

## File Structure
```
index.html              Single-file app (HTML + CSS + JS)
manifest.webmanifest    PWA manifest
sw.js                   Service worker for offline capability
data/
  tides.json            Baked predictions (generated)
  part1.txt, part2.txt  Source day-strings
icons/                  SVG + PNG app icons
tools/
  build_data.py         Data assembler and validator
  test_app.js           Playwright test suite
```

## NOAA Data Source
```
https://api.tidesandcurrents.noaa.gov/api/prod/datagetter
  ?product=predictions&interval=hilo&station=8635299
  &datum=MLLW&units=english&time_zone=lst_ldt
  &begin_date=YYYYMMDD&end_date=YYYYMMDD
  &format=json&application=tides-app
```
