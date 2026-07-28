/**
 * Client-side job card helpers: the checkpoint-to-part mapping, capacity normalisation and the
 * summary derivation, all mirroring their server counterparts in jobCardService.js.
 *
 * Duplicated deliberately rather than imported — the server is CommonJS and the client is ESM, and
 * these run optimistically on a phone that may be offline when it needs them. Keep the two in sync;
 * normalizeCapacity in particular must agree exactly or the offline preview will group differently
 * from the challan the server finally builds.
 */

export const CHECKPOINT_OK = 'OK';
export const CHECKPOINT_NOT_OK = 'NOT OK';

/**
 * The part a technician almost always fits when a given checkpoint fails. Used to pre-fill the
 * recheck modal so the common case is one tap; the item itself is resolved by name against
 * Item_Master at fitting time, since the catalogue is admin-maintained.
 */
export const CHECKPOINT_TO_PART = {
  controlValve: 'Control Valve',
  safetyPin: 'Safety Pin',
  pressureGauge: 'Pressure Gauge',
  valveHook: 'Valve Hook',
  body: 'Cylinder Body',
  mainLabel: 'Main Label',
  hoseBelt: 'Hose Belt',
  controlWheel: 'Control Wheel',
  lockRing: 'Lock Ring',
  handle: 'Handle',
  handleGrip: 'Handle Grip',
  emptyWeight: 'Recharge / Top-up'
};

export const SERVICE_STATUS = {
  PENDING: 'Pending',
  IN_PROGRESS: 'InProgress',
  DONE: 'Done',
  REJECTED: 'Rejected'
};

export const RECHECK = {
  FITTED: 'FITTED',
  CLIENT_REFUSED: 'CLIENT_REFUSED',
  NOT_REQUIRED: 'NOT_REQUIRED'
};

export const RECHECK_LABELS = {
  FITTED: 'Fitted',
  CLIENT_REFUSED: 'Client refused',
  NOT_REQUIRED: 'Not required'
};

/** Canonical capacity label: '6kg', '6 KG' and '6.0 Kg' all become '6 Kg'. */
export function normalizeCapacity(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^([\d.]+)\s*(kg|ltr|l|litre|liter)?/i);
  if (!m) return s;
  const unit = (m[2] || 'kg').toLowerCase();
  const label = unit.startsWith('l') ? 'Ltr' : 'Kg';
  return `${parseFloat(m[1])} ${label}`;
}

/** Idempotency key for an offline part fit. Generated on the device, never by the server. */
export function newLineId() {
  return `L${Date.now().toString(36)}${Math.random().toString(36).substring(2, 7)}`;
}

/** Client-generated row id so an offline-created cylinder keeps its identity through a replay. */
export function newJobCardItemId() {
  return `JCI${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
}

/** How a cylinder is identified to a human, most specific first. */
export function itemLabel(item) {
  return item?.Cylinder_No || item?.Serial_No || item?.EUID_No || item?.Client_ID_No || `Sr ${item?.Sr_No ?? '—'}`;
}

/** Every checkpoint currently NOT OK on a row, with the part usually fitted for it. */
export function notOkCheckpoints(item, columns = []) {
  const checkpoints = item?.Inward_Checkpoints || {};
  return columns
    .filter(c => c.type === 'checkpoint' && checkpoints[c.id] === CHECKPOINT_NOT_OK)
    .map(c => ({
      checkpointId: c.id,
      checkpointLabel: c.label,
      suggestedPart: CHECKPOINT_TO_PART[c.id] || c.label,
      resolved: Boolean(item?.Recheck_Resolution?.[c.id]),
      partFitted: (item?.Parts_Fitted || []).some(p => p.checkpointId === c.id)
    }));
}

/**
 * The inward row is complete once it can be identified and its service is decided — that is the
 * point CollapsibleSection folds it away. Checkpoints are not required: they default to OK, so
 * demanding them would keep every row open forever.
 */
export function isInwardRowComplete(item) {
  const identified = Boolean(item?.Cylinder_No || item?.Serial_No || item?.EUID_No || item?.Client_ID_No);
  const serviceDecided = Boolean(item?.Refilling_Required || item?.HP_Testing_Required);
  return Boolean(identified && item?.Equipment_Type && item?.Capacity && serviceDecided);
}

/** Client mirror of Job_Card_Master.Summary, for optimistic display before the server recomputes. */
export function summarizeJobCard(items = []) {
  const byType = {};
  let refillCount = 0;
  let hpTestCount = 0;

  for (const it of items) {
    if (it.Service_Status === SERVICE_STATUS.REJECTED) continue;
    const key = `${it.Equipment_Type || 'UNKNOWN'}|${normalizeCapacity(it.Capacity)}`;
    byType[key] = (byType[key] || 0) + 1;
    if (it.Refilling_Required) refillCount += 1;
    if (it.HP_Testing_Required) hpTestCount += 1;
  }

  return { totalItems: items.length, byType, refillCount, hpTestCount };
}

/** "ABC 6 Kg × 3, CO2 4.5 Kg × 1" — the one-line read of what is on the bench. */
export function formatSummaryLine(summary) {
  const entries = Object.entries(summary?.byType || {});
  if (entries.length === 0) return 'No items yet';
  return entries.map(([key, qty]) => `${key.replace('|', ' ')} × ${qty}`).join(', ');
}
