/* Verification harness for the Tides app.
   Serves the site, drives it in an iPhone-sized Chromium with the station's
   timezone, and asserts the behaviours the spec calls out as risky. */

const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8731;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
    res.end(fs.readFileSync(f));
  }).listen(PORT);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/* Freeze the clock at a chosen instant so time-dependent behaviour is
   reproducible. Value is an ISO instant in UTC. */
function freezeClock(iso) {
  return `(() => {
    const fixed = new Date(${JSON.stringify(iso)}).getTime();
    const RealDate = Date;
    function FakeDate(...a) {
      if (a.length === 0) return new RealDate(fixed);
      return new RealDate(...a);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = () => fixed;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;
  })()`;
}

async function boot(browser, iso) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },     // iPhone 16 Pro logical size
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    timezoneId: "America/New_York",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  });
  const errors = [];
  const page = await ctx.newPage();
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  if (iso) await page.addInitScript(freezeClock(iso));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
  await page.waitForSelector(".tide, .msg", { timeout: 8000 });
  return { ctx, page, errors };
}

async function rows(page) {
  return page.$$eval(".tide", els => els.map(e => ({
    type: e.querySelector(".badge").textContent,
    time: e.querySelector(".time").textContent,
    height: e.querySelector(".height").textContent,
    past: e.classList.contains("past"),
    next: e.classList.contains("next"),
    note: e.querySelector(".note") ? e.querySelector(".note").textContent : null
  })));
}

(async () => {
  const server = serve();
  const browser = await chromium.launch();

  try {
    // ---- 1. Opens on today, mid-afternoon ---------------------------------
    // 2026-08-31 18:15Z == 14:15 EDT. Tides that day: L02:28 H08:23 L14:30 H20:38
    {
      const { ctx, page, errors } = await boot(browser, "2026-08-31T18:15:00Z");
      const r = await rows(page);
      const head = await page.textContent("#bigdate");

      check("opens on today", head.trim() === "August 31, 2026", head);
      check("renders 4 tides", r.length === 4, `got ${r.length}`);
      check("time format is zero-padded 12h",
            r[0].time === "02:28 AM" && r[3].time === "08:38 PM",
            `${r[0].time} / ${r[3].time}`);
      check("height rounds to a tenth",
            r[0].height === "0.3 ft" && r[3].height === "2.3 ft",
            `${r[0].height} / ${r[3].height}`);
      check("past tides dimmed", r[0].past && r[1].past && !r[3].past,
            r.map(x => x.past ? "past" : "-").join(","));
      check("next tide is the 14:30 low",
            r[2].next && r[2].time === "02:30 PM",
            r.find(x => x.next) ? r.find(x => x.next).time : "none");
      check("countdown present and sane",
            /^Next · in 0h?15m|^Next · in 15m/.test(r[2].note || "") || /in \d+m/.test(r[2].note || ""),
            r[2].note);
      check("no console errors on load", errors.length === 0, errors.join(" | "));
      await page.screenshot({ path: path.join(ROOT, "tools/shot-today.png") });
      await ctx.close();
    }

    // ---- 2. After the day's last tide: rolls to tomorrow -------------------
    // 2026-09-01 03:30Z == 2026-08-31 23:30 EDT — every tide that day has passed.
    {
      const { ctx, page } = await boot(browser, "2026-09-01T03:30:00Z");
      const r = await rows(page);
      const nx = r.find(x => x.next);
      check("after last tide, next rolls to tomorrow",
            !!nx && /Tomorrow/.test(nx.note || ""),
            nx ? nx.note : "no next row");
      check("no negative countdown",
            !r.some(x => /-\d/.test(x.note || "")),
            r.map(x => x.note).filter(Boolean).join(" | "));
      check("all of today's tides show as past",
            r.filter(x => !x.next).every(x => x.past),
            r.map(x => `${x.time}:${x.past}`).join(","));
      await ctx.close();
    }

    // ---- 3. A three-tide day ---------------------------------------------
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      await page.fill("#dateInput", "2026-09-04");
      await page.waitForTimeout(250);
      const r = await rows(page);
      check("2026-09-04 renders exactly 3 tides", r.length === 3, `got ${r.length}`);
      check("no next/past styling on a non-today date",
            !r.some(x => x.next || x.past), "styling leaked");
      await ctx.close();
    }

    // ---- 4. Negative heights never render as "-0.0" -----------------------
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      await page.fill("#dateInput", "2026-11-24");
      await page.waitForTimeout(250);
      const r = await rows(page);
      check("negative-height day renders",
            r.length === 4, `got ${r.length}`);
      check("no '-0.0 ft' anywhere",
            !r.some(x => x.height === "-0.0 ft"),
            r.map(x => x.height).join(", "));
      check("-0.04 ft displays as 0.0 ft",
            r[1].height === "0.0 ft", r[1].height);
      await ctx.close();
    }

    // ---- 5. Range bounds --------------------------------------------------
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      const min = await page.getAttribute("#dateInput", "min");
      const max = await page.getAttribute("#dateInput", "max");
      check("picker bounded to baked range",
            min === "2026-08-31" && max === "2030-12-31", `${min} .. ${max}`);
      check("prev disabled on the first day",
            await page.isDisabled("#prev"), "enabled");

      await page.fill("#dateInput", "2030-12-31");
      await page.waitForTimeout(250);
      check("next disabled on the last day",
            await page.isDisabled("#next"), "enabled");
      const r = await rows(page);
      check("last day renders", r.length >= 3, `got ${r.length}`);
      await ctx.close();
    }

    // ---- 6. Day stepping --------------------------------------------------
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      await page.click("#next");
      await page.waitForTimeout(200);
      check("next-day steps forward",
            (await page.textContent("#bigdate")).trim() === "September 1, 2026",
            await page.textContent("#bigdate"));
      await page.click("#prev");
      await page.waitForTimeout(200);
      check("prev-day steps back",
            (await page.textContent("#bigdate")).trim() === "August 31, 2026",
            await page.textContent("#bigdate"));
      check("Today chip hidden when viewing today",
            !(await page.isVisible("#todayBtn")), "visible");
      await page.click("#next");
      await page.waitForTimeout(200);
      check("Today chip appears on another date",
            await page.isVisible("#todayBtn"), "hidden");
      await page.screenshot({ path: path.join(ROOT, "tools/shot-otherday.png") });
      await ctx.close();
    }

    // ---- 7. Timezone independence ----------------------------------------
    // Same instant, phone set to Los Angeles. "Today" must still be the
    // station's day, not the viewer's.
    {
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 }, timezoneId: "America/Los_Angeles"
      });
      const page = await ctx.newPage();
      await page.addInitScript(freezeClock("2026-09-01T03:30:00Z")); // 23:30 EDT / 20:30 PDT
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
      await page.waitForSelector(".tide");
      check("today follows the station, not the phone",
            (await page.textContent("#bigdate")).trim() === "August 31, 2026",
            await page.textContent("#bigdate"));
      await ctx.close();
    }

    // ---- 8. No horizontal overflow, longest date, smallest phone ----------
    for (const w of [320, 375, 393, 430]) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: 700 }, timezoneId: "America/New_York"
      });
      const page = await ctx.newPage();
      await page.addInitScript(freezeClock("2026-08-31T18:15:00Z"));
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
      await page.waitForSelector(".tide");
      await page.fill("#dateInput", "2026-09-30");   // longest rendered date string
      await page.waitForTimeout(200);

      const m = await page.evaluate(() => {
        const de = document.documentElement;
        const big = document.querySelector(".bigdate");
        const wrap = document.querySelector(".date-wrap");
        return {
          bodyOverflow: de.scrollWidth - de.clientWidth,
          dateOverflow: Math.round(big.scrollWidth - wrap.clientWidth),
          text: document.getElementById("bigdate").textContent
        };
      });
      check(`no page overflow @${w}px`, m.bodyOverflow <= 0, `${m.bodyOverflow}px`);
      check(`date fits on one line @${w}px`, m.dateOverflow <= 0, `"${m.text}" overflows by ${m.dateOverflow}px`);
      await ctx.close();
    }

    // ---- 9. Tap targets meet the 44pt minimum -----------------------------
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      const small = await page.evaluate(() =>
        ["#prev", "#next", "#dateInput"].filter(sel => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        })
      );
      check("controls are at least 44pt", small.length === 0, small.join(", "));
      await ctx.close();
    }

    // ---- 10. Date picker opens where Chrome needs an explicit call --------
    // Chrome and Firefox only open a date picker from its calendar icon (hidden
    // here) or from showPicker(). Safari opens it on a tap of the field. The
    // transparent input sits above the button and swallows the click, so the
    // handler must be on the input. Stub showPicker so headless doesn't try to
    // render a real picker, and assert it actually gets invoked.
    {
      const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, timezoneId: "America/New_York" });
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.__pickerCalls = 0;
        Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
          configurable: true, writable: true,
          value: function () { window.__pickerCalls++; }
        });
      });
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
      await page.waitForSelector(".tide");

      await page.click(".date-wrap");          // clicks whatever is topmost — the input
      const afterHeading = await page.evaluate(() => window.__pickerCalls);
      check("clicking the date heading opens the picker", afterHeading >= 1,
            `showPicker called ${afterHeading}x`);

      const receiver = await page.evaluate(() => {
        const r = document.querySelector(".date-wrap").getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el.id || el.tagName;
      });
      check("the input is the element receiving the click", receiver === "dateInput", receiver);
      await ctx.close();
    }

    // Separately confirm the API this fix depends on actually exists unstubbed
    // in a Chromium-family browser — otherwise the test above only proves the
    // stub was reachable.
    {
      const { ctx, page } = await boot(browser, "2026-08-31T18:15:00Z");
      const native = await page.evaluate(() =>
        typeof document.getElementById("dateInput").showPicker === "function");
      check("showPicker exists natively in Chromium", native, String(native));
      await ctx.close();
    }

    // ---- 11. Station links to the station's position on Google Maps -------
    {
      const { ctx, page, errors } = await boot(browser, "2026-08-31T18:15:00Z");
      const a = await page.evaluate(() => {
        const el = document.getElementById("stationLink");
        const r = el.getBoundingClientRect();
        return {
          href: el.getAttribute("href"),
          target: el.getAttribute("target"),
          rel: el.getAttribute("rel"),
          text: document.getElementById("stationText").textContent,
          aria: el.getAttribute("aria-label"),
          h: r.height
        };
      });
      check("station text is built from the data",
            a.text === "Port Royal, VA · Station 8635299", a.text);
      check("station links to Google Maps at the station's coordinates",
            a.href === "https://www.google.com/maps/search/?api=1&query=38.1733%2C-77.19", a.href);
      check("station link opens safely in a new tab",
            a.target === "_blank" && /noopener/.test(a.rel || ""), `${a.target} / ${a.rel}`);
      check("station link has an accessible name", /Google Maps/.test(a.aria || ""), a.aria);
      check("station link meets the 44pt tap target", a.h >= 44, `${Math.round(a.h)}px`);
      check("no console errors with the station link", errors.length === 0, errors.join(" | "));
      await ctx.close();
    }

    // ---- 12. A deploy reaches a client that already installed the app -----
    // This is the regression that matters: the first service worker was
    // cache-first with a fixed cache name, so a shipped change could never
    // reach a phone that had already installed the app. Install the worker,
    // change the file on disk the way a deploy would, reload, and demand to
    // see the new build.
    {
      const indexPath = path.join(ROOT, "index.html");
      const original = fs.readFileSync(indexPath, "utf8");
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 },
        timezoneId: "America/New_York",
        serviceWorkers: "allow"
      });
      try {
        const page = await ctx.newPage();
        await page.addInitScript(freezeClock("2026-08-31T18:15:00Z"));
        await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
        await page.waitForSelector(".tide");

        await page.waitForFunction(() => navigator.serviceWorker.controller !== null,
                                   null, { timeout: 15000 });
        check("service worker takes control of the page", true, "");

        const before = await page.textContent("#foot");

        // Simulate a deploy: the build marker changes, as it would on any push.
        fs.writeFileSync(indexPath,
          original.replace('var BUILD = "', 'var BUILD = "DEPLOYED-'), "utf8");

        await page.reload({ waitUntil: "networkidle" });
        await page.waitForSelector(".tide");
        const after = await page.textContent("#foot");

        check("a deployed change reaches an already-installed client",
              /DEPLOYED-/.test(after) && after !== before,
              `before: ${before.split("\n").pop()} | after: ${after.split("\n").pop()}`);

        // And it must still work with the network gone.
        await ctx.setOffline(true);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForSelector(".tide", { timeout: 10000 });
        const offlineRows = await page.$$eval(".tide", els => els.length);
        check("still works offline after the change", offlineRows >= 3, `${offlineRows} rows`);
        await ctx.setOffline(false);
      } finally {
        fs.writeFileSync(indexPath, original, "utf8");
        await ctx.close();
      }
    }

    // ---- 13. Opened from disk: explain, don't just fail -------------------
    {
      const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
      const page = await ctx.newPage();
      await page.goto("file://" + path.join(ROOT, "index.html"));
      await page.waitForSelector(".msg", { timeout: 8000 });
      const text = await page.textContent(".msg");
      check("file:// shows a useful message, not a bare error",
            /http\.server|localhost/.test(text), text.slice(0, 90));
      await ctx.close();
    }

  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
