/**
 * Pure helpers for the Field Visit flow's cross-family equipment search.
 *
 * A client's registered equipment lives in several Client_Equipment_Master records, one per
 * report family (Fire Extinguisher / System / Alarm / ...). The field-visit page fetches all of
 * them in one call (GET /api/client-equipment/:customerId/all) and uses these helpers to merge
 * them into one flat, searchable list so a technician can search any item — regardless of which
 * family it belongs to — while walking the site once.
 *
 * Pure transforms only; the page owns the actual fetch.
 */

/** Flattens { FIRE_EXTINGUISHER: [...], SYSTEM: [...] } into one array, each row tagged with the
 *  family it came from (__reportType), so a search result can be routed to the right checklist. */
export function buildEquipmentIndex(byType) {
  const index = [];
  Object.entries(byType || {}).forEach(([reportType, items]) => {
    (items || []).forEach(row => {
      index.push({ ...row, __reportType: reportType });
    });
  });
  return index;
}

/** Report-type ids that actually have at least one registered item for this client, in the
 *  given display order (typically REPORT_TYPE_LIST). */
export function familiesWithEquipment(byType, reportTypeList) {
  return (reportTypeList || []).filter(t => Array.isArray(byType?.[t.id]) && byType[t.id].length > 0);
}

/** Whether a row matches a free-text query against the identity fields staff search by in the
 *  field: Client ID No, Serial No, Manufacturer, Cylinder No, description, location. */
export function matchesEquipmentQuery(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [row.clientIdNo, row.serialNo, row.mfgName, row.cylinderNo, row.itemName, row.location]
    .some(v => String(v || '').toLowerCase().includes(q));
}
