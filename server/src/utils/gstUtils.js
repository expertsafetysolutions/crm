/**
 * GST helpers for the quotation/PI/invoice pipeline.
 *
 * A GSTIN is 15 chars: 2-digit state code + 10-char PAN + entity digit + 'Z' + checksum.
 * Only the leading state code matters for deciding intra- vs inter-state tax, so parsing is
 * deliberately lenient — a malformed-but-present GSTIN still yields a usable state code rather
 * than blocking a quotation.
 */

const GST_STATE_CODES = {
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

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// PAN's 4th character encodes the entity type; surfaced so the UI can pre-fill B2B/B2C and hint
// at the kind of organisation without any external lookup.
const PAN_ENTITY_TYPES = {
  C: 'Company',
  P: 'Individual / Proprietor',
  H: 'Hindu Undivided Family (HUF)',
  F: 'Partnership Firm / LLP',
  A: 'Association of Persons',
  T: 'Trust',
  B: 'Body of Individuals',
  L: 'Local Authority',
  J: 'Artificial Juridical Person',
  G: 'Government'
};

function normalizeGstin(gstin) {
  return String(gstin || '').replace(/\s/g, '').toUpperCase();
}

function isValidGstin(gstin) {
  return GSTIN_REGEX.test(normalizeGstin(gstin)) && hasValidChecksum(normalizeGstin(gstin));
}

/**
 * Validates the GSTIN's 15th character, which is a mod-36 check digit over the first 14.
 *
 * Each character maps to its value in base-36 (0-9 then A-Z). Values at alternating positions are
 * doubled, and each product is folded (quotient + remainder) before summing — the same weighting
 * scheme as the Luhn algorithm. The check digit is whatever makes the total a multiple of 36.
 *
 * This is what lets us reject a mistyped GSTIN offline: a single wrong character almost always
 * breaks the checksum, so typos are caught before they ever reach an invoice.
 */
function hasValidChecksum(gstin) {
  const clean = normalizeGstin(gstin);
  if (clean.length !== 15) return false;

  const CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;

  for (let i = 0; i < 14; i++) {
    const value = CODES.indexOf(clean[i]);
    if (value === -1) return false;
    // Positions are 1-indexed in the spec; every second position is weighted x2.
    const factor = (i % 2 === 0) ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }

  const expected = (36 - (sum % 36)) % 36;
  return CODES[expected] === clean[14];
}

/**
 * Everything that can be derived from a GSTIN without any external API call.
 *
 * Returns a structured verdict the UI can act on: whether the number is well-formed, which state
 * it belongs to, the embedded PAN, and the entity type. Deliberately never throws — a
 * half-typed GSTIN just comes back as incomplete.
 */
function parseGstin(gstin) {
  const clean = normalizeGstin(gstin);
  const result = {
    gstin: clean,
    length: clean.length,
    complete: clean.length === 15,
    formatValid: false,
    checksumValid: false,
    valid: false,
    stateCode: '',
    stateName: '',
    pan: '',
    entityType: '',
    entityTypeCode: '',
    registrationType: '',
    errors: []
  };

  if (!clean) {
    result.errors.push('GSTIN is empty');
    return result;
  }

  result.stateCode = extractStateCode(clean);
  result.stateName = getStateName(result.stateCode);
  if (result.stateCode && !result.stateName) {
    result.errors.push(`Unknown state code "${result.stateCode}"`);
  }

  if (!result.complete) {
    result.errors.push(`GSTIN must be 15 characters (currently ${clean.length})`);
    return result;
  }

  result.formatValid = GSTIN_REGEX.test(clean);
  if (!result.formatValid) {
    result.errors.push('Format is invalid — expected 2 digits, 5 letters, 4 digits, 1 letter, 1 alphanumeric, "Z", then 1 alphanumeric');
  }

  result.pan = clean.slice(2, 12);
  result.entityTypeCode = clean[5] || '';
  result.entityType = PAN_ENTITY_TYPES[result.entityTypeCode] || '';

  // The 14th character is 'Z' for ordinary taxpayers; other letters denote special registrations.
  result.registrationType = clean[13] === 'Z' ? 'Regular' : `Special (${clean[13]})`;

  result.checksumValid = hasValidChecksum(clean);
  if (result.formatValid && !result.checksumValid) {
    result.errors.push('Check digit does not match — the GSTIN appears mistyped');
  }

  result.valid = result.formatValid && result.checksumValid && Boolean(result.stateName);
  return result;
}

/** Leading 2 digits of a GSTIN, or '' when absent/too short. */
function extractStateCode(gstin) {
  const clean = normalizeGstin(gstin);
  if (clean.length < 2) return '';
  const code = clean.slice(0, 2);
  return /^[0-9]{2}$/.test(code) ? code : '';
}

function getStateName(stateCode) {
  return GST_STATE_CODES[String(stateCode || '').padStart(2, '0')] || '';
}

/**
 * Decides the tax split for a document.
 *
 * B2C/unregistered buyers have no GSTIN, so the caller supplies an explicit destination state
 * code instead; the intra/inter test is otherwise identical (place of supply vs seller state).
 * Falls back to CGST+SGST when the buyer's state cannot be determined at all, since an
 * unresolvable place of supply is treated as local rather than silently applying IGST.
 */
function determineGstType(sellerStateCode, buyerStateCode, customerType) {
  const seller = String(sellerStateCode || '').padStart(2, '0');
  const buyer = String(buyerStateCode || '').padStart(2, '0');

  if (!buyer || buyer === '00') {
    return { gstType: 'CGST_SGST', isInterState: false, resolved: false };
  }
  const isInterState = seller !== buyer;
  return {
    gstType: isInterState ? 'IGST' : 'CGST_SGST',
    isInterState,
    resolved: true,
    customerType: customerType || 'B2B'
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Computes one line item's taxable value and tax split.
 *
 * Line discount is applied before tax (discount reduces the taxable value), and an optional
 * pre-apportioned share of a document-level discount is subtracted as well so document discounts
 * also correctly reduce GST rather than being deducted after tax.
 */
function computeLineItem(line, gstType, apportionedDocDiscount = 0) {
  const qty = Number(line.Qty) || 0;
  const rate = Number(line.Rate) || 0;
  const gross = round2(qty * rate);

  const discountPct = Number(line.Discount_Pct) || 0;
  let discountAmt = Number(line.Discount_Amt) || 0;
  if (discountPct > 0) {
    discountAmt = round2(gross * (discountPct / 100));
  }

  const taxableValue = round2(Math.max(0, gross - discountAmt - (Number(apportionedDocDiscount) || 0)));
  const gstRate = Number(line.GST_Rate) || 0;
  const totalTax = round2(taxableValue * (gstRate / 100));

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (gstType === 'IGST') {
    igst = totalTax;
  } else {
    cgst = round2(totalTax / 2);
    // Assign the remainder to SGST so cgst + sgst always equals totalTax exactly, even when
    // half a paisa would otherwise be lost to double-rounding.
    sgst = round2(totalTax - cgst);
  }

  // `...line` first preserves presentational fields the caller attached (Item_Name, HSN_Code,
  // Photo_URL, Long_Description) so they survive pricing and reach the PDF unchanged.
  return {
    ...line,
    Qty: qty,
    Rate: rate,
    Gross_Value: gross,
    Discount_Pct: discountPct,
    Discount_Amt: discountAmt,
    Apportioned_Doc_Discount: round2(Number(apportionedDocDiscount) || 0),
    Taxable_Value: taxableValue,
    GST_Rate: gstRate,
    CGST_Amt: cgst,
    SGST_Amt: sgst,
    IGST_Amt: igst,
    Line_Total: round2(taxableValue + totalTax)
  };
}

/**
 * Computes a full document total from raw line items.
 *
 * A document-level discount is apportioned across lines in proportion to their post-line-discount
 * value, so it reduces each line's taxable value (and therefore its GST) correctly instead of
 * being a post-tax deduction. The last line absorbs any rounding remainder so the apportioned
 * parts always sum exactly to the requested document discount.
 */
function computeDocumentTotals({ lineItems, gstType, documentDiscountPct = 0, documentDiscountAmt = 0 }) {
  const rawLines = Array.isArray(lineItems) ? lineItems : [];

  const preDiscountValues = rawLines.map(l => {
    const gross = round2((Number(l.Qty) || 0) * (Number(l.Rate) || 0));
    const pct = Number(l.Discount_Pct) || 0;
    const amt = pct > 0 ? round2(gross * (pct / 100)) : (Number(l.Discount_Amt) || 0);
    return round2(Math.max(0, gross - amt));
  });
  const preDiscountTotal = round2(preDiscountValues.reduce((s, v) => s + v, 0));

  let docDiscount = Number(documentDiscountAmt) || 0;
  const docPct = Number(documentDiscountPct) || 0;
  if (docPct > 0) {
    docDiscount = round2(preDiscountTotal * (docPct / 100));
  }
  docDiscount = round2(Math.min(docDiscount, preDiscountTotal));

  const shares = [];
  let allocated = 0;
  for (let i = 0; i < rawLines.length; i++) {
    if (i === rawLines.length - 1) {
      shares.push(round2(docDiscount - allocated));
    } else {
      const share = preDiscountTotal > 0
        ? round2(docDiscount * (preDiscountValues[i] / preDiscountTotal))
        : 0;
      shares.push(share);
      allocated = round2(allocated + share);
    }
  }

  const computedLines = rawLines.map((l, i) => computeLineItem(l, gstType, shares[i] || 0));

  const subtotal = round2(computedLines.reduce((s, l) => s + l.Taxable_Value, 0));
  const totalCgst = round2(computedLines.reduce((s, l) => s + l.CGST_Amt, 0));
  const totalSgst = round2(computedLines.reduce((s, l) => s + l.SGST_Amt, 0));
  const totalIgst = round2(computedLines.reduce((s, l) => s + l.IGST_Amt, 0));
  const totalGst = round2(totalCgst + totalSgst + totalIgst);

  return {
    lineItems: computedLines,
    Gross_Total: round2(computedLines.reduce((s, l) => s + l.Gross_Value, 0)),
    Line_Discount_Total: round2(computedLines.reduce((s, l) => s + l.Discount_Amt, 0)),
    Document_Level_Discount_Pct: docPct,
    Document_Level_Discount_Amt: docDiscount,
    Subtotal: subtotal,
    Total_CGST: totalCgst,
    Total_SGST: totalSgst,
    Total_IGST: totalIgst,
    Total_GST: totalGst,
    Grand_Total: round2(subtotal + totalGst)
  };
}

/**
 * Effective discount percentage across the whole document, used to test the approval threshold.
 * Expressed against gross value so a 10% line discount plus a 5% document discount reads as the
 * combined ~14.5% a manager would actually be approving.
 */
function effectiveDiscountPct(totals) {
  const gross = Number(totals.Gross_Total) || 0;
  if (gross <= 0) return 0;
  const totalDiscount = (Number(totals.Line_Discount_Total) || 0) + (Number(totals.Document_Level_Discount_Amt) || 0);
  return round2((totalDiscount / gross) * 100);
}

module.exports = {
  GST_STATE_CODES,
  PAN_ENTITY_TYPES,
  normalizeGstin,
  isValidGstin,
  hasValidChecksum,
  parseGstin,
  extractStateCode,
  getStateName,
  determineGstType,
  computeLineItem,
  computeDocumentTotals,
  effectiveDiscountPct,
  round2
};
