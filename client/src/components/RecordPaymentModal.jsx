import React, { useState, useMemo } from 'react';
import { X, Loader2, ReceiptIndianRupee } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatMoney, balanceDue, todayISO, PAYMENT_MODES } from '../utils/quotationUtils';

/**
 * Records a full or part payment against a Sales Invoice.
 *
 * The server owns the settlement decision (conversionService.recordPayment treats anything within
 * ₹0.50 of the grand total as Paid, and closes the owning task); this form only collects the
 * increment, so the amount field is a delta — never a running total.
 */
export default function RecordPaymentModal({ invoice, onClose, onRecorded }) {
  const { token } = useAuth();
  const due = balanceDue(invoice);

  const [amount, setAmount] = useState(due ? String(due.toFixed(2)) : '');
  const [paymentMode, setPaymentMode] = useState(PAYMENT_MODES[0]);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const numeric = Number(amount);
  const remaining = useMemo(
    () => Math.max(0, Math.round((due - (numeric || 0)) * 100) / 100),
    [due, numeric]
  );
  const overpaying = numeric > due + 0.5;
  const valid = numeric > 0 && !saving;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/sales-invoices/${invoice.Invoice_ID}/record-payment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: numeric, paymentMode, reference, paidOn })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record payment');
      onRecorded(invoice);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const log = Array.isArray(invoice.Payment_Log) ? invoice.Payment_Log : [];

  return (
    <div className="fixed inset-0 bg-slate-900/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white">
          <div className="min-w-0">
            <div className="font-bold text-slate-900 flex items-center gap-1.5">
              <ReceiptIndianRupee className="w-4 h-4" /> Record Payment
            </div>
            <div className="text-xs text-slate-500 truncate">
              {invoice.Invoice_No} · {invoice.Customer_Name_Snapshot}
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Figure label="Total" value={invoice.Grand_Total} />
            <Figure label="Paid" value={invoice.Amount_Paid || 0} />
            <Figure label="Balance" value={due} tone="rose" />
          </div>

          <div>
            <label className="text-xs font-bold text-slate-600 uppercase">Amount received (₹)</label>
            <input type="number" inputMode="decimal" value={amount} autoFocus
              onChange={e => setAmount(e.target.value)}
              className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base font-bold" />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <Chip onClick={() => setAmount(due.toFixed(2))}>Full {formatMoney(due)}</Chip>
              <Chip onClick={() => setAmount((due / 2).toFixed(2))}>Half</Chip>
            </div>
            {overpaying && (
              <div className="text-[11px] text-amber-700 font-semibold mt-1.5">
                This is more than the balance due. It will still be recorded in full.
              </div>
            )}
            {!overpaying && numeric > 0 && remaining > 0 && (
              <div className="text-[11px] text-slate-500 mt-1.5">
                Remaining after this payment: <strong>{formatMoney(remaining)}</strong> — invoice stays Partially Paid.
              </div>
            )}
            {!overpaying && numeric > 0 && remaining === 0 && (
              <div className="text-[11px] text-emerald-700 font-semibold mt-1.5">
                Settles the invoice in full — the linked task will close automatically.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase">Mode</label>
              <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)}
                className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base">
                {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase">Paid on</label>
              <input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)}
                className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base" />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-600 uppercase">Reference / UTR</label>
            <input value={reference} onChange={e => setReference(e.target.value)}
              placeholder="Cheque no., UTR or transaction id"
              className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base" />
          </div>

          {log.length > 0 && (
            <div className="border-t border-slate-100 pt-3">
              <div className="text-xs font-bold text-slate-600 uppercase mb-1.5">Earlier payments</div>
              <div className="space-y-1">
                {log.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs text-slate-600">
                    <span>{p.paidOn} · {p.mode || '—'}{p.reference ? ` · ${p.reference}` : ''}</span>
                    <span className="font-semibold">{formatMoney(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">
              {error}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-100 flex gap-2 sticky bottom-0 bg-white">
          <button onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={submit} disabled={!valid}
            className="flex-1 px-4 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? 'Saving…' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Figure({ label, value, tone }) {
  return (
    <div className="bg-slate-50 border border-slate-100 rounded-xl py-2">
      <div className="text-[10px] font-bold uppercase text-slate-400">{label}</div>
      <div className={`font-bold text-sm mt-0.5 ${tone === 'rose' ? 'text-rose-600' : 'text-slate-900'}`}>
        {formatMoney(value)}
      </div>
    </div>
  );
}

function Chip({ onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className="px-2 py-1 rounded-md text-[11px] font-bold bg-white text-slate-600 border border-slate-200 hover:bg-slate-50">
      {children}
    </button>
  );
}
