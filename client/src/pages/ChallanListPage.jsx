import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, FileText, Mail, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * ChallanListPage — the delivery challan register.
 *
 * Deliberately its own page rather than a third tab on Sales Documents: a challan carries no money
 * (or carries it only for internal reference), so it does not belong in a register whose summary
 * tiles are outstanding, overdue and collected.
 */

const FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'Draft', label: 'Drafts' },
  { id: 'Issued', label: 'Issued' }
];

export default function ChallanListPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Challan email ships OFF; the register only grows a Send button once it is switched on in
  // Quotation Settings -> Email Templates.
  const [emailOn, setEmailOn] = useState(false);
  const [sendingId, setSendingId] = useState('');
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    fetch('/api/challans', { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || 'Could not load challans');
        return r.json();
      })
      .then(data => setRows(Array.isArray(data) ? data : []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));

    fetch('/api/quotation-settings', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(s => setEmailOn(s?.email_enabled?.challan_email === true))
      .catch(() => {});
  }, [token]);

  const showFlash = (type, message) => {
    setFlash({ type, message });
    setTimeout(() => setFlash(null), 4000);
  };

  const sendEmail = async (challan) => {
    const already = (challan.Dispatch_Log || []).some(d => d.channel === 'Email' && d.status === 'sent');
    if (already && !window.confirm(`Challan ${challan.Challan_No} was already emailed. Send it again?`)) return;

    setSendingId(challan.Challan_ID);
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}/dispatch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      const email = (data.dispatchResults || []).find(r => r.channel === 'Email');
      if (email?.ok) {
        showFlash('ok', `Challan ${challan.Challan_No} emailed to ${email.recipient}.`);
        setRows(prev => prev.map(r => (r.Challan_ID === challan.Challan_ID ? data.document : r)));
      } else {
        showFlash('err', email?.error || 'The email could not be sent.');
      }
    } catch (e) {
      showFlash('err', e.message);
    } finally {
      setSendingId('');
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (filter !== 'ALL' && r.Status !== filter) return false;
      if (!q) return true;
      return [r.Challan_No, r.Customer_Name_Snapshot, r.Challan_ID]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, filter, query]);

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <p className="flex-1 text-sm font-extrabold text-slate-900">Delivery Challans</p>
        </div>
        <div className="max-w-4xl mx-auto px-3 pb-2 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search number or party…"
              className="w-full min-h-[44px] pl-9 pr-3 rounded-xl border border-slate-200 bg-white text-sm font-bold placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
          </div>
          <div className="flex gap-2">
            {FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex-1 min-h-[38px] rounded-xl text-xs font-extrabold transition ${
                  filter === f.id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 active:bg-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-3 py-3 space-y-2">
        {flash && (
          <div className={`px-3 py-2 rounded-xl text-xs font-bold border ${
            flash.type === 'ok'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-rose-50 text-rose-700 border-rose-200'
          }`}>
            {flash.message}
          </div>
        )}
        {loading && <p className="text-center text-xs text-slate-400 py-8 animate-pulse">Loading…</p>}
        {error && <p className="text-center text-xs font-bold text-rose-600 py-8">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="text-center text-xs text-slate-400 py-10">No challans yet.</p>
        )}

        {/* Row is a div, not a button: the Send action is a second control and a button cannot
            legally nest inside another button. The card body keeps the whole tap target. */}
        {visible.map(c => {
          const emailed = (c.Dispatch_Log || []).some(d => d.channel === 'Email' && d.status === 'sent');
          return (
            <div
              key={c.Challan_ID}
              className="w-full rounded-xl bg-white border border-slate-200 flex items-center gap-1 pr-2"
            >
              <button
                onClick={() => navigate(`/challans/${c.Challan_ID}`)}
                className="flex-1 min-w-0 px-3 py-2.5 text-left active:bg-slate-50 rounded-l-xl flex items-center gap-2.5"
              >
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  c.Status === 'Issued' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'
                }`}>
                  <FileText className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-slate-900 truncate">
                    {c.Challan_No || 'Draft — no number yet'}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {c.Customer_Name_Snapshot} · {c.Challan_Date} · {c.Total_Qty} qty
                  </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-md text-[9px] font-extrabold ${
                  c.Status === 'Issued' ? 'bg-emerald-100 text-emerald-800'
                    : c.Status === 'Cancelled' ? 'bg-rose-100 text-rose-700'
                    : 'bg-slate-100 text-slate-600'
                }`}>
                  {c.Status}{c.Is_Partial ? ' · Partial' : ''}
                </span>
              </button>

              {/* Issued only — a draft has no challan-book number yet, so the customer would receive
                  a blank reference. */}
              {emailOn && c.Status === 'Issued' && (
                <button
                  onClick={() => sendEmail(c)}
                  disabled={sendingId === c.Challan_ID}
                  title={emailed ? 'Already emailed — tap to send again' : 'Email this challan to the customer'}
                  aria-label={emailed ? 'Resend challan email' : 'Email challan'}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
                    emailed
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-600 active:bg-emerald-100'
                      : 'border-slate-200 text-slate-500 active:bg-slate-100'
                  }`}
                >
                  {sendingId === c.Challan_ID
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Mail className="w-4 h-4" />}
                </button>
              )}
            </div>
          );
        })}
      </main>
    </div>
  );
}
