import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, Loader2, AlertTriangle, CheckCircle2,
  Building2, FileQuestion, ShoppingCart, PackageCheck, Star, TrendingDown,
  IndianRupee, ArrowRight
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import SmartSearchSelect from '../components/SmartSearchSelect';
import { filterByQuery } from '../utils/searchUtils';

/**
 * PurchasePage — vendors, enquiries, orders and goods receipt in one tabbed screen.
 *
 * One page rather than four routes because the four steps are one errand: you compare quotes, raise
 * the order, and receive against it in a single sitting, and splitting that across routes would mean
 * re-finding the same enquiry three times.
 *
 * Costs are hidden from anyone without finance:view. The server strips them from the response too,
 * so this only decides whether the column is drawn — a store-keeper counting cartons at the door
 * sees quantities and nothing else.
 */
const TABS = [
  { id: 'ORDERS', label: 'Orders', icon: ShoppingCart },
  { id: 'RECEIVE', label: 'Receive', icon: PackageCheck },
  { id: 'PAYMENTS', label: 'Payments', icon: IndianRupee, needsMoney: true },
  { id: 'RFQ', label: 'Enquiries', icon: FileQuestion },
  { id: 'VENDORS', label: 'Vendors', icon: Building2 }
];

const money = n => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PurchasePage() {
  const navigate = useNavigate();
  const { token, canSeeMoney } = useAuth();

  const [tab, setTab] = useState('ORDERS');
  const [vendors, setVendors] = useState([]);
  const [rfqs, setRfqs] = useState([]);
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const [vendorForm, setVendorForm] = useState(null);
  const [rfqForm, setRfqForm] = useState(null);
  const [compare, setCompare] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [payments, setPayments] = useState([]);
  const [match, setMatch] = useState(null);
  const [margin, setMargin] = useState(null);

  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token]
  );
  const flash = (text, kind = 'ok') => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 6000); };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [v, r, o, i, l, p] = await Promise.all([
        fetch('/api/vendors', { headers }).then(x => (x.ok ? x.json() : [])),
        fetch('/api/rfqs', { headers }).then(x => (x.ok ? x.json() : [])),
        fetch('/api/purchase-orders', { headers }).then(x => (x.ok ? x.json() : [])),
        fetch('/api/items', { headers }).then(x => (x.ok ? x.json() : [])),
        fetch('/api/purchase-orders/reorder-suggestions', { headers }).then(x => (x.ok ? x.json() : [])),
        fetch('/api/purchase-orders/pending-payment', { headers }).then(x => (x.ok ? x.json() : []))
      ]);
      setVendors(Array.isArray(v) ? v : []);
      setRfqs(Array.isArray(r) ? r : []);
      setOrders(Array.isArray(o) ? o : []);
      setItems(Array.isArray(i) ? i : []);
      setLowStock(Array.isArray(l) ? l : []);
      setPayments(Array.isArray(p) ? p : []);
    } catch {
      flash('Could not load purchase data', 'err');
    } finally { setLoading(false); }
  }, [headers]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const post = async (url, body, okMsg) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      if (okMsg) flash(okMsg);
      await loadAll();
      return data;
    } catch (e) {
      flash(e.message, 'err');
      return null;
    } finally { setBusy(false); }
  };

  const openCompare = async (rfq) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rfqs/${rfq.RFQ_ID}/compare`, { headers });
      if (!res.ok) throw new Error('Could not load the comparison');
      setCompare(await res.json());
    } catch (e) { flash(e.message, 'err'); } finally { setBusy(false); }
  };

  const openMatch = async (poId) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/match`, { headers });
      if (!res.ok) throw new Error('Could not build the match');
      setMatch(await res.json());
    } catch (e) { flash(e.message, 'err'); } finally { setBusy(false); }
  };

  const release = async (poId, note) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/purchase-orders/${poId}/release-payment`, {
        method: 'POST', headers, body: JSON.stringify({ note })
      });
      const data = await res.json();
      // 409 means it does not match and no reason was given — the screen asks for one.
      if (res.status === 409) { flash(data.error, 'err'); return false; }
      if (!res.ok) throw new Error(data.error || 'Could not release payment');
      flash('Payment released.');
      setMatch(null);
      await loadAll();
      return true;
    } catch (e) { flash(e.message, 'err'); return false; } finally { setBusy(false); }
  };

  /** Prices a vendor quote for onward sale so the buyer can see the margin before quoting. */
  const priceForCustomer = async (quote, marginPct, roundTo) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/rfqs/quotes/${quote.PQ_ID}/price-for-customer`, {
        method: 'POST', headers, body: JSON.stringify({ marginPct, roundTo })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not price the quote');
      setMargin({ ...data, marginPct, roundTo });
    } catch (e) { flash(e.message, 'err'); } finally { setBusy(false); }
  };

  /** Turns the winning quote straight into an order — the whole point of comparing. */
  const orderFromQuote = async (quote) => {
    const rfq = compare?.rfq;
    if (!rfq) return;
    const lines = (quote.Lines || []).map(l => {
      const rfqLine = (rfq.Lines || []).find(x => x.lineId === l.lineId) || {};
      return {
        lineId: l.lineId, itemId: rfqLine.Item_ID, itemName: l.Item_Name || rfqLine.Item_Name,
        qty: l.Qty || rfqLine.Qty, unit: rfqLine.Unit, rate: l.Rate, gstRate: l.GST_Rate
      };
    });
    const po = await post('/api/purchase-orders',
      { vendorId: quote.Vendor_ID, rfqId: rfq.RFQ_ID, quoteId: quote.PQ_ID, lines },
      `Purchase order raised on ${quote.Vendor_Name}.`);
    if (po) { setCompare(null); setTab('ORDERS'); }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading purchases…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10 qt-theme">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate('/')} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900">Purchase</p>
            <p className="text-[11px] text-slate-500">Vendors, enquiries, orders and receiving</p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-3 pb-2 flex gap-1 overflow-x-auto scrollbar-none">
          {/* Payments is a money screen end to end — there is nothing on it for someone who
              cannot see amounts, so the tab itself is hidden rather than shown empty. */}
          {TABS.filter(t => !t.needsMoney || canSeeMoney).map(t => {
            const Icon = t.icon;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3 min-h-[40px] rounded-xl text-xs font-extrabold flex items-center gap-1.5 shrink-0 ${
                  tab === t.id ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'
                }`}>
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-3 py-3 space-y-3">
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-start gap-2 ${msg.kind === 'err' ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
            {msg.kind === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}

        {/* ── ORDERS ── */}
        {tab === 'ORDERS' && (
          <>
            {lowStock.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-extrabold text-amber-900 flex items-center gap-1.5">
                  <TrendingDown className="w-3.5 h-3.5" /> {lowStock.length} item(s) at or below reorder level
                </p>
                <ul className="mt-1.5 space-y-0.5">
                  {lowStock.slice(0, 5).map(s => (
                    <li key={s.Item_ID} className="text-[11px] text-amber-800">
                      · <b>{s.Item_Name}</b> — {s.Current_Qty} left, suggest {s.Suggested_Qty} {s.Unit}
                      {s.Last_Vendor_Name && <span className="text-amber-600"> from {s.Last_Vendor_Name}</span>}
                    </li>
                  ))}
                </ul>
                <button onClick={() => { setRfqForm({ lines: lowStock.slice(0, 5).map(s => ({ itemId: s.Item_ID, itemName: s.Item_Name, qty: s.Suggested_Qty, unit: s.Unit })), vendorIds: [] }); setTab('RFQ'); }}
                  className="mt-2 w-full min-h-[44px] rounded-xl bg-amber-600 text-white text-xs font-extrabold active:bg-amber-700">
                  Raise an enquiry for these
                </button>
              </div>
            )}

            {orders.length === 0 ? (
              <Empty text="No purchase orders yet. Compare quotes on an enquiry to raise one." />
            ) : orders.map(po => (
              <div key={po.PO_ID} className="bg-white border border-slate-200 rounded-xl p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-extrabold text-slate-900 truncate">{po.PO_No}</p>
                    <p className="text-[11px] text-slate-500 truncate">{po.Vendor_Name} · {po.PO_Date}</p>
                  </div>
                  <StatusChip status={po.Status} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">
                    {(po.Lines || []).length} line(s)
                    {canSeeMoney && po.Subtotal !== undefined && <> · <b className="text-slate-700">{money(po.Subtotal)}</b></>}
                  </span>
                  {po.Status !== 'Received' && po.Status !== 'Cancelled' && (
                    <button onClick={() => { setReceiving({ po, lines: {}, totalCharges: '', vendorInvoiceNo: '', rating: 0 }); setTab('RECEIVE'); }}
                      className="px-3 min-h-[40px] rounded-xl bg-slate-900 text-white text-[11px] font-extrabold active:bg-slate-800">
                      Receive
                    </button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ── RECEIVE ── */}
        {tab === 'RECEIVE' && (
          receiving ? (
            <ReceiveForm
              state={receiving}
              setState={setReceiving}
              canSeeMoney={canSeeMoney}
              busy={busy}
              onCancel={() => { setReceiving(null); setTab('ORDERS'); }}
              onSubmit={async () => {
                const lines = Object.entries(receiving.lines)
                  .filter(([, v]) => Number(v) > 0)
                  .map(([lineId, v]) => ({ lineId, receivedQty: Number(v) }));
                if (lines.length === 0) return flash('Enter what actually arrived.', 'err');
                const out = await post('/api/grns', {
                  poId: receiving.po.PO_ID, lines,
                  totalCharges: Number(receiving.totalCharges) || 0,
                  vendorInvoiceNo: receiving.vendorInvoiceNo,
                  vendorRating: receiving.rating
                }, 'Goods received and stock updated.');
                if (out) { setReceiving(null); setTab('ORDERS'); }
              }}
            />
          ) : <Empty text="Pick an order from the Orders tab to receive against it." />
        )}

        {/* ── PAYMENTS: 3-way match before release ── */}
        {tab === 'PAYMENTS' && canSeeMoney && (
          match ? (
            <MatchView data={match} busy={busy} onClose={() => setMatch(null)} onRelease={release} />
          ) : payments.length === 0 ? (
            <Empty text="Nothing awaiting payment. Orders appear here once goods have been received against them." />
          ) : (
            <>
              <p className="text-[11px] text-slate-500 px-1">
                Ordered, received and billed — compared before anyone pays.
              </p>
              {payments.map(p => (
                <button key={p.PO_ID} onClick={() => openMatch(p.PO_ID)} disabled={busy}
                  className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 active:bg-slate-50 disabled:opacity-50">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-extrabold text-slate-900 truncate">{p.PO_No}</p>
                      <p className="text-[11px] text-slate-500 truncate">{p.Vendor_Name} · {p.PO_Date}</p>
                    </div>
                    <MatchChip status={p.Match_Status} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">
                      Billed <b className="text-slate-700">{money(p.Vendor_Invoice_Total)}</b>
                      {' vs '}<b className="text-slate-700">{money(p.Expected_Total)}</b> received
                    </span>
                    {Math.abs(p.Invoice_Variance) > 0 && (
                      <span className={`text-[11px] font-extrabold ${p.Invoice_Variance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {p.Invoice_Variance > 0 ? '+' : ''}{money(p.Invoice_Variance)}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </>
          )
        )}

        {/* ── ENQUIRIES ── */}
        {tab === 'RFQ' && (
          compare ? (
            <CompareView data={compare} canSeeMoney={canSeeMoney} busy={busy}
              onClose={() => { setCompare(null); setMargin(null); }} onOrder={orderFromQuote}
              margin={margin} onPrice={priceForCustomer} onClearMargin={() => setMargin(null)} />
          ) : rfqForm ? (
            <RfqForm form={rfqForm} setForm={setRfqForm} vendors={vendors} items={items} busy={busy}
              onCancel={() => setRfqForm(null)}
              onSubmit={async () => {
                const out = await post('/api/rfqs', rfqForm, 'Enquiry created.');
                if (out) setRfqForm(null);
              }} />
          ) : (
            <>
              <button onClick={() => setRfqForm({ title: '', vendorIds: [], lines: [{ itemName: '', qty: 1, unit: 'Nos' }] })}
                className="w-full min-h-[48px] rounded-xl border-2 border-dashed border-slate-300 text-sm font-bold text-slate-500 active:bg-slate-100 flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> New enquiry
              </button>
              {rfqs.map(r => (
                <div key={r.RFQ_ID} className="bg-white border border-slate-200 rounded-xl p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-extrabold text-slate-900 truncate">{r.Title || r.RFQ_No}</p>
                      <p className="text-[11px] text-slate-500">
                        {(r.Lines || []).length} item(s) · {(r.Vendor_IDs || []).length} vendor(s) · {r.RFQ_Date}
                      </p>
                    </div>
                    <StatusChip status={r.Status} />
                  </div>
                  <button onClick={() => openCompare(r)} disabled={busy}
                    className="mt-2 w-full min-h-[44px] rounded-xl border border-slate-300 text-xs font-extrabold text-slate-700 active:bg-slate-50 disabled:opacity-40">
                    Compare quotes
                  </button>
                </div>
              ))}
            </>
          )
        )}

        {/* ── VENDORS ── */}
        {tab === 'VENDORS' && (
          <>
            {vendorForm ? (
              <VendorForm form={vendorForm} setForm={setVendorForm} busy={busy}
                onCancel={() => setVendorForm(null)}
                onSubmit={async () => {
                  const isNew = !vendorForm.Vendor_ID;
                  setBusy(true);
                  try {
                    const res = await fetch(isNew ? '/api/vendors' : `/api/vendors/${vendorForm.Vendor_ID}`, {
                      method: isNew ? 'POST' : 'PUT', headers, body: JSON.stringify(vendorForm)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    flash('Vendor saved.');
                    setVendorForm(null);
                    await loadAll();
                  } catch (e) { flash(e.message, 'err'); } finally { setBusy(false); }
                }} />
            ) : (
              <button onClick={() => setVendorForm({ vendorName: '', gstin: '', phone: '', email: '', leadTimeDays: 0 })}
                className="w-full min-h-[48px] rounded-xl border-2 border-dashed border-slate-300 text-sm font-bold text-slate-500 active:bg-slate-100 flex items-center justify-center gap-2">
                <Plus className="w-4 h-4" /> Add vendor
              </button>
            )}
            {vendors.map(v => (
              <button key={v.Vendor_ID} onClick={() => setVendorForm({ ...v, vendorName: v.Vendor_Name, gstin: v.GSTIN, phone: v.Phone, email: v.Email, leadTimeDays: v.Lead_Time_Days })}
                className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 active:bg-slate-50">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-extrabold text-slate-900 truncate">{v.Vendor_Name}</p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {v.GSTIN || 'No GSTIN'}{v.Lead_Time_Days > 0 && ` · ${v.Lead_Time_Days} day lead`}
                    </p>
                  </div>
                  {v.Rating_Average > 0 && (
                    <span className="text-[11px] font-bold text-amber-600 flex items-center gap-0.5 shrink-0">
                      <Star className="w-3 h-3 fill-amber-400 text-amber-400" /> {v.Rating_Average}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </>
        )}
      </main>
    </div>
  );
}

function Empty({ text }) {
  return <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400 px-6">{text}</div>;
}

function MatchChip({ status }) {
  const tone = status === 'Matched' ? 'bg-emerald-100 text-emerald-700'
    : status === 'Over Billed' ? 'bg-rose-100 text-rose-700'
    : /Awaiting/.test(status) ? 'bg-slate-100 text-slate-500'
    : 'bg-amber-100 text-amber-800';
  return <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold shrink-0 ${tone}`}>{status}</span>;
}

/**
 * The 3-way match: ordered vs received vs billed, line by line.
 *
 * A mismatch does not block the release — Accounts often knows something the rule cannot, like a
 * part-shipment everyone agreed to. It does demand a written reason, so the decision is recorded
 * rather than argued about later.
 */
function MatchView({ data, busy, onClose, onRelease }) {
  const { purchaseOrder: po, lines, summary, receipts } = data;
  const [note, setNote] = useState('');

  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-extrabold text-slate-900 truncate">{po.PO_No}</p>
          <p className="text-[11px] text-slate-500 truncate">{po.Vendor_Name}</p>
        </div>
        <MatchChip status={summary.Match_Status} />
        <button onClick={onClose} className="px-3 min-h-[40px] rounded-xl border border-slate-300 text-[11px] font-extrabold text-slate-600 shrink-0">Back</button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-slate-400">
              <th className="text-left font-bold pb-1">Item</th>
              <th className="text-right font-bold pb-1 px-1">Ordered</th>
              <th className="text-right font-bold pb-1 px-1">Received</th>
              <th className="text-right font-bold pb-1 px-1">Billed</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.lineId} className="border-t border-slate-100">
                <td className="py-1.5 pr-2">
                  <span className="font-medium text-slate-700">{l.Item_Name}</span>
                  {l.Status !== 'Matched' && (
                    <span className="block text-[10px] font-bold text-amber-700">{l.Status}</span>
                  )}
                </td>
                <td className="py-1.5 px-1 text-right text-slate-600 whitespace-nowrap">{l.Ordered_Qty}</td>
                <td className={`py-1.5 px-1 text-right whitespace-nowrap font-bold ${
                  l.Qty_Variance === 0 ? 'text-slate-600' : l.Qty_Variance < 0 ? 'text-amber-700' : 'text-blue-700'
                }`}>
                  {l.Received_Qty}{l.Qty_Variance !== 0 && <span className="font-medium"> ({l.Qty_Variance > 0 ? '+' : ''}{l.Qty_Variance})</span>}
                </td>
                <td className={`py-1.5 px-1 text-right whitespace-nowrap ${Math.abs(l.Value_Variance) > 0.01 ? 'font-extrabold text-rose-600' : 'text-slate-600'}`}>
                  {money(l.Received_Value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-1 text-[11px]">
        <Row label="Value of goods received" value={money(summary.Expected_Total)} />
        <Row label="Vendor invoice" value={money(summary.Vendor_Invoice_Total)} />
        <div className="border-t border-slate-100 pt-1">
          <Row
            label={summary.Invoice_Variance > 0 ? 'Billed ABOVE goods received' : summary.Invoice_Variance < 0 ? 'Billed below goods received' : 'Difference'}
            value={money(summary.Invoice_Variance)}
            strong
            tone={summary.Invoice_Variance > 0 ? 'text-rose-600' : summary.Invoice_Variance < 0 ? 'text-emerald-600' : ''}
          />
        </div>
        {receipts.length > 0 && (
          <p className="text-[10px] text-slate-400 pt-1">
            {receipts.length} receipt(s): {receipts.map(r => r.Vendor_Invoice_No || r.GRN_No).join(', ')}
          </p>
        )}
      </div>

      {po.Payment_Released ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-900">
          <b>Payment released.</b>{po.Payment_Release_Note && <> Reason: {po.Payment_Release_Note}</>}
        </div>
      ) : (
        <div className="space-y-2">
          {!summary.Is_Matched && (
            <>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
                This order does not match. You can still pay it — say why, so the difference is on record.
              </div>
              <textarea rows={2} value={note} onChange={e => setNote(e.target.value)}
                placeholder="Why is this being paid despite the difference?"
                className="w-full rounded-xl border border-slate-300 px-2.5 py-2 text-xs" />
            </>
          )}
          <button onClick={() => onRelease(po.PO_ID, note)}
            disabled={busy || (!summary.Is_Matched && !note.trim())}
            className={`w-full min-h-[48px] rounded-xl text-sm font-extrabold disabled:opacity-40 ${
              summary.Is_Matched ? 'bg-emerald-600 text-white active:bg-emerald-700' : 'bg-amber-600 text-white active:bg-amber-700'
            }`}>
            {summary.Is_Matched ? 'Release payment' : 'Release anyway'}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong, tone = '' }) {
  return (
    <div className="flex items-center justify-between">
      <span className={strong ? 'font-bold text-slate-700' : 'text-slate-500'}>{label}</span>
      <span className={`${strong ? 'font-extrabold' : 'font-bold'} ${tone || 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

function StatusChip({ status }) {
  const tone = /Received$/.test(status) ? 'bg-emerald-100 text-emerald-700'
    : /Partial/.test(status) ? 'bg-amber-100 text-amber-800'
    : /Cancelled/.test(status) ? 'bg-slate-100 text-slate-500'
    : 'bg-blue-100 text-blue-700';
  return <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold shrink-0 ${tone}`}>{status}</span>;
}

/** Quantity-first receiving. Costs never appear here unless the viewer is allowed to see them. */
function ReceiveForm({ state, setState, canSeeMoney, busy, onCancel, onSubmit }) {
  const { po } = state;
  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl p-3">
        <p className="text-xs font-extrabold text-slate-900">{po.PO_No}</p>
        <p className="text-[11px] text-slate-500">{po.Vendor_Name}</p>
      </div>

      {(po.Lines || []).map(l => {
        const outstanding = (Number(l.Qty) || 0) - (Number(l.Received_Qty) || 0);
        return (
          <div key={l.lineId} className="bg-white border border-slate-200 rounded-xl p-3">
            <p className="text-xs font-bold text-slate-800">{l.Item_Name}</p>
            <p className="text-[11px] text-slate-500 mb-2">
              Ordered {l.Qty} {l.Unit}
              {Number(l.Received_Qty) > 0 && ` · ${l.Received_Qty} already received`}
              {outstanding > 0 && ` · ${outstanding} outstanding`}
              {canSeeMoney && l.Rate !== undefined && ` · ${money(l.Rate)}/${l.Unit}`}
            </p>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Received now</span>
              <input type="number" inputMode="decimal" className="jc-input" placeholder="0"
                value={state.lines[l.lineId] ?? ''}
                onChange={e => setState(s => ({ ...s, lines: { ...s.lines, [l.lineId]: e.target.value } }))} />
            </label>
          </div>
        );
      })}

      <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
        <label className="block">
          <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Vendor invoice no</span>
          <input className="jc-input" value={state.vendorInvoiceNo}
            onChange={e => setState(s => ({ ...s, vendorInvoiceNo: e.target.value }))} />
        </label>
        {canSeeMoney && (
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
              Freight / cartage <span className="font-medium normal-case tracking-normal">— spread across lines by value</span>
            </span>
            <input type="number" inputMode="decimal" className="jc-input" placeholder="0"
              value={state.totalCharges}
              onChange={e => setState(s => ({ ...s, totalCharges: e.target.value }))} />
          </label>
        )}
        <div>
          <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-1">Rate this delivery</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setState(s => ({ ...s, rating: n }))} aria-label={`${n} stars`}
                className="w-10 h-10 rounded-lg flex items-center justify-center active:bg-slate-100">
                <Star className={`w-5 h-5 ${n <= state.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl border border-slate-300 text-sm font-extrabold text-slate-600 active:bg-slate-50">
          Cancel
        </button>
        <button onClick={onSubmit} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold active:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Post receipt
        </button>
      </div>
    </div>
  );
}

/** L1/L2/L3 side by side. The lowest total wins the badge; the lowest per line is marked too. */
function CompareView({ data, canSeeMoney, busy, onClose, onOrder, margin, onPrice, onClearMargin }) {
  const { rfq, quotes, lineComparison } = data;
  const [marginPct, setMarginPct] = useState(20);
  const [roundTo, setRoundTo] = useState(0);

  // Pricing a vendor quote for onward sale is inherently a money screen.
  if (margin && canSeeMoney) {
    return (
      <div className="space-y-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-extrabold text-slate-900 truncate">Quoting on from {margin.source.Vendor_Name}</p>
            <p className="text-[11px] text-slate-500">Their rate plus your margin</p>
          </div>
          <button onClick={onClearMargin} className="px-3 min-h-[40px] rounded-xl border border-slate-300 text-[11px] font-extrabold text-slate-600 shrink-0">Back</button>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Margin %</span>
            <input type="number" inputMode="decimal" className="jc-input" value={marginPct}
              onChange={e => setMarginPct(e.target.value)}
              onBlur={() => onPrice(margin.source, marginPct, roundTo)} />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Round up to</span>
            <select className="jc-input" value={roundTo}
              onChange={e => { setRoundTo(e.target.value); onPrice(margin.source, marginPct, e.target.value); }}>
              <option value="0">No rounding</option>
              <option value="1">₹1</option>
              <option value="5">₹5</option>
              <option value="10">₹10</option>
              <option value="50">₹50</option>
            </select>
          </label>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-bold pb-1">Item</th>
                <th className="text-right font-bold pb-1 px-1">Cost</th>
                <th className="text-right font-bold pb-1 px-1">Sell</th>
                <th className="text-right font-bold pb-1 px-1">Total</th>
              </tr>
            </thead>
            <tbody>
              {margin.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2 font-medium text-slate-700">{l.Item_Name}<span className="text-slate-400"> ×{l.Qty}</span></td>
                  <td className="py-1.5 px-1 text-right text-slate-500 whitespace-nowrap">{money(l.Purchase_Rate)}</td>
                  <td className="py-1.5 px-1 text-right font-extrabold text-slate-800 whitespace-nowrap">{money(l.Rate)}</td>
                  <td className="py-1.5 px-1 text-right text-slate-600 whitespace-nowrap">{money(l.Line_Total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-1 text-[11px]">
          <Row label="Total cost" value={money(margin.summary.Cost_Total)} />
          <Row label="Selling total" value={money(margin.summary.Selling_Total)} strong />
          <Row label="Your margin" value={`${money(margin.summary.Margin_Amount)} · ${margin.summary.Effective_Margin_Pct}%`}
            tone="text-emerald-600" strong />
          {margin.summary.Effective_Margin_Pct !== margin.summary.Requested_Margin_Pct && (
            <p className="text-[10px] text-slate-400 pt-1">
              Rounding moved the margin from {margin.summary.Requested_Margin_Pct}% to {margin.summary.Effective_Margin_Pct}%.
            </p>
          )}
        </div>

        <p className="text-[10px] text-slate-400 px-1">
          Take these rates into a new quotation — the builder adds the customer, GST and terms.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-extrabold text-slate-900 truncate">{rfq.Title || rfq.RFQ_No}</p>
          <p className="text-[11px] text-slate-500">{quotes.length} quote(s) received</p>
        </div>
        <button onClick={onClose} className="px-3 min-h-[40px] rounded-xl border border-slate-300 text-[11px] font-extrabold text-slate-600">Back</button>
      </div>

      {quotes.length === 0 ? (
        <Empty text="No quotes recorded against this enquiry yet." />
      ) : (
        <>
          {quotes.map(q => (
            <div key={q.PQ_ID} className={`bg-white border rounded-xl p-3 ${q.Is_Lowest ? 'border-emerald-300 ring-1 ring-emerald-200' : 'border-slate-200'}`}>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${q.Is_Lowest ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                  {q.Rank}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-slate-900 truncate">{q.Vendor_Name}</p>
                  <p className="text-[11px] text-slate-500">
                    {q.Lead_Time_Days > 0 && `${q.Lead_Time_Days} day lead`}
                    {canSeeMoney && q.Quote_Total !== undefined && ` · ${money(q.Quote_Total)}`}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => onOrder(q)} disabled={busy}
                  className={`flex-1 min-h-[44px] rounded-xl text-xs font-extrabold disabled:opacity-40 ${
                    q.Is_Lowest ? 'bg-emerald-600 text-white active:bg-emerald-700' : 'border border-slate-300 text-slate-700 active:bg-slate-50'
                  }`}>
                  Raise order
                </button>
                {canSeeMoney && (
                  <button onClick={() => onPrice(q, 20, 0)} disabled={busy}
                    className="flex-1 min-h-[44px] rounded-xl border border-indigo-300 bg-indigo-50 text-indigo-800 text-xs font-extrabold active:bg-indigo-100 disabled:opacity-40 flex items-center justify-center gap-1">
                    Quote on <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}

          {canSeeMoney && (
            <div className="bg-white border border-slate-200 rounded-xl p-3 overflow-x-auto">
              <p className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-2">Line by line</p>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-slate-400">
                    <th className="text-left font-bold pb-1">Item</th>
                    {quotes.map(q => <th key={q.PQ_ID} className="text-right font-bold pb-1 px-1 whitespace-nowrap">{q.Rank}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {lineComparison.map(line => (
                    <tr key={line.lineId} className="border-t border-slate-100">
                      <td className="py-1 pr-2 font-medium text-slate-700">{line.Item_Name}<span className="text-slate-400"> ×{line.Qty}</span></td>
                      {line.offers.map(o => (
                        <td key={o.Vendor_ID} className={`py-1 px-1 text-right whitespace-nowrap ${o.Is_Lowest_For_Line ? 'font-extrabold text-emerald-700' : 'text-slate-600'}`}>
                          {o.Rate === null ? '—' : money(o.Rate)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RfqForm({ form, setForm, vendors, items, busy, onCancel, onSubmit }) {
  const [vendorQuery, setVendorQuery] = useState('');
  const setLine = (i, patch) => setForm(f => ({
    ...f, lines: f.lines.map((l, n) => (n === i ? { ...l, ...patch } : l))
  }));
  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
        <label className="block">
          <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">What is this for</span>
          <input className="jc-input" value={form.title} placeholder="Q3 workshop spares"
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        </label>
        <div>
          <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-1">
            Ask these vendors {form.vendorIds.length > 0 && <span className="text-slate-600">· {form.vendorIds.length} selected</span>}
          </span>
          {/* A filter rather than a dropdown: this is multi-select, and hiding the ticks behind a
              popover would mean losing sight of who is already chosen. */}
          {vendors.length > 6 && (
            <input className="jc-input mb-1" value={vendorQuery}
              placeholder="Filter vendors" onChange={e => setVendorQuery(e.target.value)} />
          )}
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {filterByQuery(vendors, vendorQuery, v => [v.Vendor_Name, v.GSTIN, v.Contact_Person]).map(v => (
              <label key={v.Vendor_ID} className="flex items-center gap-2 min-h-[48px] px-2 rounded-lg border border-slate-200 active:bg-slate-50">
                <input type="checkbox" className="w-4 h-4"
                  checked={form.vendorIds.includes(v.Vendor_ID)}
                  onChange={() => setForm(f => ({
                    ...f,
                    vendorIds: f.vendorIds.includes(v.Vendor_ID)
                      ? f.vendorIds.filter(x => x !== v.Vendor_ID)
                      : [...f.vendorIds, v.Vendor_ID]
                  }))} />
                <span className="text-xs font-bold text-slate-700 truncate">{v.Vendor_Name}</span>
              </label>
            ))}
            {vendors.length === 0 && <p className="text-[11px] text-slate-400">Add a vendor first.</p>}
          </div>
        </div>
      </div>

      {form.lines.map((l, i) => (
        <div key={i} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400">Item {i + 1}</span>
            {form.lines.length > 1 && (
              <button onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, n) => n !== i) }))}
                aria-label="Remove item" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 active:bg-rose-50 active:text-rose-600">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* allowFreeText because an enquiry often precedes the catalogue — you ask for a part
              before anyone has created an item row for it, and blocking that would be backwards. */}
          <SmartSearchSelect
            options={items}
            value={l.itemName ? (items.find(it => it.Item_ID === l.itemId) || l.itemName) : null}
            onChange={sel => {
              if (!sel) return setLine(i, { itemName: '', itemId: '' });
              if (typeof sel === 'string') return setLine(i, { itemName: sel, itemId: '' });
              setLine(i, { itemName: sel.Item_Name, itemId: sel.Item_ID, unit: sel.Unit || l.unit });
            }}
            getLabel={it => (typeof it === 'string' ? it : it.Item_Name)}
            getSubtitle={it => (typeof it === 'string' ? '' : [it.Category, it.HSN_Code].filter(Boolean).join(' · '))}
            getKey={it => (typeof it === 'string' ? it : it.Item_ID)}
            getSearchable={it => (typeof it === 'string' ? [it] : [it.Item_Name, it.Category, it.HSN_Code, ...(it.Aliases || [])])}
            placeholder="Search or type an item"
            allowFreeText
          />
          <div className="grid grid-cols-2 gap-2">
            <input type="number" inputMode="decimal" className="jc-input" placeholder="Qty"
              value={l.qty ?? ''} onChange={e => setLine(i, { qty: e.target.value })} />
            <input className="jc-input" placeholder="Unit" value={l.unit || 'Nos'}
              onChange={e => setLine(i, { unit: e.target.value })} />
          </div>
          <input className="jc-input" placeholder="Specification (optional)" value={l.specification || ''}
            onChange={e => setLine(i, { specification: e.target.value })} />
        </div>
      ))}

      <button onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { itemName: '', qty: 1, unit: 'Nos' }] }))}
        className="jc-btn-ghost w-full border border-dashed border-slate-300 rounded-xl">
        <Plus className="w-3.5 h-3.5" /> Add item
      </button>

      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl border border-slate-300 text-sm font-extrabold text-slate-600 active:bg-slate-50">Cancel</button>
        <button onClick={onSubmit} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold active:bg-slate-800 disabled:opacity-40">
          Create enquiry
        </button>
      </div>
    </div>
  );
}

function VendorForm({ form, setForm, busy, onCancel, onSubmit }) {
  const F = ({ label, field, type = 'text', placeholder }) => (
    <label className="block">
      <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">{label}</span>
      <input className="jc-input" type={type} placeholder={placeholder} value={form[field] ?? ''}
        onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} />
    </label>
  );
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
      <F label="Vendor name" field="vendorName" placeholder="Acme Fire Services" />
      <div className="grid grid-cols-2 gap-2">
        <F label="GSTIN" field="gstin" placeholder="24ABCDE1234F1Z5" />
        <F label="Lead time (days)" field="leadTimeDays" type="number" placeholder="7" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <F label="Phone" field="phone" />
        <F label="Email" field="email" type="email" />
      </div>
      <F label="Payment terms" field="paymentTerms" placeholder="30 days" />
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl border border-slate-300 text-sm font-extrabold text-slate-600 active:bg-slate-50">Cancel</button>
        <button onClick={onSubmit} disabled={busy}
          className="flex-1 min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold active:bg-slate-800 disabled:opacity-40">Save vendor</button>
      </div>
    </div>
  );
}
