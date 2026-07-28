import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { RECHECK, RECHECK_LABELS } from '../../utils/jobCardSchema';

/**
 * FinalRecheckModal — the gate between "we noticed the safety pin was missing" and handing the
 * cylinder back without one.
 *
 * Every checkpoint flagged NOT OK at inward must be answered before the job card can close. Client
 * refusal is allowed — the customer is entitled to decline — but it demands a written reason,
 * because that is the one outcome where equipment leaves with a known defect and the business needs
 * a record of who accepted that. The server enforces the same rule; this is the humane version.
 */
export default function FinalRecheckModal({ pending = [], onSubmit, onClose, busy = false }) {
  const [answers, setAnswers] = useState(() => {
    const seed = {};
    for (const p of pending) {
      const key = `${p.Job_Card_Item_ID}::${p.checkpointId}`;
      // Where a part was already fitted the answer is self-evident, so it starts filled in.
      seed[key] = { resolution: p.partAlreadyFitted ? RECHECK.FITTED : '', reason: '' };
    }
    return seed;
  });

  const setAnswer = (key, patch) => setAnswers(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const missing = pending.filter(p => {
    const a = answers[`${p.Job_Card_Item_ID}::${p.checkpointId}`];
    if (!a?.resolution) return true;
    return a.resolution === RECHECK.CLIENT_REFUSED && !a.reason.trim();
  });

  const submit = () => {
    if (missing.length > 0) return;
    onSubmit(pending.map(p => {
      const a = answers[`${p.Job_Card_Item_ID}::${p.checkpointId}`];
      return {
        Job_Card_Item_ID: p.Job_Card_Item_ID,
        checkpointId: p.checkpointId,
        resolution: a.resolution,
        reason: a.reason
      };
    }));
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl max-h-[88vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <span className="w-8 h-8 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900">Confirm inward issues</p>
            <p className="text-[11px] text-slate-500">
              {pending.length} item{pending.length > 1 ? 's were' : ' was'} marked NOT OK on arrival
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center active:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {pending.map(p => {
            const key = `${p.Job_Card_Item_ID}::${p.checkpointId}`;
            const a = answers[key] || { resolution: '', reason: '' };
            return (
              <div key={key} className="rounded-xl border border-slate-200 p-2.5 space-y-2">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="text-xs font-extrabold text-slate-900 truncate">{p.checkpointLabel}</span>
                  <span className="text-[11px] text-slate-500 truncate">
                    · {p.equipmentLabel} ({p.equipmentType} {p.capacity})
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {Object.values(RECHECK).map(option => (
                    <button
                      key={option}
                      onClick={() => setAnswer(key, { resolution: option })}
                      className={`min-h-[44px] px-1 rounded-xl text-[11px] font-extrabold border transition ${
                        a.resolution === option
                          ? option === RECHECK.CLIENT_REFUSED
                            ? 'bg-rose-600 border-rose-600 text-white'
                            : 'bg-emerald-600 border-emerald-600 text-white'
                          : 'bg-white border-slate-200 text-slate-500'
                      }`}
                    >
                      {RECHECK_LABELS[option]}
                    </button>
                  ))}
                </div>

                {p.partAlreadyFitted && a.resolution === RECHECK.FITTED && (
                  <p className="text-[10px] font-bold text-emerald-600">A part was already recorded for this.</p>
                )}

                {a.resolution === RECHECK.CLIENT_REFUSED && (
                  <input
                    autoFocus
                    value={a.reason}
                    onChange={e => setAnswer(key, { reason: e.target.value })}
                    placeholder="Why did the client refuse? (required)"
                    className="w-full min-h-[44px] px-2.5 rounded-xl border border-rose-300 bg-rose-50/50 text-xs font-bold placeholder:font-normal placeholder:text-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div
          className="px-4 py-3 border-t border-slate-200"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <button
            onClick={submit}
            disabled={missing.length > 0 || busy}
            className="w-full min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold active:bg-slate-800 disabled:opacity-40"
          >
            {missing.length > 0 ? `${missing.length} still to answer` : 'Confirm & finish'}
          </button>
        </div>
      </div>
    </div>
  );
}
