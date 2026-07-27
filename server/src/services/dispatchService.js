const sheetsService = require('./sheetsService');
const emailService = require('./emailService');
const whatsappService = require('./whatsappService');
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

function quotePortalLink(quotation) {
  return `${portalBaseUrl()}/api/quote-portal/${quotation.Portal_Guid}`;
}

async function getSettings() {
  return mergeQuotationSettings(await sheetsService.getQuotationSettings('DEFAULT'));
}

/** dd/mm/yyyy for customer-facing text; documents store ISO yyyy-mm-dd. */
function formatDateDMY(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('-');
  return (y && m && d) ? `${d}/${m}/${y}` : String(dateStr);
}

/** "ABC 6Kg - 10 Nos, CO2 4.5Kg - 2 Nos" for item-summary variables. */
function summarizeItems(lineItems) {
  return (lineItems || [])
    .map(l => `${l.Item_Name || ''}${l.Qty ? ` - ${Number(l.Qty)} ${l.Unit || 'Nos'}` : ''}`.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Builds the substitution map shared by every template type.
 *
 * Works across quotations, proforma invoices and sales invoices: document-number and date fields
 * fall back across the three shapes so one template can serve any of them. Keys here must stay in
 * sync with TEMPLATE_VARIABLES in the settings UI, which is what admins pick from.
 */
function buildVars(doc, extra = {}) {
  const docNo = doc.Quote_No_Display || doc.Quote_No || doc.PI_No || doc.Invoice_No || '';
  const docDate = doc.Created_At || doc.PI_Date || doc.Invoice_Date || '';

  return {
    // Customer
    company_name: doc.Customer_Name_Snapshot || '',
    customer_name: doc.Customer_Name_Snapshot || '',
    contact_person: doc.Customer_Auth_Person_Snapshot || doc.Auth_Person || '',
    customer_gstin: doc.Customer_GSTIN_Snapshot || '',
    customer_email: doc.Customer_Email_Snapshot || '',
    customer_phone: doc.Customer_Contact_Snapshot || '',
    customer_address: doc.Customer_Address_Snapshot || '',

    // Document identity
    document_no: docNo,
    quote_no: docNo,
    document_date: formatDateDMY(docDate),
    quotation_date: formatDateDMY(docDate),
    revision_no: doc.Revision_No !== undefined ? String(doc.Revision_No) : '',
    subject: doc.Subject || '',
    category: doc.Category || doc.Subject || '',

    // Money
    amount: formatCurrency(doc.Grand_Total),
    taxable_amount: formatCurrency(doc.Subtotal),
    tax_amount: formatCurrency(doc.Total_GST),
    discount_amount: formatCurrency((Number(doc.Line_Discount_Total) || 0) + (Number(doc.Document_Level_Discount_Amt) || 0)),
    amount_paid: formatCurrency(doc.Amount_Paid || 0),
    balance_due: formatCurrency((Number(doc.Grand_Total) || 0) - (Number(doc.Amount_Paid) || 0)),

    // Dates
    due_date: formatDateDMY(doc.Due_Date || doc.Expiry_Date),
    valid_until: formatDateDMY(doc.Expiry_Date),
    expiry_date: formatDateDMY(doc.Expiry_Date),

    // Items + link
    item_summary: summarizeItems(doc.Line_Items),
    item_count: String((doc.Line_Items || []).length),
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
async function dispatchTemplated({ doc, templateKey, recipientEmail, recipientPhone, attachments, settings, channel }) {
  const cfg = settings || await getSettings();
  const template = cfg.draft_templates?.[templateKey] || {};
  const vars = buildVars(doc);
  // An explicit channel (from the per-channel Email/WhatsApp buttons) overrides the configured
  // dispatch_mode for this send only; it does not change the saved setting.
  const mode = channel || cfg.dispatch_mode || 'Email';

  const wantEmail = mode === 'Email' || mode === 'Both';
  const wantWhatsapp = mode === 'WhatsApp' || mode === 'Both';

  const results = [];

  if (wantEmail) {
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
async function sendQuotation(quotation, attachments, channel) {
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
    channel
  });
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
  sendFollowUpReminder,
  sendPaymentDueReminder
};
