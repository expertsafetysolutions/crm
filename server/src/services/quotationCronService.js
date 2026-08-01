const sheetsService = require('./sheetsService');
const quotationEngine = require('./quotationEngine');
const dispatchService = require('./dispatchService');

/**
 * Scheduled workers for the quotation pipeline, invoked by the /api/cron/* routes registered in
 * server.js (guarded by CRON_SECRET) and scheduled in vercel.json.
 *
 * Lives in its own module rather than inside workflowEngine because it depends on quotationEngine,
 * which already depends on workflowEngine — putting these there would create a require cycle.
 *
 * Every worker follows the same shape as the existing generateRefillingDueTasks(): a single daily
 * invocation queries for everything due *today* and fans out, so one cron entry serves any number
 * of documents each with their own interval. No per-document scheduling exists or is needed.
 */

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function istDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function summarizeLineItems(lineItems) {
  return (lineItems || [])
    .map(l => `${[l.Item_Name, l.Capacity].filter(Boolean).join(' ')} - ${Number(l.Qty) || 0} ${l.Unit || 'Nos'}`)
    .join(', ');
}

/**
 * Module D: sends follow-up reminders for every open quotation whose Next_Reminder_Date is today
 * (or earlier — a missed cron run shouldn't strand a reminder forever), then re-arms the next one.
 * Reminders stop on their own once Status leaves the open set (accepted/rejected/expired/converted),
 * because those rows fall out of this query.
 */
/**
 * The reminder cap for one quotation: its own Max_Reminders, else the company default.
 *
 * 0 (or a negative) means unlimited, deliberately — an office that wants the old behaviour of
 * chasing until the quotation closes can ask for it explicitly rather than getting it by accident.
 */
function resolveReminderLimit(quotation, settings) {
  const own = Number(quotation.Max_Reminders);
  if (Number.isFinite(own) && own > 0) return own;
  if (Number.isFinite(own) && own === 0) return 0;          // explicit "unlimited" on this row
  const fallback = Number(settings?.defaults?.max_follow_up_reminders);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

/**
 * Post-send bookkeeping, shared by the cron and the manual "Send now" button.
 *
 * Extracted so the two paths cannot drift: if the manual send did not increment Reminder_Count, a
 * hand-sent reminder would never count toward the cap and the cadence could be pushed past its
 * limit by hand without anyone noticing.
 *
 * Latches Reminder_Stopped once the cap is reached and clears Next_Reminder_Date, so the row drops
 * out of the due query entirely rather than being re-evaluated (and re-skipped) every single day.
 */
async function recordReminderSent(quotation, results, settings) {
  const interval = Number(quotation.Follow_Up_Interval_Days) || 3;
  const log = Array.isArray(quotation.Reminder_Log) ? quotation.Reminder_Log : [];
  const nextCount = (Number(quotation.Reminder_Count) || 0) + 1;
  const limit = resolveReminderLimit(quotation, settings);
  const reachedCap = limit > 0 && nextCount >= limit;

  const patch = {
    // Always re-arm from today, not from the stale due date, so a backlog can't cause a burst
    // of same-day reminders on the next run.
    Next_Reminder_Date: reachedCap ? '' : istDateOffset(interval),
    Last_Reminder_Sent_At: new Date().toISOString(),
    Reminder_Count: nextCount,
    Reminder_Log: [...log, {
      timestamp: new Date().toISOString(),
      channels: results.map(r => ({ channel: r.channel, status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : String(r.error || '') }))
    }]
  };
  if (reachedCap) {
    patch.Reminder_Stopped = true;
    patch.Reminder_Stopped_Reason = `Reached the ${limit}-reminder limit`;
  }

  await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotation.Quotation_ID, patch);
  return { reachedCap, nextCount, limit };
}

async function runQuotationFollowUpReminders() {
  const todayStr = istToday();
  const settings = await quotationEngine.getSettings();
  const quotations = await sheetsService.getAllQuotations();

  const due = quotations.filter(q =>
    quotationEngine.OPEN_STATUSES.includes(q.Status)
    && q.Reminder_Stopped !== true
    && q.Next_Reminder_Date
    && q.Next_Reminder_Date <= todayStr
  );

  let sentCount = 0;
  let failedCount = 0;
  let stoppedCount = 0;

  for (const quotation of due) {
    try {
      // Checked before sending, not after: a row already at its cap (because the limit was lowered,
      // or a manual send pushed it there) must be retired without one last email going out.
      const limit = resolveReminderLimit(quotation, settings);
      if (limit > 0 && (Number(quotation.Reminder_Count) || 0) >= limit) {
        await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotation.Quotation_ID, {
          Reminder_Stopped: true,
          Reminder_Stopped_Reason: `Reached the ${limit}-reminder limit`,
          Next_Reminder_Date: ''
        });
        stoppedCount++;
        continue;
      }

      const results = await dispatchService.sendFollowUpReminder(quotation);
      const anySent = results.some(r => r.ok);
      if (anySent) sentCount++; else failedCount++;

      const outcome = await recordReminderSent(quotation, results, settings);
      if (outcome.reachedCap) stoppedCount++;
    } catch (e) {
      failedCount++;
      console.error(`Follow-up reminder failed for ${quotation.Quotation_ID}:`, e.message);
    }
  }

  return { dueCount: due.length, sentCount, failedCount, stoppedCount, todayStr };
}

/**
 * Module G: payment-due reminders for unpaid Sales Invoices, fired at each configured offset
 * relative to the invoice due date (e.g. -3 = three days before, 0 = on the day, +7 = overdue).
 * Idempotent per (invoice, offset) via Reminder_Offsets_Sent, so a re-run can't double-send.
 */
async function runPaymentDueReminders() {
  const todayStr = istToday();
  const settings = await quotationEngine.getSettings();
  const offsets = Array.isArray(settings.payment_reminder_offsets) ? settings.payment_reminder_offsets : [-3, 0, 7];

  const invoices = await sheetsService.getAllSalesInvoices();
  const unpaid = invoices.filter(i => {
    const status = String(i.Payment_Status || '').toLowerCase();
    return status !== 'paid' && status !== 'cancelled' && i.Due_Date;
  });

  let sentCount = 0;
  let failedCount = 0;

  for (const invoice of unpaid) {
    // An offset of -3 means "remind 3 days before due", i.e. fire when due_date - 3 === today.
    const alreadySent = Array.isArray(invoice.Reminder_Offsets_Sent) ? invoice.Reminder_Offsets_Sent : [];
    const matchedOffset = offsets.find(off => {
      if (alreadySent.includes(off)) return false;
      const fireDate = (() => {
        const d = new Date(invoice.Due_Date);
        d.setDate(d.getDate() + Number(off));
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
      })();
      return fireDate === todayStr;
    });

    if (matchedOffset === undefined) continue;

    try {
      const results = await dispatchService.sendPaymentDueReminder(invoice);
      const anySent = results.some(r => r.ok);
      if (anySent) sentCount++; else failedCount++;

      const log = Array.isArray(invoice.Reminder_Log) ? invoice.Reminder_Log : [];
      await sheetsService.updateRow('Sales_Invoice_Master', 'Invoice_ID', invoice.Invoice_ID, {
        Reminder_Offsets_Sent: [...alreadySent, matchedOffset],
        Last_Reminder_Sent_At: new Date().toISOString(),
        Reminder_Log: [...log, {
          timestamp: new Date().toISOString(),
          offset: matchedOffset,
          channels: results.map(r => ({ channel: r.channel, status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : String(r.error || '') }))
        }]
      });
    } catch (e) {
      failedCount++;
      console.error(`Payment reminder failed for ${invoice.Invoice_ID}:`, e.message);
    }
  }

  return { candidateCount: unpaid.length, sentCount, failedCount, todayStr };
}

const ANNUAL_PROSPECT_LEAD_DAYS = 335; // 30 days before the 1-year anniversary

async function getOrCreateProspectTag() {
  const tags = await sheetsService.getAllTags();
  const existing = tags.find(t => String(t.name || '').trim().toLowerCase() === 'prospective lead');
  if (existing) return existing.Tag_ID;
  const newTag = { Tag_ID: `TAG${Date.now().toString().slice(-6)}`, name: 'Prospective Lead', color: '#7c3aed' };
  await sheetsService.insertRow('Tag_Master', newTag);
  return newTag.Tag_ID;
}

/**
 * Module F: for quotations that never converted, generates a pre-populated renewal lead 30 days
 * before the quote's 1-year anniversary (i.e. quotes created exactly 335 days ago).
 *
 * Mirrors generateRefillingDueTasks(): date-equality query plus a per-row idempotency flag
 * (Annual_Refill_Task_Generated) so repeat runs can't duplicate. Uses <= rather than === on the
 * date so a skipped cron day still gets picked up on the next run.
 */
async function generateAnnualProspectTasks() {
  const todayStr = istToday();
  const targetDate = istDateOffset(-ANNUAL_PROSPECT_LEAD_DAYS);

  const quotations = await sheetsService.getAllQuotations();
  const candidates = quotations.filter(q => {
    if (q.Annual_Refill_Task_Generated) return false;
    // Converted business is a live customer, not a prospect to re-pitch.
    if (q.Status === quotationEngine.STATUS.CONVERTED || q.Status === quotationEngine.STATUS.ACCEPTED) return false;
    // Superseded revisions would each spawn a duplicate lead; only the latest version qualifies.
    if (q.Status === quotationEngine.STATUS.REVISED) return false;
    const createdAt = q.Created_At;
    return createdAt && createdAt <= targetDate;
  });

  if (candidates.length === 0) return { createdCount: 0, targetDate, todayStr };

  const tagId = await getOrCreateProspectTag();
  let createdCount = 0;

  for (const q of candidates) {
    const itemSummary = summarizeLineItems(q.Line_Items);
    const newTask = {
      Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
      Customer_ID: q.Customer_ID,
      Description: `Prospective Lead - Annual Refilling - ${itemSummary || q.Subject || q.Quote_No_Display}`,
      Assigned_Staff: q.Assigned_Staff || '',
      Department: 'Sales',
      Stage: 'New Inquiry',
      Type: 'Recurring',
      Scheduled_Date: todayStr,
      Status: 'Pending',
      Tags: [tagId],
      // Historical context carried onto the lead so staff can pitch without digging.
      Source_Quotation_ID: q.Quotation_ID,
      Source_Quote_No: q.Quote_No_Display || q.Quote_No,
      Source_Quote_Date: q.Created_At,
      Source_Quote_Amount: q.Grand_Total,
      Source_Quote_Status: q.Status,
      Historical_Items: q.Line_Items || [],
      Historical_Remarks: q.Notes || q.Requirement_Change_Note || q.Revision_Request_Note || '',
      Created_By: 'SYSTEM',
      Created_At: todayStr
    };

    await sheetsService.insertRow('Task_Master', newTask);
    await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', q.Quotation_ID, {
      Annual_Refill_Task_Generated: true,
      Annual_Refill_Task_ID: newTask.Task_ID,
      Annual_Refill_Generated_At: new Date().toISOString()
    });
    createdCount++;
  }

  return { createdCount, targetDate, todayStr };
}

/**
 * Chases vendors on open purchase orders whose Next_Reminder_Date has arrived, then re-arms the
 * next one. Mirrors runQuotationFollowUpReminders exactly — same due query, same re-arm-from-today
 * rule — so the two behave identically and a reader only has to learn the pattern once.
 *
 * Only orders with a positive Reminder_Interval_Days participate: the interval is opt-in per PO,
 * because most orders are delivered before anyone would chase them and a default cadence would
 * mail every vendor in the book.
 *
 * Received and Cancelled orders fall out of the query on their own, which is what stops the
 * reminders — there is no separate "stop" flag to forget to set.
 */
const PO_OPEN_STATUSES = ['Draft', 'Issued', 'Sent', 'Partially Received', 'Acknowledged'];

async function runPurchaseOrderReminders() {
  const todayStr = istToday();
  const orders = await sheetsService.getTab('Purchase_Order');
  const vendors = await sheetsService.getTab('Vendor_Master');
  const vendorById = new Map(vendors.map(v => [v.Vendor_ID, v]));

  const due = orders.filter(po =>
    PO_OPEN_STATUSES.includes(po.Status)
    && Number(po.Reminder_Interval_Days) > 0
    && po.Next_Reminder_Date
    && po.Next_Reminder_Date <= todayStr
  );

  let sentCount = 0;
  let failedCount = 0;

  for (const po of due) {
    try {
      const vendor = vendorById.get(po.Vendor_ID);
      // No vendor row, or no way to reach them: re-arm anyway rather than retrying every single day
      // for an order that can never send. The PO still shows its reminder settings on screen.
      if (!vendor || (!vendor.Email && !vendor.Phone)) {
        failedCount++;
        await sheetsService.updateRow('Purchase_Order', 'PO_ID', po.PO_ID, {
          Next_Reminder_Date: istDateOffset(Number(po.Reminder_Interval_Days) || 7)
        });
        continue;
      }

      const results = await dispatchService.sendPurchaseOrderReminder(po, vendor, { staffId: 'SYSTEM' });
      if (results.some(r => r.ok)) sentCount++; else failedCount++;

      const log = Array.isArray(po.Reminder_Log) ? po.Reminder_Log : [];
      await sheetsService.updateRow('Purchase_Order', 'PO_ID', po.PO_ID, {
        // Re-armed from today, not from the stale due date, so a backlog cannot fire a burst of
        // same-day reminders once the cron catches up.
        Next_Reminder_Date: istDateOffset(Number(po.Reminder_Interval_Days) || 7),
        Last_Reminder_Sent_At: new Date().toISOString(),
        Reminder_Count: (Number(po.Reminder_Count) || 0) + 1,
        Reminder_Log: [...log, {
          timestamp: new Date().toISOString(),
          channels: results.map(r => ({
            channel: r.channel,
            status: r.ok ? 'sent' : 'failed',
            error: r.ok ? '' : String(r.error || '')
          }))
        }]
      });
    } catch (e) {
      failedCount++;
      console.error(`PO reminder failed for ${po.PO_ID}:`, e.message);
    }
  }

  return { dueCount: due.length, sentCount, failedCount, todayStr };
}

const CERTIFICATE_DUE_DEFAULTS = {
  lead_days: 30,
  pre_due_interval_days: 3,
  post_due_interval_days: 1,
  stop_after_count: 10,
  stop_after_days_overdue: 60
};

/**
 * Whether one item's reminder cadence should fire today, given its stored state.
 *
 * Reminders start `lead_days` before the due date, repeat every `pre_due_interval_days` while still
 * before due, switch to `post_due_interval_days` once overdue, and stop for good once either cap in
 * `cfg` is hit — an item must not chase a customer forever. `state` is whatever this item's own
 * entry in Due_Reminder_Offsets_Sent currently holds (or undefined for an item never reminded yet).
 */
function isItemDueToday(daysUntilDue, state, cfg, todayStr) {
  if (state?.stopped) return false;
  if (daysUntilDue > cfg.lead_days) return false;

  if (!state?.lastSentAt) return true; // first reminder in this cadence

  const interval = daysUntilDue >= 0 ? cfg.pre_due_interval_days : cfg.post_due_interval_days;
  const daysSinceLast = Math.round((new Date(todayStr) - new Date(state.lastSentAt.slice(0, 10))) / 86400000);
  return daysSinceLast >= Math.max(1, Number(interval) || 1);
}

/**
 * Flattens every certificate's itemsList (each item has its own nextDate — see
 * CertificateComplianceGeneratorPage.jsx's computeCertValidUntil) plus every Manual_Due_Entries row
 * into one list of { sourceType, sourceId, itemId, customerId, customerName, itemName, capacity,
 * qty, nextDate, state } candidates, so runCertificateDueReminders can filter/group them identically
 * regardless of which collection they came from. `state` is this item's own entry (if any) inside
 * the parent record's Due_Reminder_Offsets_Sent — {itemId, sentCount, lastSentAt, stopped}.
 */
async function collectDueCandidates() {
  const certificates = await sheetsService.getAllCertificates();
  const manualEntries = await sheetsService.getTab('Manual_Due_Entries');
  const certificatesById = new Map(certificates.map(c => [c.verificationGuid || c.Verification_GUID, c]));
  const manualEntriesById = new Map(manualEntries.map(e => [e.Due_Entry_ID, e]));

  const out = [];

  for (const cert of certificates) {
    if (cert.Is_Deleted) continue;
    if (cert.Due_Reminder_Enabled === false) continue;
    const customerId = cert.Customer_ID || cert.customerId;
    const customerName = cert.Customer_Name || cert.customerName;
    if (!customerId) continue;
    const offsetsSent = Array.isArray(cert.Due_Reminder_Offsets_Sent) ? cert.Due_Reminder_Offsets_Sent : [];
    for (const item of (cert.itemsList || [])) {
      if (!item.nextDate) continue;
      const itemId = item.id || item.srNo || `${item.itemName}-${item.capacity}`;
      out.push({
        sourceType: 'certificate',
        sourceId: cert.verificationGuid || cert.Verification_GUID,
        itemId,
        customerId,
        customerName,
        itemName: item.itemName,
        capacity: item.capacity,
        qty: item.qty,
        nextDate: item.nextDate,
        state: offsetsSent.find(o => o.itemId === itemId)
      });
    }
  }

  for (const entry of manualEntries) {
    if (entry.Is_Deleted) continue;
    if (entry.Due_Reminder_Enabled === false) continue;
    if (!entry.Customer_ID || !entry.Due_Date) continue;
    const offsetsSent = Array.isArray(entry.Due_Reminder_Offsets_Sent) ? entry.Due_Reminder_Offsets_Sent : [];
    for (const item of (entry.Equipment_List || [])) {
      const itemId = item.itemName + (item.capacity || '');
      out.push({
        sourceType: 'manual',
        sourceId: entry.Due_Entry_ID,
        itemId,
        customerId: entry.Customer_ID,
        customerName: entry.Customer_Name,
        itemName: item.itemName,
        capacity: item.capacity,
        qty: item.qty,
        nextDate: entry.Due_Date,
        state: offsetsSent.find(o => o.itemId === itemId)
      });
    }
  }

  return { candidates: out, certificatesById, manualEntriesById };
}

/**
 * Module H: repeating due-reminder for expiring certificate equipment (Due Certificate Report).
 * Cadence is admin-configurable (Quotation_Settings.certificate_due_reminder_config): starts
 * `lead_days` before an item's due date, repeats every `pre_due_interval_days` before due and
 * `post_due_interval_days` once overdue, and auto-stops per item once either cap
 * (stop_after_count / stop_after_days_overdue) is hit — see isItemDueToday().
 *
 * Candidates due on the SAME run are grouped by Customer_ID before dispatch, so a company with
 * several certificates/items due together receives ONE email listing all of them rather than one
 * per certificate — confirmed requirement, not an optimisation.
 */
async function runCertificateDueReminders() {
  const todayStr = istToday();
  const settings = await quotationEngine.getSettings();
  const cfg = { ...CERTIFICATE_DUE_DEFAULTS, ...(settings.certificate_due_reminder_config || {}) };

  const { candidates, certificatesById, manualEntriesById } = await collectDueCandidates();
  const customers = await sheetsService.getAllCustomers();
  const customerById = new Map(customers.map(c => [c.Customer_ID, c]));

  const due = candidates.filter(c => {
    const daysUntilDue = Math.round((new Date(String(c.nextDate).slice(0, 10)) - new Date(todayStr)) / 86400000);
    return isItemDueToday(daysUntilDue, c.state, cfg, todayStr);
  });

  const byCustomer = new Map();
  for (const item of due) {
    if (!byCustomer.has(item.customerId)) byCustomer.set(item.customerId, []);
    byCustomer.get(item.customerId).push(item);
  }

  let sentCount = 0;
  let failedCount = 0;

  for (const [customerId, items] of byCustomer) {
    const customer = customerById.get(customerId);
    if (!customer || !customer.Email) {
      failedCount += items.length;
      continue;
    }

    try {
      const results = await dispatchService.sendCertificateDueReminder(customer, items);
      const anySent = results.some(r => r.ok);
      if (anySent) sentCount += items.length; else failedCount += items.length;

      // Stamp every source record involved — a certificate can contribute more than one item, and
      // several certificates/manual entries can belong to the same customer group.
      const bySource = new Map();
      for (const item of items) {
        const key = `${item.sourceType}::${item.sourceId}`;
        if (!bySource.has(key)) bySource.set(key, []);
        bySource.get(key).push(item);
      }

      for (const [, sourceItems] of bySource) {
        const { sourceType, sourceId } = sourceItems[0];
        const collection = sourceType === 'certificate' ? 'Document_Registry' : 'Manual_Due_Entries';
        const idColumn = sourceType === 'certificate' ? 'verificationGuid' : 'Due_Entry_ID';
        const currentRow = sourceType === 'certificate' ? certificatesById.get(sourceId) : manualEntriesById.get(sourceId);
        const offsetsSent = Array.isArray(currentRow?.Due_Reminder_Offsets_Sent) ? currentRow.Due_Reminder_Offsets_Sent : [];
        const log = Array.isArray(currentRow?.Due_Reminder_Log) ? currentRow.Due_Reminder_Log : [];

        // Update each fired item's own state in place (not appended) — sentCount/lastSentAt track
        // the running cadence, and stopped latches true once either cap is crossed, so future runs
        // skip this item until the admin flips Due_Reminder_Enabled off and back on.
        const updatedOffsets = [...offsetsSent];
        for (const item of sourceItems) {
          const daysUntilDue = Math.round((new Date(String(item.nextDate).slice(0, 10)) - new Date(todayStr)) / 86400000);
          const prevCount = Number(item.state?.sentCount) || 0;
          const nextCount = prevCount + 1;
          const daysOverdue = Math.max(0, -daysUntilDue);
          const stopped = nextCount >= cfg.stop_after_count || daysOverdue >= cfg.stop_after_days_overdue;
          const nextState = {
            itemId: item.itemId,
            sentCount: nextCount,
            lastSentAt: new Date().toISOString(),
            firstDueAt: item.state?.firstDueAt || item.nextDate,
            stopped
          };
          const idx = updatedOffsets.findIndex(o => o.itemId === item.itemId);
          if (idx === -1) updatedOffsets.push(nextState); else updatedOffsets[idx] = nextState;
        }

        await sheetsService.updateRow(collection, idColumn, sourceId, {
          Due_Reminder_Offsets_Sent: updatedOffsets,
          Due_Reminder_Log: [...log, {
            timestamp: new Date().toISOString(),
            items: sourceItems.map(i => i.itemId),
            channels: results.map(r => ({ channel: r.channel, status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : String(r.error || '') }))
          }]
        });
      }
    } catch (e) {
      failedCount += items.length;
      console.error(`Certificate due reminder failed for customer ${customerId}:`, e.message);
    }
  }

  return { dueCount: due.length, groupCount: byCustomer.size, sentCount, failedCount, todayStr };
}

module.exports = {
  runQuotationFollowUpReminders,
  // Shared with the manual "Send now" button so a hand-sent reminder is counted, logged and capped
  // exactly like an automatic one.
  recordReminderSent,
  resolveReminderLimit,
  runPaymentDueReminders,
  runPurchaseOrderReminders,
  generateAnnualProspectTasks,
  runCertificateDueReminders,
  ANNUAL_PROSPECT_LEAD_DAYS,
  PO_OPEN_STATUSES
};
