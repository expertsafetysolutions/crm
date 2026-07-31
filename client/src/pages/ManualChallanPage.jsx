import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { todayISO } from '../utils/quotationUtils';
import SmartSearchSelect from '../components/SmartSearchSelect';

/**
 * Opens a delivery challan that has no job card behind it.
 *
 * Two cases the workshop flow cannot serve: an OLD challan that already exists on paper and is being
 * typed in, and equipment SUPPLIED directly with no workshop work. Both end up on the ordinary
 * ChallanBuilderPage — this screen only answers the three questions a job card would otherwise have
 * answered (who, when, and whether the goods have already moved), then hands over.
 *
 * A route rather than a modal on the register: back-entering a stack of paper challans is repetitive,
 * so each one deserves a real history entry that the phone's back button returns from.
 */
export default function ManualChallanPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [challanDate, setChallanDate] = useState(todayISO());
  const [isHistorical, setIsHistorical] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/customers', { headers });
        if (res.ok && !cancelled) setCustomers(await res.json());
      } catch {
        if (!cancelled) setError('Could not load the customer list. Check your connection.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const selected = customers.find(c => c.Customer_ID === customerId) || null;

  const create = async () => {
    if (!customerId) return;
    setBusy(true);
    setError('');
    try {
      // Only the id goes up. The server builds the five customer snapshot fields from its own
      // authoritative row — those fields are encrypted at rest and the client's copy may be masked.
      const res = await fetch('/api/challans/manual', {
        method: 'POST', headers,
        body: JSON.stringify({ customerId, challanDate, isHistorical })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the challan');
      // replace: back should return to the register, not to a form for a challan that now exists.
      navigate(`/challans/${data.Challan_ID}`, { replace: true });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => navigate('/challans')}
            className="w-9 h-9 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0"
            aria-label="Back to challans"
          >
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold text-slate-900 truncate">New Challan</h1>
            <p className="text-[10px] text-slate-500">Without a job card</p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-3 py-4 space-y-4">
        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2">
            <p className="text-xs font-bold text-rose-700">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="py-16 flex items-center justify-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <>
            <SmartSearchSelect
              label="Customer"
              placeholder="Search name, mobile, city…"
              options={customers}
              value={selected}
              onChange={c => setCustomerId(c?.Customer_ID || '')}
              getKey={c => c.Customer_ID}
              getLabel={c => c.Company_Name}
              getSubtitle={c => [
                c.GSTIN || c.Gst_No ? `GSTIN ${c.GSTIN || c.Gst_No}` : 'No GSTIN',
                c.Contact,
                c.Address
              ].filter(Boolean).join(' · ')}
              getSearchable={c => [c.Company_Name, c.Auth_Person, c.Contact, c.Email, c.Address, c.GSTIN || c.Gst_No]}
              emptyText="No customer matches that."
            />

            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase mb-1">
                Challan date
              </label>
              <input
                type="date"
                value={challanDate}
                onChange={e => setChallanDate(e.target.value)}
                className="jc-input w-full"
              />
              <p className="mt-1 text-[11px] text-slate-500">
                For an old challan, use the date on the paper — certificates date their validity from it.
              </p>
            </div>

            {/*
              The subtitle is doing the real work here. "Historical" on its own is jargon; what the
              user has to weigh is the stock consequence, and this is the one choice on the screen
              that cannot be changed once the challan is issued.
            */}
            <label className="flex items-start gap-2.5 min-h-[48px] px-3 py-2.5 rounded-xl bg-white border border-slate-200 active:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={isHistorical}
                onChange={e => setIsHistorical(e.target.checked)}
                className="w-4 h-4 shrink-0 mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-xs font-extrabold text-slate-800">
                  Old challan — already delivered
                </span>
                <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">
                  Typing in a past paper challan. Stock will NOT be reduced when this is invoiced —
                  the goods left the shelf at the time.
                </span>
              </span>
            </label>

            <p className="text-[11px] text-slate-500 leading-snug px-1">
              Add the items on the next screen. Refilling and HP Testing items are recognised from the
              catalogue, so their certificates fill in automatically.
            </p>
          </>
        )}
      </main>

      {/* Sticky primary action — this screen is a form, so it earns the 48px bar. */}
      <div className="fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-slate-200 px-3 py-2.5"
        style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}>
        <div className="max-w-2xl mx-auto">
          <button
            onClick={create}
            disabled={busy || !customerId}
            className="w-full min-h-[48px] rounded-xl bg-emerald-600 text-white text-sm font-extrabold flex items-center justify-center gap-2 active:bg-emerald-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {customerId ? 'Create challan' : 'Choose a customer'}
          </button>
        </div>
      </div>
    </div>
  );
}
