import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDocSettings } from '../context/DocSettingsContext';
import { formatDateDDMMYYYY } from '../utils/dateUtils';
import EquipmentPreviewTable from '../components/servicereport/EquipmentPreviewTable';
import {
  resolveColumns,
  resolveNumbering,
  nextSequenceForType,
  buildReportId,
  DEFAULT_REPORT_TYPE,
  TABLE_SCHEMA_LEGACY,
  TABLE_SCHEMA_CURRENT
} from '../utils/reportTypeSchemas';
import {
  ChevronLeft,
  FileCheck,
  Search,
  PlusCircle,
  Download,
  Printer,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Unlock,
  Eye,
  Send,
  Edit3,
  Share2,
  Trash2,
  ShieldCheck,
  Building2,
  Calendar,
  Layers,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Check,
  Plus
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
// html2canvas/jspdf are loaded on demand inside handleDownloadPDF — ~590KB, only needed when
// the user actually downloads, not to open the page.

// Helper: Get PDF download filename structured as: Suffix - CompanyName - DDMMYY
const getDownloadFilename = (certNo, customerName, dateStr) => {
  const parts = (certNo || '').split('/');
  const suffix = parts[parts.length - 1] || 'CERT';
  
  let formattedDate = '';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = String(d.getFullYear()).slice(-2);
      formattedDate = `${day}${month}${year}`;
    }
  }
  
  const safeCustomer = (customerName || 'Client').replace(/[\\/:*?"<>|]/g, '');
  return `${suffix} - ${safeCustomer} - ${formattedDate}`;
};

// Helper: Calculate 4-period AMC schedule months based on service date & frequency
export const calculateAmcSchedule = (serviceDateStr, frequencyMonths = 3) => {
  if (!serviceDateStr) return [];
  const baseDate = new Date(serviceDateStr);
  if (isNaN(baseDate.getTime())) return [];

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const schedule = [];
  const freq = parseInt(frequencyMonths, 10) || 3;

  for (let i = 0; i < 4; i++) {
    const d = new Date(baseDate);
    d.setMonth(d.getMonth() + (i * freq));
    const mName = months[d.getMonth()];
    const year = d.getFullYear();
    schedule.push(`${mName}/${year}`);
  }
  return schedule;
};

// Standard Default Equipment Inventory Template for new clients
const DEFAULT_CLIENT_EQUIPMENT_TEMPLATE = [
  {
    id: 'eq-1',
    srNo: 1,
    location: 'Ground Floor Main Lobby',
    clientIdNo: 'CYL-2026-001',
    itemName: 'DCP ABC Type Fire Extinguisher (6 Kg)',
    mfgYear: '2024',
    refillingDate: new Date().toISOString().split('T')[0],
    nextRefillingDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
    hptDate: new Date().toISOString().split('T')[0],
    hptDueDate: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString().split('T')[0],
    bodyValve: 'OK',
    valve: 'OK',
    safetyPin: 'OK',
    pressureWeight: 'OK',
    hoseHorn: 'OK',
    seal: 'OK',
    remarks: 'Pressure gauge green zone'
  },
  {
    id: 'eq-2',
    srNo: 2,
    location: 'First Floor Server Room',
    clientIdNo: 'CYL-2026-002',
    itemName: 'CO2 Type Fire Extinguisher (4.5 Kg)',
    mfgYear: '2024',
    refillingDate: new Date().toISOString().split('T')[0],
    nextRefillingDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
    hptDate: new Date().toISOString().split('T')[0],
    hptDueDate: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString().split('T')[0],
    bodyValve: 'OK',
    valve: 'OK',
    safetyPin: 'OK',
    pressureWeight: 'OK',
    hoseHorn: 'OK',
    seal: 'OK',
    remarks: 'Satisfactory'
  },
  {
    id: 'eq-3',
    srNo: 3,
    location: 'Canteen / Kitchen Pantry',
    clientIdNo: 'CYL-2026-003',
    itemName: 'Mechanical Foam Fire Extinguisher (9 Ltr)',
    mfgYear: '2023',
    refillingDate: new Date().toISOString().split('T')[0],
    nextRefillingDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
    hptDate: new Date().toISOString().split('T')[0],
    hptDueDate: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString().split('T')[0],
    bodyValve: 'OK',
    valve: 'OK',
    safetyPin: 'OK',
    pressureWeight: 'OK',
    hoseHorn: 'OK',
    seal: 'OK',
    remarks: 'Satisfactory'
  }
];

// Helper: fetch one URL as base64 data URL, trying multiple fallbacks in order
async function fetchAsBase64(...urls) {
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      }
    } catch (err) {
      console.warn('Error fetching asset base64:', url, err);
    }
  }
  return '';
}

export default function CertificateGeneratorPage() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const { user, token } = useAuth();

  const userRole = user?.Role === 'Admin' ? 'Admin' : 'Staff';
  const currentStaffName = user?.Name || (userRole === 'Admin' ? 'Admin' : 'Technician');

  const { docSettings } = useDocSettings();
  const srCfg = docSettings?.document_configs?.SERVICE_REPORT || {};
  const srCols = srCfg.visible_columns || {};
  const srCps = srCfg.enabled_checkpoints || {};
  const branding = docSettings?.branding_assets || {};

  const [isPageLoading, setIsPageLoading] = useState(true);

  // Mobile responsiveness and landscape preview scaling states
  const [activeMobileTab, setActiveMobileTab] = useState('edit');
  const [previewScale, setPreviewScale] = useState(1);
  const touchStartRef = useRef(0);

  useEffect(() => {
    const updateScale = () => {
      const width = window.innerWidth;
      if (width < 640) {
        setPreviewScale(Math.min((width - 32) / 1123, 1));
      } else if (width < 1024) {
        setPreviewScale(Math.min((width - 48) / 1123, 1));
      } else {
        const columnWidth = (width - 48 - 32) / 2;
        if (columnWidth < 1150) {
          setPreviewScale(Math.min((columnWidth - 24) / 1123, 1));
        } else {
          setPreviewScale(1);
        }
      }
    };

    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);
  const [loadError, setLoadError] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [equipmentMasterList, setEquipmentMasterList] = useState([]);
  const [assets, setAssets] = useState({ header: '', stamp: '', signature: '', footer: '', watermark: '' });

  const [wizardStep, setWizardStep] = useState(1);
  const [isClientCardCollapsed, setIsClientCardCollapsed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pdfContainerRef = useRef(null);
  const rapidSearchInputRef = useRef(null);

  const handleBack = () => navigate('/');

  const handlePreviewTouchStart = (e) => {
    if (window.innerWidth < 1024) {
      touchStartRef.current = e.touches[0].clientY;
    }
  };

  const handlePreviewTouchMove = (e) => {
    if (window.innerWidth < 1024 && touchStartRef.current !== 0) {
      const currentY = e.touches[0].clientY;
      const diffY = currentY - touchStartRef.current;
      const scrollTop = e.currentTarget.scrollTop;
      if (diffY > 60 && scrollTop <= 0) {
        setActiveMobileTab('edit');
        touchStartRef.current = 0;
      }
    }
  };

  // Form State
  const [reportForm, setReportForm] = useState({
    certPrefix: 'Expert/',
    certPeriod: '26-27',
    certSequence: 'SR310',
    Report_ID: 'Expert/26-27/SR310',
    title: 'INSPECTION REPORT FOR FIRE EXTINGUISHER',
    customerName: '',
    address: '',
    gstin: '',
    contact: '',
    authPerson: '',
    serviceDate: new Date().toISOString().split('T')[0],
    serviceFrequency: '3', // '3' = 3 Months, '6' = 6 Months, '12' = 12 Months
    nextServiceDue: new Date(new Date().setMonth(new Date().getMonth() + 3)).toISOString().split('T')[0],
    amcSchedule: calculateAmcSchedule(new Date().toISOString().split('T')[0], 3),
    technicians: currentStaffName,
    Status: 'Pending Approval', // 'Draft' | 'Pending Approval' | 'Approved' | 'Revision Requested'
    Approval_Remarks: '',
    Reviewed_By: '',
    Reviewed_At: '',
    isLocked: false,
    revision: 0,
    verificationGuid: 'SR-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    authorizedSignatory: 'NILESHKUMAR MANJIBHAI PADAYA',
    fieldObservations: 'All fire safety installations inspected on-site. Extinguishers hydro-tested, pressure checked, and in compliance.',
    recommendations: 'Recommended periodic quarterly check of pressure gauges and emergency exit signage functionality.',
    customColumns: [], // Array of extra custom columns: [{ id: 'col-1', label: 'Make' }]
    itemsList: DEFAULT_CLIENT_EQUIPMENT_TEMPLATE,
    reportType: DEFAULT_REPORT_TYPE,
    // New reports print through the schema-driven table. Reports saved before this field existed
    // stay on TABLE_SCHEMA_LEGACY so a reprint matches the PDF the customer already has.
    tableSchemaVersion: TABLE_SCHEMA_CURRENT
  });

  // Columns the schema-driven preview renders. Legacy reports ignore this and use the frozen table.
  const previewColumns = useMemo(
    () => resolveColumns(reportForm.reportType, srCfg),
    [reportForm.reportType, srCfg]
  );

  const [allReports, setAllReports] = useState([]);

  // Client Search State
  const [clientSearch, setClientSearch] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);

  // Table Filter & Custom Column States
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [newCustomColName, setNewCustomColName] = useState('');
  const [showAddColumnInput, setShowAddColumnInput] = useState(false);

  const handleUpdateReportNoFields = (updatedFields) => {
    setReportForm(prev => {
      const next = { ...prev, ...updatedFields };
      const prefix = next.certPrefix !== undefined ? next.certPrefix : (prev.certPrefix || 'Expert/');
      const period = next.certPeriod !== undefined ? next.certPeriod : (prev.certPeriod || '26-27');
      const seq = next.certSequence !== undefined ? next.certSequence : (prev.certSequence || 'SR310');
      next.Report_ID = `${prefix}${period}/${seq}`;
      return next;
    });
  };

  // Bumps the in-memory report number to the next unused sequence — called right after a brand-new
  // report is successfully saved, so the number can never collide with the one just issued. Counts
  // only reports of the same type. Never runs when saving an edit to an existing report.
  const advanceToNextReportNumber = (justSavedReport) => {
    const updatedReports = [...allReports.filter(r =>
      (r.verificationGuid || r.Verification_GUID) !== (justSavedReport.verificationGuid || justSavedReport.Verification_GUID)
    ), justSavedReport];
    setReportForm(prev => {
      const nextSequence = nextSequenceForType(prev.reportType, srCfg, updatedReports);
      return {
        ...prev,
        certSequence: nextSequence,
        Report_ID: `${prev.certPrefix || 'Expert/'}${prev.certPeriod || '26-27'}/${nextSequence}`,
        verificationGuid: 'SR-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        isLocked: false,
        revision: 0
      };
    });
  };

  // Load customers, equipment master, and (if editing) the existing report
  useEffect(() => {
    let cancelled = false;
    const loadPageData = async () => {
      setIsPageLoading(true);
      setLoadError(null);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [customersRes, equipmentRes, reportsRes] = await Promise.all([
          fetch('/api/customers', { headers }),
          fetch('/api/equipment-master', { headers }),
          fetch('/api/service-reports', { headers })
        ]);
        const customersData = customersRes.ok ? await customersRes.json() : [];
        const equipmentData = equipmentRes.ok ? await equipmentRes.json() : [];
        const reportsData = reportsRes.ok ? await reportsRes.json() : [];
        if (cancelled) return;
        setCustomers(Array.isArray(customersData) ? customersData : []);
        setEquipmentMasterList(Array.isArray(equipmentData) ? equipmentData : []);
        setAllReports(Array.isArray(reportsData) ? reportsData : []);

        if (reportId) {
          const reportRes = await fetch(`/api/service-reports/${reportId}`, { headers });
          if (cancelled) return;
          if (reportRes.status === 404) {
            setLoadError('Service report not found.');
          } else if (!reportRes.ok) {
            throw new Error('Failed to load service report');
          } else {
             const reportData = await reportRes.json();
             setReportForm(prev => {
               const rParts = (reportData.Report_ID || '').split('/');
               const seq = rParts[rParts.length - 1] || 'SR310';
               return {
                 ...prev,
                 certPrefix: reportData.certPrefix || 'Expert/',
                 certPeriod: reportData.certPeriod || '26-27',
                 certSequence: reportData.certSequence || seq,
                 ...reportData,
                 amcSchedule: reportData.amcSchedule || calculateAmcSchedule(reportData.serviceDate, reportData.serviceFrequency || 3),
                 itemsList: (reportData.itemsList && reportData.itemsList.length > 0) ? reportData.itemsList : DEFAULT_CLIENT_EQUIPMENT_TEMPLATE,
                 customColumns: reportData.customColumns || [],
                 reportType: reportData.reportType || DEFAULT_REPORT_TYPE,
                 // Absent on every report saved before the schema refactor — those must keep
                 // printing through the legacy table, so never inherit the new default here.
                 tableSchemaVersion: reportData.tableSchemaVersion || TABLE_SCHEMA_LEGACY
               };
             });
             setClientSearch(reportData.customerName || '');
          }
        } else {
          // New report: apply this type's admin-configured prefix/period and the next free
          // sequence, counting only reports of the same type.
          setReportForm(prev => {
            const numbering = resolveNumbering(prev.reportType, srCfg);
            const nextSequence = nextSequenceForType(prev.reportType, srCfg, reportsData);
            return {
              ...prev,
              certPrefix: numbering.prefix,
              certPeriod: numbering.period,
              certSequence: nextSequence,
              Report_ID: buildReportId({ ...numbering, sequence: nextSequence })
            };
          });
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load certificate data');
      } finally {
        if (!cancelled) setIsPageLoading(false);
      }
    };
    loadPageData();
    return () => { cancelled = true; };
  }, [reportId, token]);

  // Admin-only: load header/stamp/signature/footer/watermark images as base64 (needed for html2canvas export)
  useEffect(() => {
    if (userRole !== 'Admin') return;
    const loadAllCertAssets = async () => {
      const [headerData, stampData, footerData, watermarkData, sigData] = await Promise.all([
        fetchAsBase64(branding.header_image_url||'/assets/header_logo.png', '/assets/header.jpg', '/assets/Expert  - Header.jpg'),
        fetchAsBase64(branding.company_stamp_url||'/assets/company_stamp.png', '/assets/stamp.jpg', '/assets/Stamp 2026.jpg'),
        fetchAsBase64(branding.footer_image_url||'/assets/Footer - Expert (2025).PNG', '/assets/footer.png'),
        fetchAsBase64(branding.watermark_logo_url||'/assets/Watermark Logo.jpg', '/assets/watermark-logo.jpg'),
        fetchAsBase64(branding.authorized_signature_url||'/assets/signature.svg')
      ]);
      setAssets({ header: headerData, stamp: stampData, footer: footerData, watermark: watermarkData, signature: sigData });
    };
    loadAllCertAssets();
  }, [userRole]);

  // Select Client & Load Master Equipment Inventory Automatically
  const handleSelectClient = (c) => {
    const custName = c.Company_Name || c.Customer_Name || '';
    setReportForm(prev => ({
      ...prev,
      customerName: custName,
      address: c.Address || c.Location || '',
      gstin: c.GSTIN || c.Gst_No || '',
      contact: c.Contact || c.Phone || c.Mobile || c.Contact_Number || '',
      authPerson: c.Auth_Person || ''
    }));
    setClientSearch(custName);
    setShowClientDropdown(false);
    setActiveMobileTab('preview');
  };

  // Frequency Change & Auto-Calculate Dates + Schedule
  const handleFrequencyChange = (freqValue) => {
    const freqInt = parseInt(freqValue, 10);
    const serviceDt = new Date(reportForm.serviceDate || new Date());
    const nextDt = new Date(serviceDt);
    nextDt.setMonth(nextDt.getMonth() + freqInt);
    const nextDtStr = isNaN(nextDt.getTime()) ? reportForm.nextServiceDue : nextDt.toISOString().split('T')[0];

    const sched = calculateAmcSchedule(reportForm.serviceDate, freqInt);
    setReportForm(prev => ({
      ...prev,
      serviceFrequency: freqValue,
      nextServiceDue: nextDtStr,
      amcSchedule: sched
    }));
  };

  // Toggle Checkpoint Value (OK <-> NOT OK) with 1 Click
  const toggleCheckpoint = (rowIndex, checkpointKey) => {
    setReportForm(prev => {
      const updatedItems = prev.itemsList.map((row, idx) => {
        if (idx === rowIndex) {
          const currentVal = row[checkpointKey] || 'OK';
          const nextVal = currentVal === 'OK' ? 'NOT OK' : 'OK';
          return { ...row, [checkpointKey]: nextVal };
        }
        return row;
      });
      return { ...prev, itemsList: updatedItems };
    });
  };

  // Add Row to Pre-populated Table
  const handleAddEquipmentRow = () => {
    const nextNo = (reportForm.itemsList || []).length + 1;
    const newRow = {
      id: 'eq-' + Date.now(),
      srNo: nextNo,
      location: 'Ground Floor',
      clientIdNo: `CYL-${new Date().getFullYear()}-${String(nextNo).padStart(3, '0')}`,
      itemName: 'DCP ABC Type Fire Extinguisher (6 Kg)',
      mfgYear: String(new Date().getFullYear()),
      refillingDate: reportForm.serviceDate,
      nextRefillingDate: reportForm.nextServiceDue,
      hptDate: reportForm.serviceDate,
      hptDueDate: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString().split('T')[0],
      bodyValve: 'OK',
      valve: 'OK',
      safetyPin: 'OK',
      pressureWeight: 'OK',
      hoseHorn: 'OK',
      seal: 'OK',
      remarks: 'Satisfactory'
    };
    setReportForm(prev => ({
      ...prev,
      itemsList: [...(prev.itemsList || []), newRow]
    }));
    setActiveMobileTab('preview');
  };

  // Add Dynamic Custom Column
  const handleAddCustomColumn = () => {
    if (!newCustomColName.trim()) return;
    const colId = 'col-' + Date.now();
    const newCol = { id: colId, label: newCustomColName.trim() };
    setReportForm(prev => ({
      ...prev,
      customColumns: [...(prev.customColumns || []), newCol]
    }));
    setNewCustomColName('');
    setShowAddColumnInput(false);
  };

  // Remove Dynamic Custom Column
  const handleRemoveCustomColumn = (colId) => {
    setReportForm(prev => ({
      ...prev,
      customColumns: (prev.customColumns || []).filter(c => c.id !== colId)
    }));
  };

  // Save Report Handler
  const handleSaveReport = async (targetStatus, remarks = '') => {
    try {
      setIsSubmitting(true);
      const payload = {
        ...reportForm,
        Status: targetStatus,
        Approval_Remarks: remarks || reportForm.Approval_Remarks || '',
        isLocked: targetStatus === 'Approved' ? true : reportForm.isLocked
      };

      let res;
      if (reportId) {
        res = await fetch(`/api/service-reports/${reportId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch('/api/service-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) throw new Error('Failed to save service report');
      if (!reportId) advanceToNextReportNumber(payload);
      alert(`✅ Service Report ${targetStatus === 'Approved' ? 'Approved & Locked' : targetStatus === 'Pending Approval' ? 'Submitted for Approval' : 'Saved'}!`);
      handleBack();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // PDF Export Engine (A4 Landscape Multi-Page with Repeating Headers & Footers)
  const handleDownloadPDF = async () => {
    try {
      if (!pdfContainerRef.current) {
        alert('Preview element not ready');
        return;
      }
      setIsSubmitting(true);

      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);

      const canvas = await html2canvas(pdfContainerRef.current, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        windowWidth: 1400,
        onclone: async (clonedDoc) => {
          const images = Array.from(clonedDoc.querySelectorAll('img'));
          await Promise.all(
            images.map(async (img) => {
              img.crossOrigin = 'anonymous';
              if (!img.complete || img.naturalWidth === 0) {
                await new Promise((resolve) => {
                  img.onload = img.onerror = resolve;
                  const src = img.src;
                  img.src = '';
                  img.src = src;
                });
              }
              try { await img.decode(); } catch (e) {}
            })
          );
          await new Promise(r => setTimeout(r, 250));
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF('landscape', 'mm', 'a4');
      const pdfWidth = 297; // A4 Landscape width
      const pdfHeight = 210; // A4 Landscape height

      const imgHeight = (canvas.height * pdfWidth) / canvas.width;

      if (imgHeight <= pdfHeight + 1) {
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(imgHeight, pdfHeight));
      } else {
        let heightLeft = imgHeight;
        let position = 0;
        pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, imgHeight);
        heightLeft -= pdfHeight;

        while (heightLeft > 1) {
          position -= pdfHeight;
          pdf.addPage('a4', 'landscape');
          pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, imgHeight);
          heightLeft -= pdfHeight;
        }
      }

      const fileName = getDownloadFilename(reportForm.Report_ID, reportForm.customerName, reportForm.serviceDate);
      pdf.save(`${fileName}.pdf`);
    } catch (err) {
      console.error('PDF Export Error:', err);
      alert('Failed to generate PDF: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // WhatsApp Share
  const handleShareWhatsApp = () => {
    const text = `📋 *INSPECTION REPORT - EXPERT SAFETY SOLUTIONS*\n\n*Report ID:* ${reportForm.Report_ID}\n*Client:* ${reportForm.customerName}\n*Date:* ${reportForm.serviceDate}\n*Status:* ${reportForm.Status}\n*Verification:* ${window.location.origin}/api/verify-certificate/${reportForm.verificationGuid}\n\nThank you for trusting Expert Safety Solutions!`;
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  };

  if (isPageLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading Service Inspection Engine...</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-slate-50 gap-4">
        <div className="text-rose-700 font-bold text-sm">{loadError}</div>
        <button
          type="button"
          onClick={handleBack}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold text-xs flex items-center gap-1.5"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 flex flex-col">
      {/* Page Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 py-3 shadow-sm gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleBack}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl font-bold text-xs flex items-center gap-1.5 transition shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Back to Dashboard</span>
          </button>
          <div>
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2 flex-wrap">
              <span>Service Inspection Engine ({reportForm.Report_ID})</span>
              <span className={`px-2 py-0.5 rounded-md text-xs font-bold ${
                reportForm.Status === 'Approved'
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : reportForm.Status === 'Pending Approval'
                  ? 'bg-amber-100 text-amber-900 border border-amber-300 animate-pulse'
                  : reportForm.Status === 'Revision Requested'
                  ? 'bg-rose-100 text-rose-800 border border-rose-300'
                  : 'bg-slate-100 text-slate-700 border border-slate-300'
              }`}>
                {reportForm.Status}
              </span>
            </h3>
            <p className="text-xs text-slate-500 font-medium">Auto-Prepopulated Inventory &amp; One-Click Inspection Engine</p>
          </div>
        </div>
      </div>

      {/* 3-Step Wizard Navigation Stepper Bar */}
      <div className="px-4 sm:px-6 pt-3">
        <div className="flex items-center justify-between bg-slate-100 rounded-xl p-1.5 border border-slate-200 max-w-3xl">
          {[
            { step: 1, label: '1. Client Info Setup' },
            { step: 2, label: `2. Equipment Checkpoints (${(reportForm.itemsList || []).length} Pre-loaded)` },
            { step: 3, label: '3. Observations & Submit' }
          ].map(s => (
            <button
              key={s.step}
              type="button"
              onClick={() => setWizardStep(s.step)}
              className={`flex-1 py-2 px-3 rounded-lg text-xs font-extrabold transition flex items-center justify-center gap-2 ${
                wizardStep === s.step
                  ? 'bg-amber-700 text-white shadow-sm'
                  : wizardStep > s.step
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200/50'
              }`}
            >
              {wizardStep > s.step ? <Check className="w-3.5 h-3.5" /> : null}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Mobile Tab Switcher */}
      <div className="lg:hidden sticky top-0 z-40 bg-white border-b border-slate-200 px-4 py-2.5 flex gap-2 shrink-0 shadow-2xs">
        <button
          type="button"
          onClick={() => setActiveMobileTab('edit')}
          className={`flex-1 py-2 text-center rounded-xl font-extrabold text-xs transition-all flex items-center justify-center gap-1.5 ${
            activeMobileTab === 'edit'
              ? 'bg-amber-700 text-white shadow-sm'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          📝 Edit Form
        </button>
        <button
          type="button"
          onClick={() => setActiveMobileTab('preview')}
          className={`flex-1 py-2 text-center rounded-xl font-extrabold text-xs transition-all flex items-center justify-center gap-1.5 ${
            activeMobileTab === 'preview'
              ? 'bg-amber-700 text-white shadow-sm'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
          }`}
        >
          👁️ Live Preview
        </button>
      </div>

      {/* Split-Screen Body: Form (left) / Live A4 Preview (right) */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 px-4 sm:px-6 py-4 min-h-0 relative">
        {/* LEFT COLUMN: FORM EDITOR */}
        <div className={`${activeMobileTab === 'edit' ? 'block' : 'hidden'} lg:block lg:w-[46%] xl:w-[48%] overflow-y-auto pr-1 space-y-4`}>

          {/* ═══════════════════════════════════════════════════════════
              STEP 1: CLIENT & INFO SETUP (WITH AUTO-HIDE UX)
              ═══════════════════════════════════════════════════════════ */}
          {wizardStep === 1 && (
            <div className="space-y-3 pt-1 text-xs">
              <div className="bg-amber-50/80 border border-amber-300 rounded-xl p-3.5 space-y-3.5 shadow-2xs">
                <div className="flex items-center justify-between border-b border-amber-200 pb-2">
                  <span className="font-extrabold text-amber-950 text-xs uppercase tracking-wide flex items-center gap-1.5">
                    <Building2 className="w-4 h-4 text-amber-700" />
                    Step 1: Client Setup &amp; Service Schedule
                  </span>
                  {isClientCardCollapsed && (
                    <button
                      type="button"
                      onClick={() => setIsClientCardCollapsed(false)}
                      className="text-xs font-bold text-amber-800 hover:underline"
                    >
                      ▼ Expand Client Info
                    </button>
                  )}
                </div>

                {!isClientCardCollapsed && (
                  <>
                    {/* Company Search — Autocompletes Company & Address ONLY */}
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wide">
                        Search Client Directory (Company &amp; Address) *
                      </label>
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder="Type company name or location..."
                          value={clientSearch}
                          onChange={e => { setClientSearch(e.target.value); setShowClientDropdown(true); }}
                          onFocus={() => setShowClientDropdown(true)}
                          onBlur={() => setTimeout(() => setShowClientDropdown(false), 200)}
                          className="w-full pl-8 pr-3 py-2 bg-white border border-slate-300 rounded-lg font-bold text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"
                        />
                        {showClientDropdown && (
                          <div className="absolute z-50 left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-white border border-amber-400 rounded-xl shadow-2xl divide-y divide-slate-100">
                            {customers
                              .filter(c => !clientSearch.trim() || (c.Company_Name || c.Customer_Name || '').toLowerCase().includes(clientSearch.toLowerCase()))
                              .slice(0, 30)
                              .map(c => (
                                <div
                                  key={c.Customer_ID}
                                  onMouseDown={() => handleSelectClient(c)}
                                  className="px-3 py-2 hover:bg-amber-50 cursor-pointer font-medium flex justify-between items-center"
                                >
                                  <div>
                                    <div className="font-bold text-slate-900">{c.Company_Name || c.Customer_Name}</div>
                                    <div className="text-[10px] text-slate-400 truncate max-w-md">{c.Address}</div>
                                  </div>
                                  <span className="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">Select</span>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="bg-amber-50/40 border border-amber-200 rounded-xl p-2.5 space-y-1.5 col-span-1 sm:col-span-3">
                        <div className="text-[10px] font-bold text-amber-900 uppercase tracking-wide">⚙️ Report Ref No Structure</div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="block text-[9px] font-bold text-slate-500 uppercase mb-0.5">Prefix</label>
                            <input
                              type="text"
                              value={reportForm.certPrefix || 'Expert/'}
                              onChange={e => handleUpdateReportNoFields({ certPrefix: e.target.value })}
                              className="w-full px-2.5 py-1 bg-white border border-slate-300 rounded-md font-bold text-slate-900 text-xs focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-bold text-slate-500 uppercase mb-0.5">Period (FY)</label>
                            <input
                              type="text"
                              value={reportForm.certPeriod || '26-27'}
                              onChange={e => handleUpdateReportNoFields({ certPeriod: e.target.value })}
                              className="w-full px-2.5 py-1 bg-white border border-slate-300 rounded-md font-bold text-slate-900 text-xs focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-bold text-slate-500 uppercase mb-0.5">Seq / Suffix</label>
                            <input
                              type="text"
                              value={reportForm.certSequence || 'SR310'}
                              onChange={e => handleUpdateReportNoFields({ certSequence: e.target.value })}
                              className="w-full px-2.5 py-1 bg-white border border-slate-300 rounded-md font-bold text-slate-900 text-xs focus:outline-none"
                            />
                          </div>
                        </div>
                        <div className="text-[9px] text-slate-400 font-bold">
                          Resulting Report ID: <strong className="text-amber-900">{reportForm.Report_ID}</strong>
                        </div>
                      </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Company / Client Name *</label>
                        <input
                          type="text"
                          value={reportForm.customerName}
                          onChange={e => setReportForm(prev => ({ ...prev, customerName: e.target.value }))}
                          className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-bold text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Premises / Site Address *</label>
                        <input
                          type="text"
                          value={reportForm.address}
                          onChange={e => setReportForm(prev => ({ ...prev, address: e.target.value }))}
                          className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-medium text-slate-800"
                        />
                      </div>
                    </div>


                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Service Date *</label>
                        <input
                          type="date"
                          value={reportForm.serviceDate}
                          onChange={e => {
                            const newDate = e.target.value;
                            setReportForm(prev => ({
                              ...prev,
                              serviceDate: newDate,
                              amcSchedule: calculateAmcSchedule(newDate, prev.serviceFrequency || 3)
                            }));
                          }}
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg font-bold text-slate-900"
                        />
                      </div>

                      {/* Frequency Selector with Auto-Calculation */}
                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Frequency of Service *</label>
                        <select
                          value={reportForm.serviceFrequency || '3'}
                          onChange={e => handleFrequencyChange(e.target.value)}
                          className="w-full px-2.5 py-1.5 bg-white border border-amber-400 rounded-lg font-extrabold text-amber-950 focus:outline-none"
                        >
                          <option value="3">3 Months (Quarterly)</option>
                          <option value="6">6 Months (Half-Yearly)</option>
                          <option value="12">12 Months (Annual)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Next Date of Service</label>
                        <input
                          type="date"
                          value={reportForm.nextServiceDue}
                          onChange={e => setReportForm(prev => ({ ...prev, nextServiceDue: e.target.value }))}
                          className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg font-bold text-rose-700"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-bold text-slate-600 uppercase mb-1">Service Engineer(s)</label>
                        <input
                          type="text"
                          value={reportForm.technicians}
                          onChange={e => setReportForm(prev => ({ ...prev, technicians: e.target.value }))}
                          className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg font-bold text-indigo-950"
                        />
                      </div>
                    </div>

                    {/* Calculated AMC Planned Schedule Display */}
                    <div className="bg-amber-100/70 border border-amber-300 rounded-xl p-2.5 space-y-1">
                      <span className="text-[10px] font-extrabold text-amber-950 uppercase tracking-wide">
                        📅 Auto-Calculated 4-Quarter AMC Planned Schedule:
                      </span>
                      <div className="flex flex-wrap gap-2 pt-0.5">
                        {(reportForm.amcSchedule || []).map((m, idx) => (
                          <span key={idx} className="bg-white border border-amber-400 text-amber-950 px-2.5 py-1 rounded-lg text-xs font-black shadow-2xs">
                            Q{idx + 1}: {m}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {/* UX Auto-Hide Action Button */}
                <div className="pt-2 border-t border-amber-200 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (!reportForm.customerName.trim()) { alert('Please enter or select a Client Name.'); return; }
                      setIsClientCardCollapsed(true);
                      setWizardStep(2);
                    }}
                    className="px-5 py-2.5 bg-amber-700 hover:bg-amber-800 text-white rounded-xl font-black text-xs flex items-center gap-2 shadow-md transition"
                  >
                    <span>Proceed to Pre-populated Equipment Inspection Table</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════
              STEP 2: PRE-POPULATED EQUIPMENT INSPECTION TABLE & ONE-CLICK TOGGLES
              ═══════════════════════════════════════════════════════════ */}
          {wizardStep === 2 && (
            <div className="space-y-3 pt-1 text-xs">
              <div className="bg-amber-50/90 border border-amber-300 rounded-xl p-3.5 space-y-3 shadow-2xs">

                {/* Rapid Search Bar & Add Column Bar */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b border-amber-200 pb-2">
                  <div className="relative flex-1 w-full">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      ref={rapidSearchInputRef}
                      type="text"
                      placeholder="Rapid search/filter by ID No (e.g. 001), Location, or Description..."
                      value={tableSearchQuery}
                      onChange={e => setTableSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 bg-white border border-slate-300 rounded-xl font-bold text-xs text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-none shadow-2xs"
                    />
                  </div>

                  <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                    <button
                      type="button"
                      onClick={handleAddEquipmentRow}
                      className="px-3 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-sm transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>+ Add Row</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowAddColumnInput(p => !p)}
                      className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-sm transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{showAddColumnInput ? 'Cancel' : '+ Add Custom Column'}</span>
                    </button>
                  </div>
                </div>

                {/* Add Custom Column Drawer */}
                {showAddColumnInput && (
                  <div className="bg-indigo-50 border border-indigo-200 p-2.5 rounded-xl flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Enter new column label (e.g. Make, Serial No, Barcode)..."
                      value={newCustomColName}
                      onChange={e => setNewCustomColName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddCustomColumn(); }}
                      className="flex-1 px-3 py-1.5 bg-white border border-indigo-300 rounded-lg text-xs font-bold focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleAddCustomColumn}
                      className="px-4 py-1.5 bg-indigo-700 hover:bg-indigo-800 text-white rounded-lg font-bold text-xs"
                    >
                      Save Column
                    </button>
                  </div>
                )}

                {/* Pre-populated Interactive Inspection Table */}
                <div className="bg-white border border-slate-300 rounded-xl overflow-hidden shadow-2xs">
                  <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 font-extrabold text-slate-800 text-xs flex justify-between items-center">
                    <span>Pre-loaded Client Equipment Table ({(reportForm.itemsList || []).length} Items)</span>
                    <span className="text-[10px] text-emerald-800 font-bold bg-emerald-100 px-2 py-0.5 rounded">
                      ✔ All checkpoints default to OK. Click any badge to toggle.
                    </span>
                  </div>

                  <div className="overflow-x-auto max-h-[55vh]">
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-amber-100 text-amber-950 font-black border-b border-slate-300 text-center">
                          <th className="p-2 w-8">Sr.</th>
                          <th className="p-2 text-left min-w-[140px]">Location</th>
                          <th className="p-2 min-w-[100px]">Client ID No</th>
                          <th className="p-2 text-left min-w-[180px]">Fire Ext. Description</th>
                          <th className="p-2 w-16">MFG</th>
                          <th className="p-2 min-w-[100px]">Refilling Dt</th>
                          <th className="p-2 min-w-[100px]">Next Refill Dt</th>
                          <th className="p-2 min-w-[100px]">HPT Dt</th>
                          <th className="p-2 min-w-[100px]">HPT Due Dt</th>
                          <th className="p-2 w-16">Body</th>
                          <th className="p-2 w-16">Valve</th>
                          <th className="p-2 w-16">Safety Pin</th>
                          <th className="p-2 w-16">Pressure / Wt</th>
                          <th className="p-2 w-16">Hose &amp; Horn</th>
                          <th className="p-2 w-16">Seal</th>
                          {(reportForm.customColumns || []).map(col => (
                            <th key={col.id} className="p-2 bg-indigo-100 text-indigo-950 border-l border-indigo-200 min-w-[90px]">
                              <div className="flex items-center justify-between gap-1">
                                <span>{col.label}</span>
                                <button type="button" onClick={() => handleRemoveCustomColumn(col.id)} className="text-rose-600 hover:font-bold">×</button>
                              </div>
                            </th>
                          ))}
                          <th className="p-2 text-left min-w-[140px]">Remarks</th>
                          <th className="p-2 w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(reportForm.itemsList || [])
                          .filter(it => {
                            if (!tableSearchQuery.trim()) return true;
                            const q = tableSearchQuery.toLowerCase();
                            return (
                              (it.clientIdNo || '').toLowerCase().includes(q) ||
                              (it.itemName || '').toLowerCase().includes(q) ||
                              (it.location || '').toLowerCase().includes(q) ||
                              (it.remarks || '').toLowerCase().includes(q)
                            );
                          })
                          .map((it, idx) => (
                            <tr key={it.id || idx} className="hover:bg-amber-50/70 transition text-center font-medium">
                              <td className="p-2 font-bold text-slate-800">{idx + 1}</td>

                              {/* Location */}
                              <td className="p-2 text-left">
                                <input
                                  type="text"
                                  value={it.location}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, location: val } : row)
                                    }));
                                  }}
                                  className="w-full bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-semibold text-slate-800"
                                />
                              </td>

                              {/* Client ID No */}
                              <td className="p-2 font-extrabold text-indigo-950 bg-slate-50/50">
                                <input
                                  type="text"
                                  value={it.clientIdNo}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, clientIdNo: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-extrabold text-indigo-950"
                                />
                              </td>

                              {/* Item Description */}
                              <td className="p-2 text-left">
                                <input
                                  type="text"
                                  value={it.itemName}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, itemName: val } : row)
                                    }));
                                  }}
                                  className="w-full bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-bold text-slate-900"
                                />
                              </td>

                              {/* MFG */}
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={it.mfgYear}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, mfgYear: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px]"
                                />
                              </td>

                              {/* Refilling Dt */}
                              <td className="p-2">
                                <input
                                  type="date"
                                  value={it.refillingDate}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, refillingDate: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px]"
                                />
                              </td>

                              {/* Next Refill Dt */}
                              <td className="p-2 font-bold text-rose-700">
                                <input
                                  type="date"
                                  value={it.nextRefillingDate}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, nextRefillingDate: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-bold text-rose-700 text-[10px]"
                                />
                              </td>

                              {/* HPT Dt */}
                              <td className="p-2">
                                <input
                                  type="date"
                                  value={it.hptDate}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, hptDate: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px]"
                                />
                              </td>

                              {/* HPT Due Dt */}
                              <td className="p-2 font-bold text-indigo-900">
                                <input
                                  type="date"
                                  value={it.hptDueDate}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, hptDueDate: val } : row)
                                    }));
                                  }}
                                  className="w-full text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none font-bold text-indigo-900 text-[10px]"
                                />
                              </td>

                              {/* 6 ONE-CLICK TOGGLE CHECKPOINTS (DEFAULT: OK in Green) */}
                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'bodyValve')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.bodyValve || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.bodyValve || 'OK'}
                                </button>
                              </td>

                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'valve')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.valve || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.valve || 'OK'}
                                </button>
                              </td>

                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'safetyPin')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.safetyPin || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.safetyPin || 'OK'}
                                </button>
                              </td>

                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'pressureWeight')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.pressureWeight || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.pressureWeight || 'OK'}
                                </button>
                              </td>

                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'hoseHorn')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.hoseHorn || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.hoseHorn || 'OK'}
                                </button>
                              </td>

                              <td className="p-1">
                                <button
                                  type="button"
                                  onClick={() => toggleCheckpoint(idx, 'seal')}
                                  className={`w-full py-1 rounded text-[10px] font-black transition cursor-pointer ${
                                    (it.seal || 'OK') === 'OK'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                                      : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                                  }`}
                                >
                                  {it.seal || 'OK'}
                                </button>
                              </td>

                              {/* Custom Columns Cells */}
                              {(reportForm.customColumns || []).map(col => (
                                <td key={col.id} className="p-1 bg-indigo-50/50 border-l border-indigo-100">
                                  <input
                                    type="text"
                                    value={it.customValues?.[col.id] || ''}
                                    onChange={e => {
                                      const val = e.target.value;
                                      setReportForm(prev => ({
                                        ...prev,
                                        itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, customValues: { ...(row.customValues || {}), [col.id]: val } } : row)
                                      }));
                                    }}
                                    className="w-full text-center bg-transparent border-b border-transparent focus:border-indigo-500 focus:outline-none font-bold text-indigo-900"
                                  />
                                </td>
                              ))}

                              {/* Remarks */}
                              <td className="p-2 text-left">
                                <input
                                  type="text"
                                  value={it.remarks || 'Satisfactory'}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: prev.itemsList.map((row, i) => i === idx ? { ...row, remarks: val } : row)
                                    }));
                                  }}
                                  className="w-full bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-slate-700 italic"
                                />
                              </td>

                              {/* Delete Row Action */}
                              <td className="p-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReportForm(prev => ({
                                      ...prev,
                                      itemsList: (prev.itemsList || []).filter((_, i) => i !== idx).map((row, i) => ({ ...row, srNo: i + 1 }))
                                    }));
                                  }}
                                  className="p-1 text-slate-300 hover:text-rose-600 transition"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Step 2 Navigation Action */}
                <div className="pt-2 border-t border-amber-200 flex justify-between">
                  <button
                    type="button"
                    onClick={() => setWizardStep(1)}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl font-bold transition text-xs"
                  >
                    ← Back to Step 1
                  </button>

                  <button
                    type="button"
                    onClick={() => setWizardStep(3)}
                    className="px-5 py-2.5 bg-amber-700 hover:bg-amber-800 text-white rounded-xl font-black text-xs flex items-center gap-2 shadow-md transition"
                  >
                    <span>Go to Next Page (Observations &amp; Findings)</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════
              STEP 3: OBSERVATIONS, RECOMMENDATIONS & FINAL SUBMIT
              ═══════════════════════════════════════════════════════════ */}
          {wizardStep === 3 && (
            <div className="space-y-3 pt-1 text-xs">
              <div className="bg-amber-50/80 border border-amber-300 rounded-xl p-3.5 space-y-3.5 shadow-2xs">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
                    General Field Observations &amp; Plant Audit Findings
                  </label>
                  <textarea
                    rows={4}
                    value={reportForm.fieldObservations}
                    onChange={e => setReportForm(prev => ({ ...prev, fieldObservations: e.target.value }))}
                    className="w-full p-2.5 bg-white border border-slate-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    placeholder="Enter overall field audit findings..."
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
                    Plant Recommendations &amp; Corrective Action Plan
                  </label>
                  <textarea
                    rows={3}
                    value={reportForm.recommendations}
                    onChange={e => setReportForm(prev => ({ ...prev, recommendations: e.target.value }))}
                    className="w-full p-2.5 bg-white border border-slate-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    placeholder="Enter recommendations..."
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Authorized Signatory Name</label>
                    <input
                      type="text"
                      value={reportForm.authorizedSignatory}
                      onChange={e => setReportForm(prev => ({ ...prev, authorizedSignatory: e.target.value }))}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-bold text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Verification GUID</label>
                    <input
                      type="text"
                      readOnly
                      value={reportForm.verificationGuid}
                      className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg font-mono font-bold text-indigo-950"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: LIVE A4 LANDSCAPE PREVIEW (always visible across all 3 steps) */}
        <div
          onTouchStart={handlePreviewTouchStart}
          onTouchMove={handlePreviewTouchMove}
          className={`${activeMobileTab === 'preview' ? 'block' : 'hidden'} lg:block lg:w-[54%] xl:w-[52%] overflow-y-auto pl-1`}
        >
          <div className="space-y-3 pt-1 text-xs flex flex-col items-center">
            <div className="text-center font-bold text-slate-600 flex items-center gap-2">
              <Eye className="w-4 h-4 text-amber-600" />
              <span>Exact Match Sample A4 Landscape PDF Table Preview ({reportForm.Report_ID})</span>
            </div>

            {/* A4 Landscape Container: 1122px width, 793px height ratio @ 96 DPI */}
            <div className="overflow-x-auto w-full flex justify-center py-3 bg-slate-200/80 rounded-2xl border border-slate-300 shadow-inner">
              <div
                style={{
                  width: `${1122 * previewScale}px`,
                  height: `${793 * previewScale}px`,
                  position: 'relative',
                  overflow: 'hidden'
                }}
                className="shrink-0 transition-all duration-200"
              >
                <div
                  ref={pdfContainerRef}
                  className="bg-white text-slate-900 shadow-2xl relative select-none flex flex-col shrink-0 origin-top-left"
                  style={{
                    width: '1122px',
                    height: '793px',
                    padding: '12px',
                    boxSizing: 'border-box',
                    fontFamily: "'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
                    isolation: 'isolate',
                    transform: `scale(${previewScale})`
                  }}
                >
                {/* Inner wrapper with double border shifted slightly inside for margins */}
                <div
                  className="w-full h-full flex flex-col justify-between border-6 border-double border-amber-800 p-5 flex-1 bg-white relative"
                  style={{ boxSizing: 'border-box' }}
                >
                <img
                  src={assets.watermark || '/assets/Watermark Logo.jpg'}
                  onError={e => { e.target.onerror = null; e.target.src = '/assets/watermark-logo.jpg'; }}
                  alt="Watermark Logo"
                  aria-hidden="true"
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2/5 object-contain pointer-events-none select-none"
                  style={{ opacity: 0.08 }}
                />
                {/* RECURRING TOP HEADER */}
                <div className="relative shrink-0">
                  <div className="flex items-center justify-between border-b-2 border-amber-700 pb-2 mb-2 shrink-0">
                    {/* MSME & FSAI Badges */}
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="bg-amber-100 text-amber-950 px-2 py-1 rounded font-black text-[9.5px] border border-amber-300 shrink-0">
                        MSME REGISTERED
                      </div>
                      <div className="bg-red-100 text-red-950 px-2 py-1 rounded font-black text-[9.5px] border border-red-300 shrink-0">
                        FSAI MEMBER
                      </div>
                    </div>

                    {/* Center Header Logo & Title */}
                    <div className="text-center shrink-0">
                      <img
                        src={assets.header || '/assets/header_logo.png'}
                        onError={e => { e.target.onerror = null; e.target.src = '/assets/header.jpg'; }}
                        alt="Company Header"
                        className="h-12 object-contain mx-auto shrink-0"
                      />
                    </div>

                    {/* Meta Ref & Page */}
                    <div className="text-right text-[9.5px] font-bold text-slate-700 space-y-0.5">
                      <div><span className="text-amber-950 font-black">Ref No:</span> {reportForm.Report_ID}</div>
                      <div><span className="text-amber-950 font-black">Date:</span> {formatDateDDMMYYYY(reportForm.serviceDate)}</div>
                      <div className="bg-amber-50 text-amber-950 px-1.5 py-0.5 rounded font-black border border-amber-200 inline-block">
                        Page 1 of 1 (A4 Landscape)
                      </div>
                    </div>
                  </div>

                  {/* Main Title Banner */}
                  <div className="text-center mb-2">
                    <span className="inline-block bg-gradient-to-r from-amber-950 via-amber-800 to-amber-950 text-white font-black text-xs px-4 py-1 rounded-md uppercase tracking-wider shadow-xs border border-amber-600">
                      {reportForm.title}
                    </span>
                  </div>

                  {/* Header Table Data Block (Matching Sample PDF Structure) */}
                  <table className="w-full text-[9.5px] border-collapse border border-amber-400 mb-2 shadow-2xs">
                    <tbody>
                      <tr className="bg-amber-50/80 font-bold">
                        <td className="border border-amber-300 p-1.5 w-1/2">
                          <span className="text-amber-950 font-black">CLIENT NAME &amp; ADDRESS:</span>
                          <div className="text-slate-900 font-extrabold text-[10px] mt-0.5">{reportForm.customerName || 'N/A'}</div>
                          <div className="text-slate-700 font-medium">{reportForm.address || 'N/A'}</div>
                        </td>
                        <td className="border border-amber-300 p-1.5 w-1/2">
                          <div className="grid grid-cols-2 gap-1">
                            <div><span className="text-amber-950 font-black">REPORT DATE:</span> <span className="text-slate-900 font-bold">{formatDateDDMMYYYY(reportForm.serviceDate)}</span></div>
                            <div><span className="text-amber-950 font-black">FREQUENCY:</span> <span className="text-indigo-900 font-bold">{reportForm.serviceFrequency} Months</span></div>
                            <div><span className="text-amber-950 font-black">GSTIN:</span> <span className="text-slate-900 font-bold">{reportForm.gstin || 'N/A'}</span></div>
                            <div><span className="text-amber-950 font-black">ENGINEER:</span> <span className="text-slate-900 font-bold">{reportForm.technicians}</span></div>
                          </div>
                        </td>
                      </tr>
                   {/* AMC schedule — visibility controlled */}
                      {(srCfg.show_amc_schedule !== false) && (
                      <tr className="bg-amber-100/80 font-black text-amber-950 text-[9px]">
                        <td colSpan="2" className="border border-amber-300 p-1">
                          <span className="mr-2">AMC PLANNED SCHEDULE:</span>
                          {(reportForm.amcSchedule || []).map((m, idx) => (
                            <span key={idx} className="mr-3 bg-white px-2 py-0.5 rounded border border-amber-400 text-slate-900">
                              Q{idx + 1}: {m}
                            </span>
                          ))}
                        </td>
                      </tr>
                      )}
                    </tbody>
                  </table>

                  {/* 16-Column Default Equipment Table Schema */}
                  {(reportForm.itemsList || []).length > 0 && (
                    <div className="mb-2">
                      <EquipmentPreviewTable
                        items={reportForm.itemsList || []}
                        columns={previewColumns}
                        customColumns={reportForm.customColumns || []}
                        schemaVersion={reportForm.tableSchemaVersion || TABLE_SCHEMA_LEGACY}
                        srCols={srCols}
                        srCps={srCps}
                      />
                    </div>
                  )}

                  {/* Observations & Recommendations */}
                  <div className="grid grid-cols-2 gap-2 text-[9px] mb-2">
                    <div className="bg-slate-50 p-1.5 rounded border border-slate-300">
                      <strong className="text-amber-950 font-bold block mb-0.5">GENERAL OBSERVATIONS:</strong>
                      <p className="text-slate-800 leading-relaxed font-medium">{reportForm.fieldObservations}</p>
                    </div>
                    <div className="bg-slate-50 p-1.5 rounded border border-slate-300">
                      <strong className="text-amber-950 font-bold block mb-0.5">RECOMMENDATIONS:</strong>
                      <p className="text-slate-800 leading-relaxed font-medium">{reportForm.recommendations}</p>
                    </div>
                  </div>
                </div>

                {/* RECURRING FOOTER, STAMPS & DIGITAL SIGNATURES (EVERY PAGE) */}
                <div className="relative mt-auto pt-2 border-t-2 border-amber-700 shrink-0">
                  <div className="grid grid-cols-3 items-end gap-3 w-full shrink-0">
                    <div className="flex justify-start">
                      {/* Left: QR Code Verification */}
                      <div className="flex flex-col items-center justify-between text-center bg-slate-50 p-1.5 rounded-xl border border-slate-300 w-[110px] h-[115px] shrink-0 shadow-2xs">
                        <div className="bg-white p-0.5 rounded border border-slate-200 shadow-2xs">
                          <QRCodeCanvas
                            value={`${window.location.origin}/api/verify-certificate/${reportForm.verificationGuid}`}
                            size={56}
                            level="H"
                            includeMargin={false}
                          />
                        </div>
                        <div className="flex flex-col items-center">
                          <span className="text-[8px] font-extrabold text-indigo-950 uppercase leading-tight">Scan to verify</span>
                          <span className="text-[6.5px] font-bold text-slate-500">{reportForm.verificationGuid}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-center">
                      {/* Middle: Emergency Contacts with matching height (borderless) */}
                      <div className="flex flex-col items-center justify-between text-center w-[185px] h-[115px] shrink-0 mx-auto">
                        <span className="text-[9.5px] font-black text-red-600 uppercase leading-tight tracking-wider border-b border-red-300 pb-0.5 w-full text-center mb-1">Emergency Contact</span>
                        <table className="w-full border-collapse text-[9px] text-center font-extrabold flex-1 flex flex-col justify-center">
                          <tbody className="w-full">
                            <tr className="border-b border-slate-300 w-full flex">
                              <td className="border-r border-slate-300 py-1.5 px-1 text-red-600 font-extrabold w-1/2 flex items-center justify-center gap-0.5">
                                <span>🚒</span> Fire: <span className="text-slate-900 font-black">101</span>
                              </td>
                              <td className="py-1.5 px-1 text-blue-700 font-extrabold w-1/2 flex items-center justify-center gap-0.5">
                                <span>🚑</span> Amb: <span className="text-slate-900 font-black">108</span>
                              </td>
                            </tr>
                            <tr className="w-full flex">
                              <td className="border-r border-slate-300 py-1.5 px-1 text-blue-700 font-extrabold w-1/2 flex items-center justify-center gap-0.5">
                                <span>👮</span> Police: <span className="text-slate-900 font-black">100</span>
                              </td>
                              <td className="py-1.5 px-1 text-red-600 font-extrabold w-1/2 flex items-center justify-center gap-0.5">
                                <span>🚨</span> Emerg: <span className="text-slate-900 font-black">112</span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      {/* Right: Merged Stamp & Signature */}
                      <div className="relative flex items-end shrink-0">
                        {(srCfg.show_signature !== false) ? (
                          <div className="text-center flex flex-col items-center justify-end min-w-[150px] shrink-0">
                             {/* Stamp placed above signature line (system signature removed) */}
                             {(srCfg.show_stamp_every_page !== false) && (
                              <img
                                src={assets.stamp || branding.company_stamp_url || '/assets/company_stamp.png'}
                                onError={e => { e.target.onerror = null; e.target.src = '/assets/stamp.jpg'; }}
                                alt="Circular Blue Seal"
                                className="w-20 h-20 object-contain mx-auto -mb-1 shrink-0"
                              />
                            )}
                            <div className="border-t border-slate-900 pt-0.5 font-black text-[10px] text-slate-950 w-full uppercase">
                              {reportForm.authorizedSignatory || 'NILESHKUMAR MANJIBHAI PADAYA'}
                            </div>
                            <div className="text-[8px] text-slate-600 font-bold leading-tight">
                              Authorized Signatory — Expert Safety Solutions
                            </div>
                          </div>
                        ) : (
                          /* If signature is hidden but stamp is shown */
                          (srCfg.show_stamp_every_page !== false) && (
                            <div className="flex flex-col items-center justify-end shrink-0">
                              <img
                                src={assets.stamp || branding.company_stamp_url || '/assets/company_stamp.png'}
                                onError={e => { e.target.onerror = null; e.target.src = '/assets/stamp.jpg'; }}
                                alt="Circular Blue Seal"
                                className="w-20 h-20 object-contain shrink-0"
                              />
                              <span className="text-[7.5px] font-bold text-slate-500 uppercase mt-0.5">Official Circular Stamp</span>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                  {/* Bottom Footer Branding Image — same proportions as header */}
                  {(srCfg.show_footer !== false) && (
                  <div className="border-t border-slate-300 pt-2 mt-2 shrink-0">
                    <img
                      src={assets.footer || branding.footer_image_url || '/assets/Footer - Expert (2025).PNG'}
                      onError={e => { e.target.onerror = null; e.target.src = '/assets/footer.png'; }}
                      alt="Expert Safety Solutions Footer"
                      className="w-full h-auto max-h-28 object-contain mx-auto shrink-0"
                    />
                  </div>
                  )}
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer & Action Buttons */}
      <div className="border-t border-slate-200 bg-white pt-3 pb-3 px-4 sm:px-6 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-500">Step {wizardStep} of 3 | Role: <strong className="text-slate-900">{userRole}</strong></span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Staff Actions */}
          {userRole === 'Staff' && (
            <>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSaveReport('Draft')}
                className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl font-bold transition"
              >
                Save Draft
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSaveReport('Pending Approval')}
                className="px-4 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-md transition"
              >
                <Send className="w-4 h-4" />
                <span>Send for Admin Approval</span>
              </button>
            </>
          )}

          {/* Admin Actions */}
          {userRole === 'Admin' && (
            <>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  const remarks = window.prompt('Enter Revision Instructions for Technician:', reportForm.Approval_Remarks || '');
                  if (remarks !== null) handleSaveReport('Revision Requested', remarks);
                }}
                className="px-3 py-2 bg-rose-100 hover:bg-rose-200 text-rose-800 border border-rose-300 rounded-xl font-bold transition"
              >
                Request Revision
              </button>

              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => handleSaveReport('Approved')}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-md transition"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Approve &amp; Lock Report</span>
              </button>
            </>
          )}

          {/* PDF & Share Actions */}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleDownloadPDF}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-md transition"
          >
            <Download className="w-4 h-4" />
            <span>Download A4 Landscape PDF</span>
          </button>

          <button
            type="button"
            onClick={handleShareWhatsApp}
            className="px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl font-bold flex items-center gap-1.5 shadow-md transition"
          >
            <Share2 className="w-4 h-4" />
            <span>Share WhatsApp</span>
          </button>
        </div>
      </div>

      {/* Floating Action Button for Mobile Toggle */}
      <div className="lg:hidden fixed bottom-6 right-6 z-50">
        <button
          type="button"
          onClick={() => setActiveMobileTab(activeMobileTab === 'edit' ? 'preview' : 'edit')}
          className="flex items-center gap-2 bg-slate-900 text-white hover:bg-slate-800 active:scale-95 px-5 py-3.5 rounded-full font-black text-sm shadow-2xl transition-all border border-slate-700"
        >
          {activeMobileTab === 'edit' ? (
            <>
              <Eye className="w-4 h-4 text-amber-500 animate-pulse" />
              <span>Show Preview</span>
            </>
          ) : (
            <>
              <Edit3 className="w-4 h-4 text-amber-500" />
              <span>Edit Form</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
