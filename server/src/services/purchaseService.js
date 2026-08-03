const sheetsService = require('./sheetsService');
const inventoryService = require('./inventoryService');
const landedCostService = require('./landedCostService');
const quotationEngine = require('./quotationEngine');
const interactionLogger = require('./interactionLogger');
const { round2, computeDocumentTotals, extractStateCode } = require('../utils/gstUtils');

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

/** Calendar date `days` from now on the office's clock. Never toISOString — the server may not be IST. */
function istDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
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

// What a vendor actually supplies, so an enquiry for valves is not sent to the uniform supplier.
// Free text rather than a fixed enum: it merges with the item catalogue's own categories, and a
// buyer who needs a new one at 6pm must not have to wait for an admin to add it to a master list.
// De-duplicated case-insensitively — "Valves" and "valves" from two typists is one category.
function normalizeCategories(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  const seen = new Map();
  for (const c of raw) {
    const name = String(c || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

// A supplier is rarely one phone number: sales quotes, accounts chases the payment, the driver
// calls about the gate. Same shape as the inquiry form's Extra_Contacts so both read alike.
// Rows with no name AND no phone are dropped — an empty row someone tabbed past is not a contact.
function normalizeContacts(input) {
  return (Array.isArray(input) ? input : [])
    .map(c => ({
      name: String(c?.name || '').trim(),
      designation: String(c?.designation || '').trim(),
      phone: String(c?.phone || '').trim(),
      email: String(c?.email || '').trim()
    }))
    .filter(c => c.name || c.phone);
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
    Product_Categories: normalizeCategories(payload.productCategories),
    Extra_Contacts: normalizeContacts(payload.extraContacts),
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
  // Not in the map above: that loop String()s every value, which would turn the array into "a,b".
  if (payload.productCategories !== undefined) {
    patch.Product_Categories = normalizeCategories(payload.productCategories);
  }
  if (payload.extraContacts !== undefined) {
    patch.Extra_Contacts = normalizeContacts(payload.extraContacts);
  }

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
/**
 * Prices a purchase order exactly the way a quotation is priced.
 *
 * A PO is a tax document we ISSUE — the vendor bills against it — so the same
 * `computeDocumentTotals` that produces a quotation's figures produces these, including line
 * discounts and a document-level discount. Before this, the PDF re-derived GST from `Lines` in the
 * browser, which meant the printed total and the stored `Subtotal` were computed by two different
 * pieces of code, and only one of them knew about discounts.
 *
 * Place of supply comes from the VENDOR's GSTIN, not the customer's: on a purchase we are the
 * recipient, so an out-of-state supplier charges IGST. Falls back to intra-state when either GSTIN
 * is missing, which is the same assumption the old client-side maths made.
 */
function priceLines(payload, vendor, seller, existingLines = []) {
  const receivedByLineId = new Map(
    (existingLines || []).map(l => [l.lineId, Number(l.Received_Qty) || 0])
  );

  const raw = (Array.isArray(payload.lines) ? payload.lines : []).map((l, i) => {
    const lineId = l.lineId || `PL${i}${Date.now().toString(36)}`;
    return {
      lineId,
      Item_ID: String(l.itemId || l.Item_ID || '').trim(),
      Item_Name: String(l.itemName || l.Item_Name || '').trim(),
      HSN_Code: String(l.hsnCode || l.HSN_Code || '').trim(),
      Specification: String(l.specification || l.Specification || '').trim(),
      Remarks: String(l.remarks || l.Remarks || '').trim(),
      Qty: Number(l.qty ?? l.Qty) || 0,
      Unit: String(l.unit || l.Unit || 'Nos').trim(),
      Rate: Number(l.rate ?? l.Rate) || 0,
      Discount_Pct: Number(l.discountPct ?? l.Discount_Pct) || 0,
      GST_Rate: Number(l.gstRate ?? l.GST_Rate) || 0,
      // Carried through pricing so an edit cannot reset what has already arrived.
      Received_Qty: Number(l.Received_Qty) || receivedByLineId.get(lineId) || 0
    };
  }).filter(l => l.Item_Name);

  // The vendor's GSTIN encodes their state in its first two digits, and that is the right answer
  // whenever it exists. An explicit sourceStateCode is the fallback for an unregistered supplier:
  // without it a vendor with no GSTIN silently priced as intra-state CGST/SGST, which is the wrong
  // tax on a real purchase order and there was no way to correct it. Mirrors the quotation
  // builder's "Place of supply", which solves the identical problem for a B2C customer.
  const vendorState = extractStateCode(vendor?.GSTIN || '')
    || String(payload.sourceStateCode || '').trim();
  const sellerState = extractStateCode(seller?.gstin || '');
  const gstType = (vendorState && sellerState && vendorState !== sellerState) ? 'IGST' : 'CGST_SGST';

  const totals = computeDocumentTotals({
    lineItems: raw,
    gstType,
    documentDiscountPct: Number(payload.documentDiscountPct) || 0,
    documentDiscountAmt: Number(payload.documentDiscountAmt) || 0
  });

  return { lines: totals.lineItems, totals, gstType, sourceStateCode: vendorState };
}

/**
 * When the next vendor chase-up should fire.
 *
 * Must NOT simply re-arm from today on every save: editing a PO would push the date forward each
 * time and a reminder on a 7-day cadence would never fire for anyone who touches the order weekly.
 * An existing date is therefore preserved untouched, and only a CHANGED interval re-arms it —
 * which is what someone adjusting the cadence is asking for.
 */
function nextReminderDate(payload, existing) {
  const days = Math.max(0, Number(payload.reminderIntervalDays) || 0);
  if (days === 0) return '';                       // turned off — stop chasing

  const prevDays = Math.max(0, Number(existing?.Reminder_Interval_Days) || 0);
  const prevDate = String(existing?.Next_Reminder_Date || '').trim();
  if (prevDate && prevDays === days) return prevDate;

  // Armed from TODAY, never from the PO date, so switching this on for an order raised last month
  // does not fire an immediate backlog of overdue reminders.
  return istDateOffset(days);
}

/**
 * The document fields a PO shares with a quotation — subject, terms, notes — so the two builders
 * write the same shape and `QuotationPdfTemplate` needs no PO-specific branch to render them.
 */
function documentFields(payload, vendor, totals, gstType, existing = null) {
  return {
    Subject: String(payload.subject || '').trim(),
    Payment_Terms: String(payload.paymentTerms || vendor.Payment_Terms || '').trim(),
    Payment_Terms_ID: String(payload.paymentTermsId || '').trim(),
    Selected_TNC_IDs: Array.isArray(payload.selectedTncIds) ? payload.selectedTncIds : [],
    Expected_Date: String(payload.expectedDate || '').trim(),
    Notes: String(payload.notes || '').trim(),
    /*
     * Auto-chase cadence, opt-in per order. 0 (the default) means never — most orders arrive before
     * anyone would chase them, and a blanket default would mail every vendor in the book.
     *
     * Next_Reminder_Date is armed from TODAY rather than the PO date, so setting an interval on an
     * order raised last month does not fire an immediate backlog of overdue reminders.
     */
    Reminder_Interval_Days: Math.max(0, Number(payload.reminderIntervalDays) || 0),
    Next_Reminder_Date: nextReminderDate(payload, existing),
    // Despatch details. Optional everywhere and printed only when filled, so an order that needs
    // none looks exactly as it did before these existed.
    Despatch_Through: String(payload.despatchThrough || '').trim(),
    Agent_Name: String(payload.agentName || '').trim(),
    Vehicle_No: String(payload.vehicleNo || '').trim(),
    GST_Type: gstType,
    // Recorded so a saved PO keeps the basis its tax was split on, even if the vendor's GSTIN is
    // added or corrected later — the same reason a quotation stores Destination_State_Code.
    Source_State_Code: String(payload.sourceStateCode || '').trim(),
    Subtotal: totals.Subtotal,
    Gross_Total: totals.Gross_Total,
    Line_Discount_Total: totals.Line_Discount_Total,
    Document_Level_Discount_Pct: totals.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: totals.Document_Level_Discount_Amt,
    Total_CGST: totals.Total_CGST,
    Total_SGST: totals.Total_SGST,
    Total_IGST: totals.Total_IGST,
    Total_GST: totals.Total_GST,
    Grand_Total: totals.Grand_Total
  };
}

/** Live totals for the builder, computed by the same code that will save them. */
async function previewPurchaseOrder(payload) {
  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendor = vendors.find(v => v.Vendor_ID === String(payload.vendorId || '').trim()) || {};
  const settings = await quotationEngine.getSettings();
  const { lines, totals, gstType } = priceLines(payload, vendor, settings.seller_profile || {});
  return { ...totals, Lines: lines, GST_Type: gstType };
}

/**
 * Purchase Orders never carried a Task_ID — they aren't part of the Sales/Production pipeline, only
 * Vendor_ID. That meant a PO event could only ever be logged customer/vendor-keyed, and the task
 * board's timeline only matches a Task_ID-less interaction by Customer_ID — which a Vendor_ID never
 * equals — so no PO activity could ever surface where telecalling staff actually work from. This
 * creates a real Task_Master row (mirroring createQuotationFollowUpTask in apiRoutes.js) so PO
 * events can be logged against a real Task_ID and finally show up on the board.
 */
async function createPurchaseOrderTask(po, actor) {
  const task = {
    Task_ID: newId('TASK'),
    Description: `Purchase Order Follow-up - ${po.PO_No} - ${po.Vendor_Name}`,
    Assigned_Staff: actor?.staffId || '',
    Department: 'Purchase',
    Stage: 'Purchase Order',
    Type: 'One-time',
    Scheduled_Date: istToday(),
    Status: 'Pending',
    PO_ID: po.PO_ID,
    PO_No: po.PO_No,
    Vendor_ID: po.Vendor_ID,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: istToday()
  };
  await sheetsService.insertRow('Task_Master', task);
  return task;
}

async function createPurchaseOrder(payload, actor) {
  const vendorId = String(payload.vendorId || '').trim();
  if (!vendorId) throw new Error('A vendor is required');

  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendor = vendors.find(v => v.Vendor_ID === vendorId);
  if (!vendor) throw new Error(`Vendor ${vendorId} not found`);

  const settings = await quotationEngine.getSettings();
  const { lines, totals, gstType } = priceLines(payload, vendor, settings.seller_profile || {});

  if (lines.length === 0) throw new Error('A purchase order needs at least one line');

  const existing = await sheetsService.getTab('Purchase_Order');
  let poNo = String(payload.poNo || '').trim();
  if (poNo) {
    if (existing.some(p => String(p.PO_No || '').trim().toLowerCase() === poNo.toLowerCase())) {
      throw new Error(`Purchase order number "${poNo}" already exists`);
    }
  } else {
    poNo = await quotationEngine.nextDocumentNumber(
      settings.defaults?.po_no_prefix || 'PO',
      settings.defaults?.number_reset,
      { existing, field: 'PO_No' }
    );
  }

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
    ...documentFields(payload, vendor, totals, gstType),
    Status: PO_STATUS.ISSUED,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString()
  };

  const task = await createPurchaseOrderTask(row, actor);
  row.Task_ID = task.Task_ID;
  await sheetsService.insertRow('Purchase_Order', row);

  if (row.RFQ_ID) {
    await sheetsService.updateRow('Purchase_RFQ', 'RFQ_ID', row.RFQ_ID, {
      Status: RFQ_STATUS.CLOSED, Converted_PO_ID: row.PO_ID, Updated_At: new Date().toISOString()
    });
  }

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.PO_GENERATED,
    summary: `${row.PO_No} | ${interactionLogger.formatAmount(row.Grand_Total)} | ${row.Vendor_Name}`,
    taskId: task.Task_ID,
    customerId: vendorId,
    actor
  });

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
  const cancelReason = String(reason || '').trim();
  const updated = await sheetsService.updateRow('Purchase_Order', 'PO_ID', poId, {
    Status: PO_STATUS.CANCELLED,
    Cancel_Reason: cancelReason,
    Cancelled_By: actor?.staffId || 'SYSTEM',
    Cancelled_At: new Date().toISOString()
  });

  // Logged against the PO's own follow-up task (created with the order) — no second task for a
  // cancellation, same principle as everywhere else a document is superseded rather than reborn.
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.PO_CANCELLED,
    summary: `${po.PO_No}${cancelReason ? ` | ${cancelReason}` : ''}`,
    taskId: po.Task_ID,
    customerId: po.Vendor_ID,
    actor
  });

  return updated;
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

// ─── 3-WAY MATCH ───────────────────────────────────────────────────────────────────────────────

/**
 * Compares what was ORDERED, what ARRIVED, and what the vendor BILLED, before anyone pays.
 *
 * These three should agree and frequently do not: a vendor ships forty of the fifty ordered and
 * invoices for fifty, or quietly bills a higher rate than the order carried. Catching that after
 * payment means asking for money back, which rarely works. So the check runs before release, and a
 * mismatch does not block payment — it just refuses to call itself matched, because Accounts may
 * have a perfectly good reason (an agreed part-shipment, a renegotiated rate) that no rule knows.
 *
 * Tolerance exists because rounding differs between systems: a vendor's invoice computed line by
 * line and ours computed on the total will disagree by paise on a large order, and flagging that as
 * a discrepancy every time would train people to ignore the flag.
 */
const MATCH_TOLERANCE = 1.00;   // rupees — below this, treat amounts as agreeing

const MATCH_STATUS = {
  MATCHED: 'Matched',
  SHORT_DELIVERY: 'Short Delivery',
  OVER_DELIVERY: 'Over Delivery',
  PRICE_VARIANCE: 'Price Variance',
  OVER_BILLED: 'Over Billed',
  AWAITING_INVOICE: 'Awaiting Invoice',
  AWAITING_GOODS: 'Awaiting Goods'
};

/**
 * Builds the match for one purchase order across every receipt against it.
 *
 * Aggregates receipts rather than matching one at a time: a two-delivery order is complete when the
 * quantities add up, and matching each delivery in isolation would report both as short.
 */
async function getThreeWayMatch(poId) {
  const po = await getPurchaseOrderById(poId);
  if (!po) throw new Error(`Purchase order ${poId} not found`);

  const grns = (await sheetsService.getTab('Goods_Receipt')).filter(g => g.PO_ID === poId);

  // Roll every receipt up per order line.
  const receivedByLine = {};
  const billedByLine = {};
  for (const grn of grns) {
    for (const l of (grn.Lines || [])) {
      receivedByLine[l.lineId] = round2((receivedByLine[l.lineId] || 0) + (Number(l.Received_Qty) || 0));
      billedByLine[l.lineId] = round2((billedByLine[l.lineId] || 0) + (Number(l.Line_Total) || 0));
    }
  }

  const lines = (po.Lines || []).map(l => {
    const orderedQty = Number(l.Qty) || 0;
    const receivedQty = receivedByLine[l.lineId] || 0;
    const orderedValue = Number(l.Line_Total) || 0;
    const receivedValue = billedByLine[l.lineId] || 0;

    // What the goods actually received SHOULD cost at the agreed rate. Comparing the vendor's bill
    // against this rather than against the whole order is what separates a short delivery (fine,
    // pay for what came) from over-billing (not fine).
    const expectedValue = round2(receivedQty * (Number(l.Rate) || 0));

    const qtyVariance = round2(receivedQty - orderedQty);
    const valueVariance = round2(receivedValue - expectedValue);

    let status = MATCH_STATUS.MATCHED;
    if (receivedQty === 0) status = MATCH_STATUS.AWAITING_GOODS;
    else if (Math.abs(valueVariance) > MATCH_TOLERANCE) status = MATCH_STATUS.PRICE_VARIANCE;
    else if (qtyVariance < 0) status = MATCH_STATUS.SHORT_DELIVERY;
    else if (qtyVariance > 0) status = MATCH_STATUS.OVER_DELIVERY;

    return {
      lineId: l.lineId,
      Item_ID: l.Item_ID,
      Item_Name: l.Item_Name,
      Unit: l.Unit,
      Ordered_Qty: orderedQty,
      Received_Qty: receivedQty,
      Qty_Variance: qtyVariance,
      Rate: Number(l.Rate) || 0,
      Ordered_Value: orderedValue,
      Expected_Value: expectedValue,
      Received_Value: receivedValue,
      Value_Variance: valueVariance,
      Status: status
    };
  });

  // The vendor's own invoice figure, when the receiving clerk captured one.
  const vendorInvoiceTotal = round2(grns.reduce((s, g) => s + (Number(g.Vendor_Invoice_Amount) || 0), 0));
  const expectedTotal = round2(lines.reduce((s, l) => s + l.Expected_Value, 0));
  const invoiceVariance = vendorInvoiceTotal > 0 ? round2(vendorInvoiceTotal - expectedTotal) : 0;

  const problems = lines.filter(l => l.Status !== MATCH_STATUS.MATCHED);
  let overall = MATCH_STATUS.MATCHED;
  if (grns.length === 0) overall = MATCH_STATUS.AWAITING_GOODS;
  else if (vendorInvoiceTotal === 0) overall = MATCH_STATUS.AWAITING_INVOICE;
  else if (invoiceVariance > MATCH_TOLERANCE) overall = MATCH_STATUS.OVER_BILLED;
  else if (problems.length > 0) overall = problems[0].Status;

  return {
    purchaseOrder: {
      PO_ID: po.PO_ID, PO_No: po.PO_No, PO_Date: po.PO_Date,
      Vendor_ID: po.Vendor_ID, Vendor_Name: po.Vendor_Name,
      Subtotal: po.Subtotal, Status: po.Status,
      Payment_Released: Boolean(po.Payment_Released),
      Payment_Released_At: po.Payment_Released_At || '',
      Payment_Release_Note: po.Payment_Release_Note || ''
    },
    receipts: grns.map(g => ({
      GRN_ID: g.GRN_ID, GRN_No: g.GRN_No, GRN_Date: g.GRN_Date,
      Vendor_Invoice_No: g.Vendor_Invoice_No,
      Vendor_Invoice_Amount: g.Vendor_Invoice_Amount,
      Has_Discrepancy: g.Has_Discrepancy
    })),
    lines,
    summary: {
      Ordered_Total: round2(lines.reduce((s, l) => s + l.Ordered_Value, 0)),
      Expected_Total: expectedTotal,
      Vendor_Invoice_Total: vendorInvoiceTotal,
      Invoice_Variance: invoiceVariance,
      Match_Status: overall,
      Is_Matched: overall === MATCH_STATUS.MATCHED,
      Problem_Count: problems.length,
      Tolerance: MATCH_TOLERANCE
    }
  };
}

/** Every order that has been received but not yet paid — the Accounts queue. */
async function getPendingPayments() {
  const pos = await getPurchaseOrders();
  const open = pos.filter(p =>
    p.Status !== PO_STATUS.CANCELLED && p.Status !== PO_STATUS.DRAFT && !p.Payment_Released);

  const out = [];
  for (const po of open) {
    const match = await getThreeWayMatch(po.PO_ID);
    // Nothing has arrived yet, so there is nothing to pay for.
    if (match.summary.Match_Status === MATCH_STATUS.AWAITING_GOODS) continue;
    out.push({
      PO_ID: po.PO_ID, PO_No: po.PO_No, Vendor_Name: po.Vendor_Name, PO_Date: po.PO_Date,
      ...match.summary
    });
  }
  return out;
}

/**
 * Records that Accounts has released payment.
 *
 * A mismatch does not block the release, but it does force a written note. Accounts often has a good
 * reason the rule cannot know — a part-shipment everyone agreed to, a rate renegotiated by phone —
 * and refusing the release would just move the payment off the system entirely. Recording WHY is
 * worth more than preventing it.
 */
async function releasePayment(poId, { note, paidAmount } = {}, actor) {
  const match = await getThreeWayMatch(poId);
  const text = String(note || '').trim();

  if (!match.summary.Is_Matched && !text) {
    const err = new Error(`This order does not match (${match.summary.Match_Status}) — add a note explaining why it is being paid`);
    err.statusCode = 409;
    err.match = match.summary;
    throw err;
  }

  const releasedAmount = round2(Number(paidAmount) || match.summary.Expected_Total);
  const updated = await sheetsService.updateRow('Purchase_Order', 'PO_ID', poId, {
    Payment_Released: true,
    Payment_Released_At: new Date().toISOString(),
    Payment_Released_By: actor?.staffId || 'SYSTEM',
    Payment_Release_Note: text,
    Payment_Released_Amount: releasedAmount,
    Payment_Match_Status: match.summary.Match_Status,
    Updated_At: new Date().toISOString()
  });

  const po = await getPurchaseOrderById(poId);
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.VENDOR_PAYMENT_RELEASED,
    summary: `${interactionLogger.formatAmount(releasedAmount)} to ${po?.Vendor_Name || 'vendor'} | ${po?.PO_No || poId}`
      + `${text ? ` | ${text}` : ''}`,
    taskId: po?.Task_ID,
    customerId: po?.Vendor_ID,
    actor
  });

  return updated;
}

// ─── VENDOR QUOTE → CUSTOMER QUOTATION ─────────────────────────────────────────────────────────

/**
 * Prices a vendor's quote for onward sale: vendor rate + margin % = selling rate.
 *
 * Margin here is a MARK-UP on cost, not a margin on the selling price — 20% on a ₹100 buy gives
 * ₹120, not ₹125. That is how the office actually quotes ("cost plus twenty"), and picking the other
 * reading would silently under-price every line by a few percent.
 *
 * Returns priced lines for the quotation builder rather than creating a quotation outright: the
 * customer, subject and terms still have to be chosen, and the builder already owns all of that
 * along with GST, discounts and numbering. This is the pricing step, not a second quotation engine.
 */
function buildMarginPricing({ lines, marginPct, roundTo }) {
  const margin = Number(marginPct) || 0;
  const rounding = Number(roundTo) || 0;

  const priced = (Array.isArray(lines) ? lines : []).map(l => {
    const cost = Number(l.Rate ?? l.rate) || 0;
    const raw = round2(cost * (1 + margin / 100));
    // Optional rounding to a tidy figure — a quotation reading ₹1,180 looks considered where
    // ₹1,176.47 looks like a spreadsheet leaked onto the page.
    const sellingRate = rounding > 0 ? Math.ceil(raw / rounding) * rounding : raw;
    const qty = Number(l.Qty ?? l.qty) || 0;
    return {
      Item_ID: l.Item_ID || l.itemId || '',
      Item_Name: l.Item_Name || l.itemName || '',
      Qty: qty,
      Unit: l.Unit || l.unit || 'Nos',
      GST_Rate: Number(l.GST_Rate ?? l.gstRate) || 0,
      Purchase_Rate: cost,
      Rate: sellingRate,
      Line_Total: round2(qty * sellingRate),
      Margin_Pct: margin,
      Margin_Amount: round2((sellingRate - cost) * qty)
    };
  });

  const costTotal = round2(priced.reduce((s, l) => s + l.Purchase_Rate * l.Qty, 0));
  const sellTotal = round2(priced.reduce((s, l) => s + l.Line_Total, 0));

  return {
    lines: priced,
    summary: {
      Cost_Total: costTotal,
      Selling_Total: sellTotal,
      Margin_Amount: round2(sellTotal - costTotal),
      // Realised margin can drift from the requested one once rounding is applied, so it is
      // reported rather than assumed.
      Effective_Margin_Pct: costTotal > 0 ? round2(((sellTotal - costTotal) / costTotal) * 100) : 0,
      Requested_Margin_Pct: margin
    }
  };
}

/** Prices a stored vendor quote for onward sale. */
async function priceQuoteForCustomer(quoteId, { marginPct, roundTo } = {}) {
  const quotes = await sheetsService.getTab('Purchase_Quote');
  const quote = quotes.find(q => q.PQ_ID === quoteId);
  if (!quote) throw new Error(`Vendor quote ${quoteId} not found`);

  const rfq = await getRfqById(quote.RFQ_ID);
  const settings = await quotationEngine.getSettings();
  const margin = marginPct !== undefined && marginPct !== null && marginPct !== ''
    ? Number(marginPct)
    : Number(settings.defaults?.default_margin_pct ?? 20);

  // Carry the enquiry's item ids and units across — a vendor quote only echoes back what it was
  // asked, and the quotation builder needs the catalogue link for HSN and stock.
  const enriched = (quote.Lines || []).map(l => {
    const rfqLine = (rfq?.Lines || []).find(x => x.lineId === l.lineId) || {};
    return { ...l, Item_ID: rfqLine.Item_ID || '', Unit: rfqLine.Unit || 'Nos' };
  });

  const priced = buildMarginPricing({ lines: enriched, marginPct: margin, roundTo });
  return {
    ...priced,
    source: {
      PQ_ID: quote.PQ_ID, RFQ_ID: quote.RFQ_ID,
      Vendor_ID: quote.Vendor_ID, Vendor_Name: quote.Vendor_Name,
      Quote_Total: quote.Quote_Total,
      Lead_Time_Days: quote.Lead_Time_Days
    }
  };
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

async function updatePurchaseOrder(poId, payload, actor) {
  const vendorId = String(payload.vendorId || '').trim();
  if (!vendorId) throw new Error('Vendor is required');
  const vendors = await getVendors({ includeInactive: true });
  const vendor = vendors.find(v => v.Vendor_ID === vendorId);
  if (!vendor) throw new Error('Vendor not found');

  const existing = await getPurchaseOrderById(poId);
  const settings = await quotationEngine.getSettings();
  const { lines, totals, gstType } = priceLines(
    payload, vendor, settings.seller_profile || {}, existing?.Lines || []
  );

  if (lines.length === 0) throw new Error('A purchase order needs at least one line');

  const patch = {
    PO_Date: payload.poDate || istToday(),
    Vendor_ID: vendorId,
    Vendor_Name: vendor.Vendor_Name,
    Vendor_GSTIN: vendor.GSTIN || '',
    Lines: lines,
    ...documentFields(payload, vendor, totals, gstType, existing),
    Updated_At: new Date().toISOString()
  };

  const saved = await sheetsService.updateRow('Purchase_Order', 'PO_ID', poId, patch);
  if (!saved) throw new Error(`Purchase order ${poId} not found`);
  return saved;
}

module.exports = {
  RFQ_STATUS,
  PO_STATUS,
  MATCH_STATUS,
  MATCH_TOLERANCE,
  getThreeWayMatch,
  getPendingPayments,
  releasePayment,
  buildMarginPricing,
  priceQuoteForCustomer,
  getVendors,
  createVendor,
  updateVendor,
  createRfq,
  getRfqs,
  getRfqById,
  recordQuote,
  compareQuotes,
  previewPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  getPurchaseOrders,
  getPurchaseOrderById,
  cancelPurchaseOrder,
  postGoodsReceipt,
  getGoodsReceipts,
  getReorderSuggestions
};
