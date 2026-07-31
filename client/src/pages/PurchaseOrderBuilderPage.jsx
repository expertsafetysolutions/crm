import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, Save, FileText, Download, CheckCircle2,
  AlertTriangle, Loader2, Building2, Eye, X, Printer, MoreHorizontal,
  Mail, Bell, MessageSquarePlus, PackageCheck, Star, IndianRupee
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery } from '../utils/searchUtils';
import { useDocSettings } from '../context/DocSettingsContext';
import QuotationPdfTemplate from '../components/QuotationPdfTemplate';
import SmartSearchSelect from '../components/SmartSearchSelect';
import GstinInput from '../components/GstinInput';
import { downloadPdfFromElement, fetchAsBase64, safeFileName } from '../utils/pdfGenerator';
import { formatMoney, formatDate } from '../utils/quotationUtils';

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const emptyPoLine = (gstRate = 18) => ({
  itemId: '', itemName: '', hsnCode: '', unit: 'Nos',
  qty: 1, rate: '', discountPct: 0, gstRate, specification: '', remarks: ''
});

/**
 * Purchase order builder — deliberately a near-copy of QuotationBuilderPage.
 *
 * The office raises far more quotations than purchase orders, so the quotation screen is the one
 * staff have in their fingers. Giving the PO its own layout would mean learning a second screen to
 * do the same job in the other direction, which is exactly what the previous inline form on
 * PurchasePage did. Same sections in the same order, same controls, same sticky bar; only the party
 * changes from customer to vendor.
 *
 * All money math is server-side: every edit re-requests /api/purchase-orders/preview, so the totals
 * on screen are the same figures that will be saved and printed.
 */
export default function PurchaseOrderBuilderPage() {
  const { poId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token, user, canSeeMoney } = useAuth();
  const { docSettings } = useDocSettings();

  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';
  const pdfRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [settings, setSettings] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [items, setItems] = useState([]);
  const [branding, setBranding] = useState({});

  const [po, setPo] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showActions, setShowActions] = useState(false);
  // Inline vendor editor, so a missing GSTIN can be fixed without leaving the order.
  const [vendEdit, setVendEdit] = useState(null);
  const [savingVend, setSavingVend] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [perms, setPerms] = useState(null);
  const [itemCreate, setItemCreate] = useState(null);
  const [savingItem, setSavingItem] = useState(false);
  // Receive/pay-on-save panel: only offered while creating, mirroring the old inline form.
  const [instant, setInstant] = useState({
    markReceived: false, vendorInvoiceNo: '', vendorInvoiceAmount: '', totalCharges: '',
    rating: 5, grnNotes: '', receiptDate: istToday(),
    markPaid: false, paymentNote: '', paidAmount: ''
  });

  const [form, setForm] = useState({
    vendorId: searchParams.get('vendorId') || '',
    poNo: '',
    poDate: istToday(),
    expectedDate: '',
    subject: '',
    notes: '',
    paymentTermsId: '',
    paymentTerms: '',
    selectedTncIds: [],
    // Same rule as the quotation: exactly one of pct/amt is ever sent, because the server lets a
    // pct > 0 win and would silently discard a rupee figure typed alongside it.
    discountMode: 'PCT',
    documentDiscountPct: 0,
    documentDiscountAmt: 0,
    lines: [emptyPoLine()]
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
        const [sRes, vRes, iRes, pRes] = await Promise.all([
          fetch('/api/quotation-settings', { headers: authHeaders }),
          fetch('/api/vendors', { headers: authHeaders }),
          fetch('/api/items', { headers: authHeaders }),
          fetch('/api/my-permissions', { headers: authHeaders })
        ]);
        if (cancelled) return;

        const s = sRes.ok ? await sRes.json() : null;
        const v = vRes.ok ? await vRes.json() : [];
        const i = iRes.ok ? await iRes.json() : [];
        const p = pRes.ok ? (await pRes.json()).permissions : null;

        setSettings(s);
        setVendors(Array.isArray(v) ? v : []);
        setItems((Array.isArray(i) ? i : []).filter(x => x.Active !== false));
        setPerms(p);

        // Only tick default T&C on a NEW order — an existing one keeps what it was issued with.
        if (s && !poId) {
          setForm(f => ({
            ...f,
            selectedTncIds: f.selectedTncIds.length
              ? f.selectedTncIds
              : (s.tnc_checklist || []).filter(t => t.default_checked).map(t => t.id)
          }));
        }
      } catch (e) {
        if (!cancelled) setError('Could not load purchase settings or master data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authHeaders, poId]);

  // ---- load an existing purchase order ----
  useEffect(() => {
    if (!poId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/purchase-orders/${poId}`, { headers: authHeaders });
        if (!res.ok) throw new Error('Purchase order not found');
        const p = await res.json();
        if (cancelled) return;
        setPo(p);
        setForm(f => ({
          ...f,
          vendorId: p.Vendor_ID,
          poNo: p.PO_No || '',
          poDate: p.PO_Date || istToday(),
          expectedDate: p.Expected_Date || '',
          subject: p.Subject || '',
          notes: p.Notes || '',
          paymentTermsId: p.Payment_Terms_ID || '',
          paymentTerms: p.Payment_Terms || '',
          selectedTncIds: p.Selected_TNC_IDs || [],
          discountMode: (!Number(p.Document_Level_Discount_Pct) && Number(p.Document_Level_Discount_Amt) > 0)
            ? 'AMT' : 'PCT',
          documentDiscountPct: p.Document_Level_Discount_Pct || 0,
          documentDiscountAmt: p.Document_Level_Discount_Amt || 0,
          lines: (p.Lines || []).length
            ? p.Lines.map(l => ({
                lineId: l.lineId,
                itemId: l.Item_ID || '',
                itemName: l.Item_Name || '',
                hsnCode: l.HSN_Code || '',
                unit: l.Unit || 'Nos',
                qty: l.Qty,
                rate: l.Rate,
                discountPct: l.Discount_Pct || 0,
                gstRate: l.GST_Rate,
                specification: l.Specification || '',
                remarks: l.Remarks || '',
                Received_Qty: l.Received_Qty || 0
              }))
            : [emptyPoLine()]
        }));
        setTotals(p);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [poId, authHeaders]);

  // ---- branding assets, inlined as base64 for html2canvas ----
  useEffect(() => {
    const assets = docSettings?.branding_assets;
    if (!assets) return;
    let cancelled = false;
    (async () => {
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

  useEffect(() => {
    if (!showPreview) return;
    const fit = () => setPreviewScale(Math.min((window.innerWidth - 64) / 794, 1));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [showPreview]);

  const selectedVendor = vendors.find(v => v.Vendor_ID === form.vendorId);
  // Goods already received freeze the order: the shelf and the ledger have to keep agreeing.
  const readOnly = po ? ['Received', 'Cancelled'].includes(po.Status) : false;

  const discountFields = useMemo(() => (
    form.discountMode === 'AMT'
      ? { documentDiscountPct: 0, documentDiscountAmt: Number(form.documentDiscountAmt) || 0 }
      : { documentDiscountPct: Number(form.documentDiscountPct) || 0, documentDiscountAmt: 0 }
  ), [form.discountMode, form.documentDiscountPct, form.documentDiscountAmt]);

  const payloadLines = useCallback(() => form.lines
    .filter(l => String(l.itemName || '').trim() && Number(l.qty) > 0)
    .map(l => ({
      lineId: l.lineId || undefined,
      itemId: l.itemId || '',
      itemName: l.itemName,
      hsnCode: l.hsnCode || '',
      specification: l.specification || '',
      remarks: l.remarks || '',
      qty: Number(l.qty) || 0,
      unit: l.unit || 'Nos',
      rate: Number(l.rate) || 0,
      discountPct: Number(l.discountPct) || 0,
      gstRate: Number(l.gstRate) || 0,
      Received_Qty: l.Received_Qty || 0
    })), [form.lines]);

  // ---- live server-side pricing (debounced) ----
  const priceNow = useCallback(async () => {
    const valid = payloadLines();
    if (!form.vendorId || valid.length === 0) { setTotals(null); return; }
    try {
      const res = await fetch('/api/purchase-orders/preview', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ vendorId: form.vendorId, lines: valid, ...discountFields })
      });
      if (res.ok) setTotals(await res.json());
    } catch (e) { /* keep last good totals */ }
  }, [form.vendorId, payloadLines, discountFields, authHeaders]);

  useEffect(() => {
    if (readOnly) return;
    const t = setTimeout(priceNow, 400);
    return () => clearTimeout(t);
  }, [priceNow, readOnly]);

  // ---- line helpers ----
  const updateLine = (idx, patch) => {
    setForm(f => {
      // An index past the end means a just-created item is landing on a row appended in the same
      // tick (see openItemCreate) — .map alone would drop the patch on the floor.
      const base = idx < f.lines.length ? f.lines : [...f.lines, emptyPoLine()];
      return { ...f, lines: base.map((l, i) => (i === idx ? { ...l, ...patch } : l)) };
    });
  };

  /**
   * Copies a catalogue item onto a line. Takes the item OBJECT, not an id, so a freshly-created
   * item can be applied straight from the POST response — resolving by id right after setItems()
   * would read the pre-update `items` closure and blank the line instead of filling it.
   *
   * The rate suggested is the last PURCHASE rate, not the selling rate: this is what we pay.
   */
  const applyItemToLine = (idx, item) => {
    if (!item) { updateLine(idx, { itemId: '', itemName: '' }); return; }
    if (typeof item === 'string') { updateLine(idx, { itemId: '', itemName: item }); return; }
    updateLine(idx, {
      itemId: item.Item_ID,
      itemName: item.Item_Name,
      hsnCode: item.HSN_Code || '',
      unit: item.Unit || 'Nos',
      gstRate: Number(item.Default_GST_Rate) || settings?.defaults?.default_gst_rate || 18,
      rate: item.Last_Purchase_Rate || item.Purchase_Rate || item.Moving_Avg_Cost || ''
    });
  };

  const openItemCreate = (idx) => setItemCreate({
    idx: idx ?? (() => {
      const empty = form.lines.findIndex(l => !l.itemName);
      return empty !== -1 ? empty : form.lines.length;
    })(),
    itemName: '',
    unit: 'Nos',
    standardRate: '',
    defaultGstRate: settings?.defaults?.default_gst_rate ?? 18,
    hsnCode: '',
    category: ''
  });

  const saveNewItem = async () => {
    if (!String(itemCreate.itemName || '').trim()) return flash('Enter an item name.', true);
    setSavingItem(true);
    try {
      const { idx, ...body } = itemCreate;
      const res = await fetch('/api/items', {
        method: 'POST', headers: authHeaders, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the item');

      setItems(list => [...list, data]);
      applyItemToLine(idx, data);
      setItemCreate(null);
      flash(`${data.Item_Name} added to the catalogue.`);
    } catch (e) {
      flash(e.message, true);
    } finally {
      setSavingItem(false);
    }
  };

  const addLine = () => setForm(f => ({
    ...f, lines: [...f.lines, emptyPoLine(settings?.defaults?.default_gst_rate || 18)]
  }));

  const removeLine = (idx) => setForm(f => ({
    ...f, lines: f.lines.length === 1 ? [emptyPoLine()] : f.lines.filter((_, i) => i !== idx)
  }));

  // ---- actions ----
  const flash = (msg, isError = false) => {
    if (isError) { setError(msg); setNotice(''); } else { setNotice(msg); setError(''); }
    setTimeout(() => { setNotice(''); setError(''); }, 6000);
  };

  const payload = () => ({
    vendorId: form.vendorId,
    poNo: form.poNo || undefined,
    poDate: form.poDate,
    expectedDate: form.expectedDate,
    subject: form.subject,
    notes: form.notes,
    paymentTermsId: form.paymentTermsId,
    paymentTerms: form.paymentTerms,
    selectedTncIds: form.selectedTncIds,
    ...discountFields,
    lines: payloadLines()
  });

  const handleSave = async () => {
    if (!form.vendorId) return flash('Select a vendor first.', true);
    if (payload().lines.length === 0) return flash('Add at least one line item.', true);

    setSaving(true);
    try {
      const url = po ? `/api/purchase-orders/${po.PO_ID}` : '/api/purchase-orders';
      const res = await fetch(url, {
        method: po ? 'PUT' : 'POST', headers: authHeaders, body: JSON.stringify(payload())
      });
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error || 'Save failed');

      let msg = po ? `Purchase order ${saved.PO_No} updated.` : `Purchase order ${saved.PO_No} created.`;

      // Receive-and-pay on save, offered only while creating — the same shortcut the old inline
      // form had, for a cash purchase that is already in the van by the time it is typed in.
      if (!po && instant.markReceived) {
        const grnRes = await fetch('/api/grns', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            poId: saved.PO_ID,
            lines: (saved.Lines || []).map(l => ({ lineId: l.lineId, receivedQty: l.Qty })),
            totalCharges: Number(instant.totalCharges) || 0,
            vendorInvoiceNo: instant.vendorInvoiceNo,
            vendorInvoiceAmount: Number(instant.vendorInvoiceAmount) || 0,
            vendorRating: Number(instant.rating) || 5,
            receiptDate: instant.receiptDate || form.poDate,
            notes: instant.grnNotes || 'Auto-received on PO creation'
          })
        });
        const grn = await grnRes.json();
        if (!grnRes.ok) throw new Error(grn.error || 'Order saved but the goods receipt failed');
        msg += ' Goods received.';

        if (instant.markPaid) {
          const payRes = await fetch(`/api/purchase-orders/${saved.PO_ID}/release-payment`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              note: instant.paymentNote || 'Paid on purchase',
              paidAmount: Number(instant.paidAmount) || saved.Grand_Total || saved.Subtotal
            })
          });
          const pay = await payRes.json();
          if (!payRes.ok) throw new Error(pay.error || 'Order saved and received, but the payment release failed');
          msg += ' Payment recorded.';
        }
      }

      setPo(saved);
      setTotals(saved);
      flash(msg);
      if (!po) navigate(`/purchase-orders/${saved.PO_ID}`, { replace: true });
    } catch (e) {
      flash(e.message, true);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (action, path, body, method = 'POST') => {
    setBusyAction(action);
    try {
      const res = await fetch(path, { method, headers: authHeaders, body: JSON.stringify(body || {}) });
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

  /**
   * Renders the on-screen PDF template to base64 for emailing, so the vendor receives the same
   * document the buyer previewed. Waits for images to decode and the frame to settle first —
   * capturing before both would yield a blank or half-drawn canvas.
   */
  const buildPoPdfAttachment = async () => {
    if (!pdfRef.current) throw new Error('The purchase order preview has not finished rendering yet.');
    const node = pdfRef.current;
    await Promise.all(
      Array.from(node.querySelectorAll('img')).map(img => (
        img.complete && img.naturalWidth > 0
          ? Promise.resolve()
          : new Promise(resolve => { img.onload = img.onerror = resolve; })
      ))
    );
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const { generatePdfFromElement } = await import('../utils/pdfGenerator');
    const pdf = await generatePdfFromElement(node, { orientation: 'portrait' });
    // 'datauristring' — jsPDF's output() has no "base64" case; an unrecognised type returns null.
    const base64 = String(pdf.output('datauristring') || '').split('base64,').pop() || '';
    if (!base64) throw new Error('The generated PDF was empty.');

    return {
      fileName: `${safeFileName('PO', po.PO_No, po.Vendor_Name)}.pdf`,
      mimeType: 'application/pdf',
      base64
    };
  };

  const handleSendEmail = async () => {
    setBusyAction('email');
    let inlineAttachments;
    try {
      inlineAttachments = [await buildPoPdfAttachment()];
    } catch (e) {
      // The PDF is the deliverable — a failed render aborts the send rather than mailing a vendor
      // an order with nothing attached to supply against.
      setBusyAction('');
      return flash(`Could not attach the purchase order PDF, so nothing was sent: ${e.message}`, true);
    }
    const data = await runAction('email', `/api/purchase-orders/${po.PO_ID}/dispatch`, { inlineAttachments });
    if (data) flash('Purchase order emailed to the supplier.');
  };

  const handleSendReminder = async () => {
    const data = await runAction('reminder', `/api/purchase-orders/${po.PO_ID}/reminder`);
    if (data) flash('Reminder emailed to the supplier.');
  };

  const handleCancel = async () => {
    const reason = window.prompt('Why is this purchase order being cancelled?');
    if (reason === null) return;
    if (!reason.trim()) return flash('A reason is required to cancel a purchase order.', true);
    const data = await runAction('cancel', `/api/purchase-orders/${po.PO_ID}/cancel`, { reason });
    if (data) {
      flash(`Purchase order ${po.PO_No} has been cancelled.`);
      const refreshed = await fetch(`/api/purchase-orders/${po.PO_ID}`, { headers: authHeaders });
      if (refreshed.ok) setPo(await refreshed.json());
    }
  };

  const handleDownloadPdf = async () => {
    if (!pdfRef.current) return;
    setBusyAction('pdf');
    try {
      await downloadPdfFromElement(pdfRef.current, safeFileName('PO', po.PO_No, po.Vendor_Name), { orientation: 'portrait' });
    } catch (e) {
      flash('Could not generate the PDF.', true);
    } finally {
      setBusyAction('');
    }
  };

  const openVendorCreate = () => setVendEdit({
    mode: 'create', vendorName: '', contactPerson: '', phone: '', email: '',
    address: '', gstin: '', paymentTerms: '', leadTimeDays: 0
  });

  const openVendorEditor = () => {
    if (!selectedVendor) return;
    setVendEdit({
      mode: 'edit',
      vendorName: selectedVendor.Vendor_Name || '',
      contactPerson: selectedVendor.Contact_Person || '',
      phone: String(selectedVendor.Phone || '').replace(/^\+91\s?/, ''),
      email: selectedVendor.Email || '',
      address: selectedVendor.Address || '',
      gstin: selectedVendor.GSTIN || '',
      paymentTerms: selectedVendor.Payment_Terms || '',
      leadTimeDays: selectedVendor.Lead_Time_Days || 0
    });
  };

  const saveVendor = async () => {
    const isCreate = vendEdit.mode === 'create';
    if (isCreate && !String(vendEdit.vendorName || '').trim()) {
      return flash('Enter a name for the new vendor.', true);
    }

    setSavingVend(true);
    try {
      const { mode, ...body } = vendEdit;
      const res = await fetch(
        isCreate ? '/api/vendors' : `/api/vendors/${selectedVendor.Vendor_ID}`,
        { method: isCreate ? 'POST' : 'PUT', headers: authHeaders, body: JSON.stringify(body) }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Could not ${isCreate ? 'create' : 'update'} vendor`);

      const vRes = await fetch('/api/vendors', { headers: authHeaders });
      if (vRes.ok) setVendors(await vRes.json());
      setVendEdit(null);

      if (isCreate) {
        setForm(f => ({ ...f, vendorId: data.Vendor_ID }));
        flash(`Vendor ${data.Vendor_Name} created and selected.`);
      } else {
        // A GSTIN change flips the CGST/SGST vs IGST split, so re-price immediately.
        flash('Vendor updated. Totals will re-price with the new GST details.');
        priceNow();
      }
    } catch (e) {
      flash(e.message, true);
    } finally {
      setSavingVend(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
    </div>;
  }

  const displayTotals = totals || po;
  // Money is stripped server-side for anyone without finance:view; this only decides whether the
  // columns are drawn, so a store-keeper raising an order sees quantities and nothing else.
  const showMoney = canSeeMoney;
  const canAddItem = isAdmin || Boolean(perms?.inventory?.add);
  const canEditPo = isAdmin || Boolean(perms?.purchase?.edit);

  return (
    <div className="qt-theme min-h-screen bg-slate-50 pb-24">
      <div className="qt-appbar sticky top-0 z-30 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 py-3 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="qt-appbar-btn" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-[17px] truncate">
              {po ? po.PO_No : 'Create Purchase Order'}
            </h1>
            {po && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/20 text-white">{po.Status}</span>
                <span className="text-[11px] text-white/80">{formatDate(po.PO_Date)}</span>
              </div>
            )}
          </div>
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

        {readOnly && (
          <div className="bg-slate-100 border border-slate-200 px-4 py-3 rounded-xl text-sm text-slate-600 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {po.Status === 'Cancelled'
                ? `This order was cancelled${po.Cancel_Reason ? `: ${po.Cancel_Reason}` : ''}.`
                : 'Goods have been fully received against this order, so it can no longer be edited.'}
            </span>
          </div>
        )}

        {/* Vendor + document meta */}
        <div className="qt-card">
          <div className="grid md:grid-cols-2 gap-5">
            <div>
              {readOnly ? (
                <>
                  <div className="qt-section-label">Supplier</div>
                  <div className="mt-1 font-semibold text-slate-800">{po.Vendor_Name}</div>
                </>
              ) : (
                <div className="mt-1 flex items-start gap-2">
                  <SmartSearchSelect
                    className="flex-1 min-w-0"
                    label="Supplier"
                    placeholder="Search name, phone, GSTIN…"
                    options={vendors}
                    value={selectedVendor || null}
                    onChange={v => setForm(f => ({
                      ...f,
                      vendorId: v?.Vendor_ID || '',
                      // The vendor's own terms are the sensible default, but only fill an empty
                      // box — never overwrite what the buyer has already typed for this order.
                      paymentTerms: f.paymentTerms || v?.Payment_Terms || ''
                    }))}
                    getKey={v => v.Vendor_ID}
                    getLabel={v => v.Vendor_Name}
                    getSubtitle={v => [
                      v.GSTIN ? `GSTIN ${v.GSTIN}` : 'No GSTIN',
                      v.Phone,
                      v.Address
                    ].filter(Boolean).join(' · ')}
                    getSearchable={v => [v.Vendor_Name, v.Contact_Person, v.Phone, v.Email, v.Address, v.GSTIN]}
                    emptyText="No vendor matches that."
                  />
                  {/* Alone on its line, so it earns the full 48px target rather than a toolbar 32px. */}
                  <button
                    type="button"
                    onClick={openVendorCreate}
                    title="Add a new vendor"
                    aria-label="Add a new vendor"
                    className="mt-[15px] w-12 h-12 shrink-0 rounded-xl border border-slate-300 flex items-center justify-center text-slate-600 hover:bg-slate-50 active:bg-slate-100 transition"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </div>
              )}

              {selectedVendor && !readOnly && (
                <div
                  onClick={openVendorEditor}
                  title="Tap to edit vendor details"
                  className="mt-2 text-xs text-slate-600 bg-slate-50 hover:bg-slate-100 rounded-lg px-3 py-2 space-y-0.5 cursor-pointer border border-transparent hover:border-slate-200 transition"
                >
                  <div className="flex items-center gap-1.5 font-semibold text-slate-700">
                    <Building2 className="w-3 h-3 shrink-0" />
                    <span className="flex-1 truncate">{selectedVendor.Vendor_Name}</span>
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); openVendorEditor(); }}
                      className="px-2 py-0.5 text-[10px] font-bold rounded bg-white border border-slate-200 hover:bg-slate-50 shrink-0"
                    >
                      Edit
                    </button>
                  </div>
                  {selectedVendor.Address && <div>{selectedVendor.Address}</div>}
                  {selectedVendor.Email && <div>{selectedVendor.Email}</div>}
                  {selectedVendor.Phone && <div>{selectedVendor.Phone}</div>}
                  <div>
                    {selectedVendor.GSTIN
                      ? <span className="font-semibold text-emerald-700">GSTIN {selectedVendor.GSTIN}</span>
                      : <span className="text-amber-700 font-semibold">No GSTIN on file — tap to add</span>}
                  </div>
                  {displayTotals?.GST_Type && (
                    <div className="text-slate-500">
                      Supply type: <span className="font-semibold text-slate-700">
                        {displayTotals.GST_Type === 'IGST' ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}
                      </span>
                    </div>
                  )}
                  {selectedVendor.Lead_Time_Days > 0 && (
                    <div className="text-slate-500">Usual lead time: {selectedVendor.Lead_Time_Days} days</div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-4">
              <SubjectCombo
                value={form.subject}
                disabled={readOnly}
                options={settings?.subject_options || []}
                onChange={v => setForm(f => ({ ...f, subject: v }))}
              />
              <div className="qt-field">
                <select value={form.paymentTermsId} disabled={readOnly}
                  onChange={e => {
                    const picked = (settings?.payment_terms || []).find(t => t.id === e.target.value);
                    setForm(f => ({
                      ...f,
                      paymentTermsId: e.target.value,
                      // The label is stored alongside the id so the PDF still reads correctly if
                      // the settings row is later renamed or deleted.
                      paymentTerms: picked ? picked.label : f.paymentTerms
                    }));
                  }}
                  className="qt-select">
                  <option value="">— Select —</option>
                  {(settings?.payment_terms || []).map(t => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <label>Payment terms</label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="qt-field">
                  <input type="date" value={form.poDate} disabled={readOnly} placeholder=" "
                    onChange={e => setForm(f => ({ ...f, poDate: e.target.value }))}
                    className="qt-input" />
                  <label>PO date</label>
                </div>
                <div className="qt-field">
                  <input type="date" value={form.expectedDate} disabled={readOnly} placeholder=" "
                    onChange={e => setForm(f => ({ ...f, expectedDate: e.target.value }))}
                    className="qt-input" />
                  <label>Expected by</label>
                </div>
              </div>
              {/* Only offered while creating: the number is issued once and a PO already sent to a
                  vendor must keep the number they are quoting back at us. */}
              {!po && (
                <div className="qt-field">
                  <input value={form.poNo} placeholder=" "
                    onChange={e => setForm(f => ({ ...f, poNo: e.target.value }))}
                    className="qt-input" />
                  <label>PO number (leave blank to auto-generate)</label>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <span className="qt-section-label">Items</span>
            {!readOnly && canAddItem && (
              <button onClick={() => openItemCreate()}
                className="qt-btn qt-btn-outline text-xs py-2 px-3.5">
                <Plus className="w-3.5 h-3.5" /> NEW ITEM
              </button>
            )}
          </div>

          {/* MOBILE: one stacked card per line. A 7-column table forces horizontal scrolling on a
              phone and shrinks the inputs below a tappable size. */}
          <div className="md:hidden divide-y divide-slate-100">
            {form.lines.map((line, idx) => {
              const computed = displayTotals?.lineItems?.[idx] || displayTotals?.Lines?.[idx];
              return (
                <div key={idx} className="p-3 space-y-2.5">
                  <div className="flex items-start gap-2">
                    <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-500 text-[11px] font-bold flex items-center justify-center shrink-0 mt-1">
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      {readOnly ? (
                        <div className="font-semibold text-sm">{line.itemName}</div>
                      ) : (
                        <ItemPicker items={items} line={line} onPick={item => applyItemToLine(idx, item)} />
                      )}
                    </div>
                    {!readOnly && (
                      <button onClick={() => removeLine(idx)} aria-label="Remove item"
                        className="p-2.5 text-slate-400 active:bg-rose-50 active:text-rose-600 rounded-lg shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {Number(line.Received_Qty) > 0 && (
                    <div className="text-[11px] text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5">
                      {line.Received_Qty} already received against this line.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <MobileNumField label="Qty" value={line.qty} disabled={readOnly}
                      onChange={v => updateLine(idx, { qty: v })} />
                    <MobileTextField label="Unit" value={line.unit} disabled={readOnly}
                      onChange={v => updateLine(idx, { unit: v })} />
                    {showMoney && (
                      <>
                        <MobileNumField label="Rate" value={line.rate} disabled={readOnly}
                          onChange={v => updateLine(idx, { rate: v })} />
                        <MobileNumField label="Discount %" value={line.discountPct} disabled={readOnly}
                          onChange={v => updateLine(idx, { discountPct: v })} />
                        <MobileNumField label="GST %" value={line.gstRate} disabled={readOnly}
                          onChange={v => updateLine(idx, { gstRate: v })} />
                      </>
                    )}
                    <MobileTextField label="HSN" value={line.hsnCode} disabled={readOnly}
                      onChange={v => updateLine(idx, { hsnCode: v })} />
                  </div>

                  <LineRemarks
                    value={line.specification}
                    readOnly={readOnly}
                    label="Specification"
                    placeholder="Specification — prints under this item on the PDF"
                    onChange={v => updateLine(idx, { specification: v })}
                  />

                  {showMoney && (
                    <div className="flex justify-between items-center pt-1.5 border-t border-slate-100">
                      <span className="text-[11px] font-bold uppercase text-slate-400">Line total</span>
                      <span className="font-bold text-base">{computed ? formatMoney(computed.Line_Total) : '—'}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* DESKTOP: full table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-bold" style={{ minWidth: '220px' }}>Item</th>
                  <th className="px-2 py-2 text-center font-bold" style={{ width: '90px' }}>HSN</th>
                  <th className="px-2 py-2 text-right font-bold" style={{ width: '80px' }}>Qty</th>
                  <th className="px-2 py-2 text-center font-bold" style={{ width: '70px' }}>Unit</th>
                  {showMoney && <th className="px-2 py-2 text-right font-bold" style={{ width: '110px' }}>Rate</th>}
                  {showMoney && <th className="px-2 py-2 text-right font-bold" style={{ width: '90px' }}>Disc %</th>}
                  {showMoney && <th className="px-2 py-2 text-right font-bold" style={{ width: '80px' }}>GST %</th>}
                  {showMoney && <th className="px-2 py-2 text-right font-bold" style={{ width: '120px' }}>Amount</th>}
                  {!readOnly && <th style={{ width: '44px' }} />}
                </tr>
              </thead>
              <tbody>
                {form.lines.map((line, idx) => {
                  const computed = displayTotals?.lineItems?.[idx] || displayTotals?.Lines?.[idx];
                  return (
                    <tr key={idx} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        {readOnly ? (
                          <div className="font-medium">{line.itemName}</div>
                        ) : (
                          <ItemPicker items={items} line={line} onPick={item => applyItemToLine(idx, item)} />
                        )}
                        {Number(line.Received_Qty) > 0 && (
                          <div className="text-[10px] text-emerald-700 mt-1">
                            {line.Received_Qty} already received
                          </div>
                        )}
                        <LineRemarks
                          value={line.specification}
                          readOnly={readOnly}
                          label="Specification"
                          placeholder="Specification — prints under this item on the PDF"
                          onChange={v => updateLine(idx, { specification: v })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input value={line.hsnCode || ''} disabled={readOnly}
                          onChange={e => updateLine(idx, { hsnCode: e.target.value })}
                          className="qt-cell text-center" />
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" min="0" step="any" value={line.qty} disabled={readOnly}
                          onChange={e => updateLine(idx, { qty: e.target.value })}
                          className="qt-cell text-right" />
                      </td>
                      <td className="px-2 py-2">
                        <input value={line.unit || ''} disabled={readOnly}
                          onChange={e => updateLine(idx, { unit: e.target.value })}
                          className="qt-cell text-center" />
                      </td>
                      {showMoney && (
                        <>
                          <td className="px-2 py-2">
                            <input type="number" min="0" step="any" value={line.rate} disabled={readOnly}
                              onChange={e => updateLine(idx, { rate: e.target.value })}
                              className="qt-cell text-right" />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" min="0" max="100" step="any" value={line.discountPct} disabled={readOnly}
                              onChange={e => updateLine(idx, { discountPct: e.target.value })}
                              className="qt-cell text-right" />
                          </td>
                          <td className="px-2 py-2">
                            <input type="number" min="0" step="any" value={line.gstRate} disabled={readOnly}
                              onChange={e => updateLine(idx, { gstRate: e.target.value })}
                              className="qt-cell text-right" />
                          </td>
                          <td className="px-2 py-2 text-right font-semibold">
                            {computed ? formatMoney(computed.Line_Total) : '—'}
                          </td>
                        </>
                      )}
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

          {/* Adds the next line where the eye already is — directly under the last row. */}
          {!readOnly && (
            <div className="border-t border-slate-100 p-3">
              <button
                onClick={addLine}
                className="w-full min-h-[48px] rounded-xl border border-dashed border-slate-300 text-xs font-extrabold uppercase tracking-wide text-slate-600 flex items-center justify-center gap-2 hover:bg-slate-50 active:bg-slate-100 transition"
              >
                <Plus className="w-4 h-4" /> ADD ITEM
              </button>
            </div>
          )}

          {/* Totals */}
          {showMoney && (
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex flex-col md:flex-row gap-4 justify-between">
                <div className="text-xs space-y-2 md:max-w-xs w-full">
                  {!readOnly && (
                    <div>
                      <div className="qt-section-label mb-1.5">Additional discount</div>
                      {/* Switching mode zeroes the other field rather than keeping it hidden-but-set:
                          a stale pct left behind would win at the server and quietly override the
                          rupee figure the user typed. */}
                      <div className="flex gap-1 p-1 bg-slate-200/70 rounded-xl mb-2">
                        {[['PCT', 'PERCENT %'], ['AMT', 'AMOUNT ₹']].map(([mode, text]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setForm(f => ({
                              ...f,
                              discountMode: mode,
                              documentDiscountPct: mode === 'PCT' ? f.documentDiscountPct : 0,
                              documentDiscountAmt: mode === 'AMT' ? f.documentDiscountAmt : 0
                            }))}
                            className={`flex-1 min-h-[36px] rounded-lg text-[11px] font-extrabold tracking-wide transition ${
                              form.discountMode === mode
                                ? 'bg-white text-slate-900 shadow-sm'
                                : 'text-slate-500 active:bg-white/50'
                            }`}
                          >
                            {text}
                          </button>
                        ))}
                      </div>
                      {form.discountMode === 'AMT' ? (
                        <div className="qt-field">
                          <input type="number" inputMode="decimal" min="0" step="any" placeholder=" "
                            value={form.documentDiscountAmt}
                            onChange={e => setForm(f => ({ ...f, documentDiscountAmt: e.target.value }))}
                            className="qt-input" />
                          <label>Discount amount (₹)</label>
                        </div>
                      ) : (
                        <div className="qt-field">
                          <input type="number" inputMode="decimal" min="0" max="100" step="any" placeholder=" "
                            value={form.documentDiscountPct}
                            onChange={e => setForm(f => ({ ...f, documentDiscountPct: e.target.value }))}
                            className="qt-input" />
                          <label>Discount percent (%)</label>
                        </div>
                      )}
                      {/* The server caps the deduction at the taxable value, so a too-large amount is
                          silently reduced — say so instead of letting the total look wrong. */}
                      {form.discountMode === 'AMT'
                        && Number(form.documentDiscountAmt) > 0
                        && Number(displayTotals?.Document_Level_Discount_Amt) > 0
                        && Number(displayTotals.Document_Level_Discount_Amt) < Number(form.documentDiscountAmt) && (
                        <div className="text-[11px] text-amber-700 mt-1">
                          Capped at {formatMoney(displayTotals.Document_Level_Discount_Amt)} — a discount cannot exceed the item value.
                        </div>
                      )}
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
                      {displayTotals.GST_Type === 'IGST' ? (
                        <Row label="IGST" value={formatMoney(displayTotals.Total_IGST)} />
                      ) : (
                        <>
                          <Row label="CGST" value={formatMoney(displayTotals.Total_CGST)} />
                          <Row label="SGST" value={formatMoney(displayTotals.Total_SGST)} />
                        </>
                      )}
                      {/* Echoes the PDF's red grand-total band so the figure the buyer confirms on
                          screen is the one they recognise on the document. */}
                      <div className="flex justify-between pt-2 mt-1 border-t-2 border-slate-300 font-extrabold text-base text-rose-600">
                        <span>Grand Total</span><span>{formatMoney(displayTotals.Grand_Total)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="text-slate-400 text-xs">Select a vendor and add items to see totals.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* T&C + notes */}
        {!readOnly && (
          <div className="qt-card">
            <div className="qt-section-label mb-2.5">Terms &amp; Conditions</div>
            <div className="space-y-1">
              {(settings?.tnc_checklist || []).map(t => (
                <label key={t.id} className="flex items-start gap-2.5 text-sm cursor-pointer px-2 py-1.5 -mx-2 rounded-lg hover:bg-slate-50">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0"
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
              {(settings?.tnc_checklist || []).length === 0 && (
                <p className="text-xs text-slate-400">
                  No terms configured yet — an Admin can add them in Quotation Settings.
                </p>
              )}
            </div>
            <div className="qt-field mt-4">
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                rows={2} placeholder=" " className="qt-textarea" />
              <label>Notes</label>
            </div>
          </div>
        )}

        {/* Receive / pay on save — creation only. An existing order is received from the Receive tab,
            where partial deliveries can be entered line by line. */}
        {!po && !readOnly && (
          <div className="qt-card space-y-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 shrink-0"
                checked={instant.markReceived}
                onChange={e => setInstant(s => ({
                  ...s, markReceived: e.target.checked, markPaid: e.target.checked ? s.markPaid : false
                }))} />
              <span className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                <PackageCheck className="w-4 h-4 text-slate-400" /> Goods already received
              </span>
            </label>

            {instant.markReceived && (
              <div className="pl-6 space-y-3 border-l-2 border-slate-100">
                <p className="text-[11px] text-slate-500">
                  Receives the full ordered quantity and moves stock. For a part delivery, save the
                  order and use the Receive tab instead.
                </p>
                <div className="grid md:grid-cols-2 gap-3">
                  <PlainField label="Vendor invoice no" value={instant.vendorInvoiceNo}
                    onChange={v => setInstant(s => ({ ...s, vendorInvoiceNo: v }))} />
                  <div className="qt-field">
                    <input type="date" value={instant.receiptDate} placeholder=" "
                      onChange={e => setInstant(s => ({ ...s, receiptDate: e.target.value }))}
                      className="qt-input" />
                    <label>Receipt date</label>
                  </div>
                </div>
                {showMoney && (
                  <div className="grid md:grid-cols-2 gap-3">
                    <MobileNumField label="Vendor invoice amount (₹)" value={instant.vendorInvoiceAmount}
                      onChange={v => setInstant(s => ({ ...s, vendorInvoiceAmount: v }))} />
                    <MobileNumField label="Freight / cartage (₹)" value={instant.totalCharges}
                      onChange={v => setInstant(s => ({ ...s, totalCharges: v }))} />
                  </div>
                )}
                {showMoney && (
                  <p className="text-[11px] text-slate-400 -mt-1">
                    Freight is spread across the lines by value, so each item carries its true landed cost.
                  </p>
                )}
                <div>
                  <div className="qt-section-label mb-1">Rate this delivery</div>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button type="button" key={n} onClick={() => setInstant(s => ({ ...s, rating: n }))}
                        aria-label={`${n} stars`}
                        className="w-10 h-10 rounded-lg flex items-center justify-center active:bg-slate-100">
                        <Star className={`w-5 h-5 ${n <= instant.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
                      </button>
                    ))}
                  </div>
                </div>
                <PlainField label="Receipt remarks" value={instant.grnNotes}
                  onChange={v => setInstant(s => ({ ...s, grnNotes: v }))} />

                {showMoney && (
                  <>
                    <label className="flex items-center gap-2.5 cursor-pointer pt-1">
                      <input type="checkbox" className="w-4 h-4 shrink-0"
                        checked={instant.markPaid}
                        onChange={e => setInstant(s => ({ ...s, markPaid: e.target.checked }))} />
                      <span className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
                        <IndianRupee className="w-4 h-4 text-slate-400" /> Already paid
                      </span>
                    </label>
                    {instant.markPaid && (
                      <div className="grid md:grid-cols-2 gap-3">
                        <PlainField label="Payment reference" value={instant.paymentNote}
                          onChange={v => setInstant(s => ({ ...s, paymentNote: v }))} />
                        <MobileNumField label="Paid amount (₹)" value={instant.paidAmount}
                          onChange={v => setInstant(s => ({ ...s, paidAmount: v }))} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sticky action bar. On mobile only the primary action stays inline; everything else moves
          into a bottom sheet. `env(safe-area-inset-bottom)` keeps clear of the iOS home indicator. */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 z-30"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="max-w-6xl mx-auto px-3 py-2.5 flex items-center gap-2">
          {!readOnly && (
            <button onClick={handleSave} disabled={saving}
              className="qt-btn qt-btn-primary flex-1 md:flex-none">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {po ? 'SAVE' : 'CREATE PURCHASE ORDER'}
            </button>
          )}

          {po && (
            <>
              <div className="hidden md:flex items-center gap-2">
                <ActionBtn onClick={() => setShowPreview(true)} icon={Eye} label="Preview" />
                <ActionBtn onClick={handleDownloadPdf} icon={Download} label="PDF" busy={busyAction === 'pdf'} />
                <ActionBtn
                  onClick={handleSendEmail}
                  icon={Mail}
                  label="Email"
                  busy={busyAction === 'email'}
                  disabled={!selectedVendor?.Email}
                  title={selectedVendor?.Email
                    ? `Send to ${selectedVendor.Email}`
                    : 'No email address on file for this vendor'}
                />
                {po.Status === 'Issued' && (
                  <ActionBtn onClick={handleSendReminder} icon={Bell} label="Reminder" busy={busyAction === 'reminder'} />
                )}
                {!readOnly && canEditPo && (
                  <ActionBtn onClick={handleCancel} icon={Trash2} label="Cancel PO" busy={busyAction === 'cancel'} />
                )}
              </div>

              <button onClick={() => setShowActions(true)} aria-label="More actions"
                className="md:hidden px-4 py-3 border border-slate-300 rounded-xl text-sm font-bold flex items-center gap-1.5 active:bg-slate-50">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile action sheet */}
      {showActions && po && (
        <div className="md:hidden fixed inset-0 bg-slate-900/50 z-50 flex items-end" onClick={() => setShowActions(false)}>
          <div className="bg-white w-full rounded-t-2xl p-3 space-y-1.5"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
            onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-2" />
            <SheetBtn icon={Eye} label="Preview document" onClick={() => { setShowActions(false); setShowPreview(true); }} />
            <SheetBtn icon={Download} label="Download PDF" onClick={() => { setShowActions(false); handleDownloadPdf(); }} />
            {selectedVendor?.Email && (
              <SheetBtn icon={Mail} label="Email to supplier" onClick={() => { setShowActions(false); handleSendEmail(); }} />
            )}
            {po.Status === 'Issued' && (
              <SheetBtn icon={Bell} label="Send reminder" onClick={() => { setShowActions(false); handleSendReminder(); }} />
            )}
            {!readOnly && canEditPo && (
              <SheetBtn icon={Trash2} label="Cancel purchase order" onClick={() => { setShowActions(false); handleCancel(); }} />
            )}
            <button onClick={() => setShowActions(false)}
              className="w-full mt-2 px-4 py-3 border border-slate-200 rounded-xl text-sm font-bold">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* New catalogue item, created straight onto the line that opened it */}
      {itemCreate && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-end md:items-center justify-center md:p-4" onClick={() => setItemCreate(null)}>
          <div
            className="bg-white rounded-t-2xl md:rounded-2xl p-4 md:p-5 w-full max-w-md max-h-[92vh] overflow-y-auto"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-2 md:hidden" />
            <div className="flex items-center justify-between mb-3">
              <div className="font-bold text-slate-900">New item</div>
              <button onClick={() => setItemCreate(null)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <PlainField label="Item name" value={itemCreate.itemName}
                onChange={v => setItemCreate(s => ({ ...s, itemName: v }))} />
              <div className="grid grid-cols-2 gap-3">
                <PlainField label="Unit" value={itemCreate.unit}
                  onChange={v => setItemCreate(s => ({ ...s, unit: v }))} />
                <PlainField label="HSN code" value={itemCreate.hsnCode}
                  onChange={v => setItemCreate(s => ({ ...s, hsnCode: v }))} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MobileNumField label="Rate" value={itemCreate.standardRate}
                  onChange={v => setItemCreate(s => ({ ...s, standardRate: v }))} />
                <MobileNumField label="GST %" value={itemCreate.defaultGstRate}
                  onChange={v => setItemCreate(s => ({ ...s, defaultGstRate: v }))} />
              </div>
              <PlainField label="Category" value={itemCreate.category}
                onChange={v => setItemCreate(s => ({ ...s, category: v }))} />
              <div className="text-[11px] text-slate-500">
                Saved to the item catalogue and added to this line. Photos and stock details can be
                filled in later from Items &amp; Inventory.
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setItemCreate(null)} className="qt-btn qt-btn-ghost flex-1">CANCEL</button>
              <button onClick={saveNewItem} disabled={savingItem} className="qt-btn qt-btn-primary flex-1">
                {savingItem && <Loader2 className="w-4 h-4 animate-spin" />} CREATE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vendor create / quick-edit — one modal, two modes (vendEdit.mode) */}
      {vendEdit && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-end md:items-center justify-center md:p-4" onClick={() => setVendEdit(null)}>
          <div
            className="bg-white rounded-t-2xl md:rounded-2xl p-4 md:p-5 w-full max-w-md max-h-[92vh] overflow-y-auto"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-2 md:hidden" />
            <div className="flex items-center justify-between mb-3">
              <div className="font-bold text-slate-900">
                {vendEdit.mode === 'create' ? 'New vendor' : 'Edit vendor'}
              </div>
              <button onClick={() => setVendEdit(null)} className="p-1.5 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
              <PlainField label="Vendor name" value={vendEdit.vendorName}
                onChange={v => setVendEdit(s => ({ ...s, vendorName: v }))} />
              <div className="grid grid-cols-2 gap-3">
                <PlainField label="Contact person" value={vendEdit.contactPerson}
                  onChange={v => setVendEdit(s => ({ ...s, contactPerson: v }))} />
                <PlainField label="Phone" value={vendEdit.phone}
                  onChange={v => setVendEdit(s => ({ ...s, phone: v }))} />
              </div>
              <PlainField label="Email" value={vendEdit.email}
                onChange={v => setVendEdit(s => ({ ...s, email: v }))} />
              <PlainField label="Address" value={vendEdit.address}
                onChange={v => setVendEdit(s => ({ ...s, address: v }))} />
              {/* Reuses the quotation's GSTIN control, so the same validation and state detection
                  applies on the buying side. The vendor's state is what decides IGST here. */}
              <GstinInput
                gstin={vendEdit.gstin}
                stateCode={vendEdit.stateCode}
                onChange={({ gstin, stateCode }) => setVendEdit(s => ({ ...s, gstin, stateCode }))}
              />
              <div className="grid grid-cols-2 gap-3">
                <PlainField label="Payment terms" value={vendEdit.paymentTerms}
                  onChange={v => setVendEdit(s => ({ ...s, paymentTerms: v }))} />
                <MobileNumField label="Lead time (days)" value={vendEdit.leadTimeDays}
                  onChange={v => setVendEdit(s => ({ ...s, leadTimeDays: v }))} />
              </div>
              <div className="text-[11px] text-slate-500">
                The vendor's GSTIN decides whether this order is taxed CGST + SGST or IGST.
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setVendEdit(null)} className="qt-btn qt-btn-ghost flex-1">CANCEL</button>
              <button onClick={saveVendor} disabled={savingVend} className="qt-btn qt-btn-primary flex-1">
                {savingVend && <Loader2 className="w-4 h-4 animate-spin" />}
                {vendEdit.mode === 'create' ? 'CREATE' : 'SAVE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* A4 print preview */}
      {showPreview && po && (
        <div className="fixed inset-0 bg-slate-900/70 z-50 overflow-auto" onClick={() => setShowPreview(false)}>
          <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200 px-4 py-2.5 flex items-center gap-2 z-10"
            onClick={e => e.stopPropagation()}>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm truncate">{po.PO_No}</div>
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
                    doc={po}
                    docType="PO"
                    settings={settings}
                    branding={branding}
                    vendors={vendors}
                    paymentTerm={(settings?.payment_terms || []).find(t => t.id === po.Payment_Terms_ID)}
                    tncItems={(settings?.tnc_checklist || []).filter(t => (po.Selected_TNC_IDs || []).includes(t.id))}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen PDF source */}
      {po && (
        <div style={{ position: 'fixed', left: '-10000px', top: 0 }} aria-hidden="true">
          <QuotationPdfTemplate
            ref={pdfRef}
            doc={po}
            docType="PO"
            settings={settings}
            branding={branding}
            vendors={vendors}
            paymentTerm={(settings?.payment_terms || []).find(t => t.id === po.Payment_Terms_ID)}
            tncItems={(settings?.tnc_checklist || []).filter(t => (po.Selected_TNC_IDs || []).includes(t.id))}
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
 * Subject field: free text with a type-to-filter dropdown of the saved suggestions, shared with the
 * quotation builder. Deliberately NOT a <select> — an unusual subject must still be typeable without
 * an Admin first editing settings, so the typed value is always authoritative.
 *
 * Blur closes the list on a timeout rather than immediately: a mousedown on an option fires blur
 * before click, so closing synchronously would unmount the option before its click registers.
 */
function SubjectCombo({ value, onChange, options, disabled }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);

  const query = String(value || '').toLowerCase().trim();
  const list = (options || []).map(o => (typeof o === 'string' ? o : o.text)).filter(Boolean);
  const filtered = query && !list.some(t => t.toLowerCase() === query)
    ? list.filter(t => matchesQuery(query, [t]))
    : list;

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <div className="relative">
      <div className="qt-field">
        <input
          value={value ?? ''}
          disabled={disabled}
          placeholder=" "
          autoComplete="off"
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { closeTimer.current = setTimeout(() => setOpen(false), 120); }}
          className="qt-input"
        />
        <label>Subject</label>
      </div>

      {open && !disabled && filtered.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
          {filtered.map(text => (
            <button
              key={text}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(text); setOpen(false); }}
              className="w-full text-left px-3 py-2.5 text-sm hover:bg-slate-50 active:bg-slate-100"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Per-line note, printed under the item on the PDF.
 *
 * Collapsed to a single small button until there is something to show — twenty always-open
 * textareas would bury the numbers that matter. Once text exists it stays visible, because a note
 * the vendor will read must never be hidden behind a tap the user has to remember to make.
 */
function LineRemarks({ value, onChange, readOnly, label = 'Remark', placeholder }) {
  const [open, setOpen] = useState(false);
  const text = String(value || '');

  if (readOnly) {
    return text
      ? <div className="text-[11px] text-slate-600 mt-1 whitespace-pre-line">{text}</div>
      : null;
  }

  if (!open && !text) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400 hover:text-slate-700 transition"
      >
        <MessageSquarePlus className="w-3 h-3" /> {label}
      </button>
    );
  }

  return (
    <textarea
      value={text}
      autoFocus={open && !text}
      rows={2}
      placeholder={placeholder || `${label} — prints under this item on the PDF`}
      onChange={e => onChange(e.target.value)}
      onBlur={() => { if (!text.trim()) setOpen(false); }}
      className="qt-cell mt-1 w-full text-[11px] leading-snug"
      style={{ height: 'auto', minHeight: '44px' }}
    />
  );
}

/**
 * Item picker for one purchase-order line.
 *
 * allowFreeText because a purchase often precedes the catalogue — you buy a part before anyone has
 * created an item row for it, and blocking that would be backwards. The selected row is synthesised
 * from the LINE, not looked up in `items`, so a line whose catalogue entry was later renamed or
 * deactivated still shows the name the order was raised with.
 */
function ItemPicker({ items, line, onPick }) {
  const selected = line.itemName
    ? (items.find(i => i.Item_ID === line.itemId) || line.itemName)
    : null;

  return (
    <SmartSearchSelect
      options={items}
      value={selected}
      onChange={onPick}
      placeholder="Search item name or HSN…"
      getKey={i => (typeof i === 'string' ? i : i.Item_ID)}
      getLabel={i => (typeof i === 'string' ? i : i.Item_Name)}
      getSubtitle={i => (typeof i === 'string'
        ? ''
        : [i.Category, i.HSN_Code ? `HSN ${i.HSN_Code}` : '', i.Unit].filter(Boolean).join(' · '))}
      getSearchable={i => (typeof i === 'string'
        ? [i]
        : [i.Item_Name, i.Category, i.HSN_Code, ...(i.Aliases || [])])}
      emptyText="No item matches that."
      allowFreeText
    />
  );
}

function ActionBtn({ onClick, icon: Icon, label, busy, disabled, title }) {
  return (
    <button onClick={onClick} disabled={busy || disabled} title={title}
      className="qt-btn qt-btn-ghost py-2 disabled:cursor-not-allowed">
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />} {label}
    </button>
  );
}

/** Full-width row in the mobile action sheet — 48px tall to meet touch-target guidance. */
function SheetBtn({ icon: Icon, label, onClick }) {
  return (
    <button onClick={onClick}
      className="w-full px-4 py-3.5 rounded-xl text-sm font-bold flex items-center gap-3 text-left transition text-slate-700 active:bg-slate-100">
      <Icon className="w-4 h-4 shrink-0" /> {label}
    </button>
  );
}

/**
 * Numeric field for the mobile line cards.
 * `inputMode="decimal"` brings up the numeric keypad, and the 16px base font stops iOS Safari
 * zooming the viewport when the field gains focus.
 */
function MobileNumField({ label, value, onChange, disabled }) {
  return (
    <div className="qt-field">
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value ?? ''}
        disabled={disabled}
        placeholder=" "
        onChange={e => onChange(e.target.value)}
        className="qt-input text-right"
      />
      <label>{label}</label>
    </div>
  );
}

function MobileTextField({ label, value, onChange, disabled }) {
  return (
    <div className="qt-field">
      <input value={value ?? ''} disabled={disabled} placeholder=" "
        onChange={e => onChange(e.target.value)} className="qt-input" />
      <label>{label}</label>
    </div>
  );
}

function PlainField({ label, value, onChange }) {
  return (
    <div className="qt-field">
      {/* placeholder=" " is what drives the floating label — see .qt-field in index.css */}
      <input value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder=" "
        className="qt-input" />
      <label>{label}</label>
    </div>
  );
}
