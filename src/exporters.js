// CSV / JSON export and JSON import.

import { dayPTO, round2, toNumber } from './calc.js';
import { periodDays, weekdayShort } from './payperiod.js';
import { normalizeState } from './state.js';

const CSV_HEADER = ['date', 'weekday', 'charge_code', 'type', 'hours'];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/**
 * One row per date x charge code, plus a PTO row on days that have any.
 * Days with no hours are skipped entirely.
 */
export function buildCSV(state, startISO) {
  const period = state.periods[startISO];
  const rows = [csvRow(CSV_HEADER)];
  if (!period) return rows.join('\r\n');

  const codeById = new Map(period.codes.map((code) => [code.id, code]));

  for (const date of periodDays(startISO)) {
    const day = period.days[date];
    if (!day) continue;
    const weekday = weekdayShort(date);

    for (const code of period.codes) {
      const hours = toNumber(day.alloc[code.id]);
      if (hours === 0) continue;
      rows.push(csvRow([date, weekday, code.code, code.type, round2(hours).toFixed(2)]));
    }

    // Hours pointing at a code that no longer exists still belong in the export.
    for (const [codeId, raw] of Object.entries(day.alloc || {})) {
      if (codeById.has(codeId)) continue;
      const hours = toNumber(raw);
      if (hours === 0) continue;
      rows.push(csvRow([date, weekday, '(removed code)', 'regular', round2(hours).toFixed(2)]));
    }

    const pto = dayPTO(day);
    if (pto > 0) {
      rows.push(csvRow([date, weekday, state.ptoCodeLabel || 'PTO', 'pto', pto.toFixed(2)]));
    }
  }

  return rows.join('\r\n');
}

export function buildJSON(state) {
  return JSON.stringify(state, null, 2);
}

export function parseImportedJSON(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!raw || typeof raw !== 'object' || !raw.periods) {
    return { ok: false, error: 'That JSON does not look like a timecard backup.' };
  }
  return { ok: true, state: normalizeState(raw) };
}

export function downloadFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next turn so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportCSV(state, startISO) {
  downloadFile(`timecard-${startISO}.csv`, buildCSV(state, startISO), 'text/csv');
}

export function exportJSON(state, startISO) {
  downloadFile(`timecard-${startISO}.json`, buildJSON(state), 'application/json');
}
