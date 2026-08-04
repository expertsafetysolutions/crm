import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, AlertTriangle, Plus, X, Loader2, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery } from '../utils/searchUtils';
import SmartSearchSelect from '../components/SmartSearchSelect';
import useModalBackButton from '../utils/useModalBackButton';

/**
 * CertificateDueReportPage — every piece of equipment whose validity is expiring soon, flattened
 * from every certificate's itemsList[].nextDate (the per-item expiry — see CLAUDE.md/the certificate
 * generator's computeCertValidUntil) plus manually-added legacy entries for paper customers with no
 * certificate ever generated in this system.
 *
 * This is a DISPLAY window (default: next 60 days) independent of the reminder cron's own fixed
 * 30-day trigger — the report lets the office see what's coming before the automated email fires.
 */

const WINDOW_DAYS_DEFAULT = 60;

function daysFromToday(dateStr) {
  if (!dateStr) return null;
  const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const due = new Date(String(dateStr).slice(0, 10));
  return Math.round((due - today) / 86400000);
}

function equipmentSummary(items) {
  return (items || [])
    .map(it => [it.itemName, it.capacity].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
}

function totalQty(items) {
  return (items || []).reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
}

/** Flattens certificates -> one row per DUE DATE per certificate (items sharing a date are grouped). */
function certificateDueRows(certificates) {
  const rows = [];
  for (const cert of certificates) {
    if (cert.Is_Deleted) continue;
    const byDate = new Map();
    for (const item of (cert.itemsList || [])) {
      if (!item.nextDate) continue;
      if (!byDate.has(item.nextDate)) byDate.set(item.nextDate, []);
      byDate.get(item.nextDate).push(item);
    }
    for (const [dueDate, items] of byDate) {
      rows.push({
        kind: 'certificate',
        key: `${cert.verificationGuid || cert.Verification_GUID}::${dueDate}`,
        guid: cert.verificationGuid || cert.Verification_GUID,
        certificateNo: cert.Certificate_No || cert.certificateNo,
        certificateDate: cert.Issue_Date || cert.issueDate,
        challanNo: cert.Source_Challan_No || '',
        challanDate: cert.Challan_Date || cert.challanDate || '',
        companyName: cert.Customer_Name || cert.customerName,
        items,
        dueDate,
        reminderEnabled: cert.Due_Reminder_Enabled !== false,
        raw: cert
      });
    }
  }
  return rows;
}

function manualDueRows(entries) {
  return entries
    .filter(e => !e.Is_Deleted)
    .map(e => ({
      kind: 'manual',
      key: e.Due_Entry_ID,
      id: e.Due_Entry_ID,
      certificateNo: '',
      certificateDate: '',
      challanNo: '',
      challanDate: '',
      companyName: e.Customer_Name,
      items: e.Equipment_List || [],
      dueDate: e.Due_Date,
      reminderEnabled: e.Due_Reminder_Enabled !== false,
      raw: e
    }));
}

export default function CertificateDueReportPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [certificates, setCertificates] = useState([]);
  const [manualEntries, setManualEntries] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState('');
  const [windowDays, setWindowDays] = useState(WINDOW_DAYS_DEFAULT);
  const [togglingKey, setTogglingKey] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const loadAll = () => {
    setLoading(true);
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/certificates', { headers }).then(r => r.ok ? r.json() : []),
      fetch('/api/manual-due-entries', { headers }).then(r => r.ok ? r.json() : []),
      fetch('/api/customers', { headers }).then(r => r.ok ? r.json() : [])
    ])
      .then(([certs, entries, custs]) => {
        setCertificates(Array.isArray(certs) ? certs : []);
        setManualEntries(Array.isArray(entries) ? entries : []);
        setCustomers(Array.isArray(custs) ? custs : []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadAll, [token]);

  const allRows = useMemo(() => [
    ...certificateDueRows(certificates),
    ...manualDueRows(manualEntries)
  ], [certificates, manualEntries]);

  const visible = useMemo(() => {
    return allRows.filter(row => {
      const days = daysFromToday(row.dueDate);
      if (days === null || days < 0 || days > windowDays) return false;
      if (month && !String(row.dueDate).startsWith(month)) return false;
      if (!query.trim()) return true;
      return matchesQuery(query, [row.companyName, row.certificateNo, row.challanNo, equipmentSummary(row.items)]);
    }).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  }, [allRows, query, month, windowDays]);

  const toggleReminder = async (row) => {
    setTogglingKey(row.key);
    try {
      const next = !row.reminderEnabled;
      // Dedicated toggle routes, not the generic PUT — turning a reminder back on also resets its
      // cadence state (sentCount/stopped) so it starts fresh instead of being immediately
      // re-stopped by whatever count/overdue cap it had already crossed.
      if (row.kind === 'certificate') {
        const res = await fetch(`/api/certificates/${row.guid}/due-reminder-toggle`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Update failed');
        setCertificates(prev => prev.map(c => (c.verificationGuid || c.Verification_GUID) === row.guid
          ? { ...c, Due_Reminder_Enabled: next, Due_Reminder_Offsets_Sent: next ? [] : c.Due_Reminder_Offsets_Sent }
          : c));
      } else {
        const res = await fetch(`/api/manual-due-entries/${row.id}/due-reminder-toggle`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Update failed');
        setManualEntries(prev => prev.map(e => e.Due_Entry_ID === row.id
          ? { ...e, Due_Reminder_Enabled: next, Due_Reminder_Offsets_Sent: next ? [] : e.Due_Reminder_Offsets_Sent }
          : e));
      }
    } catch (e) {
      alert('Could not update reminder setting: ' + e.message);
    } finally {
      setTogglingKey('');
    }
  };

  const deleteManualEntry = async (row) => {
    if (!window.confirm(`Remove the manual due entry for ${row.companyName}?`)) return;
    try {
      const res = await fetch(`/api/manual-due-entries/${row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Delete failed');
      setManualEntries(prev => prev.filter(e => e.Due_Entry_ID !== row.id));
    } catch (e) {
      alert('Could not delete entry: ' + e.message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <p className="flex-1 text-sm font-extrabold text-slate-900">Due Certificate Report</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="shrink-0 min-h-[44px] px-3 rounded-xl bg-slate-900 text-white text-xs font-extrabold flex items-center gap-1.5 active:bg-slate-800"
          >
            <Plus className="w-4 h-4" /> Manual Entry
          </button>
        </div>
        <div className="max-w-5xl mx-auto px-3 pb-2 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search company, cert no, challan no…"
              className="w-full min-h-[44px] pl-9 pr-3 rounded-xl border border-slate-200 bg-white text-sm font-bold placeholder:font-normal focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
          </div>
          <div className="flex gap-2">
            <input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="min-h-[44px] px-3 rounded-xl border border-slate-200 bg-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
            <select
              value={windowDays}
              onChange={e => setWindowDays(Number(e.target.value))}
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-slate-200 bg-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            >
              <option value={30}>Due within 30 days</option>
              <option value={60}>Due within 60 days</option>
              <option value={90}>Due within 90 days</option>
              <option value={365}>Due within 1 year</option>
            </select>
            {month && (
              <button onClick={() => setMonth('')} className="min-h-[44px] px-3 rounded-xl bg-slate-100 text-slate-600 text-xs font-extrabold active:bg-slate-200">
                Clear month
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-3 py-3 space-y-2">
        {loading && <p className="text-center text-xs text-slate-400 py-8 animate-pulse">Loading…</p>}
        {error && <p className="text-center text-xs font-bold text-rose-600 py-8">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="text-center text-xs text-slate-400 py-10">Nothing due in this window.</p>
        )}

        {visible.map(row => {
          const days = daysFromToday(row.dueDate);
          const urgent = days !== null && days <= 30;
          return (
            <div key={row.key} className={`w-full rounded-xl bg-white border flex items-center gap-1 pr-2 ${urgent ? 'border-amber-300' : 'border-slate-200'}`}>
              <div className="flex-1 min-w-0 px-3 py-2.5 flex items-center gap-2.5">
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${urgent ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'}`}>
                  <AlertTriangle className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-slate-900 truncate">
                    {row.companyName || 'Unknown company'}
                    {row.kind === 'manual' && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-indigo-100 text-indigo-700">MANUAL</span>}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {row.certificateNo ? `Cert ${row.certificateNo} · ${row.certificateDate}` : 'No certificate on file'}
                    {row.challanNo && ` · DC ${row.challanNo} (${row.challanDate})`}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {equipmentSummary(row.items) || 'No items'} · {totalQty(row.items)} qty · Due {row.dueDate} ({days === 0 ? 'today' : days < 0 ? 'overdue' : `${days}d`})
                  </p>
                </div>
              </div>

              {row.kind === 'manual' && (
                <button
                  onClick={() => deleteManualEntry(row)}
                  title="Remove this manual entry"
                  aria-label="Remove manual entry"
                  className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-rose-500 active:bg-rose-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}

              <button
                onClick={() => toggleReminder(row)}
                disabled={togglingKey === row.key}
                title={row.reminderEnabled ? 'Due-reminder email ON — tap to turn off' : 'Due-reminder email OFF — tap to turn on'}
                aria-label={row.reminderEnabled ? 'Turn off due reminder' : 'Turn on due reminder'}
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
              >
                {togglingKey === row.key
                  ? <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                  : row.reminderEnabled
                    ? <ToggleRight className="w-7 h-7 text-amber-600" />
                    : <ToggleLeft className="w-7 h-7 text-slate-300" />}
              </button>
            </div>
          );
        })}
      </main>

      {showAddModal && (
        <AddManualDueEntryModal
          token={token}
          customers={customers}
          onClose={() => setShowAddModal(false)}
          onSaved={() => { setShowAddModal(false); loadAll(); }}
        />
      )}
    </div>
  );
}

function AddManualDueEntryModal({ token, customers, onClose, onSaved }) {
  // Only mounted while open, so `true` is always correct: the phone back button closes this modal
  // instead of exiting the app. See useModalBackButton.
  useModalBackButton(true, onClose);

  const [customer, setCustomer] = useState(null);
  const [items, setItems] = useState([{ itemName: '', capacity: '', qty: '1' }]);
  const [dueDate, setDueDate] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const addItemRow = () => setItems(prev => [...prev, { itemName: '', capacity: '', qty: '1' }]);
  const removeItemRow = (idx) => setItems(prev => prev.filter((_, i) => i !== idx));
  const updateItemRow = (idx, field, value) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));

  const canSave = customer && dueDate && items.some(it => it.itemName.trim());

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch('/api/manual-due-entries', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Customer_ID: customer.Customer_ID,
          Customer_Name: customer.Company_Name,
          Equipment_List: items.filter(it => it.itemName.trim()).map(it => ({ ...it, qty: Number(it.qty) || 1 })),
          Due_Date: dueDate,
          Due_Reminder_Enabled: reminderEnabled
        })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      onSaved();
    } catch (e) {
      alert('Could not save entry: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <p className="text-sm font-extrabold text-slate-900">Add Manual Due Entry</p>
          <button onClick={onClose} className="w-9 h-9 rounded-xl flex items-center justify-center active:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-[11px] text-slate-500">
            For a legacy/paper customer with no certificate ever generated in this system. This creates
            a due-tracking row only — not a real certificate.
          </p>

          <SmartSearchSelect
            label="Company"
            placeholder="Search company name…"
            options={customers}
            value={customer}
            onChange={setCustomer}
            getKey={c => c.Customer_ID}
            getLabel={c => c.Company_Name}
            getSubtitle={c => [c.Contact, c.Address].filter(Boolean).join(' · ')}
          />

          <div>
            <label className="block text-[10px] font-bold text-slate-600 mb-1">Due Date *</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="jc-input w-full min-h-[44px] px-3 rounded-xl border border-slate-200 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-slate-600">Equipment Due</label>
            {items.map((it, idx) => (
              <div key={idx} className="flex gap-1.5 items-center">
                <input
                  value={it.itemName}
                  onChange={e => updateItemRow(idx, 'itemName', e.target.value)}
                  placeholder="Item name"
                  className="jc-input flex-1 min-w-0 min-h-[44px] px-2.5 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                />
                <input
                  value={it.capacity}
                  onChange={e => updateItemRow(idx, 'capacity', e.target.value)}
                  placeholder="Capacity"
                  className="jc-input w-20 shrink-0 min-h-[44px] px-2.5 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                />
                <input
                  type="number"
                  min="1"
                  value={it.qty}
                  onChange={e => updateItemRow(idx, 'qty', e.target.value)}
                  placeholder="Qty"
                  className="jc-input w-16 shrink-0 min-h-[44px] px-2.5 rounded-xl border border-slate-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
                />
                {items.length > 1 && (
                  <button onClick={() => removeItemRow(idx)} className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-rose-500 active:bg-rose-50" aria-label="Remove row">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button onClick={addItemRow} className="text-xs font-extrabold text-amber-700 active:text-amber-800 flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add another item
            </button>
          </div>

          <button
            onClick={() => setReminderEnabled(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border border-slate-200"
          >
            <span className="text-xs font-bold text-slate-700">Send 30-day due-reminder email</span>
            {reminderEnabled ? <ToggleRight className="w-7 h-7 text-amber-600" /> : <ToggleLeft className="w-7 h-7 text-slate-300" />}
          </button>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-200 p-3 pb-safe">
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="w-full min-h-[48px] rounded-xl bg-slate-900 text-white text-sm font-extrabold flex items-center justify-center gap-2 disabled:opacity-40 active:bg-slate-800"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save Entry'}
          </button>
        </div>
      </div>
    </div>
  );
}
