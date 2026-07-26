import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, Save, Send, FileText, Download, CheckCircle2,
  AlertTriangle, History, Loader2, Copy, Building2, Search, Eye, X, Printer, MoreHorizontal,
  Image as ImageIcon, Mail, MessageCircle
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useDocSettings } from '../context/DocSettingsContext';
import QuotationPdfTemplate from '../components/QuotationPdfTemplate';
import GstinInput from '../components/GstinInput';
import { downloadPdfFromElement, fetchAsBase64, safeFileName } from '../utils/pdfGenerator';
import {
  formatMoney, formatDate, statusMeta, emptyLineItem,
  isEditable, isDispatchable, canRevise
} from '../utils/quotationUtils';
import { stateOptions } from '../utils/gstinUtils';

/**
 * Quotation builder — a dedicated route (not an AdminDashboard tab) because it's a stateful
 * multi-step flow: pick customer -> build line items -> review server-computed tax -> dispatch.
 *
 * All money math is server-side: every edit re-requests /api/quotations/preview so the totals on
 * screen are always the same figures that will be saved and printed.
 */
export default function QuotationBuilderPage() {
  const { quotationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const { docSettings } = useDocSettings();

  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';
  const pdfRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [settings, setSettings] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [lastRates, setLastRates] = useState({});
  const [branding, setBranding] = useState({});

  const [quotation, setQuotation] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [showActions, setShowActions] = useState(false);
  // Inline customer editor, so a missing GSTIN can be fixed without leaving the quotation.
  const [custEdit, setCustEdit] = useState(null);
  const [savingCust, setSavingCust] = useState(false);
  // The A4 sheet is 794px wide; scale it down to fit narrow screens rather than letting the
  // modal scroll horizontally.
  const [previewScale, setPreviewScale] = useState(1);

  // Draft form state (only meaningful before the quotation is issued)
  const [form, setForm] = useState({
    customerId: searchParams.get('customerId') || '',
    taskId: searchParams.get('taskId') || '',
    subject: '',
    notes: '',
    paymentTermsId: '',
    selectedTncIds: [],
    followUpIntervalDays: '',
    autoExpiryDays: '',
    destinationStateCode: '',
    documentDiscountPct: 0,
    lineItems: [emptyLineItem()]
  });
  const [totals, setTotals] = useState(null);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }), [token]);

  // ---- initial load ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [sRes, cRes, iRes] = await Promise.all([
          fetch('/api/quotation-settings', { headers: authHeaders }),
          fetch('/api/customers', { headers: authHeaders }),
          fetch('/api/items', { headers: authHeaders })
        ]);
        if (cancelled) return;

        const s = sRes.ok ? await sRes.json() : null;
        const c = cRes.ok ? await cRes.json() : [];
        const i = iRes.ok ? await iRes.json() : [];

        setSettings(s);
        setCustomers(Array.isArray(c) ? c : []);
        setItems((Array.isArray(i) ? i : []).filter(x => x.Active !== false));

        if (s) {
          setForm(f => ({
            ...f,
            followUpIntervalDays: f.followUpIntervalDays || s.defaults?.follow_up_interval_days || 3,
            autoExpiryDays: f.autoExpiryDays || s.defaults?.auto_expiry_days || 30,
            selectedTncIds: f.selectedTncIds.length
              ? f.selectedTncIds
              : (s.tnc_checklist || []).filter(t => t.default_checked).map(t => t.id)
          }));
        }
      } catch (e) {
        if (!cancelled) setError('Could not load quotation settings or master data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authHeaders]);

  // ---- load an existing quotation ----
  useEffect(() => {
    if (!quotationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/quotations/${quotationId}`, { headers: authHeaders });
        if (!res.ok) throw new Error('Quotation not found');
        const q = await res.json();
        if (cancelled) return;
        setQuotation(q);
        setForm(f => ({
          ...f,
          customerId: q.Customer_ID,
          taskId: q.Task_ID || '',
          subject: q.Subject || '',
          notes: q.Notes || '',
          paymentTermsId: q.Payment_Terms_ID || '',
          selectedTncIds: q.Selected_TNC_IDs || [],
          followUpIntervalDays: q.Follow_Up_Interval_Days,
          autoExpiryDays: q.Auto_Expiry_Days,
          destinationStateCode: q.Destination_State_Code || '',
          documentDiscountPct: q.Document_Level_Discount_Pct || 0,
          lineItems: (q.Line_Items || []).length ? q.Line_Items : [emptyLineItem()]
        }));
        setTotals(q);

        const hRes = await fetch(`/api/quotations/${q.Root_Quotation_ID || q.Quotation_ID}/history`, { headers: authHeaders });
        if (hRes.ok && !cancelled) setHistory(await hRes.json());
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [quotationId, authHeaders]);

  // ---- branding assets, inlined as base64 for html2canvas ----
  useEffect(() => {
    const assets = docSettings?.branding_assets;
    if (!assets) return;
    let cancelled = false;
    (async () => {
      // Signature image is deliberately NOT fetched — quotations/PI/invoices show the company
      // stamp above a typed signatory name, with no handwritten signature graphic.
      const [header, footer, stamp, watermark] = await Promise.all([
        fetchAsBase64(assets.header_image_url),
        fetchAsBase64(assets.footer_image_url),
        fetchAsBase64(assets.company_stamp_url),
        fetchAsBase64(assets.watermark_logo_url)
      ]);
      if (!cancelled) setBranding({ header, footer, stamp, watermark });
    })();
    return () => { cancelled = true; };
  }, [docSettings]);

  // Scale the 794px A4 sheet to fit the viewport when the preview is open.
  useEffect(() => {
    if (!showPreview) return;
    const fit = () => setPreviewScale(Math.min((window.innerWidth - 64) / 794, 1));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [showPreview]);

  // ---- historical rates when the customer changes ----
  useEffect(() => {
    if (!form.customerId) { setLastRates({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/quotations/last-rates/${form.customerId}`, { headers: authHeaders });
        if (res.ok && !cancelled) setLastRates(await res.json());
      } catch (e) { /* suggestions are optional */ }
    })();
    return () => { cancelled = true; };
  }, [form.customerId, authHeaders]);

  const selectedCustomer = customers.find(c => c.Customer_ID === form.customerId);
  const readOnly = quotation ? !isEditable(quotation.Status) : false;

  // ---- live server-side pricing (debounced) ----
  const priceNow = useCallback(async () => {
    const valid = form.lineItems.filter(l => l.Item_Name && Number(l.Qty) > 0);
    if (!form.customerId || valid.length === 0) { setTotals(null); return; }
    try {
      const res = await fetch('/api/quotations/preview', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          customerId: form.customerId,
          lineItems: valid,
          documentDiscountPct: Number(form.documentDiscountPct) || 0,
          destinationStateCode: form.destinationStateCode
        })
      });
      if (res.ok) setTotals(await res.json());
    } catch (e) { /* keep last good totals */ }
  }, [form.customerId, form.lineItems, form.documentDiscountPct, form.destinationStateCode, authHeaders]);

  useEffect(() => {
    if (readOnly) return;
    const t = setTimeout(priceNow, 400);
    return () => clearTimeout(t);
  }, [priceNow, readOnly]);

  // ---- line item helpers ----
  const updateLine = (idx, patch) => {
    setForm(f => ({
      ...f,
      lineItems: f.lineItems.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    }));
  };

  /**
   * Resolves a line's product photo against the current item master rather than trusting the
   * Photo_URL snapshotted on the line. Quotations saved before an item got its photo (or before
   * the photo column existed at all) carry no Photo_URL, so reading it back from the line alone
   * would leave those documents permanently image-less.
   */
  const linePhoto = useCallback((line) => {
    if (!line) return '';
    return items.find(i => i.Item_ID === line.Item_ID)?.Photo_URL || line.Photo_URL || '';
  }, [items]);

  const pickItem = (idx, itemId) => {
    const item = items.find(i => i.Item_ID === itemId);
    if (!item) { updateLine(idx, { Item_ID: '', Item_Name: '', Photo_URL: '' }); return; }
    const suggested = lastRates[itemId];
    updateLine(idx, {
      Item_ID: item.Item_ID,
      Item_Name: item.Item_Name,
      HSN_Code: item.HSN_Code || '',
      Unit: item.Unit || 'Nos',
      GST_Rate: Number(item.Default_GST_Rate) || settings?.defaults?.default_gst_rate || 18,
      // Prefer the last rate this specific customer was quoted, else the catalog rate.
      Rate: suggested ? suggested.rate : (Number(item.Standard_Rate) || 0),
      // Carried onto the line so the quotation PDF can show the product image and copy.
      Photo_URL: item.Photo_URL || '',
      Long_Description: item.Long_Description || item.Description || ''
    });
  };

  const addLine = () => setForm(f => ({
    ...f,
    lineItems: [...f.lineItems, emptyLineItem(settings?.defaults?.default_gst_rate || 18)]
  }));

  const removeLine = (idx) => setForm(f => ({
    ...f,
    lineItems: f.lineItems.length === 1 ? [emptyLineItem()] : f.lineItems.filter((_, i) => i !== idx)
  }));

  // ---- actions ----
  const flash = (msg, isError = false) => {
    if (isError) { setError(msg); setNotice(''); } else { setNotice(msg); setError(''); }
    setTimeout(() => { setNotice(''); setError(''); }, 6000);
  };

  const payload = () => ({
    customerId: form.customerId,
    taskId: form.taskId || undefined,
    lineItems: form.lineItems.filter(l => l.Item_Name && Number(l.Qty) > 0),
    documentDiscountPct: Number(form.documentDiscountPct) || 0,
    destinationStateCode: form.destinationStateCode,
    subject: form.subject,
    notes: form.notes,
    paymentTermsId: form.paymentTermsId,
    selectedTncIds: form.selectedTncIds,
    followUpIntervalDays: Number(form.followUpIntervalDays) || undefined,
    autoExpiryDays: Number(form.autoExpiryDays) || undefined
  });

  const handleSave = async () => {
    if (!form.customerId) return flash('Select a customer first.', true);
    if (payload().lineItems.length === 0) return flash('Add at least one line item.', true);

    setSaving(true);
    try {
      const url = quotation ? `/api/quotations/${quotation.Quotation_ID}` : '/api/quotations';
      const res = await fetch(url, {
        method: quotation ? 'PUT' : 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload())
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      setQuotation(data);
      setTotals(data);
      flash(quotation ? 'Quotation updated.' : `Quotation ${data.Quote_No_Display} created.`);
      if (!quotation) navigate(`/quotations/${data.Quotation_ID}`, { replace: true });
    } catch (e) {
      flash(e.message, true);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action, path, body, successMsg) => {
    setBusyAction(action);
    try {
      const res = await fetch(path, { method: 'POST', headers: authHeaders, body: JSON.stringify(body || {}) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      return data;
    } catch (e) {
      flash(e.message, true);
      return null;
    } finally {
      setBusyAction('');
    }
  };

  const handleApprove = async () => {
    const data = await runAction('approve', `/api/quotations/${quotation.Quotation_ID}/approve`);
    if (data) { setQuotation(data); flash('Approved. The quotation can now be dispatched.'); }
  };

  /**
   * Dispatches the quotation. `channel` sends over Email or WhatsApp alone; omitting it uses the
   * dispatch_mode configured in Quotation Settings.
   */
  const handleDispatch = async (channel) => {
    const data = await runAction(
      channel ? `dispatch:${channel}` : 'dispatch',
      `/api/quotations/${quotation.Quotation_ID}/dispatch`,
      channel ? { channel } : {}
    );
    if (!data) return;
    setQuotation(data.quotation);
    const results = data.dispatchResults || [];
    const failures = results.filter(r => !r.ok);
    if (results.length && failures.length === results.length) {
      flash(`Dispatch failed: ${failures.map(f => `${f.channel} — ${f.error}`).join('; ')}`, true);
    } else if (failures.length) {
      // Partial success: one channel landed, the other didn't — surface both outcomes.
      flash(`Sent via ${results.filter(r => r.ok).map(r => r.channel).join(', ')}. Failed: ${failures.map(f => `${f.channel} — ${f.error}`).join('; ')}`, true);
    } else {
      flash(`Sent${channel ? ` via ${channel}` : ''}. ${data.followUpTask ? 'A follow-up task has been created.' : ''}`);
    }
  };

  const handleRevise = async () => {
    const reason = window.prompt('What is changing in this revision?');
    if (reason === null) return;
    const data = await runAction('revise', `/api/quotations/${quotation.Quotation_ID}/revise`, {
      revisionReason: reason,
      lineItems: form.lineItems.filter(l => l.Item_Name)
    });
    if (data) { flash(`Revision ${data.Quote_No_Display} created.`); navigate(`/quotations/${data.Quotation_ID}`); }
  };

  const handleConvert = async (target) => {
    const path = target === 'PI'
      ? `/api/quotations/${quotation.Quotation_ID}/convert-to-pi`
      : `/api/quotations/${quotation.Quotation_ID}/convert-to-invoice`;
    const data = await runAction('convert', path);
    if (data) {
      flash(target === 'PI' ? `Proforma Invoice ${data.PI_No} created.` : `Sales Invoice ${data.invoice?.Invoice_No} created.`);
      const refreshed = await fetch(`/api/quotations/${quotation.Quotation_ID}`, { headers: authHeaders });
      if (refreshed.ok) setQuotation(await refreshed.json());
    }
  };

  const handleDownloadPdf = async () => {
    if (!pdfRef.current) return;
    setBusyAction('pdf');
    try {
      const name = safeFileName('Quotation', quotation.Quote_No_Display, quotation.Customer_Name_Snapshot);
      await downloadPdfFromElement(pdfRef.current, name, { orientation: 'portrait' });
    } catch (e) {
      flash('Could not generate the PDF.', true);
    } finally {
      setBusyAction('');
    }
  };

  const openCustomerEditor = () => {
    if (!selectedCustomer) return;
    setCustEdit({
      companyName: selectedCustomer.Company_Name || '',
      authPerson: selectedCustomer.Auth_Person || '',
      contact: String(selectedCustomer.Contact || '').replace(/^\+91\s?/, ''),
      email: selectedCustomer.Email || '',
      address: selectedCustomer.Address || '',
      gstin: selectedCustomer.GSTIN || selectedCustomer.Gst_No || '',
      stateCode: selectedCustomer.State_Code || ''
    });
  };

  const saveCustomer = async () => {
    setSavingCust(true);
    try {
      const res = await fetch(`/api/customers/${selectedCustomer.Customer_ID}`, {
        method: 'PUT', headers: authHeaders, body: JSON.stringify(custEdit)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update customer');

      // Refresh the local list so the card and the tax calculation both pick up the new GSTIN.
      const cRes = await fetch('/api/customers', { headers: authHeaders });
      if (cRes.ok) setCustomers(await cRes.json());
      setCustEdit(null);
      flash('Customer updated. Totals will re-price with the new GST details.');
      priceNow();
    } catch (e) {
      flash(e.message, true);
    } finally {
      setSavingCust(false);
    }
  };

  const copyPortalLink = () => {
    const link = `${window.location.origin}/api/quote-portal/${quotation.Portal_Guid}`;
    navigator.clipboard?.writeText(link);
    flash('Customer link copied to clipboard.');
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
    </div>;
  }

  const displayTotals = totals || quotation;
  const meta = quotation ? statusMeta(quotation.Status) : null;

  // The printed document resolves photos the same way the grid does, so a quotation saved before
  // its item had a photo still prints one.
  const printDoc = quotation && {
    ...quotation,
    Line_Items: (quotation.Line_Items || []).map(l => ({ ...l, Photo_URL: linePhoto(l) }))
  };

  const filteredCustomers = customerSearch
    ? customers.filter(c => `${c.Company_Name} ${c.Auth_Person || ''}`.toLowerCase().includes(customerSearch.toLowerCase())).slice(0, 40)
    : customers.slice(0, 40);

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-slate-100 rounded-lg">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-slate-900 truncate">
              {quotation ? quotation.Quote_No_Display : 'New Quotation'}
            </h1>
            {quotation && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                <span className="text-[11px] text-slate-500">{formatDate(quotation.Created_At)}</span>
                {quotation.Revision_No > 0 && (
                  <span className="text-[10px] font-bold text-slate-500">Rev {quotation.Revision_No}</span>
                )}
              </div>
            )}
          </div>
          {history.length > 1 && (
            <button onClick={() => setShowHistory(v => !v)}
              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5" /> {history.length} versions
            </button>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5 space-y-5">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> <span>{notice}</span>
          </div>
        )}

        {quotation?.Status === 'PendingApproval' && (
          <div className="bg-amber-50 border border-amber-200 px-4 py-3 rounded-xl text-sm flex items-center justify-between gap-3">
            <div className="flex items-start gap-2 text-amber-800">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Discount of {quotation.Effective_Discount_Pct}% exceeds the approval threshold. Admin sign-off is required before this can be sent.</span>
            </div>
            {isAdmin && (
              <button onClick={handleApprove} disabled={busyAction === 'approve'}
                className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700 shrink-0 disabled:opacity-50">
                {busyAction === 'approve' ? 'Approving…' : 'Approve'}
              </button>
            )}
          </div>
        )}

        {showHistory && (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-bold uppercase text-slate-500 mb-2">Revision history</div>
            <div className="space-y-1.5">
              {history.map(h => (
                <button key={h.Quotation_ID} onClick={() => navigate(`/quotations/${h.Quotation_ID}`)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between hover:bg-slate-50 ${h.Quotation_ID === quotation?.Quotation_ID ? 'bg-slate-100 font-bold' : ''}`}>
                  <span>{h.Quote_No_Display}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">{formatDate(h.Created_At)}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${statusMeta(h.Status).cls}`}>{statusMeta(h.Status).label}</span>
                    <span className="font-semibold text-xs">{formatMoney(h.Grand_Total)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Customer + document meta */}
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase">Customer</label>
              {readOnly ? (
                <div className="mt-1 font-semibold text-slate-800">{quotation.Customer_Name_Snapshot}</div>
              ) : (
                <>
                  <div className="relative mt-1">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
                      placeholder="Search customers…"
                      className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm" />
                  </div>
                  <select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}
                    className="w-full mt-2 px-3 py-2 border border-slate-200 rounded-lg text-sm" size={customerSearch ? 6 : 1}>
                    <option value="">— Select customer —</option>
                    {filteredCustomers.map(c => (
                      <option key={c.Customer_ID} value={c.Customer_ID}>
                        {c.Company_Name}{c.GSTIN ? ` (${c.GSTIN})` : ' (No GSTIN)'}
                      </option>
                    ))}
                  </select>
                </>
              )}

              {selectedCustomer && !readOnly && (
                /* Tap anywhere on this card to edit the customer — handy for filling in a missing
                   GSTIN without abandoning the quotation. */
                <div
                  onClick={openCustomerEditor}
                  title="Tap to edit customer details"
                  className="mt-2 text-xs text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-lg px-3 py-2 space-y-0.5 cursor-pointer border border-transparent hover:border-slate-200 transition"
                >
                  <div className="flex items-center gap-1.5 font-semibold text-slate-700">
                    <Building2 className="w-3 h-3 shrink-0" />
                    <span className="flex-1 truncate">{selectedCustomer.Company_Name}</span>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); openCustomerEditor(); }}
                      className="px-2 py-0.5 text-[10px] font-bold rounded bg-white border border-slate-200 hover:bg-slate-50 shrink-0"
                    >
                      Edit
                    </button>
                  </div>
                  {selectedCustomer.Address && <div>{selectedCustomer.Address}</div>}
                  {selectedCustomer.Email && <div>{selectedCustomer.Email}</div>}
                  {selectedCustomer.Contact && <div>{selectedCustomer.Contact}</div>}
                  <div>
                    {selectedCustomer.GSTIN
                      ? <span className="font-semibold text-emerald-700">GSTIN {selectedCustomer.GSTIN}</span>
                      : <span className="text-amber-700 font-semibold">No GSTIN on file — tap to add (treated as B2C)</span>}
                  </div>
                </div>
              )}

              {/* B2C customers have no GSTIN, so place of supply must be chosen explicitly —
                  without it the tax split can't be determined. */}
              {selectedCustomer && !selectedCustomer.GSTIN && !selectedCustomer.State_Code && !readOnly && (
                <div className="mt-2">
                  <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Place of supply</label>
                  <select
                    value={form.destinationStateCode}
                    onChange={e => setForm(f => ({ ...f, destinationStateCode: e.target.value }))}
                    className="w-full px-3 py-3 border border-slate-300 rounded-xl text-base bg-white"
                  >
                    <option value="">— Select state —</option>
                    {stateOptions().map(s => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase">Subject</label>
                <input value={form.subject} disabled={readOnly}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm disabled:bg-slate-50" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-600 uppercase">Payment terms</label>
                  <select value={form.paymentTermsId} disabled={readOnly}
                    onChange={e => setForm(f => ({ ...f, paymentTermsId: e.target.value }))}
                    className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm disabled:bg-slate-50">
                    <option value="">— Select —</option>
                    {(settings?.payment_terms || []).map(t => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-bold text-slate-600 uppercase">Follow-up</label>
                    <input type="number" min="1" value={form.followUpIntervalDays} disabled={readOnly}
                      onChange={e => setForm(f => ({ ...f, followUpIntervalDays: e.target.value }))}
                      className="w-full mt-1 px-2 py-2 border border-slate-200 rounded-lg text-sm disabled:bg-slate-50" />
                    <div className="text-[10px] text-slate-400 mt-0.5">days</div>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-600 uppercase">Expiry</label>
                    <input type="number" min="1" value={form.autoExpiryDays} disabled={readOnly}
                      onChange={e => setForm(f => ({ ...f, autoExpiryDays: e.target.value }))}
                      className="w-full mt-1 px-2 py-2 border border-slate-200 rounded-lg text-sm disabled:bg-slate-50" />
                    <div className="text-[10px] text-slate-400 mt-0.5">days</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="font-bold text-sm text-slate-700">Line Items</span>
            {!readOnly && (
              <button onClick={addLine} className="px-3 py-1.5 bg-slate-900 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 hover:bg-slate-800">
                <Plus className="w-3.5 h-3.5" /> Add item
              </button>
            )}
          </div>

          {/* MOBILE: one stacked card per line item. A 7-column table is unusable on a phone —
              it forces horizontal scrolling and the inputs become too small to tap accurately. */}
          <div className="md:hidden divide-y divide-slate-100">
            {form.lineItems.map((line, idx) => {
              const computed = displayTotals?.lineItems?.[idx] || displayTotals?.Line_Items?.[idx];
              const suggestion = line.Item_ID ? lastRates[line.Item_ID] : null;
              return (
                <div key={idx} className="p-3 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-[11px] font-bold flex items-center justify-center shrink-0 mt-1">
                      {idx + 1}
                    </span>
                    <LinePhoto src={linePhoto(line)} name={line.Item_Name} />
                    <div className="flex-1 min-w-0">
                      {readOnly ? (
                        <div className="font-semibold text-sm">{line.Item_Name}</div>
                      ) : (
                        <select value={line.Item_ID} onChange={e => pickItem(idx, e.target.value)}
                          className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-base bg-white">
                          <option value="">— Select item —</option>
                          {items.map(i => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_Name}</option>)}
                        </select>
                      )}
                    </div>
                    {!readOnly && (
                      <button onClick={() => removeLine(idx)} aria-label="Remove item"
                        className="p-2.5 text-slate-400 active:bg-rose-50 active:text-rose-600 rounded-lg shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {suggestion && !readOnly && (
                    <div className="text-[11px] text-indigo-600 bg-indigo-50 rounded-lg px-2.5 py-1.5">
                      Last quoted: {formatMoney(suggestion.rate)} on {formatDate(suggestion.quotedOn)}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <MobileNumField label="Qty" value={line.Qty} disabled={readOnly}
                      onChange={v => updateLine(idx, { Qty: v })} />
                    <MobileNumField label="Rate" value={line.Rate} disabled={readOnly}
                      onChange={v => updateLine(idx, { Rate: v })} />
                    <MobileNumField label="Discount %" value={line.Discount_Pct} disabled={readOnly}
                      onChange={v => updateLine(idx, { Discount_Pct: v })} />
                    <MobileNumField label="GST %" value={line.GST_Rate} disabled={readOnly}
                      onChange={v => updateLine(idx, { GST_Rate: v })} />
                  </div>

                  <div className="flex justify-between items-center pt-1.5 border-t border-slate-100">
                    <span className="text-[11px] font-bold uppercase text-slate-400">Line total</span>
                    <span className="font-bold text-base">{computed ? formatMoney(computed.Line_Total) : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* DESKTOP: full table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-2 text-center font-bold" style={{ width: '56px' }}>Photo</th>
                  <th className="px-3 py-2 text-left font-bold" style={{ minWidth: '220px' }}>Item</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '80px' }}>Qty</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '110px' }}>Rate</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '90px' }}>Disc %</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '80px' }}>GST %</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '120px' }}>Amount</th>
                  {!readOnly && <th style={{ width: '44px' }} />}
                </tr>
              </thead>
              <tbody>
                {form.lineItems.map((line, idx) => {
                  const computed = displayTotals?.lineItems?.[idx] || displayTotals?.Line_Items?.[idx];
                  const suggestion = line.Item_ID ? lastRates[line.Item_ID] : null;
                  return (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-2 py-2">
                        <LinePhoto src={linePhoto(line)} name={line.Item_Name} />
                      </td>
                      <td className="px-3 py-2">
                        {readOnly ? (
                          <div className="font-medium">{line.Item_Name}</div>
                        ) : (
                          <select value={line.Item_ID} onChange={e => pickItem(idx, e.target.value)}
                            className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm">
                            <option value="">— Select item —</option>
                            {items.map(i => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_Name}</option>)}
                          </select>
                        )}
                        {suggestion && !readOnly && (
                          <div className="text-[10px] text-indigo-600 mt-1">
                            Last quoted to this customer: {formatMoney(suggestion.rate)} on {formatDate(suggestion.quotedOn)}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" min="0" step="any" value={line.Qty} disabled={readOnly}
                          onChange={e => updateLine(idx, { Qty: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-right disabled:bg-slate-50" />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" min="0" step="any" value={line.Rate} disabled={readOnly}
                          onChange={e => updateLine(idx, { Rate: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-right disabled:bg-slate-50" />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" min="0" max="100" step="any" value={line.Discount_Pct} disabled={readOnly}
                          onChange={e => updateLine(idx, { Discount_Pct: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-right disabled:bg-slate-50" />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" min="0" step="any" value={line.GST_Rate} disabled={readOnly}
                          onChange={e => updateLine(idx, { GST_Rate: e.target.value })}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm text-right disabled:bg-slate-50" />
                      </td>
                      <td className="px-2 py-2 text-right font-semibold">
                        {computed ? formatMoney(computed.Line_Total) : '—'}
                      </td>
                      {!readOnly && (
                        <td className="px-2 py-2">
                          <button onClick={() => removeLine(idx)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-col md:flex-row gap-4 justify-between">
              <div className="text-xs space-y-2 md:max-w-xs w-full">
                {!readOnly && (
                  <div>
                    <label className="font-bold text-slate-600 uppercase">Additional discount %</label>
                    <input type="number" min="0" max="100" step="any" value={form.documentDiscountPct}
                      onChange={e => setForm(f => ({ ...f, documentDiscountPct: e.target.value }))}
                      className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
                  </div>
                )}
                {displayTotals?.approvalRequired && (
                  <div className="text-amber-700 font-semibold flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    Discount {displayTotals.effectiveDiscountPct}% needs Admin approval before dispatch.
                  </div>
                )}
              </div>

              <div className="w-full md:w-72 text-sm space-y-1">
                {displayTotals ? (
                  <>
                    <Row label="Taxable Value" value={formatMoney(displayTotals.Subtotal)} />
                    {Number(displayTotals.Document_Level_Discount_Amt) > 0 && (
                      <Row label="Additional Discount" value={`- ${formatMoney(displayTotals.Document_Level_Discount_Amt)}`} />
                    )}
                    {displayTotals.GST_Type === 'IGST' || displayTotals.gstType === 'IGST' ? (
                      <Row label="IGST" value={formatMoney(displayTotals.Total_IGST)} />
                    ) : (
                      <>
                        <Row label="CGST" value={formatMoney(displayTotals.Total_CGST)} />
                        <Row label="SGST" value={formatMoney(displayTotals.Total_SGST)} />
                      </>
                    )}
                    <div className="flex justify-between pt-2 mt-1 border-t-2 border-slate-300 font-extrabold text-base">
                      <span>Grand Total</span><span>{formatMoney(displayTotals.Grand_Total)}</span>
                    </div>
                  </>
                ) : (
                  <div className="text-slate-400 text-xs">Select a customer and add items to see totals.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* T&C + notes */}
        {!readOnly && (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-bold uppercase text-slate-600 mb-2">Terms &amp; Conditions</div>
            <div className="space-y-1.5">
              {(settings?.tnc_checklist || []).map(t => (
                <label key={t.id} className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-1"
                    checked={form.selectedTncIds.includes(t.id)}
                    onChange={e => setForm(f => ({
                      ...f,
                      selectedTncIds: e.target.checked
                        ? [...f.selectedTncIds, t.id]
                        : f.selectedTncIds.filter(x => x !== t.id)
                    }))} />
                  <span className="text-slate-700">{t.text}</span>
                </label>
              ))}
            </div>
            <div className="mt-3">
              <label className="text-xs font-bold uppercase text-slate-600">Notes</label>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
            </div>
          </div>
        )}
      </div>

      {/* Sticky action bar.
          On mobile only the primary action stays inline; everything else moves into a bottom sheet,
          because six side-by-side buttons cannot fit a 375px screen without wrapping into an
          unusable stack that covers the form. `pb-safe` keeps clear of the iOS home indicator. */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 z-30"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="max-w-6xl mx-auto px-3 py-2.5 flex items-center gap-2">
          {!readOnly && (
            <button onClick={handleSave} disabled={saving}
              className="flex-1 md:flex-none px-4 py-3 md:py-2 bg-slate-900 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 transition">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {quotation ? 'Save' : 'Create quotation'}
            </button>
          )}

          {quotation && isDispatchable(quotation.Status) && (
            <button onClick={() => handleDispatch()} disabled={busyAction === 'dispatch'}
              className="flex-1 md:flex-none px-4 py-3 md:py-2 bg-blue-600 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-50 transition">
              {busyAction === 'dispatch' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
          )}

          {quotation && (
            <>
              {/* Desktop: all actions visible */}
              <div className="hidden md:flex items-center gap-2">
                <ActionBtn onClick={() => setShowPreview(true)} icon={Eye} label="Preview" />
                <ActionBtn onClick={handleDownloadPdf} icon={Download} label="PDF" busy={busyAction === 'pdf'} />
                {/* Per-channel resend. Available after the first dispatch too, so a quotation can be
                    re-sent over a single channel without creating a revision. */}
                <ActionBtn
                  onClick={() => handleDispatch('Email')}
                  icon={Mail}
                  label="Email"
                  busy={busyAction === 'dispatch:Email'}
                  disabled={!quotation.Customer_Email_Snapshot}
                  title={quotation.Customer_Email_Snapshot
                    ? `Send to ${quotation.Customer_Email_Snapshot}`
                    : 'No email address on file for this customer'}
                />
                <ActionBtn
                  onClick={() => handleDispatch('WhatsApp')}
                  icon={MessageCircle}
                  label="WhatsApp"
                  busy={busyAction === 'dispatch:WhatsApp'}
                  disabled={!quotation.Customer_Contact_Snapshot}
                  title={quotation.Customer_Contact_Snapshot
                    ? `Send to ${quotation.Customer_Contact_Snapshot}`
                    : 'No mobile number on file for this customer'}
                />
                {quotation.Portal_Guid && <ActionBtn onClick={copyPortalLink} icon={Copy} label="Customer link" />}
                {canRevise(quotation.Status) && <ActionBtn onClick={handleRevise} icon={FileText} label="New revision" busy={busyAction === 'revise'} />}
                {quotation.Status === 'Accepted' && (
                  <>
                    <button onClick={() => handleConvert('PI')} disabled={busyAction === 'convert'}
                      className="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                      Convert to PI
                    </button>
                    <button onClick={() => handleConvert('INVOICE')} disabled={busyAction === 'convert'}
                      className="px-4 py-2 bg-emerald-600 text-white text-sm font-bold rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                      Convert to Invoice
                    </button>
                  </>
                )}
              </div>

              {/* Mobile: overflow menu */}
              <button onClick={() => setShowActions(true)} aria-label="More actions"
                className="md:hidden px-4 py-3 border border-slate-300 rounded-xl text-sm font-bold flex items-center gap-1.5 active:bg-slate-50">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile action sheet */}
      {showActions && quotation && (
        <div className="md:hidden fixed inset-0 bg-slate-900/50 z-50 flex items-end" onClick={() => setShowActions(false)}>
          <div className="bg-white w-full rounded-t-2xl p-3 space-y-1.5"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-2" />
            <SheetBtn icon={Eye} label="Preview document" onClick={() => { setShowActions(false); setShowPreview(true); }} />
            <SheetBtn icon={Download} label="Download PDF" onClick={() => { setShowActions(false); handleDownloadPdf(); }} />
            {quotation.Customer_Email_Snapshot && (
              <SheetBtn icon={Mail} label="Send via Email"
                onClick={() => { setShowActions(false); handleDispatch('Email'); }} />
            )}
            {quotation.Customer_Contact_Snapshot && (
              <SheetBtn icon={MessageCircle} label="Send via WhatsApp"
                onClick={() => { setShowActions(false); handleDispatch('WhatsApp'); }} />
            )}
            {quotation.Portal_Guid && (
              <SheetBtn icon={Copy} label="Copy customer link" onClick={() => { setShowActions(false); copyPortalLink(); }} />
            )}
            {canRevise(quotation.Status) && (
              <SheetBtn icon={FileText} label="Create new revision" onClick={() => { setShowActions(false); handleRevise(); }} />
            )}
            {quotation.Status === 'Accepted' && (
              <>
                <SheetBtn icon={FileText} label="Convert to Proforma Invoice" tone="indigo"
                  onClick={() => { setShowActions(false); handleConvert('PI'); }} />
                <SheetBtn icon={FileText} label="Convert to Sales Invoice" tone="emerald"
                  onClick={() => { setShowActions(false); handleConvert('INVOICE'); }} />
              </>
            )}
            <button onClick={() => setShowActions(false)}
              className="w-full mt-2 px-4 py-3 border border-slate-200 rounded-xl text-sm font-bold">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Customer quick-edit */}
      {custEdit && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-end md:items-center justify-center md:p-4" onClick={() => setCustEdit(null)}>
          <div
            className="bg-white rounded-t-2xl md:rounded-2xl p-4 md:p-5 w-full max-w-md max-h-[92vh] overflow-y-auto"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-2 md:hidden" />
            <div className="flex items-center justify-between mb-3">
              <div className="font-bold text-slate-900">Edit customer</div>
              <button onClick={() => setCustEdit(null)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <CustField label="Company name" value={custEdit.companyName} onChange={v => setCustEdit(s => ({ ...s, companyName: v }))} />
              <div className="grid grid-cols-2 gap-3">
                <CustField label="Contact person" value={custEdit.authPerson} onChange={v => setCustEdit(s => ({ ...s, authPerson: v }))} />
                <CustField label="Mobile" value={custEdit.contact} onChange={v => setCustEdit(s => ({ ...s, contact: v }))} />
              </div>
              <CustField label="Email" value={custEdit.email} onChange={v => setCustEdit(s => ({ ...s, email: v }))} />
              <CustField label="Address" value={custEdit.address} onChange={v => setCustEdit(s => ({ ...s, address: v }))} />
              <GstinInput
                gstin={custEdit.gstin}
                stateCode={custEdit.stateCode}
                onChange={({ gstin, stateCode, customerType }) =>
                  setCustEdit(s => ({ ...s, gstin, stateCode, customerType }))}
              />
              <div className="text-[11px] text-slate-500">
                Adding a GSTIN switches this customer to B2B and re-prices the quotation with the correct CGST+SGST or IGST split.
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setCustEdit(null)} className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-sm font-bold">Cancel</button>
              <button onClick={saveCustomer} disabled={savingCust}
                className="flex-1 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                {savingCust && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A4 print preview */}
      {showPreview && quotation && (
        <div className="fixed inset-0 bg-slate-900/70 z-50 overflow-auto" onClick={() => setShowPreview(false)}>
          <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-2.5 flex items-center gap-2 z-10"
            onClick={e => e.stopPropagation()}>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm truncate">{quotation.Quote_No_Display}</div>
              <div className="text-[11px] text-slate-500">A4 Portrait preview — exactly what the PDF will contain</div>
            </div>
            <button onClick={handleDownloadPdf} disabled={busyAction === 'pdf'}
              className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 disabled:opacity-50">
              {busyAction === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
            </button>
            <button onClick={() => window.print()}
              className="px-3 py-2 border border-slate-200 text-xs font-bold rounded-lg flex items-center gap-1.5 hover:bg-slate-50">
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button onClick={() => setShowPreview(false)} className="p-2 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
          </div>

          <div className="flex justify-center py-6 px-4" onClick={e => e.stopPropagation()}>
            {/* Scaled wrapper: transform doesn't affect layout size, so the outer box is sized
                manually to keep the modal's scroll height correct. */}
            <div style={{ width: 794 * previewScale, height: 1123 * previewScale }}>
              <div style={{ transform: `scale(${previewScale})`, transformOrigin: 'top left' }}>
                <div className="shadow-2xl bg-white">
                  <QuotationPdfTemplate
                    doc={printDoc}
                    docType="QUOTATION"
                    settings={settings}
                    branding={branding}
                    paymentTerm={(settings?.payment_terms || []).find(t => t.id === quotation.Payment_Terms_ID)}
                    tncItems={(settings?.tnc_checklist || []).filter(t => (quotation.Selected_TNC_IDs || []).includes(t.id))}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen PDF source */}
      {quotation && (
        <div style={{ position: 'fixed', left: '-10000px', top: 0 }} aria-hidden="true">
          <QuotationPdfTemplate
            ref={pdfRef}
            doc={printDoc}
            docType="QUOTATION"
            settings={settings}
            branding={branding}
            paymentTerm={(settings?.payment_terms || []).find(t => t.id === quotation.Payment_Terms_ID)}
            tncItems={(settings?.tnc_checklist || []).filter(t => (quotation.Selected_TNC_IDs || []).includes(t.id))}
          />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between text-slate-600">
      <span>{label}</span><span className="font-semibold text-slate-800">{value}</span>
    </div>
  );
}

/**
 * 40px product thumbnail for a line-item row. Falls back to a neutral placeholder when the item
 * has no photo, so the column keeps a constant width and rows don't jump as items are picked.
 */
function LinePhoto({ src, name }) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;

  return (
    <div className="w-10 h-10 shrink-0 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
      {showImage ? (
        <img
          src={src}
          alt={name || 'Product'}
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <ImageIcon className="w-4 h-4 text-slate-300" />
      )}
    </div>
  );
}

function ActionBtn({ onClick, icon: Icon, label, busy, disabled, title }) {
  return (
    <button onClick={onClick} disabled={busy || disabled} title={title}
      className="px-4 py-2 border border-slate-200 text-sm font-bold rounded-lg flex items-center gap-2 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed">
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />} {label}
    </button>
  );
}

/** Full-width row in the mobile action sheet — 48px tall to meet touch-target guidance. */
function SheetBtn({ icon: Icon, label, onClick, tone }) {
  const tones = {
    indigo: 'text-indigo-700 bg-indigo-50 active:bg-indigo-100',
    emerald: 'text-emerald-700 bg-emerald-50 active:bg-emerald-100'
  };
  return (
    <button onClick={onClick}
      className={`w-full px-4 py-3.5 rounded-xl text-sm font-bold flex items-center gap-3 text-left transition ${tone ? tones[tone] : 'text-slate-700 active:bg-slate-100'}`}>
      <Icon className="w-4 h-4 shrink-0" /> {label}
    </button>
  );
}

/**
 * Numeric field for the mobile line-item cards.
 * `inputMode="decimal"` brings up the numeric keypad, and the 16px base font stops iOS Safari
 * zooming the viewport when the field gains focus.
 */
function MobileNumField({ label, value, onChange, disabled }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase text-slate-400 mb-0.5">{label}</label>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-base text-right disabled:bg-slate-100"
      />
    </div>
  );
}

function CustField({ label, value, onChange, mono }) {
  return (
    <div>
      <label className="text-xs font-bold text-slate-600 uppercase">{label}</label>
      {/* text-base (16px) keeps iOS Safari from zooming the viewport on focus */}
      <input value={value ?? ''} onChange={e => onChange(e.target.value)}
        className={`w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base ${mono ? 'font-mono' : ''}`} />
    </div>
  );
}
