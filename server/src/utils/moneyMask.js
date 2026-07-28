const { canSeeMoney, resolvePermissions, isAdmin } = require('./permissions');

/**
 * moneyMask — strips rates, amounts and totals out of API responses for staff without `finance:view`.
 *
 * Hiding price columns in the UI alone is cosmetic: the figures still arrive in the JSON and anyone
 * can read them from the network tab. A technician's phone should never receive what a customer is
 * paying, so the stripping happens here, on the way out.
 *
 * WHY A NAME ALLOW-LIST AND NOT A PATTERN
 * A regex over /Rate|Amount|Total|Value|Price/ looks tempting and would break the app. A census of
 * the server found these non-money fields matching such a pattern:
 *
 *   GSTIN (29 uses)        an identifier
 *   idValue (27)           generic lookup helper
 *   Daily_Salary_Rate (12) payroll — a different concern, with different viewers, already gated
 *   Total_Worked_Hours     attendance hours
 *   GST_Rate (5)           a PERCENTAGE, needed to render the tax column, useless on its own
 *   Total_Qty / Total_Consumed   counts of cylinders, not money
 *   Balance_After          stock on hand after a transaction
 *   Price_ID               a row identifier
 *   completionRate         a percentage
 *   customValues           user-defined certificate fields
 *
 * Stripping any of those would break screens the user is entitled to. So the list below is exact
 * names, and every addition is a deliberate act. The cost is that a NEW money field is not masked
 * until someone adds it here — re-run the census when adding financial fields.
 *
 * WHY DELETE RATHER THAN ZERO
 * A zeroed rate is indistinguishable from a genuine zero, and the unpriced-line warning would read
 * as "this item is free" rather than "you cannot see this". Absent is honest; zero lies.
 */

// Exact field names to remove. Both casings appear in this codebase — Sheet-era PascalCase_Snake on
// stored documents, camelCase on some newer endpoints — so both are listed.
const MONEY_FIELDS = new Set([
  // Line-level (gstUtils.computeLineItem)
  'Rate', 'Gross_Value', 'Taxable_Value', 'Line_Total',
  'Discount_Amt', 'Discount_Pct', 'Apportioned_Doc_Discount',
  'CGST_Amt', 'SGST_Amt', 'IGST_Amt',

  // Document-level (gstUtils.computeDocumentTotals)
  'Gross_Total', 'Line_Discount_Total', 'Subtotal',
  'Document_Level_Discount_Pct', 'Document_Level_Discount_Amt',
  'Total_CGST', 'Total_SGST', 'Total_IGST', 'Total_GST', 'Grand_Total',
  'Effective_Discount_Pct',

  // Document / task / catalogue
  'Total_Amount', 'Amount', 'Amount_Paid', 'Balance_Due',
  'Standard_Rate', 'Quote_Amount', 'Source_Quote_Amount',
  'Current_Value', 'Advance_Amount',

  // Rate memory — the source label alone reveals what was quoted before
  'Rate_Source', 'Rate_Source_Label', 'Rate_Sources', 'Rate_Touched',

  // Cost. Arguably more sensitive than selling price: knowing both is knowing the margin, and a
  // store-keeper receiving goods has no reason to see either.
  'Unit_Price', 'Unit_Cost', 'Landed_Unit_Cost', 'Landed_Total', 'Moving_Avg_Cost',
  'Moving_Avg_After', 'Stock_Value', 'Allocated_Charges', 'Other_Charges', 'Total_Charges',
  'Invoice_Total', 'Last_Purchase_Rate', 'Last_Landed_Cost', 'Quote_Total',
  'Vendor_Invoice_Amount', 'Suggested_Rate',

  // camelCase mirrors
  'rate', 'amount', 'amountPaid', 'balanceDue', 'standardRate',
  'grossTotal', 'grandTotal', 'taxableValue', 'lineTotal', 'subtotal',
  'discountAmt', 'discountPct', 'documentDiscountPct', 'documentDiscountAmt',
  'effectiveDiscountPct', 'apportionedDocDiscount', 'totalDiscount',
  'totalAmount', 'totalPaid', 'totalLostValue', 'preDiscountTotal'
]);

/**
 * Names that LOOK financial and must survive. Not consulted at runtime — MONEY_FIELDS is the only
 * thing that removes anything — but kept as executable documentation, and asserted by the tests so
 * nobody can add one of these to MONEY_FIELDS without a test failing.
 */
const NEVER_MASK = new Set([
  'GST_Rate', 'Default_GST_Rate', 'defaultGstRate', 'gstRate', 'GST_Type',
  'Total_Qty', 'Total_Consumed', 'Item_Count', 'Qty', 'Unit',
  'Balance_After', 'Current_Qty', 'Reorder_Level',
  'Daily_Salary_Rate', 'dailySalaryRate', 'dailyRate', 'Total_Worked_Hours',
  'completionRate', 'customValues', 'Custom_Values',
  'Price_ID', 'GSTIN', 'Customer_GSTIN_Snapshot', 'HSN_Code'
]);

/**
 * Whether a value is worth walking into. Dates arrive as Date objects from Mongoose and must be
 * passed through untouched rather than shallow-copied into a plain object.
 */
function isWalkable(v) {
  return v !== null
    && typeof v === 'object'
    && !(v instanceof Date)
    && !Buffer.isBuffer(v);
}

/**
 * Returns a masked COPY. Never mutates its input.
 *
 * This is not a style preference. sheetsService.getTab() hands back its cached array BY REFERENCE on
 * a 3-second TTL, so mutating a row here would poison the cache for every request in that window —
 * including an Admin's, who would then silently lose the prices they are entitled to. Copy-on-write
 * keeps the damage contained to the response being written.
 */
function maskValue(node) {
  if (Array.isArray(node)) return node.map(maskValue);
  if (!isWalkable(node)) return node;

  const out = {};
  for (const key of Object.keys(node)) {
    if (MONEY_FIELDS.has(key)) continue;      // dropped
    out[key] = maskValue(node[key]);
  }
  return out;
}

/**
 * Masks a response payload and flags that it happened, so the client can render "hidden" rather
 * than an empty cell — a visible marker beats a silent gap when something goes wrong.
 */
function maskPayload(payload) {
  const masked = maskValue(payload);
  if (isWalkable(masked) && !Array.isArray(masked)) masked._Money_Masked = true;
  return masked;
}

/**
 * Paths whose responses carry money. Matched against req.path (the router is mounted at /api, so
 * these are the post-mount paths).
 *
 * An allow-list rather than a blanket sweep: every other endpoint is passed through untouched, so
 * adding a non-financial route can never accidentally mangle it. The trade-off is that a NEW
 * financial route is not covered until it is listed here.
 */
const MONEY_ROUTE_PATTERNS = [
  /^\/quotations(\/|$)/,
  /^\/proforma-invoices(\/|$)/,
  /^\/sales-invoices(\/|$)/,
  /^\/challans(\/|$)/,
  /^\/job-cards\/[^/]+\/generate-challan$/,
  /^\/price-list(\/|$)/,
  /^\/items(\/|$)/,
  /^\/inventory(\/|$)/,
  /^\/analytics\/order-lost$/,
  /^\/sync\/all$/,
  // Procurement. The receiving screen is used by store-keepers, who see quantities but not costs.
  /^\/vendors(\/|$)/,
  /^\/rfqs(\/|$)/,
  /^\/purchase-orders(\/|$)/,
  /^\/grns(\/|$)/,
  /^\/purchase(\/|$)/
];

function isMoneyRoute(path) {
  return MONEY_ROUTE_PATTERNS.some(re => re.test(path));
}

/**
 * Express middleware. Wraps res.json so masking happens at send time regardless of which handler
 * responds — including the actionable 409 bodies, where `unpricedLines` carries rates.
 *
 * Admin short-circuits with no database read, matching requirePermission's behaviour.
 */
function middleware() {
  const sheetsService = require('../services/sheetsService');

  return async (req, res, next) => {
    if (!isMoneyRoute(req.path)) return next();
    if (isAdmin(req.user)) return next();

    try {
      const staff = await sheetsService.getStaffById(req.user?.staffId);
      if (canSeeMoney(resolvePermissions(staff, req.user?.role))) return next();
    } catch (err) {
      // Fail CLOSED: if we cannot prove the caller may see money, assume they may not.
      console.error('moneyMask: permission check failed, masking response:', err);
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => originalJson(maskPayload(payload));
    return next();
  };
}

module.exports = {
  MONEY_FIELDS,
  NEVER_MASK,
  MONEY_ROUTE_PATTERNS,
  isMoneyRoute,
  maskValue,
  maskPayload,
  middleware
};
