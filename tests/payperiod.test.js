import { assert, assertEqual, test } from './runner.js';
import {
  addDays,
  alignBackToSaturday,
  daysBetween,
  formatRange,
  fromISO,
  isSaturday,
  isValidISO,
  isWeekend,
  nextPeriodStart,
  periodDays,
  periodEndISO,
  periodStartContaining,
  prevPeriodStart,
  toISO,
  weekIndexOf,
  weekdayShort,
} from '../src/payperiod.js';

// 2026-08-01 is a Saturday; the period runs through Friday 2026-08-14.
const START = '2026-08-01';

test('fromISO/toISO round-trip stays on the same calendar day', () => {
  // The reason fromISO exists: new Date("2026-08-01") is UTC midnight, which is
  // July 31 in any negative-offset timezone.
  for (const iso of ['2026-01-01', '2026-08-01', '2026-12-31', '2024-02-29']) {
    assertEqual(toISO(fromISO(iso)), iso);
  }
});

test('isValidISO rejects malformed and impossible dates', () => {
  assert(isValidISO('2026-08-01'));
  assert(!isValidISO('2026-8-1'));
  assert(!isValidISO('2026-02-30'));
  assert(!isValidISO(''));
  assert(!isValidISO(null));
});

test('the configured start is a Saturday and the period ends on a Friday', () => {
  assert(isSaturday(START), 'start is Saturday');
  assertEqual(weekdayShort(periodEndISO(START)), 'Fri');
});

test('periodDays returns exactly 14 consecutive days', () => {
  const days = periodDays(START);
  assertEqual(days.length, 14);
  assertEqual(days[0], START);
  assertEqual(days[13], '2026-08-14');
  for (let i = 1; i < days.length; i += 1) {
    assertEqual(daysBetween(days[i - 1], days[i]), 1, `gap before ${days[i]}`);
  }
});

test('a period spanning the spring DST change still has 14 days', () => {
  // US DST begins 2026-03-08, inside this period.
  const start = alignBackToSaturday('2026-03-08');
  assertEqual(start, '2026-03-07');
  const days = periodDays(start);
  assertEqual(days.length, 14);
  assertEqual(days[13], '2026-03-20');
  assertEqual(daysBetween(start, days[13]), 13);
});

test('a period spanning the autumn DST change still has 14 days', () => {
  // US DST ends 2026-11-01, inside this period.
  const start = alignBackToSaturday('2026-11-01');
  assertEqual(start, '2026-10-31');
  const days = periodDays(start);
  assertEqual(days.length, 14);
  assertEqual(days[13], '2026-11-13');
  assertEqual(daysBetween(start, days[13]), 13);
});

test('alignBackToSaturday snaps every weekday back to the Saturday before', () => {
  assertEqual(alignBackToSaturday('2026-08-01'), '2026-08-01'); // Sat -> itself
  assertEqual(alignBackToSaturday('2026-08-02'), '2026-08-01'); // Sun
  assertEqual(alignBackToSaturday('2026-08-03'), '2026-08-01'); // Mon
  assertEqual(alignBackToSaturday('2026-08-07'), '2026-08-01'); // Fri
  assertEqual(alignBackToSaturday('2026-08-08'), '2026-08-08'); // Sat
});

test('next/prev period step by exactly two weeks', () => {
  assertEqual(nextPeriodStart(START), '2026-08-15');
  assertEqual(prevPeriodStart(START), '2026-07-18');
  assertEqual(prevPeriodStart(nextPeriodStart(START)), START);
});

test('periodStartContaining lands on the anchor grid, forwards and backwards', () => {
  assertEqual(periodStartContaining('2026-08-01', START), START);
  assertEqual(periodStartContaining('2026-08-14', START), START);
  assertEqual(periodStartContaining('2026-08-15', START), '2026-08-15');
  assertEqual(periodStartContaining('2026-08-28', START), '2026-08-15');
  assertEqual(periodStartContaining('2026-07-31', START), '2026-07-18');
  assertEqual(periodStartContaining('2026-07-18', START), '2026-07-18');
  assertEqual(periodStartContaining('2026-07-17', START), '2026-07-04');
});

test('periodStartContaining is stable across a DST boundary', () => {
  // Anchored in February, resolved in April: 4 strides, no drift.
  assertEqual(periodStartContaining('2026-04-04', '2026-02-07'), '2026-04-04');
  assertEqual(periodStartContaining('2026-04-17', '2026-02-07'), '2026-04-04');
});

test('weekIndexOf splits the period into two 7-day halves', () => {
  const days = periodDays(START);
  assertEqual(days.filter((d) => weekIndexOf(START, d) === 0).length, 7);
  assertEqual(days.filter((d) => weekIndexOf(START, d) === 1).length, 7);
  assertEqual(weekIndexOf(START, '2026-08-07'), 0);
  assertEqual(weekIndexOf(START, '2026-08-08'), 1);
});

test('weekends are Saturday and Sunday', () => {
  assert(isWeekend('2026-08-01'));
  assert(isWeekend('2026-08-02'));
  assert(!isWeekend('2026-08-03'));
});

test('addDays crosses month and year boundaries', () => {
  assertEqual(addDays('2026-12-28', 14), '2027-01-11');
  assertEqual(addDays('2027-01-11', -14), '2026-12-28');
  assertEqual(addDays('2024-02-28', 1), '2024-02-29'); // leap year
});

test('formatRange collapses a shared year and keeps both when they differ', () => {
  assertEqual(formatRange(START), 'Aug 1 – Aug 14, 2026');
  assertEqual(formatRange('2026-12-26'), 'Dec 26, 2026 – Jan 8, 2027');
});
