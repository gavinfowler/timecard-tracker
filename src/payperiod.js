// Pure date math for two-week pay periods that run Saturday -> Friday.
//
// Everything here speaks date-only ISO strings ("YYYY-MM-DD"). Dates are built
// with `new Date(y, m - 1, d)` rather than parsed from the string, because
// `new Date("2026-08-01")` is parsed as UTC midnight and lands on the previous
// day for anyone west of Greenwich.

const MS_PER_DAY = 86400000;
const PERIOD_LENGTH = 14;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const PERIOD_DAYS = PERIOD_LENGTH;

/** "YYYY-MM-DD" -> local Date at midnight. */
export function fromISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Local Date -> "YYYY-MM-DD". */
export function toISO(date) {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return false;
  const date = fromISO(iso);
  return !Number.isNaN(date.getTime()) && toISO(date) === iso;
}

/** Calendar-day arithmetic. Uses setDate so DST shifts never lose a day. */
export function addDays(iso, days) {
  const date = fromISO(iso);
  date.setDate(date.getDate() + days);
  return toISO(date);
}

/**
 * Whole calendar days from `aISO` to `bISO`. Computed against UTC noon so a
 * DST transition inside the span can't round the division the wrong way.
 */
export function daysBetween(aISO, bISO) {
  const a = fromISO(aISO);
  const b = fromISO(bISO);
  const aUTC = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bUTC = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bUTC - aUTC) / MS_PER_DAY);
}

export function isSaturday(iso) {
  return fromISO(iso).getDay() === 6;
}

/** Snap back to the Saturday on or before `iso`. */
export function alignBackToSaturday(iso) {
  const dow = fromISO(iso).getDay(); // 0 = Sun .. 6 = Sat
  return addDays(iso, dow === 6 ? 0 : -(dow + 1));
}

/** The 14 ISO dates of the period beginning at `startISO`. */
export function periodDays(startISO) {
  const days = [];
  for (let i = 0; i < PERIOD_LENGTH; i += 1) days.push(addDays(startISO, i));
  return days;
}

/** Last day of the period (a Friday, when the start is a Saturday). */
export function periodEndISO(startISO) {
  return addDays(startISO, PERIOD_LENGTH - 1);
}

export function nextPeriodStart(startISO) {
  return addDays(startISO, PERIOD_LENGTH);
}

export function prevPeriodStart(startISO) {
  return addDays(startISO, -PERIOD_LENGTH);
}

/**
 * Start of the period containing `dateISO`, counting in 14-day strides from
 * `anchorISO`. Works for dates before the anchor too, so navigating backwards
 * past the configured start stays on the same Saturday cadence.
 */
export function periodStartContaining(dateISO, anchorISO) {
  const offset = daysBetween(anchorISO, dateISO);
  const strides = Math.floor(offset / PERIOD_LENGTH);
  return addDays(anchorISO, strides * PERIOD_LENGTH);
}

/** 0 for the first week of the period, 1 for the second. */
export function weekIndexOf(startISO, dateISO) {
  return Math.floor(daysBetween(startISO, dateISO) / 7);
}

export function weekdayShort(iso) {
  return WEEKDAY_SHORT[fromISO(iso).getDay()];
}

export function isWeekend(iso) {
  const dow = fromISO(iso).getDay();
  return dow === 0 || dow === 6;
}

/** "Aug 1" — month and day only. */
export function formatShort(iso) {
  const date = fromISO(iso);
  return `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
}

/** "Aug 1 – Aug 14, 2026", collapsing the year when both ends share one. */
export function formatRange(startISO) {
  const endISO = periodEndISO(startISO);
  const start = fromISO(startISO);
  const end = fromISO(endISO);
  if (start.getFullYear() === end.getFullYear()) {
    return `${formatShort(startISO)} – ${formatShort(endISO)}, ${end.getFullYear()}`;
  }
  return `${formatShort(startISO)}, ${start.getFullYear()} – ${formatShort(endISO)}, ${end.getFullYear()}`;
}

export function todayISO() {
  return toISO(new Date());
}
