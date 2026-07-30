import React, { useState } from 'react';
import { Globe, Send, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * OnlineInquiryPanel — the "*Online Inquiry*" badge and the 1-click Send Company Profile action,
 * shown on a lead that came from the public /inquiry form.
 *
 * Renders nothing at all for a task from any other source, so it can be dropped into a shared task
 * view without a caller-side condition (`task.Source === 'ONLINE_INQUIRY'` lives here, once).
 *
 * The button posts to /api/inquiry/send-company-profile, which resolves the brochure from the
 * existing Quotation Settings → Email Attachments library. Two outcomes are deliberately
 * distinguished in the UI: "sent" and "sent, but nothing was attached". Reporting an empty send as
 * plain success is how staff end up believing a customer received a brochure that was never
 * uploaded.
 */
export default function OnlineInquiryPanel({ task, token, customerId }) {
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);

  if (!task || task.Source !== 'ONLINE_INQUIRY') return null;

  const handleSendProfile = async () => {
    if (sending) return;
    setSending(true);
    setOutcome(null);
    try {
      const res = await fetch('/api/inquiry/send-company-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          customerId: customerId || task.Customer_ID,
          taskId: task.Task_ID,
          email: task.Contact_Email || '',
          phone: task.Contact_Phone || ''
        })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setOutcome({ ok: false, message: data.error || 'Could not send the company profile.' });
        return;
      }

      // Per-channel results: an email can succeed while WhatsApp fails for want of an approved
      // Meta template, and saying "sent" flatly would hide that.
      const delivered = (data.results || []).filter(r => r.ok).map(r => r.channel);
      const failed = (data.results || []).filter(r => !r.ok);

      setOutcome({
        ok: data.success,
        message: data.success
          ? `Sent via ${delivered.join(' & ')}.${data.warning ? ` ${data.warning}` : ''}`
          : (failed[0]?.error || 'Nothing could be sent — check the email and WhatsApp settings.')
      });
    } catch {
      setOutcome({ ok: false, message: 'Network error — please try again.' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-orange-600 text-white text-[10px] font-extrabold uppercase tracking-wide">
          <Globe className="w-3 h-3" />
          Online Inquiry
        </span>
        {task.Inquiry_No && (
          <span className="text-[11px] font-extrabold text-orange-900">{task.Inquiry_No}</span>
        )}
      </div>

      {task.Site_Address && (
        <p className="text-[11px] text-orange-900/80 font-semibold leading-relaxed">
          📍 {task.Site_Address}
        </p>
      )}

      {task.Inquiry_Other_Text && (
        <p className="text-[11px] text-orange-900/80 font-medium leading-relaxed whitespace-pre-wrap border-l-2 border-orange-300 pl-2">
          {task.Inquiry_Other_Text}
        </p>
      )}

      <button
        type="button"
        onClick={handleSendProfile}
        disabled={sending}
        className="w-full flex items-center justify-center gap-2 rounded-xl bg-orange-700 text-white font-extrabold text-xs active:scale-[0.98] transition disabled:opacity-60"
        style={{ minHeight: '44px' }}
      >
        {sending
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
          : <><Send className="w-4 h-4" /> 📧 Send Company Profile</>}
      </button>

      {outcome && (
        <div className={`flex gap-2 text-[11px] font-semibold leading-relaxed ${outcome.ok ? 'text-emerald-800' : 'text-red-700'}`}>
          {outcome.ok
            ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
          <span>{outcome.message}</span>
        </div>
      )}
    </div>
  );
}
