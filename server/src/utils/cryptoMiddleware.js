/**
 * Transparent encrypt-on-write / decrypt-on-read for the data layer.
 *
 * Applied inside sheetsService's four chokepoints (getTab, insertRow, updateRow, and the
 * single-document getters), so every existing route keeps working unchanged. Nothing above the
 * data layer needs to know encryption exists — which is the only realistic way to retrofit this
 * onto ~4200 lines of routes without rewriting them.
 *
 * ── THE CACHE HAZARD ─────────────────────────────────────────────────────────────────────────
 * CLAUDE.md warns that `getTab` returns the cached array BY REFERENCE with a 3s TTL, which is why
 * moneyMask builds new objects instead of deleting keys in place. Decryption has exactly the same
 * hazard in reverse: decrypting rows in place would write plaintext back into the shared cache,
 * and a later caller would then try to decrypt an already-decrypted value.
 *
 * Worse, `decryptRows` runs BEFORE the cache is populated in getTab, so mutating in place would
 * poison the cache for every subsequent reader within the TTL. These functions therefore always
 * return NEW objects and never touch the input — same discipline as moneyMask.maskValue().
 */

const { encryptValue, decryptValue, blindIndex, isEncryptionEnabled } = require('./fieldCrypto');
const { fieldsFor, blindIndexFieldsFor } = require('./encryptedFields');

/** Suffix for the blind-index companion column, e.g. Contact → Contact_Idx. */
const INDEX_SUFFIX = '_Idx';

/**
 * Encrypts the protected fields of one row before it is written.
 *
 * Returns a new object. Fields absent from the payload are left absent rather than being written
 * as empty — updateRow does a `$set`, so materialising a missing key would wipe a stored value
 * that the caller never intended to touch.
 */
function encryptRow(collection, row) {
  const fields = fieldsFor(collection);
  if (!fields || !row || typeof row !== 'object' || !isEncryptionEnabled()) return row;

  const out = { ...row };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(out, field)) {
      out[field] = encryptValue(out[field]);
    }
  }

  // Blind index written alongside, from the PLAINTEXT value, before it was encrypted above.
  const indexed = blindIndexFieldsFor(collection);
  if (indexed) {
    for (const field of indexed) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        const digest = blindIndex(row[field]);
        if (digest) out[`${field}${INDEX_SUFFIX}`] = digest;
      }
    }
  }
  return out;
}

/** Decrypts one row on read. Returns a new object; the input is never mutated (see header). */
function decryptRow(collection, row) {
  const fields = fieldsFor(collection);
  if (!fields || !row || typeof row !== 'object') return row;

  let touched = false;
  const out = { ...row };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === 'string' && value.startsWith('enc:')) {
      out[field] = decryptValue(value);
      touched = true;
    }
  }
  // Returning the original when nothing was encrypted avoids allocating a copy of every row of
  // every unencrypted collection on every read — getTab runs constantly.
  return touched ? out : row;
}

function decryptRows(collection, rows) {
  if (!Array.isArray(rows) || !fieldsFor(collection)) return rows;
  return rows.map(r => decryptRow(collection, r));
}

/**
 * Builds a query that finds a row by an encrypted field's exact value.
 *
 * Uses the blind index when encryption is on, and falls back to a plain equality match when it is
 * off — so a caller works identically either way.
 */
function buildLookup(collection, field, value) {
  const indexed = blindIndexFieldsFor(collection);
  if (isEncryptionEnabled() && indexed && indexed.includes(field)) {
    const digest = blindIndex(value);
    if (digest) return { [`${field}${INDEX_SUFFIX}`]: digest };
  }
  return { [field]: value };
}

module.exports = { encryptRow, decryptRow, decryptRows, buildLookup, INDEX_SUFFIX };
