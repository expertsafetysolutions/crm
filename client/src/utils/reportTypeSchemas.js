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

// ─── Fire Extinguisher sub-types (ABC vs CO2) ──────────────────────────────────────────────────
// Same identity/date columns either way; only the checkpoint set differs. ABC keeps the exact
// ids/legacyFlags the module shipped with so rows with no subType (all pre-existing reports)
// keep rendering through the untouched 2-arg resolveColumns() path below, unaffected by any of this.
const FIRE_EXTINGUISHER_BASE_COLUMNS = [
  ...IDENTITY_COLUMNS,
  { id: 'itemName', label: 'Fire Ext. Description', type: COLUMN_TYPES.TEXT, align: 'left', emphasis: EMPHASIS.STRONG },
  { id: 'mfgYear', label: 'MFG', type: COLUMN_TYPES.TEXT, legacyFlag: 'visible_columns.mfg_year' },
  { id: 'refillingDate', label: 'Refilling Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.refill_date' },
  { id: 'nextRefillingDate', label: 'Refilling Due Dt', type: COLUMN_TYPES.DATE, emphasis: EMPHASIS.DANGER, legacyFlag: 'visible_columns.next_refill_due' },
  { id: 'hptDate', label: 'HP Testing Date', type: COLUMN_TYPES.DATE, legacyFlag: 'visible_columns.hpt_date' },
  { id: 'hptDueDate', label: 'HP Testing Due Dt', type: COLUMN_TYPES.DATE, emphasis: EMPHASIS.PRIMARY, legacyFlag: 'visible_columns.hpt_due_date' }
];

const FIRE_EXTINGUISHER_ABC_CHECKPOINTS = [
  { id: 'bodyValve', label: 'Body/Valve', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.body_valve' },
  // Rendered as a value but had no header before the schema refactor, which shifted every
  // column to its right in the PDF. It is a real checkpoint (own toggle, own row field).
  { id: 'valve', label: 'Valve', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.valve' },
  { id: 'safetyPin', label: 'Safety Pin', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.safety_pin' },
  { id: 'pressureWeight', label: 'Pressure / Wt', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.pressure_gauge' },
  { id: 'hoseHorn', label: 'Hose & Horn', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.hose_pipe' },
  { id: 'seal', label: 'Seal', type: COLUMN_TYPES.CHECKPOINT, legacyFlag: 'enabled_checkpoints.seal' }
];

// CO2 cylinders have no pressure gauge (checked by weight against the nameplate) and discharge
// through a horn/cone rather than a hose — different physical checks, same row shape otherwise.
const FIRE_EXTINGUISHER_CO2_CHECKPOINTS = [
  { id: 'bodyValve', label: 'Body/Valve', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'valve', label: 'Valve/Horn Assembly', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'safetyPin', label: 'Safety Pin', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'weightCheck', label: 'Weight (vs Nameplate)', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'dischargeHorn', label: 'Discharge Horn/Cone', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'seal', label: 'Seal', type: COLUMN_TYPES.CHECKPOINT }
];

// ─── Fire Fighting System sub-types ────────────────────────────────────────────────────────────
// Hydrant Valve/Post, Hose Box and Hose Reel are physically different fittings but share one
// inspection checklist (the same checks repeat at every location on site). Pump House is a
// distinct set of pump-room checks and does not share any checkpoint with the hose-side items.
const SYSTEM_BASE_COLUMNS = [
  ...IDENTITY_COLUMNS,
  { id: 'itemName', label: 'System Description', type: COLUMN_TYPES.TEXT, align: 'left' },
  { id: 'lastServiceDate', label: 'Last Service Date', type: COLUMN_TYPES.DATE },
  { id: 'nextServiceDueDate', label: 'Next Service Due', type: COLUMN_TYPES.DATE, emphasis: EMPHASIS.DANGER }
];

const SYSTEM_HOSE_COMMON_CHECKPOINTS = [
  { id: 'valveCondition', label: 'Valve Condition (No Leakage)', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'hoseCondition', label: 'Hose Fabric/Coupling', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'branchPipeNozzle', label: 'Branch Pipe/Nozzle', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'couplingGasket', label: 'Coupling Gaskets/Washers', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'cabinetSignage', label: 'Box/Cabinet & Signage', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'flowTestOk', label: 'Flow Test/Reel Rotation', type: COLUMN_TYPES.CHECKPOINT }
];

const SYSTEM_PUMP_HOUSE_CHECKPOINTS = [
  { id: 'jockeyPumpAutoStart', label: 'Jockey Pump Auto-Start', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'mainPumpStatus', label: 'Main Pump Status', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'dieselPumpAutoStart', label: 'Diesel Pump Auto-Start', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'headerPressureOk', label: 'Header Pressure OK', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'pressureSwitchSetting', label: 'Pressure Switch Setting', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'glandLeakage', label: 'Gland Leakage', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'panelIndicationLamps', label: 'Panel Indication Lamps', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'batteryFuelLevel', label: 'Battery/Fuel Level', type: COLUMN_TYPES.CHECKPOINT },
  { id: 'isolationValvesPosition', label: 'Isolation Valves Position', type: COLUMN_TYPES.CHECKPOINT }
];

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
    // Mirrors the column order the module shipped with, so existing reports (all of which have no
    // row-level subType) render unchanged through the 2-arg resolveColumns() path.
    columns: [...FIRE_EXTINGUISHER_BASE_COLUMNS, ...FIRE_EXTINGUISHER_ABC_CHECKPOINTS, REMARKS_COLUMN],
    baseColumns: FIRE_EXTINGUISHER_BASE_COLUMNS,
    defaultSubType: 'ABC',
    subTypes: {
      ABC: { id: 'ABC', label: 'ABC / DCP Type', checkpoints: FIRE_EXTINGUISHER_ABC_CHECKPOINTS },
      CO2: { id: 'CO2', label: 'CO2 Type', checkpoints: FIRE_EXTINGUISHER_CO2_CHECKPOINTS }
    }
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
    // Unchanged from before sub-types existed — rows with no subType (all pre-existing System
    // reports) keep rendering with zero checkpoints via the 2-arg resolveColumns() path.
    columns: [
      ...IDENTITY_COLUMNS,
      { id: 'itemName', label: 'System Description', type: COLUMN_TYPES.TEXT, align: 'left' },
      REMARKS_COLUMN
    ],
    baseColumns: SYSTEM_BASE_COLUMNS,
    // No defaultSubType: a System row with no subType is legacy data, not "Hose" by default guess.
    subTypes: {
      HOSE_COMMON: { id: 'HOSE_COMMON', label: 'Hydrant Valve / Hose Box / Hose Reel', checkpoints: SYSTEM_HOSE_COMMON_CHECKPOINTS },
      PUMP_HOUSE: { id: 'PUMP_HOUSE', label: 'Pump House', checkpoints: SYSTEM_PUMP_HOUSE_CHECKPOINTS }
    }
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

/** A module's built-in default columns (unfiltered), used to seed the settings checklist editor.
 *  Pass subTypeId for a module that has sub-types to get that sub-type's own checkpoint set. */
export function getDefaultColumns(typeId, subTypeId) {
  const type = getReportType(typeId);
  const subType = subTypeId && type.subTypes?.[subTypeId];
  if (subType) return [...(type.baseColumns || type.columns), ...subType.checkpoints, REMARKS_COLUMN];
  return type.columns;
}

/** Sub-types available for a module, e.g. [{id:'ABC',label:'ABC / DCP Type'}, {id:'CO2',...}]. */
export function getSubTypeList(typeId) {
  const type = getReportType(typeId);
  return Object.values(type.subTypes || {}).map(s => ({ id: s.id, label: s.label }));
}

/** The sub-type a module defaults new rows to when none is specified, or undefined if a missing
 *  subType should be treated as legacy data rather than guessed (e.g. SYSTEM). */
export function getDefaultSubType(typeId) {
  return getReportType(typeId).defaultSubType;
}

/** A row's effective sub-type: its own value, or the module's default if it has none. */
export function getRowSubType(typeId, row) {
  return row?.subType || getDefaultSubType(typeId);
}

/** Reads a dotted path like 'visible_columns.location' out of a module's docSettings config. */
function readLegacyFlag(config, path) {
  if (!config || !path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), config);
}

/**
 * Resolves the column list actually rendered for a module. When an admin has configured columns
 * in the checklist builder those are authoritative and returned as-is (the builder can hide a
 * column by removing it, so the legacy toggles no longer apply). Otherwise the built-in defaults
 * are used, minus any column switched off via the legacy visible_columns / enabled_checkpoints
 * toggles, so pre-builder admin configuration keeps working.
 */
export function resolveColumns(typeId, serviceReportConfig = {}, subTypeId) {
  const type = getReportType(typeId);
  const subType = subTypeId && type.subTypes?.[subTypeId];

  if (subType) {
    const configured = serviceReportConfig?.report_types?.[type.id]?.subtypes?.[subTypeId]?.columns;
    if (Array.isArray(configured) && configured.length > 0) return configured;
    return getDefaultColumns(typeId, subTypeId);
  }

  const configured = serviceReportConfig?.report_types?.[type.id]?.columns;
  if (Array.isArray(configured) && configured.length > 0) return configured;
  return type.columns.filter(col => readLegacyFlag(serviceReportConfig, col.legacyFlag) !== false);
}

/** The subset of resolved columns a technician toggles OK / NOT OK. */
export function getCheckpointColumns(typeId, serviceReportConfig = {}, subTypeId) {
  return resolveColumns(typeId, serviceReportConfig, subTypeId).filter(c => c.type === COLUMN_TYPES.CHECKPOINT);
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

/** Builds a blank row for a module, with every checkpoint defaulted to OK. Pass subTypeId for a
 *  module with sub-types so the row seeds only that sub-type's checkpoint keys and remembers
 *  which sub-type it is (row.subType) for later column resolution. */
export function createEmptyRow(typeId, serviceReportConfig = {}, srNo = 1, subTypeId) {
  const row = {
    id: 'eq-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    srNo,
    customValues: {}
  };
  if (subTypeId) row.subType = subTypeId;
  resolveColumns(typeId, serviceReportConfig, subTypeId).forEach(col => {
    row[col.id] = col.type === COLUMN_TYPES.CHECKPOINT ? CHECKPOINT_OK : '';
  });
  return row;
}
