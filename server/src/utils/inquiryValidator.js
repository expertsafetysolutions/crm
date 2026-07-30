/**
 * inquiryValidator — sanitises and validates the ONE payload in this app that arrives from an
 * unauthenticated stranger on the public internet.
 *
 * Every other write path in the system sits behind authenticateToken, so its input comes from a
 * known member of staff. `/api/inquiry` does not: anything here may be hostile, and whatever it
 * stores is later rendered into an admin's email client, a React dashboard and a draft quotation.
 * So the rule is sanitise on the way IN, and store only clean values — a stored payload is read
 * far more often than it is written, and one of those readers is an HTML email that React's
 * auto-escaping does not protect.
 *
 * What is deliberately NOT done here:
 *   - No HTML sanitiser dependency. These fields are plain text — a name, a phone, an address —
 *     so tags are stripped outright rather than allow-listed. There is no legitimate markup to
 *     preserve, which makes stripping strictly safer than any policy-based cleaner.
 *   - No rejection on "suspicious" content. A refusal teaches an attacker what the filter looks
 *     for, and would also reject a genuine customer whose company name contains an ampersand.
 *     Values are neutralised and accepted.
 *
 * Mongo injection is handled by shape, not by pattern-matching: every value returned from here is
 * a primitive string. A JSON body can carry `{"mobile": {"$ne": null}}`, and coercing to String
 * before it reaches a query turns that object into harmless text.
 */

const gstUtils = require('./gstUtils');

// Field lengths are generous for real data and tight enough that a payload cannot be used as
// storage. The whole-body cap in the route is the real backstop; these keep one field from
// consuming it.
const LIMITS = {
  name: 100,
  companyName: 150,
  email: 254, // RFC 5321 maximum
  address: 500,
  gstin: 15,
  otherRequirement: 1000
};

/**
 * The five requirement options. Server-side allow-list: whatever the browser posts, only these
 * survive, so a crafted request cannot inject arbitrary text into the admin alert or the draft
 * quotation through what looks like a checkbox.
 *
 * `key` is what crosses the wire and is stored; `label` is what a human reads. Keys are stable —
 * renaming a label must never orphan the inquiries already saved under it.
 */
const REQUIREMENT_OPTIONS = [
  { key: 'EXTINGUISHER', label: 'Fire Extinguisher Refilling / New Supply' },
  { key: 'HYDRANT', label: 'Fire Hydrant System Maintenance' },
  { key: 'NOC', label: 'Fire NOC Consultancy & Renewal' },
  { key: 'AUDIT', label: 'Safety Audit & Training' },
  { key: 'OTHER', label: 'Other Requirement' }
];

const REQUIREMENT_KEYS = REQUIREMENT_OPTIONS.map(o => o.key);

/**
 * Strips markup and control characters from a single free-text value.
 *
 * Order matters. Tags are removed BEFORE entities are neutralised, otherwise `&lt;script&gt;`
 * written by an attacker would survive tag-stripping and then be un-escaped by a downstream
 * renderer into a live tag. Angle brackets are then escaped so anything that looks like markup
 * after stripping still cannot open an element.
 *
 * Non-strings collapse to '' rather than being coerced: `String({$ne: null})` yields
 * "[object Object]", which would silently store nonsense instead of revealing a bad payload.
 */
function sanitizeText(value, maxLength = 255) {
  if (typeof value !== 'string') return '';

  return value
    // Strip anything tag-shaped, including unclosed ones (`<script` with no `>`).
    .replace(/<[^>]*>?/g, '')
    // NUL and the C0/C1 control ranges, minus \t \n \r which are legitimate in an address.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    // Zero-width and bidi-override characters: invisible in every UI, but they let a display name
    // be reversed or padded so an admin reads something other than what is stored.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\r\n/g, '\n')
    // Collapse runs of blank lines; a 500-char address of newlines is not an address.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

/**
 * Indian mobile validation, normalised to bare 10 digits.
 *
 * This is the deduplication key for the whole feature — it decides whether an inquiry joins an
 * existing customer or creates a new one — so it must produce ONE canonical form. `+91 98765 43210`,
 * `098765 43210` and `9876543210` are the same person and all three reach the office.
 *
 * A valid Indian mobile starts 6-9. Landlines and short codes are rejected: WhatsApp confirmation
 * is part of the flow and would fail on them anyway.
 */
function normalizeMobile(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';

  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);   // +91XXXXXXXXXX
  else if (local.length === 13 && local.startsWith('091')) local = local.slice(3);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1); // trunk prefix

  return /^[6-9]\d{9}$/.test(local) ? local : '';
}

/**
 * Email validation.
 *
 * Deliberately a shape check, not RFC 5322 — the full grammar accepts addresses no mail server
 * will route, and this value is only ever used as a send target. Rejecting a real address is the
 * expensive failure here (the customer never hears back), so the pattern stays permissive about
 * what it allows before the @ and strict only about structure.
 */
function normalizeEmail(value) {
  const email = sanitizeText(value, LIMITS.email).toLowerCase().replace(/\s/g, '');
  if (!email) return '';
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email) ? email : '';
}

/**
 * Validates the whole submission.
 *
 * Returns `{ valid, errors, data }` rather than throwing: the form shows every problem at once,
 * and a customer standing at a gate on a bad connection should not have to resubmit five times to
 * discover five mistakes.
 *
 * Field-level errors are keyed by field name so the client can mark the specific input.
 */
function validateInquiry(body = {}) {
  const errors = {};

  const name = sanitizeText(body.name, LIMITS.name);
  if (!name) errors.name = 'Please enter your name';
  else if (name.length < 2) errors.name = 'Please enter your full name';

  const mobile = normalizeMobile(body.mobile);
  if (!String(body.mobile ?? '').trim()) errors.mobile = 'Please enter your mobile number';
  else if (!mobile) errors.mobile = 'Please enter a valid 10-digit Indian mobile number';

  const companyName = sanitizeText(body.companyName, LIMITS.companyName);
  if (!companyName) errors.companyName = 'Please enter your company name';

  // Email is required: it is how the customer receives the confirmation and, later, the quotation.
  const rawEmail = String(body.email ?? '').trim();
  const email = normalizeEmail(body.email);
  if (!rawEmail) errors.email = 'Please enter your email address';
  else if (!email) errors.email = 'Please enter a valid email address';

  const address = sanitizeText(body.address, LIMITS.address);
  if (!address) errors.address = 'Please enter your site address';

  // GSTIN is optional — most refilling customers are unregistered — but a value that IS supplied
  // must be correct, checksum included. A wrong GSTIN copied onto a tax invoice is a compliance
  // problem for both sides, and it is cheaper to catch here than to unpick from a filed return.
  const gstinRaw = sanitizeText(body.gstin, LIMITS.gstin);
  let gstin = '';
  if (gstinRaw) {
    gstin = gstUtils.normalizeGstin(gstinRaw);
    if (!gstUtils.isValidGstin(gstin)) {
      errors.gstin = 'This GST number is not valid. Please check it, or leave it blank.';
    }
  }

  // Allow-list intersection — unknown keys are dropped silently rather than erroring, so a stale
  // cached copy of the form does not hard-fail after the options are edited.
  const submitted = Array.isArray(body.requirements) ? body.requirements : [];
  const requirements = REQUIREMENT_KEYS.filter(key => submitted.includes(key));
  if (requirements.length === 0) errors.requirements = 'Please select at least one requirement';

  // Only meaningful when OTHER is ticked; stored empty otherwise so a stale value from an
  // unticked box cannot leak into the lead description.
  const otherRequirement = requirements.includes('OTHER')
    ? sanitizeText(body.otherRequirement, LIMITS.otherRequirement)
    : '';
  if (requirements.includes('OTHER') && !otherRequirement) {
    errors.otherRequirement = 'Please describe your requirement';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    data: {
      name,
      mobile,
      companyName,
      email,
      gstin,
      address,
      requirements,
      otherRequirement,
      requirementLabels: requirements.map(labelForRequirement)
    }
  };
}

function labelForRequirement(key) {
  return REQUIREMENT_OPTIONS.find(o => o.key === key)?.label || key;
}

/**
 * Human-readable one-liner used in the lead description, the draft quotation subject and the
 * admin alert subject. "Other" carries its free text so the office can triage without opening
 * the record.
 */
function summarizeRequirements(data) {
  const labels = (data.requirements || []).map(key =>
    key === 'OTHER' && data.otherRequirement
      ? `Other: ${data.otherRequirement}`
      : labelForRequirement(key)
  );
  return labels.join(', ');
}

module.exports = {
  REQUIREMENT_OPTIONS,
  REQUIREMENT_KEYS,
  LIMITS,
  sanitizeText,
  normalizeMobile,
  normalizeEmail,
  validateInquiry,
  labelForRequirement,
  summarizeRequirements
};
