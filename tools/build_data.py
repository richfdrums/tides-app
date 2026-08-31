#!/usr/bin/env python3
"""
Assemble data/tides.json for the Tides app.

The tide predictions come from NOAA CO-OPS. They are astronomical
computations published years ahead and do not change once issued, so the app
bakes them in rather than fetching at runtime.

The raw pull happens elsewhere (NOAA is not reachable from every environment);
this script only assembles verified day-strings into the file the app loads,
and re-checks the invariants that matter before writing anything.

Input:  data/part*.txt  — one day per line, in date order from START.
        A blank line means "no predictions for this day".
Output: data/tides.json

Encoding, one line per day, tides comma-separated:
    <TYPE><minutes-after-midnight>:<thousandths-of-a-foot>
    e.g. "L148:345,H503:2200,L870:251,H1238:2343"

Heights are stored in THOUSANDTHS — NOAA's full published precision, which
never exceeds three decimals. This matters: an earlier build stored
hundredths, and rounding twice (0.345 -> 35 -> 0.4 ft) disagreed with NOAA's
own 0.3 ft. Store exactly what NOAA published and round exactly once, at
display time.

Usage:  python3 tools/build_data.py
"""

import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

START = date(2026, 8, 31)
END = date(2030, 12, 31)

META = {
    "station": "8635299",
    "name": "Port Royal",
    "state": "VA",
    "lat": 38.1733,
    "lon": -77.19,
    "datum": "MLLW",
    "units": "ft",
    "timezone": "America/New_York",
    "timeBasis": "local station time (NOAA lst_ldt), DST already applied",
    "source": "NOAA CO-OPS datagetter, product=predictions interval=hilo",
    "encoding": "days[i] = tides for start + i days; each tide "
                "<TYPE><minutes-after-midnight>:<thousandths-of-a-foot>",
}

TIDE_RE = re.compile(r"^([HL])(\d{1,4}):(-?\d{1,5})$")


def load_parts():
    parts = sorted(DATA.glob("part*.txt"))
    if not parts:
        sys.exit("No data/part*.txt files found. Nothing to assemble.")
    days = []
    for p in parts:
        text = p.read_text().strip("\n")
        lines = text.split("\n") if text else []
        days.extend(line.strip() for line in lines)
        print(f"  {p.name}: {len(lines)} days")
    return days


def verify(days):
    """Fail loudly rather than ship a file that is quietly wrong."""
    problems = []
    expected = (END - START).days + 1

    if len(days) != expected:
        problems.append(
            f"expected {expected} days ({START} .. {END}), got {len(days)}"
        )

    counts = {}
    empty = []
    negatives = 0

    for i, enc in enumerate(days):
        day = START + timedelta(days=i)
        if not enc:
            empty.append(str(day))
            continue

        tides = enc.split(",")
        counts[len(tides)] = counts.get(len(tides), 0) + 1

        if not 3 <= len(tides) <= 5:
            problems.append(f"{day}: {len(tides)} tides (expected 3-5)")

        prev_min = -1
        prev_type = None
        for tok in tides:
            m = TIDE_RE.match(tok)
            if not m:
                problems.append(f"{day}: malformed token {tok!r}")
                continue
            ttype, mins, th = m.group(1), int(m.group(2)), int(m.group(3))

            if not 0 <= mins <= 1439:
                problems.append(f"{day}: minute {mins} out of range")
            if mins <= prev_min:
                problems.append(f"{day}: times not ascending at {tok}")
            if ttype == prev_type:
                problems.append(f"{day}: two {ttype} in a row at {tok}")
            if not -3000 <= th <= 9000:
                problems.append(f"{day}: implausible height {th/1000} ft")
            if th < 0:
                negatives += 1

            prev_min, prev_type = mins, ttype

    print(f"  days:            {len(days)}")
    print(f"  tides per day:   {dict(sorted(counts.items()))}")
    print(f"  negative heights:{negatives}")
    if empty:
        print(f"  EMPTY DAYS:      {len(empty)} -> {empty[:5]}")
        problems.append(f"{len(empty)} day(s) have no predictions")

    return problems


def main():
    print("Loading parts:")
    days = load_parts()

    print("\nVerifying:")
    problems = verify(days)

    if problems:
        print(f"\nFAILED — {len(problems)} problem(s):")
        for p in problems[:25]:
            print(f"  - {p}")
        if len(problems) > 25:
            print(f"  ... and {len(problems) - 25} more")
        sys.exit(1)

    payload = dict(META)
    payload.update({
        "generated": date.today().isoformat(),
        "start": START.isoformat(),
        "end": END.isoformat(),
        "days": days,
    })

    out = DATA / "tides.json"
    out.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"\nOK — wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
