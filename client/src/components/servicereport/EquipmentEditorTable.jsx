import React from 'react';
import { Trash2, Check } from 'lucide-react';
import { COLUMN_TYPES, CHECKPOINT_OK, CHECKPOINT_NOT_OK } from '../../utils/reportTypeSchemas';

/**
 * The editable Step 2 equipment table. Headers, inputs and checkpoint toggles all come from the
 * active report type's column list, so any report type renders without bespoke markup.
 *
 * Rows are addressed by their `id`, never by list position, so editing or deleting a row while a
 * search filter is active always hits the intended row.
 */

const INPUT_TYPE = {
  [COLUMN_TYPES.DATE]: 'date',
  [COLUMN_TYPES.NUMBER]: 'number',
  [COLUMN_TYPES.TEXT]: 'text'
};

function DataCell({ col, row, onChange }) {
  const alignLeft = col.align === 'left';
  return (
    <td className={`p-2 ${alignLeft ? 'text-left' : ''}`}>
      <input
        type={INPUT_TYPE[col.type] || 'text'}
        value={row[col.id] ?? ''}
        onChange={e => onChange(row.id, col.id, e.target.value)}
        className={`w-full ${alignLeft ? '' : 'text-center'} bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-semibold text-slate-800 ${col.type === COLUMN_TYPES.DATE || col.type === COLUMN_TYPES.NUMBER ? 'text-[10px]' : ''}`}
      />
    </td>
  );
}

function CheckpointCell({ col, row, onToggle }) {
  const ok = (row[col.id] || CHECKPOINT_OK) === CHECKPOINT_OK;
  return (
    <td className="p-1">
      {/* min-height keeps this an easy phone tap target */}
      <button
        type="button"
        onClick={() => onToggle(row.id, col.id)}
        className={`w-full min-h-[36px] py-1.5 rounded-lg text-[10px] font-black transition cursor-pointer active:scale-95 ${
          ok
            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
            : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
        }`}
      >
        {row[col.id] || CHECKPOINT_OK}
      </button>
    </td>
  );
}

export default function EquipmentEditorTable({
  items = [],
  columns = [],
  customColumns = [],
  searchQuery = '',
  onCellChange,
  onToggleCheckpoint,
  onToggleServiced,
  onCustomValueChange,
  onRemoveCustomColumn,
  onDeleteRow
}) {
  const q = searchQuery.trim().toLowerCase();
  const visibleItems = !q
    ? items
    : items.filter(it =>
        (it.clientIdNo || '').toLowerCase().includes(q) ||
        (it.itemName || '').toLowerCase().includes(q) ||
        (it.location || '').toLowerCase().includes(q) ||
        (it.remarks || '').toLowerCase().includes(q)
      );

  return (
    <>
    {/* Desktop / tablet: wide table */}
    <div className="hidden lg:block overflow-x-auto max-h-[55vh]">
      <table className="w-full text-left text-[11px] border-collapse">
        <thead>
          <tr className="bg-amber-100 text-amber-950 font-black border-b border-slate-300 text-center">
            <th className="p-2 w-8">Sr.</th>
            <th className="p-2 w-10" title="Mark row as checked / serviced">✓</th>
            {columns.map(col => (
              <th
                key={col.id}
                className={`p-2 ${col.align === 'left' ? 'text-left min-w-[140px]' : ''} ${col.type === COLUMN_TYPES.CHECKPOINT ? 'w-16' : 'min-w-[100px]'}`}
              >
                {col.label}
              </th>
            ))}
            {customColumns.map(col => (
              <th key={col.id} className="p-2 bg-indigo-100 text-indigo-950 border-l border-indigo-200 min-w-[90px]">
                <div className="flex items-center justify-between gap-1">
                  <span>{col.label}</span>
                  <button type="button" onClick={() => onRemoveCustomColumn(col.id)} className="text-rose-600 hover:font-bold">×</button>
                </div>
              </th>
            ))}
            <th className="p-2 w-8"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visibleItems.map((it, idx) => (
            <tr
              key={it.id || idx}
              className={`transition text-center font-medium border-l-4 ${
                it.serviced
                  ? 'bg-emerald-50 border-emerald-400 hover:bg-emerald-100/70'
                  : 'border-transparent hover:bg-amber-50/70'
              }`}
            >
              <td className="p-2 font-bold text-slate-800">{idx + 1}</td>
              <td className="p-1">
                {/* Per-row "checked / serviced" toggle — turns the row green (item 10) */}
                <button
                  type="button"
                  onClick={() => onToggleServiced(it.id)}
                  title={it.serviced ? 'Checked — tap to unmark' : 'Mark this row as checked'}
                  className={`w-8 h-8 rounded-full flex items-center justify-center mx-auto transition active:scale-95 ${
                    it.serviced
                      ? 'bg-emerald-500 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-400 border border-slate-300 hover:bg-slate-200'
                  }`}
                >
                  <Check className="w-4 h-4" />
                </button>
              </td>
              {columns.map(col =>
                col.type === COLUMN_TYPES.CHECKPOINT ? (
                  <CheckpointCell key={col.id} col={col} row={it} onToggle={onToggleCheckpoint} />
                ) : (
                  <DataCell key={col.id} col={col} row={it} onChange={onCellChange} />
                )
              )}
              {customColumns.map(col => (
                <td key={col.id} className="p-1 bg-indigo-50/50 border-l border-indigo-100">
                  <input
                    type="text"
                    value={it.customValues?.[col.id] || ''}
                    onChange={e => onCustomValueChange(it.id, col.id, e.target.value)}
                    className="w-full text-center bg-transparent border-b border-transparent focus:border-indigo-500 focus:outline-none font-bold text-indigo-900"
                  />
                </td>
              ))}
              <td className="p-2">
                <button
                  type="button"
                  onClick={() => onDeleteRow(it.id)}
                  className="p-1 text-slate-300 hover:text-rose-600 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    {/* Phone: one card per item, no sideways scrolling */}
    <div className="lg:hidden space-y-2.5 max-h-[60vh] overflow-y-auto p-0.5">
      {visibleItems.map((it, idx) => {
        const dataCols = columns.filter(c => c.type !== COLUMN_TYPES.CHECKPOINT);
        const checkCols = columns.filter(c => c.type === COLUMN_TYPES.CHECKPOINT);
        return (
          <div
            key={it.id || idx}
            className={`rounded-xl border-l-4 border p-3 shadow-2xs ${
              it.serviced ? 'bg-emerald-50 border-emerald-400' : 'bg-white border-l-slate-200 border-slate-200'
            }`}
          >
            {/* Card header: Sr + serviced + delete */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-black text-slate-500">#{idx + 1}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onToggleServiced(it.id)}
                  className={`h-9 px-3 rounded-full flex items-center gap-1.5 text-[11px] font-bold transition active:scale-95 ${
                    it.serviced
                      ? 'bg-emerald-500 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-500 border border-slate-300'
                  }`}
                >
                  <Check className="w-4 h-4" />
                  {it.serviced ? 'Checked' : 'Mark checked'}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteRow(it.id)}
                  className="p-2 text-slate-300 hover:text-rose-600"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Data fields */}
            <div className="grid grid-cols-2 gap-2">
              {dataCols.map(col => (
                <label key={col.id} className={col.align === 'left' ? 'col-span-2' : ''}>
                  <span className="block text-[9px] font-bold text-slate-400 uppercase mb-0.5">{col.label}</span>
                  <input
                    type={INPUT_TYPE[col.type] || 'text'}
                    value={it[col.id] ?? ''}
                    onChange={e => onCellChange(it.id, col.id, e.target.value)}
                    className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  />
                </label>
              ))}
              {customColumns.map(col => (
                <label key={col.id} className="col-span-1">
                  <span className="block text-[9px] font-bold text-indigo-400 uppercase mb-0.5">{col.label}</span>
                  <input
                    type="text"
                    value={it.customValues?.[col.id] || ''}
                    onChange={e => onCustomValueChange(it.id, col.id, e.target.value)}
                    className="w-full px-2 py-1.5 bg-indigo-50/60 border border-indigo-200 rounded-lg text-xs font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
                  />
                </label>
              ))}
            </div>

            {/* Checks */}
            {checkCols.length > 0 && (
              <div className="mt-2.5">
                <span className="block text-[9px] font-bold text-slate-400 uppercase mb-1">Checks — tap to mark Not OK</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {checkCols.map(col => {
                    const ok = (it[col.id] || CHECKPOINT_OK) === CHECKPOINT_OK;
                    return (
                      <button
                        key={col.id}
                        type="button"
                        onClick={() => onToggleCheckpoint(it.id, col.id)}
                        className={`min-h-[40px] px-2 py-1.5 rounded-lg text-[11px] font-bold flex items-center justify-between gap-1 transition active:scale-95 border ${
                          ok
                            ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                            : 'bg-rose-100 text-rose-800 border-rose-300'
                        }`}
                      >
                        <span className="truncate">{col.label}</span>
                        <span className="shrink-0 font-black">{it[col.id] || CHECKPOINT_OK}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}

export { CHECKPOINT_NOT_OK };
