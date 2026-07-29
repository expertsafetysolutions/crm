/**
 * Audit trail — who changed what, when, from where, and what the values were before and after.
 *
 * ── WHY THIS IS NOT Activity_Logs ────────────────────────────────────────────────────────────
 * `Activity_Logs` already exists and is kept as-is: it is the FIELD activity timeline, keyed on
 * `Task_ID`, storing a prose sentence ("Rescheduled to 2026-08-01") plus GPS and a photo. It
 * answers "what did the technician do on site". It cannot answer "who changed this customer's
 * GSTIN and what was it before" — there is no entity type, no old value, no new value, no IP and
 * no role on that record, and a non-task entity has nowhere to go but `Task_ID: 'GENERAL'`.
 *
 * Rather than widen Activity_Logs and disturb the LOGS tab that reads it, audit records live in
 * their own collection with their own shape.
 *
 * ── REDACTION IS NOT OPTIONAL ────────────────────────────────────────────────────────────────
 * An audit log copies field values by definition. Without redaction it would become a second,
 * unencrypted, unmasked copy of every phone number, address and price in the system — quietly
 * undoing the field-level encryption and the money/PII masking that already ship here. So values
 * are redacted on the way in, using the SAME field lists those two systems use, so a field added
 * to either is automatically covered here too.
 *
 * ── FAILURE IS SILENT BY DESIGN ──────────────────────────────────────────────────────────────
 * recordAudit never throws and never rejects. An audit write failing must not fail the customer
 * edit that triggered it — the business operation is what the user asked for; the audit row is
 * bookkeeping. Failures go to console.error, matching runReminderJob's "never throws" discipline.
 */

const sheetsService = require('../services/sheetsService');
const { MONEY_FIELDS } = require('./moneyMask');
const { PHONE_FIELDS, EMAIL_FIELDS, ADDRESS_FIELDS } = require('./piiMask');

const REDACTED = '[redacted]';

/** Always redacted regardless of the other lists — credentials and crypto material. */
const SECRET_FIELDS = new Set([
  'Password', 'password', 'Code_Hash', 'Token', 'token',
  'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'BACKUP_PASSWORD',
  'Push_Subscriptions', 'Profile_Photo'   // huge blobs, not meaningful in a diff
]);

function shouldRedact(field) {
  return SECRET_FIELDS.has(field)
    || MONEY_FIELDS.has(field)
    || PHONE_FIELDS.has(field)
    || EMAIL_FIELDS.has(field)
    || ADDRESS_FIELDS.has(field);
}

/**
 * Renders a value for storage: redacted if sensitive, truncated if huge, stringified if an object.
 *
 * Truncation matters — Line_Items on an invoice or a base64 photo would otherwise make a single
 * audit row larger than the document it describes.
 */
function safeValue(field, value) {
  if (shouldRedact(field)) return REDACTED;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 500)}… (${json.length} chars)` : json;
  }
  const str = String(value);
  return str.length > 500 ? `${str.slice(0, 500)}… (${str.length} chars)` : str;
}

/**
 * Field-level diff. Only changed fields are stored, so the viewer shows "GSTIN: X → Y" rather
 * than two 40-field documents the reader has to compare by eye.
 */
function diffFields(before, after) {
  if (!before || !after) return [];
  const changed = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === '_id' || field === '__v') continue;
    const from = before[field];
    const to = after[field];
    // JSON comparison so nested objects/arrays compare by value, not reference.
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changed.push({ field, from: safeValue(field, from), to: safeValue(field, to) });
  }
  return changed;
}

/**
 * The caller's real IP.
 *
 * Deliberately NOT `req.body.ipAddress`. The attendance routes trust a client-supplied IP, which
 * means a staff member can put any value they like in their own attendance record. An audit trail
 * whose IP column can be set by the person being audited is worse than having no IP column at all.
 * `app.set('trust proxy', 1)` makes req.ip correct behind Vercel's edge.
 */
function clientIp(req) {
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

/**
 * Writes one audit record.
 *
 * @param {object} req    Express request — supplies the actor (req.user) and the IP.
 * @param {object} entry
 * @param {string} entry.entity     Collection/entity name, e.g. 'Customer_Master'
 * @param {string} entry.entityId   The row's business key, e.g. 'CUST7608'
 * @param {string} entry.action     'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN_FAILED' | ...
 * @param {object} [entry.before]   Row state before (UPDATE/DELETE)
 * @param {object} [entry.after]    Row state after (CREATE/UPDATE)
 * @param {string} [entry.note]     Free text for actions with no before/after
 */
async function recordAudit(req, { entity, entityId, action, before, after, note } = {}) {
  try {
    const rand2 = Math.floor(Math.random() * 90 + 10);
    const record = {
      // LOG${Date.now()} (the Activity_Logs idiom) collides when several are written inside one
      // millisecond — which happens in loops. The random suffix follows the convention used by
      // every other hand-rolled ID in this codebase.
      Audit_ID: `AUD${Date.now().toString().slice(-6)}${rand2}`,
      Timestamp: new Date().toISOString(),
      Staff_ID: req?.user?.staffId || 'SYSTEM',
      Staff_Name: req?.user?.name || '',
      Role: req?.user?.role || '',
      IP: clientIp(req),
      Entity: entity || '',
      Entity_ID: entityId ? String(entityId) : '',
      Action: action || 'UPDATE',
      Note: note || '',
      Changed_Fields: action === 'UPDATE' ? diffFields(before, after) : []
    };

    // For create/delete there is no diff to show, so keep a redacted snapshot of the row instead.
    if (action === 'CREATE' && after) {
      record.Changed_Fields = Object.keys(after)
        .filter(f => f !== '_id' && f !== '__v')
        .map(f => ({ field: f, from: '', to: safeValue(f, after[f]) }));
    }
    if (action === 'DELETE' && before) {
      record.Changed_Fields = Object.keys(before)
        .filter(f => f !== '_id' && f !== '__v')
        .map(f => ({ field: f, from: safeValue(f, before[f]), to: '' }));
    }

    await sheetsService.insertRow('Audit_Logs', record);
    return record;
  } catch (err) {
    // Never propagate — see the header note.
    console.error('Audit write failed (operation itself was unaffected):', err.message);
    return null;
  }
}

module.exports = { recordAudit, diffFields, safeValue, shouldRedact, SECRET_FIELDS, REDACTED };
