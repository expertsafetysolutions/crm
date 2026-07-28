import React, { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { newLineId } from '../../utils/jobCardSchema';

/**
 * PartsFittedEditor — records what actually went into one cylinder.
 *
 * The parts flagged NOT OK at inward are offered as one-tap chips, since fitting exactly what was
 * flagged is the overwhelmingly common case. Anything else is picked from Item_Master by typeahead.
 *
 * lineId is generated here, on the device, before the request leaves: it is what makes a replayed
 * offline action a no-op instead of fitting the same part twice.
 */
export default function PartsFittedEditor({ item, issues = [], itemMaster = [], onAdd, onRemove, readOnly = false }) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [qty, setQty] = useState(1);

  const parts = item.Parts_Fitted || [];

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return itemMaster.slice(0, 8);
    return itemMaster
      .filter(i => String(i.Item_Name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, itemMaster]);

  /** Resolves a part name against Item_Master so stock can be consumed when it maps to a real item. */
  const resolveItem = (name) => itemMaster.find(
    i => String(i.Item_Name || '').trim().toLowerCase() === String(name).trim().toLowerCase()
  );

  const addFromIssue = (issue) => {
    const master = resolveItem(issue.suggestedPart);
    onAdd([{
      lineId: newLineId(),
      Item_ID: master?.Item_ID || '',
      Item_Name: master?.Item_Name || issue.suggestedPart,
      Qty: 1,
      Unit: master?.Unit || 'Nos',
      source: 'CHECKLIST',
      checkpointId: issue.checkpointId
    }]);
  };

  const addFromMaster = (master) => {
    onAdd([{
      lineId: newLineId(),
      Item_ID: master.Item_ID,
      Item_Name: master.Item_Name,
      Qty: Number(qty) || 1,
      Unit: master.Unit || 'Nos',
      source: 'EXTRA',
      checkpointId: ''
    }]);
    setPicking(false);
    setQuery('');
    setQty(1);
  };

  const pendingIssues = issues.filter(i => !i.partFitted);

  return (
    <div className="space-y-2">
      <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
        Parts fitted
      </span>

      {parts.length === 0 && !picking && (
        <p className="text-[11px] text-slate-400">Nothing fitted yet.</p>
      )}

      {parts.map(p => (
        <div key={p.lineId} className="flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-200 px-2.5 py-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-slate-800 truncate">{p.Item_Name}</p>
            <p className="text-[10px] text-slate-500">
              {p.Qty} {p.Unit}
              {p.source === 'CHECKLIST' && <span className="text-emerald-600 font-bold"> · from checklist</span>}
              {p.Inventory_Error && <span className="text-amber-600 font-bold"> · stock not updated</span>}
            </p>
          </div>
          {!readOnly && (
            <button
              onClick={() => onRemove(p.lineId)}
              className="w-8 h-8 rounded-lg flex items-center justify-center active:bg-slate-200 shrink-0"
              aria-label={`Remove ${p.Item_Name}`}
            >
              <X className="w-3.5 h-3.5 text-slate-400" />
            </button>
          )}
        </div>
      ))}

      {!readOnly && pendingIssues.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingIssues.map(i => (
            <button
              key={i.checkpointId}
              onClick={() => addFromIssue(i)}
              className="min-h-[36px] px-2.5 rounded-xl bg-white border border-indigo-300 text-indigo-700 text-[11px] font-extrabold active:bg-indigo-50"
            >
              + {i.suggestedPart}
            </button>
          ))}
        </div>
      )}

      {!readOnly && !picking && (
        <button
          onClick={() => setPicking(true)}
          className="jc-btn-ghost w-full min-h-[44px]"
        >
          <Plus className="w-3.5 h-3.5" /> Add other part
        </button>
      )}

      {picking && (
        <div className="rounded-xl border border-slate-200 bg-white p-2 space-y-2">
          <div className="flex gap-2">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search item master…"
              className="jc-input flex-1"
            />
            <input
              type="number"
              min="1"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="jc-input w-16 text-center"
              aria-label="Quantity"
            />
          </div>
          <div className="max-h-44 overflow-y-auto space-y-1">
            {matches.map(m => (
              <button
                key={m.Item_ID}
                onClick={() => addFromMaster(m)}
                className="w-full min-h-[40px] px-2.5 rounded-lg text-left text-xs font-bold text-slate-700 active:bg-slate-100 flex items-center justify-between gap-2"
              >
                <span className="truncate">{m.Item_Name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{m.Unit || 'Nos'}</span>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="text-[11px] text-slate-400 text-center py-3">No matching item in the catalogue.</p>
            )}
          </div>
          <button onClick={() => { setPicking(false); setQuery(''); }} className="jc-btn-ghost w-full">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
