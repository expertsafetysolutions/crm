import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Save, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle,
  Mail, MessageSquare, Landmark, FileText, Percent, Shield, ChevronDown
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isUpiDeepLink, extractUpiVpa } from '../utils/quotationUtils';

/**
 * Module A settings surface — payment terms, T&C, banking/UPI, dispatch channels, message
 * templates and the discount approval threshold.
 *
 * Dedicated route (like DocSettingsPage) rather than a dashboard tab: it's a large, rarely-visited
 * configuration screen. Secrets are never edited here — the SMTP password and WhatsApp token live
 * in environment variables and only their variable NAMES are configured.
 */
const TABS = [
  { id: 'company', label: 'Company & Bank', icon: Landmark },
  { id: 'terms', label: 'Terms & T&C', icon: FileText },
  { id: 'channels', label: 'Channels & Credentials', icon: Mail },
  { id: 'email_templates', label: 'Email Templates', icon: Mail },
  { id: 'whatsapp_templates', label: 'WhatsApp Templates', icon: MessageSquare },
  { id: 'rules', label: 'Approval & Defaults', icon: Percent }
];

// Email templates carry a subject line; WhatsApp templates additionally need a Meta-approved
// template name, since freeform business-initiated WhatsApp messages are not permitted.
const EMAIL_TEMPLATES = [
  { key: 'quotation_email', label: 'Quotation Dispatch', hint: 'Sent when you dispatch a quotation to a customer.' },
  { key: 'followup_reminder', label: 'Quotation Follow-up Reminder', hint: 'Sent automatically at your configured follow-up interval while a quotation is still open.' },
  { key: 'invoice_payment_due', label: 'Invoice Payment Due', hint: 'Sent around the invoice due date, per the reminder schedule under Approval & Defaults.' }
];

const WHATSAPP_TEMPLATES = [
  { key: 'quotation_whatsapp', label: 'Quotation Dispatch', hint: 'Sent when you dispatch a quotation, if WhatsApp is an enabled channel.' },
  { key: 'followup_reminder', label: 'Quotation Follow-up Reminder', hint: 'Shares the follow-up template body with email; the WhatsApp template name below is what Meta actually sends.' },
  { key: 'invoice_payment_due', label: 'Invoice Payment Due', hint: 'Shares the payment-reminder body with email; Meta sends via the approved template named below.' }
];

/**
 * Variables available in message templates, grouped for the click-to-insert picker.
 * Keys must match buildVars() in server/src/services/dispatchService.js.
 */
const TEMPLATE_VARIABLES = [
  {
    group: 'Customer',
    items: [
      { token: '{company_name}', label: 'Company Name' },
      { token: '{contact_person}', label: 'Contact Person' },
      { token: '{customer_gstin}', label: 'Customer GSTIN' },
      { token: '{customer_email}', label: 'Customer Email' },
      { token: '{customer_phone}', label: 'Customer Phone' },
      { token: '{customer_address}', label: 'Customer Address' }
    ]
  },
  {
    group: 'Document',
    items: [
      { token: '{document_no}', label: 'Document No.' },
      { token: '{document_date}', label: 'Document Date' },
      { token: '{revision_no}', label: 'Revision No.' },
      { token: '{subject}', label: 'Subject' },
      { token: '{category}', label: 'Category' },
      { token: '{view_link}', label: 'Customer View Link' }
    ]
  },
  {
    group: 'Amounts',
    items: [
      { token: '{amount}', label: 'Grand Total' },
      { token: '{taxable_amount}', label: 'Taxable Value' },
      { token: '{tax_amount}', label: 'GST Amount' },
      { token: '{discount_amount}', label: 'Discount' },
      { token: '{amount_paid}', label: 'Amount Paid' },
      { token: '{balance_due}', label: 'Balance Due' }
    ]
  },
  {
    group: 'Dates & Items',
    items: [
      { token: '{due_date}', label: 'Due Date' },
      { token: '{valid_until}', label: 'Valid Until' },
      { token: '{item_summary}', label: 'Item Summary' },
      { token: '{item_count}', label: 'Item Count' },
      { token: '{sales_person}', label: 'Sales Person' },
      { token: '{payment_status}', label: 'Payment Status' }
    ]
  }
];

export default function QuotationSettingsPage() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('company');
  const [waTemplates, setWaTemplates] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/quotation-settings', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) setSettings(await res.json());
      } finally { setLoading(false); }
    })();
  }, [token]);

  const flash = (text, kind = 'ok') => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 5000); };
  const set = (path, value) => {
    setSettings(s => {
      const next = structuredClone(s);
      const keys = path.split('.');
      let cur = next;
      for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  };

  const save = async () => {
    if (!isAdmin) return flash('Only an Admin can change these settings.', 'err');
    setSaving(true);
    try {
      const res = await fetch('/api/quotation-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(settings)
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Save failed');
      flash('Settings saved.');
    } catch (e) {
      flash(e.message, 'err');
    } finally { setSaving(false); }
  };

  const testEmail = async () => {
    const to = window.prompt('Send a test email to which address?');
    if (!to) return;
    const res = await fetch('/api/quotation-settings/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to })
    });
    const data = await res.json();
    flash(res.ok && data.ok !== false ? 'Test email sent.' : `Failed: ${data.error || 'unknown error'}`, res.ok && data.ok !== false ? 'ok' : 'err');
  };

  const loadWaTemplates = async () => {
    const res = await fetch('/api/quotation-settings/whatsapp-templates', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (res.ok) { setWaTemplates(data); flash(`${data.length} template(s) found.`); }
    else { flash(data.error || 'Could not list templates', 'err'); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  if (!settings) return <div className="min-h-screen flex items-center justify-center text-slate-500">Could not load settings.</div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 hover:bg-slate-100 rounded-lg"><ArrowLeft className="w-4 h-4" /></button>
          <h1 className="font-bold flex-1">Quotation & Invoice Settings</h1>
          <button onClick={save} disabled={saving || !isAdmin}
            className="px-4 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-2 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
        <div className="max-w-4xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs font-bold whitespace-nowrap border-b-2 flex items-center gap-1.5 ${tab === t.id ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-5 space-y-4">
        {!isAdmin && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
            <Shield className="w-4 h-4" /> You can view these settings but only an Admin can change them.
          </div>
        )}
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-center gap-2 ${msg.kind === 'err' ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
            {msg.kind === 'err' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{msg.text}
          </div>
        )}

        {tab === 'company' && (
          <>
            <Card title="Seller Profile" hint="Your GSTIN's state code decides whether CGST+SGST or IGST is applied.">
              <Grid>
                <Field label="Legal name" value={settings.seller_profile.legal_name} onChange={v => set('seller_profile.legal_name', v)} />
                <Field label="GSTIN" value={settings.seller_profile.gstin}
                  onChange={v => {
                    const clean = v.toUpperCase().replace(/\s/g, '');
                    set('seller_profile.gstin', clean);
                    if (clean.length >= 2) set('seller_profile.state_code', clean.slice(0, 2));
                  }} />
                <Field label="State code" value={settings.seller_profile.state_code} onChange={v => set('seller_profile.state_code', v)} />
                <Field label="Phone" value={settings.seller_profile.phone} onChange={v => set('seller_profile.phone', v)} />
                <Field label="Email" value={settings.seller_profile.email} onChange={v => set('seller_profile.email', v)} />
              </Grid>
              <Field label="Address" textarea value={settings.seller_profile.address} onChange={v => set('seller_profile.address', v)} />
            </Card>

            <Card title="Bank & UPI" hint="Printed on quotations/invoices. The UPI ID generates the payment QR code.">
              <Grid>
                <Field label="Account name" value={settings.banking_details.account_name} onChange={v => set('banking_details.account_name', v)} />
                <Field label="Bank name" value={settings.banking_details.bank_name} onChange={v => set('banking_details.bank_name', v)} />
                <Field label="Account number" value={settings.banking_details.account_no} onChange={v => set('banking_details.account_no', v)} />
                <Field label="IFSC" value={settings.banking_details.ifsc} onChange={v => set('banking_details.ifsc', v)} />
                <Field label="Branch" value={settings.banking_details.branch} onChange={v => set('banking_details.branch', v)} />
                <UpiField value={settings.banking_details.upi_id} onChange={v => set('banking_details.upi_id', v)} />
              </Grid>
            </Card>

            <Card title="PDF Overlays">
              <div className="space-y-2">
                {[['show_signature', 'Show signatory name & line'], ['show_stamp', 'Show company stamp'], ['show_watermark', 'Show watermark'], ['show_upi_qr', 'Show UPI payment QR']].map(([k, label]) => (
                  <Toggle key={k} label={label} checked={settings.signature_stamp_overlay[k] !== false}
                    onChange={v => set(`signature_stamp_overlay.${k}`, v)} />
                ))}
              </div>
            </Card>
          </>
        )}

        {tab === 'terms' && (
          <>
            <Card title="Payment Terms" hint="Selectable on each quotation. 'Days' drives the invoice due date.">
              <ListEditor
                rows={settings.payment_terms}
                onChange={rows => set('payment_terms', rows)}
                newRow={() => ({ id: `PT_${Date.now()}`, label: '', days: 0, description: '' })}
                render={(row, update) => (
                  <div className="flex gap-2 flex-1">
                    <input value={row.label} onChange={e => update({ label: e.target.value })} placeholder="e.g. 30 Days Credit"
                      className="flex-1 px-2 py-1.5 border border-slate-200 rounded-lg text-sm" />
                    <input type="number" value={row.days} onChange={e => update({ days: Number(e.target.value) })} placeholder="days"
                      className="w-24 px-2 py-1.5 border border-slate-200 rounded-lg text-sm" />
                  </div>
                )} />
            </Card>

            <Card title="Terms & Conditions" hint="Checked items are pre-selected on new quotations.">
              <ListEditor
                rows={settings.tnc_checklist}
                onChange={rows => set('tnc_checklist', rows)}
                newRow={() => ({ id: `TNC_${Date.now()}`, text: '', default_checked: true })}
                render={(row, update) => (
                  <div className="flex gap-2 flex-1 items-start">
                    <input type="checkbox" checked={!!row.default_checked} onChange={e => update({ default_checked: e.target.checked })} className="mt-2" />
                    <textarea value={row.text} onChange={e => update({ text: e.target.value })} rows={2} placeholder="Term text"
                      className="flex-1 px-2 py-1.5 border border-slate-200 rounded-lg text-sm" />
                  </div>
                )} />
            </Card>

            <Card title="Customer Portal Actions" hint="Up to 4 buttons shown on the public quotation link.">
              <div className="space-y-2">
                {(settings.customer_actions || []).map((a, i) => (
                  <div key={a.action_key} className="flex items-center gap-2">
                    <input type="checkbox" checked={a.enabled !== false}
                      onChange={e => set('customer_actions', settings.customer_actions.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))} />
                    <input value={a.label}
                      onChange={e => set('customer_actions', settings.customer_actions.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      className="flex-1 px-2 py-1.5 border border-slate-200 rounded-lg text-sm" />
                    <code className="text-[10px] text-slate-400 w-40 truncate">{a.action_key}</code>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}

        {tab === 'channels' && (
          <>
            <Card title="Dispatch Mode">
              <div className="flex gap-2">
                {['Email', 'WhatsApp', 'Both'].map(m => (
                  <button key={m} onClick={() => set('dispatch_mode', m)}
                    className={`px-4 py-2 rounded-lg text-sm font-bold border ${settings.dispatch_mode === m ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 hover:bg-slate-50'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </Card>

            <Card title="SMTP (Email)" hint="The password is read from the environment variable named below — it is never stored in the database.">
              <Toggle label="Enable email sending" checked={!!settings.smtp_config.enabled} onChange={v => set('smtp_config.enabled', v)} />
              <Grid>
                <Field label="Host" value={settings.smtp_config.host} onChange={v => set('smtp_config.host', v)} />
                <Field label="Port" type="number" value={settings.smtp_config.port} onChange={v => set('smtp_config.port', Number(v))} />
                <Field label="Username" value={settings.smtp_config.user} onChange={v => set('smtp_config.user', v)} />
                <Field label="From email" value={settings.smtp_config.from_email} onChange={v => set('smtp_config.from_email', v)} />
                <Field label="From name" value={settings.smtp_config.from_name} onChange={v => set('smtp_config.from_name', v)} />
                <Field label="Password env var" value={settings.smtp_config.pass_ref} onChange={v => set('smtp_config.pass_ref', v)} />
              </Grid>
              <div className="flex items-center gap-2 mt-3">
                <button onClick={testEmail} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-bold hover:bg-slate-50">Send test email</button>
                <StatusPill ok={settings._channel_status?.email_configured} okText="Configured" badText="Not configured" />
              </div>
            </Card>

            <Card title="WhatsApp Business Cloud API"
              hint="Meta requires pre-approved message templates for business-initiated messages. Freeform sending is not permitted for quotations or reminders.">
              <Toggle label="Enable WhatsApp sending" checked={!!settings.whatsapp_config.enabled} onChange={v => set('whatsapp_config.enabled', v)} />
              <Grid>
                <Field label="Phone number ID" value={settings.whatsapp_config.phone_number_id} onChange={v => set('whatsapp_config.phone_number_id', v)} />
                <Field label="WABA ID" value={settings.whatsapp_config.waba_id} onChange={v => set('whatsapp_config.waba_id', v)} />
                <Field label="API version" value={settings.whatsapp_config.api_version} onChange={v => set('whatsapp_config.api_version', v)} />
                <Field label="Access token env var" value={settings.whatsapp_config.access_token_ref} onChange={v => set('whatsapp_config.access_token_ref', v)} />
              </Grid>
              <div className="flex items-center gap-2 mt-3">
                <button onClick={loadWaTemplates} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-bold hover:bg-slate-50">Fetch templates from Meta</button>
                <StatusPill ok={settings._channel_status?.whatsapp_configured} okText="Configured" badText="Not configured" />
              </div>
              {waTemplates && (
                <div className="mt-3 border border-slate-200 rounded-lg divide-y text-xs">
                  {waTemplates.map(t => (
                    <div key={`${t.name}-${t.language}`} className="px-3 py-1.5 flex justify-between">
                      <span className="font-mono">{t.name} <span className="text-slate-400">({t.language})</span></span>
                      <span className={t.status === 'APPROVED' ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold'}>{t.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}

        {tab === 'email_templates' && (
          <>
            <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2.5 rounded-xl text-xs flex items-start gap-2">
              <Mail className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Email templates support a subject line and freeform text. Click any variable chip to insert it at your cursor.</span>
            </div>
            {EMAIL_TEMPLATES.map(t => {
              const tpl = settings.draft_templates[t.key] || {};
              return (
                <Card key={t.key} title={t.label} hint={t.hint}>
                  <TemplateField label="Subject" value={tpl.subject || ''}
                    onChange={v => set(`draft_templates.${t.key}.subject`, v)} />
                  <div className="mt-3">
                    <TemplateField label="Message body" textarea rows={7} value={tpl.body || ''}
                      onChange={v => set(`draft_templates.${t.key}.body`, v)} />
                  </div>
                </Card>
              );
            })}
          </>
        )}

        {tab === 'whatsapp_templates' && (
          <>
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2.5 rounded-xl text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Meta only permits <strong>pre-approved templates</strong> for business-initiated WhatsApp messages.
                The body below is your working draft — what actually sends is the approved template named on each card.
                When authoring a template with Meta, order its <code>{'{{1}}'}</code>…<code>{'{{4}}'}</code> placeholders as:
                contact name, document no., amount, view link.
              </span>
            </div>
            {WHATSAPP_TEMPLATES.map(t => {
              const tpl = settings.draft_templates[t.key] || {};
              const approved = String(tpl.whatsapp_template_status || '').toLowerCase() === 'approved';
              return (
                <Card key={t.key} title={t.label} hint={t.hint}>
                  <TemplateField label="Message body (draft)" textarea rows={5} value={tpl.body || ''}
                    onChange={v => set(`draft_templates.${t.key}.body`, v)} />
                  <div className="mt-3">
                    <Grid>
                      <Field label="Meta template name" value={tpl.whatsapp_template_name || ''}
                        onChange={v => set(`draft_templates.${t.key}.whatsapp_template_name`, v)} />
                      <div>
                        <label className="text-xs font-bold text-slate-600 uppercase">Meta approval status</label>
                        <select value={tpl.whatsapp_template_status || 'not_submitted'}
                          onChange={e => set(`draft_templates.${t.key}.whatsapp_template_status`, e.target.value)}
                          className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm">
                          {['not_submitted', 'pending', 'approved', 'rejected'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    </Grid>
                  </div>
                  {!approved && (
                    <div className="mt-2 text-xs text-amber-700 flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      {tpl.whatsapp_template_name
                        ? 'WhatsApp sending is blocked for this message until the status is set to approved.'
                        : 'No Meta template name set — WhatsApp sending will fail for this message type.'}
                    </div>
                  )}
                </Card>
              );
            })}
          </>
        )}

        {tab === 'rules' && (
          <>
            <Card title="Discount Approval Threshold" hint="A quotation exceeding either limit goes to Pending Approval and cannot be dispatched until an Admin approves it. Set to 0 to disable a check.">
              <Grid>
                <Field label="Discount % trigger" type="number" value={settings.approval_threshold.discount_pct_trigger}
                  onChange={v => set('approval_threshold.discount_pct_trigger', Number(v))} />
                <Field label="Discount amount trigger (₹)" type="number" value={settings.approval_threshold.discount_amt_trigger}
                  onChange={v => set('approval_threshold.discount_amt_trigger', Number(v))} />
              </Grid>
            </Card>

            <Card title="Defaults">
              <Grid>
                <Field label="Follow-up interval (days)" type="number" value={settings.defaults.follow_up_interval_days}
                  onChange={v => set('defaults.follow_up_interval_days', Number(v))} />
                <Field label="Quotation validity (days)" type="number" value={settings.defaults.auto_expiry_days}
                  onChange={v => set('defaults.auto_expiry_days', Number(v))} />
                <Field label="Default GST rate (%)" type="number" value={settings.defaults.default_gst_rate}
                  onChange={v => set('defaults.default_gst_rate', Number(v))} />
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase">Numbering resets</label>
                  <select value={settings.defaults.number_reset} onChange={e => set('defaults.number_reset', e.target.value)}
                    className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm">
                    <option value="financial">Financial year (April–March)</option>
                    <option value="calendar">Calendar year (January–December)</option>
                  </select>
                </div>
                <Field label="Quotation prefix" value={settings.defaults.quote_no_prefix} onChange={v => set('defaults.quote_no_prefix', v)} />
                <Field label="PI prefix" value={settings.defaults.pi_no_prefix} onChange={v => set('defaults.pi_no_prefix', v)} />
                <Field label="Invoice prefix" value={settings.defaults.invoice_no_prefix} onChange={v => set('defaults.invoice_no_prefix', v)} />
              </Grid>
            </Card>

            <Card title="Payment Reminder Schedule" hint="Days relative to the invoice due date. Negative = before, 0 = on the day, positive = overdue.">
              <input value={(settings.payment_reminder_offsets || []).join(', ')}
                onChange={e => set('payment_reminder_offsets', e.target.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n)))}
                placeholder="-3, 0, 7"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Card({ title, hint, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="font-bold text-sm text-slate-800">{title}</div>
      {hint && <div className="text-xs text-slate-500 mt-0.5 mb-3">{hint}</div>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </div>
  );
}

function Grid({ children }) {
  return <div className="grid sm:grid-cols-2 gap-3">{children}</div>;
}

/**
 * Template input with a click-to-insert variable picker.
 *
 * Inserts at the caret (replacing any selection) rather than appending, so a variable can be
 * dropped mid-sentence. The caret is restored just after the inserted token so typing continues
 * naturally — without this, React's re-render would bounce the cursor to the end of the field.
 */
function TemplateField({ label, value, onChange, textarea, rows = 5 }) {
  const ref = React.useRef(null);
  const [openGroup, setOpenGroup] = React.useState(null);

  const insert = (token) => {
    const el = ref.current;
    const current = value || '';
    if (!el) { onChange(current + token); return; }

    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    onChange(current.slice(0, start) + token + current.slice(end));

    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const Input = textarea ? 'textarea' : 'input';

  return (
    <div>
      <label className="text-xs font-bold text-slate-600 uppercase">{label}</label>
      <Input
        ref={ref}
        {...(textarea ? { rows } : { type: 'text' })}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono"
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="text-[10px] font-bold uppercase text-slate-400 self-center mr-1">Insert:</span>
        {TEMPLATE_VARIABLES.map(g => (
          <div key={g.group} className="relative">
            <button
              type="button"
              onClick={() => setOpenGroup(openGroup === g.group ? null : g.group)}
              className={`px-2 py-1 rounded-md text-[11px] font-bold border transition ${
                openGroup === g.group
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {g.group} <ChevronDown className="w-3 h-3 inline-block -mt-0.5" />
            </button>
            {openGroup === g.group && (
              <>
                {/* Click-away layer so the menu closes without needing a document listener */}
                <div className="fixed inset-0 z-10" onClick={() => setOpenGroup(null)} />
                <div className="absolute left-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-56 max-h-64 overflow-y-auto">
                  {g.items.map(it => (
                    <button
                      key={it.token}
                      type="button"
                      onClick={() => { insert(it.token); setOpenGroup(null); }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-50 flex items-center justify-between gap-2"
                    >
                      <span className="text-xs text-slate-700">{it.label}</span>
                      <code className="text-[10px] text-slate-400 font-mono shrink-0">{it.token}</code>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * UPI ID field that tolerates a pasted scanner deep-link.
 *
 * Pasting the full "upi://pay?pa=…&sign=…" string used to be stored verbatim and printed on the
 * PDF, where a ~200-char unbreakable token pushed the bank card off the sheet. The VPA is now
 * extracted on paste, with the full link offered as an explicit choice for signed merchant QRs.
 */
function UpiField({ value, onChange }) {
  const raw = String(value || '').trim();
  const isDeepLink = isUpiDeepLink(raw);
  const vpa = isDeepLink ? extractUpiVpa(raw) : raw;

  return (
    <div>
      <label className="text-xs font-bold text-slate-600 uppercase">UPI ID</label>
      <input
        type="text"
        value={raw}
        placeholder="yourname@bank"
        onChange={e => onChange(e.target.value)}
        className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base"
      />
      {isDeepLink && (
        <div className="mt-1.5 px-2.5 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="text-[11px] text-amber-900 font-semibold">
            This is a full payment link, not a UPI ID.
          </div>
          <div className="text-[11px] text-amber-800 mt-0.5">
            The QR still scans, but only <b>{vpa || 'the ID'}</b> is printed on the document.
          </div>
          {vpa && (
            <button type="button" onClick={() => onChange(vpa)}
              className="mt-1.5 px-2 py-1 rounded-md text-[11px] font-bold bg-white text-amber-900 border border-amber-300 hover:bg-amber-100">
              Use {vpa} instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', textarea, rows = 3 }) {
  return (
    <div>
      <label className="text-xs font-bold text-slate-600 uppercase">{label}</label>
      {/* text-base (16px) prevents iOS Safari zooming the viewport on focus */}
      {textarea ? (
        <textarea value={value ?? ''} rows={rows} onChange={e => onChange(e.target.value)}
          className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base font-mono" />
      ) : (
        <input
          type={type}
          inputMode={type === 'number' ? 'decimal' : undefined}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base"
        />
      )}
    </div>
  );
}

/** Larger tap area than a bare checkbox — the whole row is the target. */
function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-3 text-sm cursor-pointer py-2.5 -mx-1 px-1 rounded-lg active:bg-slate-50">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 shrink-0" />
      <span className="text-slate-700">{label}</span>
    </label>
  );
}

function ListEditor({ rows, onChange, newRow, render }) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="space-y-2">
      {list.map((row, i) => (
        <div key={row.id || i} className="flex items-start gap-2">
          {render(row, patch => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r))))}
          <button onClick={() => onChange(list.filter((_, j) => j !== i))}
            className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded shrink-0">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...list, newRow()])}
        className="px-3 py-1.5 border border-dashed border-slate-300 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5">
        <Plus className="w-3.5 h-3.5" /> Add
      </button>
    </div>
  );
}

function StatusPill({ ok, okText, badText }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>
      {ok ? okText : badText}
    </span>
  );
}
