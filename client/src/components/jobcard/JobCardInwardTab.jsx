import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Copy, Trash2, Save } from 'lucide-react';
import CollapsibleSection from '../CollapsibleSection';
import AccessoryChecklistCells from './AccessoryChecklistCells';
import EuidScanner from '../EuidScanner';
import {
  CHECKPOINT_OK, newJobCardItemId, normalizeCapacity, itemLabel, isInwardRowComplete
} from '../../utils/jobCardSchema';

/**
 * JobCardInwardTab — the intake sweep: one row per physical cylinder as it comes off the van.
 *
 * Accordion by design. Ten cylinders is ten forms, and on a phone the only way that stays workable
 * is if a finished row folds to a single line and only one row is open at a time. New rows inherit
 * the previous row's type and capacity, because a delivery is usually several of the same thing.
 */

const emptyRow = (categories, previous, srNo) => {
  const fallback = categories[0]?.Code || 'ABC';
  return {
    Job_Card_Item_ID: newJobCardItemId(),
    Sr_No: srNo,
    Equipment_Type: previous?.Equipment_Type || fallback,
    Capacity: previous?.Capacity || '',
    Client_ID_No: '',
    EUID_No: '',
    Serial_No: '',
    Cylinder_No: '',
    Mfg_Year: previous?.Mfg_Year || '',
    Refilling_Required: previous ? previous.Refilling_Required : true,
    HP_Testing_Required: false,
    Last_HP_Test_Date: '',
    Inward_Checkpoints: {},
    Inward_Notes: '',
    Empty_Weight: '',
    _isNew: true
  };
};

export default function JobCardInwardTab({
  items, categories, columnsByCode, onSave, onDelete, readOnly = false
}) {
  const [drafts, setDrafts] = useState([]);
  const [openId, setOpenId] = useState(null);

  // Saved rows are the source of truth; drafts are what has not reached the server yet.
  const rows = useMemo(() => [...items, ...drafts], [items, drafts]);

  useEffect(() => {
    if (items.length === 0 && drafts.length === 0 && !readOnly) {
      const first = emptyRow(categories, null, 1);
      setDrafts([first]);
      setOpenId(first.Job_Card_Item_ID);
    }
  }, [items.length, drafts.length, categories, readOnly]);

  const categoryFor = (code) => categories.find(c => String(c.Code).toUpperCase() === String(code).toUpperCase());

  const addRow = (copyFrom) => {
    const previous = copyFrom || rows[rows.length - 1];
    const row = emptyRow(categories, previous, rows.length + 1);
    if (copyFrom) {
      // Duplicating carries the identity-free details; serials must stay unique per cylinder.
      row.Client_ID_No = '';
      row.EUID_No = '';
      row.Serial_No = '';
      row.Cylinder_No = '';
      row.HP_Testing_Required = copyFrom.HP_Testing_Required;
    }
    setDrafts(prev => [...prev, row]);
    setOpenId(row.Job_Card_Item_ID);
  };

  const patchRow = (id, patch) => {
    setDrafts(prev => prev.map(r => (r.Job_Card_Item_ID === id ? { ...r, ...patch } : r)));
  };

  const dropDraft = (id) => {
    setDrafts(prev => prev.filter(r => r.Job_Card_Item_ID !== id));
    if (openId === id) setOpenId(null);
  };

  const saveAll = async () => {
    const ready = drafts.filter(isInwardRowComplete);
    if (ready.length === 0) return;
    await onSave(ready.map(({ _isNew, ...r }) => r));
    setDrafts(prev => prev.filter(r => !ready.some(x => x.Job_Card_Item_ID === r.Job_Card_Item_ID)));
  };

  const pendingCount = drafts.filter(isInwardRowComplete).length;

  return (
    <div className="space-y-2">
      {rows.map((row, idx) => {
        const category = categoryFor(row.Equipment_Type);
        const columns = columnsByCode[String(row.Equipment_Type).toUpperCase()] || [];
        const complete = isInwardRowComplete(row);
        const isDraft = Boolean(row._isNew);
        const notOkCount = Object.values(row.Inward_Checkpoints || {}).filter(v => v !== CHECKPOINT_OK).length;

        return (
          <CollapsibleSection
            key={row.Job_Card_Item_ID}
            open={openId === row.Job_Card_Item_ID}
            onToggle={(next) => setOpenId(next ? row.Job_Card_Item_ID : null)}
            isComplete={complete}
            autoCollapse={isDraft}
            tone={notOkCount > 0 ? 'warning' : 'default'}
            badge={notOkCount > 0 ? (
              <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-extrabold">
                {notOkCount} not ok
              </span>
            ) : null}
            summary={(
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-[11px] font-extrabold text-slate-400 shrink-0">#{idx + 1}</span>
                <span className="text-xs font-bold text-slate-900 truncate">
                  {row.Equipment_Type} {row.Capacity || '—'}
                </span>
                <span className="text-[11px] text-slate-500 truncate">{itemLabel(row)}</span>
                {isDraft && <span className="text-[10px] font-bold text-indigo-500 shrink-0">unsaved</span>}
              </div>
            )}
          >
            <div className="space-y-2.5 pt-1">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Type">
                  <select
                    value={row.Equipment_Type}
                    disabled={readOnly || !isDraft}
                    onChange={e => patchRow(row.Job_Card_Item_ID, { Equipment_Type: e.target.value, Inward_Checkpoints: {} })}
                    className="jc-input"
                  >
                    {categories.map(c => <option key={c.Code} value={c.Code}>{c.Label || c.Code}</option>)}
                  </select>
                </Field>
                <Field label="Capacity">
                  {/* datalist rather than free text: three spellings of "6 Kg" would otherwise
                      become three separate lines on the challan. */}
                  <input
                    list={`cap-${row.Job_Card_Item_ID}`}
                    value={row.Capacity}
                    disabled={readOnly || !isDraft}
                    onChange={e => patchRow(row.Job_Card_Item_ID, { Capacity: e.target.value })}
                    onBlur={e => patchRow(row.Job_Card_Item_ID, { Capacity: normalizeCapacity(e.target.value) })}
                    placeholder="6 Kg"
                    className="jc-input"
                  />
                  <datalist id={`cap-${row.Job_Card_Item_ID}`}>
                    {(category?.Capacities || []).map(c => <option key={c} value={c} />)}
                  </datalist>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Cylinder No"><TextCell row={row} field="Cylinder_No" disabled={readOnly || !isDraft} onChange={patchRow} /></Field>
                <Field label="Serial No"><TextCell row={row} field="Serial_No" disabled={readOnly || !isDraft} onChange={patchRow} /></Field>
                <div className="col-span-2">
                  <EuidScanner
                    value={row.EUID_No}
                    disabled={readOnly || !isDraft}
                    onChange={v => patchRow(row.Job_Card_Item_ID, { EUID_No: v })}
                  />
                </div>
                <Field label="Client ID No"><TextCell row={row} field="Client_ID_No" disabled={readOnly || !isDraft} onChange={patchRow} /></Field>
                <Field label="MFG Year"><TextCell row={row} field="Mfg_Year" disabled={readOnly || !isDraft} onChange={patchRow} /></Field>
                {category?.Requires_Weight && (
                  <Field label="Empty Weight"><TextCell row={row} field="Empty_Weight" disabled={readOnly || !isDraft} onChange={patchRow} /></Field>
                )}
              </div>

              <div className="flex gap-2">
                <Toggle
                  label="Refilling"
                  active={row.Refilling_Required}
                  disabled={readOnly || !isDraft}
                  onClick={() => patchRow(row.Job_Card_Item_ID, { Refilling_Required: !row.Refilling_Required })}
                />
                <Toggle
                  label="HP Testing"
                  active={row.HP_Testing_Required}
                  disabled={readOnly || !isDraft}
                  onClick={() => patchRow(row.Job_Card_Item_ID, { HP_Testing_Required: !row.HP_Testing_Required })}
                />
              </div>

              {row.Last_HP_Test_Date && (
                <p className="text-[11px] text-slate-500">
                  Last HP test: <span className="font-bold text-slate-700">{row.Last_HP_Test_Date}</span>
                  {row.Last_HP_Test_Source === 'CLIENT_EQUIPMENT' && (
                    <span className="ml-1 text-emerald-600 font-bold">· from client register</span>
                  )}
                </p>
              )}

              <AccessoryChecklistCells
                columns={columns}
                values={row.Inward_Checkpoints || {}}
                disabled={readOnly || !isDraft}
                onChange={next => patchRow(row.Job_Card_Item_ID, { Inward_Checkpoints: next })}
              />

              <input
                value={row.Inward_Notes || ''}
                disabled={readOnly || !isDraft}
                onChange={e => patchRow(row.Job_Card_Item_ID, { Inward_Notes: e.target.value })}
                placeholder="Remarks"
                className="jc-input"
              />

              {!readOnly && (
                <div className="flex gap-2 pt-1">
                  <button onClick={() => addRow(row)} className="jc-btn-ghost flex-1">
                    <Copy className="w-3.5 h-3.5" /> Duplicate
                  </button>
                  <button
                    onClick={() => (isDraft ? dropDraft(row.Job_Card_Item_ID) : onDelete(row.Job_Card_Item_ID))}
                    className="jc-btn-ghost text-rose-600 border-rose-200"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                </div>
              )}
            </div>
          </CollapsibleSection>
        );
      })}

      {!readOnly && (
        <div className="flex gap-2 pt-1">
          <button onClick={() => addRow(null)} className="jc-btn-ghost flex-1 min-h-[48px]">
            <Plus className="w-4 h-4" /> Add Equipment
          </button>
          {pendingCount > 0 && (
            <button onClick={saveAll} className="flex-[2] min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold flex items-center justify-center gap-2 active:bg-slate-800">
              <Save className="w-4 h-4" /> Save {pendingCount}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">{label}</span>
      {children}
    </label>
  );
}

function TextCell({ row, field, disabled, onChange }) {
  return (
    <input
      value={row[field] || ''}
      disabled={disabled}
      onChange={e => onChange(row.Job_Card_Item_ID, { [field]: e.target.value })}
      className="jc-input"
    />
  );
}

function Toggle({ label, active, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 min-h-[44px] rounded-xl text-xs font-extrabold border transition disabled:opacity-60 ${
        active
          ? 'bg-indigo-600 border-indigo-600 text-white'
          : 'bg-white border-slate-200 text-slate-500'
      }`}
    >
      {label}
    </button>
  );
}
