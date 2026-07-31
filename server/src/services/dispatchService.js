const sheetsService = require('./sheetsService');
const emailService = require('./emailService');
const whatsappService = require('./whatsappService');
const interactionLogger = require('./interactionLogger');
const { mergeQuotationSettings } = require('./defaultQuotationSettings');

/**
 * dispatchService — resolves a draft template, substitutes variables, and fans out to Email and/or
 * WhatsApp according to Quotation_Settings.dispatch_mode.
 *
 * Always resolves to an array of per-channel result objects ({ok, channel, recipient, error}) and
 * never throws for a delivery failure, so callers can record partial success (email sent, WhatsApp
 * template not yet approved) rather than losing the whole dispatch.
 */

const VARIABLE_PATTERN = /\{(\w+)\}/g;

function substitute(template, vars) {
  return String(template || '').replace(VARIABLE_PATTERN, (match, key) =>
    (vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : match
  );
}

function formatCurrency(amount) {
  const n = Number(amount) || 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function portalBaseUrl() {
  // PUBLIC_BASE_URL is preferred; Vercel injects VERCEL_URL (host only, no scheme) on deployments.
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 5000}`;
}

// Short /q/ path keeps the customer-facing link readable. Quotations issued before Portal_Code
// existed fall back to their long GUID, which the same route still resolves.
function quotePortalLink(quotation) {
  return `${portalBaseUrl()}/q/${quotation.Portal_Code || quotation.Portal_Guid}`;
}

async function getSettings() {
  return mergeQuotationSettings(await sheetsService.getQuotationSettings('DEFAULT'));
}

/**
 * dd/mm/yyyy for customer-facing text; documents store ISO yyyy-mm-dd.
 *
 * Sliced to 10 chars first because certificates store full ISO timestamps in the same fields that
 * carry plain dates elsewhere — splitting one of those on '-' otherwise yields "28T01:14:43.155Z".
 */
function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : String(dateStr);
}

/**
 * "ABC 6Kg - 10 Nos, CO2 4.5Kg - 2 Nos" for item-summary variables.
 *
 * Certificate rows use camelCase (itemName/qty) and already carry their unit inside the qty string
 * ("5 Nos."), so a numeric qty gets a unit appended and a pre-formatted one is passed through.
 */
function summarizeItems(lineItems) {
  return (lineItems || [])
    .map(l => {
      const name = l.Item_Name || l.itemName || '';
      const qty = l.Qty !== undefined ? l.Qty : l.qty;
      if (qty === undefined || qty === null || qty === '') return name.trim();
      const qtyText = Number.isFinite(Number(qty)) ? `${Number(qty)} ${l.Unit || l.unit || 'Nos'}` : String(qty);
      return `${name} - ${qtyText}`.trim();
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * Builds the substitution map shared by every template type.
 *
 * Works across quotations, proforma invoices, sales invoices, delivery challans and certificates:
 * document-number, date, party and amount fields fall back across every shape so one template can
 * serve any of them. Keys here must stay in sync with TEMPLATE_VARIABLES in the settings UI, which
 * is what admins pick from.
 *
 * Certificates are the awkward one — Document_Registry stores both casings of every field (see
 * CLAUDE.md), so each certificate fallback needs its camelCase twin.
 */
function buildVars(doc, extra = {}) {
  const docNo = doc.Quote_No_Display || doc.Quote_No || doc.PI_No || doc.Invoice_No
    || doc.Challan_No || doc.Certificate_No || doc.certificateNo || doc.PO_No || '';
  // Type-specific dates come first; Created_At is the catch-all, and on a quotation it is the only
  // one present. A challan or certificate carries its own issue date, which is what the customer
  // reads on the paper document.
  const docDate = doc.PI_Date || doc.Invoice_Date || doc.Challan_Date
    || doc.Issue_Date || doc.issueDate || doc.PO_Date || doc.Created_At || '';

  const customerName = doc.Customer_Name_Snapshot || doc.Customer_Name || doc.customerName
    || doc.Vendor_Name || doc.Vendor_Name_Snapshot || '';
  // Challans total in Total_Amount; every priced document elsewhere uses Grand_Total.
  let amount = doc.Grand_Total !== undefined ? doc.Grand_Total : doc.Total_Amount;
  let subtotal = doc.Subtotal;
  let totalGst = doc.Total_GST;

  if (doc.PO_ID) {
    let totalTaxable = 0;
    let totalTax = 0;
    for (const l of (doc.Lines || [])) {
      const taxable = l.Line_Total || 0;
      const gstPct = l.GST_Rate || 0;
      const gstAmt = taxable * (gstPct / 100);
      totalTaxable += taxable;
      totalTax += gstAmt;
    }
    amount = totalTaxable + totalTax;
    subtotal = totalTaxable;
    totalGst = totalTax;
  }

  return {
    // Customer
    company_name: customerName,
    customer_name: customerName,
    contact_person: doc.Customer_Auth_Person_Snapshot || doc.Auth_Person || '',
    customer_gstin: doc.Customer_GSTIN_Snapshot || doc.GSTIN || doc.gstin || '',
    customer_email: doc.Customer_Email_Snapshot || '',
    customer_phone: doc.Customer_Contact_Snapshot || doc.contact || '',
    customer_address: doc.Customer_Address_Snapshot || doc.Address || doc.address || '',

    // Document identity
    document_no: docNo,
    quote_no: docNo,
    document_date: formatDateDMY(docDate),
    quotation_date: formatDateDMY(docDate),
    revision_no: doc.Revision_No !== undefined ? String(doc.Revision_No) : '',
    subject: doc.Subject || '',
    category: doc.Category || doc.Subject || '',

    // Money
    amount: formatCurrency(amount),
    taxable_amount: formatCurrency(subtotal),
    tax_amount: formatCurrency(totalGst),
    discount_amount: formatCurrency((Number(doc.Line_Discount_Total) || 0) + (Number(doc.Document_Level_Discount_Amt) || 0)),
    amount_paid: formatCurrency(doc.Amount_Paid || 0),
    balance_due: formatCurrency((Number(amount) || 0) - (Number(doc.Amount_Paid) || 0)),

    // Dates. valid_until serves both a quotation's expiry and a certificate's validity — one
    // template variable, whichever of the two the document actually has.
    due_date: formatDateDMY(doc.Due_Date || doc.Expiry_Date),
    valid_until: formatDateDMY(doc.Expiry_Date || doc.Valid_Until || doc.validUntil),
    expiry_date: formatDateDMY(doc.Expiry_Date),

    // Items + link. A certificate's rows live in itemsList, a challan's in Line_Items.
    item_summary: summarizeItems(doc.Line_Items || doc.itemsList),
    item_count: String((doc.Line_Items || doc.itemsList || []).length),
    view_link: doc.Portal_Guid ? quotePortalLink(doc) : '',

    // Despatch details — optional on every document type. Substitute() leaves an unmatched
    // {token} as literal text, so a template built around these must phrase the sentence to still
    // read sensibly when one is blank (see po_reminder's default body).
    despatch_through: doc.Despatch_Through || '',
    agent_name: doc.Agent_Name || '',
    vehicle_no: doc.Vehicle_No || '',

    // Assigned staff / seller
    sales_person: doc.Assigned_Staff || '',
    payment_status: doc.Payment_Status || '',

    ...extra
  };
}

/**
 * Sends one templated message set across the configured channels.
 *
 * WhatsApp goes out as an approved template (Meta forbids freeform business-initiated messages),
 * with named variables mapped to the positional body params Meta expects, in the fixed order
 * customer_name, quote_no, amount, view_link. Templates must be authored in that parameter order.
 */
async function dispatchTemplated({ doc, templateKey, recipientEmail, recipientPhone, attachments, settings, channel, extraVars, actor, htmlOverride }) {
  const cfg = settings || await getSettings();
  const template = cfg.draft_templates?.[templateKey] || {};
  const vars = buildVars(doc, extraVars);
  // An explicit channel (from the per-channel Email/WhatsApp buttons) overrides the configured
  // dispatch_mode for this send only; it does not change the saved setting.
  const mode = channel || cfg.dispatch_mode || 'Email';

  const wantEmail = mode === 'Email' || mode === 'Both';
  const wantWhatsapp = mode === 'WhatsApp' || mode === 'Both';

  const results = [];

  // Per-document email switch (Quotation Settings -> Email Templates). Checked here rather than in
  // each route so it also governs the reminder crons, and reported as a normal per-channel failure
  // so callers see WHY nothing went out instead of a silent no-op. An absent key means enabled.
  if (wantEmail && cfg.email_enabled?.[templateKey] === false) {
    results.push({
      ok: false,
      channel: 'Email',
      recipient: recipientEmail || '',
      disabled: true,
      error: 'Email for this document type is switched off in Quotation Settings → Email Templates'
    });
  } else if (wantEmail) {
    const body = substitute(template.body, vars);
    results.push(await emailService.sendEmail(cfg.smtp_config, {
      to: recipientEmail,
      subject: substitute(template.subject, vars),
      body,
      /*
       * `htmlOverride` lets a caller supply a designed layout instead of the auto-generated one.
       *
       * The default below can only ever produce the template's plain text in a <pre>-like wrapper,
       * which is right for a quotation covering note but cannot express a table of the customer's
       * own details or tappable Call/WhatsApp buttons. The caller owns escaping when it overrides —
       * inquiryDispatch escapes every interpolation through escapeHtml.
       *
       * `body` is still sent as the plaintext alternative either way, so a client that refuses HTML
       * always has something readable.
       */
      html: htmlOverride
        || `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${body
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>')}</div>`,
      attachments
    }));
  }

  if (wantWhatsapp) {
    const status = String(template.whatsapp_template_status || '').toLowerCase();
    if (template.whatsapp_template_name && status && status !== 'approved') {
      results.push({
        ok: false,
        channel: 'WhatsApp',
        recipient: recipientPhone || '',
        error: `WhatsApp template "${template.whatsapp_template_name}" is ${template.whatsapp_template_status} — Meta approval is required before it can be sent`
      });
    } else {
      results.push(await whatsappService.sendTemplate(cfg.whatsapp_config, {
        to: recipientPhone,
        templateName: template.whatsapp_template_name,
        languageCode: template.whatsapp_language_code || 'en',
        bodyParams: [vars.customer_name, vars.quote_no, vars.amount, vars.view_link]
      }));
    }
  }

  // Auto-records what went out on the owning task's discussion timeline. Placed here, in the one
  // funnel every send passes through, so each document type is covered without its own call site.
  // Awaited but never allowed to fail the dispatch — the message has already left either way.
  try {
    await interactionLogger.logDispatch({ doc, templateKey, results, actor });
  } catch (e) {
    console.error('Dispatch timeline logging failed:', e.message);
  }

  return results;
}

/**
 * Turns the builder's attachment picks into nodemailer attachment objects.
 *
 * Two sources are merged:
 *  - `catalogIds` — ids from settings.email_attachments; the bytes are pulled out of Media_Store.
 *  - `inline` — files the browser produced for this send (the quotation PDF), already base64.
 *
 * A catalogue whose media row has been deleted is skipped rather than failing the whole dispatch —
 * losing one brochure must never block the quotation itself from going out.
 */
async function resolveAttachments({ catalogIds, inline, settings }) {
  const out = [];

  (Array.isArray(inline) ? inline : []).forEach(a => {
    const content = String(a?.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!content) return;
    out.push({
      filename: a.fileName || 'attachment.pdf',
      content,
      encoding: 'base64',
      contentType: a.mimeType || 'application/pdf'
    });
  });

  const ids = Array.isArray(catalogIds) ? catalogIds.filter(Boolean) : [];
  if (ids.length) {
    const library = settings.email_attachments || [];
    for (const id of ids) {
      const entry = library.find(e => e.id === id || e.media_id === id);
      if (!entry?.media_id) continue;
      const media = await sheetsService.getMediaById(entry.media_id);
      if (!media?.Data) continue;
      out.push({
        filename: entry.file_name || media.File_Name || 'catalogue.pdf',
        content: media.Data,
        encoding: 'base64',
        contentType: entry.mime_type || media.Mime_Type || 'application/pdf'
      });
    }
  }

  return out;
}

/**
 * `attachments` may be a ready-made nodemailer array (legacy callers) or a
 * { catalogIds, inline } picker payload from the builder.
 */
async function sendQuotation(quotation, attachments, channel, actor) {
  const settings = await getSettings();

  let resolved = attachments;
  if (attachments && !Array.isArray(attachments)) {
    resolved = await resolveAttachments({
      catalogIds: attachments.catalogIds,
      inline: attachments.inline,
      settings
    });
  }

  return dispatchTemplated({
    doc: quotation,
    templateKey: 'quotation_email',
    recipientEmail: quotation.Customer_Email_Snapshot,
    recipientPhone: quotation.Customer_Contact_Snapshot,
    attachments: resolved && resolved.length ? resolved : undefined,
    settings,
    channel,
    actor
  });
}

/**
 * Proforma invoice / tax invoice dispatch.
 *
 * Same shape as sendQuotation, minus the portal: neither document has a Portal_Guid, so {view_link}
 * is empty for them and their default templates do not use it. Both are send-on-demand only — there
 * is deliberately no auto-send at issue time, because a wrong rate on an issued invoice is not
 * something an un-sending can take back.
 */
async function sendSalesDocument(doc, templateKey, attachments, channel, extraVars, actor) {
  const settings = await getSettings();

  let resolved = attachments;
  if (attachments && !Array.isArray(attachments)) {
    resolved = await resolveAttachments({
      catalogIds: attachments.catalogIds,
      inline: attachments.inline,
      settings
    });
  }

  return dispatchTemplated({
    doc,
    templateKey,
    recipientEmail: doc.Customer_Email_Snapshot,
    recipientPhone: doc.Customer_Contact_Snapshot,
    attachments: resolved && resolved.length ? resolved : undefined,
    settings,
    channel,
    extraVars,
    actor
  });
}

function sendProformaInvoice(pi, attachments, channel, actor) {
  return sendSalesDocument(pi, 'pi_email', attachments, channel, undefined, actor);
}

function sendSalesInvoice(invoice, attachments, channel, actor) {
  return sendSalesDocument(invoice, 'invoice_email', attachments, channel, undefined, actor);
}

/**
 * Delivery challan dispatch.
 *
 * A challan is built from a job card, and job cards only started snapshotting the customer's email
 * recently — so the address is resolved from the live Customer_Master row when the snapshot is
 * blank, which is every challan raised before that. `recipientEmail` is passed in by the route,
 * which does that lookup; this only fills the template.
 */
function sendChallan(challan, { recipientEmail, attachments, channel, actor } = {}) {
  return sendSalesDocument(
    { ...challan, Customer_Email_Snapshot: recipientEmail || challan.Customer_Email_Snapshot || '' },
    'challan_email',
    attachments,
    channel,
    undefined,
    actor
  );
}

/**
 * Proof-of-delivery confirmation, sent once the customer has signed at the gate.
 *
 * Ships disabled (email_enabled.pod_confirmation defaults to false): an existing install should not
 * suddenly start messaging every customer the moment it updates. The office turns it on when they
 * want it.
 */
function sendPodConfirmation(challan, { recipientEmail, channel, actor } = {}) {
  const pod = challan.POD || {};
  return sendSalesDocument(
    { ...challan, Customer_Email_Snapshot: recipientEmail || challan.Customer_Email_Snapshot || '' },
    'pod_confirmation',
    undefined,
    channel,
    {
      received_by: pod.receivedByName || 'the customer',
      delivered_at: formatDeliveredAt(pod.deliveredAt || challan.Delivered_At)
    },
    actor
  );
}

/** Delivery timestamps are shown in IST — the deployment clock is not necessarily Indian. */
function formatDeliveredAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  }).format(d);
}

/**
 * Certificate dispatch.
 *
 * Certificates live in Document_Registry with both casings of every field and carry no email of
 * their own, so the route resolves the address from Customer_ID and passes it in. The verification
 * link is the same public QR URL printed on the document, which is the most useful thing the mail
 * can carry — it stays valid even if the attachment is lost.
 */
function sendCertificate(certificate, { recipientEmail, attachments, channel, actor } = {}) {
  const guid = certificate.Verification_GUID || certificate.verificationGuid || '';
  return sendSalesDocument(
    { ...certificate, Customer_Email_Snapshot: recipientEmail || '' },
    'certificate_email',
    attachments,
    channel,
    {
      certificate_type: certificate.Format_Type || certificate.formatType || 'Certificate',
      certificate_no: certificate.Certificate_No || certificate.certificateNo || '',
      verification_link: guid ? `${portalBaseUrl()}/api/verify-certificate/${guid}` : ''
    },
    actor
  );
}

async function sendFollowUpReminder(quotation) {
  const settings = await getSettings();
  return dispatchTemplated({
    doc: quotation,
    templateKey: 'followup_reminder',
    recipientEmail: quotation.Customer_Email_Snapshot,
    recipientPhone: quotation.Customer_Contact_Snapshot,
    settings
  });
}

async function sendPaymentDueReminder(invoice) {
  const settings = await getSettings();
  return dispatchTemplated({
    doc: invoice,
    templateKey: 'invoice_payment_due',
    recipientEmail: invoice.Customer_Email_Snapshot,
    recipientPhone: invoice.Customer_Contact_Snapshot,
    settings
  });
}

/**
 * Both PO senders used to hard-code their subject/body directly in JS — the only two document
 * types in the file that did not go through dispatchTemplated. That meant nothing here was
 * editable from Quotation Settings the way every other document's wording is: the office could
 * change what a customer email says but never what a vendor email or reminder says. Both now
 * resolve `po_email` / `po_reminder` from settings.draft_templates, same as everything else.
 *
 * Returns just the vars dispatchTemplated cannot derive alone: buildVars' generic PO branch does
 * NOT know who is being addressed, so {customer_name} etc. must be pointed at the vendor here, and
 * a PO's amount/tax split is computed from doc.Lines rather than doc.Grand_Total (a PO never gets
 * that field written — see priceLines in purchaseService).
 */
function poExtraVars(po, vendor) {
  let totalTaxable = 0;
  let totalTax = 0;
  for (const l of (po.Lines || [])) {
    const taxable = l.Line_Total || 0;
    totalTaxable += taxable;
    totalTax += taxable * ((l.GST_Rate || 0) / 100);
  }
  return {
    customer_name: vendor.Vendor_Name || po.Vendor_Name,
    company_name: vendor.Vendor_Name || po.Vendor_Name,
    customer_email: vendor.Email || '',
    amount: formatCurrency(totalTaxable + totalTax),
    taxable_amount: formatCurrency(totalTaxable),
    tax_amount: formatCurrency(totalTax)
  };
}

async function sendPurchaseOrder(po, vendor, attachments, channel, actor) {
  const settings = await getSettings();

  let resolved = attachments;
  if (attachments && !Array.isArray(attachments)) {
    resolved = await resolveAttachments({
      catalogIds: attachments.catalogIds,
      inline: attachments.inline,
      settings
    });
  }

  const results = await dispatchTemplated({
    doc: po,
    templateKey: 'po_email',
    recipientEmail: vendor.Email || '',
    recipientPhone: vendor.Phone || '',
    attachments: resolved && resolved.length ? resolved : undefined,
    settings,
    channel,
    extraVars: poExtraVars(po, vendor),
    actor
  });

  try {
    await interactionLogger.logDispatch({ doc: po, templateKey: 'po_email', results, actor });
  } catch (e) {
    console.error('interactionLogger.logDispatch PO error:', e);
  }

  return results;
}

async function sendPurchaseOrderReminder(po, vendor, actor) {
  const settings = await getSettings();

  const results = await dispatchTemplated({
    doc: po,
    templateKey: 'po_reminder',
    recipientEmail: vendor.Email || '',
    recipientPhone: vendor.Phone || '',
    settings,
    // Reminders go by whatever channels are actually usable for this vendor, not the global
    // dispatch_mode — a vendor with a phone but a bounced email should still get chased on WhatsApp.
    channel: vendor.Email && vendor.Phone ? 'Both' : (vendor.Phone ? 'WhatsApp' : 'Email'),
    extraVars: poExtraVars(po, vendor),
    actor
  });

  try {
    await interactionLogger.logDispatch({ doc: po, templateKey: 'po_reminder', results, actor });
  } catch (e) {
    console.error('interactionLogger.logDispatch PO reminder error:', e);
  }

  return results;
}

module.exports = {
  substitute,
  buildVars,
  formatCurrency,
  quotePortalLink,
  portalBaseUrl,
  dispatchTemplated,
  resolveAttachments,
  sendQuotation,
  sendProformaInvoice,
  sendSalesInvoice,
  sendChallan,
  sendPodConfirmation,
  sendCertificate,
  sendFollowUpReminder,
  sendPaymentDueReminder,
  sendPurchaseOrder,
  sendPurchaseOrderReminder
};
