const sheetsService = require('./sheetsService');

/**
 * interactionLogger — writes automatic entries into a task's discussion timeline.
 *
 * Customer_Interactions is the "Complete Remarks & Interaction History" panel: the running story of
 * a job, where each row shows a coloured tag, the staff member's name and a line of text. Before
 * this, almost everything in there was typed by hand — the modules themselves left no trace, so
 * reconstructing a job meant opening four different pages.
 *
 * Every module now calls logEvent() after it does something, and dispatchService calls logDispatch()
 * for outbound mail. Both land in the same panel, attributed to whoever did the work.
 *
 * Deliberately writes ONLY to Customer_Interactions. Activity_Logs is a separate, staff-facing
 * stream owned by workflowEngine and the offline-sync routes; duplicating module events into it
 * would create two half-complete histories instead of one good one.
 *
 * Called from the service layer rather than the routes, so offline-queue replays and cron-driven
 * actions are logged on the same path as ordinary HTTP calls.
 */

// Tag shown on the timeline entry for a dispatch. One per channel.
const TAG = { Email: 'Email', WhatsApp: 'Whatsapp' };

/**
 * Every tag the modules write. Kept here as the single source of truth so the server and the two
 * client badge lists cannot drift; the client's REMARK_TAGS mirrors these.
 */
const EVENT_TAG = {
  MATERIAL_RECEIVED: 'Material Received',
  WORK_IN_PROGRESS: 'Work In Progress',
  RECHECK_DONE: 'Recheck Done',
  STANDBY_ISSUED: 'Standby Issued',
  STANDBY_RETURNED: 'Standby Returned',
  // The customer kept a loaner instead of returning it. Its own tag because this is the exception
  // that lets a delivery close with company equipment still on site — it must be findable later.
  STANDBY_RETAINED: 'Standby Retained',
  SERVICE_COMPLETE: 'Service Complete',
  CHALLAN_GENERATED: 'Challan Generated',
  CHALLAN_ISSUED: 'Challan Issued',
  DELIVERED: 'Delivered',
  CERTIFICATE_GENERATED: 'Certificate Generated',
  QUOTATION_GENERATED: 'Quotation Generated',
  ORDER_CONFIRMED: 'Order Confirmed',
  PI_GENERATED: 'PI Generated',
  INVOICE_GENERATED: 'Invoice Generated',
  PAYMENT_RECEIVED: 'Payment Received',
  STOCK_SHORT: 'Stock Short'
};

/**
 * What each template key is called in the timeline. Keyed by the same template key the dispatch
 * used, so the label can never drift from the message that actually went out.
 */
const ACTION_LABEL = {
  quotation_email: 'Quotation send for',
  quotation_whatsapp: 'Quotation send for',
  followup_reminder: 'Quotation Follow-up Mailed',
  invoice_payment_due: 'Payment FLP Mailed',
  pi_email: 'Proforma Invoice Mailed',
  invoice_email: 'Tax Invoice Mailed',
  challan_email: 'Delivery Challan Mailed',
  certificate_email: 'Certificate Mailed'
};

/**
 * Money as it reads on the timeline: "₹8,850.00". Shared so a payment entry and an invoice entry
 * cannot end up formatted differently in the same panel.
 */
function formatAmount(value) {
  const n = Number(value) || 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Reference number, whichever document shape this is. Mirrors dispatchService.buildVars(). */
function referenceNo(doc) {
  return doc.Quote_No_Display || doc.Quote_No || doc.PI_No || doc.Invoice_No
    || doc.Challan_No || doc.Certificate_No || doc.certificateNo || '';
}

function taskIdOf(doc) {
  return doc.Task_ID || doc.taskId || '';
}

function customerIdOf(doc) {
  return doc.Customer_ID || doc.customerId || '';
}

/**
 * Human-readable line for the timeline, e.g.
 *   "Quotation send for Annual Maintenance | Ref No: EXPERT/26-27/QUT/006 | To: buyer@acme.com"
 *
 * The subject is included only when the document has one — a challan or certificate does not, and
 * an empty " for " reads like a bug.
 */
function buildRemark({ templateKey, doc, result }) {
  let label = ACTION_LABEL[templateKey] || 'Document Mailed';
  const subject = String(doc.Subject || '').trim();
  const ref = referenceNo(doc);

  // "Quotation send for" only reads correctly with a subject after it. Without one it would sit in
  // the timeline as a dangling half-sentence, so fall back to a self-contained label.
  if (label.endsWith('for') && !subject) label = 'Quotation Mailed';

  const parts = [subject && label.endsWith('for') ? `${label} ${subject}` : label];
  if (ref) parts.push(`Ref No: ${ref}`);
  if (result.recipient) parts.push(`To: ${result.recipient}`);
  // Safe mode still counts as sent, but saying so plainly keeps the timeline honest — otherwise it
  // would claim the customer was written to when the mail went to the demo inbox.
  if (result.safeModeRedirectedTo) parts.push(`SAFE MODE — actually delivered to ${result.safeModeRedirectedTo}`);
  return parts.join(' | ');
}

/**
 * Resolves the display name for the timeline entry.
 *
 * Staff_Name is what the panel actually shows next to the badge. Services only ever carry a
 * staffId, so the name is looked up here — a row reading "STAFF005" instead of "Nilesh Padaya"
 * would read as a bug to the office. Falls back to the id if the lookup fails, and to 'System'
 * when nothing human triggered the action (a cron, or a customer acting on the portal).
 */
async function resolveActor(actor) {
  const staffId = actor?.staffId;
  if (!staffId || staffId === 'SYSTEM') return { Staff_ID: 'SYSTEM', Staff_Name: 'System' };
  if (actor.name) return { Staff_ID: staffId, Staff_Name: actor.name };
  try {
    const staff = await sheetsService.getStaffById(staffId);
    return { Staff_ID: staffId, Staff_Name: staff?.Name || staffId };
  } catch (e) {
    return { Staff_ID: staffId, Staff_Name: staffId };
  }
}

/**
 * Writes one automatic entry into the task's discussion timeline.
 *
 * `tag` becomes the coloured badge, `summary` the line of text beneath it. System_Generated marks
 * it as machine-written, which is what makes the client hide the edit button on it.
 *
 * Never throws: a timeline entry is a record OF work, not part of it, so failing to write one must
 * never fail the job card, invoice or payment that triggered it.
 */
async function logEvent({ tag, summary, taskId, customerId, actor }) {
  // With neither id the row could never surface on any timeline — skip rather than write litter.
  if (!taskId && !customerId) return null;
  if (!tag || !summary) return null;

  try {
    const nowMs = Date.now();
    const who = await resolveActor(actor);
    const entry = {
      Interaction_ID: `INT_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      Created_At: nowMs,
      Customer_ID: customerId || '',
      Task_ID: taskId || '',
      Timestamp: new Date().toISOString(),
      Type: tag,
      ...who,
      Remarks: summary,
      System_Generated: true
    };
    await sheetsService.insertRow('Customer_Interactions', entry);
    return entry;
  } catch (e) {
    console.error(`Timeline entry "${tag}" failed (the action itself still succeeded):`, e.message);
    return null;
  }
}

/**
 * Records one timeline entry per channel that actually delivered.
 *
 * Only successes are logged. A failure is already surfaced twice — in the document's Dispatch_Log
 * and in the response the user sees — and writing "we tried to email you" into the customer
 * conversation history would make the timeline harder to trust, not easier.
 *
 * Never throws and never rejects: a timeline write failing must not turn a delivered email into a
 * reported error. Returns the entries written, for tests and callers that want them.
 */
async function logDispatch({ doc, templateKey, results, actor }) {
  const sent = (results || []).filter(r => r && r.ok);
  if (sent.length === 0) return [];

  const customerId = customerIdOf(doc);
  const taskId = taskIdOf(doc);

  const written = [];
  for (const result of sent) {
    const entry = await logEvent({
      tag: TAG[result.channel] || result.channel || 'Email',
      summary: buildRemark({ templateKey, doc, result }),
      taskId,
      customerId,
      actor
    });
    if (entry) written.push(entry);
  }
  return written;
}

module.exports = {
  TAG,
  EVENT_TAG,
  ACTION_LABEL,
  buildRemark,
  referenceNo,
  formatAmount,
  logEvent,
  logDispatch
};
