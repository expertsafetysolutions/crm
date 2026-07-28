import React, { useState } from 'react';
import { X, Plus, Trash2, Loader2 } from 'lucide-react';
import EuidScanner from '../EuidScanner';

/**
 * StandbyIssueModal — lends the customer a working extinguisher while theirs is on our bench.
 *
 * Each unit is entered by its own EUID rather than as a count, because getting them back is the
 * whole point and a count cannot say WHICH cylinder is still out. The gate-pass number is optional:
 * the server mints one when it is left blank, so nothing is ever handed over unidentified, but an
 * office copying from a paper gate-pass book can type theirs and have it kept.
 */
export default function StandbyIssueModal({ categories = [], onIssue, onClose, busy = false }) {
  const [rows, setRows] = useState([{ EUID_No: '', Equipment_Type: '', Capacity: '', gatePassNo: '' }]);
  const [error, setError] = useState('');

  const update = (i, patch) => setRows(rs => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows(rs => [...rs, {
    EUID_No: '',
    // Carry the previous row's type and capacity — loaners go out in matched sets far more often
    // than not, and retyping them for each cylinder is the slow path.
    Equipment_Type: rs[rs.length - 1]?.Equipment_Type || '',
    Capacity: rs[rs.length - 1]?.Capacity || '',
    gatePassNo: ''
  }]);
  const removeRow = (i) => setRows(rs => (rs.length === 1 ? rs : rs.filter((_, n) => n !== i)));

  const submit = async () => {
    const units = rows.filter(r => String(r.EUID_No || '').trim());
    if (units.length === 0) return setError('Enter at least one EUID number');

    const seen = new Set();
    for (const u of units) {
      const key = u.EUID_No.trim().toUpperCase();
      if (seen.has(key)) return setError(`${u.EUID_No} is listed twice`);
      seen.add(key);
    }

    setError('');
    try {
      await onIssue(units);
    } catch (e) {
      setError(e.message || 'Could not issue the standby units');
    }
  };

  const capacities = categories.find(c => c.Code === rows[0]?.Equipment_Type)?.Capacities || [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900">Issue standby units</p>
            <p className="text-[11px] text-slate-500">Loaners left with the customer while we work</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center active:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-[11px] font-bold text-rose-800">
              {error}
            </div>
          )}

          {rows.map((row, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
                  Unit {i + 1}
                </span>
                {rows.length > 1 && (
                  <button onClick={() => removeRow(i)} aria-label={`Remove unit ${i + 1}`}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 active:bg-rose-50 active:text-rose-600">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <EuidScanner value={row.EUID_No} onChange={v => update(i, { EUID_No: v })} disabled={busy} />

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Type</span>
                  <select className="jc-input" value={row.Equipment_Type} disabled={busy}
                    onChange={e => update(i, { Equipment_Type: e.target.value })}>
                    <option value="">—</option>
                    {categories.map(c => <option key={c.Code} value={c.Code}>{c.Label || c.Code}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Capacity</span>
                  <input className="jc-input" value={row.Capacity} disabled={busy} list={`cap-${i}`}
                    onChange={e => update(i, { Capacity: e.target.value })} placeholder="6kg" />
                  <datalist id={`cap-${i}`}>
                    {capacities.map(c => <option key={c} value={c} />)}
                  </datalist>
                </label>
              </div>

              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
                  Gate pass no <span className="font-medium normal-case tracking-normal">— leave blank to generate</span>
                </span>
                <input className="jc-input" value={row.gatePassNo} disabled={busy}
                  onChange={e => update(i, { gatePassNo: e.target.value })} placeholder="From your gate pass book" />
              </label>
            </div>
          ))}

          <button onClick={addRow} disabled={busy} className="jc-btn-ghost w-full border border-dashed border-slate-300 rounded-xl">
            <Plus className="w-3.5 h-3.5" /> Add another unit
          </button>
        </div>

        <div className="px-4 py-3 border-t border-slate-200 flex gap-2">
          <button onClick={onClose} disabled={busy}
            className="flex-1 min-h-[44px] rounded-xl border border-slate-300 text-xs font-extrabold text-slate-600 active:bg-slate-50">
            Cancel
          </button>
          <button onClick={submit} disabled={busy}
            className="flex-1 min-h-[44px] rounded-xl bg-slate-900 text-white text-xs font-extrabold active:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Issue &amp; print gate pass
          </button>
        </div>
      </div>
    </div>
  );
}
