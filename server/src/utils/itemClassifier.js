/**
 * itemClassifier — decides what a catalogue item MEANS on a delivery challan.
 *
 * A challan built from a job card already knows: the technician ticked "refilling required" on a
 * specific cylinder, so buildChallanLines can state the service as fact. A MANUAL challan has no
 * such record — someone picked "Refilling of Fire Ext. ABC 06 Kg" out of the catalogue and that
 * name is the only evidence there is. This module reads that evidence.
 *
 * It matters because buildCertificatePrefill only sees lines carrying `Line_Type: 'SERVICE'` plus a
 * `Service_Type`. Without classification every manually-added line is inert `MANUAL` and the
 * certificate comes out empty — the feature's most likely silent failure.
 *
 * Pure by design: rows in, descriptor out, no database and no await. That is what lets the audit
 * script run it over all 1016 catalogue rows offline.
 *
 * The output is a PROPOSAL. Every line carries a `Service_Override` the user can set from the
 * builder, and an override always wins — see normalizeLine in challanService.
 */

const { normalizeCapacity } = require('./capacity');

/*
 * Token lists, shared with challanService.resolveItemForGroup rather than duplicated.
 *
 * That function maps the other direction (a service group -> the catalogue item that represents it).
 * If the two lists ever disagreed, an item classified here as "Refilling / ABC / 6 Kg" could fail to
 * resolve back to itself on the next price lookup. One source, one answer.
 */
const REFILL_TOKENS = ['refill', 'refilling', 'recharge'];
const HPT_TOKENS = ['hp test', 'hp testing', 'hydro', 'hydraulic', 'pressure test'];
const CO2_TOKENS = ['co2', 'carbon', 'dioxide'];
const ABC_TOKENS = ['abc', 'dcp', 'powder'];

// Mirrors challanService.SERVICE / LINE_TYPE. Kept as literals rather than importing them, because
// challanService imports THIS file — requiring it back would be circular.
const SERVICE_REFILLING = 'Refilling';
const SERVICE_HP_TESTING = 'HP Testing';
const LINE_TYPE_SERVICE = 'SERVICE';
const LINE_TYPE_MANUAL = 'MANUAL';

/** The values a line's Service_Override may take. 'SUPPLY' means "deliberately not certifiable". */
const OVERRIDE_SUPPLY = 'SUPPLY';

const hasToken = (text, tokens) => {
  const s = String(text || '').toLowerCase();
  return tokens.some(t => s.includes(t));
};

/**
 * Pulls a capacity out of a full item name — "Refilling of Fire Ext. ABC 06 Kg" -> "6 Kg".
 *
 * normalizeCapacity is anchored with ^, so it canonicalises a bare "06 Kg" but cannot find one
 * inside a sentence. This is the missing half.
 *
 * The unit is REQUIRED for the same reason nameHasCapacity requires it: a bare digit scan matches
 * the 2 in "Co2" and would turn a CO2 refill into a 2 Kg one. Returns '' for the genuinely generic
 * catalogue rows ("HP Testing - ABC"), which carry no size at all — 15 of the 82 service items.
 */
function extractCapacity(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(kg|kgs|ltr|litre|liter)\b/i);
  return m ? normalizeCapacity(`${m[1]} ${m[2]}`) : '';
}

/**
 * ABC vs CO2 from a name or category.
 *
 * Returns '' rather than defaulting to ABC. buildChallanLines can default (line 246) because a
 * job-card row always has a physical cylinder behind it; a manual line may be a generic service
 * with no family at all, and a wrong 'ABC' would print on the customer's certificate.
 */
function detectEquipmentType(...texts) {
  const joined = texts.filter(Boolean).join(' ');
  if (hasToken(joined, CO2_TOKENS)) return 'CO2';
  if (hasToken(joined, ABC_TOKENS)) return 'ABC';
  return '';
}

/*
 * "hydro"/"hydraulic" alone is not enough to call something a hydro TEST.
 *
 * resolveItemForGroup can afford the bare token because it has already been told the group is an
 * HP Testing one — it is only picking between candidates. Classifying from scratch, the same token
 * swallows "Hydrolic Binding-Hose Pipe (Single Side)", a physical hose in the accessories catalogue,
 * and would print it on a customer's hydro-test certificate.
 *
 * So the loose tokens must sit near the word "test"; the explicit "hp test" forms stand alone.
 */
const HPT_EXPLICIT = ['hp test', 'hp testing', 'pressure test'];
const HPT_LOOSE = ['hydro', 'hydraulic'];

function isHpTestingName(text) {
  const s = String(text || '').toLowerCase();
  if (HPT_EXPLICIT.some(t => s.includes(t))) return true;
  return HPT_LOOSE.some(t => s.includes(t)) && /test/.test(s);
}

/**
 * Which service (if any) an item represents.
 *
 * NAME BEATS CATEGORY, deliberately. The live catalogue has ITEM262560376 "HP Testing of Co2 3 Kg"
 * filed under a *Refilling* category — one row today, but it proves the category is a bookkeeping
 * bucket that can be wrong, while the name is what a human reads and what the certificate prints.
 *
 * When a name carries both (there is a real "Refilling & HP Testing of Fire Extinguisher" row),
 * HP Testing wins: it is the statutorily-dated document with the longer validity, so a wrong
 * Refilling guess is the cheaper error to correct.
 */
function detectService(name, category) {
  const nameR = hasToken(name, REFILL_TOKENS);
  const nameH = isHpTestingName(name);
  if (nameH) return SERVICE_HP_TESTING;
  if (nameR) return SERVICE_REFILLING;

  // Category is the fallback for rows whose name alone gives nothing away.
  const catR = hasToken(category, REFILL_TOKENS);
  const catH = isHpTestingName(category);
  if (catH) return SERVICE_HP_TESTING;
  if (catR) return SERVICE_REFILLING;

  return '';
}

/**
 * What this catalogue item means on a challan line.
 *
 * Always returns the same four keys so a caller can spread the result unconditionally. A non-service
 * item (a bracket, a safety pin, a brand-new extinguisher being sold) comes back as MANUAL with the
 * rest blank — which is correct: supply is not certifiable unless a human says otherwise.
 */
function classifyItem(item) {
  const name = String(item?.Item_Name || '');
  const category = String(item?.Category || '');

  const serviceType = detectService(name, category);
  if (!serviceType) {
    return { Line_Type: LINE_TYPE_MANUAL, Service_Type: '', Equipment_Type: '', Capacity: '' };
  }

  return {
    Line_Type: LINE_TYPE_SERVICE,
    Service_Type: serviceType,
    Equipment_Type: detectEquipmentType(name, category),
    Capacity: extractCapacity(name)
  };
}

/**
 * Applies an explicit user choice, bypassing detection entirely.
 *
 * 'SUPPLY' is not the absence of a choice — it is a decision that this line must NOT appear on a
 * certificate, and it has to survive the next save. That is why an override is stored rather than
 * re-derived: otherwise the classifier would helpfully undo the correction on every edit.
 */
function applyServiceOverride(override, item) {
  if (override === OVERRIDE_SUPPLY) {
    return { Line_Type: LINE_TYPE_MANUAL, Service_Type: '', Equipment_Type: '', Capacity: '' };
  }
  const name = String(item?.Item_Name || '');
  return {
    Line_Type: LINE_TYPE_SERVICE,
    Service_Type: override,
    Equipment_Type: detectEquipmentType(name, item?.Category),
    Capacity: extractCapacity(name)
  };
}

module.exports = {
  classifyItem,
  applyServiceOverride,
  extractCapacity,
  detectEquipmentType,
  detectService,
  OVERRIDE_SUPPLY,
  REFILL_TOKENS,
  HPT_TOKENS,
  CO2_TOKENS,
  ABC_TOKENS
};
