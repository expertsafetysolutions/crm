import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, RotateCcw, ListChecks, Type as TypeIcon } from 'lucide-react';
import {
  REPORT_TYPE_LIST,
  getDefaultColumns,
  getSubTypeList,
  COLUMN_TYPES
} from '../../utils/reportTypeSchemas';

/**
 * Per-report-type checklist builder for Document Settings. Admins pick a report module, then add,
 * rename, reorder and remove its columns — including which are OK/NOT OK checkpoints — and set the
 * default recommendation that fills in when each checkpoint is marked NOT OK.
 *
 * Columns are stored under document_configs.SERVICE_REPORT.report_types[TYPE].columns. Until a type
 * is edited it has none, and the report falls back to the built-in defaults; the first edit
 * materialises those defaults so the admin edits a full copy rather than an empty list.
 */

const TYPE_OPTIONS = [
  { value: COLUMN_TYPES.CHECKPOINT, label: 'Check (OK / Not OK)' },
  { value: COLUMN_TYPES.TEXT, label: 'Text' },
  { value: COLUMN_TYPES.DATE, label: 'Date' },
  { value: COLUMN_TYPES.NUMBER, label: 'Number' }
];

const newColId = () => 'col-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

export default function ReportTypeChecklistEditor({ serviceReportConfig, onChangeColumns, onChangeRecommendation }) {
  const [activeType, setActiveType] = useState(REPORT_TYPE_LIST[0].id);
  const [activeSubType, setActiveSubType] = useState(null);

  const subTypeOptions = useMemo(() => getSubTypeList(activeType), [activeType]);
  useEffect(() => {
    // Default to the module's first sub-type tab (if it has any) whenever the module changes.
    setActiveSubType(subTypeOptions[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType]);

  const typeCfg = serviceReportConfig?.report_types?.[activeType] || {};
  const subCfg = activeSubType ? (typeCfg.subtypes?.[activeSubType] || {}) : null;
  const configured = activeSubType ? subCfg.columns : typeCfg.columns;
  const columns = Array.isArray(configured) && configured.length > 0 ? configured : getDefaultColumns(activeType, activeSubType || undefined);
  const library = typeCfg.recommendation_library || {};

  const commit = (nextColumns) => onChangeColumns(activeType, nextColumns, activeSubType || undefined);

  const updateColumn = (idx, patch) => commit(columns.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const moveColumn = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[idx], next[j]] = [next[j], next[idx]];
    commit(next);
  };

  const removeColumn = (idx) => commit(columns.filter((_, i) => i !== idx));

  const addColumn = (type) => {
    const label = type === COLUMN_TYPES.CHECKPOINT ? 'New Check' : 'New Column';
    commit([...columns, { id: newColId(), label, type, align: type === COLUMN_TYPES.TEXT ? 'left' : 'center' }]);
  };

  const resetType = () => {
    if (window.confirm('Reset this checklist back to the built-in default columns?')) {
      onChangeColumns(activeType, null, activeSubType || undefined);
    }
  };

  return (
    <div>
      {/* Report-type picker */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {REPORT_TYPE_LIST.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveType(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
              t.id === activeType ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {t.shortLabel}
          </button>
        ))}
      </div>

      {/* Sub-type picker (ABC/CO2, Hydrant-Hose/Pump House) — only shown for modules that have one */}
      {subTypeOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {subTypeOptions.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSubType(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                s.id === activeSubType ? 'bg-emerald-600 text-white shadow-sm' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-slate-400">
          Columns for <span className="font-bold text-slate-600">
            {REPORT_TYPE_LIST.find(t => t.id === activeType)?.shortLabel}
            {activeSubType ? ` — ${subTypeOptions.find(s => s.id === activeSubType)?.label}` : ''}
          </span>. Checks appear as tap-to-toggle OK / Not OK cells.
        </p>
        <button
          type="button"
          onClick={resetType}
          className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-slate-800"
          title="Reset to built-in default columns"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset
        </button>
      </div>

      {/* Column rows */}
      <div className="space-y-2">
        {columns.map((col, idx) => {
          const isCheck = col.type === COLUMN_TYPES.CHECKPOINT;
          return (
            <div key={col.id || idx} className={`rounded-lg border p-2 ${isCheck ? 'bg-emerald-50/50 border-emerald-200' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-slate-300">
                  {isCheck ? <ListChecks className="w-4 h-4 text-emerald-600" /> : <TypeIcon className="w-4 h-4" />}
                </span>
                <input
                  type="text"
                  value={col.label}
                  onChange={e => updateColumn(idx, { label: e.target.value })}
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                  placeholder="Column name"
                />
                <select
                  value={col.type}
                  onChange={e => updateColumn(idx, { type: e.target.value })}
                  className="shrink-0 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] font-bold text-slate-600 focus:outline-none"
                >
                  {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <div className="shrink-0 flex items-center gap-0.5">
                  <button type="button" onClick={() => moveColumn(idx, -1)} disabled={idx === 0} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
                  <button type="button" onClick={() => moveColumn(idx, 1)} disabled={idx === columns.length - 1} className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
                  <button type="button" onClick={() => removeColumn(idx)} className="p-1 text-slate-300 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              {isCheck && (
                <div className="mt-2 pl-6">
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Default recommendation when Not OK</label>
                  <input
                    type="text"
                    value={library[col.id] || ''}
                    onChange={e => onChangeRecommendation(activeType, col.id, e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                    placeholder="e.g. Replace missing safety pin"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add buttons */}
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          onClick={() => addColumn(COLUMN_TYPES.CHECKPOINT)}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-xs flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add Check
        </button>
        <button
          type="button"
          onClick={() => addColumn(COLUMN_TYPES.TEXT)}
          className="px-3 py-1.5 bg-slate-600 hover:bg-slate-700 text-white rounded-lg font-bold text-xs flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add Data Column
        </button>
      </div>
    </div>
  );
}
