import { assert, assertDeepEqual, assertEqual, test } from './runner.js';
import { DEFAULT_WEEK_FORMAT } from '../src/calc.js';
import {
  STATE_VERSION,
  archiveCode,
  codeCatalog,
  codeKeyOf,
  normalizeState,
  restoreCode,
} from '../src/state.js';

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

// --- SUPP codes and water ---------------------------------------------------

function firstCode(raw) {
  return normalizeState({
    anchorPeriodStart: START,
    activePeriodStart: START,
    periods: { [START]: { codes: [raw], days: {} } },
  }).periods[START].codes[0];
}

test('a charge code carries a trimmed SUPP code, empty when absent', () => {
  assertEqual(firstCode({ code: 'PROJ-A', supp: ' 100 ' }).supp, '100');
  assertEqual(firstCode({ code: 'PROJ-A' }).supp, '', 'a file written before SUPP existed');
  assertEqual(firstCode({ code: 'PROJ-A', supp: 42 }).supp, '42', 'a number is fine');
});

test('the SUPP code is part of what makes a charge code unique', () => {
  const key = (supp, type = 'regular') => codeKeyOf({ code: 'PROJ-A', supp, type });
  assert(key('100') !== key('200'), 'same code, different SUPP');
  assert(key('100') !== key('100', 'overtime'), 'same code and SUPP, different type');
  assertEqual(key('100'), key(' 100 '), 'trimmed');
  assertEqual(key('100'), codeKeyOf({ code: 'proj-a', supp: '100', type: 'regular' }));
  // Joined on a separator, not a space, so the parts cannot smear together.
  assert(
    codeKeyOf({ code: 'B C', supp: 'A', type: 'regular' }) !==
      codeKeyOf({ code: 'C', supp: 'A B', type: 'regular' }),
  );
});

test('water is stored as whole ounces', () => {
  assertEqual(stateWithDay({ waterOz: 64 }).waterOz, 64);
  assertEqual(stateWithDay({ waterOz: 32.6 }).waterOz, 33, 'rounded');
  assertEqual(stateWithDay({ waterOz: -8 }).waterOz, 0, 'never negative');
  assertEqual(stateWithDay({ waterOz: 'abc' }).waterOz, 0, 'junk zeroed');
  assertEqual(stateWithDay({}).waterOz, 0);
});

// --- the charge code catalog ------------------------------------------------

const NEXT = '2026-08-15'; // the pay period after START

/** Two periods: PROJ-A charged in both, OVH only ever added to the first. */
function twoPeriods() {
  return normalizeState({
    anchorPeriodStart: START,
    activePeriodStart: NEXT,
    periods: {
      [START]: {
        codes: [
          { id: 'a1', code: 'PROJ-A', supp: '100', label: 'Platform', type: 'regular' },
          { id: 'o1', code: 'OVH', supp: '', label: 'Overhead', type: 'regular' },
        ],
        days: { '2026-08-03': { alloc: { a1: 8 } } },
      },
      [NEXT]: {
        codes: [{ id: 'a2', code: 'PROJ-A', supp: '100', label: 'Platform work', type: 'regular' }],
        days: { '2026-08-17': { alloc: { a2: 6 } } },
      },
    },
  });
}

test('the catalog dedupes a code carried by more than one period', () => {
  const catalog = codeCatalog(twoPeriods(), NEXT);
  assertEqual(catalog.length, 2, 'PROJ-A once, OVH once');
  assertEqual(catalog[0].code, 'PROJ-A', 'most recently charged first');
  assertEqual(catalog[0].label, 'Platform work', 'the most recent description wins');
  assertEqual(catalog[0].activeId, 'a2', 'its id in the active period');
  assertEqual(catalog[0].lastChargedStart, NEXT);
});

test('the catalog reports a code that was never charged', () => {
  const entry = codeCatalog(twoPeriods(), NEXT).find((row) => row.code === 'OVH');
  assertEqual(entry.lastChargedStart, null, 'added but never given hours');
  assertEqual(entry.lastSeenStart, START);
  assertEqual(entry.activeId, null, 'not in the active period');
});

test('the same code under two SUPP codes is two catalog entries', () => {
  const state = twoPeriods();
  state.periods[NEXT].codes.push({
    id: 'a3', code: 'PROJ-A', supp: '200', label: '', type: 'regular',
  });
  const named = codeCatalog(state, NEXT).filter((row) => row.code === 'PROJ-A');
  assertEqual(named.length, 2);
  assertDeepEqual(named.map((row) => row.supp).sort(), ['100', '200']);
});

test('archiving a code changes no pay period at all', () => {
  const state = twoPeriods();
  const before = JSON.stringify(state.periods);

  archiveCode(state, codeKeyOf(state.periods[START].codes[0]));

  assertEqual(JSON.stringify(state.periods), before, 'periods are untouched');
  assertEqual(state.archivedCodes.length, 1, 'only the archived list changed');
});

test('an archived code stays in the catalog, flagged, and can be restored', () => {
  const state = twoPeriods();
  const key = codeKeyOf(state.periods[NEXT].codes[0]);

  archiveCode(state, key);
  const archived = codeCatalog(state, NEXT).find((row) => row.key === key);
  assert(archived, 'still listed — it is still in the active period');
  assert(archived.archived);
  assertEqual(archived.activeId, 'a2', 'and still holds its hours there');

  archiveCode(state, key);
  assertEqual(state.archivedCodes.length, 1, 'archiving twice is not two entries');

  restoreCode(state, key);
  assertEqual(state.archivedCodes.length, 0);
  assert(!codeCatalog(state, NEXT).find((row) => row.key === key).archived);
});

test('archived code keys survive a save and reload, and junk ones do not', () => {
  const key = codeKeyOf({ code: 'PROJ-A', supp: '100', type: 'regular' });
  const state = normalizeState({ periods: {}, archivedCodes: [key, key, '', 7, null] });
  assertDeepEqual(state.archivedCodes, [key]);
  assertDeepEqual(normalizeState({ periods: {} }).archivedCodes, [], 'an older file has none');
});
