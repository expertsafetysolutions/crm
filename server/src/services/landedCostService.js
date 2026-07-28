const { round2 } = require('../utils/gstUtils');

/**
 * landedCostService — what a part actually cost by the time it reached our shelf.
 *
 * The invoice price is not the cost. A ₹10,000 order with ₹800 of freight and ₹200 of rickshaw
 * charges cost ₹11,000, and quoting a margin off the invoice price alone quietly under-prices every
 * job. Those charges arrive as one lump sum for the whole delivery, so they have to be spread across
 * the lines before a per-unit cost exists.
 *
 * Spread BY VALUE, not by quantity: freight on a consignment of fifty ₹20 safety pins and two ₹4,000
 * valves is mostly being paid to move the valves. Weighting by quantity would load the cost onto the
 * cheap high-count line and make the pins look twice their real cost.
 *
 * Cost is held as a moving weighted average on Inventory_Master, in the same document and the same
 * write as Current_Qty, so quantity and value can never disagree. Only a goods receipt changes the
 * average; issues draw at whatever the average is. That is deliberate — it means part-fitting keeps
 * behaving exactly as it always has, and the "stock is deducted once, at part-fitting time" rule is
 * untouched by any of this.
 */

/**
 * Splits lump-sum charges across receipt lines in proportion to line value.
 *
 * The last line absorbs the rounding remainder so the parts sum EXACTLY to the amount invoiced —
 * the same technique computeDocumentTotals uses for document-level discounts. Without it, ₹100
 * across three equal lines allocates ₹33.33 three times and thirty paise vanish from the books.
 *
 * @param {Array<{lineTotal:number}>} lines
 * @param {number} totalCharges  freight + cartage + any other whole-consignment cost
 * @returns {number[]} allocation per line, index-aligned with `lines`
 */
function apportionCharges(lines, totalCharges) {
  const rows = Array.isArray(lines) ? lines : [];
  const charges = round2(Number(totalCharges) || 0);
  if (rows.length === 0 || charges === 0) return rows.map(() => 0);

  const values = rows.map(l => round2(Math.max(0, Number(l.lineTotal) || 0)));
  const total = round2(values.reduce((s, v) => s + v, 0));

  // Every line free of charge (or a zero-value consignment): fall back to an equal split, since
  // proportion is undefined. Rare, but dividing by zero here would poison every unit cost.
  if (total === 0) {
    const each = round2(charges / rows.length);
    return rows.map((_, i) => (i === rows.length - 1
      ? round2(charges - each * (rows.length - 1))
      : each));
  }

  const out = [];
  let allocated = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1) {
      out.push(round2(charges - allocated));
    } else {
      const share = round2(charges * (values[i] / total));
      out.push(share);
      allocated = round2(allocated + share);
    }
  }
  return out;
}

/**
 * Per-unit landed cost for each line of a goods receipt.
 *
 * @param {Array<{itemId,receivedQty,unitPrice,lineTotal?,otherCharges?}>} lines
 * @param {number} totalCharges lump-sum freight/cartage for the whole receipt
 */
function computeLandedCosts(lines, totalCharges) {
  const rows = (Array.isArray(lines) ? lines : []).map(l => {
    const qty = Number(l.receivedQty) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    return {
      ...l,
      receivedQty: qty,
      unitPrice,
      // An explicit lineTotal wins so a vendor's own line figure (which may carry its own rounding)
      // is preserved rather than silently recomputed into a different number.
      lineTotal: l.lineTotal !== undefined ? round2(Number(l.lineTotal) || 0) : round2(qty * unitPrice)
    };
  });

  const allocations = apportionCharges(rows, totalCharges);

  return rows.map((row, i) => {
    const allocatedCharges = allocations[i];
    const otherCharges = round2(Number(row.otherCharges) || 0);
    const landedTotal = round2(row.lineTotal + allocatedCharges + otherCharges);
    return {
      ...row,
      Allocated_Charges: allocatedCharges,
      Other_Charges: otherCharges,
      Landed_Total: landedTotal,
      // Guard the divide: a zero-quantity line is a data-entry slip, not a reason to write NaN into
      // the cost ledger where it would spread through every later average.
      Landed_Unit_Cost: row.receivedQty > 0 ? round2(landedTotal / row.receivedQty) : 0
    };
  });
}

/**
 * Blends a receipt into the running average.
 *
 * Guards oldQty <= 0 by falling back to the incoming cost. Stock CAN legitimately be negative here:
 * deductForInvoice deliberately allows it rather than blocking an invoice that has already gone to a
 * customer. Averaging against a negative quantity produces a meaningless (often negative) cost, so
 * the first real receipt after a shortfall simply resets the basis.
 */
function nextMovingAverage({ oldQty, oldAvgCost, receivedQty, landedUnitCost }) {
  const prevQty = Number(oldQty) || 0;
  const prevAvg = Number(oldAvgCost) || 0;
  const inQty = Number(receivedQty) || 0;
  const inCost = Number(landedUnitCost) || 0;

  if (inQty <= 0) return round2(prevAvg);
  if (prevQty <= 0) return round2(inCost);

  const newQty = prevQty + inQty;
  return round2(((prevQty * prevAvg) + (inQty * inCost)) / newQty);
}

/** Stock value implied by a quantity and an average cost. */
function stockValue(qty, avgCost) {
  return round2((Number(qty) || 0) * (Number(avgCost) || 0));
}

module.exports = {
  apportionCharges,
  computeLandedCosts,
  nextMovingAverage,
  stockValue
};
