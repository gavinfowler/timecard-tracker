// App state: shape, defaults, normalization, and localStorage persistence.

import { DEFAULT_WEEK_FORMAT, weekFormatById } from './calc.js';
import {
  alignBackToSaturday,
  isValidISO,
  periodStartContaining,
  todayISO,
} from './payperiod.js';

const STORAGE_KEY = 'timecard-tracker/v1';
const SAVE_DELAY_MS = 200;

// v3 adds a SUPP code on every charge code, the archived-code list, and the
// daily water figure. All three are additive, so a v2 file needs no migration
// beyond the defaults normalizeState fills in.
// v2 stores the daily break in whole minutes (`breakMinutes`); v1 stored it as
// decimal hours (`breakHours`). normalizeDay migrates the old field on read.
export const STATE_VERSION = 3;

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
    weekFormat: DEFAULT_WEEK_FORMAT,
    archivedCodes: [],
    periods: {},
  };
}

export function emptyDay() {
  return { start: '', end: '', breakMinutes: 0, pto: 0, waterOz: 0, note: '', alloc: {} };
}

export function emptyPeriod() {
  return { codes: [], days: {} };
}

/**
 * Break minutes, migrating a v1 day that still carries decimal `breakHours`.
 * A 0.5-hour break comes back as 30 minutes; anything unreadable is no break.
 */
function readBreakMinutes(raw) {
  const minutes = Number(raw.breakMinutes);
  if (Number.isFinite(minutes)) return Math.max(0, Math.round(minutes));
  const hours = Number(raw.breakHours);
  if (Number.isFinite(hours)) return Math.max(0, Math.round(hours * 60));
  return 0;
}

function normalizeDay(raw) {
  const day = emptyDay();
  if (!raw || typeof raw !== 'object') return day;
  day.start = typeof raw.start === 'string' ? raw.start : '';
  day.end = typeof raw.end === 'string' ? raw.end : '';
  day.note = typeof raw.note === 'string' ? raw.note : '';
  day.breakMinutes = readBreakMinutes(raw);
  day.pto = Number(raw.pto) || 0;
  day.waterOz = Math.max(0, Math.round(Number(raw.waterOz))) || 0;
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
      supp: String(rawCode.supp ?? '').trim(),
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

/** Archived-code keys: unique, non-empty strings, in the order first seen. */
function normalizeArchived(raw) {
  const keys = [];
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    keys.push(value);
  }
  return keys;
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
    // An unknown format falls back to the default rather than leaving every day
    // without a target. A file written before week formats existed has none.
    weekFormat: weekFormatById(raw.weekFormat).id,
    archivedCodes: normalizeArchived(raw.archivedCodes),
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

/** A code is identified by name, SUPP code *and* charging type, so the same
    number can be carried once as regular and once as overtime, and once under
    each SUPP code. The parts are joined on a unit separator rather than a space
    because a name may contain spaces: on a space, "A B"+"C" and "A"+"B C" would
    collide. */
const KEY_SEP = '\u001f';

function codeKey(code, supp, type) {
  return [
    type,
    String(supp ?? '').trim().toLowerCase(),
    String(code ?? '').trim().toLowerCase(),
  ].join(KEY_SEP);
}

/** The same key, straight off a stored charge code. */
export function codeKeyOf(code) {
  return codeKey(code.code, code.supp, code.type);
}

export function addCode(state, startISO, { code, supp, label, type }) {
  const period = getPeriod(state, startISO);
  const trimmed = String(code ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Enter a charge code.' };

  const suppCode = String(supp ?? '').trim();
  const kind = type === 'overtime' ? 'overtime' : 'regular';
  const key = codeKey(trimmed, suppCode, kind);
  if (period.codes.some((existing) => codeKeyOf(existing) === key)) {
    const article = kind === 'overtime' ? 'an overtime' : 'a regular';
    const named = suppCode ? `${trimmed} / ${suppCode}` : trimmed;
    return { ok: false, error: `${named} is already in this pay period as ${article} code.` };
  }

  const entry = {
    id: newId(),
    code: trimmed,
    supp: suppCode,
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

/** Bring forward the previous period's charge codes, skipping duplicates and
    anything archived — an archived code is one you have said you are done with. */
export function copyCodesFromPrevious(state, startISO, previousStartISO) {
  const previous = state.periods[previousStartISO];
  if (!previous || previous.codes.length === 0) return 0;
  const period = getPeriod(state, startISO);
  const archived = new Set(state.archivedCodes || []);
  const existing = new Set(period.codes.map(codeKeyOf));
  let copied = 0;
  for (const code of previous.codes) {
    const key = codeKeyOf(code);
    if (existing.has(key) || archived.has(key)) continue;
    period.codes.push({
      id: newId(),
      code: code.code,
      supp: code.supp,
      label: code.label,
      type: code.type,
    });
    existing.add(key);
    copied += 1;
  }
  return copied;
}

/** Wipe the period's day entries, keeping its charge codes. */
export function clearPeriodDays(state, startISO) {
  getPeriod(state, startISO).days = {};
}

// --- charge code catalog ---------------------------------------------------

/** True once any day in the period charges hours to `codeId`. */
function chargesHours(period, codeId) {
  for (const day of Object.values(period.days || {})) {
    if (Number((day.alloc || {})[codeId]) > 0) return true;
  }
  return false;
}

/** Later dates first; a null — never charged — sorts to the end. */
function compareISODesc(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

function compareCatalog(a, b) {
  return (
    compareISODesc(a.lastChargedStart, b.lastChargedStart) ||
    compareISODesc(a.lastSeenStart, b.lastSeenStart) ||
    a.code.localeCompare(b.code) ||
    a.supp.localeCompare(b.supp) ||
    // Same name and SUPP under both types: regular first ("regular" sorts after
    // "overtime", hence the flip), so the order does not depend on which period
    // happened to be read first.
    b.type.localeCompare(a.type)
  );
}

/**
 * Every charge code any pay period has ever carried, deduped by key.
 *
 * Codes are stored per period, with ids minted fresh each time, so there is no
 * stored catalog to read — this derives one. Nothing here is persisted, and
 * archiving a row writes only to `state.archivedCodes`, which is what lets a
 * code leave the list while every past pay period keeps its own copy and hours.
 */
export function codeCatalog(state, activeStartISO) {
  const archived = new Set(state.archivedCodes || []);
  const catalog = new Map();

  // Oldest period first, so the most recent spelling and description win.
  for (const startISO of Object.keys(state.periods || {}).sort()) {
    const period = state.periods[startISO];
    for (const code of period.codes || []) {
      const key = codeKeyOf(code);
      const row = catalog.get(key) || {
        key,
        archived: archived.has(key),
        activeId: null,
        lastChargedStart: null,
        lastSeenStart: null,
      };
      row.code = code.code;
      row.supp = code.supp;
      row.label = code.label;
      row.type = code.type;
      row.lastSeenStart = startISO;
      if (chargesHours(period, code.id)) row.lastChargedStart = startISO;
      if (startISO === activeStartISO) row.activeId = code.id;
      catalog.set(key, row);
    }
  }

  return [...catalog.values()].sort(compareCatalog);
}

export function isArchived(state, key) {
  return (state.archivedCodes || []).includes(key);
}

/** Drop a code from the catalog. Deliberately touches no pay period: the code
    and its hours stay wherever they were already entered. */
export function archiveCode(state, key) {
  if (!state.archivedCodes.includes(key)) state.archivedCodes.push(key);
}

export function restoreCode(state, key) {
  state.archivedCodes = state.archivedCodes.filter((archivedKey) => archivedKey !== key);
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
