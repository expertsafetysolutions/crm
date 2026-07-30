/**
 * Merges duplicate Equipment_Master rows.
 *
 * Safe to run against the live database: it only ever touches Equipment_Master. Issued certificates
 * copy itemName/capacity into their own itemsList as plain strings and never store a master ID
 * (verified across all 110 certificates), so removing a master row cannot change what any already
 * issued certificate says or prints.
 *
 * Names are compared with punctuation and spacing flattened, because the live data contains
 * "Stored Pressure ABC" and "Stored Pressure - ABC" — the same product typed two ways. Exact-string
 * matching would leave those as separate items and the duplicate would come straight back.
 *
 *   node tests/dedupeItemMaster.js          # dry run — prints the plan, writes nothing
 *   node tests/dedupeItemMaster.js --apply  # performs the merge
 */
require('dotenv').config();
const sheetsService = require('../src/services/sheetsService');

const APPLY = process.argv.includes('--apply');

// Known misspellings that must fold into the correct name. "Carbod Dioxide" is a real typo sitting
// in the live data (it even reached a printed certificate) — left alone it stays a second CO2 item
// forever, and half the cylinders get their validity from the wrong row.
const SPELLING_FIXES = [
  [/\bcarbod\b/g, 'carbon'],
  [/\bpressire\b/g, 'pressure']
];

/**
 * Trailing parentheticals that merely abbreviate the name before them, so "Carbon Dioxide (CO2)"
 * and "Mechanical Foam (M.Foam)" fold into their bare forms.
 *
 * An explicit list rather than a cleverer rule. The tempting heuristic — "strip the brackets when
 * the contents look like an acronym of the preceding words" — cannot separate "Water Type (SP)"
 * from "Water Type (Cartridge)", which are two genuinely different extinguishers, and a wrong guess
 * here silently merges two products into one. Every entry below was checked against the live list;
 * add to it deliberately.
 */
const RESTATING_SUFFIXES = new Set(['co2', 'mfoam', 'm foam', 'dcp', 'abc', 'afff']);

const stripRestatingSuffix = (n) => String(n || '').replace(/\s*\(([^)]*)\)\s*$/, (full, inner) => {
  const key = String(inner).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return RESTATING_SUFFIXES.has(key) || RESTATING_SUFFIXES.has(key.replace(/\s/g, '')) ? '' : full;
});

// "Stored Pressure - ABC" and "Stored Pressure ABC" must collapse to one key.
const normalizeName = (n) => {
  let s = stripRestatingSuffix(String(n || '').trim())
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of SPELLING_FIXES) s = s.replace(re, to);
  return s;
};

// "01 Kg" and "1 Kg" are the same capacity; "9 kg" and "9 Kg" differ only in case. Compared on a
// normalised key so the merged list does not keep both, but the better-formatted original is what
// gets written back.
// Also drops the abbreviation period, so "9 Ltr." and "9 Ltr" are one capacity rather than two
// entries that both show up in the picker.
const capKey = (c) => String(c || '')
  .trim()
  .toLowerCase()
  .replace(/\./g, '')
  .replace(/\s+/g, '')
  .replace(/^0+(\d)/, '$1');

// "5 KKg" is a typo that would otherwise be preserved as a real capacity and offered in the picker.
// A capacity must be a number followed by a known unit; anything else is dropped from the merge.
const isValidCap = (c) => /^\d+(\.\d+)?\s*(kg|ltr|l|litre|liter|mtr|meter|m)\b/i.test(String(c || '').trim());

// "7kg" -> "7 Kg", "22.5 kg" -> "22.5 Kg". Applied to whichever spelling wins, so a capacity that
// exists in only one (badly typed) form still comes out formatted like the rest of the list.
const tidyCap = (c) => String(c || '').trim()
  .replace(/^0+(\d)/, '$1')
  .replace(/^(\d+(?:\.\d+)?)\s*(kg|ltr|l|litre|liter|mtr|meter|m)\b/i,
    (_, n, u) => `${n} ${u.toLowerCase() === 'l' ? 'Ltr' : u[0].toUpperCase() + u.slice(1).toLowerCase()}`);

const prettierCap = (a, b) => {
  // Prefer "6 Kg" over "6kg" (has a space), "1 Kg" over "01 Kg" (no leading zero), "9 Kg" over
  // "9 kg" (capitalised unit).
  const score = (c) => {
    const t = String(c).trim();
    return (/\d\s+\D/.test(t) ? 4 : 0) + (/^0\d/.test(t) ? 0 : 2) + (/\b(Kg|Ltr|Mtr)\b/.test(t) ? 1 : 0);
  };
  return score(b) > score(a) ? b : a;
};

(async () => {
  const raw = await sheetsService.getEquipmentMaster() || [];
  const items = raw.map(i => (i.toObject ? i.toObject() : i));

  // How often each exact name appears on an issued certificate — the tie-breaker for which spelling
  // to keep. The name the office has actually been printing wins over an unused variant.
  const certs = await sheetsService.getTab('Document_Registry') || [];
  const usage = {};
  for (const c0 of certs) {
    const c = c0.toObject ? c0.toObject() : c0;
    for (const it of (c.itemsList || [])) {
      const n = String(it.itemName || '').trim();
      if (n) usage[n] = (usage[n] || 0) + 1;
    }
  }

  const groups = {};
  for (const it of items) {
    const key = normalizeName(it.type || it.itemName);
    (groups[key] = groups[key] || []).push(it);
  }

  const dupeGroups = Object.values(groups).filter(g => g.length > 1);
  if (!dupeGroups.length) {
    console.log('No duplicate items found — nothing to do.');
    process.exit(0);
  }

  console.log(`${APPLY ? 'MERGING' : 'DRY RUN —'} ${dupeGroups.length} duplicate group(s)\n`);

  const plan = [];
  for (const group of dupeGroups) {
    // Keeper: most-used name on real certificates, then most capacities, then oldest row (its id is
    // the one any external note or habit refers to).
    const ranked = [...group].sort((a, b) => {
      const ua = usage[String(a.type || a.itemName).trim()] || 0;
      const ub = usage[String(b.type || b.itemName).trim()] || 0;
      if (ub !== ua) return ub - ua;
      const ca = (a.capacities || []).length, cb = (b.capacities || []).length;
      if (cb !== ca) return cb - ca;
      return String(a.id).localeCompare(String(b.id));
    });
    const keeper = ranked[0];
    const losers = ranked.slice(1);

    // Union of every capacity across the group, keeping the best-formatted spelling of each.
    const merged = new Map();
    const droppedCaps = [];
    for (const it of ranked) {
      for (const cap of (it.capacities || [])) {
        const k = capKey(cap);
        if (!k) continue;
        if (!isValidCap(cap)) { droppedCaps.push(cap); continue; }
        merged.set(k, merged.has(k) ? prettierCap(merged.get(k), cap) : cap);
      }
    }
    const capacities = [...merged.values()].map(tidyCap).sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });

    // Validity: highest value anyone in the group carries, else the standard defaults. Never lower
    // than what was already configured — silently shortening a retest interval is the dangerous
    // direction.
    const maxOf = (field, dflt) => {
      const vals = ranked.map(i => Number(i[field])).filter(v => v > 0);
      return vals.length ? Math.max(...vals) : dflt;
    };
    const refillValidityYears = maxOf('refillValidityYears', 1);
    const hptValidityYears = maxOf('hptValidityYears', /co2|carbon|carbod|dioxide/i.test(keeper.type || '') && !/water/i.test(keeper.type || '') ? 5 : 3);

    // If the surviving row is the misspelled one, correct its name. A sibling with the right
    // spelling is preferred as the source so the fix uses a name the office actually typed.
    const keeperName = String(keeper.type || keeper.itemName || '');
    const misspelled = SPELLING_FIXES.some(([re]) => re.test(keeperName.toLowerCase()));
    let keeperRename = null;
    if (misspelled) {
      const correct = ranked.find(i => !SPELLING_FIXES.some(([re]) => re.test(String(i.type || '').toLowerCase())));
      keeperRename = correct
        ? String(correct.type)
        : SPELLING_FIXES.reduce((s, [re, to]) => s.replace(new RegExp(re.source, 'gi'), m => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to)), keeperName);
    }

    plan.push({ keeper, losers, capacities, refillValidityYears, hptValidityYears, keeperRename });

    if (keeperRename) console.log(`RENAME "${keeper.type}" -> "${keeperRename}"  (spelling fix)`);
    console.log(`KEEP  "${keeperRename || keeper.type}"  (${keeper.id})`);
    console.log(`      used on ${usage[String(keeper.type).trim()] || 0} certificate row(s)`);
    console.log(`      capacities -> ${capacities.join(', ')}`);
    if (droppedCaps.length) console.log(`      dropped malformed capacity: ${[...new Set(droppedCaps)].join(', ')}`);
    console.log(`      refill ${refillValidityYears}y | hpt ${hptValidityYears}y`);
    for (const l of losers) {
      console.log(`  DEL "${l.type}"  (${l.id})  [${(l.capacities || []).join(', ')}]`);
    }
    console.log('');
  }

  const delCount = plan.reduce((n, p) => n + p.losers.length, 0);
  console.log(`${plan.length} item(s) kept and updated, ${delCount} duplicate row(s) removed.`);
  console.log('Issued certificates are untouched — they store item names as text, not master IDs.\n');

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to perform the merge.');
    process.exit(0);
  }

  for (const p of plan) {
    const patch = {
      capacities: p.capacities,
      refillValidityYears: p.refillValidityYears,
      hptValidityYears: p.hptValidityYears
    };
    // Only when the winning row itself carries the misspelling — the correctly spelled variant is
    // normally the keeper, in which case its name is already right and must not be rewritten.
    if (p.keeperRename) patch.type = p.keeperRename;
    await sheetsService.updateRow('Equipment_Master', 'id', p.keeper.id, patch);
    for (const l of p.losers) {
      await sheetsService.deleteRow('Equipment_Master', 'id', l.id);
    }
  }

  console.log('✅ Merge complete.');
  process.exit(0);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
