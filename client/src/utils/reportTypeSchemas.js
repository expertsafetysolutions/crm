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

export const CHECKPOINT_OK = 'OK';
export const CHECKPOINT_NOT_OK = 'NOT OK';

// Columns common to every equipment-bearing module.
const IDENTITY_COLUMNS = [
  { id: 'location', label: 'Location', type: COLUMN_TYPES.TEXT, align: 'left', legacyFlag: 'visible_columns.location' },
  { id: 'clientIdNo', label: 'Client ID No', type: COLUMN_TYPES.TEXT, legacyFlag: 'visible_columns.client_id_no' }
];

const REMARKS_COLUMN = { id: 'remarks', label: 'Remarks', type: COLUMN_TYPES.TEXT, align: 'left' };

export const REPORT_TYPES = {
  FIRE_EXTINGUISHER: {
    id: 'FIRE_EXTINGUISHER',
    label: 'Fire Extinguisher Service Report',
    shortLabel: 'Fire Extinguisher',
    route: 'fire-extinguisher',
    title: 'INSPECTION REPORT FOR FIRE EXTINGUISHER',
    // Mirrors the column order the module shipped with, so existing reports render unchanged.
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'Fire Ext. Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      { id: 'mfgYear', label: 'MFG', type: COLUMN_TYPES.TEXT, legacyFlag: 'visible_columns.mfg_year' },
      { id: 'refillingDate', label: 'Refilling Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.refill_date' },
      { id: 'nextRefillingDate', label: 'Refilling Due Dt', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.next_refill_due' },
      { id: 'hptDate', label: 'HP Testing Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.hpt_date' },
      { id: 'hptDueDate', label: 'HP Testing Due Dt', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.hpt_due_date' },
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
