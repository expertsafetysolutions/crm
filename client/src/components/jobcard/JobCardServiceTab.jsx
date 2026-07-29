import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { matchesQuery } from '../../utils/searchUtils';
import CollapsibleSection from '../CollapsibleSection';
import PartsFittedEditor from './PartsFittedEditor';
import { SERVICE_STATUS, itemLabel, notOkCheckpoints } from '../../utils/jobCardSchema';

/**
 * JobCardServiceTab — the four-to-five day working view.
 *
 * The technician does not scroll a list here; they pick up a cylinder, read the number stamped on
 * it and search for that. So search is the primary control and rows stay collapsed until matched.
 * Everything is additive: parts can be recorded on any cylinder on any day, in any order.
 */
export default function JobCardServiceTab({
  items, categories, columnsByCode, itemMaster, onAddParts, onRemovePart, onUpdateItem, readOnly = false
}) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    return items.filter(it => matchesQuery(query,
      [it.Cylinder_No, it.Serial_No, it.EUID_No, it.Client_ID_No, String(it.Sr_No), it.Capacity]));
  }, [items, query]);

  const categoryFor = (code) => categories.find(c => String(c.Code).toUpperCase() === String(code).toUpperCase());

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search cylinder / serial / EUID no…"
          inputMode="search"
          className="w-full min-h-[48px] pl-9 pr-9 rounded-xl border border-slate-200 bg-white text-sm font-bold placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-slate-900/10"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center active:bg-slate-100"
            aria-label="Clear search"
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        )}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-xs text-slate-400 py-8">
          {items.length === 0 ? 'No equipment on this job card yet — add it on the Inward tab.' : 'No cylinder matches that number.'}
        </p>
      )}

      {filtered.map(item => {
        const columns = columnsByCode[String(item.Equipment_Type).toUpperCase()] || [];
        const issues = notOkCheckpoints(item, columns);
        const unresolved = issues.filter(i => !i.resolved && !i.partFitted);
        const parts = item.Parts_Fitted || [];
        const category = categoryFor(item.Equipment_Type);
        const isDone = item.Service_Status === SERVICE_STATUS.DONE;

        return (
          <CollapsibleSection
            key={item.Job_Card_Item_ID}
            open={openId === item.Job_Card_Item_ID}
            onToggle={next => setOpenId(next ? item.Job_Card_Item_ID : null)}
            isComplete={isDone}
            autoCollapse={false}
            tone={unresolved.length > 0 ? 'warning' : 'default'}
            badge={parts.length > 0 ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 text-[10px] font-extrabold">
                {parts.length} part{parts.length > 1 ? 's' : ''}
              </span>
            ) : null}
            summary={(
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-[11px] font-extrabold text-slate-400 shrink-0">#{item.Sr_No}</span>
                <span className="text-xs font-bold text-slate-900 truncate">
                  {item.Equipment_Type} {item.Capacity}
                </span>
                <span className="text-[11px] text-slate-500 truncate">{itemLabel(item)}</span>
                {unresolved.length > 0 && (
                  <span className="text-[10px] font-extrabold text-amber-600 shrink-0">
                    {unresolved.length} pending
                  </span>
                )}
              </div>
            )}
          >
            <div className="space-y-2.5 pt-1">
              {issues.length > 0 && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 px-2.5 py-2">
                  <p className="text-[10px] font-extrabold uppercase tracking-wide text-amber-700 mb-1">
                    Flagged at inward
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {issues.map(i => (
                      <span
                        key={i.checkpointId}
                        className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                          i.partFitted || i.resolved
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-white text-amber-800 border border-amber-300'
                        }`}
                      >
                        {i.checkpointLabel}{i.partFitted ? ' ✓' : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <PartsFittedEditor
                item={item}
                issues={issues}
                itemMaster={itemMaster}
                onAdd={parts => onAddParts(item.Job_Card_Item_ID, parts)}
                onRemove={lineId => onRemovePart(item.Job_Card_Item_ID, lineId)}
                readOnly={readOnly}
              />

              {category?.Requires_Weight && (
                <label className="block">
                  <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
                    Full Weight (after refilling)
                  </span>
                  <input
                    defaultValue={item.Full_Weight || ''}
                    disabled={readOnly}
                    onBlur={e => {
                      if (e.target.value !== (item.Full_Weight || '')) {
                        onUpdateItem(item.Job_Card_Item_ID, { Full_Weight: e.target.value });
                      }
                    }}
                    placeholder={item.Empty_Weight ? `Empty was ${item.Empty_Weight}` : 'e.g. 10.4 Kg'}
                    className="jc-input"
                  />
                </label>
              )}

              {!readOnly && (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => onUpdateItem(item.Job_Card_Item_ID, {
                      Service_Status: isDone ? SERVICE_STATUS.IN_PROGRESS : SERVICE_STATUS.DONE,
                      ...(isDone ? {} : {
                        Refilling_Date: item.Refilling_Required ? istToday() : '',
                        HP_Test_Date: item.HP_Testing_Required ? istToday() : ''
                      })
                    })}
                    className={`flex-1 min-h-[44px] rounded-xl text-xs font-extrabold border transition ${
                      isDone
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white border-slate-200 text-slate-600'
                    }`}
                  >
                    {isDone ? 'Done ✓' : 'Mark Done'}
                  </button>
                  {/* A scrapped cylinder is excluded from the challan's service lines — it was
                      never refilled or tested, so it must not be billed as if it were. */}
                  <button
                    onClick={() => onUpdateItem(item.Job_Card_Item_ID, {
                      Service_Status: item.Service_Status === SERVICE_STATUS.REJECTED
                        ? SERVICE_STATUS.PENDING
                        : SERVICE_STATUS.REJECTED
                    })}
                    className={`min-h-[44px] px-3 rounded-xl text-xs font-extrabold border transition ${
                      item.Service_Status === SERVICE_STATUS.REJECTED
                        ? 'bg-rose-600 border-rose-600 text-white'
                        : 'bg-white border-slate-200 text-slate-500'
                    }`}
                  >
                    Unserviceable
                  </button>
                </div>
              )}
            </div>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
