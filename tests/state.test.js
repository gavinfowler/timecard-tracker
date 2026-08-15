import { assertEqual, test } from './runner.js';
import { DEFAULT_WEEK_FORMAT } from '../src/calc.js';
import { STATE_VERSION, normalizeState } from '../src/state.js';

const START = '2026-08-01'; // Saturday
const DATE = '2026-08-03';

function stateWithDay(day) {
  return normalizeState({
    version: STATE_VERSION,
    anchorPeriodStart: START,
    activePeriodStart: START,
    periods: { [START]: { codes: [], days: { [DATE]: day } } },
  }).periods[START].days[DATE];
}

test('breaks are stored as whole minutes', () => {
  assertEqual(stateWithDay({ breakMinutes: 45 }).breakMinutes, 45);
  assertEqual(stateWithDay({ breakMinutes: 30.4 }).breakMinutes, 30, 'rounded to the minute');
  assertEqual(stateWithDay({ breakMinutes: -15 }).breakMinutes, 0, 'never negative');
  assertEqual(stateWithDay({ breakMinutes: 'abc' }).breakMinutes, 0, 'junk zeroed');
  assertEqual(stateWithDay({}).breakMinutes, 0, 'missing means no break');
});

test('a v1 day carrying decimal breakHours is migrated to minutes', () => {
  assertEqual(stateWithDay({ breakHours: 0.5 }).breakMinutes, 30);
  assertEqual(stateWithDay({ breakHours: 1 }).breakMinutes, 60);
  assertEqual(stateWithDay({ breakHours: 0 }).breakMinutes, 0);
  // Both present means the file has already been migrated; minutes win.
  assertEqual(stateWithDay({ breakHours: 0.5, breakMinutes: 20 }).breakMinutes, 20);
});

test('the migrated day drops the old field entirely', () => {
  assertEqual(stateWithDay({ breakHours: 0.5 }).breakHours, undefined);
});

test('the week format is kept when known and defaulted when not', () => {
  const format = (raw) => normalizeState({ periods: {}, ...raw }).weekFormat;
  assertEqual(format({ weekFormat: '9/80b' }), '9/80b');
  assertEqual(format({ weekFormat: '4x10' }), '4x10');
  assertEqual(format({ weekFormat: 'nonsense' }), DEFAULT_WEEK_FORMAT, 'unknown id');
  assertEqual(format({}), DEFAULT_WEEK_FORMAT, 'a file written before formats existed');
});
