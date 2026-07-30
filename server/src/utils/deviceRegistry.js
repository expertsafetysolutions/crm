/**
 * Remembers which browsers a staff member has already signed in from.
 *
 * ── WHAT A "DEVICE" ACTUALLY IS HERE ─────────────────────────────────────────────────────────
 * A random id the client generates once and keeps in localStorage. It identifies a BROWSER
 * PROFILE, not hardware: clearing site data, using a private window, or switching browsers all
 * look like a new device and will each ask for a code once. That is honest behaviour for what it
 * is, and the UI should say "device" only in the loose sense the user already means.
 *
 * It is not a security token and is not trusted as one. Knowing someone's device id gets you
 * nothing without their password — the id only decides whether the SECOND factor is demanded.
 *
 * ── WHY THE LIST LIVES ON Staff_Master ───────────────────────────────────────────────────────
 * Known_Devices is a small, bounded array written only at login, mirroring the existing
 * Push_Subscriptions field on the same document. Sessions are different and live in their own
 * collection: several can be created concurrently and updateRow only does $set, so an array would
 * lose writes — the same reasoning that keeps Job_Card_Item out of its header.
 *
 * ── EVERY DEVICE IS VERIFIED, INCLUDING THE FIRST ────────────────────────────────────────────
 * This started as "the first device on an account is free", so that turning the feature on could
 * not demand a code from everyone at once. The owner reviewed that and chose the stricter rule:
 * an account with no registered devices is still challenged, because the free-first-device rule
 * meant a stolen password worked from any browser until someone happened to log in once.
 *
 * That is only safe because two things were verified first: a real OTP email was delivered to the
 * administrator inbox, and scripts/reset-auth.js can clear every gate straight from Mongo with no
 * working login. Do not tighten this further without checking both still hold.
 */

const MAX_LABEL = 60;

/** Coarse, readable label for the device list. Not used for any decision. */
function describeDevice(userAgent = '') {
  const ua = String(userAgent);
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown';
  // Order matters: Edge and Opera both contain "Chrome", Chrome contains "Safari".
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\//i.test(ua) ? 'Opera'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${os}`.slice(0, MAX_LABEL);
}

function listDevices(staff) {
  return Array.isArray(staff?.Known_Devices) ? staff.Known_Devices : [];
}

function isKnownDevice(staff, deviceId) {
  if (!deviceId) return false;
  return listDevices(staff).some(d => d && d.id === deviceId);
}

/** True when this account has never registered a device — the free-enrolment case above. */
function hasNoDevices(staff) {
  return listDevices(staff).length === 0;
}

/**
 * How many devices this account may hold. Admin-settable per staff member; 2 by default so a
 * phone and a desk machine both work without anyone having to configure anything.
 */
function allowedCount(staff) {
  const raw = Number(staff?.Allowed_Device_Count);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.min(Math.floor(raw), 10);
}

/**
 * Returns the device list with `deviceId` added, evicting the least recently used entries when
 * the account is over its limit.
 *
 * Eviction is by Last_Seen_At — the device someone actually stopped using is the one that goes,
 * rather than the oldest-registered, which may well be their daily phone.
 */
function registerDevice(staff, deviceId, userAgent, ip) {
  const now = new Date().toISOString();
  const existing = listDevices(staff).filter(d => d && d.id);

  const found = existing.find(d => d.id === deviceId);
  if (found) {
    // Touch the timestamp so an active device is never the one evicted.
    return existing.map(d => (d.id === deviceId ? { ...d, lastSeenAt: now, ip: ip || d.ip } : d));
  }

  const entry = {
    id: deviceId,
    label: describeDevice(userAgent),
    ip: ip || '',
    firstSeenAt: now,
    lastSeenAt: now
  };

  const combined = [...existing, entry].sort(
    (a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
  );
  return combined.slice(0, allowedCount(staff));
}

/** Devices that would be dropped by registering this one — reported so the event can be audited. */
function devicesEvictedBy(staff, deviceId, userAgent, ip) {
  const before = listDevices(staff).map(d => d?.id).filter(Boolean);
  const after = registerDevice(staff, deviceId, userAgent, ip).map(d => d.id);
  return before.filter(id => !after.includes(id));
}

module.exports = {
  describeDevice,
  listDevices,
  isKnownDevice,
  hasNoDevices,
  allowedCount,
  registerDevice,
  devicesEvictedBy
};
