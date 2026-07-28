const sheetsService = require('./sheetsService');

/**
 * inventoryService — stock ledger for Module E.
 *
 * Stock_Transactions is the append-only source of truth; Inventory_Master carries the
 * read-optimized Current_Qty rollup. Every mutation appends a transaction and then updates the
 * rollup in the same call, so no separate reconciliation job is needed at this data scale.
 */

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const TYPES = {
  INWARD: 'Inward',
  USAGE: 'Usage',
  SALE_DEDUCTION: 'Sale_Deduction',
  ADJUSTMENT: 'Adjustment'
};

async function ensureInventoryRow(itemId, unit) {
  const existing = await sheetsService.getInventoryByItem(itemId);
  if (existing) return existing;

  const item = await sheetsService.getItemById(itemId);
  const row = {
    Inventory_ID: `INV${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
    Item_ID: itemId,
    Item_Name: item?.Item_Name || '',
    Warehouse_Location: 'MAIN',
    Current_Qty: 0,
    Reorder_Level: Number(item?.Reorder_Level) || 0,
    Unit: unit || item?.Unit || 'Nos',
    Last_Updated_At: new Date().toISOString()
  };
  await sheetsService.insertRow('Inventory_Master', row);
  return row;
}

/**
 * Core ledger write. Direction is decided by transaction type: inward adds, usage/sale deductions
 * subtract, and callers pass a positive magnitude for those.
 *
 * ADJUSTMENT is the exception — it honours the SIGN of `qty`, because a stock-count correction has
 * to be able to go either way. Forcing it through Math.abs() (as every type once was) made a
 * negative adjustment silently ADD stock, so shortfalls could never be corrected.
 */
async function recordTransaction({ itemId, type, qty, unit, supplierName, supplierInvoiceNo, clientId, site, linkedInvoiceId, notes, recordedBy, date }) {
  if (!itemId) throw new Error('itemId is required');
  const raw = Number(qty) || 0;
  const magnitude = Math.abs(raw);
  if (magnitude === 0) throw new Error('Quantity must be non-zero');

  const inventoryRow = await ensureInventoryRow(itemId, unit);
  const isOutward = type === TYPES.USAGE || type === TYPES.SALE_DEDUCTION;
  const signedQty = type === TYPES.ADJUSTMENT ? raw : (isOutward ? -magnitude : magnitude);
  const balanceAfter = (Number(inventoryRow.Current_Qty) || 0) + signedQty;

  const transaction = {
    Transaction_ID: `STK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
    Item_ID: itemId,
    Item_Name: inventoryRow.Item_Name || '',
    Type: type,
    Qty: signedQty,
    Unit: unit || inventoryRow.Unit || 'Nos',
    Supplier_Name: supplierName || '',
    Supplier_Invoice_No: supplierInvoiceNo || '',
    Client_ID: clientId || '',
    Site: site || '',
    Linked_Invoice_ID: linkedInvoiceId || '',
    Notes: notes || '',
    Balance_After: balanceAfter,
    Date: date || istToday(),
    Recorded_By: recordedBy || 'SYSTEM',
    Created_At: new Date().toISOString()
  };

  await sheetsService.insertRow('Stock_Transactions', transaction);
  await sheetsService.updateRow('Inventory_Master', 'Item_ID', itemId, {
    Current_Qty: balanceAfter,
    Last_Updated_At: new Date().toISOString()
  });

  return { transaction, balanceAfter };
}

async function recordInward(payload) {
  return recordTransaction({ ...payload, type: TYPES.INWARD });
}

async function recordUsage(payload) {
  return recordTransaction({ ...payload, type: TYPES.USAGE });
}

async function recordAdjustment(payload) {
  return recordTransaction({ ...payload, type: TYPES.ADJUSTMENT });
}

/**
 * Deducts every line item on a Sales Invoice from stock.
 *
 * Deliberately does NOT block on insufficient stock: an invoice has already been issued to a
 * customer by the time this runs, so refusing the deduction would leave the ledger silently out of
 * step with reality. Shortfalls are allowed to go negative and reported back so the UI can flag
 * them for correction.
 */
async function deductForInvoice(invoice, actor) {
  const lines = Array.isArray(invoice.Line_Items) ? invoice.Line_Items : [];
  const results = [];

  for (const line of lines) {
    if (!line.Item_ID) continue;
    try {
      const { balanceAfter } = await recordTransaction({
        itemId: line.Item_ID,
        type: TYPES.SALE_DEDUCTION,
        qty: line.Qty,
        unit: line.Unit,
        clientId: invoice.Customer_ID,
        linkedInvoiceId: invoice.Invoice_ID,
        notes: `Auto-deducted on invoice ${invoice.Invoice_No || invoice.Invoice_ID}`,
        recordedBy: actor?.staffId || 'SYSTEM'
      });
      results.push({
        itemId: line.Item_ID,
        itemName: line.Item_Name,
        qty: Number(line.Qty) || 0,
        balanceAfter,
        wentNegative: balanceAfter < 0
      });
    } catch (e) {
      results.push({ itemId: line.Item_ID, itemName: line.Item_Name, error: e.message });
    }
  }

  const shortfalls = results.filter(r => r.wentNegative);

  // Only a shortfall reaches the timeline. A normal deduction is bookkeeping the office does not
  // need narrated; stock going negative is a problem someone has to act on.
  if (shortfalls.length > 0) {
    const interactionLogger = require('./interactionLogger');
    await interactionLogger.logEvent({
      tag: interactionLogger.EVENT_TAG.STOCK_SHORT,
      summary: `${shortfalls.length} item(s) short on invoice ${invoice.Invoice_No || invoice.Invoice_ID}`
        + ` | ${shortfalls.map(s => `${s.itemName} (${s.balanceAfter})`).join(', ')}`,
      taskId: invoice.Task_ID,
      customerId: invoice.Customer_ID,
      actor
    });
  }

  return {
    deductedCount: results.filter(r => !r.error).length,
    shortfalls,
    results
  };
}

async function getBalances() {
  const [rows, items] = await Promise.all([
    sheetsService.getInventory(),
    sheetsService.getAllItems()
  ]);
  const itemById = {};
  items.forEach(i => { itemById[i.Item_ID] = i; });

  return rows.map(r => {
    const item = itemById[r.Item_ID] || {};
    const currentQty = Number(r.Current_Qty) || 0;
    const reorderLevel = Number(r.Reorder_Level ?? item.Reorder_Level) || 0;
    return {
      ...r,
      Item_Name: r.Item_Name || item.Item_Name || '',
      Unit: r.Unit || item.Unit || 'Nos',
      Reorder_Level: reorderLevel,
      Is_Low_Stock: reorderLevel > 0 && currentQty <= reorderLevel
    };
  });
}

async function getLowStock() {
  const balances = await getBalances();
  return balances.filter(b => b.Is_Low_Stock);
}

/**
 * Consumption report over Usage + Sale_Deduction transactions, optionally narrowed by date range,
 * item, or client. Returns per-item totals plus the matching raw transactions.
 */
async function getConsumptionReport({ fromDate, toDate, itemId, clientId } = {}) {
  const transactions = await sheetsService.getStockTransactions();

  const filtered = transactions.filter(t => {
    if (t.Type !== TYPES.USAGE && t.Type !== TYPES.SALE_DEDUCTION) return false;
    if (fromDate && String(t.Date) < fromDate) return false;
    if (toDate && String(t.Date) > toDate) return false;
    if (itemId && t.Item_ID !== itemId) return false;
    if (clientId && t.Client_ID !== clientId) return false;
    return true;
  });

  const byItem = {};
  for (const t of filtered) {
    if (!byItem[t.Item_ID]) {
      byItem[t.Item_ID] = { Item_ID: t.Item_ID, Item_Name: t.Item_Name || '', Unit: t.Unit || 'Nos', Total_Consumed: 0, Transaction_Count: 0 };
    }
    byItem[t.Item_ID].Total_Consumed += Math.abs(Number(t.Qty) || 0);
    byItem[t.Item_ID].Transaction_Count++;
  }

  return {
    fromDate: fromDate || '',
    toDate: toDate || '',
    summary: Object.values(byItem).sort((a, b) => b.Total_Consumed - a.Total_Consumed),
    transactions: filtered.sort((a, b) => String(b.Date).localeCompare(String(a.Date)))
  };
}

module.exports = {
  TYPES,
  recordTransaction,
  recordInward,
  recordUsage,
  recordAdjustment,
  deductForInvoice,
  getBalances,
  getLowStock,
  getConsumptionReport,
  ensureInventoryRow
};
