/**
 * Client-side quotation helpers — display formatting and the status vocabulary shared by the
 * builder, list views and PDF template. Money math is NOT duplicated here: totals always come
 * from the server (POST /api/quotations/preview) so the figures shown, saved and printed can
 * never drift apart.
 */

export const QUOTATION_STATUS_META = {
  Draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  PendingApproval: { label: 'Pending Approval', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  Sent: { label: 'Sent', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  Revised: { label: 'Superseded', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  Accepted: { label: 'Accepted', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  RevisionRequested: { label: 'Revision Requested', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  RequirementChangeRequested: { label: 'Change Requested', cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  Rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  Expired: { label: 'Expired', cls: 'bg-rose-50 text-rose-600 border-rose-200' },
  Converted: { label: 'Converted', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' }
};

export const ORDER_LOST_REASONS = ['Price High', 'Competitor', 'Delay', 'Requirement Cancelled', 'Other'];

/** Payment_Status vocabulary for Sales_Invoice_Master, set by conversionService.recordPayment(). */
export const PAYMENT_STATUS_META = {
  Unpaid: { label: 'Unpaid', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  'Partially Paid': { label: 'Partially Paid', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  Paid: { label: 'Paid', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  Cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
};

/** Document-level Status for PI_Master / Sales_Invoice_Master rows. */
export const DOC_STATUS_META = {
  Issued: { label: 'Issued', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  Converted: { label: 'Converted', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  Cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
};

export const PAYMENT_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card', 'Other'];

function metaFrom(table, status) {
  return table[status] || { label: status || 'Unknown', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
}

export function statusMeta(status) {
  return metaFrom(QUOTATION_STATUS_META, status);
}

export function paymentStatusMeta(status) {
  return metaFrom(PAYMENT_STATUS_META, status);
}

export function docStatusMeta(status) {
  return metaFrom(DOC_STATUS_META, status);
}

/** Outstanding amount on an invoice, floored at zero so overpayment never shows as negative. */
export function balanceDue(invoice) {
  return Math.max(0, (Number(invoice?.Grand_Total) || 0) - (Number(invoice?.Amount_Paid) || 0));
}

/**
 * Mirrors quotationCronService.runPaymentDueReminders(): an invoice is chased while it is neither
 * paid nor cancelled and carries a due date.
 */
export function isChasable(invoice) {
  const s = String(invoice?.Payment_Status || '').toLowerCase();
  return s !== 'paid' && s !== 'cancelled' && Boolean(invoice?.Due_Date);
}

/** Negative = days remaining, positive = days overdue. Null when there is no due date. */
export function daysPastDue(dueDate) {
  if (!dueDate) return null;
  const today = new Date(`${todayISO()}T00:00:00`);
  const due = new Date(`${String(dueDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((today - due) / 86400000);
}

export function formatMoney(amount, withSymbol = true) {
  const n = Number(amount) || 0;
  const formatted = n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? `₹${formatted}` : formatted;
}

/** dd/mm/yyyy for display; input is the ISO yyyy-mm-dd the server stores. */
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('-');
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/** Converts a number to Indian-format words for the PDF's "Amount in words" line. */
export function amountInWords(amount) {
  const num = Math.floor(Number(amount) || 0);
  if (num === 0) return 'Zero Rupees Only';

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const twoDigit = (n) => n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const threeDigit = (n) => {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${h ? ones[h] + ' Hundred' : ''}${h && rest ? ' ' : ''}${rest ? twoDigit(rest) : ''}`;
  };

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const rest = num % 1000;

  const parts = [];
  if (crore) parts.push(`${threeDigit(crore)} Crore`);
  if (lakh) parts.push(`${threeDigit(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigit(thousand)} Thousand`);
  if (rest) parts.push(threeDigit(rest));

  const paise = Math.round(((Number(amount) || 0) - num) * 100);
  const rupeesPart = `${parts.join(' ')} Rupees`;
  return paise > 0 ? `${rupeesPart} and ${twoDigit(paise)} Paise Only` : `${rupeesPart} Only`;
}

/** True when a UPI settings value is a full scanner deep link rather than a plain VPA. */
export function isUpiDeepLink(value) {
  return /^upi:\/\//i.test(String(value || '').trim());
}

/**
 * Pulls the payee VPA out of a "upi://pay?pa=…" deep link. URLSearchParams already decodes, and a
 * malformed percent-escape would throw mid-render, so the whole read is defensive.
 */
export function extractUpiVpa(deepLink) {
  let pa;
  try {
    pa = new URLSearchParams(String(deepLink).split('?')[1] || '').get('pa') || '';
  } catch {
    return '';
  }
  // A bad percent-escape decodes to U+FFFD rather than throwing; a VPA containing one is corrupt
  // and must not reach the printed document.
  if (!pa || pa.includes('�')) return '';
  return pa.trim();
}

/**
 * Builds a UPI payment URI for the PDF QR code.
 * Format per NPCI's UPI deep-link spec: upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR
 */
export function buildUpiUri({ upiId, payeeName, amount, note }) {
  if (!upiId) return '';
  const params = new URLSearchParams();
  params.set('pa', upiId);
  if (payeeName) params.set('pn', payeeName);
  if (amount) params.set('am', Number(amount).toFixed(2));
  params.set('cu', 'INR');
  if (note) params.set('tn', note);
  return `upi://pay?${params.toString()}`;
}

/** A blank line-item row for the builder grid. */
export function emptyLineItem(defaultGstRate = 18) {
  return {
    Item_ID: '',
    Item_Name: '',
    HSN_Code: '',
    Qty: 1,
    Unit: 'Nos',
    Rate: 0,
    GST_Rate: defaultGstRate,
    Discount_Pct: 0,
    Discount_Amt: 0,
    // Free-text note typed per line and printed under the item on the PDF. Kept SEPARATE from
    // Long_Description, which is catalogue copy auto-filled from the item master — editing that
    // here would read as changing the product itself, and would be overwritten on re-pick.
    Remarks: ''
  };
}

export function isEditable(status) {
  return status === 'Draft' || status === 'PendingApproval';
}

export function isDispatchable(status) {
  return status === 'Draft';
}

export function canRevise(status) {
  return ['Sent', 'RevisionRequested', 'RequirementChangeRequested', 'Rejected', 'Expired'].includes(status);
}
