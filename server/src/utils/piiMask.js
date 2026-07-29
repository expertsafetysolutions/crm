/**
 * piiMask — partially masks customer email and address for roles that do not need the full value.
 * Phone is a special case — see "WHY PHONE IS NOT MASKED FOR staff/delivery" below.
 *
 * Deliberately parallel to moneyMask.js in structure, for the same reason that file exists:
 * hiding a value in the UI is cosmetic, because the full value still arrives in the JSON and is
 * readable from the network tab or the offline IndexedDB cache. Masking happens on the way out,
 * so the hidden part never reaches the device.
 *
 * ── WHY PHONE IS NOT MASKED FOR staff/delivery ──────────────────────────────────────────────
 * Phone masking for these two roles was implemented and then reversed after tracing a real
 * break: client/src/pages/StaffDashboard.jsx's task-card Call and WhatsApp buttons read
 * `Contact`/`Customer_Contact` directly (via `getAvailableContacts()` in
 * client/src/utils/dateUtils.js) and strip it to digits — `.replace(/\D/g, '')` — to build
 * `tel:`/`wa.me`/intent hrefs. Fed a masked value like "+91 ***** 3210", that strip produces a
 * garbage 6-digit number ("913210"), and the resulting `tel:+913210` / `wa.me/913210` links are
 * syntactically valid — nothing throws — so the app silently dials or messages the wrong party
 * with no error shown. There is no server-side click-to-call proxy today (the one safe pattern
 * that exists, POST /api/challans/:id/pod-notify, is delivery-POD-confirmation-only and is not
 * used by task cards), so masking phone for these two roles broke a load-bearing existing
 * feature with no fallback. `PHONE_EXEMPT_ROLES` turns phone masking off for exactly the roles
 * that hit this code path. Email masking and address masking below are UNCHANGED — only phone
 * was reversed, because only phone is consumed client-side in a way that breaks when masked.
 *
 * ── PARTIAL, NOT ABSENT (email, address) ────────────────────────────────────────────────────
 * Contact data that IS masked is masked rather than deleted. Deleting it would break workflows
 * that legitimately need a partial value to recognise a record; showing all of it hands a full
 * customer contact list to every phone in the field, which is the realistic leak for a business
 * like this (staff turnover, a lost handset, a competitor).
 *
 * ── WHO IS AFFECTED ──────────────────────────────────────────────────────────────────────────
 * Email/address masking applies to `staff` and `delivery` — the two roles that work from a
 * customer list but have no reason to hold a complete one. Roles that legitimately own customer
 * relationships (admin, sales, supervisor, accounts, certification) are unaffected, because
 * masking them would be a silent regression to people doing their jobs today, exactly as the
 * `finance` module notes about sales and supervisor. Phone scope is governed separately by
 * `MASKED_ROLES` minus `PHONE_EXEMPT_ROLES` — see above.
 *
 * technician is NOT masked: a workshop technician calls customers about their cylinders directly.
 * Adding a role here is a deliberate act, like adding a field to MONEY_FIELDS.
 */

const { isAdmin } = require('./permissions');

/** Roles whose responses get PII-masked. Lowercased at comparison; see resolvePermissions. */
const MASKED_ROLES = new Set(['staff', 'delivery']);

/**
 * Phone-ish fields. Exact names, never a pattern — the same discipline moneyMask documents.
 * A regex over /Contact|Phone|Mobile/ would catch `Contact_Person` (a NAME, masking it would
 * render the record unusable), `phone_number_id` (a WhatsApp API config value) and
 * `Emergency_Contact` on the staff's own profile.
 */
const PHONE_FIELDS = new Set([
  'Contact', 'Customer_Contact', 'Contact_Number', 'Mobile', 'Phone',
  'Customer_Contact_Snapshot', 'customer_phone', 'contactNumber'
]);

/** Email fields — a full address is a spam/phishing target and identifies the individual. */
const EMAIL_FIELDS = new Set([
  'Email', 'Customer_Email', 'Customer_Email_Snapshot', 'customerEmail'
]);

/**
 * Full street addresses. Masked to locality level for these roles.
 *
 * Delivery is the deliberate exception, applied by the caller: a driver obviously needs the full
 * delivery address. See ADDRESS_EXEMPT_ROLES.
 */
const ADDRESS_FIELDS = new Set([
  'Address', 'Billing_Address', 'Shipping_Address',
  'Customer_Address_Snapshot', 'Consignee_Address', 'Location_Link'
]);

/** Roles that keep full addresses despite being masked elsewhere — they deliver to them. */
const ADDRESS_EXEMPT_ROLES = new Set(['delivery']);

/**
 * Roles that keep full, unmasked phone numbers despite being in MASKED_ROLES otherwise.
 *
 * Kept as its own set rather than reusing MASKED_ROLES directly — even though it holds the same
 * two roles today — so a future role added to MASKED_ROLES for email/address masking does NOT
 * silently get its phone exempted too. Exemption must be explicit, not inherited.
 *
 * Both roles here hit StaffDashboard.jsx's task-card Call/WhatsApp buttons, which read this field
 * directly and cannot tolerate a masked value — see the header comment for the full story.
 */
const PHONE_EXEMPT_ROLES = new Set(['staff', 'delivery']);

/**
 * Fields that must never be masked, with the reason. Asserted by the test suite.
 */
const NEVER_MASK_PII = {
  Company_Name: 'the identifier staff work from; masking it makes every list unusable',
  Customer_ID: 'join key',
  Staff_ID: 'join key and login identifier',
  Contact_Person: 'a name, not a number — needed to ask for the right person on arrival',
  Auth_Person: 'a name; same reason',
  GSTIN: 'printed on tax documents',
  Certificate_No: 'the reference a customer quotes back to you'
};

/**
 * `+91 98765 43210` → `+91 ***** 3210`
 *
 * Keeps the last 4 digits — the part people actually verify a number against — plus the country
 * code when one was written, so the value still reads as a phone number. The masked middle is a
 * fixed five stars rather than one-per-hidden-digit, so the output does not leak the original
 * length.
 *
 * Anything under 7 digits is returned unchanged: a short internal extension is not a mobile
 * number, and masking it would destroy the value while protecting nothing.
 */
function maskPhone(value) {
  if (typeof value !== 'string' || !value) return value;

  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return value;

  const last4 = digits.slice(-4);
  // Treat anything beyond the trailing 10 as a country code (Indian numbers are 10 digits).
  const ccDigits = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const prefix = ccDigits && value.trim().startsWith('+') ? `+${ccDigits} ` : '';
  return `${prefix}***** ${last4}`;
}

/** `rajesh@acme.co.in` → `r****@acme.co.in` — the domain stays, the person does not. */
function maskEmail(value) {
  if (typeof value !== 'string' || !value.includes('@')) return value;
  const [local, domain] = value.split('@');
  if (!local || !domain) return value;
  return `${local[0]}${'*'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}

/**
 * Keeps the last address line (locality/city), drops the street detail that pinpoints premises.
 * Falls back to a generic label for a single-line address, where any truncation would either
 * reveal the street or say nothing useful.
 */
function maskAddress(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const parts = value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return '[address hidden]';
  return `… ${parts[parts.length - 1]}`;
}

function isWalkable(v) {
  return v && typeof v === 'object';
}

/**
 * Returns a NEW object with PII masked. Never mutates the input.
 *
 * This is not optional politeness: sheetsService.getTab returns the cached array BY REFERENCE
 * with a 3s TTL, so masking a row in place would strip a customer's phone number for the NEXT
 * caller — who might be an Admin. moneyMask.maskValue() exists in this exact shape for the same
 * reason; see CLAUDE.md.
 *
 * `opts.keepPhones` mirrors `opts.keepAddresses`: both default to masking when absent (falsy),
 * and each is set independently by middleware() based on the caller's role.
 */
function maskValue(node, opts) {
  if (Array.isArray(node)) return node.map(n => maskValue(n, opts));
  if (!isWalkable(node)) return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (PHONE_FIELDS.has(key)) out[key] = opts.keepPhones ? value : maskPhone(value);
    else if (EMAIL_FIELDS.has(key)) out[key] = maskEmail(value);
    else if (ADDRESS_FIELDS.has(key) && !opts.keepAddresses) out[key] = maskAddress(value);
    else if (isWalkable(value)) out[key] = maskValue(value, opts);
    else out[key] = value;
  }
  return out;
}

function maskPayload(payload, opts) {
  if (!isWalkable(payload)) return payload;
  return maskValue(payload, opts);
}

/**
 * Express middleware. Wraps res.json so masking happens at send time whichever handler responds.
 *
 * Unlike moneyMask this is NOT route-scoped: customer contact details surface across tasks,
 * challans, job cards and /sync/all, so an allow-list of routes would leak through whichever one
 * was forgotten. The role check is the gate instead.
 */
function middleware() {
  return (req, res, next) => {
    if (isAdmin(req.user)) return next();

    const role = String(req.user?.role || '').trim().toLowerCase();
    if (!MASKED_ROLES.has(role)) return next();

    const opts = {
      keepAddresses: ADDRESS_EXEMPT_ROLES.has(role),
      keepPhones: PHONE_EXEMPT_ROLES.has(role)
    };
    const originalJson = res.json.bind(res);
    res.json = (payload) => originalJson(maskPayload(payload, opts));
    return next();
  };
}

module.exports = {
  MASKED_ROLES,
  PHONE_FIELDS,
  EMAIL_FIELDS,
  ADDRESS_FIELDS,
  ADDRESS_EXEMPT_ROLES,
  PHONE_EXEMPT_ROLES,
  NEVER_MASK_PII,
  maskPhone,
  maskEmail,
  maskAddress,
  maskValue,
  maskPayload,
  middleware
};
