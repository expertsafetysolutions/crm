import React from 'react';
import { Search, ChevronLeft, Check, ArrowRight, CircleDot, CheckCircle2 } from 'lucide-react';
import { COLUMN_TYPES, CHECKPOINT_OK } from '../../utils/reportTypeSchemas';

/**
 * Guided, one-equipment-at-a-time inspection flow for field staff on a phone.
 *
 * List view: search by number / id / location, pending items on top, finished ones below. Tapping
 * an item opens the focused view — only that item's fields and checks — with Save & Next, which
 * marks it done and returns to the list so the next item can be searched (item's own workflow).
 *
 * Purely presentational: all state lives in the parent report form; this reuses the same row-id
 * keyed handlers as the table/card editor, so the three views stay perfectly in sync.
 */

const INPUT_TYPE = {
  [COLUMN_TYPES.DATE]: 'date',
  [COLUMN_TYPES.NUMBER]: 'number',
  [COLUMN_TYPES.TEXT]: 'text'
};

function itemTitle(it) {
  return it.clientIdNo || it.location || it.itemName || 'Equipment';
}

function itemSubtitle(it) {
  return [it.location, it.itemName].filter(Boolean).join(' · ');
}

function FocusedItem({ item, columns, customColumns, onCellChange, onToggleCheckpoint, onCustomValueChange, onRecommendationChange, onBack, onSaveNext }) {
  const dataCols = columns.filter(c => c.type !== COLUMN_TYPES.CHECKPOINT);
  const checkCols = columns.filter(c => c.type === COLUMN_TYPES.CHECKPOINT);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="text-sm font-black text-slate-900 truncate">{itemTitle(item)}</div>
          {itemSubtitle(item) && <div className="text-[11px] text-slate-500 truncate">{itemSubtitle(item)}</div>}
        </div>
      </div>

      {/* Data fields */}
      <div className="grid grid-cols-2 gap-2">
        {dataCols.map(col => (
          <label key={col.id} className={col.align === 'left' ? 'col-span-2' : ''}>
            <span className="block text-[9px] font-bold text-slate-400 uppercase mb-0.5">{col.label}</span>
            <input
              type={INPUT_TYPE[col.type] || 'text'}
              value={item[col.id] ?? ''}
              onChange={e => onCellChange(item.id, col.id, e.target.value)}
              className="w-full px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
            />
          </label>
        ))}
        {customColumns.map(col => (
          <label key={col.id}>
            <span className="block text-[9px] font-bold text-indigo-400 uppercase mb-0.5">{col.label}</span>
            <input
              type="text"
              value={item.customValues?.[col.id] || ''}
              onChange={e => onCustomValueChange(item.id, col.id, e.target.value)}
              className="w-full px-2.5 py-2 bg-indigo-50/60 border border-indigo-200 rounded-lg text-xs font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
            />
          </label>
        ))}
      </div>

      {/* Checks + per-issue recommendation */}
      {checkCols.length > 0 && (
        <div>
          <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">Checks — tap to mark Not OK</span>
          <div className="space-y-1.5">
            {checkCols.map(col => {
              const ok = (item[col.id] || CHECKPOINT_OK) === CHECKPOINT_OK;
              return (
                <div key={col.id}>
                  <button
                    type="button"
                    onClick={() => onToggleCheckpoint(item.id, col.id)}
                    className={`w-full min-h-[44px] px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-between gap-2 transition active:scale-[0.99] border ${
                      ok ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-rose-100 text-rose-800 border-rose-300'
                    }`}
                  >
                    <span className="truncate">{col.label}</span>
                    <span className="shrink-0 font-black">{item[col.id] || CHECKPOINT_OK}</span>
                  </button>
                  {!ok && (
                    <input
                      type="text"
                      value={item.recommendations?.[col.id] || ''}
                      onChange={e => onRecommendationChange(item.id, col.id, e.target.value)}
                      placeholder="Recommendation for this issue…"
                      className="mt-1 w-full px-2.5 py-1.5 bg-white border border-rose-200 rounded-lg text-xs font-medium focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => onSaveNext(item.id)}
        className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-sm flex items-center justify-center gap-2 shadow-sm active:scale-[0.99]"
      >
        <Check className="w-5 h-5" /> Save &amp; Next <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function GuidedInspection({
  items = [],
  columns = [],
  customColumns = [],
  selectedId,
  search = '',
  onSearch,
  onSelect,
  onCloseItem,
  onCellChange,
  onToggleCheckpoint,
  onCustomValueChange,
  onRecommendationChange,
  onSaveNext
}) {
  const selected = items.find(it => it.id === selectedId) || null;

  if (selected) {
    return (
      <FocusedItem
        item={selected}
        columns={columns}
        customColumns={customColumns}
        onCellChange={onCellChange}
        onToggleCheckpoint={onToggleCheckpoint}
        onCustomValueChange={onCustomValueChange}
        onRecommendationChange={onRecommendationChange}
        onBack={onCloseItem}
        onSaveNext={onSaveNext}
      />
    );
  }

  const q = search.trim().toLowerCase();
  const matches = it => {
    if (!q) return true;
    const idx = String((items.indexOf(it) + 1));
    return (
      (it.clientIdNo || '').toLowerCase().includes(q) ||
      (it.location || '').toLowerCase().includes(q) ||
      (it.itemName || '').toLowerCase().includes(q) ||
      idx === q
    );
  };
  const filtered = items.filter(matches);
  const pending = filtered.filter(it => !it.serviced);
  const done = filtered.filter(it => it.serviced);

  const Row = ({ it }) => (
    <button
      type="button"
      onClick={() => onSelect(it.id)}
      className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition active:scale-[0.99] ${
        it.serviced ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200 hover:border-amber-300'
      }`}
    >
      <span className={`shrink-0 ${it.serviced ? 'text-emerald-600' : 'text-slate-300'}`}>
        {it.serviced ? <CheckCircle2 className="w-5 h-5" /> : <CircleDot className="w-5 h-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-slate-900 truncate">{itemTitle(it)}</span>
        {itemSubtitle(it) && <span className="block text-[11px] text-slate-500 truncate">{itemSubtitle(it)}</span>}
      </span>
      <ArrowRight className="w-4 h-4 text-slate-300 shrink-0" />
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          inputMode="search"
          placeholder="Search by number, ID or location…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2.5 bg-white border border-slate-300 rounded-xl font-bold text-sm text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-none"
        />
      </div>

      {items.length === 0 && (
        <p className="text-center text-xs text-slate-500 py-6">No equipment yet — load or import the client’s equipment first.</p>
      )}

      {pending.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-black uppercase tracking-wide text-amber-700">Pending ({pending.length})</div>
          {pending.map(it => <Row key={it.id} it={it} />)}
        </div>
      )}

      {done.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-black uppercase tracking-wide text-emerald-700">Checked ({done.length})</div>
          {done.map(it => <Row key={it.id} it={it} />)}
        </div>
      )}

      {items.length > 0 && filtered.length === 0 && (
        <p className="text-center text-xs text-slate-500 py-4">No equipment matches “{search}”.</p>
      )}
    </div>
  );
}
