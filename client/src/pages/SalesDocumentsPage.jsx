import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Search, FileText, Loader2, ReceiptIndianRupee, AlertTriangle, CheckCircle2
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import RecordPaymentModal from '../components/RecordPaymentModal';
import {
  formatMoney, formatDate, docStatusMeta, paymentStatusMeta,
  balanceDue, isChasable, daysPastDue
} from '../utils/quotationUtils';

/**
 * Sales document register — the read side of the conversion pipeline that the quotation builder
 * writes into. Two tabs over the same layout because a PI and an invoice differ only in which
 * action a row offers (convert vs. record payment); the identity, party and money columns are the
 * carry-forward fields conversionService copies verbatim between them.
 */

const TABS = [
  { id: 'invoices', label: 'Sales Invoices', endpoint: '/api/sales-invoices', idKey: 'Invoice_ID', noKey: 'Invoice_No', dateKey: 'Invoice_Date' },
  { id: 'pi', label: 'Proforma Invoices', endpoint: '/api/proforma-invoices', idKey: 'PI_ID', noKey: 'PI_No', dateKey: 'PI_Date' }
];

export default function SalesDocumentsPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [tab, setTab] = useState('invoices');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [payTarget, setPayTarget] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [flash, setFlash] = useState(null);

  const active = TABS.find(t => t.id === tab);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(active.endpoint, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRows(await res.json());
      else setRows([]);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [active.endpoint, token]);

  useEffect(() => { load(); }, [load]);

  // Switching tabs must clear the previous list, otherwise the old rows render for a frame against
  // the new tab's column meaning.
  useEffect(() => { setRows([]); setFilter(''); }, [tab]);

  const showFlash = (type, message) => {
    setFlash({ type, message });
    setTimeout(() => setFlash(null), 4000);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (filter === 'unpaid' && !isChasable(r)) return false;
      if (filter === 'overdue' && !(isChasable(r) && (daysPastDue(r.Due_Date) ?? -1) > 0)) return false;
      if (filter === 'paid' && String(r.Payment_Status || '').toLowerCase() !== 'paid') return false;
      if (filter === 'pending' && r.Linked_Invoice_ID) return false;
      if (!q) return true;
      return `${r[active.noKey] || ''} ${r.Customer_Name_Snapshot || ''} ${r.Subject || ''} ${r.Source_Quote_No || ''}`
        .toLowerCase().includes(q);
    });
  }, [rows, search, filter, active.noKey]);

  const summary = useMemo(() => {
    if (tab !== 'invoices') return null;
    return rows.reduce((acc, r) => {
      const due = balanceDue(r);
      if (isChasable(r)) {
        acc.outstanding += due;
        if ((daysPastDue(r.Due_Date) ?? -1) > 0) acc.overdue += due;
      }
      acc.collected += Number(r.Amount_Paid) || 0;
      return acc;
    }, { outstanding: 0, overdue: 0, collected: 0 });
  }, [rows, tab]);

  const convertPI = async (pi) => {
    setBusyId(pi.PI_ID);
    try {
      const res = await fetch(`/api/proforma-invoices/${pi.PI_ID}/convert-to-invoice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Conversion failed');
      showFlash('ok', `Sales Invoice ${data.invoice?.Invoice_No} created.`);
      if (data.inventoryResult?.shortfalls?.length) {
        showFlash('warn', `Invoice created, but ${data.inventoryResult.shortfalls.length} item(s) are short on stock.`);
      }
      await load();
    } catch (e) {
      showFlash('err', e.message);
    } finally {
      setBusyId('');
    }
  };

  const onPaymentRecorded = async (invoice) => {
    setPayTarget(null);
    showFlash('ok', `Payment recorded for ${invoice.Invoice_No}.`);
    await load();
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="p-2 hover:bg-slate-100 rounded-lg">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="font-bold text-slate-900 flex-1">Sales Documents</h1>
            <button onClick={() => navigate('/quotations')}
              className="px-3 py-2 border border-slate-200 text-slate-700 text-sm font-bold rounded-lg hover:bg-slate-50">
              Quotations
            </button>
          </div>

          <div className="flex gap-1 mt-3 border-b border-slate-100 -mb-3">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm font-bold border-b-2 transition ${
                  tab === t.id ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5">
        {flash && (
          <div className={`mb-3 px-3 py-2 rounded-lg text-sm font-semibold border ${
            flash.type === 'ok' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : flash.type === 'warn' ? 'bg-amber-50 text-amber-800 border-amber-200'
              : 'bg-rose-50 text-rose-700 border-rose-200'
          }`}>
            {flash.message}
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatCard label="Outstanding" value={summary.outstanding} tone="amber" />
            <StatCard label="Overdue" value={summary.overdue} tone="rose" />
            <StatCard label="Collected" value={summary.collected} tone="emerald" />
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by number, customer or subject…"
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm" />
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
            <option value="">All</option>
            {tab === 'invoices' ? (
              <>
                <option value="unpaid">Unpaid / Partial</option>
                <option value="overdue">Overdue</option>
                <option value="paid">Paid</option>
              </>
            ) : (
              <option value="pending">Not yet invoiced</option>
            )}
          </select>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <div className="text-sm font-semibold">No {active.label.toLowerCase()} found</div>
            <div className="text-xs mt-1">Accepted quotations become documents here once converted.</div>
          </div>
        ) : (
          <>
            {/* MOBILE cards / DESKTOP table — same split as QuotationListPage. */}
            <div className="md:hidden space-y-2">
              {filtered.map(r => (
                <MobileCard key={r[active.idKey]} row={r} tab={tab} active={active}
                  busy={busyId === r[active.idKey]}
                  onConvert={() => convertPI(r)}
                  onPay={() => setPayTarget(r)} />
              ))}
            </div>

            <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-bold">Number</th>
                      <th className="px-4 py-2.5 text-left font-bold">Customer</th>
                      <th className="px-4 py-2.5 text-left font-bold">Date</th>
                      <th className="px-4 py-2.5 text-left font-bold">Due</th>
                      <th className="px-4 py-2.5 text-left font-bold">Status</th>
                      <th className="px-4 py-2.5 text-right font-bold">Total</th>
                      {tab === 'invoices' && <th className="px-4 py-2.5 text-right font-bold">Balance</th>}
                      <th className="px-4 py-2.5 text-right font-bold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r => {
                      const id = r[active.idKey];
                      const overdue = isChasable(r) && (daysPastDue(r.Due_Date) ?? -1) > 0;
                      const meta = tab === 'invoices' ? paymentStatusMeta(r.Payment_Status) : docStatusMeta(r.Status);
                      return (
                        <tr key={id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                            {r[active.noKey]}
                            {r.Source_Quote_No && (
                              <div className="text-[10px] text-slate-400 font-normal">from {r.Source_Quote_No}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium truncate max-w-[200px]">{r.Customer_Name_Snapshot}</div>
                            {r.Subject && <div className="text-xs text-slate-400 truncate max-w-[200px]">{r.Subject}</div>}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(r[active.dateKey])}</td>
                          <td className={`px-4 py-2.5 whitespace-nowrap ${overdue ? 'text-rose-600 font-semibold' : 'text-slate-500'}`}>
                            {formatDate(r.Due_Date)}
                            {overdue && <div className="text-[10px]">{daysPastDue(r.Due_Date)}d overdue</div>}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                            {Array.isArray(r.Inventory_Shortfall) && r.Inventory_Shortfall.length > 0 && (
                              <span title="Stock shortfall recorded" className="ml-1 inline-flex align-middle">
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold whitespace-nowrap">{formatMoney(r.Grand_Total)}</td>
                          {tab === 'invoices' && (
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <span className={balanceDue(r) > 0 ? 'font-bold text-rose-600' : 'text-emerald-600 font-semibold'}>
                                {formatMoney(balanceDue(r))}
                              </span>
                            </td>
                          )}
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <RowAction row={r} tab={tab} busy={busyId === id}
                              onConvert={() => convertPI(r)} onPay={() => setPayTarget(r)} />
                          </td>
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

      {payTarget && (
        <RecordPaymentModal
          invoice={payTarget}
          onClose={() => setPayTarget(null)}
          onRecorded={onPaymentRecorded}
        />
      )}
    </div>
  );
}

function RowAction({ row, tab, busy, onConvert, onPay }) {
  if (busy) return <Loader2 className="w-4 h-4 animate-spin text-slate-400 inline-block" />;

  if (tab === 'pi') {
    if (row.Linked_Invoice_ID) return <span className="text-xs text-slate-400">Invoiced</span>;
    return (
      <button onClick={onConvert}
        className="px-2.5 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700">
        Convert to Invoice
      </button>
    );
  }

  if (String(row.Payment_Status || '').toLowerCase() === 'paid') {
    return (
      <span className="text-xs text-emerald-600 font-semibold inline-flex items-center gap-1">
        <CheckCircle2 className="w-3.5 h-3.5" /> Settled
      </span>
    );
  }
  return (
    <button onClick={onPay}
      className="px-2.5 py-1.5 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800 inline-flex items-center gap-1">
      <ReceiptIndianRupee className="w-3.5 h-3.5" /> Record Payment
    </button>
  );
}

function MobileCard({ row, tab, active, busy, onConvert, onPay }) {
  const overdue = isChasable(row) && (daysPastDue(row.Due_Date) ?? -1) > 0;
  const meta = tab === 'invoices' ? paymentStatusMeta(row.Payment_Status) : docStatusMeta(row.Status);
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm truncate">{row.Customer_Name_Snapshot}</div>
          <div className="text-[11px] text-slate-500 font-mono mt-0.5">{row[active.noKey]}</div>
        </div>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>
          {meta.label}
        </span>
      </div>

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 text-[11px]">
        <span className={overdue ? 'text-rose-600 font-semibold' : 'text-slate-500'}>
          Due {formatDate(row.Due_Date) || '—'}{overdue ? ` · ${daysPastDue(row.Due_Date)}d late` : ''}
        </span>
        <span className="font-bold text-base text-slate-900">{formatMoney(row.Grand_Total)}</span>
      </div>

      {tab === 'invoices' && balanceDue(row) > 0 && (
        <div className="text-[11px] text-rose-600 font-semibold mt-1">
          Balance {formatMoney(balanceDue(row))}
        </div>
      )}

      <div className="mt-2">
        <RowAction row={row} tab={tab} busy={busy} onConvert={onConvert} onPay={onPay} />
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  const tones = {
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700'
  };
  return (
    <div className={`border rounded-xl p-3 ${tones[tone]}`}>
      <div className="text-[10px] font-bold uppercase opacity-70">{label}</div>
      <div className="font-bold text-base sm:text-lg mt-0.5 truncate">{formatMoney(value)}</div>
    </div>
  );
}
