import { assert, assertClose, assertDeepEqual, assertEqual, test } from './runner.js';
import {
  DEFAULT_WEEK_FORMAT,
  REGULAR_HOURS_PER_PERIOD,
  WEEK_FORMATS,
  dayAllocated,
  dayCharged,
  dayCredited,
  dayIsEmpty,
  dayPTO,
  dayVariance,
  dayWorked,
  isOvernight,
  parseTimeToHours,
  periodTotals,
  round1,
  round2,
  scheduledHours,
  scheduledHoursOn,
  scheduledPeriodHours,
  scheduledWeekHours,
  spanHours,
  totalsByCode,
  weekFormatById,
  weekTotals,
} from '../src/calc.js';
import { periodDays } from '../src/payperiod.js';

const START = '2026-08-01'; // Saturday
const DAYS = periodDays(START);

const REG = 'code-regular';
const REG2 = 'code-regular-2';
const OT = 'code-overtime';

function makePeriod() {
  return {
    codes: [
      { id: REG, code: 'PROJ-A', label: '', type: 'regular' },
      { id: REG2, code: 'PROJ-B', label: '', type: 'regular' },
      { id: OT, code: 'PROJ-A-OT', label: '', type: 'overtime' },
    ],
    days: {},
  };
}

/** Spread `hours` of a given type across the first `count` days of the period. */
function fill(period, { count, hours, codeId = REG, pto = 0, startIndex = 0 }) {
  for (let i = 0; i < count; i += 1) {
    const date = DAYS[startIndex + i];
    const day = period.days[date] || { start: '', end: '', breakMinutes: 0, pto: 0, note: '', alloc: {} };
    if (hours) day.alloc[codeId] = (day.alloc[codeId] || 0) + hours;
    if (pto) day.pto = (day.pto || 0) + pto;
    period.days[date] = day;
  }
  return period;
}

// --- day-level math --------------------------------------------------------

test('parseTimeToHours handles valid times and rejects junk', () => {
  assertEqual(parseTimeToHours('07:30'), 7.5);
  assertEqual(parseTimeToHours('00:00'), 0);
  assertEqual(parseTimeToHours('23:45'), 23.75);
  assertEqual(parseTimeToHours(''), null);
  assertEqual(parseTimeToHours('7:5'), null);
  assertEqual(parseTimeToHours('24:00'), null);
  assertEqual(parseTimeToHours('12:60'), null);
});

test('spanHours measures one clock time to another', () => {
  assertEqual(spanHours('09:00', '17:00'), 8);
  assertEqual(spanHours('07:30', '17:00'), 9.5);
  assertEqual(spanHours('08:00', '16:20'), 8.33);
  assertEqual(spanHours('', '17:00'), null);
  assertEqual(spanHours('09:00', ''), null);
  assertEqual(spanHours('nope', '17:00'), null);
});

test('spanHours reads an end at or before the start as overnight', () => {
  assertEqual(spanHours('22:00', '06:00'), 8);
  assertEqual(spanHours('09:00', '09:00'), 24);
});

test('round1 rounds to the tenth of an hour timecards are entered in', () => {
  assertEqual(round1(8.33), 8.3);
  assertEqual(round1(8.36), 8.4);
  assertEqual(round1(9.5), 9.5);
  assertEqual(round1('nonsense'), 0);
});

test('dayWorked subtracts the break, given in minutes, from the span', () => {
  assertEqual(dayWorked({ start: '07:30', end: '17:00', breakMinutes: 30 }), 9);
  assertEqual(dayWorked({ start: '09:00', end: '17:00', breakMinutes: 0 }), 8);
  assertEqual(dayWorked({ start: '09:00', end: '17:00', breakMinutes: 60 }), 7);
  // A break that is not a whole tenth of an hour still lands where it should.
  assertEqual(dayWorked({ start: '09:00', end: '17:00', breakMinutes: 20 }), 7.67);
});

test('an incomplete day is worth zero hours', () => {
  assertEqual(dayWorked({ start: '09:00', end: '', breakMinutes: 0 }), 0);
  assertEqual(dayWorked({ start: '', end: '17:00', breakMinutes: 0 }), 0);
  assertEqual(dayWorked(null), 0);
});

test('a break longer than the shift clamps to zero, never negative', () => {
  assertEqual(dayWorked({ start: '09:00', end: '10:00', breakMinutes: 180 }), 0);
});

test('an end at or before the start is read as an overnight shift', () => {
  assertEqual(dayWorked({ start: '22:00', end: '06:00', breakMinutes: 30 }), 7.5);
  assert(isOvernight({ start: '22:00', end: '06:00' }));
  assert(!isOvernight({ start: '09:00', end: '17:00' }));
  // Exactly equal times mean a full 24 hours, not zero.
  assertEqual(dayWorked({ start: '09:00', end: '09:00', breakMinutes: 0 }), 24);
});

test('dayVariance reports hours still needing a charge code', () => {
  const day = { start: '07:30', end: '17:00', breakMinutes: 30, alloc: { [REG]: 6 } };
  assertEqual(dayWorked(day), 9);
  assertEqual(dayAllocated(day), 6);
  assertEqual(dayVariance(day), 3);

  day.alloc[REG2] = 3;
  assertEqual(dayVariance(day), 0);

  day.alloc[REG2] = 5;
  assertEqual(dayVariance(day), -2); // over-allocated
});

test('dayCharged is everything on a code plus PTO', () => {
  assertEqual(dayCharged({ alloc: { a: 6, b: 3 } }), 9);
  assertEqual(dayCharged({ pto: 8, alloc: {} }), 8, 'a leave day charges its PTO');
  assertEqual(dayCharged({ pto: 4, alloc: { a: 4 } }), 8, 'half worked, half leave');
  assertEqual(dayCharged({}), 0);
  assertEqual(dayCharged({ pto: 8, alloc: {}, waterOz: 64 }), 8, 'water is not hours');
});

test('dayIsEmpty distinguishes untouched days from PTO-only days', () => {
  assert(dayIsEmpty({ start: '', end: '', breakMinutes: 0, pto: 0, note: '', alloc: {} }));
  assert(!dayIsEmpty({ start: '', end: '', breakMinutes: 0, pto: 8, note: '', alloc: {} }));
  assert(!dayIsEmpty({ start: '09:00', end: '', breakMinutes: 0, pto: 0, note: '', alloc: {} }));
});

// --- week formats ----------------------------------------------------------

/** The scheduled hours for all 14 days of a period, Saturday first. */
function schedule(formatId) {
  return DAYS.map((_, index) => scheduledHours(formatId, index));
}

test('every week format adds up to the same 80-hour pay period', () => {
  for (const format of WEEK_FORMATS) {
    assertEqual(scheduledPeriodHours(format.id), REGULAR_HOURS_PER_PERIOD, format.id);
  }
});

test('5 × 8 is eight hours Monday to Friday, both weeks', () => {
  assertDeepEqual(schedule('5x8'), [0, 0, 8, 8, 8, 8, 8, 0, 0, 8, 8, 8, 8, 8]);
  assertEqual(scheduledWeekHours('5x8', 0), 40);
  assertEqual(scheduledWeekHours('5x8', 1), 40);
});

test('4 × 10 is ten hours Monday to Thursday, with Fridays off', () => {
  assertDeepEqual(schedule('4x10'), [0, 0, 10, 10, 10, 10, 0, 0, 0, 10, 10, 10, 10, 0]);
  assertEqual(scheduledWeekHours('4x10', 0), 40);
});

test('9/80 A takes the first Friday off and works the second', () => {
  assertDeepEqual(schedule('9/80a'), [0, 0, 9, 9, 9, 9, 0, 0, 0, 9, 9, 9, 9, 8]);
  assertEqual(scheduledWeekHours('9/80a', 0), 36);
  assertEqual(scheduledWeekHours('9/80a', 1), 44);
});

test('9/80 B is 9/80 A with the Fridays swapped', () => {
  assertDeepEqual(schedule('9/80b'), [0, 0, 9, 9, 9, 9, 8, 0, 0, 9, 9, 9, 9, 0]);
  assertEqual(scheduledWeekHours('9/80b', 0), 44);
  assertEqual(scheduledWeekHours('9/80b', 1), 36);
});

test('scheduled hours can be asked for by date', () => {
  assertEqual(scheduledHoursOn('5x8', START, START), 0, 'the period opens on a Saturday');
  assertEqual(scheduledHoursOn('5x8', START, DAYS[2]), 8, 'Monday');
  assertEqual(scheduledHoursOn('9/80a', START, DAYS[6]), 0, 'the first Friday is off');
  assertEqual(scheduledHoursOn('9/80a', START, DAYS[13]), 8, 'the second Friday is short');
});

test('an unknown week format falls back to the default instead of throwing', () => {
  assertEqual(weekFormatById('nonsense').id, DEFAULT_WEEK_FORMAT);
  assertEqual(weekFormatById(undefined).id, DEFAULT_WEEK_FORMAT);
  assertEqual(scheduledHours('nonsense', 2), 8, 'and still reports the default schedule');
});

test('a date outside the period is scheduled for nothing', () => {
  assertEqual(scheduledHours('5x8', 14), 0);
  assertEqual(scheduledHours('5x8', -1), 0);
});

test('PTO counts toward the day it is taken on', () => {
  assertEqual(dayCredited({ start: '09:00', end: '17:00', breakMinutes: 0 }), 8);
  assertEqual(dayCredited({ start: '', end: '', pto: 8 }), 8, 'a full leave day still meets it');
  assertEqual(dayCredited({ start: '09:00', end: '13:00', pto: 4 }), 8, 'half worked, half leave');
  assertEqual(dayCredited({}), 0);
});

test('PTO is clamped at zero', () => {
  assertEqual(dayPTO({ pto: 8 }), 8);
  assertEqual(dayPTO({ pto: -4 }), 0);
  assertEqual(dayPTO({}), 0);
});

test('round2 kills floating point dust', () => {
  assertEqual(round2(0.1 + 0.2), 0.3);
  assertEqual(round2(7.999999999), 8);
});

// --- period rules ----------------------------------------------------------

test('under 80 regular hours produces no overtime', () => {
  const period = fill(makePeriod(), { count: 9, hours: 8 }); // 72
  const totals = periodTotals(period, START);
  assertClose(totals.R, 72);
  assertClose(totals.regularWorked, 72);
  assertClose(totals.overtime, 0);
  assertClose(totals.regularRemaining, 8);
  assertClose(totals.totalPaid, 72);
});

test('regular hours past 80 spill into overtime (R=90 -> 80 + 10 OT)', () => {
  const period = fill(makePeriod(), { count: 10, hours: 9 }); // 90
  const totals = periodTotals(period, START);
  assertClose(totals.regularWorked, 80);
  assertClose(totals.spill, 10);
  assertClose(totals.overtime, 10);
  assertClose(totals.regularRemaining, 0);
  assertClose(totals.totalPaid, 90);
});

test('overtime codes are always OT, even well under 80 (R=70, O=6)', () => {
  const period = makePeriod();
  fill(period, { count: 10, hours: 7 }); // R = 70
  fill(period, { count: 2, hours: 3, codeId: OT }); // O = 6
  const totals = periodTotals(period, START);
  assertClose(totals.R, 70);
  assertClose(totals.O, 6);
  assertClose(totals.regularWorked, 70);
  assertClose(totals.spill, 0);
  assertClose(totals.overtime, 6);
  assertClose(totals.regularRemaining, 10);
  assertClose(totals.totalPaid, 76);
});

test('OT-code hours and over-80 spill add together', () => {
  const period = makePeriod();
  fill(period, { count: 10, hours: 9 }); // R = 90 -> 10 spill
  fill(period, { count: 2, hours: 2, codeId: OT }); // O = 4
  const totals = periodTotals(period, START);
  assertClose(totals.overtime, 14);
  assertClose(totals.regularWorked, 80);
  assertClose(totals.totalPaid, 94);
});

test('PTO fills regular hours (R=72, P=8 -> 80 regular, 0 OT)', () => {
  const period = makePeriod();
  fill(period, { count: 9, hours: 8 }); // R = 72
  fill(period, { count: 1, hours: 0, pto: 8, startIndex: 9 }); // P = 8
  const totals = periodTotals(period, START);
  assertClose(totals.P, 8);
  assertClose(totals.regularTotal, 80);
  assertClose(totals.overtime, 0);
  assertClose(totals.regularRemaining, 0);
  assertClose(totals.totalPaid, 80);
  assert(!totals.overRegularCap);
});

test('PTO never creates overtime, even past 80 (R=80, P=8)', () => {
  const period = makePeriod();
  fill(period, { count: 10, hours: 8 }); // R = 80
  fill(period, { count: 1, hours: 0, pto: 8, startIndex: 10 }); // P = 8
  const totals = periodTotals(period, START);
  assertClose(totals.spill, 0);
  assertClose(totals.overtime, 0);
  assertClose(totals.regularTotal, 88);
  assertClose(totals.regularRemaining, 0);
  assert(totals.overRegularCap, 'flagged as over the 80-hour cap');
});

test('PTO does not push worked hours over the threshold (R=76, P=8 -> 0 OT)', () => {
  const period = makePeriod();
  fill(period, { count: 10, hours: 7.6 }); // R = 76
  fill(period, { count: 1, hours: 0, pto: 8, startIndex: 10 });
  const totals = periodTotals(period, START);
  assertClose(totals.overtime, 0, 'threshold is evaluated on worked hours alone');
  assertClose(totals.regularTotal, 84);
});

test('a long week offset by a short week yields no overtime', () => {
  const period = makePeriod();
  fill(period, { count: 5, hours: 9.2, startIndex: 1 }); // week 1 = 46
  fill(period, { count: 5, hours: 6.8, startIndex: 8 }); // week 2 = 34
  const totals = periodTotals(period, START);
  assertClose(weekTotals(period, START, 0).allocated, 46);
  assertClose(weekTotals(period, START, 1).allocated, 34);
  assertClose(totals.R, 80);
  assertClose(totals.overtime, 0, 'overtime is a period-level concept, not weekly');
  assertClose(totals.regularRemaining, 0);
});

test('exactly 80 regular hours sits on the boundary with no overtime', () => {
  const period = fill(makePeriod(), { count: 10, hours: 8 });
  const totals = periodTotals(period, START);
  assertClose(totals.regularWorked, REGULAR_HOURS_PER_PERIOD);
  assertClose(totals.overtime, 0);
  assertClose(totals.regularRemaining, 0);
});

test('an empty period is all zeros', () => {
  const totals = periodTotals(makePeriod(), START);
  assertClose(totals.R, 0);
  assertClose(totals.overtime, 0);
  assertClose(totals.regularRemaining, 80);
  assertClose(totals.totalPaid, 0);
});

// --- allocation vs worked --------------------------------------------------

test('unallocated hours are reported at the period level', () => {
  const period = makePeriod();
  period.days[DAYS[2]] = {
    start: '07:30', end: '17:00', breakMinutes: 30, pto: 0, note: '',
    alloc: { [REG]: 6 },
  };
  const totals = periodTotals(period, START);
  assertClose(totals.worked, 9);
  assertClose(totals.allocated, 6);
  assertClose(totals.unallocated, 3);
});

test('over-allocation surfaces as a negative unallocated figure', () => {
  const period = makePeriod();
  period.days[DAYS[2]] = {
    start: '09:00', end: '17:00', breakMinutes: 0, pto: 0, note: '',
    alloc: { [REG]: 10 },
  };
  assertClose(periodTotals(period, START).unallocated, -2);
});

test('hours on a deleted code still count as regular', () => {
  const period = makePeriod();
  period.days[DAYS[2]] = { start: '', end: '', breakMinutes: 0, pto: 0, note: '', alloc: { 'gone-id': 5 } };
  const totals = periodTotals(period, START);
  assertClose(totals.R, 5, 'orphaned hours stay visible rather than vanishing');
  assertEqual(totals.byCode.has('gone-id'), false);
});

test('totalsByCode reports each code separately', () => {
  const period = makePeriod();
  period.days[DAYS[2]] = {
    start: '', end: '', breakMinutes: 0, pto: 0, note: '',
    alloc: { [REG]: 6, [REG2]: 2, [OT]: 1 },
  };
  const byCode = totalsByCode(period, DAYS);
  assertClose(byCode.get(REG), 6);
  assertClose(byCode.get(REG2), 2);
  assertClose(byCode.get(OT), 1);
});

// --- weeks -----------------------------------------------------------------

test('week totals cover 7 days each and ignore the other week', () => {
  const period = makePeriod();
  fill(period, { count: 5, hours: 8, startIndex: 2 }); // Mon-Fri of week 1
  fill(period, { count: 5, hours: 4, startIndex: 9 }); // Mon-Fri of week 2

  const week1 = weekTotals(period, START, 0);
  const week2 = weekTotals(period, START, 1);
  assertEqual(week1.dates.length, 7);
  assertEqual(week2.dates.length, 7);
  assertClose(week1.R, 40);
  assertClose(week2.R, 20);
});

test('week PTO rolls up separately from charged hours', () => {
  const period = makePeriod();
  fill(period, { count: 1, hours: 0, pto: 8, startIndex: 2 });
  fill(period, { count: 1, hours: 8, startIndex: 3 });
  const week1 = weekTotals(period, START, 0);
  assertClose(week1.P, 8);
  assertClose(week1.allocated, 8);
  assertClose(week1.paid, 16);
});
