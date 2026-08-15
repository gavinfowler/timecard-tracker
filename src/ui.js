// Rendering and event wiring.
//
// Structural changes (period switch, adding/removing a code) rebuild the day
// grid. Typing hours does not: it mutates state and refreshes only the affected
// day, its week totals, and the summary, so inputs never lose focus mid-entry.
//
// Each week is one matrix: the seven days across the top, and down the left the
// entry rows (start, end, break, worked), then a row per charge code, then PTO
// and the balance. A day therefore owns a *column*, not a row — `rows` holds
// the scattered cells that make up each day so refreshes stay targeted.

import {
  REGULAR_HOURS_PER_PERIOD,
  WEEK_FORMATS,
  dayAllocated,
  dayBreakMinutes,
  dayCredited,
  dayPTO,
  dayVariance,
  dayWorked,
  isOvernight,
  periodTotals,
  round1,
  round2,
  scheduledHoursOn,
  scheduledWeekHours,
  spanHours,
  toNumber,
  totalsByCode,
  weekFormatById,
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

/** DOM handles for each rendered day column, so refreshes stay targeted. */
const rows = new Map();

/** Week-total cells, keyed "<weekIndex>:<row>", so totals refresh in place. */
const totalCells = new Map();

let ctx = null;
let lastUsedCodeId = null;
let toastTimer = null;

function fmt(hours) {
  return round2(hours).toFixed(2);
}

/** Breaks are whole minutes, so they get none of the two-decimal treatment. */
function fmtMinutes(minutes) {
  return String(Math.round(minutes));
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

function weekFormat() {
  return weekFormatById(ctx.state.weekFormat);
}

/** The hours this date is scheduled for under the configured week format. */
function scheduledOn(dateISO) {
  return scheduledHoursOn(weekFormat().id, activeStart(), dateISO);
}

/** Targets are whole or half hours, so they read better without the .00. */
function fmtTarget(hours) {
  return round2(hours) % 1 === 0 ? String(round2(hours)) : fmt(hours);
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
      `${codeName(code)} has ${fmt(allocated)} hours allocated in this pay period.\n\n` +
        'Removing it deletes those hours. Continue?',
    );
    if (!ok) return;
  }
  store.removeCode(state(), activeStart(), code.id);
  if (lastUsedCodeId === code.id) lastUsedCodeId = null;
  touch();
  render();
}

// --- day grid --------------------------------------------------------------

function codeById(codeId) {
  return activePeriod().codes.find((code) => code.id === codeId) || null;
}

function dayAllocMap(dateISO) {
  const day = store.peekDay(state(), activeStart(), dateISO);
  return (day && day.alloc) || {};
}

/**
 * True when the same code name is carried under both charging types. The pair
 * is legitimate — plenty of employers bill overtime against the same number —
 * so the two rows have to be told apart on sight and to a screen reader.
 */
function hasTypeTwin(code) {
  return activePeriod().codes.some(
    (other) => other.id !== code.id && other.code.toLowerCase() === code.code.toLowerCase(),
  );
}

/** "PROJ-A", or "PROJ-A (overtime)" when both types of it exist. */
function codeName(code) {
  return hasTypeTwin(code) ? `${code.code} (${code.type})` : code.code;
}

/** "PROJ-A — Platform work (OT)", for the hover title on a code's row. */
function codeDescription(code, twinned) {
  let text = code.code;
  if (code.label) text += ` — ${code.label}`;
  if (code.type === 'overtime') text += ' (OT)';
  else if (twinned) text += ' (regular)';
  return text;
}

/** Repaint one day's computed cells: worked hours and the balance chip. */
function refreshDay(dateISO) {
  const handle = rows.get(dateISO);
  if (!handle) return;
  const day = store.peekDay(state(), activeStart(), dateISO) || store.emptyDay();

  const worked = dayWorked(day);
  handle.workedValue.textContent = fmt(worked);
  handle.overnight.hidden = !isOvernight(day);

  // Progress against what the week format expects of this day. PTO counts, so
  // a day taken as leave reads as met rather than as a day eight hours short.
  const scheduled = scheduledOn(dateISO);
  const credited = dayCredited(day);
  const target = handle.target;
  target.className = 'worked__target';
  if (scheduled === 0) {
    target.textContent = credited > 0 ? 'not scheduled' : 'off';
    target.classList.add(credited > 0 ? 'worked__target--extra' : 'worked__target--off');
  } else {
    target.textContent = `of ${fmtTarget(scheduled)}`;
    if (credited >= scheduled - 0.005) target.classList.add('worked__target--met');
    else if (credited > 0) target.classList.add('worked__target--short');
  }

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

  for (const input of handle.allocInputs.values()) {
    input.classList.toggle('is-over', variance < -0.005);
  }
}

/** A zero total reads as clutter across a 7-day row, so blanks show as a dash. */
function setTotal(weekIndex, key, value, format = fmt) {
  const cell = totalCells.get(`${weekIndex}:${key}`);
  if (!cell) return;
  cell.textContent = Math.abs(value) < 0.005 ? '—' : format(value);
  cell.classList.toggle('grid__total--zero', Math.abs(value) < 0.005);
}

function renderWeekTotals(weekIndex) {
  const period = activePeriod();
  const totals = weekTotals(period, activeStart(), weekIndex);

  const el = document.querySelector(`[data-week-totals="${weekIndex}"]`);
  if (el) {
    el.textContent = '';
    const worked = document.createElement('strong');
    worked.textContent = fmt(totals.worked);
    el.append('Worked ', worked);
    el.append(` of ${fmtTarget(scheduledWeekHours(weekFormat().id, weekIndex))}`);

    if (totals.P > 0) el.append(` · PTO ${fmt(totals.P)}`);
    if (Math.abs(totals.unallocated) >= 0.005) {
      el.append(
        totals.unallocated > 0
          ? ` · ${fmt(totals.unallocated)} unallocated`
          : ` · ${fmt(-totals.unallocated)} over`,
      );
    }
  }

  // The right-hand column: one week total per row of the matrix.
  let breakMinutes = 0;
  for (const dateISO of totals.dates) {
    const day = store.peekDay(state(), activeStart(), dateISO);
    if (day) breakMinutes += dayBreakMinutes(day);
  }
  setTotal(weekIndex, 'break', breakMinutes, fmtMinutes);
  setTotal(weekIndex, 'worked', totals.worked);
  setTotal(weekIndex, 'pto', totals.P);

  const byCode = totalsByCode(period, totals.dates);
  for (const code of period.codes) setTotal(weekIndex, `code:${code.id}`, byCode.get(code.id) || 0);

  const balance = totalCells.get(`${weekIndex}:balance`);
  if (balance) {
    const chip = balance.firstElementChild;
    chip.className = 'chip';
    if (totals.worked === 0 && totals.allocated === 0) {
      chip.classList.add('chip--idle');
      chip.textContent = '—';
    } else if (Math.abs(totals.unallocated) < 0.005) {
      chip.classList.add('chip--ok');
      chip.textContent = '✓ balanced';
    } else if (totals.unallocated > 0) {
      chip.classList.add('chip--under');
      chip.textContent = `${fmt(totals.unallocated)} left`;
    } else {
      chip.classList.add('chip--over');
      chip.textContent = `${fmt(-totals.unallocated)} over`;
    }
  }
}

/** After any hours edit: recompute the day, its week, code totals, and summary. */
function refreshAfterEdit(dateISO, weekIndex) {
  refreshDay(dateISO);
  renderWeekTotals(weekIndex);
  const totals = renderSummary();
  refreshCodeTotals(totals);
}

function numberInput({ value, className, ariaLabel, min = 0, step = '0.1' }) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = className;
  input.step = step;
  input.min = String(min);
  input.inputMode = step.includes('.') ? 'decimal' : 'numeric';
  input.setAttribute('aria-label', ariaLabel);
  input.value = value === 0 ? '' : String(round2(value));
  input.placeholder = '0';
  return input;
}

/** Cells of one day column, tagged so weekend/today shading follows them down. */
function dayCell(dateISO, className) {
  const cell = document.createElement('td');
  cell.className = className ? `grid__cell ${className}` : 'grid__cell';
  cell.dataset.date = dateISO;
  if (isWeekend(dateISO)) cell.classList.add('col--weekend');
  if (dateISO === todayISO()) cell.classList.add('col--today');
  return cell;
}

/** Every grid row opens with a label cell on the left. */
function gridRow(className, label) {
  const row = document.createElement('tr');
  row.className = className;
  const th = document.createElement('th');
  th.scope = 'row';
  th.className = 'grid__label';
  if (typeof label === 'string') th.textContent = label;
  else th.append(label);
  row.append(th);
  return row;
}

/** Closes a grid row with its week total. `key` omitted means nothing to total. */
function totalCell(weekIndex, key) {
  const cell = document.createElement('td');
  cell.className = 'grid__total';
  if (key) {
    cell.dataset.total = `${weekIndex}:${key}`;
    totalCells.set(cell.dataset.total, cell);
  }
  return cell;
}

function buildTimeRow(dates, weekIndex, label, field) {
  const row = gridRow('grid__row', label);
  for (const dateISO of dates) {
    const day = store.peekDay(state(), activeStart(), dateISO) || store.emptyDay();
    const cell = dayCell(dateISO);
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'time-input';
    input.value = day[field] || '';
    input.setAttribute('aria-label', `${label} time ${dateISO}`);
    input.addEventListener('input', (event) => {
      store.getDay(state(), activeStart(), dateISO)[field] = event.target.value;
      touch();
      refreshAfterEdit(dateISO, weekIndex);
    });
    cell.append(input);
    row.append(cell);
  }
  row.append(totalCell(weekIndex));
  return row;
}

/**
 * Break (minutes) and PTO (hours): one number box per day, summed in the week
 * column. `unit` names what goes in the box, for the label and the step.
 */
function buildHoursRow(dates, weekIndex, { label, heading, key, unit = 'hours', step, read, write }) {
  const row = gridRow('grid__row', heading || label);
  for (const dateISO of dates) {
    const day = store.peekDay(state(), activeStart(), dateISO) || store.emptyDay();
    const cell = dayCell(dateISO);
    const input = numberInput({
      value: read(day),
      className: 'hours-input',
      ariaLabel: `${label} ${unit} ${dateISO}`,
      step,
    });
    input.addEventListener('input', (event) => {
      write(store.getDay(state(), activeStart(), dateISO), toNumber(event.target.value));
      touch();
      refreshAfterEdit(dateISO, weekIndex);
    });
    cell.append(input);
    row.append(cell);
  }
  row.append(totalCell(weekIndex, key));
  return row;
}

function buildWorkedRow(dates, weekIndex) {
  const row = gridRow('grid__row grid__row--worked', 'Worked');
  for (const dateISO of dates) {
    const cell = dayCell(dateISO, 'worked');
    const value = document.createElement('span');
    // Filled by refreshDay: how the day stands against its scheduled hours.
    const target = document.createElement('span');
    target.className = 'worked__target';
    const overnight = document.createElement('span');
    overnight.className = 'worked__overnight';
    overnight.textContent = 'overnight';
    overnight.hidden = true;
    cell.append(value, target, overnight);

    const handle = rows.get(dateISO);
    handle.workedValue = value;
    handle.target = target;
    handle.overnight = overnight;
    row.append(cell);
  }
  row.append(totalCell(weekIndex, 'worked'));
  return row;
}

/** One charge code's row: its name on the left, then a box under each day. */
function buildCodeRow(dates, weekIndex, code) {
  const twinned = hasTypeTwin(code);
  // Only a twinned regular code needs its type spelled out; overtime always
  // carries its tag because the tag is about pay, not about which row is which.
  const ariaName = twinned ? `${code.code} ${code.type}` : code.code;

  const label = document.createElement('span');
  label.className = 'grid__code';
  label.title = codeDescription(code, twinned);

  const name = document.createElement('span');
  name.className = 'grid__code-name';
  name.textContent = code.code;
  label.append(name);

  if (code.type === 'overtime' || twinned) {
    const type = document.createElement('span');
    type.className = `grid__code-type grid__code-type--${code.type}`;
    type.textContent = code.type === 'overtime' ? 'OT' : 'REG';
    name.append(' ', type);
  }
  if (code.label) {
    const desc = document.createElement('span');
    desc.className = 'grid__code-desc';
    desc.textContent = code.label;
    label.append(desc);
  }

  const row = gridRow('grid__row grid__row--code', label);
  row.dataset.codeId = code.id;

  for (const dateISO of dates) {
    const cell = dayCell(dateISO, 'alloc');
    const input = numberInput({
      value: toNumber(dayAllocMap(dateISO)[code.id]),
      className: 'hours-input alloc__hours',
      ariaLabel: `${ariaName} hours ${dateISO}`,
    });
    input.addEventListener('input', (event) => {
      lastUsedCodeId = code.id;
      rows.get(dateISO).lastCodeId = code.id;
      store.setAllocation(state(), activeStart(), dateISO, code.id, toNumber(event.target.value));
      touch();
      refreshAfterEdit(dateISO, weekIndex);
    });
    rows.get(dateISO).allocInputs.set(code.id, input);
    cell.append(input);
    row.append(cell);
  }

  row.append(totalCell(weekIndex, `code:${code.id}`));
  return row;
}

/** Fill tops up the code last touched on this day, else the one last used
    anywhere, else the first code in the period. */
function fillTarget(handle) {
  if (handle.lastCodeId && handle.allocInputs.has(handle.lastCodeId)) return handle.lastCodeId;
  if (lastUsedCodeId && handle.allocInputs.has(lastUsedCodeId)) return lastUsedCodeId;
  const first = activePeriod().codes[0];
  return first ? first.id : null;
}

function fillDay(dateISO, weekIndex) {
  const handle = rows.get(dateISO);
  const current = store.getDay(state(), activeStart(), dateISO);
  const variance = dayVariance(current);
  if (Math.abs(variance) < 0.005) return;

  const codeId = fillTarget(handle);
  if (!codeId) return;

  const next = round2(toNumber(current.alloc[codeId]) + variance);
  store.setAllocation(state(), activeStart(), dateISO, codeId, next);
  const input = handle.allocInputs.get(codeId);
  if (input) input.value = next === 0 ? '' : String(next);
  handle.lastCodeId = codeId;
  lastUsedCodeId = codeId;
  touch();
  refreshAfterEdit(dateISO, weekIndex);
  const code = codeById(codeId);
  showToast(`Filled ${code ? codeName(code) : 'charge code'} on ${formatShort(dateISO)}.`);
}

function buildBalanceRow(dates, weekIndex) {
  const row = gridRow('grid__row grid__row--balance', 'Balance');
  for (const dateISO of dates) {
    const cell = dayCell(dateISO, 'balance');
    const chip = document.createElement('span');
    chip.className = 'chip chip--idle';
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'fill-btn';
    fill.textContent = 'fill';
    fill.hidden = true;
    fill.setAttribute('aria-label', `Fill unallocated hours on ${dateISO}`);
    fill.addEventListener('click', () => fillDay(dateISO, weekIndex));
    cell.append(chip, fill);

    const handle = rows.get(dateISO);
    handle.chip = chip;
    handle.fill = fill;
    row.append(cell);
  }

  const cell = totalCell(weekIndex, 'balance');
  const weekChip = document.createElement('span');
  weekChip.className = 'chip chip--idle';
  cell.append(weekChip);
  row.append(cell);
  return row;
}

/** The header row: one column per day of the week. */
function buildHeadRow(dates) {
  const row = document.createElement('tr');
  const corner = document.createElement('th');
  corner.scope = 'col';
  corner.className = 'grid__corner';
  const cornerText = document.createElement('span');
  cornerText.className = 'visually-hidden';
  cornerText.textContent = 'Entry';
  corner.append(cornerText);
  row.append(corner);

  for (const dateISO of dates) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'grid__day';
    th.dataset.date = dateISO;
    if (isWeekend(dateISO)) th.classList.add('col--weekend');
    if (dateISO === todayISO()) th.classList.add('col--today');

    const dow = document.createElement('span');
    dow.className = 'grid__day-dow';
    dow.textContent = weekdayShort(dateISO);
    const date = document.createElement('span');
    date.className = 'grid__day-date';
    date.textContent = formatShort(dateISO);
    th.append(dow, date);
    row.append(th);
  }

  const total = document.createElement('th');
  total.scope = 'col';
  total.className = 'grid__total-head';
  total.textContent = 'Week';
  row.append(total);
  return row;
}

/** Column widths: a fixed label column, seven even days, a fixed total. */
function buildColgroup() {
  const group = document.createElement('colgroup');
  const label = document.createElement('col');
  label.className = 'grid__col-label';
  group.append(label);
  for (let i = 0; i < 7; i += 1) {
    const col = document.createElement('col');
    col.className = 'grid__col-day';
    group.append(col);
  }
  const total = document.createElement('col');
  total.className = 'grid__col-total';
  group.append(total);
  return group;
}

function buildWeek(weekIndex) {
  const dates = periodDays(activeStart()).slice(weekIndex * 7, weekIndex * 7 + 7);
  for (const dateISO of dates) {
    rows.set(dateISO, {
      weekIndex,
      workedValue: null,
      target: null,
      overnight: null,
      chip: null,
      fill: null,
      allocInputs: new Map(),
      lastCodeId: null,
    });
  }

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
  table.className = 'grid';
  table.append(buildColgroup());

  const thead = document.createElement('thead');
  thead.append(buildHeadRow(dates));
  table.append(thead);

  // Three bands: the times that produce worked hours, the charge codes those
  // hours go to, and what is left over.
  const times = document.createElement('tbody');
  times.className = 'grid__band';
  times.append(
    buildTimeRow(dates, weekIndex, 'Start', 'start'),
    buildTimeRow(dates, weekIndex, 'End', 'end'),
    buildHoursRow(dates, weekIndex, {
      label: 'Break',
      heading: 'Break (min)',
      key: 'break',
      unit: 'minutes',
      step: '5',
      read: (day) => dayBreakMinutes(day),
      write: (day, value) => { day.breakMinutes = Math.max(0, Math.round(value)); },
    }),
    buildWorkedRow(dates, weekIndex),
  );
  table.append(times);

  const codes = activePeriod().codes;
  if (codes.length > 0) {
    const band = document.createElement('tbody');
    band.className = 'grid__band grid__band--codes';
    for (const code of codes) band.append(buildCodeRow(dates, weekIndex, code));
    table.append(band);
  }

  const foot = document.createElement('tbody');
  foot.className = 'grid__band';
  foot.append(
    buildHoursRow(dates, weekIndex, {
      label: 'PTO',
      key: 'pto',
      read: (day) => toNumber(day.pto),
      write: (day, value) => { day.pto = Math.max(0, value); },
    }),
    buildBalanceRow(dates, weekIndex),
  );
  table.append(foot);

  scroll.append(table);
  section.append(scroll);
  return section;
}

function renderWeeks() {
  const container = $('weeks');
  container.textContent = '';
  rows.clear();
  totalCells.clear();

  if (activePeriod().codes.length === 0) {
    const note = document.createElement('p');
    note.className = 'no-codes-note';
    note.textContent =
      'Add at least one charge code above — each one becomes a row in the grid below, so there is nowhere to put hours until you do.';
    container.append(note);
  }

  for (const weekIndex of [0, 1]) container.append(buildWeek(weekIndex));
  for (const dateISO of periodDays(activeStart())) refreshDay(dateISO);
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
  $('week-format-input').value = weekFormat().id;
  $('week-format-hint').textContent = weekFormat().hint;
}

/** The week-format menu is built from calc.js so the two can't drift apart. */
function buildWeekFormatOptions() {
  const select = $('week-format-input');
  select.textContent = '';
  for (const format of WEEK_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    select.append(option);
  }
}

/**
 * Full rebuild. Use after a period switch or a structural change.
 *
 * A throw in here used to leave the day grid an empty panel with no hint as to
 * why, so a failure says so on the page instead of only in the console.
 */
export function render() {
  try {
    renderHeader();
    const totals = renderSummary();
    renderCodes(totals);
    renderWeeks();
  } catch (err) {
    console.error(err);
    showStorageWarning(
      'Something went wrong drawing this pay period, so what you see may be incomplete. ' +
        'Export a JSON backup, then reload the page.',
    );
    const note = document.createElement('p');
    note.className = 'no-codes-note';
    note.textContent = `Could not draw the day grid: ${(err && err.message) || err}`;
    $('weeks').append(note);
  }
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

/**
 * The scratch calculator at the top of the page. It shares the span rule with
 * the day grid — including the overnight one — but touches no state: nothing it
 * shows is saved or counted anywhere.
 */
function wireTimeCalc() {
  const start = $('calc-start');
  const end = $('calc-end');
  const hours = $('calc-hours');
  const note = $('calc-note');

  const update = () => {
    const span = spanHours(start.value, end.value);
    if (span === null) {
      hours.textContent = '—';
      note.textContent = start.value || end.value
        ? 'Needs both a start and an end time.'
        : 'Enter a start and an end time.';
      return;
    }

    hours.textContent = `${round1(span).toFixed(1)} hrs`;
    const minutes = Math.round(span * 60);
    const exact = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    note.textContent = isOvernight({ start: start.value, end: end.value })
      ? `${exact} · crosses midnight`
      : exact;
  };

  start.addEventListener('input', update);
  end.addEventListener('input', update);
  $('calc-clear').addEventListener('click', () => {
    start.value = '';
    end.value = '';
    update();
    start.focus();
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

  $('week-format-input').addEventListener('change', (event) => {
    const format = weekFormatById(event.target.value);
    state().weekFormat = format.id;
    touch();
    render();
    showToast(`Week format set to ${format.label}.`);
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
  buildWeekFormatOptions();
  wireHeader();
  wireTimeCalc();
  wireCodeForm();
  wireSettings();
  wireFooter(context.actions);
  render();
}
