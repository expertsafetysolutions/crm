/**
 * Burns GPS coordinates and a timestamp into a photograph's pixels.
 *
 * Deliberately not EXIF metadata: metadata is stripped the moment a photo is forwarded on WhatsApp,
 * emailed, or re-saved, which is exactly when a delivery photo needs to still prove where and when
 * it was taken. Drawn onto the canvas, the stamp survives every one of those.
 *
 * The band is drawn as a translucent strip along the bottom so it never obscures the subject, and
 * the font is sized from the image width so it stays legible on both a 640px and a 4000px capture.
 */

function formatCoord(value, positive, negative) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '';
  const n = Number(value);
  return `${Math.abs(n).toFixed(6)}° ${n >= 0 ? positive : negative}`;
}

/** IST timestamp, matching how the rest of the app records time. */
function istStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date).replace(',', '');
}

/**
 * Returns a JPEG data URL of the image with a location/time band drawn on it.
 * Falls back to the original image if anything goes wrong — a delivery photo without a stamp is
 * far better than no photo at all.
 */
export async function watermarkWithLocation(dataUrl, { lat, lng, accuracy, label, capturedAt } = {}) {
  try {
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const lines = [];
    if (label) lines.push(label);
    const coords = [formatCoord(lat, 'N', 'S'), formatCoord(lng, 'E', 'W')].filter(Boolean).join('  ');
    if (coords) lines.push(coords + (accuracy ? `  (±${Math.round(accuracy)}m)` : ''));
    lines.push(istStamp(capturedAt ? new Date(capturedAt) : new Date()) + ' IST');

    // Scale everything off the image width so the stamp reads the same on any camera resolution.
    const pad = Math.max(8, Math.round(canvas.width * 0.015));
    const fontSize = Math.max(12, Math.round(canvas.width * 0.028));
    const lineHeight = Math.round(fontSize * 1.35);
    const bandHeight = lines.length * lineHeight + pad * 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, canvas.height - bandHeight, canvas.width, bandHeight);

    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, canvas.height - bandHeight + pad + i * lineHeight);
    });

    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return dataUrl;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
