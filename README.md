# Timecard Tracker

A single-page timecard tracker for two-week pay periods that run **Saturday → Friday**
with **80 regular hours**. Enter each day's start, end, and break; split the resulting
hours across your charge codes; log PTO; and watch regular, overtime, and remaining
hours update live.

No build step, no dependencies, no server. Everything is stored in your browser's
local storage — nothing is uploaded anywhere.

## Features

- **Pay periods** — configure the start date once (it snaps to a Saturday); every
  period after that is a 14-day stride from it. Navigate with ◀ ▶ or jump to Today.
- **Charge codes** — add per-period codes, each marked *regular* or *overtime*.
  One click copies last period's codes forward.
- **Daily entry** — start/end/break gives you worked hours; split those hours across
  charge codes. A balance chip per day shows `✓ balanced`, `N unallocated`, or
  `N over worked`, with a **fill** button to dump the remainder into a code.
- **Live totals** — regular (of 80), overtime, PTO, remaining, and total paid, plus
  a progress bar and per-code period totals.
- **PTO** — entered per day, counts toward the 80 regular hours, never creates overtime.
- **Export** — CSV of `date × charge code × hours` for pasting into your real
  timesheet, plus a full JSON backup you can re-import.
- Works in light and dark mode, prints cleanly, and keeps two open tabs in sync.

## How hours are calculated

Over a whole pay period, where `R` is hours on regular codes, `O` is hours on
overtime codes, and `P` is PTO:

```
overtime         = O + max(0, R - 80)
regularWorked    = min(R, 80)
regularTotal     = regularWorked + P
regularRemaining = max(0, 80 - regularTotal)
totalPaid        = regularTotal + overtime
```

Consequences worth knowing:

- **Overtime is a period-level concept.** A 46-hour week followed by a 34-hour week
  is 80 regular hours and zero overtime — the short week offsets the long one.
- **Hours on an overtime code are always overtime**, regardless of the 80-hour mark.
- **PTO fills regular hours but never triggers overtime.** The 80-hour threshold is
  measured against worked regular hours alone. So if you work 80 hours *and* take
  8 hours of PTO, you'll see 88 regular hours and no overtime, flagged with an
  "over 80" note rather than silently capped.
- A day whose end time is at or before its start time is treated as an **overnight
  shift** and the row is labelled accordingly.

## Running it locally

The app uses ES modules, which browsers refuse to load over `file://`. Serve the
folder over HTTP:

```bash
cd timecard-tracker
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Tests

Open <http://localhost:8000/tests/> — a zero-dependency in-browser runner covering
the pay-period date math, the hour/overtime rules, and CSV/JSON export. The page
title reads `PASS (n)` or `FAIL (n)`, and results are also on `window.__testResults`
for headless drivers.

<http://localhost:8000/tests/ui-smoke.html> is an integration pass that loads the
real `index.html` markup and drives `ui.js` through it — adding codes, typing hours,
filling remainders, navigating periods, and exporting. It snapshots and restores
your saved timecard, so it is safe to run against a browser holding real data.

Both suites run headlessly, which is handy in CI or from a terminal:

```bash
"path/to/msedge" --headless --disable-gpu --user-data-dir=/tmp/p \
  --virtual-time-budget=15000 --dump-dom http://localhost:8000/tests/
```

## Deploying to GitHub Pages

This repo is static and Pages-ready as-is; every asset path is relative, so it works
from a project subpath like `https://<user>.github.io/timecard-tracker/`.

```bash
gh repo create timecard-tracker --public --source . --push
```

Then in the repository: **Settings → Pages → Build and deployment → Deploy from a
branch → `main` / `root`**. No Actions workflow or build is needed.

## Data and backups

State lives under the single local-storage key `timecard-tracker/v1`, scoped to the
origin serving the page. That means:

- Clearing site data, using a different browser, or switching between `localhost`
  and the Pages URL each gives you a separate, empty timecard.
- **Export a JSON backup** before clearing site data or moving machines. Import
  replaces all local state with the file's contents.

## Project layout

```
index.html          app shell
styles.css          all styling; light/dark and print
src/payperiod.js    pay-period date math (pure)
src/calc.js         hour and overtime rules (pure) — the single source of truth
src/state.js        state shape, normalization, localStorage
src/exporters.js    CSV/JSON export and import
src/ui.js           rendering and event wiring
src/main.js         entry point
tests/index.html    in-browser unit test runner
tests/ui-smoke.html integration pass that drives the real UI
```

`calc.js` and `payperiod.js` are pure and DOM-free — if a pay rule needs to change,
`calc.js` is the only file to touch.
