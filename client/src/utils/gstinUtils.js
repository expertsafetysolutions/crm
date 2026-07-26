/**
 * Client-side GSTIN validation — mirrors server/src/utils/gstUtils.js so the form can validate
 * instantly as the user types, with no network round-trip and no paid API.
 *
 * What this gives you for free:
 *  - a mistyped GSTIN is caught immediately (the 15th character is a mod-36 check digit)
 *  - state is auto-filled from the leading 2 digits
 *  - B2B/B2C and entity type are inferred from the embedded PAN
 *
 * What it cannot do: fetch the company's legal name and address. That data lives only on the GST
 * portal, which has no free public API — it needs a paid provider (Masters India, Signzy, Cashfree
 * etc.). Name and address therefore stay manual entry for now.
 */

export const GST_STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

const PAN_ENTITY_TYPES = {
  C: 'Company', P: 'Individual / Proprietor', H: 'Hindu Undivided Family (HUF)',
  F: 'Partnership Firm / LLP', A: 'Association of Persons', T: 'Trust',
  B: 'Body of Individuals', L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government'
};

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normalizeGstin(gstin) {
  return String(gstin || '').replace(/\s/g, '').toUpperCase();
}

/** Mod-36 check digit over the first 14 characters, Luhn-style alternating weights. */
export function hasValidChecksum(gstin) {
  const clean = normalizeGstin(gstin);
  if (clean.length !== 15) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CODES.indexOf(clean[i]);
    if (value === -1) return false;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CODES[(36 - (sum % 36)) % 36] === clean[14];
}

export function extractStateCode(gstin) {
  const clean = normalizeGstin(gstin);
  if (clean.length < 2) return '';
  const code = clean.slice(0, 2);
  return /^[0-9]{2}$/.test(code) ? code : '';
}

export function getStateName(stateCode) {
  return GST_STATE_CODES[String(stateCode || '').padStart(2, '0')] || '';
}

/** Full offline verdict for a (possibly partial) GSTIN. Never throws. */
export function parseGstin(gstin) {
  const clean = normalizeGstin(gstin);
  const out = {
    gstin: clean, complete: clean.length === 15, formatValid: false, checksumValid: false,
    valid: false, stateCode: '', stateName: '', pan: '', entityType: '',
    registrationType: '', error: ''
  };
  if (!clean) return out;

  out.stateCode = extractStateCode(clean);
  out.stateName = getStateName(out.stateCode);

  if (out.stateCode && !out.stateName) {
    out.error = `Unknown state code "${out.stateCode}"`;
    return out;
  }
  if (!out.complete) {
    out.error = `${clean.length}/15 characters`;
    return out;
  }

  out.formatValid = GSTIN_REGEX.test(clean);
  if (!out.formatValid) {
    out.error = 'Invalid format';
    return out;
  }

  out.pan = clean.slice(2, 12);
  out.entityType = PAN_ENTITY_TYPES[clean[5]] || '';
  out.registrationType = clean[13] === 'Z' ? 'Regular' : `Special (${clean[13]})`;
  out.checksumValid = hasValidChecksum(clean);

  if (!out.checksumValid) {
    out.error = 'Check digit mismatch — please re-check the GSTIN';
    return out;
  }

  out.valid = true;
  return out;
}

/** Sorted list for state dropdowns. */
export function stateOptions() {
  return Object.entries(GST_STATE_CODES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
