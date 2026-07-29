/**
 * HTML escaping for the server-rendered public pages.
 *
 * Almost the whole app is React, which escapes for us — this exists for the handful of pages that
 * are built as template strings and sent with res.send(): the certificate verification results,
 * the "revoked" notice and the "expired" renewal page in server.js. Those are public and
 * unauthenticated, so their input is the least trustworthy in the system.
 *
 * Two distinct sources need escaping there and both are hostile until proven otherwise:
 *   - `req.params.guid`, typed straight into the URL by anyone
 *   - stored fields (Customer_Name, Certificate_No, Format_Type) which are staff free-text and
 *     could carry markup from a CSV import that nobody eyeballed
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

/**
 * Escapes a value for interpolation into HTML *text* or a quoted attribute.
 *
 * Backtick is escaped alongside the usual five because these pages are built from template
 * literals and older IE treats a backtick as an attribute delimiter.
 *
 * Non-strings are coerced rather than rejected: callers interpolate optional stored fields that
 * may be undefined, and `undefined` printing as an empty string is what the pages already expect.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, ch => HTML_ENTITIES[ch]);
}

module.exports = { escapeHtml };
