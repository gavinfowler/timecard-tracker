// Rendering and event wiring.
//
// Structural changes (period switch, adding/removing a code) rebuild the day
// grid. Typing hours does not: it mutates state and refreshes only the affected
// row, the week header, and the summary, so inputs never lose focus mid-entry.

import {
  REGULAR_HOURS_PER_PERIOD,
  dayAllocated,
  dayPTO,
  dayVariance,
  dayWorked,
  isOvernight,
  periodTotals,
  round2,
  toNumber,
  weekTotals,
} from './calc.js';
import {
  formatRange,
  formatShort,
  isWeekend,
  nextPeriodStart,
  periodDays,
  periodStartContaining,
  prevPeriodStart,
  todayISO,
  weekdayShort,
} from './payperiod.js';
import * as store from './state.js';

const $ = (id) => document.getElementById(id);

/** DOM handles for each rendered day row, so refreshes stay targeted. */
const rows = new Map();
let ctx = null;
let lastUsedCodeId = null;
let toastTimer = null;

function fmt(hours) {
  return round2(hours).toFixed(2);
}

function state() {
  return ctx.state;
}

function activeStart() {
  return ctx.state.activePeriodStart;
}

function activePeriod() {
  return store.getPeriod(ctx.state, activeStart());
}

function touch() {
  ctx.requestSave();
}

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    toastTimer = null;
  }, 4000);
}

export function showStorageWarning(message) {
  const el = $('storage-warning');
  el.textContent = message || '';
  el.hidden = !message;
}

// --- summary ---------------------------------------------------------------

function renderSummary() {
  const totals = periodTotals(activePeriod(), activeStart());

  $('stat-regular').textContent = fmt(totals.regularTotal);
  $('stat-ot').textContent = fmt(totals.overtime);
  $('stat-pto').textContent = fmt(totals.P);
  $('stat-remaining').textContent = fmt(totals.regularRemaining);
  $('stat-total').textContent = fmt(totals.totalPaid);

  const regularNote = $('stat-regular-note');
  if (totals.overRegularCap) {
    regularNote.textContent = `${fmt(totals.regularWorked)} worked + ${fmt(totals.P)} PTO — over 80`;
    regularNote.classList.add('stat__note--alert');
  } else {
    regularNote.textContent = totals.P > 0
      ? `${fmt(totals.regularWorked)} worked + ${fmt(totals.P)} PTO`
      : `${fmt(totals.regularWorked)} worked`;
    regularNote.classList.remove('stat__note--alert');
  }

  const otNote = $('stat-ot-note');
  if (totals.O > 0 && totals.spill > 0) {
    otNote.textContent = `${fmt(totals.O)} on OT codes + ${fmt(totals.spill)} over 80`;
  } else if (totals.spill > 0) {
    otNote.textContent = `${fmt(totals.spill)} over 80 regular`;
  } else if (totals.O > 0) {
    otNote.textContent = 'charged to overtime codes';
  } else {
    otNote.textContent = '';
  }

  const unallocated = $('stat-unallocated');
  if (Math.abs(totals.unallocated) < 0.005) {
    unallocated.textContent = 'all worked hours assigned';
    unallocated.classList.remove('stat__note--alert');
  } else if (totals.unallocated > 0) {
    unallocated.textContent = `${fmt(totals.unallocated)} hrs not assigned to a code`;
    unallocated.classList.add('stat__note--alert');
  } else {
    unallocated.textContent = `${fmt(-totals.unallocated)} hrs over what was worked`;
    unallocated.classList.add('stat__note--alert');
  }

  const denom = Math.max(REGULAR_HOURS_PER_PERIOD, totals.totalPaid);
  const pct = (hours) => `${denom > 0 ? (hours / denom) * 100 : 0}%`;
  $('progress-regular').style.width = pct(totals.regularWorked);
  $('progress-pto').style.width = pct(totals.P);
  $('progress-ot').style.width = pct(totals.overtime);

  return totals;
}

// --- charge codes ----------------------------------------------------------

function renderCodes(totals) {
  const period = activePeriod();
  const list = $('code-list');
  list.textContent = '';

  for (const code of period.codes) {
    const item = document.createElement('li');
    item.className = 'code-chip';

    const name = document.createElement('span');
    name.className = 'code-chip__name';
    name.textContent = code.code;
    item.append(name);

    if (code.label) {
      const desc = document.createElement('span');
      desc.className = 'code-chip__desc';
      desc.textContent = code.label;
      item.append(desc);
    }

    const type = document.createElement('span');
    type.className = `code-chip__type code-chip__type--${code.type}`;
    type.textContent = code.type === 'overtime' ? 'OT' : 'Reg';
    item.append(type);

    const hours = document.createElement('span');
    hours.className = 'code-chip__hours';
    hours.dataset.codeTotal = code.id;
    hours.textContent = `${fmt(totals.byCode.get(code.id) || 0)} hrs`;
    item.append(hours);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'code-chip__remove';
    remove.textContent = '×';
    remove.title = `Remove ${code.code}`;
    remove.setAttribute('aria-label', `Remove charge code ${code.code}`);
    remove.addEventListener('click', () => handleRemoveCode(code));
    item.append(remove);

    list.append(item);
  }

  $('code-empty').hidden = period.codes.length > 0;
  $('copy-codes').disabled = !hasPreviousCodes();
}

function refreshCodeTotals(totals) {
  for (const el of document.querySelectorAll('[data-code-total]')) {
    el.textContent = `${fmt(totals.byCode.get(el.dataset.codeTotal) || 0)} hrs`;
  }
}

function hasPreviousCodes() {
  const previous = store.peekPeriod(state(), prevPeriodStart(activeStart()));
  return Boolean(previous && previous.codes.length > 0);
}

function handleRemoveCode(code) {
  const totals = periodTotals(activePeriod(), activeStart());
  const allocated = totals.byCode.get(code.id) || 0;
  if (allocated !== 0) {
    const ok = window.confirm(
      `${code.code} has ${fmt(allocated)} hours allocated in this pay period.\n\n` +
        'Removing it deletes those hours. Continue?',
    );
    if (!ok) return;
  }
  store.removeCode(state(), activeStart(), code.id);
  if (lastUsedCodeId === code.id) lastUsedCodeId = null;
  touch();
  render();
}

// --- day rows --------------------------------------------------------------

function refreshRow(dateISO) {
  const handle = rows.get(dateISO);
  if (!handle) return;
  const day = store.peekDay(state(), activeStart(), dateISO) || store.emptyDay();

  const worked = dayWorked(day);
  handle.workedValue.textContent = fmt(worked);
  handle.overnight.hidden = !isOvernight(day);

  const variance = dayVariance(day);
  const allocated = dayAllocated(day);
  const chip = handle.chip;
  chip.className = 'chip';
  handle.fill.hidden = true;

  if (worked === 0 && allocated === 0) {
    chip.classList.add('chip--idle');
    chip.textContent = dayPTO(day) > 0 ? `${fmt(dayPTO(day))} PTO` : '—';
  } else if (Math.abs(variance) < 0.005) {
    chip.classList.add('chip--ok');
    chip.textContent = '✓ balanced';
  } else if (variance > 0) {
    chip.classList.add('chip--under');
    chip.textContent = `${fmt(variance)} unallocated`;
    handle.fill.hidden = activePeriod().codes.length === 0;
  } else {
    chip.classList.add('chip--over');
    chip.textContent = `${fmt(-variance)} over worked`;
  }

  for (const input of handle.allocInputs) {
    input.classList.toggle('is-over', variance < -0.005);
  }
}

function renderWeekTotals(weekIndex) {
  const totals = weekTotals(activePeriod(), activeStart(), weekIndex);
  const el = document.querySelector(`[data-week-totals="${weekIndex}"]`);
  if (!el) return;
  el.textContent = '';

  const worked = document.createElement('strong');
  worked.textContent = fmt(totals.worked);
  el.append('Worked ', worked);

  if (totals.P > 0) el.append(` · PTO ${fmt(totals.P)}`);
  if (Math.abs(totals.unallocated) >= 0.005) {
    el.append(
      totals.unallocated > 0
        ? ` · ${fmt(totals.unallocated)} unallocated`
        : ` · ${fmt(-totals.unallocated)} over`,
    );
  }
}

/** After any hours edit: recompute the row, its week, code totals, and summary. */
function refreshAfterEdit(dateISO, weekIndex) {
  refreshRow(dateISO);
  renderWeekTotals(weekIndex);
  const totals = renderSummary();
  refreshCodeTotals(totals);
}

function numberInput({ value, className, ariaLabel, min = 0 }) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = className;
  input.step = '0.25';
  input.min = String(min);
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', ariaLabel);
  input.value = value === 0 ? '' : String(round2(value));
  input.placeholder = '0';
  return input;
}

function buildDayRow(dateISO, weekIndex) {
  const period = activePeriod();
  const day = store.peekDay(state(), activeStart(), dateISO) || store.emptyDay();
  const row = document.createElement('tr');
  row.className = 'day';
  if (isWeekend(dateISO)) row.classList.add('day--weekend');
  if (dateISO === todayISO()) row.classList.add('day--today');

  // Date
  const dateCell = document.createElement('th');
  dateCell.scope = 'row';
  const dateWrap = document.createElement('span');
  dateWrap.className = 'day-date';
  const dow = document.createElement('span');
  dow.className = 'day-date__dow';
  dow.textContent = weekdayShort(dateISO);
  const dateText = document.createElement('span');
  dateText.className = 'day-date__date';
  dateText.textContent = formatShort(dateISO);
  dateWrap.append(dow, dateText);
  dateCell.append(dateWrap);
  row.append(dateCell);

  const onTimeInput = (field) => (event) => {
    store.getDay(state(), activeStart(), dateISO)[field] = event.target.value;
    touch();
    refreshAfterEdit(dateISO, weekIndex);
  };

  // Start / end
  for (const field of ['start', 'end']) {
    const cell = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'time-input';
    input.value = day[field] || '';
    input.setAttribute('aria-label', `${field === 'start' ? 'Start' : 'End'} time ${dateISO}`);
    input.addEventListener('input', onTimeInput(field));
    cell.append(input);
    row.append(cell);
  }

  // Break
  const breakCell = document.createElement('td');
  breakCell.className = 'num';
  const breakInput = numberInput({
    value: toNumber(day.breakHours),
    className: 'hours-input',
    ariaLabel: `Break hours ${dateISO}`,
  });
  breakInput.addEventListener('input', (event) => {
    store.getDay(state(), activeStart(), dateISO).breakHours = toNumber(event.target.value);
    touch();
    refreshAfterEdit(dateISO, weekIndex);
  });
  breakCell.append(breakInput);
  row.append(breakCell);

  // Worked (computed)
  const workedCell = document.createElement('td');
  workedCell.className = 'num worked';
  const workedValue = document.createElement('span');
  const overnight = document.createElement('span');
  overnight.className = 'worked__overnight';
  overnight.textContent = 'overnight';
  overnight.hidden = true;
  workedCell.append(workedValue, overnight);
  row.append(workedCell);

  // PTO
  const ptoCell = document.createElement('td');
  ptoCell.className = 'num';
  const ptoInput = numberInput({
    value: toNumber(day.pto),
    className: 'hours-input',
    ariaLabel: `PTO hours ${dateISO}`,
  });
  ptoInput.addEventListener('input', (event) => {
    store.getDay(state(), activeStart(), dateISO).pto = Math.max(0, toNumber(event.target.value));
    touch();
    refreshAfterEdit(dateISO, weekIndex);
  });
  ptoCell.append(ptoInput);
  row.append(ptoCell);

  // One column per charge code
  const allocInputs = [];
  for (const code of period.codes) {
    const cell = document.createElement('td');
    cell.className = 'num';
    const input = numberInput({
      value: toNumber(day.alloc[code.id]),
      className: 'hours-input',
      ariaLabel: `${code.code} hours ${dateISO}`,
    });
    input.dataset.codeId = code.id;
    input.addEventListener('input', (event) => {
      lastUsedCodeId = code.id;
      store.setAllocation(state(), activeStart(), dateISO, code.id, toNumber(event.target.value));
      touch();
      refreshAfterEdit(dateISO, weekIndex);
    });
    allocInputs.push(input);
    cell.append(input);
    row.append(cell);
  }

  // Balance chip + fill action
  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = 'chip chip--idle';
  const fill = document.createElement('button');
  fill.type = 'button';
  fill.className = 'fill-btn';
  fill.textContent = 'fill';
  fill.hidden = true;
  fill.addEventListener('click', () => {
    const codes = activePeriod().codes;
    if (codes.length === 0) return;
    const target = codes.find((code) => code.id === lastUsedCodeId) || codes[0];
    const day2 = store.getDay(state(), activeStart(), dateISO);
    const next = round2(toNumber(day2.alloc[target.id]) + dayVariance(day2));
    store.setAllocation(state(), activeStart(), dateISO, target.id, next);
    const input = allocInputs.find((el) => el.dataset.codeId === target.id);
    if (input) input.value = next === 0 ? '' : String(next);
    touch();
    refreshAfterEdit(dateISO, weekIndex);
    showToast(`Filled ${target.code} on ${formatShort(dateISO)}.`);
  });
  statusCell.append(chip, fill);
  row.append(statusCell);

  rows.set(dateISO, { row, workedValue, overnight, chip, fill, allocInputs });
  return row;
}

function buildWeek(weekIndex) {
  const period = activePeriod();
  const dates = periodDays(activeStart()).slice(weekIndex * 7, weekIndex * 7 + 7);

  const section = document.createElement('section');
  section.className = 'week';

  const head = document.createElement('div');
  head.className = 'week__head';
  const title = document.createElement('h3');
  title.className = 'week__title';
  title.textContent = `Week ${weekIndex + 1}`;
  const range = document.createElement('span');
  range.className = 'week__range';
  range.textContent = `${formatShort(dates[0])} – ${formatShort(dates[dates.length - 1])}`;
  const totalsEl = document.createElement('span');
  totalsEl.className = 'week__totals';
  totalsEl.dataset.weekTotals = String(weekIndex);
  head.append(title, range, totalsEl);
  section.append(head);

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'days';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const headings = [
    { text: 'Day', num: false },
    { text: 'Start', num: false },
    { text: 'End', num: false },
    { text: 'Break', num: true },
    { text: 'Worked', num: true },
    { text: 'PTO', num: true },
    ...period.codes.map((code) => ({ text: code.code, num: true })),
    { text: 'Balance', num: false },
  ];
  for (const heading of headings) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = heading.text;
    if (heading.num) th.className = 'num';
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const dateISO of dates) tbody.append(buildDayRow(dateISO, weekIndex));
  table.append(tbody);

  scroll.append(table);
  section.append(scroll);
  return section;
}

function renderWeeks() {
  const container = $('weeks');
  container.textContent = '';
  rows.clear();

  if (activePeriod().codes.length === 0) {
    const note = document.createElement('p');
    note.className = 'no-codes-note';
    note.textContent =
      'Add at least one charge code above — hours are split across codes, so the day grid needs somewhere to put them.';
    container.append(note);
  }

  for (const weekIndex of [0, 1]) container.append(buildWeek(weekIndex));
  for (const dateISO of periodDays(activeStart())) refreshRow(dateISO);
  renderWeekTotals(0);
  renderWeekTotals(1);
}

// --- header / settings -----------------------------------------------------

function renderHeader() {
  const start = activeStart();
  $('period-range').textContent = formatRange(start);

  const current = periodStartContaining(todayISO(), state().anchorPeriodStart);
  const relative = $('period-relative');
  if (start === current) relative.textContent = 'current pay period';
  else if (start < current) relative.textContent = 'past pay period';
  else relative.textContent = 'future pay period';

  $('anchor-input').value = state().anchorPeriodStart;
  $('pto-label-input').value = state().ptoCodeLabel;
}

/** Full rebuild. Use after a period switch or a structural change. */
export function render() {
  renderHeader();
  const totals = renderSummary();
  renderCodes(totals);
  renderWeeks();
}

function goToPeriod(startISO) {
  state().activePeriodStart = periodStartContaining(startISO, state().anchorPeriodStart);
  lastUsedCodeId = null;
  touch();
  render();
}

// --- wiring ----------------------------------------------------------------

function wireHeader() {
  $('prev-period').addEventListener('click', () => goToPeriod(prevPeriodStart(activeStart())));
  $('next-period').addEventListener('click', () => goToPeriod(nextPeriodStart(activeStart())));
  $('today-period').addEventListener('click', () => goToPeriod(todayISO()));
}

function wireCodeForm() {
  const form = $('code-form');
  const error = $('code-error');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const result = store.addCode(state(), activeStart(), {
      code: data.get('code'),
      label: data.get('label'),
      type: data.get('type'),
    });
    if (!result.ok) {
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    error.hidden = true;
    lastUsedCodeId = result.code.id;
    form.reset();
    $('code-input').focus();
    touch();
    render();
  });

  $('copy-codes').addEventListener('click', () => {
    const copied = store.copyCodesFromPrevious(
      state(),
      activeStart(),
      prevPeriodStart(activeStart()),
    );
    if (copied === 0) {
      showToast('Nothing new to copy from the previous pay period.');
      return;
    }
    touch();
    render();
    showToast(`Copied ${copied} charge code${copied === 1 ? '' : 's'} from the previous period.`);
  });
}

function wireSettings() {
  $('anchor-input').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!value) {
      event.target.value = state().anchorPeriodStart;
      return;
    }
    const { anchor, snapped } = store.setAnchor(state(), value);
    touch();
    render();
    if (snapped) {
      showToast(`Pay periods start on Saturdays — snapped back to ${formatShort(anchor)}.`);
    }
  });

  $('pto-label-input').addEventListener('input', (event) => {
    state().ptoCodeLabel = event.target.value.trim() || 'PTO';
    touch();
  });
}

function wireFooter(actions) {
  $('export-csv').addEventListener('click', () => actions.exportCSV());
  $('export-json').addEventListener('click', () => actions.exportJSON());
  $('import-json').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const text = await file.text();
    const result = actions.importJSON(text);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    render();
    showToast(`Imported ${file.name}.`);
  });

  $('clear-period').addEventListener('click', () => {
    const ok = window.confirm(
      `Clear every day entry in ${formatRange(activeStart())}?\n\n` +
        'Charge codes are kept. This cannot be undone.',
    );
    if (!ok) return;
    store.clearPeriodDays(state(), activeStart());
    touch();
    render();
    showToast('Day entries cleared for this pay period.');
  });
}

export function mount(context) {
  ctx = context;
  wireHeader();
  wireCodeForm();
  wireSettings();
  wireFooter(context.actions);
  render();
}
