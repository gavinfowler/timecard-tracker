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
- **Charge codes** — one table of every code any pay period has ever used, with a
  tick box per row for whether it is in the period you are looking at. Each code
  carries an optional **SUPP code**, a description, and a *regular* or *overtime*
  marking, and each row shows what it has taken this period and when it was last
  charged. A code is a duplicate only if its name, SUPP code *and* type all already
  exist — so the same number can be carried under two SUPP codes, or once as regular
  and once as overtime for employers who bill overtime against the same number. Each
  combination gets its own grid row, tagged `REG` or `OT`. One click copies last
  period's codes forward.
- **Removing a code from the list never touches a pay period.** The `×` on a row takes
  the code out of the list and out of the suggestions, and nothing else: every pay
  period keeps the code and every hour charged to it, and the export is unchanged. It
  stays on screen, greyed and tagged `archived`, for as long as it is still in the
  period you are looking at — untick it separately if you want it out of that period
  too, which *does* delete that period's hours and asks first. **Show archived** lists
  what has been removed, with a **Restore** button. Adding the same code again from
  the form restores it.
- **Daily entry** — each week is a matrix: the seven days across the top, and down
  the left the start/end/break rows, then a row per charge code, then PTO, worked,
  charged and the balance. So Monday can be split two ways and Tuesday charged to something else
  entirely, and a code's week reads straight across. Hours go in in tenths of an hour
  (`0.1`); the break goes in as whole **minutes** (`30`), since that is how breaks are
  actually taken. A balance chip per day shows `✓ balanced`, `N unallocated`, or `N
  over worked`, with a **fill** button to dump the remainder into that day's code.
- **Charged, against worked** — under the code rows, `Charged` totals everything the
  day put on a code *plus* its PTO, sitting directly under what the day worked, so a
  leave day reads as fully charged rather than as eight hours missing.
- **Tab runs down a day, not across the week.** A day owns a column, so plain document
  order would take you across all seven Start boxes before the first End box. Tab
  instead walks one day — start, end, break, each code, PTO, fill, water — and only
  then moves to the next day. Shift+Tab walks back. At the ends of a week the key is
  left to the browser, so focus still leaves the grid normally.
- **Water (oz)** — a row at the foot of each week for logging what you drank, with a
  week total. It has nothing to do with timekeeping: it is stored with the day but
  counts toward no total, appears in no summary, and is left out of the CSV export
  and of print.
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
  worked, each charge code, PTO, charged, water (ounces), and what the week still has
  unallocated. The week
  heading reads worked against the week's scheduled hours (`Worked 36.00 of 44`).
- **Live totals** — regular (of 80), overtime, PTO, remaining, and total paid, plus
  a progress bar and per-code period totals.
- **PTO** — entered per day, counts toward the 80 regular hours, never creates overtime.
- **Export** — CSV of `date × charge code × SUPP code × hours` for pasting into your
  real timesheet, plus a full JSON backup you can re-import.
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
- Files written before SUPP codes, the removed-code list, or the water row existed
  load fine: those fields simply default to empty. The saved shape is now version 3.

Charge codes are stored **per pay period**, each with its own ids, and a day's hours
point at those ids. Nothing links a code in one period to the same code in another, so
a period can only ever be changed by editing that period. The charge code list is not
stored at all — it is derived by reading every period — and removing a code from it
records only its name, SUPP code and type in a separate `archivedCodes` list. That is
why removing a code cannot affect a past pay period: there is nothing shared to break.

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
