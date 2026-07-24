import React, { useState, useEffect, useMemo } from 'react';
import { Search, CheckCircle2, CircleDot, ArrowRight, ChevronLeft } from 'lucide-react';
import GuidedInspection from './GuidedInspection';
import {
  resolveColumns,
  getRowSubType,
  getRecommendationDefault,
  REPORT_TYPE_LIST,
  getReportType
} from '../../utils/reportTypeSchemas';
import { buildEquipmentIndex, familiesWithEquipment, matchesEquipmentQuery } from '../../utils/fieldVisitEquipmentIndex';

/**
 * One continuous walk-through for a single client visit, covering every equipment family the
 * client has on file (Fire Extinguisher, System, Alarm, ...) through one shared search box.
 *
 * Searching finds an item regardless of its family, opens that item's own checklist (the right
 * checkpoints for its family + sub-type — ABC vs CO2, Hose vs Pump House), and "Save & Next"
 * returns to the same search so the technician keeps walking without switching screens. Each
 * family's captured rows are kept in their own itemsList in memory; "Finish Visit" (owned by the
 * parent page) turns each touched family into its own normal Service_Reports document.
 */
export default function FieldVisitInspector({ customerId, byType, srCfg, onFormsChange }) {
  // itemsList per report-type family, lazily seeded from the client's registry the first time
  // that family is actually touched (so families the technician never opens aren't submitted).
  const [forms, setForms] = useState({});
  const [activeFamily, setActiveFamily] = useState(null);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [search, setSearch] = useState('');

  const families = useMemo(() => familiesWithEquipment(byType, REPORT_TYPE_LIST), [byType]);
  const equipmentIndex = useMemo(() => buildEquipmentIndex(byType), [byType]);

  useEffect(() => {
    onFormsChange?.(forms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forms]);

  // Rows already captured this visit take priority over the untouched registry copy, so progress
  // (serviced / edited values) survives even while other families are still untouched.
  const liveIndex = useMemo(() => {
    return equipmentIndex.map(row => {
      const liveRow = forms[row.__reportType]?.itemsList?.find(r => r.id === row.id);
      return liveRow ? { ...liveRow, __reportType: row.__reportType } : row;
    });
  }, [equipmentIndex, forms]);

  const results = useMemo(() => liveIndex.filter(row => matchesEquipmentQuery(row, search)), [liveIndex, search]);

  const ensureFamilyForm = (reportType) => {
    setForms(prev => {
      if (prev[reportType]) return prev;
      const seeded = (byType[reportType] || []).map(row => ({ ...row, serviced: false }));
      return { ...prev, [reportType]: { itemsList: seeded } };
    });
  };

  const openRow = (row) => {
    const reportType = row.__reportType;
    ensureFamilyForm(reportType);
    setActiveFamily(reportType);
    setSelectedRowId(row.id);
  };

  const activeItems = forms[activeFamily]?.itemsList || [];
  const activeRow = activeItems.find(r => r.id === selectedRowId) || null;
  const activeSubType = activeRow ? getRowSubType(activeFamily, activeRow) : null;
  const activeColumns = activeFamily ? resolveColumns(activeFamily, srCfg, activeSubType) : [];

  const updateActiveRow = (patch) => {
    setForms(prev => ({
      ...prev,
      [activeFamily]: {
        ...prev[activeFamily],
        itemsList: prev[activeFamily].itemsList.map(row => row.id === selectedRowId ? { ...row, ...patch(row) } : row)
      }
    }));
  };

  const handleCellChange = (rowId, field, val) => updateActiveRow(() => ({ [field]: val }));
  const handleCustomValueChange = (rowId, colId, val) => updateActiveRow(row => ({ customValues: { ...(row.customValues || {}), [colId]: val } }));
  const handleRecommendationChange = (rowId, checkpointId, text) => updateActiveRow(row => ({ recommendations: { ...(row.recommendations || {}), [checkpointId]: text } }));
  const handleToggleCheckpoint = (rowId, checkpointKey) => updateActiveRow(row => {
    const nextVal = (row[checkpointKey] || 'OK') === 'OK' ? 'NOT OK' : 'OK';
    const patch = { [checkpointKey]: nextVal, serviced: true };
    if (nextVal === 'NOT OK' && !row.recommendations?.[checkpointKey]) {
      const def = getRecommendationDefault(activeFamily, srCfg, checkpointKey);
      if (def) patch.recommendations = { ...(row.recommendations || {}), [checkpointKey]: def };
    }
    return patch;
  });

  const handleSaveNext = () => {
    updateActiveRow(() => ({ serviced: true }));
    setSelectedRowId(null);
    setActiveFamily(null);
    setSearch('');
  };

  const progressFor = (reportType) => {
    const items = forms[reportType]?.itemsList || (byType[reportType] || []);
    const total = items.length;
    const done = items.filter(r => r.serviced).length;
    return { total, done };
  };

  if (families.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-300 rounded-xl p-6 text-center">
        <p className="text-sm font-bold text-amber-900">No registered equipment found for this client yet.</p>
        <p className="text-xs text-amber-700 mt-1">Add their Fire Extinguisher / System / Alarm equipment in the client registry first, then start the visit again.</p>
      </div>
    );
  }

  // A specific item is open — show its own focused checklist (its family + sub-type's checkpoints).
  if (activeRow) {
    return (
      <div className="bg-white border border-indigo-200 rounded-xl p-3 shadow-2xs space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-black uppercase tracking-wide text-indigo-700">
            {getReportType(activeFamily).shortLabel}
          </span>
          <button
            type="button"
            onClick={() => { setSelectedRowId(null); setActiveFamily(null); }}
            className="flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-slate-800"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Back to search
          </button>
        </div>
        <GuidedInspection
          items={[activeRow]}
          columns={activeColumns}
          customColumns={[]}
          selectedId={activeRow.id}
          search=""
          onSearch={() => {}}
          onSelect={() => {}}
          onCloseItem={() => { setSelectedRowId(null); setActiveFamily(null); }}
          onCellChange={handleCellChange}
          onToggleCheckpoint={handleToggleCheckpoint}
          onCustomValueChange={handleCustomValueChange}
          onRecommendationChange={handleRecommendationChange}
          onSaveNext={handleSaveNext}
        />
      </div>
    );
  }

  // No item open — the shared cross-family search + per-family progress chips.
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {families.map(f => {
          const { total, done } = progressFor(f.id);
          return (
            <span
              key={f.id}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${
                done === total && total > 0 ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-slate-50 border-slate-200 text-slate-600'
              }`}
            >
              {f.shortLabel}: {done}/{total}
            </span>
          );
        })}
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          inputMode="search"
          autoFocus
          placeholder="Search Client ID, Serial No, Manufacturer or Cylinder No — any equipment type…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2.5 bg-white border border-slate-300 rounded-xl font-bold text-sm text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-none"
        />
      </div>

      {results.length === 0 && (
        <p className="text-center text-xs text-slate-500 py-6">
          {search.trim() ? `No equipment matches "${search}".` : 'Start typing to find equipment, or browse below.'}
        </p>
      )}

      <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
        {results.map(row => (
          <button
            key={`${row.__reportType}-${row.id}`}
            type="button"
            onClick={() => openRow(row)}
            className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition active:scale-[0.99] ${
              row.serviced ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-slate-200 hover:border-amber-300'
            }`}
          >
            <span className={`shrink-0 ${row.serviced ? 'text-emerald-600' : 'text-slate-300'}`}>
              {row.serviced ? <CheckCircle2 className="w-5 h-5" /> : <CircleDot className="w-5 h-5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-slate-900 truncate">{row.clientIdNo || row.location || row.itemName || 'Equipment'}</span>
              <span className="block text-[11px] text-slate-500 truncate">
                {getReportType(row.__reportType).shortLabel}
                {row.location ? ` · ${row.location}` : ''}
                {row.itemName ? ` · ${row.itemName}` : ''}
              </span>
            </span>
            <ArrowRight className="w-4 h-4 text-slate-300 shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
