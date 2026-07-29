import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, FileText, Loader2, ArrowLeft, Filter, TrendingDown } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery } from '../utils/searchUtils';
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
  // 'list' = the quotation register, 'lost' = why enquiries were lost.
  const [view, setView] = useState('list');
  const [lostReport, setLostReport] = useState(null);
  const [lostLoading, setLostLoading] = useState(false);

  // Fetched on first open of the report rather than up front — it scans every task, so there is no
  // reason to pay for it on a page most visits never leave the register on.
  useEffect(() => {
    if (view !== 'lost' || lostReport) return;
    let cancelled = false;
    (async () => {
      setLostLoading(true);
      try {
        const res = await fetch('/api/analytics/order-lost', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setLostReport(await res.json());
      } finally {
        if (!cancelled) setLostLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [view, lostReport, token]);

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
      return matchesQuery(q, [r.Quote_No_Display, r.Customer_Name_Snapshot, r.Subject]);
    });
  }, [rows, search, statusFilter]);

  const statuses = useMemo(() => [...new Set(rows.map(r => r.Status))].filter(Boolean), [rows]);

  return (
    <div className="qt-theme min-h-screen bg-slate-50">
      <div className="sticky top-0 z-20 shadow-sm">
        <div className="qt-appbar">
          <div className="max-w-6xl mx-auto px-3 py-3 flex items-center gap-2">
            <button onClick={() => navigate('/')} className="qt-appbar-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-[17px] flex-1">Quotations</h1>
            <button onClick={() => navigate('/quotations/new')}
              className="qt-btn bg-white/15 text-white hover:bg-white/25 py-2 px-3.5 text-xs">
              <Plus className="w-4 h-4" /> NEW
            </button>
          </div>
        </div>

        {/* Filter bar on white, below the red app bar — keeps the controls legible and lets the
            search field use the same outlined treatment as the rest of the module. */}
        <div className="bg-white border-b border-slate-200">
          <div className="max-w-6xl mx-auto px-4 flex gap-1">
            {[['list', 'Quotations', FileText], ['lost', 'Order Lost', TrendingDown]].map(([id, label, Icon]) => (
              <button key={id} onClick={() => setView(id)}
                className={`px-3 py-2.5 text-xs font-bold whitespace-nowrap border-b-2 flex items-center gap-1.5 transition ${view === id ? 'border-rose-600 text-rose-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>

          {view === 'list' && (
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap gap-2 items-center border-t border-slate-100">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search by number, customer or subject…"
                  className="qt-input pl-10 py-2.5 text-sm" />
              </div>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="qt-select w-auto py-2.5 text-sm">
                <option value="">All statuses</option>
                {statuses.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 px-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4" checked={showSuperseded} onChange={e => setShowSuperseded(e.target.checked)} />
                Show superseded
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5">
        {view === 'lost' ? (
          <OrderLostReport report={lostReport} loading={lostLoading} />
        ) : loading ? (
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

/**
 * Why enquiries were lost, by reason.
 *
 * Bars are scaled against the largest reason rather than the total, so the leading cause always
 * fills the row and small differences stay readable — with five reasons, percent-of-total bars are
 * all short and hard to compare.
 */
function OrderLostReport({ report, loading }) {
  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }
  if (!report) {
    return <div className="text-center py-16 text-slate-400 text-sm font-semibold">Could not load the report.</div>;
  }
  if (!report.totalLost) {
    return (
      <div className="text-center py-16 text-slate-400">
        <TrendingDown className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <div className="text-sm font-semibold">No lost orders recorded yet</div>
        <div className="text-xs mt-1">
          Open a quotation and use <b>Won / Lost</b> to record an outcome — it will show up here.
        </div>
      </div>
    );
  }

  const maxCount = Math.max(...report.byReason.map(r => r.count), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Orders lost</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{report.totalLost}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Value lost</div>
          <div className="text-2xl font-black text-rose-600 mt-1">{formatMoney(report.totalLostValue)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">By reason</div>
        <div className="space-y-3">
          {report.byReason.map(r => (
            <div key={r.reason}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-slate-700">{r.reason}</span>
                <span className="text-slate-500 text-xs shrink-0">
                  <b className="text-slate-800">{r.count}</b> · {formatMoney(r.value)}
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-rose-500"
                  style={{ width: `${Math.round((r.count / maxCount) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
