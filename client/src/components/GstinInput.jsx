import React from 'react';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { parseGstin, stateOptions } from '../utils/gstinUtils';

/**
 * GSTIN field with live offline validation.
 *
 * Validates the check digit as the user types and auto-fills the state code / entity type, so a
 * mistyped GSTIN is caught before it can reach an invoice — all without any paid API.
 *
 * Company name and address are not auto-filled: that data exists only on the GST portal, which has
 * no free public API. Wiring a paid provider later would only need an extra fetch here.
 *
 * Touch-friendly by default: inputs use a 16px font so iOS doesn't zoom on focus, and the state
 * picker is a native <select> so mobile shows its own wheel UI.
 */
export default function GstinInput({
  gstin,
  stateCode,
  onChange,          // ({ gstin, stateCode, customerType, stateName }) => void
  showStateField = true,
  disabled = false,
  loading = false,
  label = 'GSTIN',
  compact = false
}) {
  const parsed = parseGstin(gstin);
  const hasInput = (gstin || '').length > 0;

  const emit = (nextGstin, nextStateCode) => {
    const p = parseGstin(nextGstin);
    onChange({
      gstin: p.gstin,
      // A complete GSTIN always wins over a manually chosen state — they must not disagree.
      stateCode: p.stateCode || nextStateCode || '',
      stateName: p.stateName,
      customerType: p.gstin ? 'B2B' : 'B2C',
      valid: p.valid
    });
  };

  const borderClass = !hasInput
    ? 'border-slate-300'
    : parsed.valid
      ? 'border-emerald-400 bg-emerald-50/40'
      : parsed.complete
        ? 'border-rose-400 bg-rose-50/40'
        : 'border-amber-300';

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-bold text-slate-600 uppercase mb-1">
          {label}
          <span className="ml-1 font-normal normal-case text-slate-400">(optional — leave blank for B2C)</span>
        </label>
        <div className="relative">
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={15}
            disabled={disabled}
            value={gstin || ''}
            onChange={e => emit(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''), stateCode)}
            placeholder="24AAACC1206D1ZM"
            /* 16px min font-size stops iOS Safari zooming in when the field is focused */
            className={`w-full pl-3 pr-10 py-3 border rounded-xl font-mono tracking-wide text-base disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${borderClass}`}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {loading
              ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
              : hasInput && parsed.valid
                ? <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                : hasInput && parsed.complete
                  ? <AlertTriangle className="w-4 h-4 text-rose-500" />
                  : hasInput
                    ? <span className="text-[10px] font-bold text-amber-600">{(gstin || '').length}/15</span>
                    : null}
          </div>
        </div>

        {/* Verdict line */}
        {hasInput && (
          <div className="mt-1.5 text-[11px] leading-snug">
            {parsed.valid ? (
              <div className="text-emerald-700 font-semibold flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 shrink-0" /> Valid GSTIN
                </span>
                <span className="text-slate-600 font-normal">
                  {parsed.stateName}
                  {parsed.entityType ? ` · ${parsed.entityType}` : ''}
                  {parsed.registrationType !== 'Regular' ? ` · ${parsed.registrationType}` : ''}
                </span>
              </div>
            ) : (
              <div className={parsed.complete ? 'text-rose-600 font-semibold' : 'text-amber-600'}>
                {parsed.error}
                {!parsed.complete && parsed.stateName && (
                  <span className="text-slate-500 font-normal"> · {parsed.stateName}</span>
                )}
              </div>
            )}
          </div>
        )}

        {!compact && (
          <div className="mt-1 text-[10px] text-slate-400 leading-snug">
            Validated offline against the GSTIN check digit. Company name and address are not fetched
            automatically — the GST portal has no free lookup API.
          </div>
        )}
      </div>

      {showStateField && (
        <div>
          <label className="block text-xs font-bold text-slate-600 uppercase mb-1">
            State / Place of Supply
            {parsed.stateCode && <span className="ml-1 font-normal normal-case text-emerald-600">auto-filled from GSTIN</span>}
          </label>
          <select
            disabled={disabled || Boolean(parsed.stateCode)}
            value={parsed.stateCode || stateCode || ''}
            onChange={e => emit(gstin, e.target.value)}
            className="w-full px-3 py-3 border border-slate-300 rounded-xl text-base bg-white disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">— Select state —</option>
            {stateOptions().map(s => (
              <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
            ))}
          </select>
          {!parsed.stateCode && (
            <div className="mt-1 text-[10px] text-slate-400">
              Required for B2C customers so the correct tax split can be applied.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
