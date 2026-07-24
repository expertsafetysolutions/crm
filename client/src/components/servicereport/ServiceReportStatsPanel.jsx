import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BarChart3, Download, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { REPORT_TYPE_LIST, getSubTypeList } from '../../utils/reportTypeSchemas';

/**
 * Statistics/Summary panel: due-date filtering, counts by sub-type + capacity (e.g. "ABC 6kg: 10,
 * CO2 5kg: 3"), and a Not-OK punch list, downloadable as CSV. Shared between AdminDashboard (full,
 * all-clients view) and the Field Visit page (customerId-scoped, "this client's due/Not-OK items").
 *
 * Reads GET /api/service-reports/stats — see server/src/services/serviceReportStats.js for the
 * aggregation itself; this component only renders whatever it returns.
 */
export default function ServiceReportStatsPanel({ token, customerId, compact = false }) {
  const [reportType, setReportType] = useState(REPORT_TYPE_LIST[0].id);
  const [subType, setSubType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [notOkOnly, setNotOkOnly] = useState(false);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const subTypeOptions = useMemo(() => getSubTypeList(reportType), [reportType]);

  useEffect(() => {
    // Reset the sub-type filter whenever the family changes to one whose sub-types differ.
    setSubType('');
  }, [reportType]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (reportType) params.set('reportType', reportType);
      if (subType) params.set('subType', subType);
      if (customerId) params.set('customerId', customerId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (notOkOnly) params.set('notOkOnly', 'true');
      const res = await fetch(`/api/service-reports/stats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load statistics');
      setStats(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [reportType, subType, customerId, from, to, notOkOnly, token]);

  useEffect(() => { load(); }, [load]);

  const handleDownloadCsv = async (rows, filenamePart) => {
    if (!rows || !rows.length) return;
    const { default: Papa } = await import('papaparse');
    const csv = Papa.unparse(rows);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `service-report-${filenamePart}-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs space-y-3">
      <div className="flex items-center gap-2">
        <BarChart3 className="w-5 h-5 text-indigo-600" />
        <h3 className="font-extrabold text-slate-900 text-sm">
          {customerId ? "This Client's Due / Not-OK Summary" : 'Service Report Statistics'}
        </h3>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10px] font-bold text-slate-500 uppercase">
          Equipment Type
          <select
            value={reportType}
            onChange={e => setReportType(e.target.value)}
            className="block mt-0.5 px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"
          >
            {REPORT_TYPE_LIST.map(t => <option key={t.id} value={t.id}>{t.shortLabel}</option>)}
          </select>
        </label>

        {subTypeOptions.length > 0 && (
          <label className="text-[10px] font-bold text-slate-500 uppercase">
            Sub-Type
            <select
              value={subType}
              onChange={e => setSubType(e.target.value)}
              className="block mt-0.5 px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"
            >
              <option value="">All</option>
              {subTypeOptions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        )}

        <label className="text-[10px] font-bold text-slate-500 uppercase">
          Due From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="block mt-0.5 px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800" />
        </label>
        <label className="text-[10px] font-bold text-slate-500 uppercase">
          Due To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="block mt-0.5 px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800" />
        </label>

        <label className="flex items-center gap-1.5 text-[11px] font-bold text-rose-700 px-2.5 py-1.5 bg-rose-50 border border-rose-200 rounded-lg cursor-pointer">
          <input type="checkbox" checked={notOkOnly} onChange={e => setNotOkOnly(e.target.checked)} />
          Not-OK only
        </label>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg font-bold text-xs flex items-center gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {error && <p className="text-xs font-bold text-rose-600">{error}</p>}

      {stats && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-lg text-xs font-black text-indigo-900">
              Total: {stats.totalCount}
            </span>
            {stats.bySubTypeAndCapacity.map(b => (
              <span key={`${b.subType}-${b.capacity}`} className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold text-slate-700">
                {b.subType} {b.capacity}: {b.count}
              </span>
            ))}
          </div>

          {(from || to) && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-black uppercase text-amber-800">Due in range ({stats.dueList.length})</span>
                {stats.dueList.length > 0 && (
                  <button type="button" onClick={() => handleDownloadCsv(stats.dueList, 'due-list')} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                    <Download className="w-3.5 h-3.5" /> Download CSV
                  </button>
                )}
              </div>
              <div className={`overflow-y-auto border border-slate-200 rounded-lg ${compact ? 'max-h-40' : 'max-h-64'}`}>
                {stats.dueList.length === 0 ? (
                  <p className="text-xs text-slate-400 p-3">Nothing due in this range.</p>
                ) : stats.dueList.map((d, i) => (
                  <div key={i} className="px-3 py-1.5 text-xs border-b border-slate-100 last:border-0 flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800 truncate">{d.clientIdNo || d.location} <span className="text-slate-400 font-normal">— {d.customerName}</span></span>
                    <span className="text-amber-700 font-bold shrink-0">{d.dueDate}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-black uppercase text-rose-800 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" /> Not-OK Punch List ({stats.notOkList.length})
              </span>
              {stats.notOkList.length > 0 && (
                <button type="button" onClick={() => handleDownloadCsv(stats.notOkList, 'not-ok-list')} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
                  <Download className="w-3.5 h-3.5" /> Download CSV
                </button>
              )}
            </div>
            <div className={`overflow-y-auto border border-slate-200 rounded-lg ${compact ? 'max-h-40' : 'max-h-64'}`}>
              {stats.notOkList.length === 0 ? (
                <p className="text-xs text-slate-400 p-3">No open issues found.</p>
              ) : stats.notOkList.map((n, i) => (
                <div key={i} className="px-3 py-1.5 text-xs border-b border-slate-100 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800 truncate">{n.clientIdNo || n.location} <span className="text-slate-400 font-normal">— {n.customerName}</span></span>
                    <span className="text-rose-700 font-black shrink-0">NOT OK</span>
                  </div>
                  <div className="text-slate-500">{n.checkpointId}{n.recommendation ? ` — ${n.recommendation}` : ''}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
