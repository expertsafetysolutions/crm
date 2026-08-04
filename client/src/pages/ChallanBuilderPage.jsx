import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, AlertTriangle, Check, Link2, FileText, Download, MapPin } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { filterByQuery } from '../utils/searchUtils';
import QuotationPdfTemplate from '../components/QuotationPdfTemplate';
import SmartSearchSelect from '../components/SmartSearchSelect';
import DeliveryPODModal from '../components/DeliveryPODModal';
import { downloadPdfFromElement, safeFileName } from '../utils/pdfGenerator';
import { enqueueOfflineAction } from '../utils/offlineQueue';
import useModalBackButton from '../utils/useModalBackButton';

/**
 * ChallanBuilderPage — reviews the generated draft and turns it into an issued delivery challan.
 *
 * Two things make this screen different from the quotation builder:
 *
 * The challan number is typed by a human. The office writes challans in a paper book and the app
 * must match that book exactly, so nothing is ever auto-assigned; the suggestion appears as
 * placeholder text only and a number already in use raises a warning the user can override.
 *
 * Rates are recorded on every line but shown only when an Admin has switched printing on. Lines the
 * grouping could not map to a catalogue item are flagged rather than guessed, and can be mapped
 * here so the catalogue fills in as the business runs.
 */

const CONFIDENCE_STYLE = {
  EXACT: null,
  ALIAS: null,
  FUZZY: { chip: 'bg-amber-100 text-amber-800', label: 'auto-matched' },
  NONE: { chip: 'bg-rose-100 text-rose-700', label: 'not mapped' }
};

export default function ChallanBuilderPage() {
  const { challanId, jobCardId } = useParams();
  const navigate = useNavigate();
  const { token, user, canSeeMoney, updateQueueCount } = useAuth();

  const [challan, setChallan] = useState(null);
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(null);
  const [showPrice, setShowPrice] = useState(false);
  const pdfRef = useRef(null);
  const [challanNo, setChallanNo] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [duplicate, setDuplicate] = useState(null);
  // Post-issue certificate offer. Null = not asked. Dismissing is always safe: the challan is
  // already issued by the time this appears, and the Cert button below remains the later route in.
  const [certPrompt, setCertPrompt] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [pod, setPod] = useState(null);

  // Phone back button closes the open popup instead of exiting the app (installed PWAs run in
  // standalone mode, where back on an empty history stack quits). See useModalBackButton.
  // DeliveryPODModal registers itself internally, so it is deliberately NOT listed here —
  // registering a popup twice would make it take two back presses to close.
  useModalBackButton(Boolean(certPrompt), () => setCertPrompt(null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Partial-delivery picker. Only used on the "new challan from job card" path; an existing challan
  // has its lines already fixed.
  const [pickerItems, setPickerItems] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [choosing, setChoosing] = useState(false);
  // Mirrors of the two above, so load() can read the selection without depending on it.
  const pickerItemsRef = useRef([]);
  const pickedRef = useRef(new Set());
  pickerItemsRef.current = pickerItems;
  pickedRef.current = picked;

  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token]
  );

  const isIssued = challan?.Status === 'Issued';
  // A challan with no job card behind it: typed in from paper, or a direct supply. Gates the extra
  // line controls, which would otherwise invite someone to contradict a workshop record.
  const isManual = Boolean(challan) && !challan.Job_Card_ID;
  const lines = challan?.Line_Items || [];
  const unmapped = lines.filter(l => l.Item_Match_Confidence === 'NONE').length;

  // Three gates, all of which must pass: the viewer is allowed to see money at all, the admin has
  // turned prices on for challans, and something actually has a price — a column of zeroes helps
  // nobody. For a masked viewer the server has already stripped Rate, so the third test would fail
  // on its own; canSeeMoney is stated explicitly so the intent does not rest on that side effect.
  const priceVisible = canSeeMoney && showPrice && lines.some(l => Number(l.Rate) > 0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let doc;
      if (challanId) {
        const res = await fetch(`/api/challans/${challanId}`, { headers });
        if (!res.ok) throw new Error((await res.json()).error || 'Could not load challan');
        doc = await res.json();
      } else {
        // Read through refs so `load` does not have to depend on the picker state — it is invoked
        // from an effect, and re-creating it on every tick of a checkbox would re-run that effect.
        const chosen = pickedRef.current;
        const available = pickerItemsRef.current;

        // Selecting every cylinder posts {} rather than the full id list: generateChallanDraft
        // derives Is_Partial from itemIds.length > 0, so sending them all would flag a complete
        // delivery as partial. Empty body === "everything", exactly as before this picker existed.
        const all = available.length > 0 && chosen.size === available.length;
        const body = (chosen.size === 0 || all)
          ? '{}'
          : JSON.stringify({ itemIds: [...chosen] });
        const res = await fetch(`/api/job-cards/${jobCardId}/generate-challan`, { method: 'POST', headers, body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not generate the challan draft');
        doc = data;
      }
      setChallan(doc);
      setChallanNo(doc.Challan_No || '');

      const [sug, cfg, master] = await Promise.all([
        fetch('/api/challans/suggest-no', { headers }).then(r => (r.ok ? r.json() : { suggestion: '' })),
        fetch('/api/quotation-settings', { headers }).then(r => (r.ok ? r.json() : null)),
        fetch('/api/items', { headers }).then(r => (r.ok ? r.json() : []))
      ]);
      setSuggestion(sug.suggestion || doc.Challan_No_Suggested || '');
      setSettings(cfg);
      setShowPrice(Boolean(cfg?.challan_config?.show_price));
      setItems(Array.isArray(master) ? master : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [challanId, jobCardId, headers]);

  /**
   * On the "new challan from job card" path, ask which cylinders are going back BEFORE generating
   * anything — generateChallanDraft writes a draft row, so loading first and asking afterwards
   * would leave an unwanted draft behind every time someone split a delivery.
   *
   * The question is only worth asking when there is a choice: a single-cylinder card, an existing
   * challan, or a failed lookup all fall through to the normal load.
   */
  useEffect(() => {
    if (challanId || !jobCardId || !token) { load(); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/job-cards/${jobCardId}`, { headers });
        const data = res.ok ? await res.json() : null;
        const ready = (data?.items || []).filter(i => i.Service_Status !== 'REJECTED');
        if (cancelled) return;
        if (ready.length < 2) { load(); return; }
        setPickerItems(ready);
        setPicked(new Set(ready.map(i => i.Job_Card_Item_ID)));
        setChoosing(true);
        setLoading(false);
      } catch {
        // The picker is a convenience, never a gate — fall back to generating the whole challan.
        if (!cancelled) load();
      }
    })();
    return () => { cancelled = true; };
  }, [challanId, jobCardId, token, headers, load]);

  const persist = async (patch) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}`, {
        method: 'PUT', headers, body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      setChallan(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const patchLine = (lineId, patch) => {
    const next = lines.map(l => (l.lineId === lineId ? { ...l, ...patch } : l));
    setChallan(c => ({ ...c, Line_Items: next }));
  };

  const saveLines = (next) => persist({ Line_Items: next || lines });

  const addManualLine = () => {
    // Inherit equipment type and capacity from the row above — on a manual challan the next line is
    // usually the same family, and this is the JobCardInwardTab pattern for cutting typing.
    const prev = lines[lines.length - 1];
    const next = [...lines, {
      lineId: `M${Date.now().toString(36)}`,
      Line_Type: 'MANUAL', Item_ID: '', Item_Name: '', Description: '',
      Qty: 1, Unit: 'Nos', Rate: 0, HSN_Code: '',
      // '' means "let the server classify from the catalogue".
      Service_Override: '', Service_Type: '',
      Equipment_Type: prev?.Equipment_Type || '', Capacity: prev?.Capacity || '',
      Item_Match_Confidence: 'NONE', Source_Item_IDs: [], UID_Numbers: []
    }];
    setChallan(c => ({ ...c, Line_Items: next }));
  };

  const removeLine = (lineId) => saveLines(lines.filter(l => l.lineId !== lineId));

  /** Maps an unmatched line to a catalogue item and pulls that item's rate in with it. */
  const applyMapping = async (lineId, master) => {
    const rates = await fetch(
      `/api/price-list/resolve?customerId=${encodeURIComponent(challan.Customer_ID)}&itemIds=${encodeURIComponent(master.Item_ID)}`,
      { headers }
    ).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    const resolved = rates[master.Item_ID];

    const next = lines.map(l => (l.lineId === lineId ? {
      ...l,
      Item_ID: master.Item_ID,
      Item_Name: master.Item_Name,
      HSN_Code: master.HSN_Code || '',
      Unit: master.Unit || l.Unit,
      Rate: resolved?.rate ?? Number(master.Standard_Rate) ?? 0,
      Rate_Source: resolved?.source || 'STANDARD',
      Rate_Source_Label: resolved?.sourceLabel || 'Standard rate from Item Master',
      Item_Match_Confidence: 'EXACT',
      /*
       * Cleared so the server re-derives them for the item just picked. Without this, swapping
       * "Refilling CO2 3 Kg" for "HP Testing ABC 6 Kg" would keep the old service and capacity and
       * put the line on the wrong certificate. A hand-typed override is deliberately NOT cleared —
       * the user chose it and it outranks detection.
       */
      Line_Type: l.Service_Override ? l.Line_Type : '',
      Service_Type: l.Service_Override ? l.Service_Type : '',
      Equipment_Type: '',
      Capacity: ''
    } : l));
    setMapping(null);
    await saveLines(next);
  };

  /** Opens the delivery capture, pre-loaded with whatever loaner units are still out. */
  const openPod = async () => {
    setBusy(true);
    try {
      const standby = challan.Job_Card_ID
        ? await fetch(`/api/job-cards/${challan.Job_Card_ID}/standby`, { headers })
          .then(r => (r.ok ? r.json() : [])).catch(() => [])
        : [];
      setPod({ pendingStandby: standby });
    } finally {
      setBusy(false);
    }
  };

  // Both of these must throw on failure: the modal marks the units resolved as soon as they return,
  // so swallowing an error here would unlock the signature pad over a write that never happened.
  const returnStandby = async (euids) => {
    const res = await fetch(`/api/job-cards/${challan.Job_Card_ID}/standby/return`, {
      method: 'POST', headers, body: JSON.stringify({ euids })
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || 'Could not record the standby return');
    }
  };

  const retainStandby = async (euids, reason) => {
    const res = await fetch(`/api/job-cards/${challan.Job_Card_ID}/standby/retain`, {
      method: 'POST', headers, body: JSON.stringify({ euids, reason })
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || 'Could not record the retention');
    }
  };

  const notifyPod = async (channel) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}/pod-notify`, {
        method: 'POST', headers, body: JSON.stringify({ channel })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the confirmation');
      // Partial success is normal here — email may land while an unapproved WhatsApp template is
      // rejected — so report what each channel actually did rather than a blanket "sent".
      const failed = (data.dispatchResults || []).filter(r => !r.ok);
      setError(failed.length > 0
        ? failed.map(f => `${f.channel}: ${f.error}`).join(' · ')
        : `Confirmation sent by ${channel}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const savePod = async (payload) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}/pod`, {
        method: 'POST', headers, body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.pendingStandby) {
          setPod({ pendingStandby: data.pendingStandby });
          return;
        }
        throw new Error(data.error || 'Could not save proof of delivery');
      }
      setChallan(data);
      setPod(null);
    } catch (e) {
      // A delivery address is exactly where the signal dies, and the customer is standing there
      // with a pen. Queue the signed proof and let it sync rather than asking them to sign twice.
      // Only a genuine network failure qualifies — a 409 or a validation error came from a server
      // that answered, and replaying it would fail identically.
      if (!navigator.onLine || e instanceof TypeError) {
        try {
          await enqueueOfflineAction('CHALLAN_POD', { ...payload, challanId: challan.Challan_ID });
          await updateQueueCount();
          setPod(null);
          setError('Saved on this device — it will sync when you are back online.');
        } catch {
          setError('Could not save proof of delivery, and it could not be stored offline either.');
        }
      } else {
        setError(e.message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** Captures the off-screen A4 template, which is the same component the invoice PDF uses. */
  const downloadPdf = async () => {
    if (!pdfRef.current) return;
    setBusy(true);
    try {
      await downloadPdfFromElement(
        pdfRef.current,
        safeFileName('Delivery-Challan', challan.Challan_No || challan.Challan_ID, challan.Customer_Name_Snapshot)
      );
    } catch (e) {
      setError(e.message || 'Could not generate the PDF');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Raises the tax invoice. Rates already live on the challan, so this only sends the lines a user
   * corrected here; the server prices and taxes the document itself.
   */
  const createInvoice = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}/convert-to-invoice`, {
        method: 'POST', headers,
        body: JSON.stringify({ lineOverrides: lines.filter(l => l.Rate_Touched).map(l => ({ lineId: l.lineId, Rate: l.Rate })) })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.unpricedLines) {
          throw new Error(`${data.unpricedLines.length} line(s) still have no rate: ${data.unpricedLines.map(l => l.Item_Name).join(', ')}`);
        }
        throw new Error(data.error || 'Could not create the invoice');
      }
      navigate('/sales-documents');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const issue = async (acknowledgeDuplicate = false) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/challans/${challan.Challan_ID}/issue`, {
        method: 'POST', headers,
        body: JSON.stringify({ challanNo, challanDate: challan.Challan_Date, acknowledgeDuplicate })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.duplicateOf) { setDuplicate(data.duplicateOf); return; }
        throw new Error(data.error || 'Could not issue the challan');
      }
      setDuplicate(null);
      setChallan(data);

      /*
       * Offer the certificate while the delivery is still in hand — the prefill endpoint is already
       * there, it just had nothing calling it, so certificates were raised days later from memory.
       * Only for lines that actually certify: an accessory-only delivery must not be asked.
       *
       * EVERY distinct service present gets offered, not just one. A single cylinder can legitimately
       * be both refilled and hydro-tested (see the note in challanService.buildChallanLines), and
       * those are two separate certificates. Picking one meant the other was silently never offered.
       */
      const certifiable = (data.Line_Items || []).filter(l => l.Line_Type === 'SERVICE' && l.Service_Type);
      const byType = [...new Set(certifiable.map(l => l.Service_Type))]
        .map(formatType => ({
          formatType,
          count: certifiable.filter(l => l.Service_Type === formatType).length
        }));
      if (byType.length > 0) setCertPrompt({ types: byType });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Split-delivery choice, offered before the draft is built. Everything starts ticked, so the
  // common case is one tap on Continue and the result is identical to the old behaviour.
  if (choosing) {
    const allPicked = picked.size === pickerItems.length;
    return (
      <div className="min-h-screen bg-slate-50 pb-28">
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
          <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
            <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-slate-900">What is going back?</p>
              <p className="text-[11px] text-slate-500">Untick anything staying in the workshop</p>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-3 py-3 space-y-2">
          <button
            onClick={() => setPicked(allPicked ? new Set() : new Set(pickerItems.map(i => i.Job_Card_Item_ID)))}
            className="jc-btn-ghost w-full border border-slate-200 rounded-xl bg-white">
            {allPicked ? 'Clear all' : 'Select all'}
          </button>

          {pickerItems.map(i => (
            <label key={i.Job_Card_Item_ID}
              className="flex items-center gap-2.5 min-h-[48px] px-3 rounded-xl bg-white border border-slate-200 active:bg-slate-50">
              <input
                type="checkbox"
                checked={picked.has(i.Job_Card_Item_ID)}
                onChange={() => setPicked(prev => {
                  const next = new Set(prev);
                  next.has(i.Job_Card_Item_ID) ? next.delete(i.Job_Card_Item_ID) : next.add(i.Job_Card_Item_ID);
                  return next;
                })}
                className="w-4 h-4 shrink-0"
              />
              <span className="text-xs font-bold text-slate-700 min-w-0 truncate">
                {i.Cylinder_No || i.EUID_No || `Sr ${i.Sr_No}`}
                <span className="font-medium text-slate-400"> · {i.Equipment_Type} {i.Capacity}</span>
              </span>
            </label>
          ))}
        </main>

        <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <div className="max-w-4xl mx-auto px-3 py-2">
            <button
              onClick={() => { setChoosing(false); load(); }}
              disabled={picked.size === 0}
              className="w-full min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold active:bg-slate-800 disabled:opacity-40">
              {allPicked
                ? `Continue with all ${pickerItems.length}`
                : `Continue with ${picked.size} of ${pickerItems.length} — partial challan`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Preparing challan…</div>
      </div>
    );
  }

  if (!challan) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
        <p className="text-sm font-bold text-rose-600">{error || 'Challan not found'}</p>
        <button onClick={() => navigate(-1)} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold">Go back</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900 truncate">Delivery Challan</p>
            <p className="text-[11px] text-slate-500 truncate">{challan.Customer_Name_Snapshot}</p>
          </div>
          <span className={`shrink-0 px-2 py-1 rounded-lg text-[10px] font-extrabold ${
            isIssued ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
          }`}>
            {challan.Status}{challan.Is_Partial ? ' · Partial' : ''}
          </span>
          {/* Stays visible after issue: whoever opens this later needs to know why the stock ledger
              will not move when it is invoiced. */}
          {challan.Is_Historical && (
            <span className="shrink-0 px-2 py-1 rounded-lg bg-amber-100 text-amber-800 text-[10px] font-extrabold">
              Old record
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="max-w-4xl mx-auto px-3 pt-3">
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 flex items-start gap-2">
            <p className="text-xs font-bold text-rose-700 flex-1">{error}</p>
            <button onClick={() => setError('')} className="text-rose-400 text-xs font-bold">✕</button>
          </div>
        </div>
      )}

      <main className="max-w-4xl mx-auto px-3 py-3 space-y-3">
        <div className="rounded-xl bg-white border border-slate-200 p-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
              Challan No <span className="text-rose-500">*</span>
            </span>
            {/* Typed by hand, never auto-assigned — the paper book is the authority. */}
            <input
              value={challanNo}
              disabled={isIssued}
              onChange={e => { setChallanNo(e.target.value); setDuplicate(null); }}
              placeholder={suggestion ? `e.g. ${suggestion}` : 'From your challan book'}
              className="jc-input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Date</span>
            <input
              type="date"
              value={challan.Challan_Date || ''}
              disabled={isIssued}
              onChange={e => setChallan(c => ({ ...c, Challan_Date: e.target.value }))}
              onBlur={e => !isIssued && persist({ Challan_Date: e.target.value })}
              className="jc-input"
            />
          </label>
        </div>

        {/*
          Manual drafts only. Editable right up to issue and locked after, because the stock decision
          must not change under an invoice that has already been raised on it.
        */}
        {isManual && !isIssued && (
          <label className="flex items-start gap-2.5 min-h-[48px] px-3 py-2.5 rounded-xl bg-white border border-slate-200 active:bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(challan.Is_Historical)}
              onChange={e => persist({ Is_Historical: e.target.checked })}
              className="w-4 h-4 shrink-0 mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-xs font-extrabold text-slate-800">Old challan — already delivered</span>
              <span className="block text-[11px] text-slate-500 leading-snug mt-0.5">
                Stock will NOT be reduced when this is invoiced — the goods left the shelf at the time.
              </span>
            </span>
          </label>
        )}

        {/*
          Vehicle number and notes are exactly what a paper challan carries, and the server has always
          accepted them — there was simply nowhere to type them. Collapsed by default so the job-card
          layout is unchanged for the people who never need them.
        */}
        {isManual && !isIssued && (
          <details className="rounded-xl bg-white border border-slate-200 overflow-hidden">
            <summary className="px-3 min-h-[44px] flex items-center text-xs font-extrabold text-slate-700 cursor-pointer select-none">
              Delivery details
            </summary>
            <div className="px-3 pb-3 space-y-2">
              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Despatch through</span>
                <input
                  value={challan.Despatch_Through || ''}
                  onChange={e => setChallan(c => ({ ...c, Despatch_Through: e.target.value }))}
                  onBlur={e => persist({ Despatch_Through: e.target.value })}
                  placeholder="e.g. By Road — Gati Transport"
                  className="jc-input"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Agent name</span>
                <input
                  value={challan.Agent_Name || ''}
                  onChange={e => setChallan(c => ({ ...c, Agent_Name: e.target.value }))}
                  onBlur={e => persist({ Agent_Name: e.target.value })}
                  placeholder="Transport agent / broker"
                  className="jc-input"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Vehicle no</span>
                <input
                  value={challan.Vehicle_No || ''}
                  onChange={e => setChallan(c => ({ ...c, Vehicle_No: e.target.value }))}
                  onBlur={e => persist({ Vehicle_No: e.target.value })}
                  placeholder="e.g. GJ-06-AB-1234"
                  className="jc-input"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Received by</span>
                <input
                  value={challan.Received_By_Name || ''}
                  onChange={e => setChallan(c => ({ ...c, Received_By_Name: e.target.value }))}
                  onBlur={e => persist({ Received_By_Name: e.target.value })}
                  placeholder="Name on the paper challan"
                  className="jc-input"
                />
              </label>
              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Notes</span>
                <textarea
                  value={challan.Notes || ''}
                  onChange={e => setChallan(c => ({ ...c, Notes: e.target.value }))}
                  onBlur={e => persist({ Notes: e.target.value })}
                  rows={2}
                  className="jc-input py-2"
                />
              </label>
            </div>
          </details>
        )}

        {duplicate && (
          <div className="rounded-xl bg-amber-50 border border-amber-300 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-extrabold text-amber-900">Number already used</p>
                <p className="text-[11px] text-amber-800 mt-0.5">
                  {challanNo} was issued to {duplicate.Customer || 'another customer'} on {duplicate.Challan_Date || '—'}.
                  Use it anyway only if that page was cancelled or this is a reprint.
                </p>
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => setDuplicate(null)} className="jc-btn-ghost flex-1">Change number</button>
              <button onClick={() => issue(true)} disabled={busy} className="flex-1 min-h-[44px] rounded-xl bg-amber-600 text-white text-xs font-extrabold active:bg-amber-700">
                Use it anyway
              </button>
            </div>
          </div>
        )}

        {unmapped > 0 && !isIssued && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 flex items-start gap-2">
            <Link2 className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <p className="text-[11px] font-bold text-rose-700">
              {unmapped} line{unmapped > 1 ? 's are' : ' is'} not linked to a catalogue item. The challan still
              delivers correctly, but these cannot be priced on an invoice until they are mapped.
            </p>
          </div>
        )}

        <div className="rounded-xl bg-white border border-slate-200 overflow-hidden">
          {lines.map((line, idx) => {
            const flag = CONFIDENCE_STYLE[line.Item_Match_Confidence];
            return (
              <div key={line.lineId} className="px-3 py-2.5 border-b border-slate-100 last:border-0">
                <div className="flex items-start gap-2">
                  <span className="text-[11px] font-extrabold text-slate-400 mt-0.5 shrink-0">{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    {line.Line_Type === 'MANUAL' && !isIssued ? (
                      <input
                        value={line.Item_Name}
                        onChange={e => patchLine(line.lineId, { Item_Name: e.target.value, Description: e.target.value })}
                        onBlur={() => saveLines()}
                        placeholder="Item description"
                        className="jc-input mb-1"
                      />
                    ) : (
                      <p className="text-xs font-bold text-slate-900">{line.Item_Name}</p>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                      {line.Line_Type === 'ACCESSORY' && (
                        <span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[9px] font-extrabold">ACCESSORY</span>
                      )}
                      {line.Line_Type === 'MANUAL' && (
                        <span className="px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 text-[9px] font-extrabold">ADDED</span>
                      )}
                      {flag && (
                        <button
                          onClick={() => !isIssued && setMapping(line.lineId)}
                          disabled={isIssued}
                          className={`px-1.5 py-0.5 rounded-md text-[9px] font-extrabold ${flag.chip}`}
                        >
                          {flag.label} · map
                        </button>
                      )}
                      {line.Line_Type === 'SERVICE' && line.Service_Type && (
                        <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-700 text-[9px] font-extrabold">
                          {line.Service_Type}{line.Capacity ? ` · ${line.Capacity}` : ''}
                        </span>
                      )}
                      {line.UID_Numbers?.length > 0 && !isManual && (
                        <span className="text-[9px] text-slate-400 font-bold truncate">
                          UID: {line.UID_Numbers.join(', ')}
                        </span>
                      )}
                    </div>

                    {/*
                      Manual challans only. A job-card line already knows what it is — the technician
                      ticked it on the cylinder — so exposing a dropdown there would invite someone
                      to contradict the workshop record.

                      The value falls back to what the server derived, so the auto-detected answer is
                      what the user sees and they only touch it when it is wrong. Options are labelled
                      by consequence, because "does this print a certificate?" is the actual question.
                    */}
                    {isManual && !isIssued && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <select
                          value={line.Service_Override || (line.Line_Type === 'SERVICE' ? line.Service_Type : 'SUPPLY')}
                          onChange={e => {
                            const next = lines.map(l => (l.lineId === line.lineId
                              ? { ...l, Service_Override: e.target.value }
                              : l));
                            setChallan(c => ({ ...c, Line_Items: next }));
                            saveLines(next);
                          }}
                          className="jc-input flex-1 min-w-[11rem] text-xs"
                          aria-label="What this line is"
                        >
                          <option value="SUPPLY">Supply only — no certificate</option>
                          <option value="Refilling">Refilling — certificate</option>
                          <option value="HP Testing">HP Testing — certificate</option>
                          <option value="New Fire Extinguisher">New extinguisher — certificate</option>
                        </select>

                        {/* The certificate prints this, so a blank capacity is a blank column. The
                            server normalises it, so "6kg" typed in a hurry comes back as "6 Kg". */}
                        {line.Line_Type === 'SERVICE' && (
                          <input
                            value={line.Capacity || ''}
                            onChange={e => patchLine(line.lineId, { Capacity: e.target.value })}
                            onBlur={() => saveLines()}
                            placeholder="Capacity"
                            className="jc-input w-24 text-xs"
                            aria-label="Capacity"
                          />
                        )}
                      </div>
                    )}

                    {/*
                      Cylinder numbers, for HP Testing only — buildCertificatePrefill emits one
                      certificate row per number. Optional on purpose: a back-entered paper challan
                      often has none, and the prefill then falls back to a single aggregated row,
                      which is the honest outcome. Comma-separated rather than a repeater: three
                      numbers are quicker typed than tapped.
                    */}
                    {isManual && !isIssued && /hp\s*test/i.test(line.Service_Type || '') && (
                      <div className="mt-1.5">
                        <input
                          value={(line.UID_Numbers || []).join(', ')}
                          onChange={e => patchLine(line.lineId, {
                            UID_Numbers: e.target.value.split(',').map(v => v.trim()).filter(Boolean)
                          })}
                          onBlur={() => saveLines()}
                          placeholder="Cylinder numbers, comma separated (optional)"
                          className="jc-input w-full text-xs"
                          aria-label="Cylinder numbers"
                        />
                        {(line.UID_Numbers || []).length > 0 && (line.UID_Numbers || []).length !== Number(line.Qty) && (
                          /* Advisory, never a block: fewer numbers than cylinders means fewer rows on
                             the certificate, which nobody notices until the customer's auditor does. */
                          <p className="mt-0.5 text-[10px] font-bold text-amber-600">
                            {(line.UID_Numbers || []).length} of {line.Qty} numbers entered
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      min="0"
                      value={line.Qty}
                      disabled={isIssued}
                      onChange={e => patchLine(line.lineId, { Qty: Number(e.target.value) })}
                      onBlur={() => saveLines()}
                      className="jc-input w-14 text-center"
                      aria-label="Quantity"
                    />
                    <span className="text-[10px] text-slate-400 font-bold w-7">{line.Unit}</span>

                    {priceVisible && (
                      <input
                        type="number"
                        min="0"
                        value={line.Rate || 0}
                        disabled={isIssued}
                        onChange={e => patchLine(line.lineId, { Rate: Number(e.target.value), Rate_Touched: true })}
                        onBlur={() => saveLines()}
                        title={line.Rate_Source_Label || ''}
                        // Auto-filled rates read indigo so it is obvious at a glance which numbers
                        // nobody has checked yet; typing one turns it black.
                        className={`jc-input w-20 text-right ${
                          !line.Rate_Touched && Number(line.Rate) > 0 ? 'text-indigo-600 bg-indigo-50/40' : ''
                        }`}
                        aria-label="Rate"
                      />
                    )}

                    {!isIssued && (
                      <button
                        onClick={() => removeLine(line.lineId)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center active:bg-slate-100"
                        aria-label="Remove line"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                      </button>
                    )}
                  </div>
                </div>

                {mapping === line.lineId && (
                  <ItemPicker
                    items={items}
                    onPick={master => applyMapping(line.lineId, master)}
                    onClose={() => setMapping(null)}
                  />
                )}
              </div>
            );
          })}

          <div className="px-3 py-2 bg-slate-50 flex items-center justify-between">
            <span className="text-[11px] font-extrabold text-slate-500">
              {challan.Item_Count} line{challan.Item_Count === 1 ? '' : 's'} · {challan.Total_Qty} total qty
            </span>
            {priceVisible && (
              <span className="text-xs font-extrabold text-slate-900">
                ₹ {Number(challan.Total_Amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            )}
          </div>
        </div>

        {!isIssued && (
          <button onClick={addManualLine} className="jc-btn-ghost w-full min-h-[48px]">
            {/* A manual challan opens empty, so "another" would be wrong on the first tap. */}
            <Plus className="w-4 h-4" /> {lines.length === 0 ? 'Add the first item' : 'Add another product'}
          </button>
        )}

        {/* Delivered — offer to tell the customer. Deliberately here rather than in the action bar:
            it is a follow-up to the signature, not one of the primary document actions. */}
        {challan.POD?.deliveredAt && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <p className="text-[11px] font-extrabold text-emerald-900">
              Received by {challan.POD.receivedByName || 'the customer'}
            </p>
            <div className="flex gap-2 mt-2">
              <button onClick={() => notifyPod('Email')} disabled={busy}
                className="flex-1 min-h-[44px] rounded-xl border border-emerald-300 bg-white text-emerald-800 text-xs font-extrabold active:bg-emerald-100 disabled:opacity-40">
                Email confirmation
              </button>
              <button onClick={() => notifyPod('WhatsApp')} disabled={busy}
                className="flex-1 min-h-[44px] rounded-xl border border-emerald-300 bg-white text-emerald-800 text-xs font-extrabold active:bg-emerald-100 disabled:opacity-40">
                WhatsApp
              </button>
            </div>
          </div>
        )}

        {/* Only shown to someone who could act on it — a viewer without price access cannot see
            the figures at all, so pointing them at a print setting would only confuse. */}
        {!showPrice && canSeeMoney && (
          <p className="text-[10px] text-slate-400 text-center px-4">
            Prices are recorded on this challan but not printed. An Admin can switch printing on in
            Quotation Settings → Approval &amp; Defaults.
          </p>
        )}
      </main>

      <div className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          {isIssued ? (
            <>
              <button
                onClick={downloadPdf}
                disabled={busy}
                className="w-12 min-h-[48px] rounded-xl border border-slate-200 bg-white flex items-center justify-center active:bg-slate-50 disabled:opacity-40"
                aria-label="Download PDF"
              >
                <Download className="w-4 h-4 text-slate-600" />
              </button>
              <button
                onClick={openPod}
                disabled={busy}
                className={`flex-1 min-h-[48px] rounded-xl border text-xs font-extrabold flex items-center justify-center gap-1.5 disabled:opacity-40 ${
                  challan.POD
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 bg-white text-slate-700 active:bg-slate-50'
                }`}
              >
                <MapPin className="w-4 h-4" /> {challan.POD ? 'Delivered ✓' : 'Delivery'}
              </button>
              {/* Re-opens the same chooser as the post-issue prompt rather than assuming Refilling.
                  Hard-coding it here was the second half of the mixed-challan bug: coming back to a
                  challan carrying both services always landed on the wrong certificate. */}
              <button
                onClick={() => {
                  const certifiable = (challan.Line_Items || []).filter(l => l.Line_Type === 'SERVICE' && l.Service_Type);
                  const byType = [...new Set(certifiable.map(l => l.Service_Type))]
                    .map(formatType => ({ formatType, count: certifiable.filter(l => l.Service_Type === formatType).length }));
                  if (byType.length === 1) {
                    navigate(`/certificate-compliance/new?challanId=${challan.Challan_ID}&formatType=${encodeURIComponent(byType[0].formatType)}`);
                  } else if (byType.length > 1) {
                    setCertPrompt({ types: byType });
                  } else {
                    setError('No line on this challan needs a certificate. Set a line to Refilling or HP Testing first.');
                  }
                }}
                className="flex-1 min-h-[48px] rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-extrabold flex items-center justify-center gap-1.5 active:bg-slate-50"
              >
                <FileText className="w-4 h-4" /> Cert
              </button>
              <button
                onClick={createInvoice}
                disabled={busy || Boolean(challan.Linked_Invoice_ID)}
                className="flex-1 min-h-[48px] rounded-xl bg-indigo-600 text-white text-xs font-extrabold active:bg-indigo-700 disabled:opacity-40"
              >
                {challan.Linked_Invoice_ID ? 'Invoiced ✓' : 'Create Invoice'}
              </button>
            </>
          ) : (
            <button
              onClick={() => issue(false)}
              disabled={busy || !challanNo.trim()}
              className="flex-1 min-h-[48px] rounded-xl bg-emerald-600 text-white text-sm font-extrabold flex items-center justify-center gap-2 active:bg-emerald-700 disabled:opacity-40"
            >
              <Check className="w-4 h-4" />
              {challanNo.trim() ? 'Issue Challan' : 'Enter challan number'}
            </button>
          )}
        </div>
      </div>

      {pod && (
        <DeliveryPODModal
          challan={challan}
          pendingStandby={pod.pendingStandby}
          onSubmit={savePod}
          onReturnStandby={returnStandby}
          onRetainStandby={retainStandby}
          onClose={() => setPod(null)}
          busy={busy}
        />
      )}

      {certPrompt && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full p-5 shadow-2xl space-y-3">
            <div className="flex items-start gap-2.5">
              <FileText className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-extrabold text-slate-900">
                  {certPrompt.types.length > 1 ? 'Raise the certificates now?' : 'Raise the certificate now?'}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Challan {challan.Challan_No} is issued.{' '}
                  {certPrompt.types.length > 1
                    ? `This delivery needs ${certPrompt.types.length} certificates — create them one at a time.`
                    : `${certPrompt.types[0].count} line${certPrompt.types[0].count > 1 ? 's' : ''} need a ${certPrompt.types[0].formatType} certificate — the details carry over automatically.`}
                </p>
              </div>
            </div>
            {/* Stacked, not side by side: two 48px buttons plus Later cannot fit a 320px screen. */}
            <div className="space-y-2 pt-1">
              {certPrompt.types.map(t => (
                <button
                  key={t.formatType}
                  onClick={() => navigate(`/certificate-compliance/new?challanId=${challan.Challan_ID}&formatType=${encodeURIComponent(t.formatType)}`)}
                  className="w-full min-h-[48px] px-3 rounded-xl bg-indigo-600 text-white text-xs font-extrabold active:bg-indigo-700 flex items-center justify-between gap-2"
                >
                  <span>{t.formatType} certificate</span>
                  <span className="opacity-70 shrink-0">{t.count} line{t.count > 1 ? 's' : ''}</span>
                </button>
              ))}
              <button
                onClick={() => setCertPrompt(null)}
                className="jc-btn-ghost w-full border border-slate-200 rounded-xl"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Off-screen A4 capture node. Parked far off-canvas rather than display:none, because
          html2canvas cannot measure a node with no layout box. Same template as the invoice, with
          docType CHALLAN gating the money columns. */}
      <div style={{ position: 'fixed', left: '-10000px', top: 0, zIndex: -1 }} aria-hidden="true">
        <QuotationPdfTemplate
          ref={pdfRef}
          doc={challan}
          docType="CHALLAN"
          settings={settings}
          tncItems={[]}
        />
      </div>
    </div>
  );
}

/**
 * Was a hand-rolled list capped at 8 rows in a 160px box, searching Item_Name only. On a catalogue
 * of hundreds that meant the item you wanted usually was not on screen and there was no way to tell.
 * Now the shared picker: matches HSN and category too, in any word order, and expands full-screen.
 */
function ItemPicker({ items, onPick, onClose }) {
  const active = useMemo(
    () => items.filter(i => i.Active !== false && !i.Is_Deleted),
    [items]
  );

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-white p-2 space-y-1.5">
      <SmartSearchSelect
        options={active}
        value={null}
        onChange={row => { if (row) onPick(row); }}
        expandable
        expandedTitle="Select an item"
        placeholder="Search item name or HSN…"
        getKey={i => i.Item_ID}
        getLabel={i => i.Item_Name}
        getSubtitle={i => [i.Category, i.HSN_Code ? `HSN ${i.HSN_Code}` : '', i.Unit || 'Nos'].filter(Boolean).join(' · ')}
        getSearchable={i => [i.Item_Name, i.Category, i.HSN_Code, ...(i.Aliases || [])]}
        emptyText="Nothing matches. Add it in Items & Inventory first."
      />
      <button onClick={onClose} className="jc-btn-ghost w-full">Cancel</button>
    </div>
  );
}
