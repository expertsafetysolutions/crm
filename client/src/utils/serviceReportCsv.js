/**
 * CSV helpers for the Service Report equipment table.
 *
 * Export writes one column per schema column plus any per-client custom columns, using the column
 * LABEL as the CSV header. Import matches cells back to columns by that label (case-insensitive),
 * so a file exported for one client round-trips cleanly. Headers the current report doesn't know
 * about are kept as new per-client custom columns, which is how a client's columns "vary slightly"
 * without breaking the shared module format.
 *
 * These are pure transforms; the page owns the actual papaparse parse/unparse and file I/O.
 */

import { COLUMN_TYPES, CHECKPOINT_OK, CHECKPOINT_NOT_OK } from './reportTypeSchemas';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

const SR_NO_HEADER = 'Sr No';

// Reads a cell from a parsed CSV row by header label, tolerant of case and surrounding spaces.
function readCell(row, label) {
  const target = norm(label);
  const key = Object.keys(row).find(k => norm(k) === target);
  return key === undefined ? undefined : row[key];
}

// Anything clearly negative becomes NOT OK; blank or anything else defaults to OK, matching the
// on-screen rule that checkpoints are OK until a technician marks them otherwise.
function normalizeCheckpoint(raw) {
  const v = norm(raw);
  if (!v) return CHECKPOINT_OK;
  if (['not ok', 'notok', 'not-ok', 'fail', 'failed', 'no', 'x', 'ng'].includes(v)) return CHECKPOINT_NOT_OK;
  return CHECKPOINT_OK;
}

/** Builds the array of header-keyed objects papaparse.unparse expects, one per equipment row. */
export function itemsToCsvObjects(items, columns, customColumns = []) {
  return (items || []).map((it, idx) => {
    const obj = { [SR_NO_HEADER]: idx + 1 };
    columns.forEach(col => { obj[col.label] = it[col.id] ?? ''; });
    customColumns.forEach(col => { obj[col.label] = it.customValues?.[col.id] ?? ''; });
    return obj;
  });
}

/**
 * Converts parsed CSV rows (header-keyed objects) into equipment rows for the report.
 * Returns { items, addedCustomColumns } — addedCustomColumns holds any unrecognised headers,
 * which the caller should merge into reportForm.customColumns so they render.
 */
export function csvObjectsToItems(rows, columns, customColumns = []) {
  const schemaLabels = new Set(columns.map(c => norm(c.label)));
  const known = new Set([...schemaLabels, ...customColumns.map(c => norm(c.label)), norm(SR_NO_HEADER)]);

  // Detect extra headers (present in the file, unknown to this report) across all rows.
  const addedCustomColumns = [];
  const seen = new Set();
  (rows || []).forEach(row => {
    Object.keys(row).forEach(h => {
      const n = norm(h);
      if (n && !known.has(n) && !seen.has(n)) {
        seen.add(n);
        addedCustomColumns.push({
          id: 'col-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          label: String(h).trim()
        });
      }
    });
  });

  const allCustom = [...customColumns, ...addedCustomColumns];
  const stamp = Date.now();

  const items = (rows || []).map((row, idx) => {
    const item = {
      id: 'eq-' + stamp + '-' + idx + '-' + Math.random().toString(36).slice(2, 6),
      srNo: idx + 1,
      customValues: {}
    };
    columns.forEach(col => {
      const raw = readCell(row, col.label);
      item[col.id] = col.type === COLUMN_TYPES.CHECKPOINT ? normalizeCheckpoint(raw) : (raw ?? '');
    });
    allCustom.forEach(col => {
      item.customValues[col.id] = readCell(row, col.label) ?? '';
    });
    return item;
  });

  return { items, addedCustomColumns };
}
