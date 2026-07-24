import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDocSettings } from '../context/DocSettingsContext';
import { ChevronLeft, Search, Building2, CheckCircle2, Loader2 } from 'lucide-react';
import FieldVisitInspector from '../components/servicereport/FieldVisitInspector';
import ServiceReportStatsPanel from '../components/servicereport/ServiceReportStatsPanel';
import { calculateAmcSchedule } from './CertificateGeneratorPage';
import {
  resolveNumbering,
  nextSequenceForType,
  buildReportId,
  getReportType,
  TABLE_SCHEMA_CURRENT
} from '../utils/reportTypeSchemas';

/**
 * One field visit = one client, one continuous walk-through covering every equipment family the
 * client has on file (see FieldVisitInspector). "Finish Visit" turns each family actually touched
 * into its own normal Service_Reports document — same shape and approval flow every report
 * created through the certificate generator already uses — tagged with a shared Visit_ID so the
 * Admin queue can show them as siblings from one visit.
 */
function buildReportPayload(reportType, itemsList, customer, technicianName, serviceDate, srCfg, allReports, visitId) {
  const numbering = resolveNumbering(reportType, srCfg);
  const sequence = nextSequenceForType(reportType, srCfg, allReports);
  const type = getReportType(reportType);
  return {
    certPrefix: numbering.prefix,
    certPeriod: numbering.period,
    certSequence: sequence,
    Report_ID: buildReportId({ ...numbering, sequence }),
    title: type.title,
    customerName: customer.Company_Name || customer.Customer_Name || '',
    customerId: customer.Customer_ID || customer.customerId || '',
    address: customer.Address || customer.Location || '',
    gstin: customer.GSTIN || customer.Gst_No || '',
    contact: customer.Contact || customer.Phone || customer.Mobile || customer.Contact_Number || '',
    authPerson: customer.Auth_Person || '',
    serviceDate,
    serviceFrequency: '3',
    nextServiceDue: new Date(new Date(serviceDate).setMonth(new Date(serviceDate).getMonth() + 3)).toISOString().split('T')[0],
    amcSchedule: calculateAmcSchedule(serviceDate, 3),
    technicians: technicianName,
    Status: 'Pending Approval',
    Approval_Remarks: '',
    Reviewed_By: '',
    Reviewed_At: '',
    isLocked: false,
    revision: 0,
    verificationGuid: 'SR-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    authorizedSignatory: 'NILESHKUMAR MANJIBHAI PADAYA',
    fieldObservations: 'All fire safety installations inspected on-site during the field visit.',
    recommendations: '',
    customColumns: [],
    itemsList,
    reportType,
    autoSummary: true,
    tableSchemaVersion: TABLE_SCHEMA_CURRENT,
    Visit_ID: visitId
  };
}

export default function FieldVisitPage() {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { user, token } = useAuth();
  const { docSettings } = useDocSettings();
  const srCfg = docSettings?.document_configs?.SERVICE_REPORT || {};
  const technicianName = user?.Name || 'Technician';

  const [customers, setCustomers] = useState([]);
  const [allReports, setAllReports] = useState([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [customer, setCustomer] = useState(null);
  const [visit, setVisit] = useState(null);
  const [byType, setByType] = useState({});
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const formsRef = useRef({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [customersRes, reportsRes] = await Promise.all([
          fetch('/api/customers', { headers }),
          fetch('/api/service-reports', { headers })
        ]);
        const customersData = customersRes.ok ? await customersRes.json() : [];
        const reportsData = reportsRes.ok ? await reportsRes.json() : [];
        if (cancelled) return;
        setCustomers(Array.isArray(customersData) ? customersData : []);
        setAllReports(Array.isArray(reportsData) ? reportsData : []);

        if (visitId) {
          const visitRes = await fetch(`/api/field-visits/${encodeURIComponent(visitId)}`, { headers });
          if (visitRes.ok) {
            const visitData = await visitRes.json();
            if (cancelled) return;
            setVisit(visitData);
            const c = (Array.isArray(customersData) ? customersData : []).find(
              cc => String(cc.Customer_ID) === String(visitData.Customer_ID)
            );
            if (c) {
              setCustomer(c);
              const eqRes = await fetch(`/api/client-equipment/${encodeURIComponent(visitData.Customer_ID)}/all`, { headers });
              if (eqRes.ok && !cancelled) setByType(await eqRes.json());
            }
          }
        }
      } catch (err) {
        console.error('Failed to load field visit page data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visitId, token]);

  const handleSelectCustomer = async (c) => {
    setCustomerSearch(c.Company_Name || c.Customer_Name || '');
    setShowDropdown(false);
    setStarting(true);
    try {
      const customerId = c.Customer_ID || c.customerId || '';
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const [visitRes, eqRes] = await Promise.all([
        fetch('/api/field-visits', { method: 'POST', headers, body: JSON.stringify({ Customer_ID: customerId }) }),
        fetch(`/api/client-equipment/${encodeURIComponent(customerId)}/all`, { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (!visitRes.ok) throw new Error('Could not start field visit');
      const { visit: newVisit } = await visitRes.json();
      setCustomer(c);
      setVisit(newVisit);
      setByType(eqRes.ok ? await eqRes.json() : {});
      navigate(`/field-visit/${encodeURIComponent(newVisit.Visit_ID)}`, { replace: true });
    } catch (err) {
      alert('Could not start the field visit: ' + err.message);
    } finally {
      setStarting(false);
    }
  };

  const handleFormsChange = useCallback((forms) => { formsRef.current = forms; }, []);

  const handleFinishVisit = async () => {
    const forms = formsRef.current;
    const touchedFamilies = Object.entries(forms).filter(([, f]) => (f.itemsList || []).length > 0);
    if (!touchedFamilies.length) {
      alert('No equipment was checked yet — search and save at least one item first.');
      return;
    }
    if (!window.confirm(`Finish this visit and submit ${touchedFamilies.length} report(s) for approval — one per equipment type checked?`)) return;

    setFinishing(true);
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const serviceDate = new Date().toISOString().split('T')[0];
      const reportIds = [];
      for (const [reportType, form] of touchedFamilies) {
        const payload = buildReportPayload(reportType, form.itemsList, customer, technicianName, serviceDate, srCfg, allReports, visit.Visit_ID);
        const res = await fetch('/api/service-reports', { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(`Failed to submit the ${getReportType(reportType).shortLabel} report`);
        reportIds.push(payload.Report_ID);
      }
      await fetch(`/api/field-visits/${encodeURIComponent(visit.Visit_ID)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ Status: 'COMPLETED', reportIds })
      });
      alert(`✅ Visit complete — ${reportIds.length} report(s) submitted for approval.`);
      navigate('/');
    } catch (err) {
      alert('Could not finish the visit: ' + err.message);
    } finally {
      setFinishing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading field visit…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-5">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="p-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-600"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-black text-slate-900">Field Visit — Guided Inspection</h1>
        </div>

        {!visit ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-2">
            <p className="text-xs text-slate-500 font-semibold">
              Select the client you're visiting. Every equipment type they have on file (Fire Extinguisher, System, Alarm...)
              will be searchable together, so you only need to walk the site once.
            </p>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search client by company name…"
                value={customerSearch}
                onChange={e => { setCustomerSearch(e.target.value); setShowDropdown(true); }}
                onFocus={() => setShowDropdown(true)}
                className="w-full pl-9 pr-3 py-2.5 bg-white border border-slate-300 rounded-xl font-bold text-sm text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-none"
              />
              {showDropdown && (
                <div className="absolute z-10 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-lg">
                  {customers
                    .filter(c => !customerSearch.trim() || (c.Company_Name || c.Customer_Name || '').toLowerCase().includes(customerSearch.toLowerCase()))
                    .slice(0, 30)
                    .map(c => (
                      <button
                        key={c.Customer_ID || c.customerId}
                        type="button"
                        onMouseDown={() => handleSelectCustomer(c)}
                        className="w-full text-left px-3 py-2 hover:bg-amber-50 border-b border-slate-100 last:border-0"
                      >
                        <div className="flex items-center gap-2 font-bold text-slate-900 text-sm">
                          <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          {c.Company_Name || c.Customer_Name}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">{c.Address}</div>
                      </button>
                    ))}
                </div>
              )}
            </div>
            {starting && <p className="text-xs text-slate-500 font-semibold flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting visit…</p>}
          </div>
        ) : (
          <>
            <div className="bg-white border border-slate-200 rounded-2xl p-3.5 shadow-sm flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-black text-slate-900 truncate">{customer?.Company_Name || customer?.Customer_Name}</div>
                <div className="text-[11px] text-slate-400 truncate">{customer?.Address}</div>
              </div>
              <button
                type="button"
                onClick={handleFinishVisit}
                disabled={finishing}
                className="shrink-0 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl font-black text-xs flex items-center gap-1.5 shadow-md transition"
              >
                <CheckCircle2 className="w-4 h-4" />
                {finishing ? 'Submitting…' : 'Finish Visit'}
              </button>
            </div>

            <FieldVisitInspector
              customerId={customer?.Customer_ID}
              byType={byType}
              srCfg={srCfg}
              onFormsChange={handleFormsChange}
            />

            {/* This client's Not-OK / due items — the punch list to leave with them on-site. */}
            <ServiceReportStatsPanel token={token} customerId={customer?.Customer_ID} compact />
          </>
        )}
      </div>
    </div>
  );
}
