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
    || doc.Challan_No || doc.Certificate_No || doc.certificateNo || '';
  // Type-specific dates come first; Created_At is the catch-all, and on a quotation it is the only
  // one present. A challan or certificate carries its own issue date, which is what the customer
  // reads on the paper document.
  const docDate = doc.PI_Date || doc.Invoice_Date || doc.Challan_Date
    || doc.Issue_Date || doc.issueDate || doc.Created_At || '';

  const customerName = doc.Customer_Name_Snapshot || doc.Customer_Name || doc.customerName || '';
  // Challans total in Total_Amount; every priced document elsewhere uses Grand_Total.
  const amount = doc.Grand_Total !== undefined ? doc.Grand_Total : doc.Total_Amount;

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
    taxable_amount: formatCurrency(doc.Subtotal),
    tax_amount: formatCurrency(doc.Total_GST),
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
async function dispatchTemplated({ doc, templateKey, recipientEmail, recipientPhone, attachments, settings, channel, extraVars, actor }) {
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
      // Preserve template line breaks in HTML-rendering clients.
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${body
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
  sendCertificate,
  sendFollowUpReminder,
  sendPaymentDueReminder
};
