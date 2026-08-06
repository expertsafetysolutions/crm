import React, { useState, useMemo } from 'react';
import { Loader2, Bell, Search, X, ChevronDown, Send } from 'lucide-react';
import { formatDate } from '../utils/quotationUtils';
import { matchesQuery } from '../utils/searchUtils';

/**
 * Interval is stored in DAYS everywhere — the cron, the document row and the API all speak days.
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
 * Every document (quotation or PI) still on the reminder cron's open-status list, with its
 * cadence — including a one-time manual override of the next date — editable in place. Reuses
 * whatever rows the caller already fetched for its register.
 *
 * Shared between QuotationListPage and SalesDocumentsPage (PI tab) rather than copied twice: the
 * two document types differ only in id field, display number field, which statuses count as
 * "open", and the API path — everything else (draft/dirty/Save, Resume/Stop, Send now, the
 * editable Next-date input) is identical logic that must not drift between two copies.
 *
 * Editing lives here rather than only on the detail page because tuning a cadence is a
 * whole-list job — the office reviews every open document together and adjusts a few. Opening
 * twenty documents one at a time to change one number each was the friction this replaces.
 *
 * Props:
 *   rows            full row list already fetched by the caller
 *   loading         caller's loading flag
 *   token           auth token for the PATCH/POST calls
 *   onRowUpdated    called with the server's updated row so the caller can splice it into state
 *   idKey           e.g. 'Quotation_ID' or 'PI_ID'
 *   noKeyField      e.g. 'Quote_No_Display' or 'PI_No' — what the Number column displays
 *   endpointBase    e.g. '/api/quotations' or '/api/proforma-invoices'
 *   openStatuses    array of Status values that count as "still open" for this document type
 *   detailPath      optional (id) => path; when provided, Number/Customer link there. When
 *                   omitted (no detail route exists, e.g. PI today) they render as plain text.
 *   noun            singular label used in confirm dialogs and the empty state, e.g.
 *                   'quotation' / 'PI'
 */
export default function RemindersReport({
  rows, loading, navigate, token, onRowUpdated,
  idKey, noKeyField, endpointBase, openStatuses, detailPath, noun = 'document'
}) {
  const eligible = useMemo(
    () => rows
      .filter(r => openStatuses.includes(r.Status))
      .sort((a, b) => String(a.Next_Reminder_Date || '9999').localeCompare(String(b.Next_Reminder_Date || '9999'))),
    [rows, openStatuses]
  );

  // Per-row edits are held here until Save, keyed by idKey. Nothing is written as you type: a
  // cadence change mails real customers, so it should take a deliberate second action.
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  // Company/number search + a stopped/active filter — the office wants to answer "how many mails
  // did this company get" without scrolling a long list.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | stopped

  // Mobile cards start collapsed to a summary row (identity + sent count + Send now); cadence
  // fields open per-card on tap so twenty companies don't turn into a wall of date/number inputs.
  const [expandedId, setExpandedId] = useState(null);

  const filtered = useMemo(
    () => eligible
      .filter(r => statusFilter === 'all' ? true : statusFilter === 'stopped' ? r.Reminder_Stopped === true : r.Reminder_Stopped !== true)
      .filter(r => matchesQuery(query, [r.Customer_Name_Snapshot, r[noKeyField], r.Source_Quote_No])),
    [eligible, query, statusFilter, noKeyField]
  );

  const totalSent = useMemo(() => filtered.reduce((sum, r) => sum + (Number(r.Reminder_Count) || 0), 0), [filtered]);

  const draftFor = (r) => {
    if (drafts[r[idKey]]) return drafts[r[idKey]];
    const parts = toIntervalParts(r.Follow_Up_Interval_Days);
    return { value: parts.value, unit: parts.unit, max: Number(r.Max_Reminders) || 0, next: r.Next_Reminder_Date || '' };
  };

  const setDraft = (id, patch) =>
    setDrafts(d => ({ ...d, [id]: { ...draftFor(rows.find(x => x[idKey] === id) || {}), ...d[id], ...patch } }));

  const isDirty = (r) => {
    const d = drafts[r[idKey]];
    if (!d) return false;
    const saved = toIntervalParts(r.Follow_Up_Interval_Days);
    return toDays(d.value, d.unit) !== toDays(saved.value, saved.unit)
      || Number(d.max) !== (Number(r.Max_Reminders) || 0)
      || (d.next || '') !== (r.Next_Reminder_Date || '');
  };

  const patchRow = async (id, body) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`${endpointBase}/${id}/reminder-settings`, {
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
    const body = { followUpIntervalDays: days, maxReminders: Number(d.max) || 0 };
    // Only sent when actually edited — a manual date is a one-time override; after it fires the
    // normal today+interval cadence resumes on its own (server-side, no separate "resume" step).
    if ((d.next || '') !== (r.Next_Reminder_Date || '')) body.nextReminderDate = d.next || '';
    patchRow(r[idKey], body);
  };

  /** Sends one reminder right now. Confirms first — a mis-tap while scrolling must not mail a
   *  customer, and an email cannot be recalled. */
  const sendNow = async (r) => {
    const ok = window.confirm(
      `Send a follow-up reminder to ${r.Customer_Name_Snapshot} now?\n\n${r[noKeyField]}\n\nThis emails the customer immediately.`
    );
    if (!ok) return;

    const id = r[idKey];
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`${endpointBase}/${id}/send-reminder`, {
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
        <div className="text-sm font-semibold">No {noun}s are currently on a reminder cadence</div>
      </div>
    );
  }

  const filterChip = (key, label) => (
    <button
      onClick={() => setStatusFilter(key)}
      className={`px-3 py-1.5 rounded-lg text-xs font-extrabold border whitespace-nowrap ${
        statusFilter === key
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-2.5 rounded-xl text-xs font-semibold">
          {error}
        </div>
      )}
      <p className="text-[11px] text-slate-500 px-1">
        Reminders stop on their own once a {noun} reaches its limit, or when it is accepted,
        rejected, converted or expires. Leave the limit at 0 for no limit.
      </p>

      {/* Filter bar: company/number search + active/stopped chips + a running total so the office
          can answer "how many mails did this company get" at a glance. Sticky so it stays
          reachable while scrolling a long list on a phone. */}
      <div className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm -mx-1 px-1 pt-1 pb-2 flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search company or number…"
            className="w-full h-11 pl-9 pr-9 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {filterChip('all', `All (${eligible.length})`)}
          {filterChip('active', 'Active')}
          {filterChip('stopped', 'Stopped')}
        </div>
      </div>

      <div className="flex items-center justify-between px-1 text-[11px] text-slate-500 font-semibold">
        <span>{filtered.length} {noun}{filtered.length === 1 ? '' : 's'}</span>
        <span>{totalSent} reminder{totalSent === 1 ? '' : 's'} sent</span>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <Search className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <div className="text-sm font-semibold">No {noun}s match this search</div>
        </div>
      ) : (
      <>
      {/* Mobile / narrow view: collapsed summary cards that expand per-row for cadence editing —
          twenty companies stay scannable instead of turning into a wall of date/number inputs. */}
      <div className="sm:hidden space-y-2">
        {filtered.map(r => {
          const id = r[idKey];
          const d = draftFor(r);
          const busy = busyId === id;
          const dirty = isDirty(r);
          const stopped = r.Reminder_Stopped === true;
          const open = expandedId === id;
          return (
            <div key={id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedId(open ? null : id)}
                className="w-full flex items-center gap-2.5 px-3 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-extrabold text-sm truncate">{r[noKeyField]}</span>
                    {stopped && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[9px] font-extrabold">STOPPED</span>
                    )}
                  </div>
                  <div className="text-slate-600 text-xs truncate">{r.Customer_Name_Snapshot}</div>
                  {r.Source_Quote_No && <div className="text-[10px] text-slate-400">from {r.Source_Quote_No}</div>}
                </div>
                <div className="shrink-0 text-center px-2">
                  <div className="text-lg font-extrabold text-slate-900 leading-none">{r.Reminder_Count || 0}</div>
                  <div className="text-[9px] uppercase text-slate-400 font-bold">sent</div>
                </div>
                <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>

              <div className="flex items-center gap-2 px-3 pb-3 text-[11px] text-slate-500">
                <span>Last sent: <span className="font-semibold text-slate-600">{r.Last_Reminder_Sent_At ? formatDate(r.Last_Reminder_Sent_At.slice(0, 10)) : 'Never'}</span></span>
                <span className="text-slate-300">•</span>
                <span>Limit: <span className="font-semibold text-slate-600">{Number(r.Max_Reminders) || '∞'}</span></span>
                <button onClick={() => sendNow(r)} disabled={busy}
                  className="ml-auto flex items-center gap-1 h-8 px-2.5 rounded-lg border border-indigo-300 text-indigo-700 text-[11px] font-extrabold hover:bg-indigo-50 disabled:opacity-50">
                  <Send className="w-3 h-3" />{busy ? '…' : 'Send now'}
                </button>
              </div>

              {open && (
                <div className="border-t border-slate-100 p-3 space-y-2 bg-slate-50/60">
                  <div className="grid grid-cols-3 gap-1.5">
                    <label className="block">
                      <span className="text-[9px] uppercase text-slate-400 font-bold">Every</span>
                      <input
                        type="number" min="1" inputMode="numeric" disabled={busy}
                        value={d.value}
                        onChange={e => setDraft(id, { value: e.target.value })}
                        className="jc-input w-full h-10 px-2 border border-slate-300 rounded-lg text-sm font-semibold bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[9px] uppercase text-slate-400 font-bold">Unit</span>
                      <select
                        value={d.unit} disabled={busy}
                        onChange={e => setDraft(id, { unit: e.target.value })}
                        className="w-full h-10 px-1.5 border border-slate-300 rounded-lg text-xs font-bold bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      >
                        <option value="days">days</option>
                        <option value="months">months</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[9px] uppercase text-slate-400 font-bold">Stop after</span>
                      <input
                        type="number" min="0" inputMode="numeric" disabled={busy}
                        value={d.max}
                        placeholder="0"
                        onChange={e => setDraft(id, { max: e.target.value })}
                        className="jc-input w-full h-10 px-2 border border-slate-300 rounded-lg text-sm font-semibold bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                    </label>
                  </div>

                  {!stopped && (
                    <label className="block">
                      <span className="text-[9px] uppercase text-slate-400 font-bold">Next (one-time override)</span>
                      <input
                        type="date" disabled={busy}
                        value={d.next}
                        onChange={e => setDraft(id, { next: e.target.value })}
                        className="jc-input w-full h-10 px-2 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400"
                      />
                    </label>
                  )}

                  <div className="flex items-center gap-1.5 pt-0.5">
                    {dirty && (
                      <button onClick={() => saveRow(r)} disabled={busy}
                        className="flex-1 h-10 rounded-lg bg-slate-900 text-white text-xs font-extrabold disabled:opacity-50">
                        {busy ? '…' : 'Save'}
                      </button>
                    )}
                    {stopped ? (
                      <button
                        onClick={() => patchRow(id, { reminderStopped: false })}
                        disabled={busy}
                        className="flex-1 h-10 rounded-lg border border-emerald-300 text-emerald-700 text-xs font-extrabold hover:bg-emerald-50 disabled:opacity-50"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={() => patchRow(id, { reminderStopped: true })}
                        disabled={busy}
                        className="flex-1 h-10 rounded-lg border border-slate-300 text-slate-600 text-xs font-extrabold hover:bg-slate-100 disabled:opacity-50"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop / wide view: original Excel-like table, unchanged behaviour. */}
      <div className="hidden sm:block bg-white border border-slate-200 rounded-xl overflow-hidden">
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
              {filtered.map(r => {
                const id = r[idKey];
                const d = draftFor(r);
                const busy = busyId === id;
                const dirty = isDirty(r);
                const stopped = r.Reminder_Stopped === true;
                const numberCell = (
                  <>
                    {r[noKeyField]}
                    {r.Source_Quote_No && (
                      <div className="text-[10px] text-slate-400 font-normal">from {r.Source_Quote_No}</div>
                    )}
                  </>
                );
                return (
                  <tr key={id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap">
                      {detailPath ? (
                        <button onClick={() => navigate(detailPath(id))} className="hover:underline text-left">
                          {numberCell}
                        </button>
                      ) : numberCell}
                    </td>
                    <td className="px-3 py-2.5">
                      {detailPath ? (
                        <button onClick={() => navigate(detailPath(id))}
                          className="font-medium truncate max-w-[200px] block text-left hover:underline">
                          {r.Customer_Name_Snapshot}
                        </button>
                      ) : (
                        <div className="font-medium truncate max-w-[200px]">{r.Customer_Name_Snapshot}</div>
                      )}
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

                    <td className="px-3 py-2.5">
                      {stopped ? (
                        <span className="text-slate-400 text-xs">—</span>
                      ) : (
                        <input
                          type="date" disabled={busy}
                          value={d.next}
                          onChange={e => setDraft(id, { next: e.target.value })}
                          title="One-time override — normal cadence resumes automatically after this date."
                          className="px-2 py-1.5 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="1" inputMode="numeric" disabled={busy}
                          value={d.value}
                          onChange={e => setDraft(id, { value: e.target.value })}
                          className="w-16 px-2 py-1.5 border border-slate-300 rounded-lg text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                        <select
                          value={d.unit} disabled={busy}
                          onChange={e => setDraft(id, { unit: e.target.value })}
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
                        onChange={e => setDraft(id, { max: e.target.value })}
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
                            onClick={() => patchRow(id, { reminderStopped: false })}
                            disabled={busy}
                            className="px-2.5 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 text-[11px] font-extrabold hover:bg-emerald-50 disabled:opacity-50"
                          >
                            Resume
                          </button>
                        ) : (
                          <button
                            onClick={() => patchRow(id, { reminderStopped: true })}
                            disabled={busy}
                            title={`Stop reminders for this ${noun}`}
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
      </>
      )}
    </div>
  );
}
