# Timecard Tracker

A single-page timecard tracker for two-week pay periods that run **Saturday → Friday**
with **80 regular hours**. Each week is a grid of days across by charge codes down:
enter each day's start, end, and break (in minutes); charge those hours to any of your
codes in tenth-of-an-hour steps; log PTO; and watch regular, overtime, and remaining
hours update live. Every day shows what it worked against the hours your week format —
5 × 8, 4 × 10, or either half of a 9/80 — expects of it. It assumes a desktop-width
window.

No build step, no dependencies, no server. Everything is stored in your browser's
local storage — nothing is uploaded anywhere.

## Features

- **Time calculator** — a scratch pad at the top of the page: give it a start and an
  end and it reports the span in tenths of an hour (`8.4 hrs`) alongside the exact
  `8h 25m`. It uses the same overnight rule as the grid and saves nothing.
- **Pay periods** — configure the start date once (it snaps to a Saturday); every
  period after that is a 14-day stride from it. Navigate with ◀ ▶ or jump to Today.
- **Charge codes** — add per-period codes, each marked *regular* or *overtime*. The
  same code can be carried under both types, for employers who bill overtime against
  the same number; the two get their own rows, tagged `REG` and `OT`. A code is a
  duplicate only if its name *and* type already exist. One click copies last period's
  codes forward.
- **Daily entry** — each week is a matrix: the seven days across the top, and down
  the left the start/end/break/worked rows, then a row per charge code, then PTO and
  the balance. So Monday can be split two ways and Tuesday charged to something else
  entirely, and a code's week reads straight across. Hours go in in tenths of an hour
  (`0.1`); the break goes in as whole **minutes** (`30`), since that is how breaks are
  actually taken. A balance chip per day shows `✓ balanced`, `N unallocated`, or `N
  over worked`, with a **fill** button to dump the remainder into that day's code.
- **Hours worked per day, against a target** — every day reports what it worked and
  what your **week format** expects of it (`8.75` / `of 9`): green once the day is met,
  amber while it is short, and `off` on a day the schedule doesn't work. PTO counts
  toward the target, so a leave day reads as met rather than as a day missed. Hours on
  a scheduled day off are called out as `not scheduled` — usually where overtime starts.
- **Week formats** — pick the shape your 80 hours are worked in (Settings → Week format):

  | Format | Mon–Thu | First Friday | Second Friday | Weeks |
  | --- | --- | --- | --- | --- |
  | 5 × 8-hour days | 8 | 8 | 8 | 40 + 40 |
  | 4 × 10-hour days | 10 | off | off | 40 + 40 |
  | 9/80 A | 9 | off | 8 | 36 + 44 |
  | 9/80 B | 9 | 8 | off | 44 + 36 |

  All four total 80 hours a period. The format is a **target only** — it changes what
  each day is compared against, never how regular, overtime, or PTO are worked out.
- **Week totals** — a right-hand column totals every row of the matrix: break (minutes),
  worked, each charge code, PTO, and what the week still has unallocated. The week
  heading reads worked against the week's scheduled hours (`Worked 36.00 of 44`).
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
- **The week format changes none of this.** Working a 9/80 Friday that the schedule
  has off is flagged on the day, but whether those hours are overtime still comes
  down to the code they are charged to and the 80-hour period total.

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
- Timecards saved before breaks moved to minutes are migrated when they load, whether
  from local storage or an imported backup: a `0.5`-hour break becomes `30` minutes.

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
