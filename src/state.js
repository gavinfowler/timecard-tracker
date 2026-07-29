// App state: shape, defaults, normalization, and localStorage persistence.

import {
  alignBackToSaturday,
  isValidISO,
  periodStartContaining,
  todayISO,
} from './payperiod.js';

const STORAGE_KEY = 'timecard-tracker/v1';
const SAVE_DELAY_MS = 200;

export const STATE_VERSION = 1;

let saveTimer = null;
let storageWarning = '';

export function getStorageWarning() {
  return storageWarning;
}

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultState(today = todayISO()) {
  const anchor = alignBackToSaturday(today);
  return {
    version: STATE_VERSION,
    anchorPeriodStart: anchor,
    activePeriodStart: anchor,
    ptoCodeLabel: 'PTO',
    periods: {},
  };
}

export function emptyDay() {
  return { start: '', end: '', breakHours: 0, pto: 0, note: '', alloc: {} };
}

export function emptyPeriod() {
  return { codes: [], days: {} };
}

function normalizeDay(raw) {
  const day = emptyDay();
  if (!raw || typeof raw !== 'object') return day;
  day.start = typeof raw.start === 'string' ? raw.start : '';
  day.end = typeof raw.end === 'string' ? raw.end : '';
  day.note = typeof raw.note === 'string' ? raw.note : '';
  day.breakHours = Number(raw.breakHours) || 0;
  day.pto = Number(raw.pto) || 0;
  if (raw.alloc && typeof raw.alloc === 'object') {
    for (const [codeId, hours] of Object.entries(raw.alloc)) {
      const amount = Number(hours);
      if (Number.isFinite(amount) && amount !== 0) day.alloc[codeId] = amount;
    }
  }
  return day;
}

function normalizePeriod(raw) {
  const period = emptyPeriod();
  if (!raw || typeof raw !== 'object') return period;

  const seenIds = new Set();
  for (const rawCode of Array.isArray(raw.codes) ? raw.codes : []) {
    if (!rawCode || typeof rawCode !== 'object') continue;
    const code = String(rawCode.code ?? '').trim();
    if (!code) continue;
    let id = String(rawCode.id ?? '') || newId();
    if (seenIds.has(id)) id = newId();
    seenIds.add(id);
    period.codes.push({
      id,
      code,
      label: String(rawCode.label ?? '').trim(),
      type: rawCode.type === 'overtime' ? 'overtime' : 'regular',
    });
  }

  if (raw.days && typeof raw.days === 'object') {
    for (const [date, rawDay] of Object.entries(raw.days)) {
      if (!isValidISO(date)) continue;
      period.days[date] = normalizeDay(rawDay);
    }
  }
  return period;
}

/** Coerce anything (parsed JSON, an import file) into a valid state object. */
export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const anchor = isValidISO(raw.anchorPeriodStart)
    ? alignBackToSaturday(raw.anchorPeriodStart)
    : base.anchorPeriodStart;

  const active = isValidISO(raw.activePeriodStart)
    ? periodStartContaining(raw.activePeriodStart, anchor)
    : periodStartContaining(todayISO(), anchor);

  const periods = {};
  if (raw.periods && typeof raw.periods === 'object') {
    for (const [start, rawPeriod] of Object.entries(raw.periods)) {
      if (!isValidISO(start)) continue;
      periods[periodStartContaining(start, anchor)] = normalizePeriod(rawPeriod);
    }
  }

  return {
    version: STATE_VERSION,
    anchorPeriodStart: anchor,
    activePeriodStart: active,
    ptoCodeLabel: String(raw.ptoCodeLabel ?? '').trim() || 'PTO',
    periods,
  };
}

export function loadState() {
  let stored = null;
  try {
    stored = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch (err) {
    storageWarning =
      'Browser storage is unavailable, so entries will be lost when this tab closes. Export a JSON backup before you go.';
    return defaultState();
  }
  if (!stored) return defaultState();
  try {
    return normalizeState(JSON.parse(stored));
  } catch (err) {
    storageWarning =
      'Saved data could not be read and was ignored. Nothing was overwritten yet — export a JSON backup if you have one.';
    return defaultState();
  }
}

function writeNow(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWarning = '';
    return true;
  } catch (err) {
    storageWarning =
      'Could not save to browser storage (it may be full or blocked). Keep this tab open and export a JSON backup.';
    return false;
  }
}

/** Debounced save; call flushSave() when you need it on disk immediately. */
export function saveState(state, onWarning) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const before = storageWarning;
    writeNow(state);
    if (storageWarning !== before && typeof onWarning === 'function') {
      onWarning(storageWarning);
    }
  }, SAVE_DELAY_MS);
}

export function flushSave(state) {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return writeNow(state);
}

// --- accessors / mutations -------------------------------------------------

/** The period record for `startISO`, created on demand. */
export function getPeriod(state, startISO) {
  if (!state.periods[startISO]) state.periods[startISO] = emptyPeriod();
  return state.periods[startISO];
}

/** Read-only peek that does not create the record. */
export function peekPeriod(state, startISO) {
  return state.periods[startISO] || null;
}

export function getDay(state, startISO, dateISO) {
  const period = getPeriod(state, startISO);
  if (!period.days[dateISO]) period.days[dateISO] = emptyDay();
  return period.days[dateISO];
}

export function peekDay(state, startISO, dateISO) {
  const period = state.periods[startISO];
  return (period && period.days[dateISO]) || null;
}

/** A code is identified by name *and* charging type, so the same number can be
    carried once as regular and once as overtime. The type leads: a name may
    contain spaces, so trailing it would let "A B"+regular collide with "A"+"B regular". */
function codeKey(code, type) {
  return `${type} ${String(code).trim().toLowerCase()}`;
}

export function addCode(state, startISO, { code, label, type }) {
  const period = getPeriod(state, startISO);
  const trimmed = String(code ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Enter a charge code.' };

  const kind = type === 'overtime' ? 'overtime' : 'regular';
  const clash = period.codes.some(
    (existing) => codeKey(existing.code, existing.type) === codeKey(trimmed, kind),
  );
  if (clash) {
    const article = kind === 'overtime' ? 'an overtime' : 'a regular';
    return { ok: false, error: `${trimmed} is already in this pay period as ${article} code.` };
  }

  const entry = {
    id: newId(),
    code: trimmed,
    label: String(label ?? '').trim(),
    type: kind,
  };
  period.codes.push(entry);
  return { ok: true, code: entry };
}

/** Remove a code and every hour allocated to it. */
export function removeCode(state, startISO, codeId) {
  const period = getPeriod(state, startISO);
  period.codes = period.codes.filter((code) => code.id !== codeId);
  for (const day of Object.values(period.days)) delete day.alloc[codeId];
}

export function setAllocation(state, startISO, dateISO, codeId, hours) {
  const day = getDay(state, startISO, dateISO);
  const amount = Number(hours);
  if (!Number.isFinite(amount) || amount === 0) delete day.alloc[codeId];
  else day.alloc[codeId] = amount;
}

/** Bring forward the previous period's charge codes, skipping duplicates. */
export function copyCodesFromPrevious(state, startISO, previousStartISO) {
  const previous = state.periods[previousStartISO];
  if (!previous || previous.codes.length === 0) return 0;
  const period = getPeriod(state, startISO);
  const existing = new Set(period.codes.map((code) => codeKey(code.code, code.type)));
  let copied = 0;
  for (const code of previous.codes) {
    if (existing.has(codeKey(code.code, code.type))) continue;
    period.codes.push({ id: newId(), code: code.code, label: code.label, type: code.type });
    existing.add(codeKey(code.code, code.type));
    copied += 1;
  }
  return copied;
}

/** Wipe the period's day entries, keeping its charge codes. */
export function clearPeriodDays(state, startISO) {
  getPeriod(state, startISO).days = {};
}

export function setAnchor(state, requestedISO) {
  const anchor = alignBackToSaturday(requestedISO);
  const snapped = anchor !== requestedISO;
  const remapped = {};
  for (const [start, period] of Object.entries(state.periods)) {
    remapped[periodStartContaining(start, anchor)] = period;
  }
  state.periods = remapped;
  state.anchorPeriodStart = anchor;
  state.activePeriodStart = periodStartContaining(state.activePeriodStart, anchor);
  return { anchor, snapped };
}
