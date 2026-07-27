/**
 * Shared html2canvas + jsPDF export pipeline.
 *
 * Extracted from CertificateGeneratorPage's handleDownloadPDF so the quotation/PI/invoice modules
 * reuse the same battle-tested behaviour. Two non-obvious details are preserved deliberately:
 *
 *  - the `onclone` hook force-reloads any <img> that hasn't decoded yet, because html2canvas
 *    otherwise rasterises them as blanks;
 *  - long documents are exported as one tall canvas sliced across pages by shifting the image's
 *    y-offset, rather than laying out per-page.
 *
 * html2canvas and jspdf are imported lazily (~590KB combined) so pages that never export a PDF
 * don't pay for them.
 */

const PAGE_SIZES = {
  a4: { portrait: { w: 210, h: 297 }, landscape: { w: 297, h: 210 } }
};

/** Renders a DOM node to a JPEG data URL at print resolution. */
export async function renderElementToCanvas(element, options = {}) {
  if (!element) throw new Error('No element supplied to render');
  const { default: html2canvas } = await import('html2canvas');

  // Capture exactly the element's own box.
  //
  // html2canvas defaults its capture window to the browser viewport and positions the element
  // within it. For a source parked off-screen (the PDF template sits at left:-10000px) that meant
  // the sheet could be laid out against a window far wider than itself: the 794px page was drawn
  // into a ~1400px canvas, leaving dead space to the right of the content, and when the off-screen
  // offset fell outside the assumed window the capture came back zero-width — the "generated PDF
  // was empty" failure. Pinning width/height/window* to the element's measured size makes the
  // canvas exactly the sheet, so the content is centred and the capture can never be clipped.
  const rect = element.getBoundingClientRect();
  const width = Math.ceil(options.width || rect.width || element.offsetWidth);
  const height = Math.ceil(options.height || rect.height || element.offsetHeight);

  if (!width || !height) {
    throw new Error('The document layout has no size yet — try again in a moment.');
  }

  return html2canvas(element, {
    scale: options.scale || 2,
    useCORS: true,
    allowTaint: false,
    backgroundColor: options.backgroundColor || '#ffffff',
    width,
    height,
    windowWidth: width,
    windowHeight: height,
    // Neutralise the element's own page offset; without this the off-screen -10000px left position
    // is treated as a scroll offset and the drawn content lands outside the canvas.
    x: 0,
    y: 0,
    scrollX: 0,
    scrollY: 0,
    onclone: async (clonedDoc) => {
      // Images that haven't finished decoding render blank in the captured canvas, so each one is
      // re-kicked and awaited before capture.
      const images = Array.from(clonedDoc.querySelectorAll('img'));
      await Promise.all(
        images.map(async (img) => {
          img.crossOrigin = 'anonymous';
          if (!img.complete || img.naturalWidth === 0) {
            await new Promise((resolve) => {
              img.onload = img.onerror = resolve;
              const src = img.src;
              img.src = '';
              img.src = src;
            });
          }
          try { await img.decode(); } catch (e) { /* decode is best-effort */ }
        })
      );
      await new Promise(r => setTimeout(r, 250));
      if (typeof options.onclone === 'function') await options.onclone(clonedDoc);
    }
  });
}

/**
 * Builds a jsPDF document from an element, paginating tall content across pages.
 * Returns the jsPDF instance so callers can save, upload, or both.
 */
export async function generatePdfFromElement(element, options = {}) {
  const orientation = options.orientation || 'portrait';
  const format = options.format || 'a4';
  const { w: pdfWidth, h: pdfHeight } = PAGE_SIZES[format][orientation];

  const canvas = await renderElementToCanvas(element, options);
  // A zero-dimension canvas yields a data URI that jsPDF silently accepts, producing a blank page.
  // Fail loudly here instead, so the caller can report a real reason rather than emailing an empty
  // attachment.
  if (!canvas.width || !canvas.height) {
    throw new Error('The document could not be rendered (empty capture).');
  }
  const imgData = canvas.toDataURL('image/jpeg', options.quality || 0.98);

  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF(orientation, 'mm', format);
  const imgHeight = (canvas.height * pdfWidth) / canvas.width;

  // A source element already sized to exactly one page (see QuotationPdfTemplate's PageFrame) can
  // still measure a hair over after rounding at scale 2; treat anything within ~2mm as single-page
  // so it is drawn to the page box rather than spilling a sliver onto a blank second sheet.
  if (imgHeight <= pdfHeight + 2) {
    pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(imgHeight, pdfHeight));
  } else {
    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, imgHeight);
    heightLeft -= pdfHeight;

    while (heightLeft > 1) {
      position -= pdfHeight;
      pdf.addPage(format, orientation);
      pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, imgHeight);
      heightLeft -= pdfHeight;
    }
  }

  return pdf;
}

/** Renders and downloads in one step. */
export async function downloadPdfFromElement(element, fileName, options = {}) {
  const pdf = await generatePdfFromElement(element, options);
  pdf.save(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
  return pdf;
}

/**
 * Fetches an image URL as a base64 data URI.
 *
 * html2canvas can't reliably rasterise cross-origin images even with useCORS, so branding assets
 * are inlined before capture. Returns '' on failure so a missing logo degrades to no logo rather
 * than breaking the whole export.
 */
export async function fetchAsBase64(url) {
  if (!url) return '';
  try {
    const res = await fetch(url);
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result || '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return '';
  }
}

/** Sanitises a string for use in a download filename. */
export function safeFileName(...parts) {
  return parts
    .filter(Boolean)
    .join('-')
    .replace(/[^\w\-. ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}
