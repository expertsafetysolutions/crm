const crypto = require('crypto');
const sheetsService = require('./sheetsService');
const workflowEngine = require('./workflowEngine');
const pushService = require('./pushService');
const gstUtils = require('../utils/gstUtils');
const { mergeQuotationSettings } = require('./defaultQuotationSettings');

/**
 * quotationEngine — owns the quotation-internal state machine.
 *
 * Deliberately a sibling of workflowEngine rather than part of it: quotations cycle
 * (Draft -> PendingApproval -> Sent -> RevisionRequested -> Draft R+1 -> ...) an arbitrary number
 * of times, which the flat linear switch in workflowEngine.advanceTaskStage() cannot express.
 * Task_Master.Stage is advanced here only at the coarse milestones below, via the existing
 * `targetStage` escape hatch, so the legacy Sales/Production hand-off path stays untouched.
 */

const STATUS = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'PendingApproval',
  SENT: 'Sent',
  REVISED: 'Revised',
  ACCEPTED: 'Accepted',
  REVISION_REQUESTED: 'RevisionRequested',
  REQUIREMENT_CHANGE_REQUESTED: 'RequirementChangeRequested',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  CONVERTED: 'Converted'
};

// Coarse Task_Master.Stage milestones this engine drives. Every one of these must also exist in
// workflowEngine.SALES_STAGES or department attribution breaks (see workflowEngine lines 96-101).
const TASK_STAGE = {
  DRAFT_QUOTATION: 'Draft-Quotation',
  QUOTATION_FLP: 'Quotation FLP',
  ORDER_CONFIRMATION: 'Order Confirmation',
  PI: 'PI',
  SALES_INVOICE: 'Sales Invoice',
  ORDER_CLOSED: 'Order Closed'
};

// Statuses that still warrant follow-up reminders / block annual-prospect regeneration.
const OPEN_STATUSES = [STATUS.SENT, STATUS.REVISION_REQUESTED, STATUS.REQUIREMENT_CHANGE_REQUESTED];

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function istDatePlusDays(days, from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

async function getSettings() {
  const stored = await sheetsService.getQuotationSettings('DEFAULT');
  return mergeQuotationSettings(stored);
}

/**
 * Financial-year label for document numbering, e.g. "26-27" for 2026-04-01..2027-03-31.
 * Indian FY starts in April; calendar mode falls back to the plain year.
 */
function periodLabel(resetMode) {
  const todayStr = istToday();
  const [y, m] = todayStr.split('-').map(Number);
  if (resetMode === 'calendar') return String(y);
  const startYear = m >= 4 ? y : y - 1;
  return `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}`;
}

async function nextDocumentNumber(prefix, resetMode) {
  const period = periodLabel(resetMode);
  const seq = await sheetsService.getNextSequence(`${prefix}/${period}`);
  return `${prefix}/${period}/${String(seq).padStart(3, '0')}`;
}

function newPortalGuid() {
  return crypto.randomBytes(24).toString('hex');
}

/** Snapshot of buyer identity at issue time so historical documents never shift under edits. */
function buildCustomerSnapshot(customer) {
  const gstin = gstUtils.normalizeGstin(customer.GSTIN || customer.Gst_No);
  return {
    Customer_Name_Snapshot: customer.Company_Name || '',
    Customer_Auth_Person_Snapshot: customer.Auth_Person || '',
    Customer_Address_Snapshot: customer.Billing_Address || customer.Address || '',
    Customer_GSTIN_Snapshot: gstin,
    Customer_State_Code_Snapshot: gstin ? gstUtils.extractStateCode(gstin) : String(customer.State_Code || ''),
    Customer_Email_Snapshot: customer.Email || '',
    Customer_Contact_Snapshot: customer.Contact || '',
    Customer_Type_Snapshot: customer.Customer_Type || (gstin ? 'B2B' : 'B2C')
  };
}

/**
 * Computes GST + totals for a set of line items against a buyer, and decides whether the
 * resulting discount needs Admin sign-off.
 */
async function priceQuotation({ customer, lineItems, documentDiscountPct, documentDiscountAmt, destinationStateCode }) {
  const settings = await getSettings();
  const sellerStateCode = settings.seller_profile.state_code
    || gstUtils.extractStateCode(settings.seller_profile.gstin);

  const snapshot = buildCustomerSnapshot(customer || {});
  // B2C/unregistered buyers have no GSTIN, so an explicit destination state drives place of supply.
  const buyerStateCode = snapshot.Customer_State_Code_Snapshot || String(destinationStateCode || '');

  const { gstType, isInterState, resolved } = gstUtils.determineGstType(
    sellerStateCode,
    buyerStateCode,
    snapshot.Customer_Type_Snapshot
  );

  const totals = gstUtils.computeDocumentTotals({
    lineItems,
    gstType,
    documentDiscountPct,
    documentDiscountAmt
  });

  const effPct = gstUtils.effectiveDiscountPct(totals);
  const pctTrigger = Number(settings.approval_threshold.discount_pct_trigger) || 0;
  const amtTrigger = Number(settings.approval_threshold.discount_amt_trigger) || 0;
  const totalDiscount = (totals.Line_Discount_Total || 0) + (totals.Document_Level_Discount_Amt || 0);
  const approvalRequired = (pctTrigger > 0 && effPct > pctTrigger)
    || (amtTrigger > 0 && totalDiscount > amtTrigger);

  return {
    settings,
    snapshot,
    sellerStateCode,
    buyerStateCode,
    gstType,
    isInterState,
    stateResolved: resolved,
    totals,
    effectiveDiscountPct: effPct,
    approvalRequired
  };
}

async function createQuotation(payload, actor) {
  const customer = await sheetsService.getAllCustomers()
    .then(list => list.find(c => c.Customer_ID === payload.customerId));
  if (!customer) throw new Error(`Customer ${payload.customerId} not found`);

  const priced = await priceQuotation({
    customer,
    lineItems: payload.lineItems,
    documentDiscountPct: payload.documentDiscountPct,
    documentDiscountAmt: payload.documentDiscountAmt,
    destinationStateCode: payload.destinationStateCode
  });

  const nowMs = Date.now();
  const quotationId = `QUOT${nowMs.toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
  const todayStr = istToday();
  const quoteNo = await nextDocumentNumber(
    priced.settings.defaults.quote_no_prefix,
    priced.settings.defaults.number_reset
  );

  const expiryDays = Number(payload.autoExpiryDays ?? priced.settings.defaults.auto_expiry_days);
  const followUpDays = Number(payload.followUpIntervalDays ?? priced.settings.defaults.follow_up_interval_days);

  const quotation = {
    Quotation_ID: quotationId,
    Quote_No: quoteNo,
    Revision_No: 0,
    Quote_No_Display: quoteNo,
    Parent_Quotation_ID: null,
    Root_Quotation_ID: quotationId,

    Customer_ID: customer.Customer_ID,
    ...priced.snapshot,

    Seller_State_Code: priced.sellerStateCode,
    GST_Type: priced.gstType,
    Destination_State_Code: priced.buyerStateCode,

    Line_Items: priced.totals.lineItems,
    Gross_Total: priced.totals.Gross_Total,
    Line_Discount_Total: priced.totals.Line_Discount_Total,
    Document_Level_Discount_Pct: priced.totals.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: priced.totals.Document_Level_Discount_Amt,
    Subtotal: priced.totals.Subtotal,
    Total_CGST: priced.totals.Total_CGST,
    Total_SGST: priced.totals.Total_SGST,
    Total_IGST: priced.totals.Total_IGST,
    Total_GST: priced.totals.Total_GST,
    Grand_Total: priced.totals.Grand_Total,

    Payment_Terms_ID: payload.paymentTermsId || '',
    Selected_TNC_IDs: Array.isArray(payload.selectedTncIds) ? payload.selectedTncIds : [],
    Follow_Up_Interval_Days: followUpDays,
    Auto_Expiry_Days: expiryDays,
    Expiry_Date: istDatePlusDays(expiryDays),

    Status: priced.approvalRequired ? STATUS.PENDING_APPROVAL : STATUS.DRAFT,
    Approval_Required: priced.approvalRequired,
    Effective_Discount_Pct: priced.effectiveDiscountPct,
    Approved_By: '',
    Approved_At: '',

    Subject: payload.subject || '',
    Notes: payload.notes || '',
    Assigned_Staff: payload.assignedStaff || actor?.staffId || '',
    Task_ID: payload.taskId || '',
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: todayStr,
    Created_At_Ms: nowMs,

    Portal_Guid: newPortalGuid(),
    Portal_Last_Viewed_At: '',
    Dispatch_Log: [],
    Customer_Action_Log: [],
    Next_Reminder_Date: '',
    Linked_PI_ID: '',
    Linked_Invoice_ID: '',
    Annual_Refill_Task_Generated: false
  };

  await sheetsService.insertRow('Quotation_Master', quotation);

  // Coarse milestone: the owning task (if any) enters Draft-Quotation.
  if (quotation.Task_ID) {
    await safeAdvanceTask(quotation.Task_ID, TASK_STAGE.DRAFT_QUOTATION, actor, `Quotation ${quoteNo} drafted`);
  }

  return quotation;
}

/** Re-prices an existing Draft/PendingApproval quotation in place. Issued quotations are immutable. */
async function updateQuotation(quotationId, payload, actor) {
  const existing = await sheetsService.getQuotationById(quotationId);
  if (!existing) throw new Error(`Quotation ${quotationId} not found`);
  if (![STATUS.DRAFT, STATUS.PENDING_APPROVAL].includes(existing.Status)) {
    throw new Error(`Quotation ${quotationId} is ${existing.Status} and can no longer be edited — create a revision instead`);
  }

  const customer = await sheetsService.getAllCustomers()
    .then(list => list.find(c => c.Customer_ID === existing.Customer_ID));

  const priced = await priceQuotation({
    customer: customer || {},
    lineItems: payload.lineItems !== undefined ? payload.lineItems : existing.Line_Items,
    documentDiscountPct: payload.documentDiscountPct ?? existing.Document_Level_Discount_Pct,
    documentDiscountAmt: payload.documentDiscountAmt ?? existing.Document_Level_Discount_Amt,
    destinationStateCode: payload.destinationStateCode || existing.Destination_State_Code
  });

  const updateData = {
    // Re-derive the buyer snapshot from the live customer row, so contact details fixed after the
    // quotation was drafted (a missing email, say) actually reach dispatch — which reads only these
    // Customer_*_Snapshot fields, never Customer_Master. Only DRAFT/PENDING_APPROVAL reach this
    // point (guard above), so an issued document still never shifts under a later customer edit.
    // The `customer ?` test matters: line below passes `customer || {}`, and snapshotting an empty
    // object would blank a good snapshot if the customer row had been deleted.
    ...(customer ? priced.snapshot : {}),
    GST_Type: priced.gstType,
    Destination_State_Code: priced.buyerStateCode,
    Line_Items: priced.totals.lineItems,
    Gross_Total: priced.totals.Gross_Total,
    Line_Discount_Total: priced.totals.Line_Discount_Total,
    Document_Level_Discount_Pct: priced.totals.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: priced.totals.Document_Level_Discount_Amt,
    Subtotal: priced.totals.Subtotal,
    Total_CGST: priced.totals.Total_CGST,
    Total_SGST: priced.totals.Total_SGST,
    Total_IGST: priced.totals.Total_IGST,
    Total_GST: priced.totals.Total_GST,
    Grand_Total: priced.totals.Grand_Total,
    Effective_Discount_Pct: priced.effectiveDiscountPct,
    Approval_Required: priced.approvalRequired,
    // Re-editing a quotation re-runs the threshold test: dropping the discount back under the
    // limit clears a pending approval, raising it above re-arms one.
    Status: priced.approvalRequired ? STATUS.PENDING_APPROVAL : STATUS.DRAFT,
    Updated_By: actor?.staffId || 'SYSTEM',
    Updated_At: istToday()
  };

  if (payload.paymentTermsId !== undefined) updateData.Payment_Terms_ID = payload.paymentTermsId;
  if (payload.selectedTncIds !== undefined) updateData.Selected_TNC_IDs = payload.selectedTncIds;
  if (payload.subject !== undefined) updateData.Subject = payload.subject;
  if (payload.notes !== undefined) updateData.Notes = payload.notes;
  if (payload.assignedStaff !== undefined) updateData.Assigned_Staff = payload.assignedStaff;
  if (payload.followUpIntervalDays !== undefined) updateData.Follow_Up_Interval_Days = Number(payload.followUpIntervalDays);
  if (payload.autoExpiryDays !== undefined) {
    updateData.Auto_Expiry_Days = Number(payload.autoExpiryDays);
    updateData.Expiry_Date = istDatePlusDays(payload.autoExpiryDays);
  }

  return sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, updateData);
}

async function approveQuotation(quotationId, actor) {
  const existing = await sheetsService.getQuotationById(quotationId);
  if (!existing) throw new Error(`Quotation ${quotationId} not found`);
  if (existing.Status !== STATUS.PENDING_APPROVAL) {
    throw new Error(`Quotation ${quotationId} is not awaiting approval (status: ${existing.Status})`);
  }
  return sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, {
    Status: STATUS.DRAFT,
    Approval_Required: false,
    Approved_By: actor?.staffId || 'ADMIN',
    Approved_At: new Date().toISOString()
  });
}

async function rejectQuotation(quotationId, reason, actor) {
  const existing = await sheetsService.getQuotationById(quotationId);
  if (!existing) throw new Error(`Quotation ${quotationId} not found`);
  const updated = await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, {
    Status: STATUS.REJECTED,
    Rejected_Reason: reason || '',
    Rejected_By: actor?.staffId || 'SYSTEM',
    Rejected_At: new Date().toISOString()
  });
  return updated;
}

/**
 * Creates the next revision as a NEW row, leaving the parent untouched (parent is marked Revised
 * so it drops out of follow-up queries but stays fully readable as history).
 */
async function createRevision(quotationId, payload, actor) {
  const parent = await sheetsService.getQuotationById(quotationId);
  if (!parent) throw new Error(`Quotation ${quotationId} not found`);

  const rootId = parent.Root_Quotation_ID || parent.Quotation_ID;
  const siblings = await sheetsService.getQuotationRevisions(rootId);
  const nextRevisionNo = Math.max(...siblings.map(s => Number(s.Revision_No) || 0)) + 1;

  const customer = await sheetsService.getAllCustomers()
    .then(list => list.find(c => c.Customer_ID === parent.Customer_ID));

  const priced = await priceQuotation({
    customer: customer || {},
    lineItems: payload?.lineItems !== undefined ? payload.lineItems : parent.Line_Items,
    documentDiscountPct: payload?.documentDiscountPct ?? parent.Document_Level_Discount_Pct,
    documentDiscountAmt: payload?.documentDiscountAmt ?? parent.Document_Level_Discount_Amt,
    destinationStateCode: payload?.destinationStateCode || parent.Destination_State_Code
  });

  const nowMs = Date.now();
  const revisionId = `QUOT${nowMs.toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
  const expiryDays = Number(payload?.autoExpiryDays ?? parent.Auto_Expiry_Days);

  const revision = {
    ...parent,
    Quotation_ID: revisionId,
    Quote_No: parent.Quote_No,
    Revision_No: nextRevisionNo,
    Quote_No_Display: `${parent.Quote_No}/R${nextRevisionNo}`,
    Parent_Quotation_ID: parent.Quotation_ID,
    Root_Quotation_ID: rootId,

    GST_Type: priced.gstType,
    Destination_State_Code: priced.buyerStateCode,
    Line_Items: priced.totals.lineItems,
    Gross_Total: priced.totals.Gross_Total,
    Line_Discount_Total: priced.totals.Line_Discount_Total,
    Document_Level_Discount_Pct: priced.totals.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: priced.totals.Document_Level_Discount_Amt,
    Subtotal: priced.totals.Subtotal,
    Total_CGST: priced.totals.Total_CGST,
    Total_SGST: priced.totals.Total_SGST,
    Total_IGST: priced.totals.Total_IGST,
    Total_GST: priced.totals.Total_GST,
    Grand_Total: priced.totals.Grand_Total,
    Effective_Discount_Pct: priced.effectiveDiscountPct,
    Approval_Required: priced.approvalRequired,
    Status: priced.approvalRequired ? STATUS.PENDING_APPROVAL : STATUS.DRAFT,
    Approved_By: '',
    Approved_At: '',

    Auto_Expiry_Days: expiryDays,
    Expiry_Date: istDatePlusDays(expiryDays),
    Follow_Up_Interval_Days: Number(payload?.followUpIntervalDays ?? parent.Follow_Up_Interval_Days),
    Notes: payload?.notes !== undefined ? payload.notes : parent.Notes,
    Revision_Reason: payload?.revisionReason || '',

    // Each revision is independently dispatchable and gets its own portal link/history.
    Portal_Guid: newPortalGuid(),
    Portal_Last_Viewed_At: '',
    Dispatch_Log: [],
    Customer_Action_Log: [],
    Next_Reminder_Date: '',
    Linked_PI_ID: '',
    Linked_Invoice_ID: '',
    Annual_Refill_Task_Generated: false,

    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: istToday(),
    Created_At_Ms: nowMs
  };
  delete revision.id;

  await sheetsService.insertRow('Quotation_Master', revision);
  await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', parent.Quotation_ID, {
    Status: STATUS.REVISED,
    Superseded_By: revisionId,
    Superseded_At: new Date().toISOString()
  });

  return revision;
}

/**
 * Marks a quotation as dispatched. The actual Email/WhatsApp send is delegated to
 * dispatchService (Phase 4); this records the attempt, advances the task to Quotation FLP and
 * arms the first follow-up reminder.
 */
async function markDispatched(quotationId, dispatchResults, actor) {
  const quotation = await sheetsService.getQuotationById(quotationId);
  if (!quotation) throw new Error(`Quotation ${quotationId} not found`);

  const existingLog = Array.isArray(quotation.Dispatch_Log) ? quotation.Dispatch_Log : [];
  const newEntries = (dispatchResults || []).map(r => ({
    channel: r.channel,
    status: r.ok ? 'sent' : 'failed',
    error: r.ok ? '' : String(r.error || ''),
    recipient: r.recipient || '',
    timestamp: new Date().toISOString()
  }));

  const anySent = newEntries.some(e => e.status === 'sent');
  const interval = Number(quotation.Follow_Up_Interval_Days) || 3;

  const updateData = {
    Dispatch_Log: [...existingLog, ...newEntries],
    Last_Dispatched_At: new Date().toISOString()
  };

  if (anySent) {
    updateData.Status = STATUS.SENT;
    updateData.Sent_At = new Date().toISOString();
    updateData.Sent_Date = istToday();
    updateData.Next_Reminder_Date = istDatePlusDays(interval);
  }

  const updated = await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, updateData);

  if (anySent && quotation.Task_ID) {
    await safeAdvanceTask(quotation.Task_ID, TASK_STAGE.QUOTATION_FLP, actor, `Quotation ${quotation.Quote_No_Display} dispatched`);
  }

  return updated;
}

/**
 * Applies a customer-portal action. Only ACCEPT moves the owning task's stage; the other three
 * are quotation-internal by design so a revision request or reminder reschedule doesn't churn
 * the task pipeline.
 */
async function applyCustomerAction(quotationId, actionKey, actionPayload = {}) {
  const quotation = await sheetsService.getQuotationById(quotationId);
  if (!quotation) throw new Error(`Quotation ${quotationId} not found`);

  const log = Array.isArray(quotation.Customer_Action_Log) ? quotation.Customer_Action_Log : [];
  const entry = {
    action: actionKey,
    note: actionPayload.note || '',
    requestedDate: actionPayload.requestedDate || '',
    timestamp: new Date().toISOString()
  };

  const updateData = { Customer_Action_Log: [...log, entry] };
  let notifyBody = '';
  let createdRevision = null;

  switch (actionKey) {
    case 'ACCEPT':
      updateData.Status = STATUS.ACCEPTED;
      updateData.Accepted_At = new Date().toISOString();
      updateData.Next_Reminder_Date = '';
      notifyBody = `${quotation.Customer_Name_Snapshot} ACCEPTED quotation ${quotation.Quote_No_Display}.`;
      break;

    case 'REQUEST_REVISION':
      updateData.Status = STATUS.REVISION_REQUESTED;
      updateData.Revision_Requested_At = new Date().toISOString();
      updateData.Revision_Request_Note = actionPayload.note || '';
      notifyBody = `${quotation.Customer_Name_Snapshot} requested a REVISION on ${quotation.Quote_No_Display}.`;
      break;

    case 'CHANGE_REQUIREMENT':
      updateData.Status = STATUS.REQUIREMENT_CHANGE_REQUESTED;
      updateData.Requirement_Change_Note = actionPayload.note || '';
      notifyBody = `${quotation.Customer_Name_Snapshot} requested a REQUIREMENT CHANGE on ${quotation.Quote_No_Display}.`;
      break;

    case 'REQUEST_REMINDER_DATE': {
      // Status intentionally unchanged — the quote is still open, only the cadence shifts.
      const requested = actionPayload.requestedDate;
      if (!requested) throw new Error('A requested reminder date is required');
      updateData.Next_Reminder_Date = requested;
      updateData.Customer_Requested_Reminder_Date = requested;
      notifyBody = `${quotation.Customer_Name_Snapshot} asked to be reminded on ${requested} for ${quotation.Quote_No_Display}.`;
      break;
    }

    default:
      throw new Error(`Unsupported customer action: ${actionKey}`);
  }

  const updated = await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, updateData);

  if (actionKey === 'ACCEPT' && quotation.Task_ID) {
    await safeAdvanceTask(quotation.Task_ID, TASK_STAGE.ORDER_CONFIRMATION, null, `Quotation ${quotation.Quote_No_Display} accepted by customer`);
  }

  if (actionKey === 'REQUEST_REVISION' && actionPayload.autoCreateRevision) {
    try {
      createdRevision = await createRevision(quotationId, { revisionReason: actionPayload.note || 'Customer requested revision' }, { staffId: 'SYSTEM' });
    } catch (e) {
      console.error('Auto-revision creation failed:', e.message);
    }
  }

  await notifyOwners(quotation, notifyBody);

  return { quotation: updated, createdRevision };
}

/** Notifies the assigned Sales staff plus every Admin about a customer-side event. */
async function notifyOwners(quotation, body) {
  if (!body) return;
  try {
    const recipients = new Set();
    if (quotation.Assigned_Staff) recipients.add(quotation.Assigned_Staff);
    const allStaff = await sheetsService.getAllStaff();
    allStaff
      .filter(s => String(s.Role || '').toLowerCase() === 'admin' && s.Status !== 'Inactive')
      .forEach(s => recipients.add(s.Staff_ID));

    for (const staffId of recipients) {
      pushService.notifyStaff(staffId, {
        type: pushService.NOTIFICATION_TYPES?.TASK_STAGE_HANDOFF || 'QUOTATION_UPDATE',
        title: 'Quotation Update',
        body,
        url: `/quotations/${quotation.Quotation_ID}`,
        tag: `quotation-${quotation.Quotation_ID}`
      });
    }
  } catch (e) {
    console.error('Error sending quotation notification:', e);
  }
}

/**
 * advanceTaskStage throws if the task no longer exists; a quotation action should never fail
 * because of that, so stage advancement is best-effort and logged.
 */
async function safeAdvanceTask(taskId, targetStage, actor, remarks) {
  if (!taskId) return null;
  try {
    return await workflowEngine.advanceTaskStage(taskId, {
      targetStage,
      staffId: actor?.staffId || 'SYSTEM',
      remarks: remarks || `Quotation pipeline -> ${targetStage}`
    });
  } catch (e) {
    console.error(`Could not advance task ${taskId} to ${targetStage}:`, e.message);
    return null;
  }
}

/** Last rate this customer was quoted for an item, newest first. Derived, not materialized. */
async function getLastQuotedRate(customerId, itemId) {
  const quotes = await sheetsService.getAllQuotations();
  const relevant = quotes
    .filter(q => q.Customer_ID === customerId && Array.isArray(q.Line_Items))
    .sort((a, b) => (Number(b.Created_At_Ms) || 0) - (Number(a.Created_At_Ms) || 0));

  for (const q of relevant) {
    const line = q.Line_Items.find(l => l.Item_ID === itemId);
    if (line) {
      return {
        rate: Number(line.Rate) || 0,
        quotationId: q.Quotation_ID,
        quoteNo: q.Quote_No_Display || q.Quote_No,
        quotedOn: q.Created_At
      };
    }
  }
  return null;
}

/** Bulk variant so the quotation builder can prime every line at once. */
async function getLastQuotedRates(customerId) {
  const quotes = await sheetsService.getAllQuotations();
  const relevant = quotes
    .filter(q => q.Customer_ID === customerId && Array.isArray(q.Line_Items))
    .sort((a, b) => (Number(a.Created_At_Ms) || 0) - (Number(b.Created_At_Ms) || 0));

  const map = {};
  // Ascending order means later quotations naturally overwrite earlier ones, leaving the latest.
  for (const q of relevant) {
    for (const line of q.Line_Items) {
      if (!line.Item_ID) continue;
      map[line.Item_ID] = {
        rate: Number(line.Rate) || 0,
        quotationId: q.Quotation_ID,
        quoteNo: q.Quote_No_Display || q.Quote_No,
        quotedOn: q.Created_At
      };
    }
  }
  return map;
}

/**
 * Cron worker: expires quotations past Expiry_Date that never converted.
 * Idempotent — only touches rows still in an open status.
 */
async function expireStaleQuotations() {
  const todayStr = istToday();
  const quotes = await sheetsService.getAllQuotations();
  const stale = quotes.filter(q =>
    OPEN_STATUSES.includes(q.Status)
    && q.Expiry_Date
    && q.Expiry_Date < todayStr
  );

  for (const q of stale) {
    await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', q.Quotation_ID, {
      Status: STATUS.EXPIRED,
      Expired_At: new Date().toISOString(),
      Next_Reminder_Date: ''
    });
  }

  return { expiredCount: stale.length, todayStr };
}

module.exports = {
  STATUS,
  TASK_STAGE,
  OPEN_STATUSES,
  istToday,
  istDatePlusDays,
  getSettings,
  priceQuotation,
  createQuotation,
  updateQuotation,
  approveQuotation,
  rejectQuotation,
  createRevision,
  markDispatched,
  applyCustomerAction,
  notifyOwners,
  safeAdvanceTask,
  getLastQuotedRate,
  getLastQuotedRates,
  expireStaleQuotations,
  nextDocumentNumber,
  newPortalGuid,
  buildCustomerSnapshot
};
