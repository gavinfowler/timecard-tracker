import { assert, assertEqual, test } from './runner.js';
import { buildCSV, buildJSON, parseImportedJSON } from '../src/exporters.js';

const START = '2026-08-01';

function makeState() {
  return {
    version: 3,
    anchorPeriodStart: START,
    activePeriodStart: START,
    ptoCodeLabel: 'LEAVE-01',
    weekFormat: '9/80a',
    archivedCodes: [],
    periods: {
      [START]: {
        codes: [
          { id: 'a', code: 'PROJ-A', supp: '100', label: 'Platform', type: 'regular' },
          { id: 'b', code: 'PROJ-A-OT', supp: '', label: '', type: 'overtime' },
        ],
        days: {
          '2026-08-03': {
            start: '07:30', end: '17:00', breakMinutes: 30, pto: 0, waterOz: 0, note: '',
            alloc: { a: 6, b: 3 },
          },
          '2026-08-04': {
            start: '', end: '', breakMinutes: 0, pto: 8, waterOz: 0, note: '', alloc: {},
          },
          '2026-08-05': {
            start: '', end: '', breakMinutes: 0, pto: 0, waterOz: 0, note: '', alloc: {},
          },
        },
      },
    },
  };
}

function rows(csv) {
  return csv.split('\r\n');
}

test('CSV starts with the expected header', () => {
  assertEqual(
    rows(buildCSV(makeState(), START))[0],
    'date,weekday,charge_code,supp_code,type,hours',
  );
});

test('CSV emits one row per date and charge code, in code order', () => {
  const lines = rows(buildCSV(makeState(), START));
  assertEqual(lines[1], '2026-08-03,Mon,PROJ-A,100,regular,6.00');
  assertEqual(lines[2], '2026-08-03,Mon,PROJ-A-OT,,overtime,3.00', 'a code with no SUPP');
});

test('CSV uses the configured PTO code and marks the type as pto', () => {
  const lines = rows(buildCSV(makeState(), START));
  assertEqual(lines[3], '2026-08-04,Tue,LEAVE-01,,pto,8.00');
});

test('CSV skips days with no hours at all', () => {
  const csv = buildCSV(makeState(), START);
  assert(!csv.includes('2026-08-05'), 'empty day is omitted');
  assertEqual(rows(csv).length, 4, 'header + 3 data rows');
});

test('CSV hours sum to the on-screen total', () => {
  const total = rows(buildCSV(makeState(), START))
    .slice(1)
    .reduce((sum, line) => sum + Number(line.split(',')[5]), 0);
  assertEqual(total, 17); // 6 + 3 worked + 8 PTO
});

test('CSV keeps hours charged to a removed code', () => {
  const state = makeState();
  state.periods[START].days['2026-08-06'] = {
    start: '', end: '', breakMinutes: 0, pto: 0, note: '', alloc: { 'deleted-id': 4 },
  };
  assert(buildCSV(state, START).includes('2026-08-06,Thu,(removed code),,regular,4.00'));
});

test('CSV escapes commas and quotes in charge codes', () => {
  const state = makeState();
  state.periods[START].codes[0].code = 'PROJ,"X"';
  assert(buildCSV(state, START).includes('"PROJ,""X"""'));
});

test('an empty period still exports a valid header-only CSV', () => {
  const state = makeState();
  state.periods[START].days = {};
  assertEqual(buildCSV(state, START), 'date,weekday,charge_code,supp_code,type,hours');
});

test('CSV leaves water consumption out entirely', () => {
  const state = makeState();
  state.periods[START].days['2026-08-03'].waterOz = 64;
  const csv = buildCSV(state, START);
  assert(!csv.includes('64'), 'water is not timecard data');
  assert(!csv.includes('water'));
});

test('JSON export round-trips back through import unchanged', () => {
  const state = makeState();
  const result = parseImportedJSON(buildJSON(state));
  assert(result.ok, 'import succeeded');
  assertEqual(buildJSON(result.state), buildJSON(state));
});

test('import rejects malformed JSON and unrelated JSON', () => {
  const bad = parseImportedJSON('{not json');
  assert(!bad.ok);
  assert(bad.error.includes('not valid JSON'));

  const wrong = parseImportedJSON('{"hello":"world"}');
  assert(!wrong.ok);
  assert(wrong.error.includes('timecard backup'));
});

test('import normalizes a hand-edited file instead of trusting it', () => {
  const result = parseImportedJSON(
    JSON.stringify({
      anchorPeriodStart: '2026-08-05', // a Wednesday
      activePeriodStart: '2026-08-05',
      periods: {
        '2026-08-05': {
          codes: [{ id: 'x', code: 'PROJ-A', type: 'nonsense' }, { code: '' }],
          days: { 'not-a-date': {}, '2026-08-05': { pto: 'abc', alloc: { x: 'nope' } } },
        },
      },
    }),
  );
  assert(result.ok);
  assertEqual(result.state.anchorPeriodStart, '2026-08-01', 'snapped back to Saturday');
  assertEqual(result.state.periods['2026-08-01'].codes.length, 1, 'blank code dropped');
  assertEqual(result.state.periods['2026-08-01'].codes[0].type, 'regular', 'unknown type defaults');
  assertEqual(result.state.periods['2026-08-01'].days['not-a-date'], undefined);
  assertEqual(result.state.periods['2026-08-01'].days['2026-08-05'].pto, 0, 'junk numbers zeroed');
});
