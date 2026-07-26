import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, FileText, Loader2, ArrowLeft, Filter } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatMoney, formatDate, statusMeta } from '../utils/quotationUtils';

/** Quotation register — one row per thread (superseded revisions hidden by default). */
export default function QuotationListPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showSuperseded, setShowSuperseded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/quotations${showSuperseded ? '' : '?latestOnly=true'}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok && !cancelled) setRows(await res.json());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, showSuperseded]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (!q) return true;
      return `${r.Quote_No_Display} ${r.Customer_Name_Snapshot} ${r.Subject || ''}`.toLowerCase().includes(q);
    });
  }, [rows, search, statusFilter]);

  const statuses = useMemo(() => [...new Set(rows.map(r => r.Status))].filter(Boolean), [rows]);

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-slate-100 rounded-lg">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="font-bold text-slate-900 flex-1">Quotations</h1>
            <button onClick={() => navigate('/quotations/new')}
              className="px-3 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-1.5 hover:bg-slate-800">
              <Plus className="w-4 h-4" /> New
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by number, customer or subject…"
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
              <option value="">All statuses</option>
              {statuses.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 px-2">
              <input type="checkbox" checked={showSuperseded} onChange={e => setShowSuperseded(e.target.checked)} />
              Show superseded
            </label>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <div className="text-sm font-semibold">No quotations found</div>
          </div>
        ) : (
          <>
            {/* MOBILE: tappable cards. A 5-column table forces horizontal scrolling on a phone,
                and row taps are hard to hit accurately at table density. */}
            <div className="md:hidden space-y-2">
              {filtered.map(r => {
                const meta = statusMeta(r.Status);
                return (
                  <button key={r.Quotation_ID}
                    onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                    className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 active:bg-slate-50 transition">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-sm truncate">{r.Customer_Name_Snapshot}</div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">{r.Quote_No_Display}</div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </div>
                    {r.Subject && <div className="text-xs text-slate-400 truncate mt-1">{r.Subject}</div>}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                      <span className="text-[11px] text-slate-500">{formatDate(r.Created_At)}</span>
                      <span className="font-bold text-base">{formatMoney(r.Grand_Total)}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* DESKTOP: table */}
            <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-bold">Number</th>
                      <th className="px-4 py-2.5 text-left font-bold">Customer</th>
                      <th className="px-4 py-2.5 text-left font-bold">Date</th>
                      <th className="px-4 py-2.5 text-left font-bold">Status</th>
                      <th className="px-4 py-2.5 text-right font-bold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r => {
                      const meta = statusMeta(r.Status);
                      return (
                        <tr key={r.Quotation_ID}
                          onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                          <td className="px-4 py-2.5 font-semibold whitespace-nowrap">{r.Quote_No_Display}</td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium truncate max-w-[240px]">{r.Customer_Name_Snapshot}</div>
                            {r.Subject && <div className="text-xs text-slate-400 truncate max-w-[240px]">{r.Subject}</div>}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(r.Created_At)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold whitespace-nowrap">{formatMoney(r.Grand_Total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
