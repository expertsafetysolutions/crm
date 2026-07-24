/**
 * Per-certificate-type equipment table column config. Mirrors reportTypeSchemas.js's
 * approach for Service Reports: a base column catalog + a resolver that prefers an
 * admin-configured ordered/toggleable list and falls back to sensible defaults.
 *
 * Columns are stored under docSettings.certificate_types[formatType].equipmentColumns,
 * edited via CertificateColumnEditor in the certificate page's own Settings tab.
 */

export const CERT_BASE_COLUMN_IDS = ['sr_no', 'item_name', 'capacity', 'qty', 'refill_date', 'valid_until'];

// Types that default to base columns OFF (only sr_no on) until an admin opts in —
// mirrors the previous NO_EQUIPMENT_TABLE_FORMATS behavior, but as a default, not a wall.
const MINIMAL_DEFAULT_FORMATS = ['AMC Certificate', 'Visit Report', 'Training Certificate'];

function defaultLabelFor(id, formatType) {
  const isHP = formatType === 'HP Testing';
  switch (id) {
    case 'sr_no': return 'Sr.';
    case 'item_name': return 'Item Name / Type';
    case 'capacity': return 'Capacity';
    case 'qty': return 'Qty';
    case 'refill_date': return isHP ? 'Date of Testing' : 'Date of Refilling';
    case 'valid_until': return isHP ? 'Next Date of Testing' : 'Next Date of Refilling';
    default: return id;
  }
}

/** Built-in default column list for a certificate type (unfiltered by any saved config). */
export function getDefaultEquipmentColumns(formatType) {
  const minimal = MINIMAL_DEFAULT_FORMATS.includes(formatType);
  return CERT_BASE_COLUMN_IDS.map(id => ({
    id,
    label: defaultLabelFor(id, formatType),
    enabled: minimal ? id === 'sr_no' : true
  }));
}

/**
 * Resolves the ordered column list to actually render for a type. An admin-configured
 * list (docSettings.certificate_types[formatType].equipmentColumns) is authoritative.
 * Otherwise builds the defaults and folds in the legacy global visible_columns toggles
 * and legacy per-type customColumns, so pre-existing configuration keeps applying
 * until an admin edits (and thereby materializes) the new per-type list.
 */
export function resolveEquipmentColumns(formatType, docSettings) {
  const typeCfg = docSettings?.certificate_types?.[formatType];
  if (Array.isArray(typeCfg?.equipmentColumns) && typeCfg.equipmentColumns.length > 0) {
    return typeCfg.equipmentColumns;
  }

  const legacyVisible = docSettings?.document_configs?.CERTIFICATE?.visible_columns || {};
  const base = getDefaultEquipmentColumns(formatType).map(col => ({
    ...col,
    enabled: legacyVisible[col.id] !== undefined ? legacyVisible[col.id] !== false : col.enabled
  }));

  const legacyCustom = (typeCfg?.customColumns || []).map(c => ({
    id: c.id,
    label: c.label,
    enabled: true,
    custom: true
  }));

  return [...base, ...legacyCustom];
}

export function newCustomColumnId() {
  return 'col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}
