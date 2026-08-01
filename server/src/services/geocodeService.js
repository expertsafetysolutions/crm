/**
 * Reverse geocoding — turns "22.307200, 73.181200" into "Sarabhai Road, Vadodara" for the Admin.
 *
 * Free OpenStreetMap Nominatim, no API key and no billing account, so the feature works the day it
 * ships. It is a CONVENIENCE, never a dependency: the coordinates and the Google Maps link already
 * tell an Admin everything they need, and an address is only there to save them a tap.
 *
 * Consequently nothing here ever throws and nothing here is ever awaited on a punch. Follows the
 * same fail-open discipline as captchaService: a third-party outage must never turn into a staff
 * member being unable to record their attendance.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

// Nominatim's usage policy REQUIRES an identifying User-Agent naming a contactable address. A
// generic one gets the deployment's IP blocked outright.
const USER_AGENT = 'ExpertSafetyCRM/1.0 (expertsafetysolution@gmail.com)';

// Four decimal places ≈ 11 m. Staff punch from the same few spots every day, so this collapses a
// month of lookups into a handful. Bounded so a long-running process cannot grow it without limit.
const CACHE_MAX = 500;
const cache = new Map();

// Nominatim asks for at most ~1 request/second. Rather than sleep — this runs inside a serverless
// invocation that is frozen the moment it responds, so a sleep would burn billed time and might
// never resume — a call that would breach the interval is simply SKIPPED. An address is optional;
// being rate-limited into a ban is not worth one.
const MIN_INTERVAL_MS = 1100;
let lastCallAt = 0;

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Map preserves insertion order, so the first key is the oldest.
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

/**
 * @returns {Promise<{addressText: string, source: 'NOMINATIM'|'CACHE'|'UNAVAILABLE'}>}
 *          addressText is '' whenever anything at all went wrong.
 */
async function lookupAddress(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { addressText: '', source: 'UNAVAILABLE' };
  }

  const key = cacheKey(lat, lng);
  if (cache.has(key)) {
    return { addressText: cache.get(key), source: 'CACHE' };
  }

  const since = Date.now() - lastCallAt;
  if (since < MIN_INTERVAL_MS) {
    return { addressText: '', source: 'UNAVAILABLE' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    lastCallAt = Date.now();
    const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=0`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) return { addressText: '', source: 'UNAVAILABLE' };

    const data = await res.json();
    const addressText = String(data?.display_name || '').trim();
    if (!addressText) return { addressText: '', source: 'UNAVAILABLE' };

    remember(key, addressText);
    return { addressText, source: 'NOMINATIM' };
  } catch (e) {
    // Timeout, DNS failure, malformed JSON — all the same answer. Logged at debug level only
    // because a punch already succeeded by the time this runs and there is nothing to action.
    return { addressText: '', source: 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Address for a stored "lat, lng" string. Convenience wrapper so callers holding the raw column
 * value do not each repeat the parse.
 */
async function lookupFromLatLong(latLong) {
  const { parseLatLong } = require('../utils/geoFence');
  const point = parseLatLong(latLong);
  if (!point) return { addressText: '', source: 'UNAVAILABLE' };
  return lookupAddress(point.lat, point.lng);
}

module.exports = { lookupAddress, lookupFromLatLong };
