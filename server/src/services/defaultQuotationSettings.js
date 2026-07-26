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

  signature_stamp_overlay: {
    show_signature: true,
    show_stamp: true,
    show_watermark: true,
    show_upi_qr: true,
    size: 'medium'
  },

  approval_threshold: {
    discount_pct_trigger: 10,
    discount_amt_trigger: 0
  },

  defaults: {
    follow_up_interval_days: 3,
    auto_expiry_days: 30,
    default_gst_rate: 18,
    quote_no_prefix: 'EXP/Q',
    pi_no_prefix: 'EXP/PI',
    invoice_no_prefix: 'EXP/INV',
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
      body: 'Dear {customer_name},\n\nA gentle reminder regarding quotation {quote_no} for {amount}. Do let us know your feedback.\n\n{view_link}\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    },
    invoice_payment_due: {
      subject: 'Payment reminder — Invoice {quote_no} due {due_date}',
      body: 'Dear {customer_name},\n\nInvoice {quote_no} for {amount} is due on {due_date}. Kindly arrange the payment.\n\nRegards,\nExpert Safety Solutions',
      whatsapp_template_name: '',
      whatsapp_template_status: 'not_submitted'
    }
  },

  // Offsets (in days relative to invoice due date) at which payment reminders fire.
  // Negative = before due, 0 = on due date, positive = overdue.
  payment_reminder_offsets: [-3, 0, 7]
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
