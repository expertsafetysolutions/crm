/**
 * REPORT_TYPE_SCHEMAS — column definitions for each Service Report module.
 *
 * Every module owns a base column set rendered identically in the editable table and the
 * A4 preview/PDF, so a header can never drift out of sync with its values. Admins edit these
 * in Document Settings; per-client extra columns ride on reportForm.customColumns on top.
 *
 * Column shape:
 *   id         key on each itemsList row (also the CSV header match key)
 *   label      column heading, shown in the table, the PDF and the CSV export
 *   type       'text' | 'date' | 'number' | 'checkpoint'
 *   align      optional cell alignment: 'left' | 'center' (default 'center')
 *   emphasis   optional semantic styling hint the renderer maps to classes, kept
 *              non-visual here so admins can define columns without writing CSS
 *   legacyFlag optional path into the pre-schema docSettings toggles, so existing
 *              admin configuration keeps applying until it is migrated
 *
 * type 'checkpoint' columns are the tap-to-toggle OK / NOT OK cells. They drive the green
 * completed-row state and the auto-generated NOT OK observations, so a column is a checkpoint
 * only when a technician physically inspects it.
 */

export const COLUMN_TYPES = {
  TEXT: 'text',
  DATE: 'date',
  NUMBER: 'number',
  CHECKPOINT: 'checkpoint'
};

// Semantic styling hints. The renderer owns the actual classes.
export const EMPHASIS = {
  ID: 'id',
  STRONG: 'strong',
  DANGER: 'danger',
  PRIMARY: 'primary',
  MUTED: 'muted'
};

// Table-level schema version. v1 reports render through the frozen legacy table, which printed
// a headerless `valve` value and so shifted every column to its right. New reports use the
// schema-driven table, where headers and values come from one list and cannot drift apart.
export const TABLE_SCHEMA_LEGACY = 1;
export const TABLE_SCHEMA_CURRENT = 2;

export const CHECKPOINT_OK = 'OK';
export const CHECKPOINT_NOT_OK = 'NOT OK';

// Columns common to every equipment-bearing module.
const IDENTITY_COLUMNS = [
  { id: 'location', label: 'Location', type: COLUMN_TYPES.TEXT, align: 'left', legacyFlag: 'visible_columns.location' },
  { id: 'clientIdNo', label: 'Client ID No', type: COLUMN_TYPES.TEXT, emphasis: EMPHASIS.ID, legacyFlag: 'visible_columns.client_id_no' }
];

const REMARKS_COLUMN = { id: 'remarks', label: 'Remarks', type: COLUMN_TYPES.TEXT, align: 'left', emphasis: EMPHASIS.MUTED };

export const REPORT_TYPES = {
  FIRE_EXTINGUISHER: {
    id: 'FIRE_EXTINGUISHER',
    label: 'Fire Extinguisher Service Report',
    shortLabel: 'Fire Extinguisher',
    route: 'fire-extinguisher',
    title: 'INSPECTION REPORT FOR FIRE EXTINGUISHER',
    // Default report-number parts. Admins override these per type in Document Settings; each
    // type counts its own sequence so numbers never collide across modules.
    numbering: { prefix: 'Expert/', period: '26-27', sequence: 'SR310' },
    // Mirrors the column order the module shipped with, so existing reports render unchanged.
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'Fire Ext. Description', type: COLUMN_TYPES.TEXT, align: 'left', emphasis: EMPHASIS.STRONG },
      { id: 'mfgYear', label: 'MFG', type: COLUMN_TYPES.TEXT, legacyFlag: 'visible_columns.mfg_year' },
      { id: 'refillingDate', label: 'Refilling Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.refill_date' },
      { id: 'nextRefillingDate', label: 'Refilling Due Dt', type: COLUMN_TYPES.DATE, emphasis: EMPHASIS.DANGER, legacyFlag: 'visible_columns.next_refill_due' },
      { id: 'hptDate', label: 'HP Testing Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.hpt_date' },
      { id: 'hptDueDate', label: 'HP Testing Due Dt', type: COLUMN_TYPES.DATE, emphasis: EMPHASIS.PRIMARY, legacyFlag: 'visible_columns.hpt_due_date' },
      { id: 'bodyValve', label: 'Body/Valve', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.body_valve' },
      // Rendered as a value but had no header before the schema refactor, which shifted every
      // column to its right in the PDF. It is a real checkpoint (own toggle, own row field).
      { id: 'valve', label: 'Valve', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.valve' },
      { id: 'safetyPin', label: 'Safety Pin', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.safety_pin' },
      { id: 'pressureWeight', label: 'Pressure / Wt', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.pressure_gauge' },
      { id: 'hoseHorn', label: 'Hose & Horn', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.hose_pipe' },
      { id: 'seal', label: 'Seal', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.seal' },
      REMARKS_COLUMN
    ]
  },

  // The four modules below ship with identity columns only. Checkpoints are intentionally
  // left undefined rather than guessed — they are added per module in Document Settings.
  SYSTEM: {
    id: 'SYSTEM',
    label: 'System Service Report',
    shortLabel: 'System',
    route: 'system',
    title: 'INSPECTION REPORT FOR FIRE FIGHTING SYSTEM',
    numbering: { prefix: 'Expert/', period: '26-27', sequence: 'SYS1' },
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'System Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      REMARKS_COLUMN
    ]
  },

  ALARM: {
    id: 'ALARM',
    label: 'Alarm System Service Report',
    shortLabel: 'Alarm System',
    route: 'alarm',
    title: 'INSPECTION REPORT FOR FIRE ALARM SYSTEM',
    numbering: { prefix: 'Expert/', period: '26-27', sequence: 'AL1' },
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'Device Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      REMARKS_COLUMN
    ]
  },

  GENERAL: {
    id: 'GENERAL',
    label: 'General Service Report',
    shortLabel: 'General',
    route: 'general',
    title: 'GENERAL SERVICE REPORT',
    numbering: { prefix: 'Expert/', period: '26-27', sequence: 'GEN1' },
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      REMARKS_COLUMN
    ]
  },

  VISIT: {
    id: 'VISIT',
    label: 'Visit Report',
    shortLabel: 'Visit',
    route: 'visit',
    title: 'SITE VISIT REPORT',
    numbering: { prefix: 'Expert/', period: '26-27', sequence: 'VR1' },
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      REMARKS_COLUMN
    ]
  }
};

export const REPORT_TYPE_LIST = Object.values(REPORT_TYPES);

export const DEFAULT_REPORT_TYPE = REPORT_TYPES.FIRE_EXTINGUISHER.id;

/** Look up a module by id, falling back to Fire Extinguisher for legacy reports with no type. */
export function getReportType(typeId) {
  return REPORT_TYPES[typeId] || REPORT_TYPES[DEFAULT_REPORT_TYPE];
}

/** Look up a module by its URL segment. */
export function getReportTypeByRoute(route) {
  return REPORT_TYPE_LIST.find(t => t.route === route) || null;
}

/** Reads a dotted path like 'visible_columns.location' out of a module's docSettings config. */
function readLegacyFlag(config, path) {
  if (!config || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), config);
}

/**
 * Resolves the column list actually rendered for a module: admin-configured columns when
 * present, otherwise the built-in defaults, minus any column switched off via the legacy
 * visible_columns / enabled_checkpoints toggles.
 */
export function resolveColumns(typeId, serviceReportConfig = {}) {
  const type = getReportType(typeId);
  const configured = serviceReportConfig?.report_types?.[type.id]?.columns;
  const columns = Array.isArray(configured) && configured.length > 0 ? configured : type.columns;
  return columns.filter(col => readLegacyFlag(serviceReportConfig, col.legacyFlag) !== false);
}

/** The subset of resolved columns a technician toggles OK / NOT OK. */
export function getCheckpointColumns(typeId, serviceReportConfig = {}) {
  return resolveColumns(typeId, serviceReportConfig).filter(c => c.type === COLUMN_TYPES.CHECKPOINT);
}

/**
 * Report-number parts for a module: admin-configured values from settings when present,
 * otherwise the module's built-in defaults. Returns { prefix, period, sequence }.
 */
export function resolveNumbering(typeId, serviceReportConfig = {}) {
  const type = getReportType(typeId);
  const configured = serviceReportConfig?.report_types?.[type.id]?.numbering || {};
  return { ...type.numbering, ...configured };
}

/** Full report number string for a module, e.g. "Expert/26-27/SR310". */
export function buildReportId(numbering) {
  const { prefix = '', period = '', sequence = '' } = numbering || {};
  return `${prefix}${period}/${sequence}`;
}

// Splits a sequence like "SR310" into its letter prefix ("SR") and number (310).
function splitSequence(sequence) {
  const letters = (sequence || '').match(/^[A-Za-z]+/)?.[0] || 'SR';
  const num = parseInt((sequence || '').match(/\d+/)?.[0] || '0', 10);
  return { letters, num: isNaN(num) ? 0 : num };
}

/**
 * Next sequence for a module, counting only reports of that same type. Starts from the module's
 * configured sequence and never goes backwards past a number already issued for the type.
 */
export function nextSequenceForType(typeId, serviceReportConfig, reports = []) {
  const start = splitSequence(resolveNumbering(typeId, serviceReportConfig).sequence);
  // Track the highest number already issued for this type. Seed one below the configured start so
  // the first-ever report of a type gets the start number itself, not start+1, and so a report
  // numbered below the configured start can never drag the sequence backwards.
  let maxNum = start.num - 1;
  reports
    .filter(r => (r.reportType || DEFAULT_REPORT_TYPE) === typeId)
    .forEach(r => {
      const parts = String(r.Report_ID || '').split('/');
      const seq = parts[parts.length - 1] || '';
      const { num } = splitSequence(seq);
      if (num > maxNum) maxNum = num;
    });
  return `${start.letters}${maxNum + 1}`;
}

/**
 * Admin-configured default recommendation for a given checkpoint column, e.g. "Replace missing
 * safety pin" for the safetyPin checkpoint. Empty string when none is set. Stored per report type
 * under report_types[TYPE].recommendation_library keyed by column id.
 */
export function getRecommendationDefault(typeId, serviceReportConfig, checkpointId) {
  const type = getReportType(typeId);
  const lib = serviceReportConfig?.report_types?.[type.id]?.recommendation_library || {};
  return lib[checkpointId] || '';
}

/**
 * Collects the issues on a report: every checkpoint currently marked NOT OK, across all rows,
 * with the identifying label and the recommendation captured for it. Drives the auto-composed
 * observation summary and the issues panel.
 */
export function collectNotOkIssues(items = [], columns = []) {
  const checkpoints = columns.filter(c => c.type === COLUMN_TYPES.CHECKPOINT);
  const issues = [];
  items.forEach((row, idx) => {
    checkpoints.forEach(cp => {
      if ((row[cp.id] || CHECKPOINT_OK) === CHECKPOINT_NOT_OK) {
        issues.push({
          rowId: row.id,
          rowIndex: idx,
          srNo: idx + 1,
          checkpointId: cp.id,
          checkpointLabel: cp.label,
          clientIdNo: row.clientIdNo || '',
          location: row.location || '',
          itemName: row.itemName || '',
          recommendation: row.recommendations?.[cp.id] || ''
        });
      }
    });
  });
  return issues;
}

/** Human label for an issue's equipment: prefers Client ID, falls back to Sr No / location. */
export function issueEquipmentLabel(issue) {
  return issue.clientIdNo || issue.location || `Sr ${issue.srNo}`;
}

/** Composes the observation/recommendation summary text from the NOT OK issues (item 4). */
export function composeIssueSummary(issues = []) {
  if (!issues.length) return '';
  return issues
    .map(i => {
      const who = issueEquipmentLabel(i);
      const rec = i.recommendation ? ` — ${i.recommendation}` : '';
      return `• [${who}] ${i.checkpointLabel}: NOT OK${rec}`;
    })
    .join('\n');
}

/** Builds a blank row for a module, with every checkpoint defaulted to OK. */
export function createEmptyRow(typeId, serviceReportConfig = {}, srNo = 1) {
  const row = {
    id: 'eq-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    srNo,
    customValues: {}
  };
  resolveColumns(typeId, serviceReportConfig).forEach(col => {
    row[col.id] = col.type === COLUMN_TYPES.CHECKPOINT ? CHECKPOINT_OK : '';
  });
  return row;
}
