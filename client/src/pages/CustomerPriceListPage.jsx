import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, Lock, Unlock, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery, filterByQuery } from '../utils/searchUtils';

/**
 * CustomerPriceListPage — what we charge each customer, and where that figure came from.
 *
 * Nobody maintains this by hand: every dispatched quotation and every invoice raised deposits its
 * rate here, so the list fills in as the business runs. This screen is for reading it back and for
 * the occasional deliberate correction.
 *
 * Locking matters more than it looks. An unlocked row is overwritten by the next document that
 * mentions the item, which is usually what you want — but an admin who has negotiated a rate needs
 * it to stick, and without the lock the next invoice would silently revert it.
 */

const SOURCE_STYLE = {
  INVOICE: { chip: 'bg-emerald-100 text-emerald-700', label: 'agreed on invoice' },
  QUOTATION: { chip: 'bg-indigo-100 text-indigo-700', label: 'from quotation' },
  MANUAL: { chip: 'bg-amber-100 text-amber-800', label: 'set by admin' }
};

export default function CustomerPriceListPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token]
  );

  useEffect(() => {
    fetch('/api/customers', { headers })
      .then(r => (r.ok ? r.json() : []))
      .then(d => setCustomers(Array.isArray(d) ? d : []))
      .catch(() => setCustomers([]));
  }, [headers]);

  const load = async (id) => {
    if (!id) { setRows([]); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/price-list/${encodeURIComponent(id)}`, { headers });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not load the price list');
      setRows(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (row, patch) => {
    try {
      const res = await fetch(`/api/price-list/${encodeURIComponent(customerId)}/${encodeURIComponent(row.Item_ID)}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ rate: patch.rate ?? row.Rate, locked: patch.locked ?? row.Locked, itemName: row.Item_Name })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
      await load(customerId);
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Forget the remembered rate for ${row.Item_Name}?`)) return;
    await fetch(`/api/price-list/${encodeURIComponent(row.Price_ID)}`, { method: 'DELETE', headers });
    await load(customerId);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => matchesQuery(q, [r.Item_Name]));
  }, [rows, query]);

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <p className="flex-1 text-sm font-extrabold text-slate-900">Customer Price List</p>
        </div>
        <div className="max-w-4xl mx-auto px-3 pb-2 space-y-2">
          <select
            value={customerId}
            onChange={e => { setCustomerId(e.target.value); load(e.target.value); }}
            className="w-full min-h-[44px] px-2.5 rounded-xl border border-slate-200 bg-white text-sm font-bold"
          >
            <option value="">Select a customer…</option>
            {customers.map(c => (
              <option key={c.Customer_ID} value={c.Customer_ID}>{c.Company_Name || c.Customer_ID}</option>
            ))}
          </select>
          {rows.length > 0 && (
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search items…"
                className="w-full min-h-[44px] pl-9 pr-3 rounded-xl border border-slate-200 bg-white text-sm font-bold placeholder:font-normal focus:outline-none"
              />
            </div>
          )}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-3 py-3 space-y-2">
        {error && <p className="text-center text-xs font-bold text-rose-600 py-2">{error}</p>}
        {loading && <p className="text-center text-xs text-slate-400 py-8 animate-pulse">Loading…</p>}

        {!loading && customerId && visible.length === 0 && (
          <p className="text-center text-xs text-slate-400 py-10">
            No rates remembered for this customer yet. They fill in automatically as you send
            quotations and raise invoices.
          </p>
        )}

        {visible.map(row => {
          const style = SOURCE_STYLE[row.Source] || SOURCE_STYLE.MANUAL;
          return (
            <div key={row.Price_ID} className="rounded-xl bg-white border border-slate-200 px-3 py-2.5 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-900 truncate">{row.Item_Name || row.Item_ID}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-extrabold ${style.chip}`}>
                    {style.label}
                  </span>
                  {row.Source_Doc_No && (
                    <span className="text-[10px] text-slate-400 truncate">{row.Source_Doc_No}</span>
                  )}
                  <span className="text-[10px] text-slate-400">{row.Effective_From}</span>
                </div>
              </div>

              <input
                type="number"
                min="0"
                defaultValue={row.Rate}
                onBlur={e => {
                  const next = Number(e.target.value) || 0;
                  if (next !== Number(row.Rate)) save(row, { rate: next, locked: true });
                }}
                className="jc-input w-24 text-right shrink-0"
                aria-label={`Rate for ${row.Item_Name}`}
              />

              {/* Locking is what makes a manual correction survive the next invoice. */}
              <button
                onClick={() => save(row, { locked: !row.Locked })}
                title={row.Locked ? 'Locked — automatic updates cannot change this' : 'Unlocked — the next document may update this'}
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  row.Locked ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {row.Locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              </button>

              <button
                onClick={() => remove(row)}
                className="w-9 h-9 rounded-lg flex items-center justify-center active:bg-slate-100 shrink-0"
                aria-label="Forget this rate"
              >
                <Trash2 className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
          );
        })}
      </main>
    </div>
  );
}
