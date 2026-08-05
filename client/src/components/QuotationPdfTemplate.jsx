import React, { useRef, useLayoutEffect, useEffect, useState, useImperativeHandle } from 'react';
import { formatMoney, formatDate, amountInWords, isUpiDeepLink, extractUpiVpa } from '../utils/quotationUtils';
import { prepareCrispQr } from '../utils/qrImagePrep';

/**
 * Print/PDF layout for a quotation, proforma invoice or sales invoice.
 *
 * Layout follows the Certificate module — full-width header logo, 8%-opacity centre watermark,
 * 80x80 stamp slot above the signature line, footer image — so every document the company issues
 * looks like one family. Orientation is A4 PORTRAIT (794x1123 at 96dpi) rather than the
 * certificate's landscape, because tax invoices are conventionally portrait and long item lists
 * paginate better that way.
 *
 * Colour comes from the EXPERT logo (red on black) instead of the certificate's amber: red is
 * reserved for the three moments that identify the document — page border, title band, grand total
 * — with everything structural in black/grey. Restricting the accent that way keeps the sheet
 * readable when printed in mono and stops the page competing with the logo itself.
 *
 * html2canvas constraints preserved from the certificate implementation:
 *  - fixed-aspect boxes with max-width/max-height instead of CSS object-fit, which html2canvas
 *    ignores (a round seal would otherwise be stretched into an ellipse);
 *  - explicit px sizing rather than relative units, so the capture matches the on-screen preview.
 *  - brand colours are inline style objects, not Tailwind classes: these exact hexes are not in the
 *    palette, and html2canvas resolves computed styles either way.
 *
 * PAGINATION
 * The document is genuinely multi-page, not a single tall sheet shrunk to fit. Header, page
 * border, watermarks, footer artwork and the "Page X of Y" mark repeat on every sheet; the
 * signature block prints once, on the last sheet only, because a multi-page invoice is signed
 * once, not per page. Only the line-items table splits across sheets — everything else is either
 * page-1-only (parties/subject) or last-page-only (totals/T&C/notes).
 *
 * `MultiPagePdf` measures the real, unscaled height of the head block, the tail block and every
 * row in an invisible pass, then packs rows into pages so the tallest packed page still fits
 * CONTENT_HEIGHT after a *mild* shrink (down to MIN_SHRINK) — never the old 0.55 floor that made
 * dense sheets illegible. A page only overflows into a new sheet once even MIN_SHRINK can't make
 * it fit.
 */

const A4_PORTRAIT_WIDTH = 794;   // 210mm @ 96dpi
const A4_PORTRAIT_HEIGHT = 1123; // 297mm @ 96dpi

// 96dpi ÷ 25.4mm — used to express the page margin and border weight in real millimetres.
const PX_PER_MM = 96 / 25.4;

// White margin between the sheet edge and the printed border, equal on all four sides. Applied on
// the fixed-size outer sheet (not the scaled inner block) so it stays constant even when a page's
// content is scaled down to fit, and so the border can never be clipped by the page edge.
const PAGE_MARGIN_PX = Math.round(8 * PX_PER_MM);   // 8mm
const PAGE_BORDER_PX = Math.round(1 * PX_PER_MM);   // 1mm single solid rule

const CONTENT_WIDTH = A4_PORTRAIT_WIDTH - PAGE_MARGIN_PX * 2;
const CONTENT_HEIGHT = A4_PORTRAIT_HEIGHT - PAGE_MARGIN_PX * 2;

// The bordered, p-4-padded box drawn INSIDE the CONTENT_WIDTH/CONTENT_HEIGHT sheet (see PageSheet)
// eats further into both dimensions: Tailwind's p-4 is 16px per side, plus PAGE_BORDER_PX per side.
// Pagination must budget against these true INNER dimensions, not the outer CONTENT_* constants —
// budgeting against the wider/taller outer box measures rows against more space than they'll
// actually render in, under-shrinking pages and clipping content against the border.
const INNER_PADDING_PX = 16; // Tailwind p-4
const INNER_CONTENT_WIDTH = CONTENT_WIDTH - (INNER_PADDING_PX + PAGE_BORDER_PX) * 2;
const INNER_CONTENT_HEIGHT = CONTENT_HEIGHT - (INNER_PADDING_PX + PAGE_BORDER_PX) * 2;

// A page is allowed to shrink this far to soak up a small overflow (e.g. one row that would
// otherwise spill 20px onto a near-empty second sheet). Below this the text stops being legible,
// so the packer spills the remainder to a new page instead of shrinking further.
const MIN_SHRINK = 0.85;

// Slack added to PageSheet's per-page overflow:hidden clip, on top of naturalHeight*scale. The
// clip height comes from the same off-screen measurement pass that feeds paginateRows, but that
// pass and the real on-page render are separate DOM subtrees — a few px of drift between them
// (sub-pixel rounding, a border, a font metric) is normal and paginateRows already budgets for it
// via SAFETY_MARGIN_PX. This constant is the same idea applied to the clip itself: without it, an
// under-measured tail has its own last few px sliced off here even though the packer left room to
// spare, which is how the signature name/title under the stamp — the last element in `tail` — was
// found silently clipped while the stamp box above it rendered fine.
const CLIP_SAFETY_PX = 40;

// Sampled from assets/header_logo.png — the EXPERT wordmark's red and its black keyline.
const BRAND_RED = '#E01B24';      // page border, title band, grand total
const BRAND_RED_DARK = '#A3111A'; // small red text, where pure red would vibrate
const BRAND_INK = '#111827';      // table header fill and emphasised labels
const BRAND_HEAD_BG = '#F1F5F9';  // section-header fill (Bill To / Details / Bank)

/**
 * Anti-copy watermark: the company name repeated in small diagonal lettering across the entire
 * sheet, so a screenshot of ANY region of the document still carries the name and cannot be passed
 * off to another vendor.
 *
 * Each row is ONE continuous rotated strip whose text repeats along its full length, rather than a
 * grid of separate word tiles. Separate tiles leave visible blank gaps wherever a short word sits
 * in a wide cell; a continuous strip keeps the lettering unbroken end to end. Repeats within a
 * strip are separated by SEPARATOR (three spaces) so each occurrence still reads as its own phrase.
 *
 * Plain absolutely-positioned text is used rather than an SVG <pattern> or a
 * repeating-linear-gradient: html2canvas rasterises both of those inconsistently (patterns often
 * drop out of the capture entirely), whereas text always survives.
 *
 * Strips are sized to the page DIAGONAL and the band is over-sized and re-centred, so a 45°
 * rotation still covers all four corners. Everything sits inside a fixed-size, overflow-hidden A4
 * box, so the rotation is clipped to the page rather than expanding it. Deliberately drawn ABOVE
 * the page content (but non-interactive and very low opacity) — a watermark sitting under an
 * opaque table cell would be invisible exactly where a screenshot is most likely to be cropped.
 */
const SEPARATOR = '   ';

function SecurityWatermark({ config = {}, width, height }) {
  const text = String(config.text || '').trim();
  if (!text) return null;

  const gapY = Number(config.gap_y_px) || 74;
  const fontSize = Number(config.font_size_px) || 9;
  const angle = config.angle_deg !== undefined ? Number(config.angle_deg) : -45;
  const opacity = config.opacity !== undefined ? Number(config.opacity) : 0.07;

  // The rotated band must cover the page diagonal in both directions, else the corners fall
  // outside it once rotated.
  const diagonal = Math.ceil(Math.sqrt(width * width + height * height));
  const rows = Math.ceil(diagonal / gapY) + 2;

  // Enough repeats to fill a full diagonal-length line at this font size. ~0.62em average glyph
  // advance for bold sans text is a deliberate over-estimate, so the line always overruns rather
  // than stopping short and reintroducing a gap.
  const unit = text + SEPARATOR;
  const perLine = Math.ceil(diagonal / (unit.length * fontSize * 0.62)) + 2;
  const line = unit.repeat(Math.max(perLine, 2));

  const strips = [];
  for (let r = 0; r < rows; r++) {
    strips.push(
      <div
        key={r}
        style={{
          position: 'absolute',
          left: 0,
          top: `${r * gapY}px`,
          width: `${diagonal}px`,
          fontSize: `${fontSize}px`,
          fontWeight: 700,
          color: BRAND_INK,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          letterSpacing: '0.06em',
          // Alternate rows start half a phrase in, so repeats don't line up into vertical columns.
          textIndent: r % 2 ? `${unit.length * fontSize * 0.31}px` : 0
        }}
      >
        {line}
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        userSelect: 'none',
        opacity,
        zIndex: 5
      }}
    >
      {/* Square band of side = diagonal, centred on the page, then rotated about its own centre.
          Sizing it to the diagonal is what guarantees full coverage at any angle. */}
      <div
        style={{
          position: 'absolute',
          width: `${diagonal}px`,
          height: `${diagonal}px`,
          left: `${(width - diagonal) / 2}px`,
          top: `${(height - diagonal) / 2}px`,
          transform: `rotate(${angle}deg)`,
          transformOrigin: 'center center'
        }}
      >
        {strips}
      </div>
    </div>
  );
}

// Print size of the payment QR. At the previous 80px — with the artwork's logo and caption eating a
// third of the box — the code printed ~15mm, about 0.34mm per module, under the ~0.4mm a phone
// camera needs off paper. Cropping to the code and widening to 96px puts it near 0.56mm.
const QR_BOX_PX = 96;
// Rasterise well above the printed size: html2canvas captures at 2x and jsPDF re-encodes, so
// starting from a generous bitmap keeps the module edges hard through both steps.
const QR_SOURCE_PX = 512;

/**
 * Resolves the payment QR to a cropped, hard-thresholded PNG.
 *
 * Returns the raw src immediately and swaps in the prepared version when it is ready, so a capture
 * triggered before preparation finishes still prints a working (if softer) code rather than a gap.
 */
function useCrispQr(src) {
  const [prepared, setPrepared] = useState(src);

  useEffect(() => {
    let cancelled = false;
    setPrepared(src);
    if (!src) return undefined;
    prepareCrispQr(src, QR_SOURCE_PX)
      .then(result => { if (!cancelled) setPrepared(result); })
      .catch(() => { /* the raw image is already in place */ });
    return () => { cancelled = true; };
  }, [src]);

  return prepared;
}

const DOC_TITLES = {
  QUOTATION: 'QUOTATION',
  PI: 'PROFORMA INVOICE',
  INVOICE: 'TAX INVOICE',
  CHALLAN: 'DELIVERY CHALLAN',
  PO: 'PURCHASE ORDER'
};

/**
 * One fixed A4 sheet: border, background watermarks, the page's own scaled content block, then a
 * spacer that pushes the (always full-size, unscaled) footer to the sheet's bottom edge — matching
 * a printed letterhead, where the footer sits flush with the page edge regardless of how little
 * content precedes it.
 *
 * `scale` is applied ONLY to `children` (never to the border/watermark/page-number/footer chrome),
 * and children's own box is given a fixed px width of CONTENT_WIDTH/scale — NOT a percentage —
 * so that after the transform shrinks it visually, it nets back to exactly CONTENT_WIDTH, the same
 * width `paginateRows` measured against. A percentage width here would measure against the
 * flex-column parent instead and silently grow past the packer's budget, clipping rows under
 * overflow:hidden — the earlier bug this replaced.
 */
function PageSheet({ pageIndex, pageCount, security, seller, overlay, branding, scale, naturalHeight, footer, children }) {
  return (
    <div
      style={{
        width: `${A4_PORTRAIT_WIDTH}px`,
        height: `${A4_PORTRAIT_HEIGHT}px`,
        overflow: 'hidden',
        backgroundColor: '#ffffff',
        padding: `${PAGE_MARGIN_PX}px`,
        boxSizing: 'border-box',
        isolation: 'isolate'
      }}
      className="text-slate-900"
    >
      <div
        className="flex flex-col p-4 h-full bg-white relative"
        style={{
          boxSizing: 'border-box',
          border: `${PAGE_BORDER_PX}px solid ${BRAND_RED}`
        }}
      >
        {overlay.show_watermark !== false && (
          <img
            src={branding.watermark || '/assets/Watermark Logo.jpg'}
            onError={e => { e.target.onerror = null; e.target.src = '/assets/watermark-logo.jpg'; }}
            alt=""
            aria-hidden="true"
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[82%] object-contain pointer-events-none select-none"
            style={{ opacity: 0.06, zIndex: 0 }}
          />
        )}

        {security.enabled !== false && (
          <SecurityWatermark
            config={{ ...security, text: security.text || seller.legal_name || 'Expert Safety Solutions' }}
            width={CONTENT_WIDTH}
            height={CONTENT_HEIGHT}
          />
        )}

        {pageCount > 1 && (
          <div
            className="absolute text-[7.5px] font-bold text-slate-500"
            style={{ top: `${PAGE_BORDER_PX + 2}px`, right: `${PAGE_BORDER_PX + 6}px`, zIndex: 6 }}
          >
            Page {pageIndex + 1} of {pageCount}
          </div>
        )}

        {/* Clips the scaled child's pre-transform layout footprint (1/scale times as wide and tall
            as what's actually painted, since a CSS transform shrinks only the paint, not the box a
            flex parent reserves for it). Width is 100% of ITS parent — the bordered, p-4-padded
            box above — not the CONTENT_WIDTH constant: that constant only accounts for the outer
            sheet's PAGE_MARGIN_PX and knows nothing about this box's own border+padding, so reusing
            it here would size the clip wider than the space actually left inside the border,
            pushing the scaled child (and the border framing it) past the sheet edge. Explicit
            height of naturalHeight*scale — the TRUE painted height — rather than `auto`, which
            would still measure the unscaled naturalHeight and push the footer down too far.
            transformOrigin: top left means nothing paints past those bounds once scaled, so this
            clip never touches visible content — it only trims the invisible reserved footprint.

            CLIP_SAFETY_PX pads the clip itself (not the packer's budget): the invisible
            measurement pass and this real page are two separate DOM subtrees, so
            getBoundingClientRect can return a few px less there than the real render needs —
            sub-pixel rounding, a border added to one element, a font metric settling differently.
            paginateRows already has its own SAFETY_MARGIN_PX so pages don't overflow the sheet,
            but that budget slack does nothing for THIS box: naturalHeight came out of that same
            measurement pass, so an under-measured tail clips its own last few px here even though
            the page had room to spare. That is exactly why the signature name/title under the
            stamp — the last thing in `tail` — was found silently sliced off by this
            overflow:hidden while the stamp box above it rendered fine. */}
        <div className="relative" style={{ zIndex: 1, width: '100%', height: `${naturalHeight * scale + CLIP_SAFETY_PX}px`, overflow: 'hidden' }}>
          <div
            className="flex flex-col"
            style={{
              width: `${100 / scale}%`,
              transform: scale < 1 ? `scale(${scale})` : undefined,
              transformOrigin: 'top left'
            }}
          >
            {children}
          </div>
        </div>

        {/* Absorbs leftover height so the footer sits at the bottom of the sheet, exactly like a
            printed letterhead — a 3-item quotation and a 30-item one both end flush with the page
            edge. Lives OUTSIDE the scaled block: growing inside a scale(0.86) box would itself be
            shrunk, undershooting the real gap needed. */}
        <div className="grow relative" style={{ minHeight: '8px', zIndex: 1 }} aria-hidden="true" />
        <div className="shrink-0 relative" style={{ zIndex: 1 }}>{footer}</div>
      </div>
    </div>
  );
}

/**
 * Splits `rows` (array of {key, height}) into pages so that, per page:
 *   headHeight (page 1 only) + Σ rowHeights + tailHeight (last page only) + footerHeight <= CONTENT_HEIGHT / shrink
 * A mild shrink (down to MIN_SHRINK) is tried before spilling a row to the next page, so a row
 * that overflows by a few px doesn't strand itself alone on a near-empty extra sheet.
 *
 * Greedy first-fit: this is a print layout, not a bin-packing optimisation problem — rows are
 * fixed order (line 1 must precede line 2), so the only choice at each step is "does the next row
 * fit on the current page," which greedy answers correctly.
 */
function paginateRows(rows, { headHeight, tailHeight, footerHeight }) {
  if (!rows.length) {
    return [{ rows: [], scale: 1, naturalHeight: headHeight + tailHeight }];
  }

  // A few px of slack: the invisible measurement pass and the real per-page render are two
  // separate DOM subtrees, and getBoundingClientRect can return fractionally different values
  // between them (sub-pixel rounding). Packing to the exact budget with no margin let a page's
  // computed scale be a hair too generous, clipping the last row against the footer.
  const SAFETY_MARGIN_PX = 6;
  const budget = INNER_CONTENT_HEIGHT - footerHeight - SAFETY_MARGIN_PX;
  const pages = [];
  let current = [];
  let currentHeight = 0;

  const isFirstPage = () => pages.length === 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isLastRow = i === rows.length - 1;
    const head = isFirstPage() ? headHeight : 0;
    const tail = isLastRow ? tailHeight : 0;

    const proposedHeight = currentHeight + row.height;
    const naturalTotal = head + proposedHeight + tail;

    if (naturalTotal <= budget || current.length === 0) {
      // Always accept at least one row per page, even if it alone overflows (an oversized single
      // row — e.g. a huge photo — must still land somewhere rather than looping forever).
      current.push(row);
      currentHeight = proposedHeight;
      continue;
    }

    // Would overflow with this row added. Try a mild shrink of the page AS IT STANDS PLUS this
    // row before giving up and starting a new page — recovers the common case of a row that
    // misses the cutoff by a small margin.
    const shrunkWithRow = Math.max(budget / naturalTotal, 0);
    if (shrunkWithRow >= MIN_SHRINK) {
      current.push(row);
      currentHeight = proposedHeight;
      continue;
    }

    // Doesn't fit even at MIN_SHRINK: close the current page and start a new one with this row.
    const closedHead = isFirstPage() ? headHeight : 0;
    const closedTotal = closedHead + currentHeight;
    const closedScale = closedTotal > budget ? Math.max(budget / closedTotal, MIN_SHRINK) : 1;
    pages.push({ rows: current, scale: closedScale, naturalHeight: closedTotal });

    current = [row];
    currentHeight = row.height;
  }

  // Close the final page (always carries the tail).
  const finalHead = isFirstPage() ? headHeight : 0;
  const finalTotal = finalHead + currentHeight + tailHeight;
  const finalScale = finalTotal > budget ? Math.max(budget / finalTotal, MIN_SHRINK) : 1;
  pages.push({ rows: current, scale: finalScale, naturalHeight: finalTotal });

  return pages;
}

/**
 * Owns pagination end to end: measures `head`, `tail` and each row in an invisible pass (rendered
 * at natural size, off-screen, zero pointer-events), computes the split, then renders the real
 * paged sheets. `head` appears only on page 1, `tail` only on the last page; `renderRowsTable`
 * receives a page's row slice and must return a complete `<table>` (its own `<thead>` repeats the
 * column header on every page, matching normal document convention).
 *
 * The outer ref resolves to a container holding ALL page sheets stacked with no gap, each exactly
 * A4_PORTRAIT_HEIGHT tall — so pdfGenerator's slicer can cut at exact multiples of that height with
 * no chrome bleeding across a page boundary.
 */
const MultiPagePdf = React.forwardRef(({
  head, rows, tail, renderRowsTable, footer, pageChrome
}, ref) => {
  const outerRef = useRef(null);
  const headRef = useRef(null);
  const tailRef = useRef(null);
  const footerRef = useRef(null);
  const rowRefs = useRef([]);
  const [pages, setPages] = useState(null); // null = not yet measured

  useImperativeHandle(ref, () => outerRef.current);

  const rowsKey = rows.length; // re-measure whenever the row count changes; content edits re-key via `doc` upstream

  useLayoutEffect(() => {
    const measure = () => {
      const headHeight = headRef.current ? headRef.current.getBoundingClientRect().height : 0;
      const tailHeight = tailRef.current ? tailRef.current.getBoundingClientRect().height : 0;
      const footerHeight = footerRef.current ? footerRef.current.getBoundingClientRect().height : 0;
      const rowHeights = rowRefs.current.map(el => (el ? el.getBoundingClientRect().height : 0));

      if (rowHeights.some(h => h === 0) && rows.length > 0) return; // not painted yet

      const measuredRows = rows.map((r, i) => ({ key: r.key, height: rowHeights[i] || 0 }));
      const packed = paginateRows(measuredRows, { headHeight, tailHeight, footerHeight });
      setPages(packed);
    };

    // Two rAFs: refs attach after this effect's own render, and late-loading images (header/QR)
    // can still change heights one frame later.
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(measure));

    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf1);
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    if (tailRef.current) ro.observe(tailRef.current);
    if (footerRef.current) ro.observe(footerRef.current);
    return () => { cancelAnimationFrame(raf1); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, head, tail]);

  const pageCount = pages ? pages.length : 1;

  return (
    <div ref={outerRef} style={{ width: `${A4_PORTRAIT_WIDTH}px`, position: 'relative' }}>
      {/* ---------- INVISIBLE MEASUREMENT PASS ----------
          Rendered at natural (unscaled) width so getBoundingClientRect returns true content
          heights, positioned off-flow so it never affects layout or gets captured. Runs on every
          render because row content (rates, descriptions) can change height without the row count
          changing. */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: 0, width: `${INNER_CONTENT_WIDTH}px`, zIndex: -1 }}
      >
        <div ref={headRef}>{head}</div>
        {renderRowsTable(rows, (el, i) => { rowRefs.current[i] = el; }, true)}
        <div ref={tailRef}>{tail}</div>
        <div ref={footerRef}>{footer}</div>
      </div>

      {/* ---------- REAL PAGED OUTPUT ---------- */}
      {(pages || [{ rows, scale: 1, naturalHeight: INNER_CONTENT_HEIGHT }]).map((page, pageIndex) => {
        const isFirst = pageIndex === 0;
        const isLast = pageIndex === (pages ? pages.length - 1 : 0);
        return (
          <PageSheet key={pageIndex} pageIndex={pageIndex} pageCount={pageCount} scale={page.scale} naturalHeight={page.naturalHeight} footer={footer} {...pageChrome}>
            {isFirst && head}
            {renderRowsTable(page.rows, () => {}, false)}
            {isLast && tail}
          </PageSheet>
        );
      })}
    </div>
  );
});

MultiPagePdf.displayName = 'MultiPagePdf';

const QuotationPdfTemplate = React.forwardRef(({
  doc,
  docType = 'QUOTATION',
  settings,
  branding = {},
  paymentTerm,
  tncItems = [],
  vendors = []
}, ref) => {
  // Must run before the no-document early return below: a hook that is skipped on one render and
  // called on the next changes the hook order and React throws.
  const bankQrSrc = useCrispQr(branding.bankQr || '/assets/HDFC Bank Details.jpeg');

  if (!doc) return null;

  const isPo = docType === 'PO';
  const seller = settings?.seller_profile || {};
  const bank = settings?.banking_details || {};
  const overlay = settings?.signature_stamp_overlay || {};
  const security = settings?.security_watermark || {};

  // On a purchase order the place of supply is the VENDOR's state — we are the recipient, so an
  // out-of-state supplier bills IGST. The server stores the resolved type; comparing the two GSTINs
  // is only the fallback for orders raised before it did.
  const isIgst = isPo
    ? (doc.GST_Type
      ? doc.GST_Type === 'IGST'
      : Boolean(doc.Vendor_GSTIN && seller.gstin && doc.Vendor_GSTIN.slice(0, 2) !== seller.gstin.slice(0, 2)))
    : (doc.GST_Type === 'IGST');

  /*
   * A PO's lines are priced server-side by the same computeDocumentTotals that prices a quotation,
   * so they already carry Taxable_Value / Line_Total / Discount_Amt. Orders saved before that
   * (Line_Total was the pre-tax value then) are recomputed here rather than printing a wrong total —
   * the old rows have no discounts, so gross is their taxable value.
   */
  const poLines = React.useMemo(() => {
    if (!isPo) return [];
    return (doc.Lines || []).map(l => {
      if (l.Taxable_Value !== undefined) {
        return { ...l, Description: l.Description || l.Specification };
      }
      const taxable = Number(l.Line_Total) || 0;
      return {
        ...l,
        Description: l.Specification,
        Taxable_Value: taxable,
        Discount_Amt: 0,
        Line_Total: Math.round(taxable * (1 + (Number(l.GST_Rate) || 0) / 100) * 100) / 100
      };
    });
  }, [doc.Lines, isPo]);

  const poTotals = React.useMemo(() => {
    if (!isPo) return null;
    // Stored totals win — they are what the buyer approved and what the vendor will be paid on.
    if (doc.Grand_Total !== undefined) {
      return {
        Subtotal: doc.Subtotal,
        Total_CGST: doc.Total_CGST,
        Total_SGST: doc.Total_SGST,
        Total_IGST: doc.Total_IGST,
        Grand_Total: doc.Grand_Total
      };
    }
    const taxable = poLines.reduce((s, l) => s + (Number(l.Taxable_Value) || 0), 0);
    const gst = poLines.reduce(
      (s, l) => s + (Number(l.Taxable_Value) || 0) * ((Number(l.GST_Rate) || 0) / 100), 0
    );
    return {
      Subtotal: taxable,
      Total_CGST: isIgst ? 0 : gst / 2,
      Total_SGST: isIgst ? 0 : gst / 2,
      Total_IGST: isIgst ? gst : 0,
      Grand_Total: taxable + gst
    };
  }, [doc, poLines, isPo, isIgst]);

  const lineItems = isPo ? poLines : (doc.Line_Items || []);

  const subtotalVal = isPo ? poTotals.Subtotal : doc.Subtotal;
  const totalCgstVal = isPo ? poTotals.Total_CGST : doc.Total_CGST;
  const totalSgstVal = isPo ? poTotals.Total_SGST : doc.Total_SGST;
  const totalIgstVal = isPo ? poTotals.Total_IGST : doc.Total_IGST;
  const grandTotalVal = isPo ? poTotals.Grand_Total : doc.Grand_Total;

  const vendorDetails = isPo ? (vendors.find(v => v.Vendor_ID === doc.Vendor_ID) || {
    Vendor_Name: doc.Vendor_Name,
    GSTIN: doc.Vendor_GSTIN
  }) : {};

  /*
   * A delivery challan is a goods-movement document, not a tax document. It never prints the tax
   * apparatus — taxable value, GST, discounts, bank details — because none of that has been agreed
   * at the point the goods leave.
   *
   * Rate and Amount are the one negotiable part. They are always RECORDED on the challan so it can
   * become an invoice in one step, but printing them is an Admin decision (challan_config.show_price):
   * the person signing for goods at the gate is usually not the person who should see the pricing.
   * Even when it is switched on, the columns appear only if a line actually carries a rate, so a
   * challan for unpriced items prints clean instead of showing a column of zeroes.
   */
  const isChallan = docType === 'CHALLAN';
  const challanCfg = settings?.challan_config || {};
  const showChallanPrice = isChallan
    && challanCfg.show_price === true
    && (doc.Line_Items || []).some(l => Number(l.Rate) > 0);

  const showMoney = !isChallan || showChallanPrice;
  const showTaxColumns = !isChallan;

  // The discount column only appears when at least one line is actually discounted, so a
  // full-price quotation isn't left with a column of dashes. Mirrors the photo column below.
  const showDiscount = !isChallan && lineItems.some(l => Number(l.Discount_Amt) > 0);

  // The photo column only appears when at least one line actually has an image, so a
  // service-only quotation isn't left with a column of dashes.
  const showPhotos = !isPo && overlay.show_product_photos !== false
    && (doc.Line_Items || []).some(l => l.Photo_URL);

  // A challan is keyed on its own hand-entered number and delivery date; every other document type
  // resolves through the existing fallback chain, untouched.
  const docNo = isChallan
    ? (doc.Challan_No || '')
    : isPo
      ? (doc.PO_No || '')
      : (doc.Quote_No_Display || doc.PI_No || doc.Invoice_No || '');
  const docDate = isChallan
    ? (doc.Challan_Date || '')
    : isPo
      ? (doc.PO_Date || '')
      : (doc.Created_At || doc.PI_Date || doc.Invoice_Date || '');

  // Admins sometimes paste a whole scanner deep-link ("upi://pay?pa=…&sign=…", ~200 chars) into the
  // UPI ID field. Only the VPA is ever printed — the raw link is an unbreakable token that blows the
  // bank card past the page edge. The payment QR itself is now the bank's own artwork, so nothing is
  // generated from this value any more; it survives purely as the printed "UPI:" line.
  const rawUpi = String(bank.upi_id || '').trim();
  const upiVpa = isUpiDeepLink(rawUpi) ? extractUpiVpa(rawUpi) : rawUpi;

  const cell = 'border border-slate-400 px-1.5 py-1 align-top';

  // ---------- HEAD (page 1 only): logo header, ref/date/gstin strip, title band, parties, subject ----------
  const head = (
    <div className="relative">
      {/* The header artwork already carries the MSME/FSAI marks, the business-areas list and
          the company logo, so no chips or duplicate text sit beside it. It spans the full
          content width exactly like the footer image below, which is what makes the two ends
          of the page align. Ref/Date/GSTIN move to their own full-width strip underneath. */}
      <div className="border-b-2 pb-2 mb-2" style={{ borderColor: BRAND_RED }}>
        <img
          src={branding.header || '/assets/header_logo.png'}
          onError={e => { e.target.onerror = null; e.target.src = '/assets/header.jpg'; }}
          alt="Company Header"
          className="w-full h-auto object-contain"
        />
      </div>

      <div className="flex items-start justify-between text-[8.5px] font-bold text-slate-700 mb-2">
        <div><span className="font-black" style={{ color: BRAND_INK }}>Ref No:</span> {docNo}</div>
        <div className="text-center"><span className="font-black" style={{ color: BRAND_INK }}>Date:</span> {formatDate(docDate)}</div>
        {seller.gstin && (
          <div className="text-right"><span className="font-black" style={{ color: BRAND_INK }}>GSTIN:</span> {seller.gstin}</div>
        )}
      </div>

      {/* Document title band.

          MUST NOT use CSS letter-spacing. html2canvas 1.4.1 mis-renders it: when
          letterSpacing !== 0 it abandons a single fillText and draws the string
          glyph-by-glyph, advancing only by measureText(letter).width and never adding the
          spacing itself (renderTextWithLetterSpacing, html2canvas.js:6703). The BROWSER does
          add it, so the layout the browser measured and the text the canvas paints disagree —
          the drawn text is narrower than, and offset from, the band, which is why the PDF
          showed an empty red bar while the screen looked correct.

          Every CSS-level fix was tried and every one failed. In order: removing
          letter-spacing; padding the string with real spaces (worse — inflates it ~40% so it
          overflows the band); dropping the <h1> for a <div>; putting the fill and the text on
          one element; pinning the font to Arial at weight 700; and finally rebuilding it as a
          table row copied verbatim from "GRAND TOTAL", which prints white-on-this-same-red
          correctly further down the page. The band still came out with the bar drawn and no
          lettering — and the table did not even take the width it was given, so the renderer,
          not the markup, is what is wrong here.

          So the PDF no longer relies on html2canvas for this element at all. The
          `data-pdf-redraw` attributes tell renderElementToCanvas (utils/pdfGenerator.js) to
          repaint this band onto the finished canvas with the native 2D API — fillRect for the
          bar, fillText per glyph for the lettering. That path cannot silently drop text.

          Because the PDF is drawn independently, the on-screen styling below is free to use
          ordinary letter-spacing again; `data-pdf-redraw-spacing` carries the equivalent
          tracking in px so the two stay visually identical.

          If this element is restyled, keep the data-pdf-redraw attributes and keep the
          spacing values in step, or the PDF will silently drift from the screen. */}
      <div
        data-pdf-redraw="title"
        data-pdf-redraw-bg={BRAND_RED}
        data-pdf-redraw-color="#ffffff"
        data-pdf-redraw-spacing="2.6"
        style={{
          backgroundColor: BRAND_RED,
          color: '#ffffff',
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 8px',
          marginBottom: '8px',
          fontSize: '13px',
          lineHeight: '16px',
          fontWeight: 700,
          letterSpacing: '0.2em',
          textAlign: 'center',
          whiteSpace: 'nowrap'
        }}
      >
        {DOC_TITLES[docType] || 'QUOTATION'}
      </div>

      {/* ---------- PARTIES ---------- */}
      <div className="flex gap-2 mb-2 text-[9px]">
        <div className="flex-1 border border-slate-400" style={{ minWidth: 0 }}>
          <div className="px-1.5 py-0.5 font-black uppercase text-[8px] tracking-wide border-b border-slate-400"
            style={{ backgroundColor: BRAND_HEAD_BG, color: BRAND_INK }}>
            {isPo ? 'Supplier' : 'Bill To'}
          </div>
          {/* A long email or unspaced address must wrap rather than widen the column. */}
          {isPo ? (
            <div className="px-1.5 py-1 leading-snug" style={{ overflowWrap: 'anywhere' }}>
              <div className="font-black text-[10px]">{vendorDetails.Vendor_Name || doc.Vendor_Name}</div>
              {vendorDetails.Contact_Person && (
                <div><span className="text-slate-500">Attn:</span> {vendorDetails.Contact_Person}</div>
              )}
              <div className="whitespace-pre-line">{vendorDetails.Address || 'No Address'}</div>
              {(vendorDetails.GSTIN || doc.Vendor_GSTIN) && (
                <div><span className="font-bold">GSTIN:</span> {vendorDetails.GSTIN || doc.Vendor_GSTIN}</div>
              )}
              {vendorDetails.Phone && (
                <div><span className="font-bold">Mob:</span> {vendorDetails.Phone}</div>
              )}
              {vendorDetails.Email && (
                <div><span className="font-bold">Email:</span> {vendorDetails.Email}</div>
              )}
            </div>
          ) : (
            <div className="px-1.5 py-1 leading-snug" style={{ overflowWrap: 'anywhere' }}>
              <div className="font-black text-[10px]">{doc.Customer_Name_Snapshot}</div>
              {doc.Customer_Auth_Person_Snapshot && (
                <div><span className="text-slate-500">Attn:</span> {doc.Customer_Auth_Person_Snapshot}</div>
              )}
              <div className="whitespace-pre-line">{doc.Customer_Address_Snapshot}</div>
              {doc.Customer_GSTIN_Snapshot && (
                <div><span className="font-bold">GSTIN:</span> {doc.Customer_GSTIN_Snapshot}</div>
              )}
              {doc.Customer_Contact_Snapshot && (
                <div><span className="font-bold">Mob:</span> {doc.Customer_Contact_Snapshot}</div>
              )}
              {doc.Customer_Email_Snapshot && (
                <div><span className="font-bold">Email:</span> {doc.Customer_Email_Snapshot}</div>
              )}
            </div>
          )}
        </div>

        <div style={{ width: '250px' }} className="border border-slate-400 shrink-0">
          <div className="px-1.5 py-0.5 font-black uppercase text-[8px] tracking-wide border-b border-slate-400"
            style={{ backgroundColor: BRAND_HEAD_BG, color: BRAND_INK }}>
            {isPo ? 'Ship To / Bill To' : 'Details'}
          </div>
          {/* A PO names the delivery address before its meta rows: the vendor's first question
              is where to send the goods, and that is us. Every other document type is billed to
              the party already printed on the left, so it needs no such block. */}
          {isPo && (
            <div className="px-1.5 py-1 leading-snug text-[8.5px] border-b border-slate-400"
              style={{ overflowWrap: 'anywhere' }}>
              <div className="font-black text-[10px]">{seller.legal_name || 'Expert Safety Solutions'}</div>
              <div className="whitespace-pre-line text-slate-600 my-0.5">{seller.address}</div>
              {seller.gstin && <div><span className="font-bold">GSTIN:</span> {seller.gstin}</div>}
              {seller.phone && <div><span className="font-bold">Mob:</span> {seller.phone}</div>}
              {seller.email && <div><span className="font-bold">Email:</span> {seller.email}</div>}
            </div>
          )}
          <table className="w-full">
            <tbody>
              <Meta k="Document No." v={docNo} bold />
              <Meta k="Date" v={formatDate(docDate)} />
              {doc.Revision_No > 0 && <Meta k="Revision" v={`R${doc.Revision_No}`} />}
              {docType === 'QUOTATION' && doc.Expiry_Date && <Meta k="Valid Until" v={formatDate(doc.Expiry_Date)} />}
              {isPo && doc.Expected_Date && <Meta k="Expected By" v={formatDate(doc.Expected_Date)} />}
              {!isPo && docType !== 'QUOTATION' && doc.Due_Date && <Meta k="Due Date" v={formatDate(doc.Due_Date)} />}
              <Meta k="Supply Type" v={isIgst ? 'Inter-State' : 'Intra-State'} />
              {/* paymentTerm is the picked settings row; Payment_Terms is the free-text a PO
                  inherits from the vendor when nothing was picked. */}
              {paymentTerm
                ? <Meta k="Payment Terms" v={paymentTerm.label} />
                : doc.Payment_Terms ? <Meta k="Payment Terms" v={doc.Payment_Terms} /> : null}
              {/* Despatch details. Each prints only when filled, so a document that does not
                  need them looks exactly as it did before — this block is invisible until
                  someone actually enters a transporter or an agent. */}
              {doc.Despatch_Through && <Meta k="Despatch Through" v={doc.Despatch_Through} />}
              {doc.Agent_Name && <Meta k="Agent" v={doc.Agent_Name} />}
              {doc.Vehicle_No && <Meta k="Vehicle No." v={doc.Vehicle_No} />}
            </tbody>
          </table>
        </div>
      </div>

      {doc.Subject && (
        <div className="mb-1.5 text-[9px] border border-slate-300 px-1.5 py-1 bg-slate-50">
          <span className="font-black">Subject: </span>{doc.Subject}
        </div>
      )}
    </div>
  );

  // ---------- LINE ITEMS TABLE ----------
  // table-fixed honours the explicit column widths below; with auto layout a long product
  // name overrides them and stretches the table wider than the page.
  const colCount = 1 /* # */
    + (showPhotos ? 1 : 0) + 1 /* description */
    + ((!isChallan || challanCfg.show_hsn !== false) ? 1 : 0)
    + 1 /* qty */ + 1 /* unit */
    + (showMoney ? 1 : 0) + (showDiscount ? 1 : 0)
    + (showTaxColumns ? 2 : 0) + (showMoney ? 1 : 0);

  const thead = (
    <thead>
      <tr style={{ backgroundColor: BRAND_INK, color: '#ffffff' }}>
        <th className={`${cell} text-center`} style={{ width: '26px' }}>#</th>
        {showPhotos && <th className={`${cell} text-center`} style={{ width: '52px' }}>Photo</th>}
        <th className={`${cell} text-left`}>Description of Goods / Services</th>
        {(!isChallan || challanCfg.show_hsn !== false) && (
          <th className={`${cell} text-center`} style={{ width: '58px' }}>HSN</th>
        )}
        <th className={`${cell} text-right`} style={{ width: '40px' }}>Qty</th>
        <th className={`${cell} text-center`} style={{ width: '34px' }}>Unit</th>
        {showMoney && <th className={`${cell} text-right`} style={{ width: '62px' }}>Rate</th>}
        {showDiscount && <th className={`${cell} text-right`} style={{ width: '54px' }}>Disc.</th>}
        {showTaxColumns && <th className={`${cell} text-right`} style={{ width: '66px' }}>Taxable</th>}
        {showTaxColumns && <th className={`${cell} text-center`} style={{ width: '34px' }}>GST</th>}
        {showMoney && <th className={`${cell} text-right`} style={{ width: '72px' }}>Amount</th>}
      </tr>
    </thead>
  );

  const rowNodes = lineItems.map((l, i) => (
    <tr key={i}>
      <td className={`${cell} text-center`}>{i + 1}</td>
      {showPhotos && (
        <td className={`${cell} text-center`}>
          {/* Loaded eagerly here: html2canvas captures a static DOM snapshot, so a
              lazy image would rasterise as a blank box in the exported PDF. */}
          {l.Photo_URL ? (
            <img
              src={l.Photo_URL}
              alt=""
              crossOrigin="anonymous"
              referrerPolicy="no-referrer"
              style={{ width: '44px', height: '44px', objectFit: 'cover', display: 'block', margin: '0 auto' }}
            />
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
      )}
      <td className={cell} style={{ overflowWrap: 'anywhere' }}>
        <div className="font-bold">{l.Item_Name}</div>
        {(l.Long_Description || l.Description) && (
          <div className="text-slate-500 text-[7.5px] leading-snug whitespace-pre-line">
            {l.Long_Description || l.Description}
          </div>
        )}
        {/* Hand-typed per-line note. Sits below the catalogue copy and is styled darker
            than it — it is a deliberate instruction to this customer, not boilerplate. */}
        {l.Remarks && (
          <div className="text-slate-700 text-[7.5px] leading-snug whitespace-pre-line mt-0.5">
            {l.Remarks}
          </div>
        )}
      </td>
      {(!isChallan || challanCfg.show_hsn !== false) && (
        <td className={`${cell} text-center`}>{l.HSN_Code || '-'}</td>
      )}
      <td className={`${cell} text-right`}>{Number(l.Qty) || 0}</td>
      <td className={`${cell} text-center`}>{l.Unit || 'Nos'}</td>
      {showMoney && <td className={`${cell} text-right`}>{formatMoney(l.Rate, false)}</td>}
      {showDiscount && (
        <td className={`${cell} text-right`}>
          {Number(l.Discount_Amt) > 0 ? formatMoney(l.Discount_Amt, false) : '-'}
        </td>
      )}
      {showTaxColumns && <td className={`${cell} text-right`}>{formatMoney(l.Taxable_Value, false)}</td>}
      {showTaxColumns && <td className={`${cell} text-center`}>{Number(l.GST_Rate) || 0}%</td>}
      {showMoney && (
        <td className={`${cell} text-right font-bold`}>
          {/* A challan has no tax, so its line total is simply qty x rate. */}
          {formatMoney(isChallan ? l.Amount : l.Line_Total, false)}
        </td>
      )}
    </tr>
  ));

  const measureRows = lineItems.map((l, i) => ({ key: i }));

  /** Renders one page's slice of rows as a complete table (own thead, so the header repeats). */
  const renderRowsTable = (pageRows, attachRowRef, isMeasurePass) => {
    if (isMeasurePass) {
      // Measurement pass renders EVERY row, each independently ref'd, inside one table so the
      // measured height matches real rendering (borders/padding are per-row via table layout).
      return (
        <table className="w-full text-[8.5px] border-collapse" style={{ tableLayout: 'fixed' }}>
          {thead}
          <tbody>
            {rowNodes.map((node, i) => (
              <tr key={i} ref={el => attachRowRef(el, i)} style={node.props.style}>
                {node.props.children}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (!pageRows.length) return null;
    return (
      <table className="w-full text-[8.5px] border-collapse" style={{ tableLayout: 'fixed' }}>
        {thead}
        <tbody>
          {pageRows.map(r => rowNodes[r.key])}
        </tbody>
      </table>
    );
  };

  // ---------- TAIL (last page only): challan summary / totals / T&C / notes ----------
  const tail = (
    <div>
      {/* ---------- CHALLAN SUMMARY ----------
          A challan settles nothing, so it carries no tax table, no amount in words and no bank
          details — only what physically went out, and the value only when the Admin allows it. */}
      {isChallan && (
        <div className="flex gap-2 mt-2 text-[9px] items-start">
          <div className="flex-1" style={{ minWidth: 0 }}>
            {challanCfg.declaration && (
              <div className="border border-slate-400 px-1.5 py-1">
                <span className="italic">{challanCfg.declaration}</span>
              </div>
            )}
          </div>
          <div style={{ width: '250px' }} className="shrink-0">
            <table className="w-full border border-slate-400 text-[9px]">
              <tbody>
                <tr style={{ backgroundColor: BRAND_RED, color: '#ffffff' }}>
                  <td className="px-1.5 py-1 font-black">TOTAL QUANTITY</td>
                  <td className="px-1.5 py-1 text-right font-black text-[11px]">
                    {(doc.Line_Items || []).reduce((s, l) => s + (Number(l.Qty) || 0), 0)}
                  </td>
                </tr>
                {showChallanPrice && (
                  <Total k="Total Value" v={formatMoney(doc.Total_Amount)} bold />
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- TOTALS ----------
          items-start keeps the bank-details card at its natural height instead of stretching
          it to match the totals table beside it. */}
      {!isChallan && (
      <div className="flex gap-2 mt-2 text-[9px] items-start">
        {/* minWidth:0 lets this column shrink; a flex item defaults to min-width:auto and would
            otherwise refuse to go narrower than its longest unbreakable child. */}
        <div className="flex-1" style={{ minWidth: 0 }}>
          <div className="border border-slate-400 px-1.5 py-1 mb-1.5">
            <span className="font-black">Amount in words: </span>
            <span className="italic">{amountInWords(grandTotalVal)}</span>
          </div>

          {!isPo && (bank.account_no || rawUpi) && (
            <div className="border border-slate-400">
              <div className="px-1.5 py-0.5 font-black uppercase text-[8px] border-b border-slate-400"
                style={{ backgroundColor: BRAND_HEAD_BG, color: BRAND_INK }}>
                Bank Details
              </div>
              <div className="flex">
                <div className="px-1.5 py-1 flex-1 leading-snug text-[8.5px]"
                  style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {bank.account_name && <div><span className="text-slate-500">Name:</span> <b>{bank.account_name}</b></div>}
                  {bank.bank_name && <div><span className="text-slate-500">Bank:</span> <b>{bank.bank_name}</b></div>}
                  {bank.account_no && <div><span className="text-slate-500">A/C No:</span> <b>{bank.account_no}</b></div>}
                  {bank.ifsc && <div><span className="text-slate-500">IFSC:</span> <b>{bank.ifsc}</b></div>}
                  {bank.branch && <div><span className="text-slate-500">Branch:</span> <b>{bank.branch}</b></div>}
                  {upiVpa && <div><span className="text-slate-500">UPI:</span> <b>{upiVpa}</b></div>}
                </div>
                {overlay.show_upi_qr !== false && (
                  <div className="px-1.5 py-1 border-l border-slate-400 text-center shrink-0">
                    {/* The bank's own printed QR rather than one generated from the UPI ID: it
                        settles into the account the business actually reconciles against.
                        useCrispQr has already cropped away the artwork's logo and caption and
                        hard-thresholded every pixel to black or white, so the whole box is
                        code and nothing here is left grey for JPEG to smear. */}
                    <img
                      src={bankQrSrc}
                      alt="Scan to pay"
                      loading="eager"
                      crossOrigin="anonymous"
                      style={{
                        width: `${QR_BOX_PX}px`,
                        height: `${QR_BOX_PX}px`,
                        display: 'block',
                        margin: '0 auto',
                        // The source is already square and pre-scaled, so there is nothing to
                        // letterbox; a white backing stops any page tint bleeding into the
                        // quiet zone, which scanners read as part of the code.
                        backgroundColor: '#ffffff'
                      }}
                    />
                    <div className="text-[7px] text-slate-600 font-bold">SCAN TO PAY</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ width: '250px' }} className="shrink-0">
          <table className="w-full border border-slate-400 text-[9px]">
            <tbody>
              <Total k="Taxable Value" v={formatMoney(subtotalVal)} />
              {Number(doc.Document_Level_Discount_Amt) > 0 && (
                <Total k="Additional Discount" v={`- ${formatMoney(doc.Document_Level_Discount_Amt)}`} />
              )}
              {isIgst ? (
                <Total k="IGST" v={formatMoney(totalIgstVal)} />
              ) : (
                <>
                  <Total k="CGST" v={formatMoney(totalCgstVal)} />
                  <Total k="SGST" v={formatMoney(totalSgstVal)} />
                </>
              )}
              <tr style={{ backgroundColor: BRAND_RED, color: '#ffffff' }}>
                <td className="px-1.5 py-1 font-black">GRAND TOTAL</td>
                <td className="px-1.5 py-1 text-right font-black text-[11px]">
                  {formatMoney(grandTotalVal)}
                </td>
              </tr>
              {docType === 'INVOICE' && Number(doc.Amount_Paid) > 0 && (
                <>
                  <Total k="Amount Paid" v={formatMoney(doc.Amount_Paid)} />
                  <Total k="Balance Due" v={formatMoney((Number(grandTotalVal) || 0) - (Number(doc.Amount_Paid) || 0))} bold />
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {isChallan && challanCfg.terms && (
        <div className="mt-2 text-[7.5px] text-slate-700 leading-snug whitespace-pre-line">
          {challanCfg.terms}
        </div>
      )}

      {!isChallan && tncItems.length > 0 && (
        <div className="mt-2">
          <div className="text-[8px] font-black uppercase tracking-wide mb-0.5" style={{ color: BRAND_RED_DARK }}>Terms &amp; Conditions</div>
          <ol className="text-[7.5px] text-slate-700 leading-snug" style={{ paddingLeft: '14px', listStyleType: 'decimal' }}>
            {tncItems.map(t => <li key={t.id}>{t.text}</li>)}
          </ol>
        </div>
      )}

      {doc.Notes && (
        <div className="mt-1.5 text-[8.5px]"><span className="font-black">Note: </span>{doc.Notes}</div>
      )}

      {/* ---------- SIGNATURE ---------- (last page only, part of the tail block) */}
      <div className="flex justify-end items-end mt-3">
        <div className="text-center flex flex-col items-center justify-end shrink-0" style={{ minWidth: '170px' }}>
          <div className="font-black text-[9px] mb-0.5">For {seller.legal_name || 'Expert Safety Solutions'}</div>
          {overlay.show_stamp !== false && (
            /* Fixed 80x80 slot sized by max-width/max-height, not object-fit — html2canvas
               ignores object-fit and would stretch the round seal into an ellipse. No border: the
               stamp/signature scan is itself round and inked, a square frame around it just
               competes with the artwork. */
            <div className="w-20 h-20 mx-auto -mb-1 flex items-center justify-center">
              <img
                src={branding.stamp || '/assets/company_stamp.png'}
                onError={e => { e.target.onerror = null; e.target.src = '/assets/stamp.jpg'; }}
                alt="Company Seal"
                className="w-auto h-auto max-w-full max-h-full object-contain"
              />
            </div>
          )}
          {/* Honours the "Show signatory name & line" toggle in Quotation Settings, which the
              settings screen has always offered but this template previously ignored. */}
          {overlay.show_signature !== false && (
            <div className="border-t border-slate-900 pt-0.5 w-full">
              <div className="font-black text-[9px] uppercase">
                {seller.authorized_signatory || 'Mr. Nilesh Padaya'}
              </div>
              <div className="text-[8px] text-slate-800 font-bold leading-tight">
                Authorized Signatory
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ---------- FOOTER ARTWORK (every page) ----------
  const footerNode = (
    <div className="pt-1.5 mt-2 shrink-0">
      <img
        src={branding.footer || '/assets/Footer - Expert (2025).PNG'}
        onError={e => { e.target.onerror = null; e.target.src = '/assets/footer.png'; }}
        alt="Footer"
        className="w-full h-auto object-contain"
      />
    </div>
  );

  return (
    <MultiPagePdf
      ref={ref}
      head={head}
      tail={tail}
      rows={measureRows}
      renderRowsTable={renderRowsTable}
      footer={footerNode}
      pageChrome={{ security, seller, overlay, branding }}
    />
  );
});

function Meta({ k, v, bold }) {
  return (
    <tr>
      <td className="px-1.5 py-0.5 text-slate-500 whitespace-nowrap">{k}</td>
      <td className={`px-1.5 py-0.5 text-right ${bold ? 'font-black' : 'font-bold'}`}>{v}</td>
    </tr>
  );
}

function Total({ k, v, bold }) {
  return (
    <tr>
      <td className="px-1.5 py-0.5 text-slate-600">{k}</td>
      <td className={`px-1.5 py-0.5 text-right ${bold ? 'font-black' : 'font-bold'}`}>{v}</td>
    </tr>
  );
}

QuotationPdfTemplate.displayName = 'QuotationPdfTemplate';
export default QuotationPdfTemplate;
