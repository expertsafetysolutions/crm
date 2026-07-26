const sheetsService = require('./sheetsService');
const quotationEngine = require('./quotationEngine');
const inventoryService = require('./inventoryService');

/**
 * conversionService — Module G's 1-click Quotation -> PI -> Sales Invoice pipeline.
 *
 * Conversions COPY the already-computed line items, discounts and GST split verbatim rather than
 * re-pricing. Re-running the tax engine at conversion time would silently change an amount the
 * customer already accepted (e.g. if their GSTIN or a settings default changed in between), so the
 * accepted figures are treated as frozen.
 */

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** The monetary + party fields carried unchanged through every conversion step. */
function carryForwardFields(source) {
  return {
    Customer_ID: source.Customer_ID,
    Customer_Name_Snapshot: source.Customer_Name_Snapshot,
    Customer_Auth_Person_Snapshot: source.Customer_Auth_Person_Snapshot,
    Customer_Address_Snapshot: source.Customer_Address_Snapshot,
    Customer_GSTIN_Snapshot: source.Customer_GSTIN_Snapshot,
    Customer_State_Code_Snapshot: source.Customer_State_Code_Snapshot,
    Customer_Email_Snapshot: source.Customer_Email_Snapshot,
    Customer_Contact_Snapshot: source.Customer_Contact_Snapshot,
    Customer_Type_Snapshot: source.Customer_Type_Snapshot,

    Seller_State_Code: source.Seller_State_Code,
    GST_Type: source.GST_Type,
    Destination_State_Code: source.Destination_State_Code,

    Line_Items: source.Line_Items,
    Gross_Total: source.Gross_Total,
    Line_Discount_Total: source.Line_Discount_Total,
    Document_Level_Discount_Pct: source.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: source.Document_Level_Discount_Amt,
    Subtotal: source.Subtotal,
    Total_CGST: source.Total_CGST,
    Total_SGST: source.Total_SGST,
    Total_IGST: source.Total_IGST,
    Total_GST: source.Total_GST,
    Grand_Total: source.Grand_Total,

    Payment_Terms_ID: source.Payment_Terms_ID,
    Selected_TNC_IDs: source.Selected_TNC_IDs,
    Subject: source.Subject,
    Notes: source.Notes,
    Assigned_Staff: source.Assigned_Staff,
    Task_ID: source.Task_ID
  };
}

async function resolvePaymentTermDays(paymentTermsId, settings) {
  const term = (settings.payment_terms || []).find(t => t.id === paymentTermsId);
  return Number(term?.days) || 0;
}

/**
 * Quotation -> Proforma Invoice. Only an Accepted quotation may convert; anything else means the
 * customer hasn't agreed to these figures yet.
 */
async function convertQuotationToPI(quotationId, actor) {
  const quotation = await sheetsService.getQuotationById(quotationId);
  if (!quotation) throw new Error(`Quotation ${quotationId} not found`);
  if (quotation.Status !== quotationEngine.STATUS.ACCEPTED) {
    throw new Error(`Quotation must be Accepted before conversion (current status: ${quotation.Status})`);
  }
  if (quotation.Linked_PI_ID) {
    throw new Error(`Quotation ${quotationId} has already been converted to PI ${quotation.Linked_PI_ID}`);
  }

  const settings = await quotationEngine.getSettings();
  const nowMs = Date.now();
  const piId = `PI${nowMs.toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
  const piNo = await quotationEngine.nextDocumentNumber(
    settings.defaults.pi_no_prefix,
    settings.defaults.number_reset
  );
  const todayStr = istToday();
  const termDays = await resolvePaymentTermDays(quotation.Payment_Terms_ID, settings);

  const pi = {
    PI_ID: piId,
    PI_No: piNo,
    ...carryForwardFields(quotation),
    Source_Quotation_ID: quotation.Quotation_ID,
    Source_Quote_No: quotation.Quote_No_Display || quotation.Quote_No,
    Status: 'Issued',
    PI_Date: todayStr,
    Due_Date: addDays(todayStr, termDays),
    Linked_Invoice_ID: '',
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: todayStr,
    Created_At_Ms: nowMs
  };

  await sheetsService.insertRow('PI_Master', pi);
  await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotationId, {
    Status: quotationEngine.STATUS.CONVERTED,
    Linked_PI_ID: piId,
    Converted_At: new Date().toISOString(),
    Next_Reminder_Date: ''
  });

  if (quotation.Task_ID) {
    await quotationEngine.safeAdvanceTask(quotation.Task_ID, quotationEngine.TASK_STAGE.PI, actor, `Converted to PI ${piNo}`);
  }

  return pi;
}

/**
 * PI -> Sales Invoice. This is the point stock is consumed, so it also triggers the Module E
 * deduction. A deduction failure is reported but never rolls back the invoice — the invoice is the
 * legal document and must stand even if the ledger needs manual correction.
 */
async function convertPIToInvoice(piId, actor) {
  const pi = await sheetsService.getPIById(piId);
  if (!pi) throw new Error(`PI ${piId} not found`);
  if (pi.Linked_Invoice_ID) {
    throw new Error(`PI ${piId} has already been converted to invoice ${pi.Linked_Invoice_ID}`);
  }

  const settings = await quotationEngine.getSettings();
  const nowMs = Date.now();
  const invoiceId = `SINV${nowMs.toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
  const invoiceNo = await quotationEngine.nextDocumentNumber(
    settings.defaults.invoice_no_prefix,
    settings.defaults.number_reset
  );
  const todayStr = istToday();
  const termDays = await resolvePaymentTermDays(pi.Payment_Terms_ID, settings);

  const invoice = {
    Invoice_ID: invoiceId,
    Invoice_No: invoiceNo,
    ...carryForwardFields(pi),
    Source_PI_ID: pi.PI_ID,
    Source_PI_No: pi.PI_No,
    Source_Quotation_ID: pi.Source_Quotation_ID || '',
    Source_Quote_No: pi.Source_Quote_No || '',
    Status: 'Issued',
    Payment_Status: 'Unpaid',
    Amount_Paid: 0,
    Invoice_Date: todayStr,
    Due_Date: addDays(todayStr, termDays),
    Reminder_Offsets_Sent: [],
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: todayStr,
    Created_At_Ms: nowMs
  };

  await sheetsService.insertRow('Sales_Invoice_Master', invoice);
  await sheetsService.updateRow('PI_Master', 'PI_ID', piId, {
    Status: 'Converted',
    Linked_Invoice_ID: invoiceId,
    Converted_At: new Date().toISOString()
  });
  if (pi.Source_Quotation_ID) {
    await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', pi.Source_Quotation_ID, {
      Linked_Invoice_ID: invoiceId
    });
  }

  let inventoryResult = null;
  try {
    inventoryResult = await inventoryService.deductForInvoice(invoice, actor);
    if (inventoryResult.shortfalls.length > 0) {
      await sheetsService.updateRow('Sales_Invoice_Master', 'Invoice_ID', invoiceId, {
        Inventory_Shortfall: inventoryResult.shortfalls
      });
    }
  } catch (e) {
    console.error(`Inventory deduction failed for invoice ${invoiceId}:`, e.message);
    inventoryResult = { error: e.message };
  }

  if (pi.Task_ID) {
    await quotationEngine.safeAdvanceTask(pi.Task_ID, quotationEngine.TASK_STAGE.SALES_INVOICE, actor, `Sales Invoice ${invoiceNo} generated`);
  }

  return { invoice, inventoryResult };
}

/**
 * Direct Quotation -> Sales Invoice, for orders that skip the proforma step. Creates the PI
 * implicitly so the audit chain stays intact rather than leaving a gap in the lifecycle.
 */
async function convertQuotationToInvoice(quotationId, actor) {
  const pi = await convertQuotationToPI(quotationId, actor);
  return convertPIToInvoice(pi.PI_ID, actor);
}

/** Records payment; a full settlement closes the owning task. */
async function recordPayment(invoiceId, { amount, paymentMode, reference, paidOn }, actor) {
  const invoice = await sheetsService.getSalesInvoiceById(invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const paidSoFar = Number(invoice.Amount_Paid) || 0;
  const increment = Number(amount) || 0;
  const totalPaid = Math.round((paidSoFar + increment) * 100) / 100;
  const grandTotal = Number(invoice.Grand_Total) || 0;
  // Tolerate sub-rupee rounding differences when deciding whether an invoice is settled.
  const isFullyPaid = totalPaid >= grandTotal - 0.5;

  const log = Array.isArray(invoice.Payment_Log) ? invoice.Payment_Log : [];
  const updated = await sheetsService.updateRow('Sales_Invoice_Master', 'Invoice_ID', invoiceId, {
    Amount_Paid: totalPaid,
    Payment_Status: isFullyPaid ? 'Paid' : 'Partially Paid',
    Paid_At: isFullyPaid ? new Date().toISOString() : (invoice.Paid_At || ''),
    Payment_Log: [...log, {
      amount: increment,
      mode: paymentMode || '',
      reference: reference || '',
      paidOn: paidOn || istToday(),
      recordedBy: actor?.staffId || 'SYSTEM',
      timestamp: new Date().toISOString()
    }]
  });

  if (isFullyPaid && invoice.Task_ID) {
    await quotationEngine.safeAdvanceTask(
      invoice.Task_ID,
      quotationEngine.TASK_STAGE.ORDER_CLOSED,
      actor,
      `Payment received in full for invoice ${invoice.Invoice_No}`
    );
  }

  return updated;
}

module.exports = {
  convertQuotationToPI,
  convertPIToInvoice,
  convertQuotationToInvoice,
  recordPayment,
  carryForwardFields
};
