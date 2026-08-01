/**
 * Office geofence maths — pure functions only.
 *
 * Lives in utils/ and requires no service, the same rule that keeps normalizeCapacity out of
 * jobCardService: a util must be callable from anywhere without dragging Mongoose in behind it.
 *
 * Every coordinate in this system is stored as free text ("23.021624, 72.579707") because that is
 * what the original Sheets wrapper wrote and what Attendance_Log still holds. Nothing here assumes
 * a numeric column.
 */

// Mean Earth radius (IUGG). Haversine on a sphere is accurate to ~0.5% against the WGS-84
// ellipsoid, i.e. under a metre at the 100-300m radii this feature deals with — while GPS itself is
// good to 10-100m. A geodesy dependency would be measuring with a micrometer and cutting with an axe.
const EARTH_RADIUS_M = 6371008.8;

const toRad = deg => (deg * Math.PI) / 180;

/**
 * "23.021624, 72.579707" → { lat, lng }, or null when there is no usable fix.
 *
 * Returns null for exact zeros on purpose. '0.0000, 0.0000' is the explicit no-fix sentinel written
 * by attendanceService when the client sent nothing, and 0,0 is in the Gulf of Guinea — treating it
 * as a real position would compute a ~6,000 km distance and block someone whose GPS merely failed.
 */
function parseLatLong(value) {
  if (value === null || value === undefined) return null;

  // Tolerates "23.02, 72.57", "23.02,72.57", and stray parens/whitespace from hand-entered rows.
  const parts = String(value).replace(/[()]/g, '').split(',');
  if (parts.length !== 2) return null;

  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;

  return { lat, lng };
}

/** Great-circle distance in metres between two {lat, lng} points. */
function haversineMetres(a, b) {
  if (!a || !b) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * True only when the fence is switched on AND actually usable.
 *
 * Both halves matter: an Admin who flips the toggle without saving coordinates must leave the fence
 * INACTIVE rather than blocking everyone, and a settings row that has never been written at all
 * (the state on first deploy) must read as off.
 */
function isFenceConfigured(settings) {
  if (!settings || settings.Geofence_Enabled !== true) return false;
  const office = officePoint(settings);
  return Boolean(office) && Number(settings.Office_Radius_M) > 0;
}

/** The configured office as a {lat, lng}, or null when it has never been set. */
function officePoint(settings) {
  if (!settings) return null;
  const lat = Number(settings.Office_Latitude);
  const lng = Number(settings.Office_Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * The whole inside/outside decision, in one place so the punch routes never re-derive it.
 *
 * Accuracy grace is the part that makes this usable in practice. GPS is worst indoors, which is
 * exactly where punch-in happens: a phone at a desk inside the building can report itself 200m away.
 * Deciding on raw distance alone would block real staff standing in the office, which is the failure
 * that gets a feature switched off in a week.
 *
 * So the fix's own error radius is forgiven — if the person could plausibly be inside given how
 * uncertain their fix is, they are treated as inside. This deliberately biases toward false ALLOWS
 * over false BLOCKS: a wrong allow is recorded with its distance and stays visible in the attendance
 * table forever, while a wrong block stops someone starting work. The record is the control, not the
 * block.
 *
 * The grace is capped (Max_Accuracy_Grace_M) because accuracy is self-reported: without a cap a
 * client claiming ±99999m would be forgiven everything.
 */
function evaluateFence({ latLong, accuracyM, settings }) {
  if (!isFenceConfigured(settings)) {
    return { enabled: false, inside: true, distanceM: null, reason: 'DISABLED' };
  }

  const point = parseLatLong(latLong);
  if (!point) {
    return { enabled: true, inside: false, distanceM: null, reason: 'NO_FIX' };
  }

  const office = officePoint(settings);
  const radiusM = Number(settings.Office_Radius_M);
  const distanceM = haversineMetres(office, point);

  const accuracy = Number(accuracyM);
  const graceAllowed = settings.Accuracy_Grace !== false;
  const maxGrace = Number(settings.Max_Accuracy_Grace_M);
  // A missing accuracy earns no grace — an old client that never sent the field must not be
  // rewarded for the omission.
  const graceApplied = graceAllowed && Number.isFinite(accuracy) && accuracy > 0
    ? Math.min(accuracy, Number.isFinite(maxGrace) ? maxGrace : 150)
    : 0;

  const effectiveDistanceM = Math.max(0, distanceM - graceApplied);
  const inside = effectiveDistanceM <= radiusM;

  return {
    enabled: true,
    inside,
    distanceM,
    effectiveDistanceM,
    graceApplied,
    radiusM,
    accuracyM: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    reason: inside ? (graceApplied > 0 && distanceM > radiusM ? 'INSIDE_BY_GRACE' : 'INSIDE') : 'OUTSIDE'
  };
}

/**
 * Google Maps link for a stored "lat, lng" string.
 * Uses maps.google.com/?q= — the exact form already used by the attendance table and activity log,
 * so these links look and behave like the ones beside them.
 */
function mapsLink(latLong) {
  const point = parseLatLong(latLong);
  if (!point) return '';
  return `https://maps.google.com/?q=${point.lat},${point.lng}`;
}

module.exports = {
  parseLatLong,
  haversineMetres,
  isFenceConfigured,
  officePoint,
  evaluateFence,
  mapsLink
};
