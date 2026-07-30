/**
 * DEFAULT_QUOTATION_SETTINGS — full-shape fallback for the Quotation_Settings doc, mirroring how
 * defaultDocSettings.js backs Document_Settings on the client. Kept server-side too so engine
 * code (GST seller state, approval threshold, reminder cadence) always has concrete values even
 * before an Admin has saved settings once.
 *
 * Secrets are referenced by env-var NAME, never stored inline — see *_ref fields.
 */
const DEFAULT_QUOTATION_SETTINGS = {
  company_id: 'DEFAULT',

  seller_profile: {
    legal_name: 'Expert Safety Solutions',
    gstin: '24COMPP8380J1Z9',
    state_code: '24',
    address: '',
    email: '',
    phone: ''
  },

  payment_terms: [
    { id: 'PT_ADV100', label: '100% Advance', days: 0, description: 'Full payment along with order' },
    { id: 'PT_5050', label: '50% Advance & 50% On Delivery', days: 0, description: '' },
    { id: 'PT_NET15', label: '15 Days Credit', days: 15, description: '' },
    { id: 'PT_NET30', label: '30 Days Credit', days: 30, description: '' }
  ],

  // Suggestions for the quotation Subject line. The builder offers these in a type-to-filter
  // combobox but still accepts free text, so an unusual subject never needs a settings change.
  subject_options: [
    { id: 'SUB_NEW_FE', text: 'New Fire Extinguisher' },
    { id: 'SUB_REFILL', text: 'Fire Extinguisher Refilling' },
    { id: 'SUB_AMC', text: 'Annual Maintenance Contract (AMC)' },
    { id: 'SUB_HYDRANT', text: 'Fire Hydrant System' },
    { id: 'SUB_SPRINKLER', text: 'Fire Sprinkler System' },
    { id: 'SUB_ALARM', text: 'Fire Alarm System' },
    { id: 'SUB_TRAINING', text: 'Fire Safety Training & Consultancy' },
    { id: 'SUB_SAFETY', text: 'Safety Products Supply' }
  ],

  tnc_checklist: [
    { id: 'TNC_VALIDITY', text: 'Quotation valid for 30 days from the date of issue.', default_checked: true },
    { id: 'TNC_GST', text: 'GST as applicable will be charged extra at prevailing rates.', default_checked: true },
    { id: 'TNC_DELIVERY', text: 'Delivery within 7-10 working days from confirmed order.', default_checked: true },
    { id: 'TNC_TRANSPORT', text: 'Transportation and unloading charges to buyer\'s account.', default_checked: false },
    { id: 'TNC_WARRANTY', text: 'Warranty as per manufacturer terms against manufacturing defects only.', default_checked: true },
    { id: 'TNC_JURISDICTION', text: 'All disputes subject to local jurisdiction only.', default_checked: false }
  ],

  banking_details: {
    account_name: '',
    account_no: '',
    ifsc: '',
    bank_name: '',
    branch: '',
    upi_id: ''
  },

  // 'Email' | 'WhatsApp' | 'Both'
  dispatch_mode: 'Email',

  whatsapp_config: {
    enabled: false,
    phone_number_id: '',
    waba_id: '',
    api_version: 'v21.0',
    access_token_ref: 'WHATSAPP_ACCESS_TOKEN',
    business_display_name: ''
  },

  smtp_config: {
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    from_name: 'Expert Safety Solutions',
    from_email: '',
    pass_ref: 'SMTP_PASS'
  },

  /**
   * Per-document email master switch, keyed by draft_templates key.
   *
   * Enforced inside dispatchService.dispatchTemplated, so it covers every sender — the manual Send
   * buttons AND the reminder crons — rather than only the routes that remember to check it.
   *
   * A key that is absent counts as ENABLED: an existing install upgrading into this feature must
   * not silently stop sending quotations. Only the two workshop documents ship off, because they
   * are new and the office does not email them today.
   */
  email_enabled: {
    quotation_email: true,
    followup_reminder: true,
    invoice_payment_due: true,
    pi_email: true,
    invoice_email: true,
    challan_email: false,
    certificate_email: false,
    pod_confirmation: false,
    // ON: the customer is told on screen that a copy has been emailed to them, so suppressing it
    // would make the confirmation page a lie. It is also the customer's only durable record of the
    // reference number and of exactly what we received — the one thing that lets them spot a
    // mistyped mobile number before our follow-up call fails to arrive.
    // The INTERNAL alert is unaffected by this flag: it goes to the office's own inboxes and is
    // sent directly by inquiryDispatch, not through the per-template switch.
    inquiry_acknowledgement: true,
    // Staff press this one deliberately, so there is nothing to protect against.
    company_profile: true
  },

  // Reusable files (product catalogues, brochures, compliance certificates) an Admin uploads once
  // and the builder then ticks per quotation. Each entry:
  //   { id, label, media_id, file_name, mime_type, size_bytes, default_selected }
  // Bytes live in Media_Store (POST /api/media/upload) — only the reference is kept here so the
  // settings doc stays small.
  email_attachments: [],

  // Attach the generated quotation PDF itself to the dispatch email. The PDF is rendered in the
  // browser (same template as the PDF button) and posted with the dispatch request.
  attach_quotation_pdf: true,

  signature_stamp_overlay: {
    show_signature: true,
    show_stamp: true,
    show_watermark: true,
    show_upi_qr: true,
    size: 'medium'
  },

  // Anti-copy tiled watermark: the text is repeated in small diagonal lettering across the whole
  // sheet, so any screenshot of any part of the document still carries the company name and the
  // customer cannot pass the quotation off to another vendor. This is separate from the single
  // centre logo watermark above (signature_stamp_overlay.show_watermark), which stays as-is.
  security_watermark: {
    enabled: true,
    // Blank falls back to seller_profile.legal_name at render time.
    text: 'Expert Safety Solutions',
    angle_deg: -45,
    font_size_px: 9,
    opacity: 0.07,
    // Spacing between diagonal lines in px on the 794x1123 A4 sheet. The text repeats
    // continuously along each line, so only the line pitch is configurable.
    gap_y_px: 46
  },

  approval_threshold: {
    discount_pct_trigger: 10,
    discount_amt_trigger: 0
  },

  // Delivery challan behaviour.
  //
  // Rates are ALWAYS resolved and stored on a challan's line items, so converting one to an invoice
  // needs no second lookup and the figures cannot drift in between. `show_price` controls only
  // whether they are PRINTED. It defaults to off because a delivery challan is a goods-movement
  // document — the person signing for the goods at the gate is usually not the person who should
  // see the pricing.
  //
  // Even with the toggle on, the Rate/Amount columns appear only when at least one line actually
  // carries a rate, so a challan for items with no price on record prints clean instead of showing
  // a column of zeroes.
  challan_config: {
    show_price: false,
    show_hsn: true,
    // Printed under the signature block; blank hides the line entirely.
    declaration: 'Received the above goods in good condition.',
    terms: ''
  },

  defaults: {
    follow_up_interval_days: 3,
    auto_expiry_days: 30,
    default_gst_rate: 18,
    quote_no_prefix: 'EXP/Q',
    pi_no_prefix: 'EXP/PI',
    invoice_no_prefix: 'EXP/INV',
    // A purchase order goes to a vendor, so it draws from the same atomic counter as the outward
    // documents — a repeated PO number lets the same delivery be claimed for payment twice.
    po_no_prefix: 'EXP/PO',
    // Mark-up applied to a vendor's rate when quoting it on to a customer: cost + this % = selling
    // price. A mark-up on cost, not a margin on the sale — "cost plus twenty" is how the office
    // quotes, and reading it the other way would under-price every line.
    default_margin_pct: 20,
    // 'financial' resets the running number each April (Indian FY); 'calendar' resets in January.
    number_reset: 'financial'
  },

  // Up to 4 actions surfaced on the public customer portal. action_key values are the only ones
  // the portal route will honour — labels are cosmetic and admin-editable.
  customer_actions: [
    { action_key: 'ACCEPT', label: 'Accept Quotation', enabled: true },
    { action_key: 'REQUEST_REVISION', label: 'Request Revision', enabled: true },
    { action_key: 'CHANGE_REQUIREMENT', label: 'Change Requirement', enabled: true },
    { action_key: 'REQUEST_REMINDER_DATE', label: 'Request Next Reminder Date', enabled: true }
  ],

  draft_templates: {
    quotation_email: {
      subject: 'Quotation {quote_no} from Expert Safety Solutions',
      body: 'Dear {customer_name},\n\nThank you for your enquiry. Please find our quotation {quote_no} for {amount}.\n\nYou can review and respond here: {view_link}\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    quotation_whatsapp: {
      body: 'Dear {customer_name}, your quotation {quote_no} for {amount} is ready. View & respond: {view_link}',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    followup_reminder: {
      subject: 'Gentle reminder — Quotation {quote_no}',
      body: 'Dear {customer_name},\n\nA gentle reminder regarding quotation {quote_no} for {amount}. Do let us know your feedback.\n\nYou can view and download the quotation from the following link:\n{view_link}\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    invoice_payment_due: {
      subject: 'Payment reminder — Invoice {quote_no} due {due_date}',
      body: 'Dear {customer_name},\n\nInvoice {quote_no} for {amount} is due on {due_date}. Kindly arrange the payment.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // No {view_link} in these two: the customer portal exists only for quotations, so a PI or
    // invoice has no Portal_Guid and the variable would render as the literal placeholder.
    pi_email: {
      subject: 'Proforma Invoice {document_no} from Expert Safety Solutions',
      body: 'Dear {customer_name},\n\nPlease find attached our proforma invoice {document_no} dated {document_date} for {amount}.\n\nKindly confirm so we can proceed with the order.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    invoice_email: {
      subject: 'Tax Invoice {document_no} from Expert Safety Solutions',
      body: 'Dear {customer_name},\n\nPlease find attached tax invoice {document_no} dated {document_date} for {amount}, payable by {due_date}.\n\nThank you for your business.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // A delivery challan is a goods-movement note, so the default body carries no money at all —
    // matching challan_config.show_price, which keeps rates off the printed document too.
    challan_email: {
      subject: 'Delivery Challan {document_no} — Expert Safety Solutions',
      body: 'Dear {customer_name},\n\nPlease find attached delivery challan {document_no} dated {document_date} covering {item_count} line(s):\n\n{item_summary}\n\nKindly acknowledge receipt.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // Sent from the delivery screen once the customer has signed — the "your goods arrived" note.
    // {received_by} and {delivered_at} are unique to this template.
    pod_confirmation: {
      subject: 'Delivery confirmed — {document_no}',
      body: 'Dear {customer_name},\n\nYour equipment against delivery challan {document_no} was delivered on {delivered_at} and received by {received_by}.\n\nThank you for your business.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // {verification_link} is unique to this template — the public QR page for the certificate.
    certificate_email: {
      subject: '{certificate_type} {document_no} — Expert Safety Solutions',
      body: 'Dear {customer_name},\n\nPlease find attached your {certificate_type} {document_no}, issued on {document_date} and valid until {valid_until}.\n\nYou can verify it online at any time here:\n{verification_link}\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // Auto-reply to someone who filled in the public /inquiry form. {inquiry_no} and
    // {requirement_summary} are unique to this template — there is no document behind it yet, so
    // none of the money or document-number variables resolve.
    // The HTML the customer actually sees is built in inquiryDispatch.buildAcknowledgementHtml —
    // a settings template is one plain string and cannot carry a details table or tappable
    // buttons. This body remains the PLAINTEXT alternative (and the WhatsApp text), so it repeats
    // the same facts in full rather than pointing at an HTML part a text-only client will not show.
    inquiry_acknowledgement: {
      subject: 'Thank you for your enquiry — {inquiry_no}',
      body: 'Dear {customer_name},\n\nThank you for contacting Expert Safety Solutions. We have received your enquiry and our team will contact you shortly.\n\nYOUR REFERENCE NUMBER: {inquiry_no}\nPlease quote this when you contact us.\n\n--- DETAILS YOU SUBMITTED ---\nName:         {customer_name}\nMobile:       {customer_phone}\nEmail:        {customer_email}\nCompany:      {company_name}\nGST No:       {customer_gstin}\nSite Address: {site_address}\n\nRequirements: {requirement_summary}\n\nIf any detail above is wrong, simply reply to this email or message us on WhatsApp and we will correct it.\n\nNeed to reach us now?\nCall / WhatsApp: +91 84606 99569\n\nRegards,\nExpert Safety Solutions\nFire Extinguishers | Hydrant Systems | Fire NOC | Safety Audits',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    // Behind the one-click "Send Company Profile" button on a lead. The brochure itself is picked
    // from email_attachments (entries flagged company_profile), not stored here.
    company_profile: {
      subject: 'Expert Safety Solutions — Company Profile',
      body: 'Dear {customer_name},\n\nThank you for your interest. Please find our company profile attached.\n\nWe supply, refill and service fire extinguishers, maintain fire hydrant systems, handle Fire NOC consultancy and renewals, and conduct safety audits and training.\n\nDo let us know how we can help.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    }
  },

  /**
   * Internal recipients of the "new online inquiry" alert.
   *
   * These are the OFFICE's own inboxes, never a customer's, which is why this alert ships enabled
   * while the customer-facing acknowledgement does not. Emptying the list falls back to the
   * built-in defaults in inquiryDispatch — an alert with nobody to alert is a lost lead, and a
   * blank setting is far more likely to be an accident than a deliberate "tell no one".
   */
  inquiry_alert_recipients: [
    'sales.expertsafety@gmail.com',
    'expertsafetysolution@gmail.com'
  ],

  // Offsets (in days relative to invoice due date) at which payment reminders fire.
  // Negative = before due, 0 = on due date, positive = overdue.
  payment_reminder_offsets: [-3, 0, 7],

  /**
   * The hour of day (IST, 0-23) each automatic reminder goes out.
   *
   * Vercel cron cannot be reconfigured from the database, so vercel.json runs one dispatcher every
   * hour and the dispatcher asks THIS setting whether the current hour is the one for a given job.
   * That is why the granularity is an hour and not a minute — see reminderScheduler.js.
   *
   * `null` disables a job outright: the hour never matches, so it simply never runs. Distinct from
   * email_enabled, which stops the mail but still lets the job advance its bookkeeping.
   */
  reminder_schedule: {
    quotation_followup: 11,   // Quotation follow-up reminders
    payment_due: 12,          // Invoice payment-due reminders
    refilling_due: 9,         // Generates refilling-due follow-up TASKS (no customer email)
    annual_prospect: 9        // Generates annual renewal lead TASKS (no customer email)
  }
};

/** Deep-merges a stored settings doc over the defaults so partial saves never lose keys. */
function mergeQuotationSettings(stored) {
  if (!stored) return JSON.parse(JSON.stringify(DEFAULT_QUOTATION_SETTINGS));
  const isPlain = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (base, over) => {
    const out = Array.isArray(base) ? [...base] : { ...base };
    Object.keys(over || {}).forEach(k => {
      if (isPlain(out[k]) && isPlain(over[k])) out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    });
    return out;
  };
  return merge(JSON.parse(JSON.stringify(DEFAULT_QUOTATION_SETTINGS)), stored);
}

module.exports = { DEFAULT_QUOTATION_SETTINGS, mergeQuotationSettings };
