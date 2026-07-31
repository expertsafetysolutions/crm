/**
 * Capacity normalisation — "6kg", "6 KG", "06 Kg", "6.0 Kg" all become "6 Kg".
 *
 * Not optional. The capacity field is free text, so the same product reaches the challan under
 * several spellings; without this the grouping emits three lines where the paper challan has one,
 * which is the most likely real-world failure of the whole feature. Applied on write in
 * jobCardService and again when grouping, so legacy rows normalise too.
 *
 * Lives in utils/ rather than jobCardService because itemClassifier needs it and a util requiring a
 * service (which requires the data layer) is backwards. jobCardService re-exports it, so every
 * existing caller is unaffected — and the client keeps its own mirror in utils/jobCardSchema.js,
 * which MUST agree with this exactly or the offline preview groups differently.
 */
function normalizeCapacity(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^([\d.]+)\s*(kg|ltr|l|litre|liter)?/i);
  if (!m) return s;
  const unit = (m[2] || 'kg').toLowerCase();
  const label = unit.startsWith('l') ? 'Ltr' : 'Kg';
  return `${parseFloat(m[1])} ${label}`;
}

module.exports = { normalizeCapacity };
