// Hour rollups. Pure and DOM-free: this is the only place the pay rules live.
//
// Rules, over a whole pay period:
//   R = hours allocated to charge codes of type "regular"
//   O = hours allocated to charge codes of type "overtime"
//   P = PTO hours
//
//   overtime         = O + max(0, R - 80)
//   regularWorked    = min(R, 80)
//   regularTotal     = regularWorked + P
//   regularRemaining = max(0, 80 - regularTotal)
//
// PTO fills regular hours but never produces overtime: the 80-hour threshold is
// evaluated against worked regular hours alone.
//
// The week format (see WEEK_FORMATS) says how those 80 hours are *expected* to
// fall across the 14 days. It is a target to show progress against, nothing
// more: no rule above reads it, and every format totals the same 80 hours.

import { daysBetween, periodDays, weekIndexOf } from './payperiod.js';

export const REGULAR_HOURS_PER_PERIOD = 80;

/** Hours are stored as floats; round display-side math to avoid 7.999999. */
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Hours are entered and reported in tenths. */
export function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** "07:30" -> 7.5. Returns null for blank or malformed input. */
export function parseTimeToHours(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h + m / 60;
}

export function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Hours from one clock time to another, or null if either is missing. An end at
 * or before the start is read as an overnight shift (+24h).
 */
export function spanHours(startValue, endValue) {
  const start = parseTimeToHours(startValue);
  const end = parseTimeToHours(endValue);
  if (start === null || end === null) return null;
  let span = end - start;
  if (span <= 0) span += 24;
  return round2(span);
}

/** Breaks are entered in whole minutes, unlike every other figure here. */
export function dayBreakMinutes(day) {
  return Math.max(0, toNumber(day && day.breakMinutes));
}

/** Worked hours for one day: the span less the break, clamped at zero. */
export function dayWorked(day) {
  if (!day) return 0;
  const span = spanHours(day.start, day.end);
  if (span === null) return 0;
  return round2(Math.max(0, span - dayBreakMinutes(day) / 60));
}

/** True when the entry crosses midnight, so the UI can hint at it. */
export function isOvernight(day) {
  if (!day) return false;
  const start = parseTimeToHours(day.start);
  const end = parseTimeToHours(day.end);
  if (start === null || end === null) return false;
  return end <= start;
}

/** Total hours the day spreads across charge codes. */
export function dayAllocated(day) {
  if (!day || !day.alloc) return 0;
  let total = 0;
  for (const hours of Object.values(day.alloc)) total += toNumber(hours);
  return round2(total);
}

/** Worked minus allocated: positive means hours still need a charge code. */
export function dayVariance(day) {
  return round2(dayWorked(day) - dayAllocated(day));
}

export function dayPTO(day) {
  return round2(Math.max(0, toNumber(day && day.pto)));
}

/** True once a day has anything worth persisting or reporting. */
export function dayIsEmpty(day) {
  if (!day) return true;
  if (day.start || day.end || day.note) return false;
  if (toNumber(day.breakMinutes) !== 0 || toNumber(day.pto) !== 0) return false;
  return dayAllocated(day) === 0;
}

// --- week formats ----------------------------------------------------------

/** One week of a schedule: Saturday, Sunday, then Monday through Friday. */
function scheduleWeek(weekdayHours, fridayHours = weekdayHours) {
  return [0, 0, weekdayHours, weekdayHours, weekdayHours, weekdayHours, fridayHours];
}

/**
 * The shapes a 80-hour pay period can be worked in. `weeks` holds the expected
 * hours for each day of week 1 and week 2, Saturday first — the two differ only
 * for 9/80, where one Friday is off and the other is a short day.
 */
export const WEEK_FORMATS = [
  {
    id: '5x8',
    label: '5 × 8-hour days',
    hint: 'Monday to Friday, 8 hours each.',
    weeks: [scheduleWeek(8), scheduleWeek(8)],
  },
  {
    id: '4x10',
    label: '4 × 10-hour days',
    hint: 'Monday to Thursday, 10 hours each. Fridays off.',
    weeks: [scheduleWeek(10, 0), scheduleWeek(10, 0)],
  },
  {
    id: '9/80a',
    label: '9/80 A — first Friday off',
    hint: '9 hours Monday to Thursday. The first Friday is off; the second is 8 hours.',
    weeks: [scheduleWeek(9, 0), scheduleWeek(9, 8)],
  },
  {
    id: '9/80b',
    label: '9/80 B — second Friday off',
    hint: '9 hours Monday to Thursday. The first Friday is 8 hours; the second is off.',
    weeks: [scheduleWeek(9, 8), scheduleWeek(9, 0)],
  },
];

export const DEFAULT_WEEK_FORMAT = WEEK_FORMATS[0].id;

/** The named format, falling back to the default rather than throwing. */
export function weekFormatById(formatId) {
  return WEEK_FORMATS.find((format) => format.id === formatId) || WEEK_FORMATS[0];
}

/** Expected hours on day `dayIndex` (0–13) of a period. */
export function scheduledHours(formatId, dayIndex) {
  const format = weekFormatById(formatId);
  const week = format.weeks[Math.floor(dayIndex / 7)];
  if (!week) return 0;
  return week[dayIndex % 7] ?? 0;
}

/** Expected hours on a date, which must be inside the period at `startISO`. */
export function scheduledHoursOn(formatId, startISO, dateISO) {
  return scheduledHours(formatId, daysBetween(startISO, dateISO));
}

export function scheduledWeekHours(formatId, weekIndex) {
  return round2(weekFormatById(formatId).weeks[weekIndex].reduce((sum, hours) => sum + hours, 0));
}

export function scheduledPeriodHours(formatId) {
  return round2(scheduledWeekHours(formatId, 0) + scheduledWeekHours(formatId, 1));
}

/**
 * Hours that count against a day's scheduled hours. PTO counts: a day off on
 * leave is a day met, not a day eight hours short.
 */
export function dayCredited(day) {
  return round2(dayWorked(day) + dayPTO(day));
}

function codeTypeMap(period) {
  const types = new Map();
  for (const code of period.codes || []) types.set(code.id, code.type);
  return types;
}

/**
 * Sum a set of days into { R, O, P, worked, allocated, unallocated }.
 * Hours pointing at a deleted code fall back to "regular" so they stay visible
 * in the totals rather than silently vanishing.
 */
function sumDays(period, dates) {
  const types = codeTypeMap(period);
  const days = period.days || {};
  let R = 0;
  let O = 0;
  let P = 0;
  let worked = 0;

  for (const date of dates) {
    const day = days[date];
    if (!day) continue;
    worked += dayWorked(day);
    P += dayPTO(day);
    for (const [codeId, hours] of Object.entries(day.alloc || {})) {
      const amount = toNumber(hours);
      if (types.get(codeId) === 'overtime') O += amount;
      else R += amount;
    }
  }

  const allocated = round2(R + O);
  return {
    R: round2(R),
    O: round2(O),
    P: round2(P),
    worked: round2(worked),
    allocated,
    unallocated: round2(worked - allocated),
  };
}

function applyRules(sums) {
  const spill = Math.max(0, sums.R - REGULAR_HOURS_PER_PERIOD);
  const regularWorked = Math.min(sums.R, REGULAR_HOURS_PER_PERIOD);
  const overtime = round2(sums.O + spill);
  const regularTotal = round2(regularWorked + sums.P);
  return {
    ...sums,
    spill: round2(spill),
    regularWorked: round2(regularWorked),
    overtime,
    regularTotal,
    regularRemaining: round2(Math.max(0, REGULAR_HOURS_PER_PERIOD - regularTotal)),
    totalPaid: round2(regularTotal + overtime),
    overRegularCap: regularTotal > REGULAR_HOURS_PER_PERIOD,
  };
}

/** Per-charge-code totals for the period, in the order codes were added. */
export function totalsByCode(period, dates) {
  const days = period.days || {};
  const totals = new Map();
  for (const code of period.codes || []) totals.set(code.id, 0);
  for (const date of dates) {
    const day = days[date];
    if (!day) continue;
    for (const [codeId, hours] of Object.entries(day.alloc || {})) {
      if (!totals.has(codeId)) continue;
      totals.set(codeId, totals.get(codeId) + toNumber(hours));
    }
  }
  const out = new Map();
  for (const [codeId, hours] of totals) out.set(codeId, round2(hours));
  return out;
}

/**
 * Week rollup. Reported without the 80-hour rule applied, since overtime is a
 * period-level concept here — a long week can be offset by a short one.
 */
export function weekTotals(period, startISO, weekIndex) {
  const dates = periodDays(startISO).filter(
    (date) => weekIndexOf(startISO, date) === weekIndex,
  );
  const sums = sumDays(period, dates);
  return { ...sums, dates, paid: round2(sums.allocated + sums.P) };
}

/** Full period rollup with the pay rules applied. */
export function periodTotals(period, startISO) {
  const dates = periodDays(startISO);
  const totals = applyRules(sumDays(period, dates));
  return { ...totals, byCode: totalsByCode(period, dates) };
}
