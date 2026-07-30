/**
 * Date helpers for certificate validity.
 *
 * How many years to add is NOT decided here — it comes from the Item Master record
 * (`hptValidityYears` / `refillValidityYears`, edited in the Item Master panel on the certificate
 * page). A CO2 extinguisher is a seamless high-pressure gas cylinder retested every 5 years under
 * the Gas Cylinder Rules, while an ABC/DCP/foam/water body is a low-pressure vessel retested every
 * 3 years per IS 2190 — but that is stored per item rather than inferred from the typed name, so
 * there is exactly one place to look when a date comes out wrong.
 */

/** ISO yyyy-mm-dd `startDate` + n years, preserving the day. Returns '' on an unparseable date. */
export function addYearsIso(startDate, years) {
  if (!startDate) return '';
  const d = new Date(startDate);
  if (isNaN(d.getTime())) return '';
  d.setFullYear(d.getFullYear() + Number(years || 0));
  return d.toISOString().split('T')[0];
}

/**
 * The certificate-level Valid Until for a mixed list: the LAST date any item is due.
 *
 * Deliberately the maximum, not the minimum. Valid_Until is what the public QR page prints and what
 * the expiry check uses, so taking the earliest date would flip a certificate to "Expired" while
 * some of its cylinders were still certified — the exact mismatch that made a 2031-due CO2 read as
 * valid only to 2029. Per-cylinder truth stays in each item's own nextDate column.
 */
export function computeCertValidUntil(itemsList, fallbackDate) {
  const dates = (itemsList || [])
    .map(it => it && (it.nextDate || it.next_date))
    .filter(Boolean)
    .filter(d => !isNaN(new Date(d).getTime()));
  if (!dates.length) return fallbackDate || '';
  return dates.reduce((max, d) => (new Date(d) > new Date(max) ? d : max), dates[0]);
}
