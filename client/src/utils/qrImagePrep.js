/**
 * Prepares a scanned/photographed payment QR for print.
 *
 * A stored QR artwork is typically ~800px square and gets drawn into a ~90px box on the A4 sheet,
 * which html2canvas then rasterises and jsPDF re-encodes as JPEG. Each of those steps blurs a QR in
 * its own way: the ~9x downscale smears black modules into grey, and JPEG rings around the hard
 * black/white edges. The result looks fine on screen and fails to scan off paper.
 *
 * Three passes fix it:
 *
 *   1. CROP to the code itself. Payment artwork usually carries a logo and a caption around the
 *      code; at print size those are illegible anyway and they steal roughly a third of the box.
 *      Detected by ink density per row/column — QR rows run 30-50% dark while text and logo rows sit
 *      near 5% — so nothing has to be hard-coded about a particular image.
 *   2. THRESHOLD every pixel to pure black or pure white. Grey is what actually breaks scanning, and
 *      pure values also survive JPEG far better than gradients.
 *   3. Emit PNG at the resolution the page will actually print, so the browser never soft-scales it.
 *
 * Every stage falls back to the original image if anything looks wrong — a slightly soft QR beats no
 * QR at all.
 */

const cache = new Map();

const DARK_CUTOFF = 128;        // luma below this counts as ink
const DENSITY_CUTOFF = 0.15;    // a row/column this inky is part of the code, not the caption
const MIN_SIDE_RATIO = 0.35;    // a detected region smaller than this is a bad read — discard it

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

/**
 * Bounding box of the dense region, ignoring sparse decoration.
 * Exported for testing; operates on a plain {data,width,height} so it needs no DOM.
 */
export function findCodeBounds(imageData) {
  const { data, width, height } = imageData;

  const rowInk = new Array(height).fill(0);
  const colInk = new Array(width).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Rec. 601 luma; good enough to separate ink from paper and cheap per pixel.
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma < DARK_CUTOFF) { rowInk[y]++; colInk[x]++; }
    }
  }

  const span = (ink, extent) => {
    let start = 0;
    let end = extent - 1;
    while (start < extent && ink[start] / extent < DENSITY_CUTOFF) start++;
    while (end > start && ink[end] / extent < DENSITY_CUTOFF) end--;
    return { start, end };
  };

  const rows = span(rowInk, width);
  const cols = span(colInk, height);

  const w = cols.end - cols.start + 1;
  const h = rows.end - rows.start + 1;

  // A detection that collapsed, or that found almost nothing, means the heuristic misread the
  // artwork — fall back to the whole image rather than cropping into noise.
  if (w < width * MIN_SIDE_RATIO || h < height * MIN_SIDE_RATIO) {
    return { x: 0, y: 0, width, height, detected: false };
  }
  return { x: cols.start, y: rows.start, width: w, height: h, detected: true };
}

/** Squares off a box around its centre, so the code keeps its aspect ratio when redrawn. */
export function squareBounds(box, imageWidth, imageHeight) {
  const side = Math.max(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    x: Math.max(0, Math.min(imageWidth - side, Math.round(cx - side / 2))),
    y: Math.max(0, Math.min(imageHeight - side, Math.round(cy - side / 2))),
    side: Math.min(side, imageWidth, imageHeight)
  };
}

/**
 * Returns a PNG data URL of the code, cropped, hard-thresholded and rendered at `targetPx`.
 * Resolves to the original `src` if the image cannot be processed.
 */
export async function prepareCrispQr(src, targetPx = 512, { quietZone = 0.06 } = {}) {
  const key = `${src}@${targetPx}`;
  if (cache.has(key)) return cache.get(key);

  const work = (async () => {
    try {
      const img = await loadImage(src);
      const sw = img.naturalWidth || img.width;
      const sh = img.naturalHeight || img.height;
      if (!sw || !sh) return src;

      const probe = document.createElement('canvas');
      probe.width = sw;
      probe.height = sh;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(img, 0, 0);

      let box;
      try {
        box = squareBounds(findCodeBounds(pctx.getImageData(0, 0, sw, sh)), sw, sh);
      } catch {
        // A tainted canvas (cross-origin without CORS) blocks getImageData; keep the whole image.
        box = { x: 0, y: 0, side: Math.min(sw, sh) };
      }

      // A QR is unreadable without its quiet zone, and cropping to the ink removes it.
      const margin = Math.round(targetPx * quietZone);
      const inner = targetPx - margin * 2;

      const out = document.createElement('canvas');
      out.width = targetPx;
      out.height = targetPx;
      const octx = out.getContext('2d', { willReadFrequently: true });
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, targetPx, targetPx);
      // Smooth on the way down: nearest-neighbour would drop whole modules at these ratios, and the
      // threshold pass below removes the grey that smoothing introduces.
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(img, box.x, box.y, box.side, box.side, margin, margin, inner, inner);

      try {
        const px = octx.getImageData(0, 0, targetPx, targetPx);
        const d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const v = luma < DARK_CUTOFF ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
        octx.putImageData(px, 0, 0);
      } catch {
        // Thresholding is the polish, not the point — a cropped, correctly sized QR still prints.
      }

      return out.toDataURL('image/png');
    } catch {
      return src;
    }
  })();

  cache.set(key, work);
  return work;
}
