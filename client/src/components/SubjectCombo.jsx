import React, { useState, useEffect, useRef } from 'react';
import { Plus, Edit3, Trash2 } from 'lucide-react';
import { matchesQuery } from '../utils/searchUtils';

/**
 * Subject field: a free-text input with a type-to-filter dropdown of saved suggestions.
 *
 * Deliberately NOT a <select> — an unusual subject must still be typeable without an Admin first
 * editing Quotation Settings, so the typed value is always authoritative and the list only offers
 * shortcuts. Options come from settings.subject_options.
 *
 * Blur closes the list on a timeout rather than immediately: a mousedown on an option fires blur
 * before click, so closing synchronously would unmount the option before its click registers.
 */
export default function SubjectCombo({ value, onChange, options, disabled, onCreate, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState(null);
  const closeTimer = useRef(null);

  // Only the per-ROW actions. onCreate is excluded on purpose: a caller that can add but not edit
  // (the PO builder, which defers list management to Quotation Settings) would otherwise render an
  // empty action column against every row.
  const canManage = !!(onRename || onDelete);
  const query = String(value || '').toLowerCase().trim();
  // Rows keep their id so edit/delete can address them; a plain string list could only match on
  // text, which breaks the moment someone renames a subject to something already typed elsewhere.
  const rows = (options || [])
    .map(o => (typeof o === 'string' ? { id: o, text: o } : o))
    .filter(o => o && o.text);
  const exact = rows.some(o => o.text.toLowerCase() === query);
  const filtered = query && !exact ? rows.filter(o => matchesQuery(query, [o.text])) : rows;
  // Offer to save whatever has been typed, as long as it is not already on the list.
  const canCreate = !!onCreate && query.length > 0 && !exact;

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Any row-level action keeps the panel open — blur would otherwise close it mid-edit.
  const hold = () => clearTimeout(closeTimer.current);
  const run = async (id, fn) => {
    setBusyId(id);
    try { await fn(); } finally { setBusyId(null); }
  };

  return (
    <div className="relative">
      <div className="qt-field flex items-center">
        <input
          value={value ?? ''}
          disabled={disabled}
          placeholder=" "
          autoComplete="off"
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { closeTimer.current = setTimeout(() => setOpen(false), 160); }}
          className="qt-input"
        />
        <label>Subject</label>
        {canCreate && !disabled && (
          <button
            type="button"
            title={`Save “${String(value).trim()}” as a reusable subject`}
            onMouseDown={e => { e.preventDefault(); hold(); }}
            onClick={() => run('new', async () => { await onCreate(String(value).trim()); setOpen(true); })}
            className="shrink-0 w-8 h-8 mr-1 rounded-lg bg-slate-900 text-white flex items-center justify-center active:bg-slate-700 disabled:opacity-40"
            disabled={busyId === 'new'}
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {open && !disabled && (filtered.length > 0 || canCreate) && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto">
          {canCreate && (
            <button
              type="button"
              onMouseDown={e => { e.preventDefault(); hold(); }}
              onClick={() => run('new', async () => { await onCreate(String(value).trim()); setOpen(false); })}
              className="w-full text-left px-3 py-2.5 text-sm font-bold text-slate-700 bg-slate-50 border-b border-slate-200 flex items-center gap-2 active:bg-slate-100"
            >
              <Plus className="w-3.5 h-3.5" />
              Add “{String(value).trim()}” to the list
            </button>
          )}

          {filtered.map(row => (
            <div key={row.id} className="flex items-center gap-1 border-b border-slate-100 last:border-0">
              {editingId === row.id ? (
                <div className="flex-1 flex items-center gap-1 p-1.5" onMouseDown={hold}>
                  <input
                    value={draft}
                    autoFocus
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="qt-cell flex-1"
                  />
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); hold(); }}
                    onClick={() => run(row.id, async () => {
                      const next = draft.trim();
                      // Renaming the subject currently in the box keeps them in step, so the
                      // document does not silently keep the old wording.
                      if (next && next !== row.text) {
                        await onRename(row.id, next);
                        if (String(value || '').trim() === row.text) onChange(next);
                      }
                      setEditingId(null);
                    })}
                    disabled={busyId === row.id}
                    className="px-2 h-8 rounded-lg bg-slate-900 text-white text-[11px] font-bold disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onMouseDown={e => { e.preventDefault(); hold(); }}
                    onClick={() => setEditingId(null)}
                    className="px-2 h-8 rounded-lg border border-slate-200 text-slate-600 text-[11px] font-bold"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { onChange(row.text); setOpen(false); }}
                    className="flex-1 text-left px-3 py-2.5 text-sm hover:bg-slate-50 active:bg-slate-100"
                  >
                    {row.text}
                  </button>
                  {canManage && (
                    <div className="flex items-center gap-0.5 pr-1.5 shrink-0">
                      {onRename && (
                        <button
                          type="button"
                          title="Rename this subject"
                          onMouseDown={e => { e.preventDefault(); hold(); }}
                          onClick={() => { setEditingId(row.id); setDraft(row.text); }}
                          className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          title="Remove from the list"
                          onMouseDown={e => { e.preventDefault(); hold(); }}
                          onClick={() => run(row.id, () => onDelete(row.id, row.text))}
                          disabled={busyId === row.id}
                          className="w-8 h-8 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
