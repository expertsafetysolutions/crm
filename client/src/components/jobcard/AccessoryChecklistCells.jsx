import React from 'react';
import { CHECKPOINT_OK, CHECKPOINT_NOT_OK } from '../../utils/jobCardSchema';

/**
 * The tap-to-toggle accessory checklist.
 *
 * Two states only, and the default is OK — a technician marks the exceptions, not the norm, so ten
 * cylinders in good order cost zero taps. NOT OK is deliberately loud: each one becomes a part that
 * must be fitted or explicitly refused before a challan can be raised.
 */
export default function AccessoryChecklistCells({ columns = [], values = {}, disabled = false, onChange }) {
  const checkpoints = columns.filter(c => c.type === 'checkpoint');
  if (checkpoints.length === 0) return null;

  const toggle = (id) => {
    const current = values[id] || CHECKPOINT_OK;
    onChange({ ...values, [id]: current === CHECKPOINT_OK ? CHECKPOINT_NOT_OK : CHECKPOINT_OK });
  };

  return (
    <div>
      <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-1">
        Accessories — tap to mark not ok
      </span>
      <div className="grid grid-cols-2 gap-1.5">
        {checkpoints.map(cp => {
          const notOk = (values[cp.id] || CHECKPOINT_OK) === CHECKPOINT_NOT_OK;
          return (
            <button
              key={cp.id}
              type="button"
              onClick={() => toggle(cp.id)}
              disabled={disabled}
              className={`min-h-[44px] px-2 rounded-xl text-[11px] font-bold border text-left transition disabled:opacity-60 ${
                notOk
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : 'bg-emerald-50/60 border-emerald-200 text-emerald-800'
              }`}
            >
              <span className="block truncate">{cp.label}</span>
              <span className={`block text-[9px] font-extrabold ${notOk ? 'text-rose-600' : 'text-emerald-600'}`}>
                {notOk ? 'NOT OK' : 'OK'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
