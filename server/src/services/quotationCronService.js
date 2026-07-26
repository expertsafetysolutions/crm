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
async function runQuotationFollowUpReminders() {
  const todayStr = istToday();
  const quotations = await sheetsService.getAllQuotations();

  const due = quotations.filter(q =>
    quotationEngine.OPEN_STATUSES.includes(q.Status)
    && q.Next_Reminder_Date
    && q.Next_Reminder_Date <= todayStr
  );

  let sentCount = 0;
  let failedCount = 0;

  for (const quotation of due) {
    try {
      const results = await dispatchService.sendFollowUpReminder(quotation);
      const anySent = results.some(r => r.ok);
      if (anySent) sentCount++; else failedCount++;

      const interval = Number(quotation.Follow_Up_Interval_Days) || 3;
      const log = Array.isArray(quotation.Reminder_Log) ? quotation.Reminder_Log : [];

      await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotation.Quotation_ID, {
        // Always re-arm from today, not from the stale due date, so a backlog can't cause a burst
        // of same-day reminders on the next run.
        Next_Reminder_Date: istDateOffset(interval),
        Last_Reminder_Sent_At: new Date().toISOString(),
        Reminder_Count: (Number(quotation.Reminder_Count) || 0) + 1,
        Reminder_Log: [...log, {
          timestamp: new Date().toISOString(),
          channels: results.map(r => ({ channel: r.channel, status: r.ok ? 'sent' : 'failed', error: r.ok ? '' : String(r.error || '') }))
        }]
      });
    } catch (e) {
      failedCount++;
      console.error(`Follow-up reminder failed for ${quotation.Quotation_ID}:`, e.message);
    }
  }

  return { dueCount: due.length, sentCount, failedCount, todayStr };
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

module.exports = {
  runQuotationFollowUpReminders,
  runPaymentDueReminders,
  generateAnnualProspectTasks,
  ANNUAL_PROSPECT_LEAD_DAYS
};
