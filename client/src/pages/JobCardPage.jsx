import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, WifiOff, FileText, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { enqueueOfflineAction } from '../utils/offlineQueue';
import { resolveJobCardColumns } from '../utils/reportTypeSchemas';
import {
  newJobCardItemId, normalizeCapacity, summarizeJobCard, formatSummaryLine, isInwardRowComplete
} from '../utils/jobCardSchema';
import JobCardInwardTab from '../components/jobcard/JobCardInwardTab';
import JobCardServiceTab from '../components/jobcard/JobCardServiceTab';
import FinalRecheckModal from '../components/jobcard/FinalRecheckModal';

/**
 * JobCardPage — the workshop's view of one task's equipment, from arrival to ready-for-delivery.
 *
 * Two tabs because the two jobs happen days apart and often on different devices: INWARD is the
 * intake sweep done once when the equipment lands, SERVICE is the incremental part-fitting spread
 * over the following four or five days, reached by searching for a cylinder number.
 *
 * Every mutation is offline-tolerant. Rows and fitted parts carry client-generated ids, so a queued
 * action replayed after a partial flush updates what it created rather than duplicating it.
 */

const TABS = [
  { id: 'INWARD', label: 'Inward' },
  { id: 'SERVICE', label: 'Service' }
];

export default function JobCardPage() {
  const { taskId, jobCardId } = useParams();
  const navigate = useNavigate();
  const { token, isOnline } = useAuth();

  const [card, setCard] = useState(null);
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [itemMaster, setItemMaster] = useState([]);
  const [activeTab, setActiveTab] = useState('INWARD');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recheck, setRecheck] = useState(null);

  const headers = useMemo(
    () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
    [token]
  );

  const summary = useMemo(() => summarizeJobCard(items), [items]);

  // Columns per category, resolved once — every row renders through the same engine the service
  // reports use, so a category an admin adds later needs no code here.
  const columnsByCode = useMemo(() => {
    const out = {};
    for (const cat of categories) out[String(cat.Code).toUpperCase()] = resolveJobCardColumns(cat);
    return out;
  }, [categories]);

  const loadCard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const path = jobCardId
        ? `/api/job-cards/${encodeURIComponent(jobCardId)}`
        : `/api/job-cards/by-task/${encodeURIComponent(taskId)}`;
      const res = await fetch(path, { headers });

      if (res.status === 404 && taskId) {
        // No card yet for this task — create it, which is what tapping the button means.
        const created = await fetch('/api/job-cards', {
          method: 'POST', headers, body: JSON.stringify({ taskId })
        });
        if (!created.ok) throw new Error((await created.json()).error || 'Could not create job card');
        const newCard = await created.json();
        setCard(newCard);
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error || 'Could not load job card');

      const data = await res.json();
      setCard(data.card);
      setItems(data.items || []);
      if ((data.items || []).length > 0 && data.card?.Status !== 'Inward') setActiveTab('SERVICE');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [headers, jobCardId, taskId]);

  useEffect(() => { loadCard(); }, [loadCard]);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      fetch('/api/equipment-categories', { headers }).then(r => (r.ok ? r.json() : [])),
      fetch('/api/items', { headers }).then(r => (r.ok ? r.json() : []))
    ])
      .then(([cats, its]) => {
        setCategories(Array.isArray(cats) ? cats : []);
        setItemMaster(Array.isArray(its) ? its : []);
      })
      .catch(() => { /* the page still works with the built-in fallbacks */ });
  }, [headers, token]);

  // ─── ITEM WRITES ────────────────────────────────────────────────────────────────────────────

  /**
   * Saves inward rows. Offline the row is queued and shown immediately: a technician standing at
   * the bench must see their own work, and the id they generated is what makes the later replay
   * an update rather than a second cylinder.
   */
  const saveItems = async (rows) => {
    if (!card || rows.length === 0) return;
    setBusy(true);
    try {
      const prepared = rows.map(r => ({
        ...r,
        Job_Card_Item_ID: r.Job_Card_Item_ID || newJobCardItemId(),
        Job_Card_ID: card.Job_Card_ID,
        Capacity: normalizeCapacity(r.Capacity)
      }));

      if (!isOnline) {
        for (const row of prepared) await enqueueOfflineAction('JOB_CARD_ITEM_UPSERT', row);
        setItems(prev => {
          const byId = new Map(prev.map(p => [p.Job_Card_Item_ID, p]));
          prepared.forEach(p => byId.set(p.Job_Card_Item_ID, { ...byId.get(p.Job_Card_Item_ID), ...p }));
          return [...byId.values()];
        });
        return;
      }

      const isNew = prepared.filter(r => !items.some(i => i.Job_Card_Item_ID === r.Job_Card_Item_ID));
      const existing = prepared.filter(r => items.some(i => i.Job_Card_Item_ID === r.Job_Card_Item_ID));

      if (isNew.length > 0) {
        const res = await fetch(`/api/job-cards/${card.Job_Card_ID}/items`, {
          method: 'POST', headers, body: JSON.stringify({ items: isNew })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Could not save items');
      }
      for (const row of existing) {
        await fetch(`/api/job-cards/items/${row.Job_Card_Item_ID}`, {
          method: 'PUT', headers, body: JSON.stringify(row)
        });
      }
      await loadCard();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (itemId) => {
    if (!window.confirm('Remove this equipment from the job card?')) return;
    setBusy(true);
    try {
      await fetch(`/api/job-cards/items/${itemId}`, { method: 'DELETE', headers });
      setItems(prev => prev.filter(i => i.Job_Card_Item_ID !== itemId));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  /** Fits parts onto one cylinder. lineId comes from the caller and is the replay guard. */
  const addParts = async (itemId, parts) => {
    setBusy(true);
    try {
      if (!isOnline) {
        await enqueueOfflineAction('JOB_CARD_PARTS_ADD', {
          jobCardItemId: itemId,
          parts,
          consumeStock: true,
          // The technician's own date, so a Friday fit synced on Monday still lands in Friday's
          // consumption figures.
          date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
        });
        setItems(prev => prev.map(i => (
          i.Job_Card_Item_ID === itemId
            ? { ...i, Parts_Fitted: [...(i.Parts_Fitted || []), ...parts] }
            : i
        )));
        return;
      }
      const res = await fetch(`/api/job-cards/items/${itemId}/parts`, {
        method: 'POST', headers, body: JSON.stringify({ parts })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not add parts');
      const saved = await res.json();
      setItems(prev => prev.map(i => (i.Job_Card_Item_ID === itemId ? saved : i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removePart = async (itemId, lineId) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/job-cards/items/${itemId}/parts/${lineId}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not remove part');
      const saved = await res.json();
      setItems(prev => prev.map(i => (i.Job_Card_Item_ID === itemId ? saved : i)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateItem = async (itemId, patch) => {
    setItems(prev => prev.map(i => (i.Job_Card_Item_ID === itemId ? { ...i, ...patch } : i)));
    if (!isOnline) {
      await enqueueOfflineAction('JOB_CARD_ITEM_UPSERT', { Job_Card_Item_ID: itemId, Job_Card_ID: card.Job_Card_ID, ...patch });
      return;
    }
    await fetch(`/api/job-cards/items/${itemId}`, { method: 'PUT', headers, body: JSON.stringify(patch) });
  };

  // ─── COMPLETION ─────────────────────────────────────────────────────────────────────────────

  /**
   * Finishing opens the recheck first when anything flagged NOT OK at inward is still unresolved —
   * that gate is the difference between noticing a missing safety pin and handing the cylinder back
   * without one. The server enforces it too; this only saves a round trip.
   */
  const finishService = async () => {
    setBusy(true);
    setError('');
    try {
      const pendingRes = await fetch(`/api/job-cards/${card.Job_Card_ID}/pending-rechecks`, { headers });
      const pending = pendingRes.ok ? await pendingRes.json() : [];
      if (pending.length > 0) {
        setRecheck(pending);
        return;
      }
      const res = await fetch(`/api/job-cards/${card.Job_Card_ID}/complete`, { method: 'POST', headers });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.pendingRechecks) { setRecheck(data.pendingRechecks); return; }
        throw new Error(data.error || 'Could not complete job card');
      }
      setCard(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitRecheck = async (resolutions) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/job-cards/${card.Job_Card_ID}/recheck`, {
        method: 'POST', headers, body: JSON.stringify({ resolutions })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save the recheck');
      setRecheck(null);
      await loadCard();
      await finishService();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // ─── RENDER ─────────────────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading job card…</div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
        <p className="text-sm font-bold text-rose-600">{error || 'Job card not found'}</p>
        <button onClick={() => navigate(-1)} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold">
          Go back
        </button>
      </div>
    );
  }

  const isComplete = ['ServiceComplete', 'Challan_Drafted', 'Challan_Issued', 'Closed'].includes(card.Status);
  const completeCount = items.filter(isInwardRowComplete).length;

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900 truncate">
              {card.Customer_Name_Snapshot || 'Job Card'}
            </p>
            <p className="text-[11px] text-slate-500 truncate">
              {card.Job_Card_ID} · {formatSummaryLine(summary)}
            </p>
          </div>
          {!isOnline && (
            <span className="shrink-0 px-2 py-1 rounded-lg bg-amber-100 text-amber-800 text-[10px] font-extrabold flex items-center gap-1">
              <WifiOff className="w-3 h-3" /> Offline
            </span>
          )}
          {isComplete && (
            <span className="shrink-0 px-2 py-1 rounded-lg bg-emerald-100 text-emerald-800 text-[10px] font-extrabold">
              {card.Status === 'ServiceComplete' ? 'Ready' : card.Status}
            </span>
          )}
        </div>

        <div className="max-w-4xl mx-auto px-3 pb-2 flex gap-2">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-h-[40px] rounded-xl text-xs font-extrabold transition ${
                activeTab === tab.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 active:bg-slate-200'
              }`}
            >
              {tab.label}
              {tab.id === 'INWARD' && items.length > 0 && (
                <span className="ml-1.5 opacity-70">{completeCount}/{items.length}</span>
              )}
            </button>
          ))}
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

      <main className="max-w-4xl mx-auto px-3 py-3">
        {activeTab === 'INWARD' ? (
          <JobCardInwardTab
            items={items}
            categories={categories}
            columnsByCode={columnsByCode}
            onSave={saveItems}
            onDelete={deleteItem}
            readOnly={isComplete}
          />
        ) : (
          <JobCardServiceTab
            items={items}
            categories={categories}
            columnsByCode={columnsByCode}
            itemMaster={itemMaster}
            onAddParts={addParts}
            onRemovePart={removePart}
            onUpdateItem={updateItem}
            readOnly={isComplete}
          />
        )}
      </main>

      {/* Sticky action bar — thumb-reachable, padded clear of the phone's home indicator. */}
      <div
        className="fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="max-w-4xl mx-auto px-3 py-2 flex items-center gap-2">
          {isComplete ? (
            <button
              onClick={() => navigate(`/challans/new/${card.Job_Card_ID}`)}
              className="flex-1 min-h-[48px] rounded-xl bg-indigo-600 text-white text-sm font-extrabold flex items-center justify-center gap-2 active:bg-indigo-700"
            >
              <FileText className="w-4 h-4" />
              {card.Linked_Challan_IDs?.length > 0 ? 'Open Delivery Challan' : 'Create Delivery Challan'}
            </button>
          ) : (
            <>
              <button
                onClick={loadCard}
                disabled={busy}
                className="w-12 min-h-[48px] rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 disabled:opacity-40"
                aria-label="Refresh"
              >
                <RefreshCw className={`w-4 h-4 text-slate-500 ${busy ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={finishService}
                disabled={busy || items.length === 0}
                className="flex-1 min-h-[48px] rounded-xl bg-emerald-600 text-white text-sm font-extrabold flex items-center justify-center gap-2 active:bg-emerald-700 disabled:opacity-40"
              >
                <CheckCircle2 className="w-4 h-4" />
                Finish Service
              </button>
            </>
          )}
        </div>
      </div>

      {recheck && (
        <FinalRecheckModal
          pending={recheck}
          itemMaster={itemMaster}
          onSubmit={submitRecheck}
          onClose={() => setRecheck(null)}
          busy={busy}
        />
      )}
    </div>
  );
}
