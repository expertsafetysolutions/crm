import React from 'react';
import { formatDateDDMMYYYY } from '../../utils/dateUtils';
import {
  COLUMN_TYPES,
  EMPHASIS,
  CHECKPOINT_OK,
  TABLE_SCHEMA_CURRENT
} from '../../utils/reportTypeSchemas';

/**
 * The equipment table printed into the A4 preview and the exported PDF.
 *
 * Two renderers live here on purpose. Reports issued before the schema refactor are re-printed
 * through LegacyPreviewTable so a reprint matches the PDF the customer originally received,
 * including its column misalignment. Everything new renders from the column schema.
 */

const EMPHASIS_CLASS = {
  [EMPHASIS.ID]: 'font-bold text-indigo-950 bg-slate-50',
  [EMPHASIS.STRONG]: 'font-bold text-slate-950',
  [EMPHASIS.DANGER]: 'font-bold text-rose-700',
  [EMPHASIS.PRIMARY]: 'font-bold text-indigo-900',
  [EMPHASIS.MUTED]: 'italic text-slate-700'
};

function cellClassFor(col, value) {
  if (col.type === COLUMN_TYPES.CHECKPOINT) {
    const ok = (value || CHECKPOINT_OK) === CHECKPOINT_OK;
    return `font-bold ${ok ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`;
  }
  const parts = [];
  if (col.align === 'left') parts.push('text-left');
  if (col.emphasis && EMPHASIS_CLASS[col.emphasis]) parts.push(EMPHASIS_CLASS[col.emphasis]);
  else if (col.align === 'left') parts.push('font-semibold');
  return parts.join(' ');
}

function cellValueFor(col, row) {
  const raw = row[col.id];
  if (col.type === COLUMN_TYPES.CHECKPOINT) return raw || CHECKPOINT_OK;
  if (col.type === COLUMN_TYPES.DATE) return formatDateDDMMYYYY(raw);
  return raw;
}

function SchemaPreviewTable({ items, columns, customColumns }) {
  return (
    <table className="w-full text-[8px] border-collapse border border-slate-400 shadow-2xs">
      <thead>
        <tr className="bg-amber-100 text-amber-950 font-black text-center">
          <th className="border border-slate-400 p-1 w-6">Sr.</th>
          {columns.map(col => (
            <th
              key={col.id}
              className={`border border-slate-400 p-1 ${col.align === 'left' ? 'text-left' : ''} ${col.type === COLUMN_TYPES.CHECKPOINT ? 'w-8' : ''}`}
            >
              {col.label}
            </th>
          ))}
          {customColumns.map(col => (
            <th key={col.id} className="border border-slate-400 p-1 bg-indigo-100 text-indigo-950">{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it, idx) => (
          <tr key={it.id || idx} className="border border-slate-300 hover:bg-slate-50 font-semibold text-center">
            <td className="border border-slate-300 p-1 font-bold">{idx + 1}</td>
            {columns.map(col => (
              <td key={col.id} className={`border border-slate-300 p-1 ${cellClassFor(col, it[col.id])}`}>
                {cellValueFor(col, it)}
              </td>
            ))}
            {customColumns.map(col => (
              <td key={col.id} className="border border-slate-300 p-1 text-indigo-950 font-bold">
                {it.customValues?.[col.id] || '—'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * FROZEN — reproduces the pre-schema table exactly, including the `valve` cell that has no
 * matching header and therefore shifts every column to its right. Do not "fix" this renderer;
 * its whole purpose is to keep reprints of already-issued reports faithful to what was sent.
 */
function LegacyPreviewTable({ items, customColumns, srCols, srCps }) {
  return (
    <table className="w-full text-[8px] border-collapse border border-slate-400 shadow-2xs">
      <thead>
        <tr className="bg-amber-100 text-amber-950 font-black text-center">
          <th className="border border-slate-400 p-1 w-6">Sr.</th>
          {(srCols.location !== false) && <th className="border border-slate-400 p-1 text-left">Location</th>}
          {(srCols.client_id_no !== false) && <th className="border border-slate-400 p-1">Client ID No</th>}
          <th className="border border-slate-400 p-1 text-left">Fire Ext. Description</th>
          {(srCols.mfg_year !== false) && <th className="border border-slate-400 p-1 w-8">MFG</th>}
          {(srCols.refill_date !== false) && <th className="border border-slate-400 p-1">Refilling Date</th>}
          {(srCols.next_refill_due !== false) && <th className="border border-slate-400 p-1">Refilling Due Dt</th>}
          {(srCols.hpt_date !== false) && <th className="border border-slate-400 p-1">HP Testing Date</th>}
          {(srCols.hpt_due_date !== false) && <th className="border border-slate-400 p-1">HP Testing Due Dt</th>}
          {(srCps.body_valve !== false) && <th className="border border-slate-400 p-1 w-8">Body/Valve</th>}
          {(srCps.safety_pin !== false) && <th className="border border-slate-400 p-1 w-8">Safety Pin</th>}
          {(srCps.pressure_gauge !== false) && <th className="border border-slate-400 p-1 w-8">Pressure / Wt</th>}
          {(srCps.hose_pipe !== false) && <th className="border border-slate-400 p-1 w-8">Hose &amp; Horn</th>}
          {(srCps.seal !== false) && <th className="border border-slate-400 p-1 w-8">Seal</th>}
          {customColumns.map(col => (
            <th key={col.id} className="border border-slate-400 p-1 bg-indigo-100 text-indigo-950">{col.label}</th>
          ))}
          <th className="border border-slate-400 p-1 text-left">Remarks</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it, idx) => (
          <tr key={it.id || idx} className="border border-slate-300 hover:bg-slate-50 font-semibold text-center">
            <td className="border border-slate-300 p-1 font-bold">{idx + 1}</td>
            {(srCols.location !== false) && <td className="border border-slate-300 p-1 text-left font-semibold">{it.location}</td>}
            {(srCols.client_id_no !== false) && <td className="border border-slate-300 p-1 font-bold text-indigo-950 bg-slate-50">{it.clientIdNo}</td>}
            <td className="border border-slate-300 p-1 text-left font-bold text-slate-950">{it.itemName}</td>
            {(srCols.mfg_year !== false) && <td className="border border-slate-300 p-1">{it.mfgYear}</td>}
            {(srCols.refill_date !== false) && <td className="border border-slate-300 p-1">{formatDateDDMMYYYY(it.refillingDate)}</td>}
            {(srCols.next_refill_due !== false) && <td className="border border-slate-300 p-1 font-bold text-rose-700">{formatDateDDMMYYYY(it.nextRefillingDate)}</td>}
            {(srCols.hpt_date !== false) && <td className="border border-slate-300 p-1">{formatDateDDMMYYYY(it.hptDate)}</td>}
            {(srCols.hpt_due_date !== false) && <td className="border border-slate-300 p-1 font-bold text-indigo-900">{formatDateDDMMYYYY(it.hptDueDate)}</td>}
            {(srCps.body_valve !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.bodyValve || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.bodyValve || 'OK'}</td>}
            {(srCps.body_valve !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.valve || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.valve || 'OK'}</td>}
            {(srCps.safety_pin !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.safetyPin || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.safetyPin || 'OK'}</td>}
            {(srCps.pressure_gauge !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.pressureWeight || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.pressureWeight || 'OK'}</td>}
            {(srCps.hose_pipe !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.hoseHorn || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.hoseHorn || 'OK'}</td>}
            {(srCps.seal !== false) && <td className={`border border-slate-300 p-1 font-bold ${(it.seal || 'OK') === 'OK' ? 'text-emerald-800' : 'text-rose-700 bg-rose-50'}`}>{it.seal || 'OK'}</td>}
            {customColumns.map(col => (
              <td key={col.id} className="border border-slate-300 p-1 text-indigo-950 font-bold">{it.customValues?.[col.id] || '—'}</td>
            ))}
            <td className="border border-slate-300 p-1 text-left italic text-slate-700">{it.remarks}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function EquipmentPreviewTable({
  items = [],
  columns = [],
  customColumns = [],
  schemaVersion,
  srCols = {},
  srCps = {}
}) {
  if (schemaVersion === TABLE_SCHEMA_CURRENT) {
    return <SchemaPreviewTable items={items} columns={columns} customColumns={customColumns} />;
  }
  return <LegacyPreviewTable items={items} customColumns={customColumns} srCols={srCols} srCps={srCps} />;
}
