const sheetsService = require('./sheetsService');
const quotationEngine = require('./quotationEngine');

/**
 * priceListService — the rate memory that builds itself.
 *
 * Nobody sits down and types a price list. Instead every quotation the customer is sent and every
 * invoice raised against them deposits the rate that was actually used, so the list fills in as the
 * business runs. Resolution then answers "what do we charge this customer for this item?" without
 * anyone having maintained anything.
 *
 * Priority is deliberate: the customer's own agreed rate beats what they were last quoted, which
 * beats the catalogue's standard rate. Every answer carries its source so the UI can show which
 * numbers were filled in automatically and which a human still needs to look at.
 */

const SOURCES = { QUOTATION: 'QUOTATION', INVOICE: 'INVOICE', MANUAL: 'MANUAL' };

const RATE_SOURCE = {
  PRICE_LIST: 'PRICE_LIST',
  LAST_QUOTED: 'LAST_QUOTED',
  STANDARD: 'STANDARD',
  NONE: 'NONE'
};

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function newPriceId() {
  return `CPL${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Records one (customer, item) rate.
 *
 * Two guards stop the automatic writes doing damage:
 *
 * A LOCKED row is an admin's deliberate correction. Without the guard the very next invoice would
 * silently revert it, and the admin would have no way to make a correction stick.
 *
 * An INVOICE rate outranks a QUOTATION rate agreed the same day or earlier: a quotation is an ask,
 * an invoice is what was actually agreed. Otherwise a quotation dispatched after the invoice was
 * raised would quietly downgrade the settled figure.
 */
async function upsertPrice({ customerId, itemId, itemName, rate, source, sourceDocId, sourceDocNo, locked }, actor) {
  if (!customerId || !itemId) return null;
  const value = Number(rate) || 0;
  if (value <= 0) return null;

  const rows = await sheetsService.getCustomerPriceList(customerId);
  const existing = rows.find(r => r.Item_ID === itemId) || null;

  if (existing?.Locked && source !== SOURCES.MANUAL) return existing;
  if (existing?.Source === SOURCES.INVOICE && source === SOURCES.QUOTATION
      && String(existing.Effective_From || '') >= istToday()) {
    return existing;
  }

  const payload = {
    Customer_ID: customerId,
    Item_ID: itemId,
    Item_Name: itemName || existing?.Item_Name || '',
    Rate: value,
    Source: source || SOURCES.MANUAL,
    Source_Doc_ID: sourceDocId || '',
    Source_Doc_No: sourceDocNo || '',
    Effective_From: istToday(),
    Locked: locked !== undefined ? Boolean(locked) : Boolean(existing?.Locked),
    Updated_By: actor?.staffId || 'SYSTEM',
    Updated_At: new Date().toISOString(),
    Updated_At_Ms: Date.now()
  };

  if (existing) {
    return sheetsService.updateRow('Customer_Price_List', 'Price_ID', existing.Price_ID, payload);
  }
  const row = { Price_ID: newPriceId(), ...payload, Created_At: istToday() };
  await sheetsService.insertRow('Customer_Price_List', row);
  return row;
}

/** Fans a document's line items into the price list. Never throws — see the call sites. */
async function recordFromDocument(doc, source, { docId, docNo }, actor) {
  const lines = Array.isArray(doc?.Line_Items) ? doc.Line_Items : [];
  const saved = [];
  for (const line of lines) {
    if (!line.Item_ID) continue;
    const row = await upsertPrice({
      customerId: doc.Customer_ID,
      itemId: line.Item_ID,
      itemName: line.Item_Name,
      rate: line.Rate,
      source,
      sourceDocId: docId,
      sourceDocNo: docNo
    }, actor);
    if (row) saved.push(row);
  }
  return saved;
}

async function recordFromQuotation(quotation, actor) {
  return recordFromDocument(quotation, SOURCES.QUOTATION, {
    docId: quotation?.Quotation_ID,
    docNo: quotation?.Quote_No_Display || quotation?.Quote_No
  }, actor);
}

async function recordFromInvoice(invoice, actor) {
  return recordFromDocument(invoice, SOURCES.INVOICE, {
    docId: invoice?.Invoice_ID,
    docNo: invoice?.Invoice_No
  }, actor);
}

async function getPriceList(customerId) {
  const rows = await sheetsService.getCustomerPriceList(customerId);
  return rows.sort((a, b) => String(a.Item_Name || '').localeCompare(String(b.Item_Name || '')));
}

async function setManualPrice(customerId, itemId, { rate, locked, itemName }, actor) {
  return upsertPrice({
    customerId, itemId, itemName, rate,
    source: SOURCES.MANUAL, sourceDocId: '', sourceDocNo: '', locked
  }, actor);
}

async function deletePrice(priceId) {
  return sheetsService.deleteRow('Customer_Price_List', 'Price_ID', priceId);
}

/**
 * Resolves rates for many items in one pass.
 *
 * Bulk on purpose: getLastQuotedRate scans every quotation in the database per item, so calling it
 * once per line on a twelve-line challan would be twelve full-collection scans. getLastQuotedRates
 * builds the whole map in a single pass instead.
 */
async function resolveRates(customerId, itemIds = []) {
  const wanted = [...new Set(itemIds.filter(Boolean))];
  const out = {};
  if (wanted.length === 0) return out;

  const [priceRows, quotedMap, items] = await Promise.all([
    customerId ? sheetsService.getCustomerPriceList(customerId) : Promise.resolve([]),
    customerId ? quotationEngine.getLastQuotedRates(customerId) : Promise.resolve({}),
    sheetsService.getAllItems()
  ]);

  const priceByItem = {};
  priceRows.forEach(r => { priceByItem[r.Item_ID] = r; });
  const itemsById = {};
  items.forEach(i => { itemsById[i.Item_ID] = i; });

  for (const itemId of wanted) {
    const pl = priceByItem[itemId];
    if (pl && Number(pl.Rate) > 0) {
      const how = pl.Source === SOURCES.INVOICE ? 'agreed on invoice'
        : pl.Source === SOURCES.QUOTATION ? 'from quotation' : 'set manually';
      out[itemId] = {
        rate: Number(pl.Rate),
        source: RATE_SOURCE.PRICE_LIST,
        sourceLabel: `Customer price list — ${how}${pl.Source_Doc_No ? ` ${pl.Source_Doc_No}` : ''}`,
        docNo: pl.Source_Doc_No || '',
        locked: Boolean(pl.Locked)
      };
      continue;
    }

    const quoted = quotedMap[itemId];
    if (quoted && Number(quoted.rate) > 0) {
      out[itemId] = {
        rate: Number(quoted.rate),
        source: RATE_SOURCE.LAST_QUOTED,
        sourceLabel: `Last quoted to this customer on ${quoted.quoteNo || ''} ${quoted.quotedOn || ''}`.trim(),
        docNo: quoted.quoteNo || '',
        locked: false
      };
      continue;
    }

    const standard = Number(itemsById[itemId]?.Standard_Rate) || 0;
    out[itemId] = standard > 0
      ? { rate: standard, source: RATE_SOURCE.STANDARD, sourceLabel: 'Standard rate from Item Master', docNo: '', locked: false }
      : { rate: 0, source: RATE_SOURCE.NONE, sourceLabel: 'No rate on record — please enter', docNo: '', locked: false };
  }

  return out;
}

module.exports = {
  SOURCES,
  RATE_SOURCE,
  upsertPrice,
  recordFromQuotation,
  recordFromInvoice,
  getPriceList,
  setManualPrice,
  deletePrice,
  resolveRates
};
