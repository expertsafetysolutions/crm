/**
 * High-Accuracy GPS Acquisition Helper
 * Ensures real GPS coordinates with strict accuracy verification and zero caching.
 */

export async function getAccurateGpsPosition({ timeout = 15000, maxAccuracy = 150 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject({
        code: 'NOT_SUPPORTED',
        message: '⚠️ Geolocation is not supported by this browser or device.'
      });
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const accuracy = pos.coords.accuracy || 9999;
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;

        // If accuracy is worse than maxAccuracy (e.g. > 150 meters, indicating cell tower or IP approximate fallback)
        if (accuracy > maxAccuracy) {
          return reject({
            code: 'LOW_ACCURACY',
            accuracy: Math.round(accuracy),
            message: `⚠️ GPS accuracy is low (${Math.round(accuracy)} meters - approximate signal). Please turn on High-Accuracy GPS / Location on your mobile and step near a window/open sky.`
          });
        }

        resolve({
          latitude: Number(lat.toFixed(6)),
          longitude: Number(lng.toFixed(6)),
          accuracy: Math.round(accuracy),
          formatted: `${lat.toFixed(6)}, ${lng.toFixed(6)}`
        });
      },
      (err) => {
        let msg = 'Failed to fetch GPS coordinates.';
        let code = 'UNKNOWN_ERROR';

        if (err.code === 1) { // PERMISSION_DENIED
          code = 'PERMISSION_DENIED';
          msg = '🚫 Location permission denied! Please allow location access for this website in your browser settings and turn on mobile GPS.';
        } else if (err.code === 2) { // POSITION_UNAVAILABLE
          code = 'POSITION_UNAVAILABLE';
          msg = '📍 GPS signal unavailable or turned OFF! Please turn on High-Accuracy GPS / Location services on your mobile device and try again.';
        } else if (err.code === 3) { // TIMEOUT
          code = 'TIMEOUT';
          msg = '⏱️ GPS location request timed out! Please ensure your mobile GPS / Location is turned ON and try again.';
        }

        reject({
          code,
          originalError: err,
          message: msg
        });
      },
      {
        enableHighAccuracy: true,
        timeout: timeout,
        maximumAge: 0 // Zero cache, force fresh GPS satellite poll
      }
    );
  });
}
