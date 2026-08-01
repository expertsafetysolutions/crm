import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, FileText, Loader2, ToggleLeft, ToggleRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery } from '../utils/searchUtils';

/**
 * CertificateReportPage — the certificate register.
 *
 * Modeled on ChallanListPage.jsx: single fetch into `rows`, all filtering client-side. Reads the
 * same /api/certificates endpoint the generator itself uses, so this page needs no server changes
 * beyond the per-row Due_Reminder_Enabled toggle (PUT /api/certificates/:guid — the existing route
 * already accepts a partial body).
 */

function totalQty(itemsList) {
  return (itemsList || []).reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
}

function equipmentSummary(itemsList) {
  return (itemsList || [])
    .map(it => [it.itemName, it.capacity].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
}

/** The certificate's overall due date — the latest per-item nextDate, i.e. what Valid_Until means. */
function overallDueDate(cert) {
  const dates = (cert.itemsList || []).map(it => it.nextDate).filter(Boolean).sort();
  return dates[dates.length - 1] || cert.Valid_Until || cert.validUntil || '';
}

export default function CertificateReportPage() {
  const navigate = useNavigate();
  const { token } = useAuth();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState(''); // yyyy-mm, filters on Issue_Date
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [togglingId, setTogglingId] = useState('');

  useEffect(() => {
    fetch('/api/certificates', { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || 'Could not load certificates');
        return r.json();
      })
      .then(data => setRows(Array.isArray(data) ? data.filter(c => !c.Is_Deleted) : []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const typeOptions = useMemo(() => {
    const seen = new Set();
    rows.forEach(r => { const t = r.formatType || r.Format_Type; if (t) seen.add(t); });
    return ['ALL', ...Array.from(seen).sort()];
  }, [rows]);

  const visible = useMemo(() => {
    return rows.filter(r => {
      const type = r.formatType || r.Format_Type;
      if (typeFilter !== 'ALL' && type !== typeFilter) return false;
      const issueDate = r.Issue_Date || r.issueDate || '';
      if (month && !issueDate.startsWith(month)) return false;
      if (!query.trim()) return true;
      return matchesQuery(query, [
        r.Certificate_No || r.certificateNo,
        r.Customer_Name || r.customerName,
        r.Source_Challan_No,
        equipmentSummary(r.itemsList)
      ]);
    });
  }, [rows, query, month, typeFilter]);

  const toggleReminder = async (cert) => {
    const guid = cert.verificationGuid || cert.Verification_GUID;
    const next = !(cert.Due_Reminder_Enabled !== false);
    setTogglingId(guid);
    try {
      // Dedicated toggle route, not the generic PUT — turning this back on also resets the item's
      // reminder cadence (sentCount/stopped) so a reactivated item starts fresh instead of being
      // immediately re-stopped by whatever cap it had already hit.
      const res = await fetch(`/api/certificates/${guid}/due-reminder-toggle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');
      setRows(prev => prev.map(r => {
        const g = r.verificationGuid || r.Verification_GUID;
        return g === guid ? { ...r, Due_Reminder_Enabled: next, Due_Reminder_Offsets_Sent: next ? [] : r.Due_Reminder_Offsets_Sent } : r;
      }));
    } catch (e) {
      alert('Could not update reminder setting: ' + e.message);
    } finally {
      setTogglingId('');
    }
  };

  const openCertificate = (cert) => {
    const certNo = cert.Certificate_No || cert.certificateNo || '';
    navigate(`/certificate-compliance/new?openCertNo=${encodeURIComponent(certNo)}`);
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-8">
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="w-10 h-10 rounded-xl border border-slate-200 flex items-center justify-center active:bg-slate-100 shrink-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4 text-slate-600" />
          </button>
          <p className="flex-1 text-sm font-extrabold text-slate-900">Certificate Report</p>
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
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-slate-200 bg-white text-sm font-bold focus:outline-none focus:ring-2 focus:ring-slate-900/10"
            >
              {typeOptions.map(t => <option key={t} value={t}>{t === 'ALL' ? 'All Types' : t}</option>)}
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
          <p className="text-center text-xs text-slate-400 py-10">No certificate matches that.</p>
        )}

        {visible.map(cert => {
          const guid = cert.verificationGuid || cert.Verification_GUID;
          const reminderOn = cert.Due_Reminder_Enabled !== false;
          const equipment = equipmentSummary(cert.itemsList);
          const qty = totalQty(cert.itemsList);
          const dueDate = overallDueDate(cert);

          return (
            <div key={guid} className="w-full rounded-xl bg-white border border-slate-200 flex items-center gap-1 pr-2">
              <button
                onClick={() => openCertificate(cert)}
                className="flex-1 min-w-0 px-3 py-2.5 text-left active:bg-slate-50 rounded-l-xl flex items-center gap-2.5"
              >
                <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-amber-50 text-amber-600">
                  <FileText className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-slate-900 truncate">
                    {cert.Certificate_No || cert.certificateNo || 'Draft'} · {cert.formatType || cert.Format_Type}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {cert.Customer_Name || cert.customerName} · Cert {cert.Issue_Date || cert.issueDate}
                    {cert.Source_Challan_No && ` · DC ${cert.Source_Challan_No} (${cert.Challan_Date || cert.challanDate})`}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {equipment || 'No items'}{qty ? ` · ${qty} qty` : ''} · Due {dueDate || '—'}
                  </p>
                </div>
              </button>

              <button
                onClick={() => toggleReminder(cert)}
                disabled={togglingId === guid}
                title={reminderOn ? 'Due-reminder email ON for this certificate — tap to turn off' : 'Due-reminder email OFF for this certificate — tap to turn on'}
                aria-label={reminderOn ? 'Turn off due reminder' : 'Turn on due reminder'}
                className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
              >
                {togglingId === guid
                  ? <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                  : reminderOn
                    ? <ToggleRight className="w-7 h-7 text-amber-600" />
                    : <ToggleLeft className="w-7 h-7 text-slate-300" />}
              </button>
            </div>
          );
        })}
      </main>
    </div>
  );
}
