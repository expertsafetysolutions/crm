import React, { useState } from 'react';
import { ChevronUp, ChevronDown, Trash2, Plus } from 'lucide-react';
import { newCustomColumnId } from '../../utils/certificateColumns';

/**
 * Per-certificate-type equipment table column editor, used inline in the certificate
 * page's own Settings tab (already scoped to the active certForm.formatType — unlike
 * ReportTypeChecklistEditor this has no type-tab picker of its own).
 *
 * Base columns (sr_no/item_name/capacity/qty/refill_date/valid_until) can be toggled
 * on/off and reordered but never removed. Custom columns can also be removed.
 */
export default function CertificateColumnEditor({ columns, onChange }) {
  const [newLabel, setNewLabel] = useState('');
  const list = columns || [];

  const toggleColumn = (idx) => onChange(list.map((c, i) => (i === idx ? { ...c, enabled: !c.enabled } : c)));

  const renameColumn = (idx, label) => onChange(list.map((c, i) => (i === idx ? { ...c, label } : c)));

  const moveColumn = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  const removeColumn = (idx) => onChange(list.filter((_, i) => i !== idx));

  const addCustomColumn = () => {
    if (!newLabel.trim()) return;
    onChange([...list, { id: newCustomColumnId(), label: newLabel.trim(), enabled: true, custom: true }]);
    setNewLabel('');
  };

  return (
    <div className="space-y-2">
      {list.map((col, idx) => (
        <div key={col.id} className={`flex items-center gap-2 rounded-lg border p-2 ${col.enabled ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-200 opacity-60'}`}>
          <button
            type="button"
            role="switch"
            aria-checked={col.enabled}
            onClick={() => toggleColumn(idx)}
            className={`shrink-0 w-8 h-4.5 rounded-full transition relative ${col.enabled ? 'bg-emerald-600' : 'bg-slate-300'}`}
            title={col.enabled ? 'On — shown on certificate & entry form' : 'Off — hidden'}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 bg-white rounded-full transition-all ${col.enabled ? 'left-4' : 'left-0.5'}`} />
          </button>
          <input
            type="text"
            value={col.label}
            onChange={e => renameColumn(idx, e.target.value)}
            className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
            placeholder="Column name"
          />
          {col.custom && (
            <span className="shrink-0 text-[9px] font-bold text-indigo-500 uppercase">Custom</span>
          )}
          <div className="shrink-0 flex items-center gap-0.5">
            <button type="button" onClick={() => moveColumn(idx, -1)} disabled={idx === 0} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
            <button type="button" onClick={() => moveColumn(idx, 1)} disabled={idx === list.length - 1} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
            {col.custom && (
              <button type="button" onClick={() => removeColumn(idx)} className="p-1 text-slate-300 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
            )}
          </div>
        </div>
      ))}

      <div className="flex gap-2 pt-1">
        <input
          type="text"
          placeholder="Column Label (e.g. Working Pressure)"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          className="flex-1 px-2.5 py-1.5 bg-white border border-indigo-300 rounded-lg text-xs font-medium focus:outline-none"
        />
        <button
          type="button"
          disabled={!newLabel.trim()}
          onClick={addCustomColumn}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 transition"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>
    </div>
  );
}
