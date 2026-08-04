import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, FileText, Loader2, ArrowLeft, Filter, TrendingDown, Trophy, Bell } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery } from '../utils/searchUtils';
import { formatMoney, formatDate, statusMeta } from '../utils/quotationUtils';

// Must match quotationEngine.OPEN_STATUSES — the same set the reminder cron actually targets.
const REMINDER_OPEN_STATUSES = ['Sent', 'RevisionRequested', 'RequirementChangeRequested'];

/** Quotation register — one row per thread (superseded revisions hidden by default). */
export default function QuotationListPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showSuperseded, setShowSuperseded] = useState(false);
  // 'list' = the quotation register, 'won'/'lost' = outcome reports, 'reminders' = follow-up cadence.
  const [view, setView] = useState('list');
  const [lostReport, setLostReport] = useState(null);
  const [lostLoading, setLostLoading] = useState(false);
  const [wonReport, setWonReport] = useState(null);
  const [wonLoading, setWonLoading] = useState(false);

  // Fetched on first open of the report rather than up front — it scans every task, so there is no
  // reason to pay for it on a page most visits never leave the register on.
  useEffect(() => {
    if (view !== 'lost' || lostReport) return;
    let cancelled = false;
    (async () => {
      setLostLoading(true);
      try {
        const res = await fetch('/api/analytics/order-lost', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setLostReport(await res.json());
      } finally {
        if (!cancelled) setLostLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [view, lostReport, token]);

  useEffect(() => {
    if (view !== 'won' || wonReport) return;
    let cancelled = false;
    (async () => {
      setWonLoading(true);
      try {
        const res = await fetch('/api/analytics/order-won', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setWonReport(await res.json());
      } finally {
        if (!cancelled) setWonLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [view, wonReport, token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/quotations${showSuperseded ? '' : '?latestOnly=true'}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok && !cancelled) setRows(await res.json());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, showSuperseded]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (!q) return true;
      return matchesQuery(q, [r.Quote_No_Display, r.Customer_Name_Snapshot, r.Subject]);
    });
  }, [rows, search, statusFilter]);

  const statuses = useMemo(() => [...new Set(rows.map(r => r.Status))].filter(Boolean), [rows]);

  return (
    <div className="qt-theme min-h-screen bg-slate-50">
      <div className="sticky top-0 z-20 shadow-sm">
        <div className="qt-appbar">
          <div className="max-w-6xl mx-auto px-3 py-3 flex items-center gap-2">
            <button onClick={() => navigate('/')} className="qt-appbar-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="font-bold text-[17px] flex-1">Quotations</h1>
            <button onClick={() => navigate('/quotations/new')}
              className="qt-btn bg-white/15 text-white hover:bg-white/25 py-2 px-3.5 text-xs">
              <Plus className="w-4 h-4" /> NEW
            </button>
          </div>
        </div>

        {/* Filter bar on white, below the red app bar — keeps the controls legible and lets the
            search field use the same outlined treatment as the rest of the module. */}
        <div className="bg-white border-b border-slate-200">
          <div className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
            {[
              ['list', 'Quotations', FileText],
              ['won', 'Order Won', Trophy],
              ['lost', 'Order Lost', TrendingDown],
              ['reminders', 'Reminders', Bell]
            ].map(([id, label, Icon]) => (
              <button key={id} onClick={() => setView(id)}
                className={`px-3 py-2.5 text-xs font-bold whitespace-nowrap border-b-2 flex items-center gap-1.5 transition ${view === id ? 'border-rose-600 text-rose-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                <Icon className="w-3.5 h-3.5" />{label}
              </button>
            ))}
          </div>

          {view === 'list' && (
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap gap-2 items-center border-t border-slate-100">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search by number, customer or subject…"
                  className="qt-input pr-10 py-2.5 text-sm" />
              </div>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="qt-select w-auto py-2.5 text-sm">
                <option value="">All statuses</option>
                {statuses.map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 px-2 cursor-pointer">
                <input type="checkbox" className="w-4 h-4" checked={showSuperseded} onChange={e => setShowSuperseded(e.target.checked)} />
                Show superseded
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-5">
        {view === 'lost' ? (
          <OrderLostReport report={lostReport} loading={lostLoading} />
        ) : view === 'won' ? (
          <OrderWonReport report={wonReport} loading={wonLoading} navigate={navigate} />
        ) : view === 'reminders' ? (
          <RemindersReport
            rows={rows}
            loading={loading}
            navigate={navigate}
            token={token}
            onRowUpdated={updated => setRows(list => list.map(
              x => (x.Quotation_ID === updated.Quotation_ID ? { ...x, ...updated } : x)
            ))}
          />
        ) : loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <div className="text-sm font-semibold">No quotations found</div>
          </div>
        ) : (
          <>
            {/* MOBILE: tappable cards. A 5-column table forces horizontal scrolling on a phone,
                and row taps are hard to hit accurately at table density. */}
            <div className="md:hidden space-y-2">
              {filtered.map(r => {
                const meta = statusMeta(r.Status);
                return (
                  <button key={r.Quotation_ID}
                    onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                    className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 active:bg-slate-50 transition">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-sm truncate">{r.Customer_Name_Snapshot}</div>
                        <div className="text-[11px] text-slate-500 font-mono mt-0.5">{r.Quote_No_Display}</div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </div>
                    {r.Subject && <div className="text-xs text-slate-400 truncate mt-1">{r.Subject}</div>}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                      <span className="text-[11px] text-slate-500">{formatDate(r.Created_At)}</span>
                      <span className="font-bold text-base">{formatMoney(r.Grand_Total)}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* DESKTOP: table */}
            <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-bold">Number</th>
                      <th className="px-4 py-2.5 text-left font-bold">Customer</th>
                      <th className="px-4 py-2.5 text-left font-bold">Date</th>
                      <th className="px-4 py-2.5 text-left font-bold">Status</th>
                      <th className="px-4 py-2.5 text-right font-bold">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r => {
                      const meta = statusMeta(r.Status);
                      return (
                        <tr key={r.Quotation_ID}
                          onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                          <td className="px-4 py-2.5 font-semibold whitespace-nowrap">{r.Quote_No_Display}</td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium truncate max-w-[240px]">{r.Customer_Name_Snapshot}</div>
                            {r.Subject && <div className="text-xs text-slate-400 truncate max-w-[240px]">{r.Subject}</div>}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(r.Created_At)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-bold whitespace-nowrap">{formatMoney(r.Grand_Total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Why enquiries were lost, by reason.
 *
 * Bars are scaled against the largest reason rather than the total, so the leading cause always
 * fills the row and small differences stay readable — with five reasons, percent-of-total bars are
 * all short and hard to compare.
 */
function OrderLostReport({ report, loading }) {
  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }
  if (!report) {
    return <div className="text-center py-16 text-slate-400 text-sm font-semibold">Could not load the report.</div>;
  }
  if (!report.totalLost) {
    return (
      <div className="text-center py-16 text-slate-400">
        <TrendingDown className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <div className="text-sm font-semibold">No lost orders recorded yet</div>
        <div className="text-xs mt-1">
          Open a quotation and use <b>Won / Lost</b> to record an outcome — it will show up here.
        </div>
      </div>
    );
  }

  const maxCount = Math.max(...report.byReason.map(r => r.count), 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Orders lost</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{report.totalLost}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Value lost</div>
          <div className="text-2xl font-black text-rose-600 mt-1">{formatMoney(report.totalLostValue)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">By reason</div>
        <div className="space-y-3">
          {report.byReason.map(r => (
            <div key={r.reason}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-slate-700">{r.reason}</span>
                <span className="text-slate-500 text-xs shrink-0">
                  <b className="text-slate-800">{r.count}</b> · {formatMoney(r.value)}
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-rose-500"
                  style={{ width: `${Math.round((r.count / maxCount) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Orders won — no reason dimension (unlike Lost), so this is a simple totals + list view. */
function OrderWonReport({ report, loading, navigate }) {
  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }
  if (!report) {
    return <div className="text-center py-16 text-slate-400 text-sm font-semibold">Could not load the report.</div>;
  }
  if (!report.totalWon) {
    return (
      <div className="text-center py-16 text-slate-400">
        <Trophy className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <div className="text-sm font-semibold">No won orders recorded yet</div>
        <div className="text-xs mt-1">
          Open a quotation and use <b>Won / Lost</b> to record an outcome — it will show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Orders won</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{report.totalWon}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Value won</div>
          <div className="text-2xl font-black text-emerald-600 mt-1">{formatMoney(report.totalWonValue)}</div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 text-xs font-bold uppercase tracking-wide text-slate-500">
          Won quotations
        </div>
        <div className="divide-y divide-slate-100">
          {report.rows.map(r => (
            <button key={r.taskId}
              onClick={() => r.quotationId && navigate(`/quotations/${r.quotationId}`)}
              className="w-full text-left px-4 py-3 flex items-center justify-between gap-2 hover:bg-slate-50">
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{r.customerName}</div>
                <div className="text-[11px] text-slate-500 font-mono">{r.quoteNo}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-bold text-sm">{formatMoney(r.amount)}</div>
                <div className="text-[11px] text-slate-400">{r.closedAt ? formatDate(r.closedAt.slice(0, 10)) : ''}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Interval is stored in DAYS everywhere — the cron, the quotation row and the API all speak days.
 * Months exist only as a display convenience, because "chase every 2 months" is how the office
 * talks and 60 is not a number anyone wants to type. A month is treated as 30 days; a value that
 * is a clean multiple of 30 reads back as months, anything else stays in days so an odd cadence
 * like 45 is never silently rounded.
 */
const DAYS_PER_MONTH = 30;

function toIntervalParts(days) {
  const n = Number(days) || 3;
  if (n >= DAYS_PER_MONTH && n % DAYS_PER_MONTH === 0) {
    return { value: n / DAYS_PER_MONTH, unit: 'months' };
  }
  return { value: n, unit: 'days' };
}

function toDays(value, unit) {
  const n = Number(value) || 0;
  return unit === 'months' ? n * DAYS_PER_MONTH : n;
}

/**
 * Every quotation still in the reminder cron's OPEN_STATUSES set, with its cadence editable in
 * place. Reuses the same /api/quotations rows already fetched for the register.
 *
 * Editing lives here rather than only on the detail page because tuning a cadence is a
 * whole-list job — the office reviews every open quotation together and adjusts a few. Opening
 * twenty documents one at a time to change one number each was the friction this replaces.
 */
function RemindersReport({ rows, loading, navigate, token, onRowUpdated }) {
  const eligible = useMemo(
    () => rows
      .filter(r => REMINDER_OPEN_STATUSES.includes(r.Status))
      .sort((a, b) => String(a.Next_Reminder_Date || '9999').localeCompare(String(b.Next_Reminder_Date || '9999'))),
    [rows]
  );

  // Per-row edits are held here until Save, keyed by Quotation_ID. Nothing is written as you type:
  // a cadence change mails real customers, so it should take a deliberate second action.
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const draftFor = (r) => {
    if (drafts[r.Quotation_ID]) return drafts[r.Quotation_ID];
    const parts = toIntervalParts(r.Follow_Up_Interval_Days);
    return { value: parts.value, unit: parts.unit, max: Number(r.Max_Reminders) || 0 };
  };

  const setDraft = (id, patch) =>
    setDrafts(d => ({ ...d, [id]: { ...draftFor(rows.find(x => x.Quotation_ID === id) || {}), ...d[id], ...patch } }));

  const isDirty = (r) => {
    const d = drafts[r.Quotation_ID];
    if (!d) return false;
    const saved = toIntervalParts(r.Follow_Up_Interval_Days);
    return toDays(d.value, d.unit) !== toDays(saved.value, saved.unit)
      || Number(d.max) !== (Number(r.Max_Reminders) || 0);
  };

  const patchRow = async (id, body, okMsg) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`/api/quotations/${id}/reminder-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      // Update this row in place rather than refetching the whole register — the list must not
      // jump or reorder while someone is working down it.
      onRowUpdated(data);
      setDrafts(d => { const next = { ...d }; delete next[id]; return next; });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const saveRow = (r) => {
    const d = draftFor(r);
    const days = toDays(d.value, d.unit);
    if (!Number.isFinite(days) || days < 1) return setError('Interval must be at least 1 day.');
    patchRow(r.Quotation_ID, { followUpIntervalDays: days, maxReminders: Number(d.max) || 0 });
  };

  /** Sends one reminder right now. Confirms first — a mis-tap while scrolling must not mail a
   *  customer, and an email cannot be recalled. */
  const sendNow = async (r) => {
    const ok = window.confirm(
      `Send a follow-up reminder to ${r.Customer_Name_Snapshot} now?\n\n${r.Quote_No_Display}\n\nThis emails the customer immediately.`
    );
    if (!ok) return;

    setBusyId(r.Quotation_ID);
    setError('');
    try {
      const res = await fetch(`/api/quotations/${r.Quotation_ID}/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the reminder');
      onRowUpdated({
        ...r,
        Reminder_Count: data.reminderCount,
        Last_Reminder_Sent_At: new Date().toISOString(),
        Reminder_Stopped: data.reachedCap ? true : r.Reminder_Stopped
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  }
  if (eligible.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        <Bell className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <div className="text-sm font-semibold">No quotations are currently on a reminder cadence</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-2.5 rounded-xl text-xs font-semibold">
          {error}
        </div>
      )}
      <p className="text-[11px] text-slate-500 px-1">
        Reminders stop on their own once a quotation reaches its limit, or when it is accepted,
        rejected or expires. Leave the limit at 0 for no limit.
      </p>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2.5 text-left font-bold">Number</th>
                <th className="px-3 py-2.5 text-left font-bold">Customer</th>
                <th className="px-3 py-2.5 text-center font-bold">Sent</th>
                <th className="px-3 py-2.5 text-left font-bold">Last sent</th>
                <th className="px-3 py-2.5 text-left font-bold">Next</th>
                <th className="px-3 py-2.5 text-left font-bold" style={{ minWidth: '170px' }}>Every</th>
                <th className="px-3 py-2.5 text-left font-bold" style={{ width: '110px' }}>Stop after</th>
                <th className="px-3 py-2.5 text-right font-bold" style={{ minWidth: '150px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {eligible.map(r => {
                const d = draftFor(r);
                const busy = busyId === r.Quotation_ID;
                const dirty = isDirty(r);
                const stopped = r.Reminder_Stopped === true;
                return (
                  <tr key={r.Quotation_ID} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap">
                      <button onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                        className="hover:underline text-left">
                        {r.Quote_No_Display}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <button onClick={() => navigate(`/quotations/${r.Quotation_ID}`)}
                        className="font-medium truncate max-w-[200px] block text-left hover:underline">
                        {r.Customer_Name_Snapshot}
                      </button>
                      {stopped && (
                        <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-extrabold">
                          STOPPED
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center font-bold">{r.Reminder_Count || 0}</td>
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap text-xs">
                      {r.Last_Reminder_Sent_At ? formatDate(r.Last_Reminder_Sent_At.slice(0, 10)) : 'Never'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 font-semibold whitespace-nowrap text-xs">
                      {stopped ? '—' : (r.Next_Reminder_Date ? formatDate(r.Next_Reminder_Date) : '—')}
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="1" inputMode="numeric" disabled={busy}
                          value={d.value}
                          onChange={e => setDraft(r.Quotation_ID, { value: e.target.value })}
                          className="w-16 px-2 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                        <select
                          value={d.unit} disabled={busy}
                          onChange={e => setDraft(r.Quotation_ID, { unit: e.target.value })}
                          className="px-2 py-1.5 border border-slate-300 rounded-lg text-xs font-bold focus:outline-none focus:ring-2 focus:ring-slate-400"
                        >
                          <option value="days">days</option>
                          <option value="months">months</option>
                        </select>
                      </div>
                    </td>

                    <td className="px-3 py-2.5">
                      <input
                        type="number" min="0" inputMode="numeric" disabled={busy}
                        value={d.max}
                        placeholder="0"
                        onChange={e => setDraft(r.Quotation_ID, { max: e.target.value })}
                        className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {dirty && (
                          <button onClick={() => saveRow(r)} disabled={busy}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-extrabold disabled:opacity-50">
                            {busy ? '…' : 'Save'}
                          </button>
                        )}
                        {stopped ? (
                          <button
                            onClick={() => patchRow(r.Quotation_ID, { reminderStopped: false })}
                            disabled={busy}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 text-[11px] font-extrabold hover:bg-emerald-50 disabled:opacity-50"
                          >
                            Resume
                          </button>
                        ) : (
                          <button
                            onClick={() => patchRow(r.Quotation_ID, { reminderStopped: true })}
                            disabled={busy}
                            title="Stop reminders for this quotation"
                            className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-[11px] font-extrabold hover:bg-slate-100 disabled:opacity-50"
                          >
                            Stop
                          </button>
                        )}
                        <button onClick={() => sendNow(r)} disabled={busy}
                          className="px-2.5 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-[11px] font-extrabold hover:bg-indigo-50 disabled:opacity-50">
                          {busy ? '…' : 'Send now'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
