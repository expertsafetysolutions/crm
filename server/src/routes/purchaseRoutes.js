const express = require('express');
const { authenticateToken } = require('./authRoutes');
const { requirePermission } = require('../utils/permissions');
const moneyMask = require('../utils/moneyMask');
const purchaseService = require('../services/purchaseService');

/**
 * Procurement routes: vendors, enquiries, purchase orders and goods receipt.
 *
 * Its own router rather than more lines in apiRoutes.js, which is already ~3900 lines. Every path
 * here is new, so nothing can shadow an existing one — but the literal-before-:id rule still applies
 * within this file (see /purchase-orders/reorder-suggestions below).
 *
 * Both middlewares are re-applied here because this router is mounted separately and does not
 * inherit apiRoutes' stack. Forgetting the mask would leave costs readable by a store-keeper.
 */
const router = express.Router();

router.use(authenticateToken);
router.use(moneyMask.middleware());

/** Shared error shape: 4xx for a rejected business rule, 500 for a genuine fault. */
function fail(res, err, fallback, log) {
  console.error(log, err);
  res.status(err.statusCode || 400).json({ error: err.message || fallback });
}

// ─── VENDORS ───────────────────────────────────────────────────────────────────────────────────

router.get('/vendors', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getVendors({ includeInactive: req.query.includeInactive === 'true' }));
  } catch (err) { fail(res, err, 'Failed to load vendors', 'GET /vendors error:'); }
});

router.post('/vendors', requirePermission('purchase', 'add'), async (req, res) => {
  try {
    res.json(await purchaseService.createVendor(req.body, req.user));
  } catch (err) { fail(res, err, 'Failed to create vendor', 'POST /vendors error:'); }
});

router.put('/vendors/:id', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    res.json(await purchaseService.updateVendor(req.params.id, req.body));
  } catch (err) { fail(res, err, 'Failed to update vendor', 'PUT /vendors error:'); }
});

// ─── ENQUIRIES (RFQ) ───────────────────────────────────────────────────────────────────────────

router.get('/rfqs', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getRfqs());
  } catch (err) { fail(res, err, 'Failed to load enquiries', 'GET /rfqs error:'); }
});

router.post('/rfqs', requirePermission('purchase', 'add'), async (req, res) => {
  try {
    res.json(await purchaseService.createRfq(req.body, req.user));
  } catch (err) { fail(res, err, 'Failed to create enquiry', 'POST /rfqs error:'); }
});

/**
 * Prices a vendor quote for onward sale: vendor rate + margin % = selling rate.
 *
 * LITERAL "quotes" segment, so it must sit above /rfqs/:id or that route claims it. A GET would be
 * tidier, but margin and rounding are inputs the buyer changes repeatedly while watching the
 * result, so they belong in a body.
 */
router.post('/rfqs/quotes/:quoteId/price-for-customer', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.priceQuoteForCustomer(req.params.quoteId, req.body));
  } catch (err) { fail(res, err, 'Failed to price the quote', 'POST /price-for-customer error:'); }
});

// Literal segments before /:id — /rfqs/:id would otherwise swallow these.
router.get('/rfqs/:id/compare', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.compareQuotes(req.params.id));
  } catch (err) { fail(res, err, 'Failed to compare quotes', 'GET /rfqs/compare error:'); }
});

router.post('/rfqs/:id/quotes', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    res.json(await purchaseService.recordQuote(req.params.id, req.body, req.user));
  } catch (err) { fail(res, err, 'Failed to record the quote', 'POST /rfqs/quotes error:'); }
});

router.get('/rfqs/:id', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    const rfq = await purchaseService.getRfqById(req.params.id);
    if (!rfq) return res.status(404).json({ error: 'Enquiry not found' });
    res.json(rfq);
  } catch (err) { fail(res, err, 'Failed to load enquiry', 'GET /rfqs/:id error:'); }
});

// ─── PURCHASE ORDERS ───────────────────────────────────────────────────────────────────────────

router.get('/purchase-orders', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getPurchaseOrders());
  } catch (err) { fail(res, err, 'Failed to load purchase orders', 'GET /purchase-orders error:'); }
});

// LITERAL — must stay ahead of /purchase-orders/:id, or ":id" swallows the word.
router.get('/purchase-orders/reorder-suggestions', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getReorderSuggestions());
  } catch (err) { fail(res, err, 'Failed to load reorder suggestions', 'GET /reorder-suggestions error:'); }
});

// LITERAL — same rule. The Accounts payment queue.
router.get('/purchase-orders/pending-payment', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getPendingPayments());
  } catch (err) { fail(res, err, 'Failed to load pending payments', 'GET /pending-payment error:'); }
});

router.post('/purchase-orders', requirePermission('purchase', 'add'), async (req, res) => {
  try {
    res.json(await purchaseService.createPurchaseOrder(req.body, req.user));
  } catch (err) { fail(res, err, 'Failed to create purchase order', 'POST /purchase-orders error:'); }
});

router.post('/purchase-orders/:id/cancel', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    res.json(await purchaseService.cancelPurchaseOrder(req.params.id, req.body.reason, req.user));
  } catch (err) { fail(res, err, 'Failed to cancel purchase order', 'POST /purchase-orders/cancel error:'); }
});

router.get('/purchase-orders/:id', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    const po = await purchaseService.getPurchaseOrderById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    res.json(po);
  } catch (err) { fail(res, err, 'Failed to load purchase order', 'GET /purchase-orders/:id error:'); }
});

// ─── 3-WAY MATCH AND PAYMENT ───────────────────────────────────────────────────────────────────

router.get('/purchase-orders/:id/match', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getThreeWayMatch(req.params.id));
  } catch (err) { fail(res, err, 'Failed to build the match', 'GET /purchase-orders/match error:'); }
});

/**
 * Releases payment. Gated on `edit` rather than `view` because it is a financial decision, and the
 * 409 carries the match summary so the screen can say exactly what disagrees.
 */
router.post('/purchase-orders/:id/release-payment', requirePermission('purchase', 'edit'), async (req, res) => {
  try {
    res.json(await purchaseService.releasePayment(req.params.id, req.body, req.user));
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, match: err.match });
    }
    fail(res, err, 'Failed to release payment', 'POST /release-payment error:');
  }
});

// ─── GOODS RECEIPT ─────────────────────────────────────────────────────────────────────────────

router.get('/grns', requirePermission('purchase', 'view'), async (req, res) => {
  try {
    res.json(await purchaseService.getGoodsReceipts());
  } catch (err) { fail(res, err, 'Failed to load goods receipts', 'GET /grns error:'); }
});

/**
 * Posts a receipt: the only route in this module that moves stock. Gated on inventory:add as well
 * as purchase:add, because it writes to the stock ledger and the two permissions are held by
 * different people — a buyer raises the order, a store-keeper receives against it.
 */
router.post('/grns', requirePermission('purchase', 'add'), requirePermission('inventory', 'add'), async (req, res) => {
  try {
    res.json(await purchaseService.postGoodsReceipt(req.body, req.user));
  } catch (err) { fail(res, err, 'Failed to post goods receipt', 'POST /grns error:'); }
});

module.exports = router;
