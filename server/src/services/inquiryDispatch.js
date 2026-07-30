/**
 * inquiryDispatch — outbound messaging for the public inquiry engine.
 *
 * Two audiences with opposite risk profiles, which is why they are separated here rather than
 * sharing one path:
 *
 *   INTERNAL ALERT  → the office's own inboxes, listed in settings.inquiry_alert_recipients.
 *                     Safe to send on every submission: the recipients are the business itself,
 *                     so this cannot reach a customer by mistake. It ships ENABLED, because a lead
 *                     nobody is told about is the whole failure this feature exists to prevent.
 *
 *   CUSTOMER ACK    → a real member of the public. Ships DISABLED
 *                     (email_enabled.inquiry_acknowledgement = false), exactly like challan_email,
 *                     certificate_email and pod_confirmation, so deploying this cannot start
 *                     messaging strangers on its own. The office turns it on deliberately.
 *
 * Both still pass through emailService, so MAIL_SAFE_MODE governs them like every other sender —
 * including the internal alert, which is what makes a local test safe.
 */

const sheetsService = require('./sheetsService');
const emailService = require('./emailService');
const whatsappService = require('./whatsappService');
const dispatchService = require('./dispatchService');
const { mergeQuotationSettings } = require('./defaultQuotationSettings');
const { escapeHtml } = require('../utils/htmlEscape');
const inquiryValidator = require('../utils/inquiryValidator');

/**
 * The office inboxes. Configurable in settings, but these two are the specified defaults and are
 * used whenever the setting is missing or has been emptied — an alert with no recipient is a
 * silently lost lead, so falling back is safer than sending nothing.
 */
const DEFAULT_ALERT_RECIPIENTS = [
  'sales.expertsafety@gmail.com',
  'expertsafetysolution@gmail.com'
];

async function getSettings() {
  return mergeQuotationSettings(await sheetsService.getQuotationSettings('DEFAULT'));
}

function alertRecipients(settings) {
  const configured = settings.inquiry_alert_recipients;
  const list = (Array.isArray(configured) ? configured : [])
    .map(e => String(e || '').trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALERT_RECIPIENTS;
}

/**
 * Deep link that opens this lead inside the CRM.
 *
 * Points at the task, not the customer: the task is the unit of work someone has to action, and
 * it carries the requirements and the draft quotation link. Staff hitting this while logged out
 * land on the login screen and arrive here afterwards, which is the existing app behaviour.
 */
function crmLeadLink(task) {
  return `${dispatchService.portalBaseUrl()}/?taskId=${encodeURIComponent(task.Task_ID)}`;
}

/** IST, human-readable, for the alert body. */
function formatIstTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
  }).format(d);
}

/**
 * The internal alert's HTML.
 *
 * Built as a string with every interpolation escaped through escapeHtml. This content originates
 * from an anonymous member of the public and is being rendered inside the office's mail client —
 * React is not in this path, so escaping is manual and non-negotiable. Inline styles only, since
 * mail clients strip <style> blocks.
 */
function buildAlertHtml({ inquiryNo, data, customer, task, isReturning, quotation, submittedAt, submittedIp }) {
  const row = (label, value) => value
    ? `<tr>
         <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;font-weight:600;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
         <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;font-weight:700">${escapeHtml(value).replace(/\n/g, '<br>')}</td>
       </tr>`
    : '';

  const requirementChips = (data.requirements || []).map(key => {
    const label = key === 'OTHER' && data.otherRequirement
      ? `Other: ${data.otherRequirement}`
      : inquiryValidator.labelForRequirement(key);
    return `<span style="display:inline-block;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;
      padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;margin:0 5px 5px 0">${escapeHtml(label)}</span>`;
  }).join('');

  const statusBadge = isReturning
    ? '<span style="background:#dbeafe;color:#1e40af;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800">EXISTING CUSTOMER</span>'
    : '<span style="background:#dcfce7;color:#166534;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800">NEW CUSTOMER</span>';

  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:20px;max-width:640px;margin:0 auto">
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">

    <div style="background:linear-gradient(135deg,#9a3412 0%,#ea580c 100%);padding:22px 24px;color:#ffffff">
      <div style="font-size:11px;font-weight:800;letter-spacing:1px;opacity:.9;text-transform:uppercase">🚨 New Online Inquiry</div>
      <div style="font-size:20px;font-weight:800;margin-top:6px">${escapeHtml(inquiryNo)}</div>
      <div style="font-size:12px;opacity:.92;margin-top:4px">${escapeHtml(formatIstTimestamp(submittedAt))} IST</div>
    </div>

    <div style="padding:20px 24px">
      <div style="margin-bottom:14px">${statusBadge}</div>

      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        ${row('Company', data.companyName)}
        ${row('GST No', data.gstin || '— not provided —')}
        ${row('Site Address', data.address)}
        ${row('Name', data.name)}
        ${row('Designation', data.designation)}
        ${row('Mobile', `+91 ${data.mobile}`)}
        ${/* Only shown when it differs — an identical second number is noise on a lead the
             salesperson is skim-reading before dialling. */ ''}
        ${data.whatsapp && data.whatsapp !== data.mobile ? row('WhatsApp', `+91 ${data.whatsapp}`) : ''}
        ${row('Email', data.email)}
        ${row('Customer ID', customer.Customer_ID)}
        ${row('Lead / Task ID', task.Task_ID)}
        ${quotation ? row('Draft Quotation', `${quotation.Quote_No_Display} (unpriced — rates to be filled)`) : ''}
      </table>

      ${(data.extraContacts || []).length ? `
      <div style="margin-top:16px">
        <div style="color:#64748b;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
          Other contacts at this company
        </div>
        ${data.extraContacts.map(c => `
          <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#f8fafc">
            <div style="font-size:13px;font-weight:800;color:#0f172a">
              ${escapeHtml(c.name || 'Unnamed')}${c.designation ? `<span style="color:#64748b;font-weight:600;font-size:11.5px"> · ${escapeHtml(c.designation)}</span>` : ''}
            </div>
            <div style="font-size:12px;color:#334155;font-weight:600;margin-top:4px">
              ${c.mobile ? `<a href="tel:+91${escapeHtml(c.mobile)}" style="color:#9a3412;text-decoration:none">📞 +91 ${escapeHtml(c.mobile)}</a>` : ''}
              ${c.whatsapp && c.whatsapp !== c.mobile ? `<a href="https://wa.me/91${escapeHtml(c.whatsapp)}" style="color:#16a34a;text-decoration:none;margin-left:10px">💬 +91 ${escapeHtml(c.whatsapp)}</a>` : ''}
              ${c.email ? `<a href="mailto:${escapeHtml(c.email)}" style="color:#0284c7;text-decoration:none;margin-left:10px">✉️ ${escapeHtml(c.email)}</a>` : ''}
            </div>
          </div>
        `).join('')}
      </div>` : ''}

      <div style="margin-top:18px">
        <div style="color:#64748b;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Requirements</div>
        ${requirementChips || '<span style="color:#94a3b8;font-size:12px">None selected</span>'}
      </div>

      ${data.otherRequirement ? `
      <div style="margin-top:16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px">
        <div style="color:#92400e;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px">Customer's description</div>
        <div style="color:#451a03;font-size:13px;line-height:1.6;white-space:pre-wrap">${escapeHtml(data.otherRequirement)}</div>
      </div>` : ''}

      <div style="margin-top:22px;text-align:center">
        <a href="${escapeHtml(crmLeadLink(task))}"
           style="display:inline-block;background:#9a3412;color:#ffffff;text-decoration:none;
                  padding:13px 26px;border-radius:12px;font-weight:800;font-size:14px">
          Open this lead in CRM →
        </a>
      </div>

      <div style="margin-top:18px;text-align:center">
        <a href="tel:+91${escapeHtml(data.mobile)}" style="color:#9a3412;font-size:13px;font-weight:700;text-decoration:none;margin:0 10px">📞 Call</a>
        <a href="https://wa.me/91${escapeHtml(data.mobile)}" style="color:#16a34a;font-size:13px;font-weight:700;text-decoration:none;margin:0 10px">💬 WhatsApp</a>
        <a href="mailto:${escapeHtml(data.email)}" style="color:#0284c7;font-size:13px;font-weight:700;text-decoration:none;margin:0 10px">✉️ Email</a>
      </div>
    </div>

    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 24px;text-align:center">
      <div style="color:#94a3b8;font-size:10.5px;font-weight:600">
        Submitted from the public inquiry form${submittedIp ? ` · IP ${escapeHtml(submittedIp)}` : ''}
      </div>
    </div>
  </div>
</div>`;
}

/** Plaintext twin of the alert, for clients that refuse HTML. */
function buildAlertText({ inquiryNo, data, customer, task, isReturning, quotation, submittedAt }) {
  return [
    `NEW ONLINE INQUIRY — ${inquiryNo}`,
    `${formatIstTimestamp(submittedAt)} IST`,
    isReturning ? 'EXISTING CUSTOMER — added to their profile' : 'NEW CUSTOMER — profile created',
    '',
    `Company:      ${data.companyName}`,
    `GST No:       ${data.gstin || '(not provided)'}`,
    `Site Address: ${data.address}`,
    '',
    `Name:         ${data.name}${data.designation ? ` (${data.designation})` : ''}`,
    `Mobile:       +91 ${data.mobile}`,
    ...(data.whatsapp && data.whatsapp !== data.mobile ? [`WhatsApp:     +91 ${data.whatsapp}`] : []),
    `Email:        ${data.email}`,
    ...((data.extraContacts || []).length
      ? ['', 'OTHER CONTACTS:', ...data.extraContacts.map(c =>
          `  ${c.name || 'Unnamed'}${c.designation ? ` (${c.designation})` : ''}`
          + `${c.mobile ? ` · +91 ${c.mobile}` : ''}`
          + `${c.whatsapp && c.whatsapp !== c.mobile ? ` · WA +91 ${c.whatsapp}` : ''}`
          + `${c.email ? ` · ${c.email}` : ''}`)]
      : []),
    '',
    `Requirements: ${inquiryValidator.summarizeRequirements(data)}`,
    '',
    `Customer ID:  ${customer.Customer_ID}`,
    `Lead/Task ID: ${task.Task_ID}`,
    quotation ? `Draft Quote:  ${quotation.Quote_No_Display} (unpriced)` : '',
    '',
    `Open in CRM:  ${crmLeadLink(task)}`
  ].filter(Boolean).join('\n');
}

/**
 * Sends the internal alert to every configured office address.
 *
 * One email PER recipient rather than a single multi-recipient send, so one bad address cannot
 * suppress delivery to the others and each result is individually reportable. Sent sequentially —
 * this is two messages on a shared SMTP account, and parallel sends risk a rate trip for no
 * meaningful gain.
 *
 * Returns per-recipient results and never throws; the caller has already saved the lead.
 */
async function sendAdminAlert(context) {
  const settings = await getSettings();
  const recipients = alertRecipients(settings);

  const subject = `🚨 New Online Inquiry Received - ${context.data.name} [${context.data.companyName}]`;
  const html = buildAlertHtml(context);
  const body = buildAlertText(context);

  const results = [];
  for (const to of recipients) {
    results.push(await emailService.sendEmail(settings.smtp_config, { to, subject, body, html }));
  }
  return results;
}

/** Public phone number, shown to the customer on their confirmation. */
const OFFICE_PHONE_DISPLAY = '+91 84606 99569';
const OFFICE_PHONE_E164 = '918460699569';

// Sampled from the EXPERT wordmark, matching QuotationPdfTemplate — the quotation that follows
// this email must look like it came from the same company.
const BRAND_RED = '#E01B24';
const BRAND_INK = '#111827';

/**
 * The customer's confirmation email, as branded HTML.
 *
 * Written here rather than as a settings template because a template is one plain-text body: it
 * cannot carry a table of the customer's own details, a red header, or tappable Call/WhatsApp
 * buttons. The editable template still supplies the wording (subject and greeting) — this only
 * supplies the layout around it.
 *
 * Every interpolation is escaped. The values come from a public form, and this lands in the
 * customer's mail client where nothing else would escape them.
 *
 * Layout constraints are email-client constraints, not preferences: tables rather than flexbox,
 * inline styles only (<style> blocks are stripped), and no external CSS or webfonts.
 */
function buildAcknowledgementHtml({ inquiryNo, data }) {
  const row = (label, value) => value
    ? `<tr>
         <td style="padding:8px 0;color:#64748b;font-size:12px;font-weight:600;width:120px;vertical-align:top">${escapeHtml(label)}</td>
         <td style="padding:8px 0;color:${BRAND_INK};font-size:13px;font-weight:700">${escapeHtml(value).replace(/\n/g, '<br>')}</td>
       </tr>`
    : '';

  const chips = (data.requirements || []).map(key => {
    const label = key === 'OTHER' && data.otherRequirement
      ? `Other: ${data.otherRequirement}`
      : inquiryValidator.labelForRequirement(key);
    return `<span style="display:inline-block;background:rgba(224,27,36,0.06);border:1px solid ${BRAND_RED};
      color:${BRAND_RED};padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700;margin:0 5px 6px 0">${escapeHtml(label)}</span>`;
  }).join('');

  const waText = encodeURIComponent(
    `Hello Expert Safety Solutions, I have submitted an enquiry (${inquiryNo}). My name is ${data.name}.`
  );

  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:20px 12px">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">

    <div style="border-bottom:3px solid ${BRAND_RED};padding:20px 24px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${BRAND_INK};letter-spacing:-0.5px">EXPERT SAFETY SOLUTIONS</div>
      <div style="font-size:11px;font-weight:700;color:${BRAND_RED};letter-spacing:1.5px;margin-top:2px">FIRE SAFETY EQUIPMENT &amp; SERVICES</div>
    </div>

    <div style="padding:26px 24px 20px;text-align:center">
      <div style="font-size:19px;font-weight:800;color:${BRAND_INK};margin-bottom:8px">
        Thank you${data.name ? ', ' + escapeHtml(String(data.name).split(' ')[0]) : ''}!
      </div>
      <p style="color:#64748b;font-size:13.5px;line-height:1.65;margin:0;font-weight:500">
        We have received your enquiry and our team will contact you shortly.
      </p>
      <div style="margin-top:18px;background:rgba(224,27,36,0.06);border:1.5px solid ${BRAND_RED};border-radius:12px;padding:14px">
        <div style="font-size:10px;font-weight:800;color:${BRAND_RED};text-transform:uppercase;letter-spacing:1px">Your reference number</div>
        <div style="font-size:20px;font-weight:800;color:${BRAND_INK};margin-top:3px">${escapeHtml(inquiryNo)}</div>
        <div style="font-size:11px;font-weight:600;color:${BRAND_RED};margin-top:4px">Please quote this when you contact us.</div>
      </div>
    </div>

    <div style="padding:0 24px 20px">
      <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
        Details you submitted
      </div>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0">
        ${row('Company', data.companyName)}
        ${row('GST No', data.gstin)}
        ${row('Site Address', data.address)}
        ${row('Name', data.name)}
        ${row('Designation', data.designation)}
        ${row('Mobile', `+91 ${data.mobile}`)}
        ${data.whatsapp && data.whatsapp !== data.mobile ? row('WhatsApp', `+91 ${data.whatsapp}`) : ''}
        ${row('Email', data.email)}
      </table>

      ${(data.extraContacts || []).length ? `
      <div style="margin-top:14px">
        <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
          Other contacts you gave us
        </div>
        ${data.extraContacts.map(c => `
          <div style="font-size:12.5px;color:${BRAND_INK};font-weight:700;padding:4px 0">
            ${escapeHtml(c.name || 'Unnamed')}${c.designation ? `<span style="color:#64748b;font-weight:600"> · ${escapeHtml(c.designation)}</span>` : ''}
            ${c.mobile ? `<span style="color:#64748b;font-weight:600"> · +91 ${escapeHtml(c.mobile)}</span>` : ''}
          </div>
        `).join('')}
      </div>` : ''}

      <div style="margin-top:16px">
        <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
          Requirements
        </div>
        ${chips || '<span style="color:#94a3b8;font-size:12px">—</span>'}
      </div>

      <p style="margin:16px 0 0;font-size:11.5px;color:#94a3b8;font-weight:500;line-height:1.6">
        If any detail above is wrong, simply reply to this email or message us on WhatsApp and we
        will correct it.
      </p>
    </div>

    <div style="padding:0 24px 26px">
      <div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;text-align:center">
        Need to reach us now?
      </div>
      <table style="width:100%;border-collapse:separate;border-spacing:6px 0">
        <tr>
          <td style="width:50%">
            <a href="tel:+${OFFICE_PHONE_E164}"
               style="display:block;background:${BRAND_RED};color:#ffffff;text-decoration:none;text-align:center;
                      padding:14px 10px;border-radius:10px;font-weight:800;font-size:14px">📞 Call Us</a>
          </td>
          <td style="width:50%">
            <a href="https://wa.me/${OFFICE_PHONE_E164}?text=${waText}"
               style="display:block;background:#25D366;color:#ffffff;text-decoration:none;text-align:center;
                      padding:14px 10px;border-radius:10px;font-weight:800;font-size:14px">💬 WhatsApp</a>
          </td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:10px;font-size:12px;font-weight:700;color:#64748b">${OFFICE_PHONE_DISPLAY}</div>
    </div>

    <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 24px;text-align:center">
      <div style="color:#94a3b8;font-size:10.5px;font-weight:600">
        Expert Safety Solutions · Fire Extinguishers · Hydrant Systems · Fire NOC · Safety Audits
      </div>
    </div>
  </div>
</div>`;
}

/**
 * Customer "Thank You" over email and WhatsApp.
 *
 * Routed through dispatchService.dispatchTemplated so it obeys the same machinery as every other
 * customer-facing message: the per-template email_enabled switch, the admin-editable template body,
 * safe mode, and WhatsApp's Meta-approved-template requirement. Being inside that funnel is what
 * makes the enable/disable switch real — it is enforced in dispatchTemplated, not by a check here
 * that a future caller could forget.
 *
 * Channel is forced to 'Both' rather than following dispatch_mode: an acknowledgement is worth
 * sending on every channel the customer gave us, and each still fails independently.
 */
async function sendCustomerAcknowledgement({ inquiryNo, data, task, customer }) {
  const settings = await getSettings();

  return dispatchService.dispatchTemplated({
    // A synthetic document: dispatchService.buildVars reads these snapshot fields, so shaping the
    // inquiry like a document lets it reuse every existing template variable unchanged.
    doc: {
      Customer_ID: customer.Customer_ID,
      Task_ID: task.Task_ID,
      Customer_Name_Snapshot: data.companyName,
      Customer_Auth_Person_Snapshot: data.name,
      Customer_Email_Snapshot: data.email,
      Customer_Contact_Snapshot: `+91 ${data.mobile}`,
      Customer_Address_Snapshot: data.address,
      Customer_GSTIN_Snapshot: data.gstin
    },
    templateKey: 'inquiry_acknowledgement',
    recipientEmail: data.email,
    recipientPhone: `+91 ${data.mobile}`,
    settings,
    channel: 'Both',
    // Branded layout with the customer's own details read back and tappable Call/WhatsApp buttons.
    // The settings template still provides the subject and the plaintext alternative.
    htmlOverride: buildAcknowledgementHtml({ inquiryNo, data }),
    extraVars: {
      inquiry_no: inquiryNo,
      customer_name: data.name,
      company_name: data.companyName,
      requirement_summary: inquiryValidator.summarizeRequirements(data),
      site_address: data.address
    },
    actor: { staffId: 'PUBLIC_INQUIRY', name: 'Online Inquiry' }
  });
}

/**
 * The 1-click "Send Company Profile" action on the CRM lead view.
 *
 * The brochure comes from the existing email_attachments library (Quotation Settings → uploads), so
 * the office manages it in one place instead of this feature owning a second copy. `attachmentIds`
 * lets the caller pick specific entries; omitted, everything flagged company_profile is sent —
 * which is what the one-click button does.
 *
 * WhatsApp cannot carry an attachment through the template API, so it receives a message with the
 * profile link instead; that asymmetry is why each channel reports its own result.
 */
async function sendCompanyProfile({ customer, task, recipientEmail, recipientPhone, attachmentIds, channel, actor }) {
  const settings = await getSettings();

  const library = Array.isArray(settings.email_attachments) ? settings.email_attachments : [];
  const chosen = Array.isArray(attachmentIds) && attachmentIds.length
    ? attachmentIds
    : library.filter(a => a.company_profile).map(a => a.id || a.media_id);

  const attachments = await dispatchService.resolveAttachments({
    catalogIds: chosen,
    settings
  });

  const results = await dispatchService.dispatchTemplated({
    doc: {
      Customer_ID: customer.Customer_ID,
      Task_ID: task?.Task_ID || '',
      Customer_Name_Snapshot: customer.Company_Name || '',
      Customer_Auth_Person_Snapshot: customer.Auth_Person || '',
      Customer_Email_Snapshot: recipientEmail || customer.Email || '',
      Customer_Contact_Snapshot: recipientPhone || customer.Contact || ''
    },
    templateKey: 'company_profile',
    recipientEmail: recipientEmail || customer.Email,
    recipientPhone: recipientPhone || customer.Contact,
    attachments: attachments.length ? attachments : undefined,
    settings,
    channel: channel || 'Both',
    extraVars: {
      customer_name: customer.Auth_Person || customer.Company_Name || 'there',
      company_name: customer.Company_Name || ''
    },
    actor
  });

  // Surfaced so the UI can say "sent, but no brochure was attached" rather than implying the
  // customer received a document that was never uploaded.
  return { results, attachmentCount: attachments.length };
}

/**
 * Freeform WhatsApp fallback used by the acknowledgement when no approved template exists.
 *
 * Meta only permits this inside a 24-hour customer-initiated window, so it will usually fail — it
 * is offered because a web form submission is arguably customer-initiated contact, and a failure
 * here is reported like any other channel failure rather than throwing.
 */
async function sendWhatsappFallback({ to, body }) {
  const settings = await getSettings();
  return whatsappService.sendFreeformText(settings.whatsapp_config, { to, body });
}

module.exports = {
  DEFAULT_ALERT_RECIPIENTS,
  alertRecipients,
  crmLeadLink,
  buildAlertHtml,
  buildAlertText,
  sendAdminAlert,
  sendCustomerAcknowledgement,
  sendCompanyProfile,
  sendWhatsappFallback
};
