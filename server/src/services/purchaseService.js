const sheetsService = require('./sheetsService');
const inventoryService = require('./inventoryService');
const landedCostService = require('./landedCostService');
const quotationEngine = require('./quotationEngine');
const { round2 } = require('../utils/gstUtils');

/**
 * purchaseService — the buying side: vendors, enquiries, orders and goods receipt.
 *
 * Until now the only record of a purchase was two free-text fields on a stock transaction
 * (Supplier_Name, Supplier_Invoice_No), so there was no way to answer "what did we pay for this
 * last time", "who quoted cheapest" or "what is this stock actually worth". The flow is:
 *
 *   Vendor → RFQ (to several vendors) → their quotes → compare → Purchase Order → Goods Receipt
 *
 * Posting a goods receipt is the ONLY thing here that touches stock. Everything before it is paper.
 * That keeps a very old invariant intact: stock moves at exactly two moments — in at receipt, out at
 * part-fitting — and nothing about the second one changes.
 *
 * Quotes are their own collection rather than an array on the RFQ because vendors reply
 * independently and updateRow only does $set; two replies arriving together would clobber each
 * other, the same hazard that keeps Job_Card_Item out of Job_Card_Master.
 */

const RFQ_STATUS = { DRAFT: 'Draft', SENT: 'Sent', QUOTED: 'Quoted', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
const PO_STATUS = { DRAFT: 'Draft', ISSUED: 'Issued', PARTIAL: 'Partially Received', RECEIVED: 'Received', CANCELLED: 'Cancelled' };

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** Hand-rolled ids, matching the convention used across the rest of the app. */
function newId(prefix) {
  return `${prefix}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
}

const norm = v => String(v ?? '').trim().toLowerCase();

// ─── VENDORS ───────────────────────────────────────────────────────────────────────────────────

async function getVendors({ includeInactive = false } = {}) {
  const rows = await sheetsService.getTab('Vendor_Master');
  const list = includeInactive ? rows : rows.filter(v => v.Active !== false);
  return [...list].sort((a, b) => String(a.Vendor_Name || '').localeCompare(String(b.Vendor_Name || '')));
}

async function createVendor(payload, actor) {
  const name = String(payload.vendorName || '').trim();
  if (!name) throw new Error('Vendor name is required');

  const existing = await sheetsService.getTab('Vendor_Master');
  if (existing.some(v => norm(v.Vendor_Name) === norm(name))) {
    throw new Error(`A vendor named "${name}" already exists`);
  }

  const row = {
    Vendor_ID: newId('VEN'),
    Vendor_Name: name,
    GSTIN: String(payload.gstin || '').trim().toUpperCase(),
    Contact_Person: String(payload.contactPerson || '').trim(),
    Phone: String(payload.phone || '').trim(),
    Email: String(payload.email || '').trim(),
    Address: String(payload.address || '').trim(),
    Payment_Terms: String(payload.paymentTerms || '').trim(),
    Lead_Time_Days: Number(payload.leadTimeDays) || 0,
    Notes: String(payload.notes || '').trim(),
    Active: payload.active !== false,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString()
  };
  await sheetsService.insertRow('Vendor_Master', row);
  return row;
}

async function updateVendor(vendorId, payload) {
  const patch = { Updated_At: new Date().toISOString() };
  const map = {
    vendorName: 'Vendor_Name', gstin: 'GSTIN', contactPerson: 'Contact_Person',
    phone: 'Phone', email: 'Email', address: 'Address',
    paymentTerms: 'Payment_Terms', notes: 'Notes'
  };
  for (const [from, to] of Object.entries(map)) {
    if (payload[from] !== undefined) patch[to] = String(payload[from]).trim();
  }
  if (payload.leadTimeDays !== undefined) patch.Lead_Time_Days = Number(payload.leadTimeDays) || 0;
  if (payload.active !== undefined) patch.Active = Boolean(payload.active);

  const saved = await sheetsService.updateRow('Vendor_Master', 'Vendor_ID', vendorId, patch);
  if (!saved) throw new Error(`Vendor ${vendorId} not found`);
  return saved;
}

// ─── RFQ ───────────────────────────────────────────────────────────────────────────────────────

function normalizeRfqLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter(l => String(l.itemName || l.Item_Name || '').trim() || l.itemId || l.Item_ID)
    .map((l, i) => ({
      lineId: l.lineId || `RL${i}${Date.now().toString(36)}`,
      Item_ID: String(l.itemId || l.Item_ID || '').trim(),
      Item_Name: String(l.itemName || l.Item_Name || '').trim(),
      Specification: String(l.specification || l.Specification || '').trim(),
      Qty: Number(l.qty ?? l.Qty) || 0,
      Unit: String(l.unit || l.Unit || 'Nos').trim()
    }));
}

async function createRfq(payload, actor) {
  const lines = normalizeRfqLines(payload.lines);
  if (lines.length === 0) throw new Error('An enquiry needs at least one item');

  const vendorIds = (Array.isArray(payload.vendorIds) ? payload.vendorIds : []).filter(Boolean);
  const row = {
    RFQ_ID: newId('RFQ'),
    RFQ_No: `RFQ/${istToday().slice(2, 7).replace('-', '')}/${Date.now().toString().slice(-4)}`,
    Title: String(payload.title || '').trim(),
    Lines: lines,
    Vendor_IDs: vendorIds,
    Required_By: String(payload.requiredBy || '').trim(),
    Notes: String(payload.notes || '').trim(),
    Status: vendorIds.length > 0 ? RFQ_STATUS.SENT : RFQ_STATUS.DRAFT,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString(),
    RFQ_Date: istToday()
  };
  await sheetsService.insertRow('Purchase_RFQ', row);
  return row;
}

async function getRfqs() {
  const rows = await sheetsService.getTab('Purchase_RFQ');
  return [...rows].sort((a, b) => String(b.Created_At || '').localeCompare(String(a.Created_At || '')));
}

async function getRfqById(rfqId) {
  const rows = await sheetsService.getTab('Purchase_RFQ');
  return rows.find(r => r.RFQ_ID === rfqId) || null;
}

/**
 * Records one vendor's reply. Replacing that vendor's previous quote rather than adding a second is
 * deliberate — a revised price supersedes, and two live quotes from one vendor would make the
 * comparison ambiguous.
 */
async function recordQuote(rfqId, payload, actor) {
  const rfq = await getRfqById(rfqId);
  if (!rfq) throw new Error(`Enquiry ${rfqId} not found`);

  const vendorId = String(payload.vendorId || '').trim();
  if (!vendorId) throw new Error('A vendor is required');

  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendor = vendors.find(v => v.Vendor_ID === vendorId);
  if (!vendor) throw new Error(`Vendor ${vendorId} not found`);

  const lines = (Array.isArray(payload.lines) ? payload.lines : []).map(l => {
    const qty = Number(l.qty ?? l.Qty) || 0;
    const rate = Number(l.rate ?? l.Rate) || 0;
    return {
      lineId: String(l.lineId || '').trim(),
      Item_Name: String(l.itemName || l.Item_Name || '').trim(),
      Qty: qty,
      Rate: rate,
      GST_Rate: Number(l.gstRate ?? l.GST_Rate) || 0,
      Lead_Time_Days: Number(l.leadTimeDays ?? l.Lead_Time_Days) || 0,
      Line_Total: round2(qty * rate)
    };
  });

  const total = round2(lines.reduce((s, l) => s + l.Line_Total, 0));
  const existing = (await sheetsService.getTab('Purchase_Quote'))
    .find(q => q.RFQ_ID === rfqId && q.Vendor_ID === vendorId);

  const record = {
    PQ_ID: existing?.PQ_ID || newId('PQ'),
    RFQ_ID: rfqId,
    Vendor_ID: vendorId,
    Vendor_Name: vendor.Vendor_Name,
    Lines: lines,
    Quote_Total: total,
    Lead_Time_Days: Number(payload.leadTimeDays) || vendor.Lead_Time_Days || 0,
    Payment_Terms: String(payload.paymentTerms || vendor.Payment_Terms || '').trim(),
    Notes: String(payload.notes || '').trim(),
    Quoted_At: new Date().toISOString(),
    Recorded_By: actor?.staffId || 'SYSTEM'
  };

  if (existing) {
    await sheetsService.updateRow('Purchase_Quote', 'PQ_ID', existing.PQ_ID, record);
  } else {
    await sheetsService.insertRow('Purchase_Quote', record);
  }

  if (rfq.Status !== RFQ_STATUS.CLOSED) {
    await sheetsService.updateRow('Purchase_RFQ', 'RFQ_ID', rfqId, {
      Status: RFQ_STATUS.QUOTED, Updated_At: new Date().toISOString()
    });
  }
  return record;
}

/**
 * Side-by-side comparison, cheapest first — L1, L2, L3 in the usual purchasing shorthand.
 *
 * Ranks on total value, and separately flags the cheapest price for each individual line, because
 * the lowest overall quote is not always cheapest on everything and a buyer splitting an order
 * needs to see that.
 */
async function compareQuotes(rfqId) {
  const rfq = await getRfqById(rfqId);
  if (!rfq) throw new Error(`Enquiry ${rfqId} not found`);

  const quotes = (await sheetsService.getTab('Purchase_Quote')).filter(q => q.RFQ_ID === rfqId);
  const ranked = [...quotes]
    .sort((a, b) => (Number(a.Quote_Total) || 0) - (Number(b.Quote_Total) || 0))
    .map((q, i) => ({ ...q, Rank: `L${i + 1}`, Is_Lowest: i === 0 }));

  const lineComparison = (rfq.Lines || []).map(line => {
    const offers = ranked.map(q => {
      const match = (q.Lines || []).find(l => l.lineId === line.lineId);
      return {
        Vendor_ID: q.Vendor_ID, Vendor_Name: q.Vendor_Name, Rank: q.Rank,
        Rate: match ? match.Rate : null,
        Line_Total: match ? match.Line_Total : null,
        Lead_Time_Days: match ? match.Lead_Time_Days : null
      };
    });
    const priced = offers.filter(o => o.Rate !== null && o.Rate > 0);
    const best = priced.length > 0
      ? priced.reduce((lo, o) => (o.Rate < lo.Rate ? o : lo))
      : null;
    return {
      ...line,
      offers: offers.map(o => ({ ...o, Is_Lowest_For_Line: best ? o.Vendor_ID === best.Vendor_ID : false }))
    };
  });

  return { rfq, quotes: ranked, lineComparison };
}

// ─── PURCHASE ORDER ────────────────────────────────────────────────────────────────────────────

/**
 * Raises a purchase order, normally from a chosen vendor quote.
 *
 * The number comes from the atomic Counter_Master sequence, like every other number the company
 * issues outward: a PO goes to a vendor and must never repeat or a payment can be claimed twice.
 */
async function createPurchaseOrder(payload, actor) {
  const vendorId = String(payload.vendorId || '').trim();
  if (!vendorId) throw new Error('A vendor is required');

  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendor = vendors.find(v => v.Vendor_ID === vendorId);
  if (!vendor) throw new Error(`Vendor ${vendorId} not found`);

  const lines = (Array.isArray(payload.lines) ? payload.lines : []).map((l, i) => {
    const qty = Number(l.qty ?? l.Qty) || 0;
    const rate = Number(l.rate ?? l.Rate) || 0;
    return {
      lineId: l.lineId || `PL${i}${Date.now().toString(36)}`,
      Item_ID: String(l.itemId || l.Item_ID || '').trim(),
      Item_Name: String(l.itemName || l.Item_Name || '').trim(),
      Specification: String(l.specification || l.Specification || '').trim(),
      Qty: qty,
      Unit: String(l.unit || l.Unit || 'Nos').trim(),
      Rate: rate,
      GST_Rate: Number(l.gstRate ?? l.GST_Rate) || 0,
      Line_Total: round2(qty * rate),
      Received_Qty: 0
    };
  }).filter(l => l.Item_Name);

  if (lines.length === 0) throw new Error('A purchase order needs at least one line');

  const settings = await quotationEngine.getSettings();
  const existing = await sheetsService.getTab('Purchase_Order');
  const poNo = await quotationEngine.nextDocumentNumber(
    settings.defaults?.po_no_prefix || 'PO',
    settings.defaults?.number_reset,
    { existing, field: 'PO_No' }
  );

  const row = {
    PO_ID: newId('PO'),
    PO_No: poNo,
    PO_Date: payload.poDate || istToday(),
    Vendor_ID: vendorId,
    Vendor_Name: vendor.Vendor_Name,
    Vendor_GSTIN: vendor.GSTIN || '',
    RFQ_ID: String(payload.rfqId || '').trim(),
    PQ_ID: String(payload.quoteId || '').trim(),
    Lines: lines,
    Subtotal: round2(lines.reduce((s, l) => s + l.Line_Total, 0)),
    Payment_Terms: String(payload.paymentTerms || vendor.Payment_Terms || '').trim(),
    Expected_Date: String(payload.expectedDate || '').trim(),
    Notes: String(payload.notes || '').trim(),
    Status: PO_STATUS.ISSUED,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString()
  };
  await sheetsService.insertRow('Purchase_Order', row);

  if (row.RFQ_ID) {
    await sheetsService.updateRow('Purchase_RFQ', 'RFQ_ID', row.RFQ_ID, {
      Status: RFQ_STATUS.CLOSED, Converted_PO_ID: row.PO_ID, Updated_At: new Date().toISOString()
    });
  }
  return row;
}

async function getPurchaseOrders() {
  const rows = await sheetsService.getTab('Purchase_Order');
  return [...rows].sort((a, b) => String(b.Created_At || '').localeCompare(String(a.Created_At || '')));
}

async function getPurchaseOrderById(poId) {
  const rows = await sheetsService.getTab('Purchase_Order');
  return rows.find(p => p.PO_ID === poId) || null;
}

async function cancelPurchaseOrder(poId, reason, actor) {
  const po = await getPurchaseOrderById(poId);
  if (!po) throw new Error(`Purchase order ${poId} not found`);
  if ((po.Lines || []).some(l => Number(l.Received_Qty) > 0)) {
    throw new Error('Goods have already been received against this order — it cannot be cancelled');
  }
  return sheetsService.updateRow('Purchase_Order', 'PO_ID', poId, {
    Status: PO_STATUS.CANCELLED,
    Cancel_Reason: String(reason || '').trim(),
    Cancelled_By: actor?.staffId || 'SYSTEM',
    Cancelled_At: new Date().toISOString()
  });
}

// ─── GOODS RECEIPT ─────────────────────────────────────────────────────────────────────────────

/**
 * Receives goods against a purchase order: the only place in this module that moves stock.
 *
 * Freight is entered once for the whole delivery and spread across the lines by value, so each item
 * carries its true landed cost. That cost then blends into the item's moving average, and the stock
 * value is rewritten in the same call as the quantity so the two cannot drift apart.
 *
 * Short and over deliveries are both recorded rather than rejected — the delivery already happened,
 * and refusing to record it would leave the ledger disagreeing with the shelf.
 */
async function postGoodsReceipt(payload, actor) {
  const po = await getPurchaseOrderById(String(payload.poId || '').trim());
  if (!po) throw new Error('A valid purchase order is required');
  if (po.Status === PO_STATUS.CANCELLED) throw new Error('This purchase order has been cancelled');

  const requested = (Array.isArray(payload.lines) ? payload.lines : [])
    .map(l => ({
      lineId: String(l.lineId || '').trim(),
      receivedQty: Number(l.receivedQty) || 0,
      otherCharges: Number(l.otherCharges) || 0,
      notes: String(l.notes || '').trim()
    }))
    .filter(l => l.receivedQty > 0);

  if (requested.length === 0) throw new Error('Enter the quantity received for at least one line');

  // Marry each received line to its order line, so the price comes from the PO rather than from
  // whatever the receiving screen posted — a store-keeper cannot see prices and must not set them.
  const priced = requested.map(r => {
    const poLine = (po.Lines || []).find(l => l.lineId === r.lineId);
    if (!poLine) throw new Error(`Line ${r.lineId} is not on purchase order ${po.PO_No}`);
    return {
      ...r,
      itemId: poLine.Item_ID,
      itemName: poLine.Item_Name,
      unit: poLine.Unit,
      orderedQty: Number(poLine.Qty) || 0,
      unitPrice: Number(poLine.Rate) || 0
    };
  });

  const costed = landedCostService.computeLandedCosts(priced, payload.totalCharges);

  const grnId = newId('GRN');
  const receiptLines = [];

  for (const line of costed) {
    let stockResult = null;
    let costResult = null;
    let error = '';

    if (line.itemId) {
      try {
        // One call updates the ledger, the rollup quantity, the moving-average cost and the stock
        // value together — see inventoryService.recordInward.
        stockResult = await inventoryService.recordInward({
          itemId: line.itemId,
          qty: line.receivedQty,
          unit: line.unit,
          unitCost: line.Landed_Unit_Cost,
          vendorId: po.Vendor_ID,
          supplierName: po.Vendor_Name,
          supplierInvoiceNo: String(payload.vendorInvoiceNo || '').trim(),
          poId: po.PO_ID,
          grnId,
          notes: `GRN against ${po.PO_No}`,
          recordedBy: actor?.staffId || 'SYSTEM',
          date: payload.receiptDate || istToday()
        });
        costResult = stockResult?.cost || null;

        // Reference only — never used for valuation, which is what Moving_Avg_Cost is for.
        await sheetsService.updateRow('Item_Master', 'Item_ID', line.itemId, {
          Last_Purchase_Rate: line.unitPrice,
          Last_Landed_Cost: line.Landed_Unit_Cost,
          Last_Purchase_Date: payload.receiptDate || istToday(),
          Last_Vendor_ID: po.Vendor_ID
        });
      } catch (e) {
        // A stock failure must not lose the receipt: the goods are physically here either way.
        error = e.message;
      }
    }

    receiptLines.push({
      lineId: line.lineId,
      Item_ID: line.itemId,
      Item_Name: line.itemName,
      Unit: line.unit,
      Ordered_Qty: line.orderedQty,
      Received_Qty: line.receivedQty,
      Short_Qty: round2(Math.max(0, line.orderedQty - line.receivedQty)),
      Excess_Qty: round2(Math.max(0, line.receivedQty - line.orderedQty)),
      Unit_Price: line.unitPrice,
      Line_Total: line.lineTotal,
      Allocated_Charges: line.Allocated_Charges,
      Other_Charges: line.Other_Charges,
      Landed_Total: line.Landed_Total,
      Landed_Unit_Cost: line.Landed_Unit_Cost,
      Moving_Avg_After: costResult?.movingAvgCost ?? null,
      Notes: line.notes,
      Inventory_Error: error
    });
  }

  const grn = {
    GRN_ID: grnId,
    GRN_No: `GRN/${istToday().slice(2, 7).replace('-', '')}/${Date.now().toString().slice(-4)}`,
    GRN_Date: payload.receiptDate || istToday(),
    PO_ID: po.PO_ID,
    PO_No: po.PO_No,
    Vendor_ID: po.Vendor_ID,
    Vendor_Name: po.Vendor_Name,
    Vendor_Invoice_No: String(payload.vendorInvoiceNo || '').trim(),
    Vendor_Invoice_Amount: round2(Number(payload.vendorInvoiceAmount) || 0),
    Total_Charges: round2(Number(payload.totalCharges) || 0),
    Lines: receiptLines,
    Invoice_Total: round2(receiptLines.reduce((s, l) => s + l.Line_Total, 0)),
    Landed_Total: round2(receiptLines.reduce((s, l) => s + l.Landed_Total, 0)),
    Has_Discrepancy: receiptLines.some(l => l.Short_Qty > 0 || l.Excess_Qty > 0),
    Vendor_Rating: Number(payload.vendorRating) || 0,
    Notes: String(payload.notes || '').trim(),
    Received_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString()
  };
  await sheetsService.insertRow('Goods_Receipt', grn);

  // Roll the received quantities back onto the order so a second delivery knows what is outstanding.
  const receivedByLine = {};
  for (const l of receiptLines) receivedByLine[l.lineId] = l.Received_Qty;
  const updatedLines = (po.Lines || []).map(l => ({
    ...l,
    Received_Qty: round2((Number(l.Received_Qty) || 0) + (receivedByLine[l.lineId] || 0))
  }));
  const fullyReceived = updatedLines.every(l => (Number(l.Received_Qty) || 0) >= (Number(l.Qty) || 0));

  const updatedPo = await sheetsService.updateRow('Purchase_Order', 'PO_ID', po.PO_ID, {
    Lines: updatedLines,
    Status: fullyReceived ? PO_STATUS.RECEIVED : PO_STATUS.PARTIAL,
    Updated_At: new Date().toISOString()
  });

  if (grn.Vendor_Rating > 0) {
    await recordVendorRating(po.Vendor_ID, grn.Vendor_Rating);
  }

  return { grn, purchaseOrder: updatedPo };
}

/** Running average of every rating a vendor has been given, kept on the vendor record. */
async function recordVendorRating(vendorId, rating) {
  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendor = vendors.find(v => v.Vendor_ID === vendorId);
  if (!vendor) return null;

  const count = (Number(vendor.Rating_Count) || 0) + 1;
  const total = (Number(vendor.Rating_Total) || 0) + Number(rating);
  return sheetsService.updateRow('Vendor_Master', 'Vendor_ID', vendorId, {
    Rating_Count: count,
    Rating_Total: total,
    Rating_Average: round2(total / count)
  });
}

async function getGoodsReceipts() {
  const rows = await sheetsService.getTab('Goods_Receipt');
  return [...rows].sort((a, b) => String(b.Created_At || '').localeCompare(String(a.Created_At || '')));
}

/** Items at or below their reorder level, with the vendor last bought from as a starting point. */
async function getReorderSuggestions() {
  const [lowStock, items, vendors] = await Promise.all([
    inventoryService.getLowStock(),
    sheetsService.getTab('Item_Master'),
    sheetsService.getTab('Vendor_Master')
  ]);
  const itemById = Object.fromEntries(items.map(i => [i.Item_ID, i]));
  const vendorById = Object.fromEntries(vendors.map(v => [v.Vendor_ID, v]));

  return lowStock.map(row => {
    const item = itemById[row.Item_ID] || {};
    const vendor = vendorById[item.Last_Vendor_ID] || null;
    return {
      Item_ID: row.Item_ID,
      Item_Name: row.Item_Name,
      Unit: row.Unit,
      Current_Qty: row.Current_Qty,
      Reorder_Level: row.Reorder_Level,
      Suggested_Qty: Math.max(1, round2((Number(row.Reorder_Level) || 0) * 2 - (Number(row.Current_Qty) || 0))),
      Last_Vendor_ID: item.Last_Vendor_ID || '',
      Last_Vendor_Name: vendor?.Vendor_Name || '',
      Last_Purchase_Rate: item.Last_Purchase_Rate ?? null
    };
  });
}

module.exports = {
  RFQ_STATUS,
  PO_STATUS,
  getVendors,
  createVendor,
  updateVendor,
  createRfq,
  getRfqs,
  getRfqById,
  recordQuote,
  compareQuotes,
  createPurchaseOrder,
  getPurchaseOrders,
  getPurchaseOrderById,
  cancelPurchaseOrder,
  postGoodsReceipt,
  getGoodsReceipts,
  getReorderSuggestions
};
