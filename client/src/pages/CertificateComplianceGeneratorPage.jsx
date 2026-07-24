import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDocSettings } from '../context/DocSettingsContext';
import { getLocalDateStr, formatDateDDMMYYYY, getRecordCreatedAt, formatDateTimeDDMMYYYYHHMMSS } from '../utils/dateUtils';
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  FileCheck,
  Search,
  PlusCircle,
  X,
  Download,
  Printer,
  CheckCircle2,
  Eye,
  Edit3,
  Save,
  Settings,
  Maximize2,
  Minimize2,
  Share2,
  Lock,
  GripVertical,
  RotateCcw
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
// html2canvas/jspdf are loaded on demand (see generateCertificateCanvas/buildCertificatePdf) —
// they're ~590KB and only needed when the user actually downloads/prints/shares, not to open the page.

// Settings-panel sections. `order` controls the panel layout only; `pdf: true` marks
// sections whose content actually prints on the certificate, so they get a show/hide
// tick. Unticked = hidden from the certificate but kept here for later reuse.
const CERT_SECTIONS = [
  { id: 'itemMaster',     label: 'Item Master & Variants',   pdf: false },
  { id: 'bodyIntro',      label: 'Certificate Body Text',    pdf: true  },
  { id: 'customCertify',  label: 'Custom Lines',             pdf: true  },
  { id: 'equipmentNotes', label: 'Custom Notes',             pdf: true  },
  { id: 'formatSpecific', label: 'Format-Specific Details',  pdf: true  },
  { id: 'title',          label: 'Certificate Title',        pdf: true  },
  { id: 'statusBadge',    label: 'Compliance Status Badge',  pdf: false },
  { id: 'certNo',         label: 'Certificate No Structure', pdf: true  },
  { id: 'customColumns',  label: 'Custom Table Columns',     pdf: true  },
  { id: 'validity',       label: 'Validity Period',          pdf: false },
  { id: 'signatory',      label: 'Authorized Signatory',     pdf: true  }
];
const CERT_SECTION_IDS = CERT_SECTIONS.map(s => s.id);
const CERT_SECTION_META = Object.fromEntries(CERT_SECTIONS.map(s => [s.id, s]));
const CERT_SECTION_ORDER_KEY = 'esc_cert_section_order_v1';

// Normalize a stored order: keep known ids, drop unknown, append anything missing.
const normalizeSectionOrder = (saved) => {
  if (!Array.isArray(saved)) return CERT_SECTION_IDS;
  const valid = saved.filter(id => CERT_SECTION_IDS.includes(id));
  if (!valid.length) return CERT_SECTION_IDS;
  return [...valid, ...CERT_SECTION_IDS.filter(id => !valid.includes(id))];
};

// Helper: Format quantity with "Nos." unit
const formatQtyNos = (val) => {
  if (val === undefined || val === null || val === '') return '1 Nos.';
  const str = String(val).trim();
  if (!str) return '1 Nos.';
  if (str.toLowerCase().endsWith('nos.') || str.toLowerCase().endsWith('nos')) {
    return str;
  }
  return `${str} Nos.`;
};

// Helper: Mask customer name for privacy (first 3 and last 3 chars, e.g. Lax...ome)
const maskCustomerName = (name) => {
  if (!name) return '';
  const trimmed = name.trim();
  if (trimmed.length <= 6) return trimmed;
  return trimmed.substring(0, 3) + '...' + trimmed.substring(trimmed.length - 3);
};

// Helper: Mask address for privacy (show last 2 comma-separated segments only)
const maskAddress = (addr) => {
  if (!addr) return '';
  const segments = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (segments.length <= 1) return addr;
  const lastParts = segments.slice(-2);
  return lastParts.join(', ');
};

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

// Helper: Find latest sequence number for category
const getLatestSequenceNumber = (certs, formatType) => {
  let maxSeq = 310;
  if (!certs || !Array.isArray(certs)) return maxSeq;
  const typeCerts = certs.filter(c => c.formatType === formatType || c.Format_Type === formatType);
  typeCerts.forEach(c => {
    const certNo = c.Certificate_No || c.certificateNo || '';
    const parts = certNo.split('/');
    if (parts.length > 0) {
      const suffix = parts[parts.length - 1];
      const baseSuffix = suffix.split('-')[0];
      const numMatch = baseSuffix.match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        if (!isNaN(num) && num > maxSeq) {
          maxSeq = num;
        }
      }
    }
  });
  return maxSeq;
};

// A saved/locked Settings template stores a fixed reference certSequence (e.g. "R9813"), but that
// number goes stale the moment any newer certificate is actually issued — it must never be applied
// as-is, or every subsequently opened certificate resets back to it and collides with real numbers
// already in use. This resolves the true next-available sequence: whichever is higher between
// "next after the highest certificate actually on file" and the template's own reference number,
// so the number only ever moves forward and can never produce a duplicate.
const resolveEffectiveNextSequence = (templateSequence, formatType, certsList, fallbackSequence) => {
  const latestIssuedNum = getLatestSequenceNumber(certsList, formatType);
  const templateNumMatch = (templateSequence || '').match(/\d+/);
  const templateNum = templateNumMatch ? parseInt(templateNumMatch[0], 10) : 0;
  const nextNum = Math.max(latestIssuedNum + 1, templateNum);
  const prefixLetter = (templateSequence || fallbackSequence || '').match(/^[A-Za-z]+/)?.[0] || '';
  return `${prefixLetter}${nextNum}`;
};

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

const DEFAULT_MASTER_ITEMS = [
  { id: 'def-1', type: 'Dry Chemical Powder (ABC Type IS:15683)', capacities: ['1 Kg', '2 Kg', '4 Kg', '6 Kg', '9 Kg'] },
  { id: 'def-2', type: 'CO2 Type Fire Extinguisher (IS:2878)', capacities: ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'] },
  { id: 'def-3', type: 'Carbon Dioxide (CO2) Fire Extinguisher', capacities: ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'] },
  { id: 'def-4', type: 'Mechanical Foam AFFF Type (IS:10204)', capacities: ['6 Ltr', '9 Ltr', '50 Ltr'] },
  { id: 'def-5', type: 'Water CO2 Type Fire Extinguisher (IS:940)', capacities: ['6 Ltr', '9 Ltr', '50 Ltr'] },
  { id: 'def-6', type: 'Clean Agent HFC-227ea / FK-5-1-12 (IS:15683)', capacities: ['2 Kg', '4 Kg', '6 Kg'] },
  { id: 'def-7', type: 'Modular Automatic Extinguisher (ABC Type)', capacities: ['2 Kg', '5 Kg', '10 Kg', '15 Kg'] }
];

// Helper to find best matching master item based on ID, exact name, or keywords
const findMatchingMasterItem = (masterList, searchId, searchName) => {
  if (searchId) {
    const found = masterList.find(x => x.id === searchId);
    if (found) return found;
  }
  if (!searchName || !searchName.trim()) return null;
  const term = searchName.trim().toLowerCase();

  // 1. Exact match on type or itemName
  const exact = masterList.find(x => (x.type || x.itemName || '').toLowerCase() === term);
  if (exact) return exact;

  // 2. Partial includes match
  const contains = masterList.find(x => {
    const t = (x.type || x.itemName || '').toLowerCase();
    return t.includes(term) || term.includes(t);
  });
  if (contains) return contains;

  // 3. Keyword matching for common fire extinguisher types
  if (term.includes('co2') || term.includes('carbon') || term.includes('dioxide') || term.includes('carbod')) {
    return masterList.find(x => {
      const t = (x.type || x.itemName || '').toLowerCase();
      return t.includes('co2') || t.includes('carbon');
    }) || masterList.find(x => x.id === 'def-2');
  }

  if (term.includes('abc') || term.includes('dcp') || term.includes('powder')) {
    return masterList.find(x => {
      const t = (x.type || x.itemName || '').toLowerCase();
      return t.includes('abc') || t.includes('powder');
    }) || masterList[0];
  }

  if (term.includes('foam') || term.includes('afff')) {
    return masterList.find(x => (x.type || x.itemName || '').toLowerCase().includes('foam'));
  }

  if (term.includes('water')) {
    return masterList.find(x => (x.type || x.itemName || '').toLowerCase().includes('water'));
  }

  if (term.includes('clean') || term.includes('agent') || term.includes('hfc')) {
    return masterList.find(x => (x.type || x.itemName || '').toLowerCase().includes('clean'));
  }

  if (term.includes('modular') || term.includes('auto')) {
    return masterList.find(x => (x.type || x.itemName || '').toLowerCase().includes('modular'));
  }

  return null;
};

// Shrinks table/paragraph density as the item count grows so the certificate keeps fitting on one A4 page
const getCertDensity = (itemCount) => {
  if (itemCount === 1) {
    return { cellPad: 'py-8 px-4', cellText: 'text-[11.5px]', bodyText: 'text-[12.5px]', bodySpace: 'space-y-4 mb-6', badgeMy: 'my-6', headerMb: 'mb-6', tableMt: 'mt-6', imgMaxH: 'max-h-28' };
  }
  if (itemCount === 2) {
    return { cellPad: 'py-6 px-4', cellText: 'text-[11px]', bodyText: 'text-[12px]', bodySpace: 'space-y-3.5 mb-5', badgeMy: 'my-5', headerMb: 'mb-5', tableMt: 'mt-5', imgMaxH: 'max-h-28' };
  }
  if (itemCount === 3) {
    return { cellPad: 'py-5 px-3', cellText: 'text-[10.5px]', bodyText: 'text-[11.5px]', bodySpace: 'space-y-3 mb-4', badgeMy: 'my-4', headerMb: 'mb-4', tableMt: 'mt-4', imgMaxH: 'max-h-28' };
  }
  if (itemCount <= 5) {
    return { cellPad: 'py-3 px-3', cellText: 'text-[10px]', bodyText: 'text-xs', bodySpace: 'space-y-3 mb-4', badgeMy: 'my-4', headerMb: 'mb-4', tableMt: 'mt-4', imgMaxH: 'max-h-28' };
  }
  if (itemCount <= 8) {
    return { cellPad: 'py-2 px-2', cellText: 'text-[9.5px]', bodyText: 'text-[11px]', bodySpace: 'space-y-2 mb-3', badgeMy: 'my-3', headerMb: 'mb-3', tableMt: 'mt-3', imgMaxH: 'max-h-28' };
  }
  if (itemCount <= 12) {
    return { cellPad: 'py-1 px-1.5', cellText: 'text-[8.5px]', bodyText: 'text-[10.5px]', bodySpace: 'space-y-1.5 mb-2', badgeMy: 'my-2', headerMb: 'mb-2', tableMt: 'mt-2', imgMaxH: 'max-h-28' };
  }
  return { cellPad: 'px-1 py-[1.5px]', cellText: 'text-[7.5px]', bodyText: 'text-[10px]', bodySpace: 'space-y-1 mb-1.5', badgeMy: 'my-1.5', headerMb: 'mb-1.5', tableMt: 'mt-1.5', imgMaxH: 'max-h-28' };
};

// Reorderable list of optional free-text lines (used for the custom lines below the certify
// statement and below the equipment table) — each line can be moved up/down, removed, or added via "+".
function CustomLinesEditor({ lines, onChange, placeholder, accent = 'amber' }) {
  const safeLines = (lines && lines.length ? lines : ['']);
  const accentClasses = accent === 'indigo'
    ? { bg: 'bg-indigo-50', border: 'border-indigo-300', ring: 'focus:ring-indigo-500', btn: 'bg-indigo-600 hover:bg-indigo-700' }
    : { bg: 'bg-amber-50', border: 'border-amber-300', ring: 'focus:ring-amber-500', btn: 'bg-amber-700 hover:bg-amber-800' };

  const update = (idx, value) => {
    const next = [...safeLines];
    next[idx] = value;
    onChange(next);
  };
  const remove = (idx) => {
    const next = safeLines.filter((_, i) => i !== idx);
    onChange(next.length ? next : ['']);
  };
  const move = (idx, dir) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= safeLines.length) return;
    const next = [...safeLines];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      {safeLines.map((line, idx) => (
        <div key={idx} className="flex items-start gap-1.5">
          <div className="flex flex-col shrink-0">
            <button type="button" disabled={idx === 0} onClick={() => move(idx, -1)}
              title="Move up"
              className="p-0.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200 disabled:opacity-25 disabled:hover:bg-transparent">
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button type="button" disabled={idx === safeLines.length - 1} onClick={() => move(idx, 1)}
              title="Move down"
              className="p-0.5 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-200 disabled:opacity-25 disabled:hover:bg-transparent">
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <textarea rows={1} value={line} onChange={e => update(idx, e.target.value)} placeholder={placeholder}
            className={`flex-1 px-3 py-2 ${accentClasses.bg} border ${accentClasses.border} rounded-lg font-medium text-slate-800 text-xs focus:ring-2 ${accentClasses.ring} focus:outline-none resize-none`} />
          <button type="button" onClick={() => remove(idx)} title="Remove line"
            className="shrink-0 p-1.5 mt-0.5 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...safeLines, ''])}
        className={`flex items-center gap-1.5 px-3 py-1.5 ${accentClasses.btn} text-white rounded-lg font-bold text-[11px] transition`}>
        <PlusCircle className="w-3.5 h-3.5" /> Add Line
      </button>
    </div>
  );
}

export default function CertificateComplianceGeneratorPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const { docSettings, updateDocSettings } = useDocSettings();
  const certCfg = docSettings?.document_configs?.CERTIFICATE || {};
  const branding = docSettings?.branding_assets || {};
  const handleBack = () => navigate('/');

  const [isPageLoading, setIsPageLoading] = useState(true);
  
  // Mobile responsiveness and preview scaling states
  const [activeMobileTab, setActiveMobileTab] = useState('edit');
  const [previewScale, setPreviewScale] = useState(1);
  const [focusMode, setFocusMode] = useState(false);
  const touchStartRef = useRef(0);
  const equipmentSectionRef = useRef(null);
  const hasAutoRevealedEquipment = useRef(false);

  useEffect(() => {
    const updateScale = () => {
      const width = window.innerWidth;
      if (width < 640) {
        setPreviewScale(Math.min((width - 32) / 794, 1));
      } else if (width < 1024) {
        setPreviewScale(Math.min((width - 48) / 794, 1));
      } else {
        const columnWidth = (width - 48 - 32) / 2;
        if (columnWidth < 820) {
          setPreviewScale(Math.min((columnWidth - 24) / 794, 1));
        } else {
          setPreviewScale(1);
        }
      }
    };

    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

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

  const [loadError, setLoadError] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [equipmentMasterList, setEquipmentMasterList] = useState([]);
  const [task, setTask] = useState(null);
  const [adminSubmitting, setAdminSubmitting] = useState('');

  const certPreviewRef = useRef(null);
  const [certBase64Assets, setCertBase64Assets] = useState({
    header: '',
    stamp: '',
    signature: '',
    footer: '',
    watermark: ''
  });

  const [allCertificates, setAllCertificates] = useState([]);
  const [certSearchQuery, setCertSearchQuery] = useState('');
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showCertSearchDropdown, setShowCertSearchDropdown] = useState(false);
  const [certTab, setCertTab] = useState('client'); // 'client' | 'equipment' | 'settings'

  const [certForm, setCertForm] = useState({
    formatType: 'Refilling',
    certPrefix: 'Expert/',
    certPeriod: '26-27',
    certSequence: 'R310',
    certificateNo: 'Expert/26-27/R310',
    editCoolingDays: 3,
    title: 'FIRE EXTINGUISHER REFILLING & MAINTENANCE CERTIFICATE',
    customerName: '',
    address: '',
    gstin: '',
    contact: '',
    authPerson: '',
    equipmentDetails: 'Fire Extinguishers Refilling, Testing & Maintenance as per IS:2190 standards',
    issueDate: getLocalDateStr(),
    challanDate: getLocalDateStr(),
    validUntil: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
    validityDuration: '1 Year',
    isContentUnlocked: false,
    isLocked: false,
    revision: 0,
    verificationGuid: 'ESS-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    authorizedSignatory: 'Mr. Nilesh Padaya',
    status: 'VERIFIED & COMPLIANT',
    hpTestPressure: '35 kg/cm² (3.5 MPa)',
    hpTestResult: 'PASSED (Zero Leakage / No Deformation)',
    newExtinguisherWarranty: '12 Months Comprehensive Warranty from Date of Installation',
    isiMarkNumber: 'IS:15683 / CM/L-8472910',
    systemInstallationType: 'Fire Hydrant, Automatic Sprinkler & Conventional Fire Alarm System',
    systemStatus: 'Commissioned, Tested & Fully Operational as per NBC Part IV & TAC Guidelines',
    amcPeriod: '1 Year Comprehensive / Non-Comprehensive Annual Maintenance',
    amcFrequency: 'Quarterly Routine Inspections (4 Mandatory Visits/Year)',
    visitObservations: 'All fire safety installations inspected. Pressure gauges in green zone. Seals intact. Emergency exit lights functional.',
    bodyIntroLines: [''],
    customCertifyLines: [''],
    customEquipmentNotes: [''],
    customColumns: [],
    itemsList: [],
    sectionOrder: normalizeSectionOrder((() => {
      try { return JSON.parse(localStorage.getItem(CERT_SECTION_ORDER_KEY)); } catch { return null; }
    })()),
    sectionVisibility: {}
  });

  const [certCustomerSearch, setCertCustomerSearch] = useState('');
  const [showCertCustDropdown, setShowCertCustDropdown] = useState(false);

  // Settings-panel section ordering + per-section show/hide on the certificate.
  // Order is panel layout only; visibility gates what prints on the certificate.
  const [draggingSectionId, setDraggingSectionId] = useState(null);
  const [dragOverSectionId, setDragOverSectionId] = useState(null);

  const sectionOrder = normalizeSectionOrder(certForm.sectionOrder);
  const isSectionVisible = (id) => {
    if (!CERT_SECTION_META[id]?.pdf) return true;
    return certForm.sectionVisibility?.[id] !== false;
  };

  const setSectionOrder = (updater) => {
    setCertForm(prev => {
      const current = normalizeSectionOrder(prev.sectionOrder);
      const next = typeof updater === 'function' ? updater(current) : updater;
      try { localStorage.setItem(CERT_SECTION_ORDER_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return { ...prev, sectionOrder: next };
    });
  };

  const moveCertSection = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    setSectionOrder(current => {
      const next = [...current];
      const from = next.indexOf(fromId);
      const to = next.indexOf(toId);
      if (from === -1 || to === -1) return current;
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  const nudgeCertSection = (id, dir) => {
    setSectionOrder(current => {
      const idx = current.indexOf(id);
      const target = idx + dir;
      if (idx === -1 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const toggleSectionVisible = (id) => {
    if (!CERT_SECTION_META[id]?.pdf) return;
    setCertForm(prev => ({
      ...prev,
      sectionVisibility: {
        ...(prev.sectionVisibility || {}),
        [id]: prev.sectionVisibility?.[id] === false
      }
    }));
  };
  const [newColLabel, setNewColLabel] = useState('');
  const [newItemCustomValues, setNewItemCustomValues] = useState({});
  const [newItemSearch, setNewItemSearch] = useState('');
  const [showNewItemDropdown, setShowNewItemDropdown] = useState(false);
  const [newItemSelectedMasterId, setNewItemSelectedMasterId] = useState('');
  const [newItemCapacity, setNewItemCapacity] = useState('');
  const [newItemQty, setNewItemQty] = useState('');
  const [newItemRefillDate, setNewItemRefillDate] = useState(getLocalDateStr());
  const [newItemNextDate, setNewItemNextDate] = useState(new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0]);

  const calculateNextDate = (refillDate, duration = certForm.validityDuration) => {
    if (!refillDate) return '';
    const years = duration === '5 Years' ? 5 : duration === '3 Years' ? 3 : 1;
    try {
      const d = new Date(refillDate);
      if (isNaN(d.getTime())) return '';
      d.setFullYear(d.getFullYear() + years);
      return d.toISOString().split('T')[0];
    } catch (e) {
      return '';
    }
  };

  // Item Master CRUD panel state
  const [showItemMasterPanel, setShowItemMasterPanel] = useState(false);
  const [imEditId, setImEditId] = useState(null); // null = new, string = editing existing
  const [imName, setImName] = useState('');
  const [imVariants, setImVariants] = useState(''); // comma-separated string
  const [imSaving, setImSaving] = useState(false);

  const handleUpdateCertNoFields = (updatedFields) => {
    setCertForm(prev => {
      const next = { ...prev, ...updatedFields };
      const prefix = next.certPrefix !== undefined ? next.certPrefix : (prev.certPrefix || 'Expert/');
      const period = next.certPeriod !== undefined ? next.certPeriod : (prev.certPeriod || '26-27');
      const seq = next.certSequence !== undefined ? next.certSequence : (prev.certSequence || 'R310');
      next.certificateNo = `${prefix}${period}/${seq}`;
      return next;
    });
  };

  const handleLoadCertificateToEdit = (c) => {
    const newCertNo = c.Certificate_No || c.certificateNo || '';
    const newRevision = (c.Revision || c.revision || 0);
    const loadedChallanDate = c.Challan_Date || c.challanDate || c.Issue_Date || c.issueDate || getLocalDateStr();
    const loadedValidUntil = c.Valid_Until || c.validUntil || '';

    // Load into form state directly
    setCertForm({
      ...c,
      certificateNo: newCertNo,
      revision: newRevision,
      isLocked: false,
      isContentUnlocked: true,
      // Map standard capitalized keys back to state format if saved in sheet
      customerName: c.Customer_Name || c.customerName || '',
      address: c.Address || c.address || '',
      gstin: c.GSTIN || c.gstin || '',
      contact: c.Contact || c.contact || '',
      authPerson: c.Auth_Person || c.authPerson || '',
      issueDate: c.Issue_Date || c.issueDate || getLocalDateStr(),
      validUntil: loadedValidUntil,
      challanDate: loadedChallanDate,
      verificationGuid: c.Verification_GUID || c.verificationGuid || 'ESS-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    });

    setNewItemRefillDate(loadedChallanDate);
    setNewItemNextDate(loadedValidUntil);
    setCertSearchQuery(newCertNo);
    setShowCertSearchDropdown(false);
    setActiveMobileTab('preview');
    alert(`Loaded Certificate ${newCertNo} (Ready to edit and re-save).`);
  };

  // Copies every field from an existing certificate into a brand-new one — same customer,
  // equipment, and settings, but today's date and the next unused certificate number, so it never
  // collides with the original. Nothing is saved until the user hits Save/Download themselves.
  const handleDuplicateCertificate = (c) => {
    const format = c.formatType || c.Format_Type || 'Refilling';
    const prefix = c.certPrefix || 'Expert/';
    const period = c.certPeriod || '26-27';
    const rawCertNo = c.Certificate_No || c.certificateNo || '';
    const originalSeq = c.certSequence || rawCertNo.split('/').pop() || '';
    const nextSequence = resolveEffectiveNextSequence(null, format, allCertificates, originalSeq);
    const todayStr = getLocalDateStr();
    const years = c.validityDuration === '5 Years' ? 5 : c.validityDuration === '3 Years' ? 3 : 1;
    const nextValidUntil = c.validityDuration === 'Custom'
      ? (c.validUntil || todayStr)
      : new Date(new Date(todayStr).setFullYear(new Date(todayStr).getFullYear() + years)).toISOString().split('T')[0];

    setCertForm({
      ...c,
      formatType: format,
      certPrefix: prefix,
      certPeriod: period,
      certSequence: nextSequence,
      certificateNo: `${prefix}${period}/${nextSequence}`,
      customerName: c.Customer_Name || c.customerName || '',
      address: c.Address || c.address || '',
      gstin: c.GSTIN || c.gstin || '',
      contact: c.Contact || c.contact || '',
      authPerson: c.Auth_Person || c.authPerson || '',
      issueDate: todayStr,
      challanDate: todayStr,
      validUntil: nextValidUntil,
      isLocked: false,
      isContentUnlocked: false,
      revision: 0,
      verificationGuid: 'ESS-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    });

    setNewItemRefillDate(todayStr);
    setNewItemNextDate(nextValidUntil);
    setCertSearchQuery('');
    setShowCertSearchDropdown(false);
    setActiveMobileTab('preview');
    alert(`Duplicated as new certificate ${prefix}${period}/${nextSequence} — dated today. Review and Save/Download to issue it.`);
  };

  const handleCertFormatChange = (newFormat) => {
    let title = 'FIRE EXTINGUISHER REFILLING & MAINTENANCE CERTIFICATE';
    let details = 'Fire Extinguishers Refilling, Testing & Maintenance as per IS:2190 standards';
    let duration = '1 Year';
    let yearsToAdd = 1;
    let defaultBodyIntro = [];
    let defaultCustomCertify = [];
    
    const latestSeq = getLatestSequenceNumber(allCertificates, newFormat);
    const nextSeq = latestSeq + 1;
    let seqSuffix = 'R310';

    if (newFormat === 'HP Testing') {
      title = 'HYDRAULIC PRESSURE (HP) TESTING CERTIFICATE';
      details = 'Mandatory Hydraulic Pressure Testing of Fire Extinguishers & Cylinders at 35 kg/cm² test pressure as per IS:2190 & Gas Cylinder Rules';
      duration = '3 Years';
      yearsToAdd = 3;
      seqSuffix = `T${nextSeq}`;
      defaultBodyIntro = ["This is to certify that the fire extinguishers / cylinders listed below have been subjected to hydraulic pressure testing and found to be free from leakages, cracks, or deformation at the test pressure."];
      defaultCustomCertify = ["Testing was conducted in accordance with IS 2190 standards and Gas Cylinder Rules."];
    } else if (newFormat === 'New Fire Extinguisher') {
      title = 'NEW FIRE EXTINGUISHER WARRANTY & INSPECTION CERTIFICATE';
      details = 'Supply, Installation and Initial Verification of New ISI Marked Fire Extinguishers conforming to IS:15683 standards';
      seqSuffix = `N${nextSeq}`;
      defaultBodyIntro = ["This is to certify that we have supplied, installed and verified the initial performance of the new fire extinguishers listed below. The equipment is brand new and carries an official manufacturer warranty."];
      defaultCustomCertify = ["The equipment complies with IS 15683 standards and is certified for immediate operational readiness."];
    } else if (newFormat === 'System Installation') {
      title = 'FIRE FIGHTING SYSTEM INSTALLATION & COMMISSIONING CERTIFICATE';
      details = 'Installation, Pressure Testing & Commissioning of Fire Hydrant System, Automatic Alarm Panel & Fire Suppression Equipment';
      seqSuffix = `S${nextSeq}`;
      defaultBodyIntro = ["This is to certify that the fire fighting system (hydrant / alarm / suppression) has been successfully installed, pressure tested, and commissioned at the client premises."];
      defaultCustomCertify = ["The system has been verified for compliance with national fire safety codes and standards."];
    } else if (newFormat === 'AMC Certificate') {
      title = 'ANNUAL MAINTENANCE CONTRACT (AMC) COMPLIANCE CERTIFICATE';
      details = 'Comprehensive / Routine Preventive Maintenance and Periodic Testing of Fire Protection Systems under Annual Maintenance Contract (AMC)';
      seqSuffix = `A${nextSeq}`;
      defaultBodyIntro = ["This is to certify that the fire safety installations and safety equipment of the client are maintained in complete operational readiness under our Annual Maintenance Contract (AMC)."];
      defaultCustomCertify = ["Routine periodic maintenance checks have been performed and the installations are certified compliant."];
    } else if (newFormat === 'Visit Report') {
      title = 'FIRE SAFETY FIELD INSPECTION & SERVICE VISIT REPORT';
      details = 'On-site Field Service, Safety Audit Inspection and Routine Fire Equipment Readiness Verification Report';
      seqSuffix = `V${nextSeq}`;
      defaultBodyIntro = ["This field service safety audit report documents the observations, checks, and safety verification carried out during our engineer visit to the client premises."];
      defaultCustomCertify = ["Recommended safety rectifications and routine check-up procedures have been explained to the customer."];
    } else if (newFormat === 'Training Certificate') {
      title = 'FIRE EXTINGUISHER OPERATION & SAFETY TRAINING CERTIFICATE';
      details = 'Theoretical and Practical Training in Fire Protection and Safe Extinguisher Operation';
      seqSuffix = `TR${nextSeq}`;
      defaultBodyIntro = ["This is to certify that we have conducted practical fire extinguisher operation and basic fire safety training for the safety program participants."];
      defaultCustomCertify = ["The trainees participated in mock fire drill demonstrations and basic instruction on fire safety guidelines."];
    } else {
      seqSuffix = `R${nextSeq}`;
      defaultBodyIntro = ["This is to certify that the under noted fire extinguisher/s has/have been refilled by us on as per below details."];
      defaultCustomCertify = ["It is strongly recommended that the maintenance of Fire Extinguishers must be performed as per IS 2190."];
    }

    const currentPrefix = certForm.certPrefix || 'Expert/';
    const currentPeriod = certForm.certPeriod || '26-27';
    const refillStart = new Date(certForm.challanDate || getLocalDateStr());
    const nextDt = new Date(refillStart);
    nextDt.setFullYear(nextDt.getFullYear() + yearsToAdd);

    // Merge system settings if they exist
    const systemSettings = docSettings?.certificate_types?.[newFormat] || {};

    setCertForm(prev => {
      const nextTitle = systemSettings.title || title;
      const nextDetails = systemSettings.equipmentDetails || details;
      const nextPrefix = systemSettings.certPrefix || currentPrefix;
      const nextPeriod = systemSettings.certPeriod || currentPeriod;
      const nextSequence = resolveEffectiveNextSequence(systemSettings.certSequence, newFormat, allCertificates, seqSuffix);
      const nextCertNo = `${nextPrefix}${nextPeriod}/${nextSequence}`;
      
      const nextValidityDuration = systemSettings.validityDuration || duration;
      const nextValidUntil = systemSettings.validUntil || nextDt.toISOString().split('T')[0];
      const nextBodyIntro = systemSettings.bodyIntroLines || defaultBodyIntro;
      const nextCustomCertify = systemSettings.customCertifyLines || defaultCustomCertify;
      const nextCustomNotes = systemSettings.customEquipmentNotes || [''];
      const nextCustomColumns = systemSettings.customColumns || [];
      const nextSignatory = systemSettings.authorizedSignatory || 'Mr. Nilesh Padaya';
      const nextStatus = systemSettings.status || 'VERIFIED & COMPLIANT';
      const nextIsLocked = systemSettings.isSettingsLocked !== undefined ? systemSettings.isSettingsLocked : false;

      return {
        ...prev,
        // Clear format-specific inputs
        hpTestPressure: systemSettings.hpTestPressure || '',
        hpTestResult: systemSettings.hpTestResult || '',
        newExtinguisherWarranty: systemSettings.newExtinguisherWarranty || '',
        isiMarkNumber: systemSettings.isiMarkNumber || '',
        systemInstallationType: systemSettings.systemInstallationType || '',
        systemStatus: systemSettings.systemStatus || '',
        amcPeriod: systemSettings.amcPeriod || '',
        amcFrequency: systemSettings.amcFrequency || '',
        visitObservations: systemSettings.visitObservations || '',
        
        // Settings-isolated properties
        formatType: newFormat,
        certPrefix: nextPrefix,
        certPeriod: nextPeriod,
        certSequence: nextSequence,
        certificateNo: nextCertNo,
        title: nextTitle,
        equipmentDetails: nextDetails,
        validityDuration: nextValidityDuration,
        validUntil: nextValidUntil,
        bodyIntroLines: nextBodyIntro,
        customCertifyLines: nextCustomCertify,
        customEquipmentNotes: nextCustomNotes,
        customColumns: nextCustomColumns,
        authorizedSignatory: nextSignatory,
        status: nextStatus,
        sectionOrder: normalizeSectionOrder(systemSettings.sectionOrder),
        sectionVisibility: systemSettings.sectionVisibility || {},
        isSettingsLocked: nextIsLocked
      };
    });
  };

  // Load customers, equipment master, and (if opened from a task) the task itself
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsPageLoading(true);
      setLoadError(null);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [custRes, eqRes, tasksRes, certsRes] = await Promise.all([
          fetch('/api/customers', { headers }),
          fetch('/api/equipment-master', { headers }),
          taskId ? fetch('/api/tasks', { headers }) : Promise.resolve(null),
          fetch('/api/certificates', { headers })
        ]);
        const custData = custRes.ok ? await custRes.json() : [];
        const eqData = eqRes.ok ? await eqRes.json() : [];
        const certsData = certsRes.ok ? await certsRes.json() : [];
        if (cancelled) return;
        setCustomers(Array.isArray(custData) ? custData : []);
        setEquipmentMasterList(Array.isArray(eqData) ? eqData : []);
        setAllCertificates(Array.isArray(certsData) ? certsData : []);

        if (taskId) {
          if (!tasksRes || !tasksRes.ok) throw new Error('Failed to load work order');
          const allTasks = await tasksRes.json();
          const foundTask = (Array.isArray(allTasks) ? allTasks : []).find(t => String(t.Task_ID) === String(taskId));
          if (cancelled) return;
          if (!foundTask) {
            setLoadError('Work order not found.');
          } else {
            setTask(foundTask);
            const cust = custData.find(c => String(c.Customer_ID) === String(foundTask.Customer_ID) || c.Company_Name === foundTask.Customer_Name) || {};
            const issueDt = foundTask.Scheduled_Date || getLocalDateStr();
            const nextYrDt = new Date(new Date(issueDt).setFullYear(new Date(issueDt).getFullYear() + 1)).toISOString().split('T')[0];
            const taskSeq = String(foundTask.Task_ID || foundTask.id || Math.floor(1000 + Math.random() * 9000)).replace(/\D/g, '');
            const seqNo = `R${taskSeq || '310'}`;
            setCertForm(prev => ({
              ...prev,
              certPrefix: 'Expert/',
              certPeriod: '26-27',
              certSequence: seqNo,
              certificateNo: `Expert/26-27/${seqNo}`,
              customerName: foundTask.Customer_Name || cust.Company_Name || 'Valued Client',
              address: foundTask.Customer_Address || cust.Address || 'Gujarat, India',
              contact: cust.Contact || cust.Phone || cust.Mobile || cust.Contact_Number || '',
              authPerson: cust.Auth_Person || '',
              equipmentDetails: foundTask.Description || prev.equipmentDetails,
              issueDate: issueDt,
              validUntil: nextYrDt,
              itemsList: [
                {
                  id: 'item-1',
                  srNo: 1,
                  itemName: 'Dry Chemical Powder (ABC Type IS:15683)',
                  capacity: '6 Kg',
                  identificationNo: `CYL-${foundTask.Task_ID || '101'}`,
                  refillingDate: issueDt,
                  nextDate: nextYrDt,
                  customValues: {}
                }
              ]
            }));
            setCertCustomerSearch(foundTask.Customer_Name || cust.Company_Name || '');
          }
        } else {
          const latestSeq = getLatestSequenceNumber(certsData, 'Refilling');
          const nextSeq = latestSeq + 1;
          setCertForm(prev => ({
            ...prev,
            certSequence: `R${nextSeq}`,
            certificateNo: `Expert/26-27/R${nextSeq}`
          }));
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load certificate data');
      } finally {
        if (!cancelled) setIsPageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId, token]);
  // Apply loaded doc settings to new certificate on mount or when docSettings changes
  useEffect(() => {
    if (!docSettings || !certForm.formatType) return;
    const isExisting = allCertificates.some(c => c.verificationGuid === certForm.verificationGuid || c.Verification_GUID === certForm.verificationGuid);
    if (isExisting) return; // do not overwrite if editing loaded cert

    const systemSettings = docSettings?.certificate_types?.[certForm.formatType];
    if (systemSettings) {
      setCertForm(prev => {
        const prefix = systemSettings.certPrefix || prev.certPrefix;
        const period = systemSettings.certPeriod || prev.certPeriod;
        const nextSequence = resolveEffectiveNextSequence(systemSettings.certSequence, prev.formatType, allCertificates, prev.certSequence);
        return {
          ...prev,
          ...systemSettings,
          certPrefix: prefix,
          certPeriod: period,
          certSequence: nextSequence,
          certificateNo: `${prefix}${period}/${nextSequence}`,
        };
      });
    }
  }, [docSettings, allCertificates]);

  // Load header/stamp/signature/footer/watermark images as base64 (needed for html2canvas export)
  useEffect(() => {
    const loadAllCertAssets = async () => {
      const [headerData, stampData, footerData, watermarkData, sigData] = await Promise.all([
        fetchAsBase64(branding.header_image_url||'/assets/header_logo.png', '/assets/header.jpg', '/assets/Expert  - Header.jpg'),
        fetchAsBase64(branding.company_stamp_url||'/assets/company_stamp.png', '/assets/stamp.jpg', '/assets/Stamp 2026.jpg'),
        fetchAsBase64(branding.footer_image_url||'/assets/Footer - Expert (2025).PNG', '/assets/footer.png'),
        fetchAsBase64(branding.watermark_logo_url||'/assets/Watermark Logo.jpg', '/assets/watermark-logo.jpg'),
        fetchAsBase64(branding.authorized_signature_url||'/assets/signature.svg')
      ]);

      let sigPngData = sigData;
      if (sigData && sigData.includes('svg')) {
        try {
          sigPngData = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement('canvas');
              c.width = 400;
              c.height = 150;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, 400, 150);
              resolve(c.toDataURL('image/png'));
            };
            img.onerror = () => resolve(sigData);
            img.src = sigData;
          });
        } catch (e) {}
      }

      setCertBase64Assets({
        header: headerData || '',
        stamp: stampData || '',
        footer: footerData || '',
        watermark: watermarkData || '',
        signature: sigPngData || ''
      });
    };

    loadAllCertAssets();
  }, []);

  // Client details (date/name/address) must be filled before the Equipment section reveals itself —
  // computed here (not after the early returns below) so this hook always runs, per Rules of Hooks.
  const clientDetailsComplete = Boolean(certForm.issueDate && (certForm.customerName || '').trim() && (certForm.address || '').trim());

  useEffect(() => {
    if (clientDetailsComplete && !hasAutoRevealedEquipment.current) {
      hasAutoRevealedEquipment.current = true;
      setTimeout(() => {
        equipmentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
    if (!clientDetailsComplete) {
      hasAutoRevealedEquipment.current = false;
    }
  }, [clientDetailsComplete]);

  if (isPageLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading Certificate Generator...</div>
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

  const density = getCertDensity((certForm.itemsList || []).length);
  // Main details and equipment grid entries are always editable (the page is never locked)
  const contentEditable = true;
  const lockWrapClass = '';

  // AMC Certificate and Visit Report don't revolve around specific fire-extinguisher units either,
  // so they share Training Certificate's minimal, custom-columns-only item design (no standard
  // item name / capacity / qty / date fields, and the whole table hides itself when no custom
  // columns have been configured for that format).
  const NO_EQUIPMENT_TABLE_FORMATS = ['Training Certificate', 'AMC Certificate', 'Visit Report'];
  const isMinimalItemFormat = NO_EQUIPMENT_TABLE_FORMATS.includes(certForm.formatType);
  const hideEquipmentSection = isMinimalItemFormat && (certForm.customColumns || []).length === 0;

  const isSettingsSetupComplete = Boolean(
    (certForm.authorizedSignatory || '').trim() &&
    (certForm.certPrefix || '').trim() &&
    (certForm.certPeriod || '').trim() &&
    (certForm.certSequence || '').trim()
  );

  // readyToFinalize also gates Save/Download/Print/Share (clientDetailsComplete itself is computed
  // above the early returns, since a hook depends on it — see Rules of Hooks).
  const readyToFinalize = clientDetailsComplete && (hideEquipmentSection || (certForm.itemsList || []).length > 0);

  // Shared certificate-persistence + PDF-rendering helpers, used by Save / Download / Print / Share below.
  const saveCertificateRecord = async (extra = {}) => {
    const payload = {
      ...certForm, ...extra,
      Certificate_No: certForm.certificateNo, Customer_Name: certForm.customerName, Address: certForm.address,
      GSTIN: certForm.gstin, Issue_Date: certForm.issueDate, Valid_Until: certForm.validUntil,
      Challan_Date: certForm.challanDate || certForm.issueDate,
      Verification_GUID: certForm.verificationGuid, Revision: certForm.revision || 0,
      Status: certForm.status || 'VERIFIED & COMPLIANT'
    };
    const isExisting = allCertificates.some(c => c.verificationGuid === certForm.verificationGuid || c.Verification_GUID === certForm.verificationGuid);
    const method = isExisting ? 'PUT' : 'POST';
    const url = isExisting ? `/api/certificates/${certForm.verificationGuid}` : '/api/certificates';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('Failed to save certificate');
    const json = await res.json();
    if (json.certificate) {
      setAllCertificates(prev => isExisting
        ? prev.map(x => (x.verificationGuid === certForm.verificationGuid || x.Verification_GUID === certForm.verificationGuid) ? json.certificate : x)
        : [...prev, json.certificate]);
    }
    return { ...json, isExisting };
  };

  const uploadToDriveBackground = async (existingPdf = null) => {
    try {
      let pdfObj = existingPdf;
      if (!pdfObj) {
        const generated = await buildCertificatePdf();
        pdfObj = generated.pdf;
      }
      const pdfBase64 = pdfObj.output('datauristring');
      await fetch('/api/certificates/upload-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pdfBase64, certificateNo: certForm.certificateNo })
      });
    } catch (err) {
      console.error('Background Drive Upload Failed:', err);
    }
  };

  // Bumps the in-memory certificate number to the next unused sequence for the current format —
  // called right after a brand-new certificate is successfully saved/downloaded, so if the user
  // starts another certificate in the same session the number can never collide with the one just
  // issued. Never runs when saving an edit to an already-existing certificate (that would silently
  // change the number of the certificate the user is actively editing).
  const advanceToNextCertNumber = (justSavedCertificate) => {
    const updatedCerts = [...allCertificates.filter(c =>
      (c.verificationGuid || c.Verification_GUID) !== (justSavedCertificate.verificationGuid || justSavedCertificate.Verification_GUID)
    ), justSavedCertificate];
    const latestSeq = getLatestSequenceNumber(updatedCerts, certForm.formatType);
    const nextSeq = latestSeq + 1;
    const prefixLetter = (certForm.certSequence || '').match(/^[A-Za-z]+/)?.[0] || '';
    const nextSequence = `${prefixLetter}${nextSeq}`;
    setCertForm(prev => ({
      ...prev,
      certSequence: nextSequence,
      certificateNo: `${prev.certPrefix || 'Expert/'}${prev.certPeriod || '26-27'}/${nextSequence}`,
      verificationGuid: 'ESS-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      isLocked: false,
      isContentUnlocked: false,
      revision: 0
    }));
  };

  const handleLoadPreviousCertificate = () => {
    if (allCertificates.length === 0) {
      alert("No certificates found in history.");
      return;
    }

    const sortedCerts = [...allCertificates].sort((a, b) => {
      const ta = getRecordCreatedAt(a)?.getTime();
      const tb = getRecordCreatedAt(b)?.getTime();
      if (ta === undefined && tb === undefined) return 0;
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      return tb - ta;
    });

    const currentIndex = sortedCerts.findIndex(c =>
      (c.verificationGuid && c.verificationGuid === certForm.verificationGuid) || 
      (c.Verification_GUID && c.Verification_GUID === certForm.verificationGuid)
    );

    let targetIndex = 0;
    if (currentIndex !== -1) {
      targetIndex = currentIndex + 1;
    }

    if (targetIndex >= sortedCerts.length) {
      alert("You have reached the oldest certificate.");
      return;
    }

    const targetCert = sortedCerts[targetIndex];
    const newCertNo = targetCert.Certificate_No || targetCert.certificateNo || '';
    const newRevision = (targetCert.Revision || targetCert.revision || 0);
    const loadedChallanDate = targetCert.Challan_Date || targetCert.challanDate || targetCert.Issue_Date || targetCert.issueDate || getLocalDateStr();
    const loadedValidUntil = targetCert.Valid_Until || targetCert.validUntil || '';

    setCertForm({
      ...targetCert,
      certificateNo: newCertNo,
      revision: newRevision,
      isLocked: false,
      isContentUnlocked: true,
      customerName: targetCert.Customer_Name || targetCert.customerName || '',
      address: targetCert.Address || targetCert.address || '',
      gstin: targetCert.GSTIN || targetCert.gstin || '',
      contact: targetCert.Contact || targetCert.contact || '',
      authPerson: targetCert.Auth_Person || targetCert.authPerson || '',
      issueDate: targetCert.Issue_Date || targetCert.issueDate || getLocalDateStr(),
      validUntil: loadedValidUntil,
      challanDate: loadedChallanDate,
      verificationGuid: targetCert.Verification_GUID || targetCert.verificationGuid
    });

    setNewItemRefillDate(loadedChallanDate);
    setNewItemNextDate(loadedValidUntil);
    setCertCustomerSearch(targetCert.Customer_Name || targetCert.customerName || '');
    setActiveMobileTab('edit');
    alert(`Loaded Certificate ${newCertNo} (Previous)`);
  };

  const handleLoadNextCertificate = () => {
    if (allCertificates.length === 0) {
      alert("No certificates found in history.");
      return;
    }

    const sortedCerts = [...allCertificates].sort((a, b) => {
      const ta = getRecordCreatedAt(a)?.getTime();
      const tb = getRecordCreatedAt(b)?.getTime();
      if (ta === undefined && tb === undefined) return 0;
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      return tb - ta;
    });

    const currentIndex = sortedCerts.findIndex(c =>
      (c.verificationGuid && c.verificationGuid === certForm.verificationGuid) || 
      (c.Verification_GUID && c.Verification_GUID === certForm.verificationGuid)
    );

    if (currentIndex === -1 || currentIndex === 0) {
      alert("You are already at the newest certificate.");
      return;
    }

    const targetIndex = currentIndex - 1;
    const targetCert = sortedCerts[targetIndex];
    const newCertNo = targetCert.Certificate_No || targetCert.certificateNo || '';
    const newRevision = (targetCert.Revision || targetCert.revision || 0);
    const loadedChallanDate = targetCert.Challan_Date || targetCert.challanDate || targetCert.Issue_Date || targetCert.issueDate || getLocalDateStr();
    const loadedValidUntil = targetCert.Valid_Until || targetCert.validUntil || '';

    setCertForm({
      ...targetCert,
      certificateNo: newCertNo,
      revision: newRevision,
      isLocked: false,
      isContentUnlocked: true,
      customerName: targetCert.Customer_Name || targetCert.customerName || '',
      address: targetCert.Address || targetCert.address || '',
      gstin: targetCert.GSTIN || targetCert.gstin || '',
      contact: targetCert.Contact || targetCert.contact || '',
      authPerson: targetCert.Auth_Person || targetCert.authPerson || '',
      issueDate: targetCert.Issue_Date || targetCert.issueDate || getLocalDateStr(),
      validUntil: loadedValidUntil,
      challanDate: loadedChallanDate,
      verificationGuid: targetCert.Verification_GUID || targetCert.verificationGuid
    });

    setNewItemRefillDate(loadedChallanDate);
    setNewItemNextDate(loadedValidUntil);
    setCertCustomerSearch(targetCert.Customer_Name || targetCert.customerName || '');
    setActiveMobileTab('edit');
    alert(`Loaded Certificate ${newCertNo} (Next)`);
  };

  const handleNewBlankCertificate = async () => {
    let updatedCerts = allCertificates;
    if (readyToFinalize) {
      try {
        setAdminSubmitting('save');
        const result = await saveCertificateRecord();
        uploadToDriveBackground(null);
        if (result.certificate) {
          updatedCerts = [
            ...allCertificates.filter(c =>
              (c.verificationGuid || c.Verification_GUID) !== (result.certificate.verificationGuid || result.certificate.Verification_GUID)
            ),
            result.certificate
          ];
        }
        alert('✅ Previous certificate saved automatically.');
      } catch (err) {
        alert('Failed to auto-save previous certificate: ' + err.message);
        return;
      } finally {
        setAdminSubmitting('');
      }
    }

    const latestSeq = getLatestSequenceNumber(updatedCerts, certForm.formatType);
    const nextSeq = latestSeq + 1;
    const prefixLetter = (certForm.certSequence || '').match(/^[A-Za-z]+/)?.[0] || '';
    const nextSequence = `${prefixLetter}${nextSeq}`;

    setCertForm(prev => ({
      ...prev,
      customerName: '',
      address: '',
      gstin: '',
      contact: '',
      authPerson: '',
      itemsList: [],
      certSequence: nextSequence,
      certificateNo: `${prev.certPrefix || 'Expert/'}${prev.certPeriod || '26-27'}/${nextSequence}`,
      verificationGuid: 'ESS-VER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      isLocked: false,
      isContentUnlocked: false,
      revision: 0
    }));
    setCertCustomerSearch('');
    setNewItemSearch('');
    setActiveMobileTab('edit');
    alert('✨ New blank certificate opened.');
  };

  const generateCertificateCanvas = async () => {
    if (!certPreviewRef.current) throw new Error('Certificate preview container is not ready.');
    const { default: html2canvas } = await import('html2canvas');
    let assets = certBase64Assets;
    if (!assets.header || !assets.stamp || !assets.footer || !assets.watermark) {
      const [h, s, f, w] = await Promise.all([
        fetchAsBase64('/assets/header_logo.png', '/assets/header.jpg', '/assets/Expert  - Header.jpg'),
        fetchAsBase64('/assets/company_stamp.png', '/assets/stamp.jpg', '/assets/Stamp 2026.jpg'),
        fetchAsBase64('/assets/Footer - Expert (2025).PNG', '/assets/footer.png'),
        fetchAsBase64('/assets/Watermark Logo.jpg', '/assets/watermark-logo.jpg')
      ]);
      assets = { ...certBase64Assets, header: h || assets.header, stamp: s || assets.stamp, footer: f || assets.footer, watermark: w || assets.watermark };
      setCertBase64Assets(assets);
      await new Promise(r => setTimeout(r, 300));
    }
    return html2canvas(certPreviewRef.current, {
      scale: 2, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', windowWidth: 1200,
      onclone: async (clonedDoc) => {
        const cw = clonedDoc.getElementById('cert-scale-wrapper');
        if (cw) { cw.style.width = '794px'; cw.style.height = '1123px'; cw.style.overflow = 'visible'; }
        const cr = clonedDoc.getElementById('certificate-print-root');
        if (cr) { cr.style.transform = 'none'; cr.style.width = '794px'; cr.style.height = '1123px'; }
        const imgs = Array.from(clonedDoc.querySelectorAll('img'));
        await Promise.all(imgs.map(async img => {
          img.crossOrigin = 'anonymous';
          if (!img.complete || img.naturalWidth === 0) await new Promise(r => { img.onload = img.onerror = r; const s = img.src; img.src = ''; img.src = s; });
          try { await img.decode(); } catch (e) {}
        }));
        await new Promise(r => setTimeout(r, 200));
      }
    });
  };

  const buildCertificatePdf = async () => {
    const canvas = await generateCertificateCanvas();
    const { jsPDF } = await import('jspdf');
    const imgData = canvas.toDataURL('image/jpeg', 0.98);
    const pdf = new jsPDF('p', 'mm', 'a4'); const pdfW = 210; const pgH = 297;
    const imgH = (canvas.height * pdfW) / canvas.width;
    if (imgH <= pgH + 1) { pdf.addImage(imgData, 'JPEG', 0, 0, pdfW, Math.min(imgH, pgH)); }
    else { let hl = imgH, pos = 0; pdf.addImage(imgData, 'JPEG', 0, pos, pdfW, imgH); hl -= pgH; while (hl > 1) { pos -= pgH; pdf.addPage(); pdf.addImage(imgData, 'JPEG', 0, pos, pdfW, imgH); hl -= pgH; } }
    return { pdf, imgData };
  };

  return (
    <div className="min-h-screen w-full bg-slate-50 flex flex-col">
      {/* Page Header */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6 py-3 shadow-sm gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            🏆 CERTIFICATE
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {task && (
            <div className="text-xs text-slate-700 bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200">
              <span className="font-bold text-slate-900">{task.Customer_Name}</span>
              <span className="text-slate-400 mx-1.5">•</span>
              <span className="text-slate-500">{task.Description}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setFocusMode(prev => !prev)}
            title={focusMode ? 'Exit full-screen data entry' : 'Full-screen data entry — hides the live preview so the form has maximum room'}
            className="hidden lg:flex px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl font-bold text-xs items-center gap-1.5 transition shrink-0"
          >
            {focusMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            <span>{focusMode ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSearchModal(true)}
            className="p-2 bg-amber-50 hover:bg-amber-100 text-amber-700 hover:text-amber-800 rounded-xl transition shrink-0 shadow-2xs border border-amber-200"
            title="Search Issued Certificates"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleBack}
            title="Back to Dashboard"
            aria-label="Back to Dashboard"
            className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl transition shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
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
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 px-4 sm:px-6 py-4 min-h-0 relative">
        {/* LEFT COLUMN */}
        <div className={`${activeMobileTab === 'edit' ? 'flex' : 'hidden'} lg:flex ${focusMode ? 'lg:col-span-12' : 'lg:col-span-6'} flex-col gap-0 min-h-0 pb-36 lg:pb-0`}>



          {/* Format Selector */}
          <div className="bg-amber-50/80 border border-amber-200/80 rounded-t-xl px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2.5 shadow-sm">
            <div className="flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-amber-700 shrink-0" />
              <label className="text-xs font-bold text-amber-950 uppercase tracking-wide shrink-0">Certificate Type:</label>
            </div>
            <select
              value={certForm.formatType || 'Refilling'}
              onChange={e => handleCertFormatChange(e.target.value)}
              className="w-full sm:flex-1 bg-white border border-amber-300/80 text-amber-950 font-bold text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 shadow-sm transition"
            >
              <option value="Refilling" className="bg-white text-slate-900">🧯 Refilling — Fire Extinguisher Refilling &amp; Maintenance</option>
              <option value="HP Testing" className="bg-white text-slate-900">🔬 HP Testing — Hydraulic Pressure Testing Certificate</option>
              <option value="New Fire Extinguisher" className="bg-white text-slate-900">✨ New FE — Supply &amp; Inspection Certificate</option>
              <option value="System Installation" className="bg-white text-slate-900">🏢 System — Hydrant / Alarm Commissioning</option>
              <option value="AMC Certificate" className="bg-white text-slate-900">📋 AMC — Annual Maintenance Contract</option>
              <option value="Visit Report" className="bg-white text-slate-900">📝 Visit Report — Field Safety Inspection</option>
              <option value="Training Certificate" className="bg-white text-slate-900">🎓 Training Certificate — Practical Operations Training</option>
            </select>
          </div>

          {/* Tab Bar — Client + Equipment merged into one guided flow; Settings stays separate */}
          <div className="flex items-center justify-between border-b border-slate-200 bg-white">
            <button type="button" onClick={() => setCertTab('client')}
              className={`flex-1 py-2 px-3 text-[11px] font-bold border-b-2 transition-colors flex items-center justify-between ${certTab==='client' ? 'border-amber-600 text-amber-800 bg-amber-50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
              <span>📋 Certificate Details {clientDetailsComplete ? '✅' : ''}</span>
              {certForm.certificateNo && (
                <span className={`text-[10px] font-black px-2 py-0.5 rounded border transition-colors shrink-0 ${
                  certTab === 'client' 
                    ? 'text-amber-900 bg-amber-100/80 border-amber-200' 
                    : 'text-slate-600 bg-slate-100 border-slate-205'
                }`}>
                  No: {certForm.certificateNo}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setCertTab('settings')}
              title="Certificate Settings"
              className={`p-2 border-l border-b-2 border-slate-200 transition-colors shrink-0 flex items-center justify-center ${certTab === 'settings' ? 'bg-amber-50 border-b-amber-600 text-amber-800' : 'border-b-transparent text-slate-500 hover:text-amber-700 hover:bg-slate-50'}`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto bg-white border border-slate-200 rounded-b-xl">

            {/* TAB: CLIENT */}
            {certTab === 'client' && (
              <div className="p-3 space-y-3">
                <div className="space-y-3">
                {/* 1. Certificate Date & Validity Quick Selector */}
                <div className="space-y-2 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide">Certificate Date *</label>
                      <input
                        type="date"
                        value={certForm.issueDate || ''}
                        max={getLocalDateStr()}
                        onChange={e => {
                          let issueDt = e.target.value;
                          const today = getLocalDateStr();
                          if (issueDt > today) {
                            alert("Certificate Date cannot be in the future.");
                            issueDt = today;
                          }
                          const years = certForm.validityDuration === '5 Years' ? 5 : certForm.validityDuration === '3 Years' ? 3 : 1;
                          setCertForm(prev => {
                            const nextChallanDate = prev.challanDate > issueDt ? issueDt : prev.challanDate;
                            const nextDt = new Date(new Date(nextChallanDate).setFullYear(new Date(nextChallanDate).getFullYear() + years)).toISOString().split('T')[0];
                            return {
                              ...prev,
                              issueDate: issueDt,
                              challanDate: nextChallanDate,
                              validUntil: certForm.validityDuration === 'Custom' ? prev.validUntil : nextDt,
                              itemsList: (prev.itemsList || []).map(item => {
                                const itemRefill = item.refillingDate > issueDt ? issueDt : item.refillingDate;
                                const itemDue = new Date(new Date(itemRefill).setFullYear(new Date(itemRefill).getFullYear() + years)).toISOString().split('T')[0];
                                return {
                                  ...item,
                                  refillingDate: itemRefill,
                                  nextDate: certForm.validityDuration === 'Custom' ? item.nextDate : itemDue
                                };
                              })
                            };
                          });
                          const nextCappedChallan = certForm.challanDate > issueDt ? issueDt : certForm.challanDate;
                          setNewItemRefillDate(nextCappedChallan);
                          if (certForm.validityDuration !== 'Custom') {
                            const nextCappedDue = new Date(new Date(nextCappedChallan).setFullYear(new Date(nextCappedChallan).getFullYear() + years)).toISOString().split('T')[0];
                            setNewItemNextDate(nextCappedDue);
                          }
                        }}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-bold text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none shadow-2xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wide">Challan Date (Refill) *</label>
                      <input
                        type="date"
                        value={certForm.challanDate || ''}
                        max={certForm.issueDate || ''}
                        onChange={e => {
                          const selectedDate = e.target.value;
                          const issueDt = certForm.issueDate;
                          const years = certForm.validityDuration === '5 Years' ? 5 : certForm.validityDuration === '3 Years' ? 3 : 1;
                          const targetDate = (issueDt && selectedDate > issueDt) ? issueDt : selectedDate;
                          if (issueDt && selectedDate > issueDt) {
                            alert("Challan Date cannot exceed Certificate Date.");
                          }
                          const nextDt = new Date(new Date(targetDate).setFullYear(new Date(targetDate).getFullYear() + years)).toISOString().split('T')[0];
                          setCertForm(prev => ({
                            ...prev,
                            challanDate: targetDate,
                            validUntil: prev.validityDuration === 'Custom' ? prev.validUntil : nextDt,
                            itemsList: (prev.itemsList || []).map(item => ({
                              ...item,
                              refillingDate: targetDate,
                              nextDate: prev.validityDuration === 'Custom' ? item.nextDate : nextDt
                            }))
                          }));
                          setNewItemRefillDate(targetDate);
                          if (certForm.validityDuration !== 'Custom') {
                            setNewItemNextDate(nextDt);
                          }
                        }}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-bold text-amber-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none shadow-2xs"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. Company Name */}
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Company Name *</label>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      placeholder={`Type or select company name... (${customers.length} clients)`}
                      value={certCustomerSearch || certForm.customerName}
                      onChange={e => {
                        const val = e.target.value;
                        setCertCustomerSearch(val);
                        setCertForm(prev => ({ ...prev, customerName: val }));
                        setShowCertCustDropdown(true);
                      }}
                      onFocus={() => setShowCertCustDropdown(true)}
                      onBlur={() => setTimeout(() => setShowCertCustDropdown(false), 180)}
                      className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-300 rounded-lg font-bold text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:border-amber-500 focus:outline-none focus:bg-white transition"
                    />
                    {showCertCustDropdown && (
                      <div className="absolute z-50 left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-white border border-amber-400 rounded-xl shadow-2xl divide-y divide-slate-100">
                        {customers
                          .filter(c => !certCustomerSearch.trim() || (c.Company_Name||c.Customer_Name||'').toLowerCase().includes(certCustomerSearch.toLowerCase()) || (c.Address||'').toLowerCase().includes(certCustomerSearch.toLowerCase()))
                          .slice(0, 50).map(c => (
                          <div key={c.Customer_ID}
                            onMouseDown={() => {
                              const compName = c.Company_Name || c.Customer_Name || '';
                              const addr = c.Address || c.Location || '';
                              const gst = c.GSTIN || c.Gst_No || c.GST || '';
                              const contact = c.Contact || c.Phone || c.Mobile || c.Contact_Number || '';
                              const authPerson = c.Auth_Person || '';
                              setCertForm(prev => ({ 
                                ...prev, 
                                customerName: compName, 
                                address: addr, 
                                gstin: gst,
                                contact: contact,
                                authPerson: authPerson
                              }));
                              setCertCustomerSearch(compName);
                              setShowCertCustDropdown(false);
                            }}
                            className="flex items-center justify-between px-3 py-2 hover:bg-amber-50 cursor-pointer transition">
                            <div>
                              <div className="font-bold text-slate-900 text-xs">{c.Company_Name||c.Customer_Name}</div>
                              <div className="text-[10px] text-slate-400 truncate max-w-xs">{c.Address||'—'}</div>
                            </div>
                            <span className="text-[9px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold ml-2 shrink-0">SELECT</span>
                          </div>
                        ))}
                        {customers.filter(c => !certCustomerSearch.trim() || (c.Company_Name||c.Customer_Name||'').toLowerCase().includes(certCustomerSearch.toLowerCase())||(c.Address||'').toLowerCase().includes(certCustomerSearch.toLowerCase())).length === 0 && (
                          <div className="px-3 py-3 text-xs text-slate-400 text-center">No match — type company name manually</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 3. Address */}
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Client Address *</label>
                  <input
                    type="text"
                    placeholder="Full client address..."
                    value={certForm.address}
                    onChange={e => setCertForm(prev => ({ ...prev, address: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-medium text-slate-800 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"
                  />
                </div>

                {/* 4. Certificate No */}
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Certificate No *</label>
                  <input
                    type="text"
                    value={certForm.certificateNo}
                    readOnly
                    tabIndex={-1}
                    title="Certificate No is generated by default and cannot be edited"
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-300 rounded-lg font-bold text-slate-600 text-xs cursor-not-allowed select-none focus:outline-none"
                  />
                </div>
                </div>

                {/* Equipment section */}
                {!hideEquipmentSection && (
                  <div ref={equipmentSectionRef} className="pt-1 scroll-mt-3">
                    <div className={`space-y-3 ${lockWrapClass}`}>



                {/* Add Item Row */}
                {(() => {
                  const masterListToUse = equipmentMasterList.length > 0 ? equipmentMasterList : DEFAULT_MASTER_ITEMS;
                  const selectedMaster = findMatchingMasterItem(masterListToUse, newItemSelectedMasterId, newItemSearch);

                  let availableCaps = selectedMaster?.capacities || [];
                  if (availableCaps.length === 0 && newItemSearch.trim()) {
                    const sLow = newItemSearch.toLowerCase();
                    if (sLow.includes('co2') || sLow.includes('carbon') || sLow.includes('carbod')) {
                      availableCaps = ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'];
                    } else if (sLow.includes('foam') || sLow.includes('water')) {
                      availableCaps = ['6 Ltr', '9 Ltr', '50 Ltr'];
                    } else {
                      availableCaps = ['1 Kg', '2 Kg', '4 Kg', '6 Kg', '9 Kg'];
                    }
                  }

                  const currentDisplayName = newItemSearch.trim() || selectedMaster?.type || selectedMaster?.itemName || 'Equipment';

                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-2.5 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-bold text-amber-900 uppercase tracking-wide">Add Equipment Row to Certificate</div>
                      </div>

                      {!isMinimalItemFormat && (
                        <div className="space-y-1 relative">
                          <div className="flex items-center justify-between">
                            <label className="block text-[10px] font-bold text-slate-600">Item Name *</label>
                          </div>
                          <div className="relative">
                            <input
                              type="text"
                              placeholder="Type or tap to search item name…"
                              value={newItemSearch}
                              onChange={e => {
                                const val = e.target.value;
                                setNewItemSearch(val);
                                setShowNewItemDropdown(true);
                                const match = findMatchingMasterItem(masterListToUse, '', val);
                                if (match) {
                                  setNewItemSelectedMasterId(match.id);
                                  const matchCaps = match.capacities || [];
                                  if (matchCaps.length > 0 && !matchCaps.includes(newItemCapacity)) {
                                    setNewItemCapacity(matchCaps[0]);
                                  }
                                } else {
                                  setNewItemSelectedMasterId('');
                                }
                              }}
                              onFocus={() => setShowNewItemDropdown(true)}
                              onBlur={() => setTimeout(() => setShowNewItemDropdown(false), 180)}
                              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none focus:ring-1 focus:ring-amber-500 shadow-2xs"
                            />
                            {showNewItemDropdown && (
                              <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-amber-400 rounded-xl shadow-2xl divide-y divide-slate-100">
                                {masterListToUse
                                  .filter(eq => !newItemSearch.trim() || (eq.type || eq.itemName || '').toLowerCase().includes(newItemSearch.toLowerCase()))
                                  .map(eq => {
                                    const name = eq.type || eq.itemName || '';
                                    const caps = (eq.capacities || []).join(', ');
                                    return (
                                      <div
                                        key={eq.id}
                                        onMouseDown={() => {
                                          setNewItemSearch(name);
                                          setNewItemSelectedMasterId(eq.id);
                                          if ((eq.capacities || []).length > 0) {
                                            setNewItemCapacity(eq.capacities[0]);
                                          }
                                          setShowNewItemDropdown(false);
                                        }}
                                        className="flex items-center justify-between px-3 py-2 hover:bg-amber-50 cursor-pointer transition"
                                      >
                                        <div>
                                          <div className="font-bold text-slate-900 text-xs">{name}</div>
                                          <div className="text-[10px] text-amber-800 font-semibold truncate max-w-xs">
                                            {caps ? `Available: ${caps}` : 'Standard Equipment'}
                                          </div>
                                        </div>
                                        <span className="text-[9px] bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded font-bold ml-2 shrink-0">SELECT</span>
                                      </div>
                                    );
                                  })}
                                {masterListToUse.filter(eq => !newItemSearch.trim() || (eq.type || eq.itemName || '').toLowerCase().includes(newItemSearch.toLowerCase())).length === 0 && (
                                  <div className="px-3 py-3 text-xs text-slate-400 text-center">No matching item found — custom name allowed</div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {!isMinimalItemFormat && (
                        <>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="block text-[10px] font-bold text-slate-600">Capacity / Size *</label>
                              {availableCaps.length > 0 ? (
                                <select
                                  value={newItemCapacity || availableCaps[0]}
                                  onChange={e => setNewItemCapacity(e.target.value)}
                                  className="w-full px-2.5 py-1.5 bg-white border border-amber-400 rounded-lg text-xs font-bold text-amber-950 focus:outline-none shadow-2xs"
                                >
                                  {availableCaps.map(cap => (
                                    <option key={cap} value={cap}>
                                      {cap}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={newItemCapacity}
                                  onChange={e => setNewItemCapacity(e.target.value)}
                                  placeholder="e.g. 4.5 Kg"
                                  className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold focus:outline-none"
                                />
                              )}
                            </div>
                            <div className="space-y-1">
                              <label className="block text-[10px] font-bold text-slate-600">Qty *</label>
                              <input
                                type="text"
                                value={newItemQty}
                                onChange={e => setNewItemQty(e.target.value)}
                                placeholder="e.g. 5"
                                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold focus:outline-none"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <label className="block text-[10px] font-bold text-slate-600">{certForm.formatType === 'HP Testing' ? 'Date of Testing' : 'Date of Refilling'}</label>
                              <input type="date" value={newItemRefillDate} max={certForm.challanDate || ''} onChange={e => {
                                let refillDt = e.target.value;
                                const maxLimit = certForm.challanDate || getLocalDateStr();
                                if (refillDt > maxLimit) {
                                  alert(certForm.formatType === 'HP Testing' ? "Item testing date cannot exceed Challan Date." : "Item refilling date cannot exceed Challan Date.");
                                  refillDt = maxLimit;
                                }
                                setNewItemRefillDate(refillDt);
                                if (certForm.validityDuration !== 'Custom') {
                                  setNewItemNextDate(calculateNextDate(refillDt));
                                }
                              }}
                                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none"/>
                            </div>
                            <div className="space-y-1">
                              <label className="block text-[10px] font-bold text-slate-600">{certForm.formatType === 'HP Testing' ? 'Next Date of Testing' : 'Next Date of Refilling'}</label>
                              <input type="date" value={newItemNextDate} onChange={e => setNewItemNextDate(e.target.value)}
                                className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-rose-700 font-bold focus:outline-none"/>
                            </div>
                          </div>
                        </>
                      )}
                      {(certForm.customColumns||[]).length > 0 && (
                        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-amber-200">
                          {(certForm.customColumns||[]).map(col => (
                            <div key={col.id} className="space-y-1">
                              <label className="block text-[10px] font-bold text-indigo-700">{col.label}</label>
                              <input type="text" placeholder={col.label} value={newItemCustomValues[col.id]||''}
                                onChange={e => setNewItemCustomValues(prev => ({...prev, [col.id]: e.target.value}))}
                                className="w-full px-2 py-1.5 bg-indigo-50 border border-indigo-300 rounded-lg text-xs font-bold focus:outline-none"/>
                            </div>
                          ))}
                        </div>
                      )}
                      <button type="button" onClick={() => {
                        const isTraining = isMinimalItemFormat;
                        if (!isTraining && !newItemSearch.trim()) { alert('Please enter or select an Item Name.'); return; }
                        if (isTraining) {
                          const hasValue = Object.values(newItemCustomValues).some(v => v && v.trim());
                          if (!hasValue) { alert('Please fill in at least one custom field.'); return; }
                        }
                        const finalCapacity = isTraining ? '—' : (newItemCapacity || (availableCaps.length > 0 ? availableCaps[0] : ''));
                        if (!isTraining && (!finalCapacity || !finalCapacity.trim())) { alert('Please select or enter the Capacity / Size.'); return; }
                        const currentList = certForm.itemsList || [];
                        const newItem = {
                          id: 'item-'+Date.now(), srNo: currentList.length+1,
                          itemName: isTraining ? '' : newItemSearch.trim(), capacity: finalCapacity.trim(),
                          qty: isTraining ? '1 Nos.' : formatQtyNos(newItemQty),
                          refillingDate: isTraining ? certForm.challanDate : (newItemRefillDate||certForm.challanDate),
                          nextDate: isTraining ? certForm.validUntil : (newItemNextDate||certForm.validUntil),
                          customValues: {...newItemCustomValues}
                        };
                        setCertForm(prev => ({...prev, itemsList: [...(prev.itemsList||[]), newItem]}));
                        setNewItemCustomValues({});
                        if (isTraining) {
                          setNewItemSearch('');
                        }
                      }} className="w-full py-2 bg-amber-700 hover:bg-amber-800 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition shadow-xs">
                        <PlusCircle className="w-3.5 h-3.5"/>+ Add Item to Certificate Table
                      </button>
                    </div>
                  );
                })()}

                {/* Items List — inline editable */}
                {(certForm.itemsList||[]).length > 0 && (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <div className="bg-slate-50 px-3 py-1.5 text-[10px] font-bold text-slate-600 uppercase tracking-wide border-b border-slate-200">
                      Certificate Items — {(certForm.itemsList||[]).length} row(s)
                    </div>
                    <div className="divide-y divide-slate-100 max-h-44 overflow-y-auto">
                      {(certForm.itemsList||[]).map((it, idx) => (
                        <div key={it.id||idx} className="flex items-start justify-between px-3 py-2 hover:bg-slate-50 gap-2">
                          <div className="flex items-start gap-2 flex-1 min-w-0">
                            <span className="mt-0.5 w-5 h-5 bg-amber-100 text-amber-900 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0">{idx+1}</span>
                            <div className="min-w-0 flex-1">
                              {isMinimalItemFormat ? (
                                <div className="grid grid-cols-2 gap-2 mt-1">
                                  {(certForm.customColumns || []).map(col => (
                                    <div key={col.id} className="flex flex-col">
                                      <span className="text-[9px] font-extrabold text-indigo-800 uppercase tracking-wide">{col.label}</span>
                                      <input
                                        type="text"
                                        value={it.customValues?.[col.id] || ''}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setCertForm(prev => ({
                                            ...prev,
                                            itemsList: prev.itemsList.map((item, i) =>
                                              i === idx
                                                ? { ...item, customValues: { ...(item.customValues || {}), [col.id]: val } }
                                                : item
                                            )
                                          }));
                                        }}
                                        className="w-full bg-transparent border-b border-indigo-200 hover:border-indigo-400 focus:border-indigo-500 focus:outline-none text-xs font-bold text-slate-800 py-0.5"
                                        placeholder={col.label}
                                      />
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <>
                                  <input type="text" value={it.itemName}
                                    onChange={e => setCertForm(prev => ({...prev, itemsList: prev.itemsList.map((item,i) => i===idx ? {...item, itemName:e.target.value} : item)}))}
                                    className="w-full font-bold text-slate-900 text-xs bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none py-0.5 mb-0.5"/>
                                  <div className="flex gap-2 flex-wrap text-[10px] text-slate-500">
                                    {!isMinimalItemFormat && (
                                      <>
                                        <span>Cap:
                                          <input type="text" value={it.capacity}
                                            onChange={e => setCertForm(prev => ({...prev, itemsList: prev.itemsList.map((item,i) => i===idx ? {...item, capacity:e.target.value} : item)}))}
                                            className="ml-1 w-14 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px] font-bold text-slate-700"/>
                                        </span>
                                        <span>Qty:
                                          <input type="text" value={it.qty || it.quantity || it.identificationNo || '1 Nos.'}
                                            onChange={e => setCertForm(prev => ({...prev, itemsList: prev.itemsList.map((item,i) => i===idx ? {...item, qty: e.target.value} : item)}))}
                                            onBlur={e => setCertForm(prev => ({...prev, itemsList: prev.itemsList.map((item,i) => i===idx ? {...item, qty: formatQtyNos(e.target.value)} : item)}))}
                                            className="ml-1 w-16 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px] font-bold text-slate-700"/>
                                        </span>
                                      </>
                                    )}
                                    {(certForm.customColumns || []).map(col => (
                                      <span key={col.id}>
                                        {col.label}:
                                        <input
                                          type="text"
                                          value={it.customValues?.[col.id] || ''}
                                          onChange={e => {
                                            const val = e.target.value;
                                            setCertForm(prev => ({
                                              ...prev,
                                              itemsList: prev.itemsList.map((item, i) =>
                                                i === idx
                                                  ? { ...item, customValues: { ...(item.customValues || {}), [col.id]: val } }
                                                  : item
                                              )
                                            }));
                                          }}
                                          className="ml-1 w-16 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-[10px] font-bold text-indigo-850"
                                          placeholder={col.label}
                                        />
                                      </span>
                                    ))}
                                    {!isMinimalItemFormat && (
                                      <>
                                        <span>{certForm.formatType === 'HP Testing' ? 'Testing' : 'Refilling'}:
                                          <input type="date" value={it.refillingDate} max={certForm.challanDate || ''}
                                            onChange={e => {
                                              let refillDt = e.target.value;
                                              const maxLimit = certForm.challanDate || getLocalDateStr();
                                              if (refillDt > maxLimit) {
                                                alert(certForm.formatType === 'HP Testing' ? "Item testing date cannot exceed Challan Date." : "Item refilling date cannot exceed Challan Date.");
                                                refillDt = maxLimit;
                                              }
                                              const years = certForm.validityDuration === '5 Years' ? 5 : certForm.validityDuration === '3 Years' ? 3 : 1;
                                              const itemDue = new Date(new Date(refillDt).setFullYear(new Date(refillDt).getFullYear() + years)).toISOString().split('T')[0];
                                              setCertForm(prev => ({
                                                ...prev,
                                                itemsList: prev.itemsList.map((item, i) =>
                                                  i === idx
                                                    ? {
                                                        ...item,
                                                        refillingDate: refillDt,
                                                        nextDate: prev.validityDuration === 'Custom' ? item.nextDate : itemDue
                                                      }
                                                    : item
                                                )
                                              }));
                                            }}
                                            className="ml-1 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px] font-bold text-slate-700"/>
                                        </span>
                                        <span className="text-rose-600">{certForm.formatType === 'HP Testing' ? 'Next Testing' : 'Next Refilling'}:
                                          <input type="date" value={it.nextDate}
                                            onChange={e => setCertForm(prev => ({...prev, itemsList: prev.itemsList.map((item,i) => i===idx ? {...item, nextDate:e.target.value} : item)}))}
                                            className="ml-1 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-500 focus:outline-none text-[10px] font-bold text-rose-700"/>
                                        </span>
                                      </>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                          <button type="button"
                            onClick={() => setCertForm(prev => ({...prev, itemsList: (prev.itemsList||[]).filter((_,i)=>i!==idx).map((item,i)=>({...item,srNo:i+1}))}))}
                            className="text-slate-300 hover:text-rose-500 p-1 mt-0.5 shrink-0 transition"><X className="w-3.5 h-3.5"/></button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}


                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB: SETTINGS */}
            {certTab === 'settings' && (
              <div className="p-3 space-y-3">
                {/* Settings locked banner */}
                {certForm.isSettingsLocked && (
                  <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg text-[11px] font-bold text-amber-800 flex items-center gap-2">
                    🔒 Settings are locked. Click <strong>Unlock Settings</strong> below to make changes.
                  </div>
                )}

                <div className={`space-y-2 ${certForm.isSettingsLocked ? 'opacity-50 pointer-events-none select-none' : ''}`}>
                {(() => {
                const certSectionBlocks = {};

                // Item Master Manager — a management tool, never printed on the certificate
                certSectionBlocks.itemMaster = (
                  <div>
                    <button type="button"
                      onClick={() => { setShowItemMasterPanel(p => !p); setImEditId(null); setImName(''); setImVariants(''); }}
                      className="w-full flex items-center justify-between px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl hover:bg-indigo-100 transition">
                      <span className="font-bold text-indigo-800 text-[11px]">📦 Manage Item Master &amp; Variants ({equipmentMasterList.length} items)</span>
                      <span className="text-indigo-600 font-bold text-xs">{showItemMasterPanel ? '▲ Hide' : '▼ Manage'}</span>
                    </button>
                    {showItemMasterPanel && (
                      <div className="mt-2 border border-indigo-200 rounded-xl overflow-hidden">
                        <div className="max-h-36 overflow-y-auto divide-y divide-slate-100 bg-white">
                          {equipmentMasterList.map(eq => (
                            <div key={eq.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-50 text-[11px]">
                              <div className="flex-1 min-w-0">
                                <div className="font-bold text-slate-900 truncate">{eq.type||eq.itemName}</div>
                                <div className="text-[10px] text-slate-400 truncate">{(eq.capacities||[]).join(', ')}</div>
                              </div>
                              <div className="flex gap-1 shrink-0 ml-2">
                                <button type="button"
                                  onClick={() => { setImEditId(eq.id); setImName(eq.type||eq.itemName||''); setImVariants((eq.capacities||[]).join(', ')); }}
                                  className="px-2 py-0.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-800 rounded text-[10px] font-bold">Edit</button>
                                <button type="button"
                                  onClick={async () => {
                                    if (!window.confirm(`Delete "${eq.type||eq.itemName}"?`)) return;
                                    try {
                                      const r = await fetch(`/api/equipment-master/${eq.id}`, {method:'DELETE', headers:{Authorization:`Bearer ${token}`}});
                                      if (!r.ok) throw new Error('Delete request failed');
                                      setEquipmentMasterList(prev => prev.filter(x => x.id !== eq.id));
                                    } catch (e) { alert('Delete failed: ' + e.message); }
                                  }}
                                  className="px-2 py-0.5 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded text-[10px] font-bold">Del</button>
                              </div>
                            </div>
                          ))}
                          {equipmentMasterList.length === 0 && <div className="px-3 py-4 text-xs text-slate-400 text-center">No items yet</div>}
                        </div>
                        <div className="bg-indigo-50 border-t border-indigo-200 p-2.5 space-y-2">
                          <div className="text-[10px] font-bold text-indigo-700 uppercase">{imEditId ? 'Edit Item' : 'Add New Item'}</div>
                          <input type="text" placeholder="Item Name (e.g. DCP ABC Type Fire Extinguisher)" value={imName} onChange={e => setImName(e.target.value)}
                            className="w-full px-2.5 py-1.5 bg-white border border-indigo-300 rounded-lg text-xs font-medium focus:outline-none"/>
                          <input type="text" placeholder="Variants comma-separated (e.g. 1 Kg, 2 Kg, 4 Kg, 6 Kg, 9 Kg)" value={imVariants} onChange={e => setImVariants(e.target.value)}
                            className="w-full px-2.5 py-1.5 bg-white border border-indigo-300 rounded-lg text-xs font-medium focus:outline-none"/>
                          <div className="flex gap-2">
                            <button type="button" disabled={imSaving || !imName.trim()} onClick={async () => {
                              if (!imName.trim()) return;
                              setImSaving(true);
                              try {
                                const variantArr = imVariants.split(',').map(v => v.trim()).filter(Boolean);
                                if (imEditId) {
                                  const r = await fetch(`/api/equipment-master/${imEditId}`, {method:'PUT', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify({name:imName.trim(), variants:variantArr})});
                                  const data = await r.json();
                                  if (data.success) setEquipmentMasterList(prev => prev.map(x => x.id === imEditId ? {...x, type:imName.trim(), capacities:variantArr} : x));
                                } else {
                                  const r = await fetch('/api/equipment-master', {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}, body:JSON.stringify({name:imName.trim(), variants:variantArr})});
                                  const data = await r.json();
                                  if (data.success) setEquipmentMasterList(prev => [...prev, data.item]);
                                }
                                setImEditId(null); setImName(''); setImVariants('');
                              } catch(e) { alert('Save failed: ' + e.message); }
                              setImSaving(false);
                            }} className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold">
                              {imSaving ? 'Saving…' : imEditId ? '✔ Update' : '+ Add Item'}
                            </button>
                            {imEditId && (
                              <button type="button" onClick={() => { setImEditId(null); setImName(''); setImVariants(''); }}
                                className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-[11px] font-bold">Cancel</button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );

                // Certificate body text — custom intro per cert type
                certSectionBlocks.bodyIntro = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Certificate Body Text (Custom Intro)</label>
                  <CustomLinesEditor
                    lines={certForm.bodyIntroLines}
                    onChange={(next) => setCertForm(prev => ({ ...prev, bodyIntroLines: next }))}
                    placeholder="Leave blank for standard compliance text, or enter custom intro paragraph…"
                    accent="amber"
                  />
                </div>
                );

                certSectionBlocks.customCertify = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Custom Lines (shown below the certify statement)</label>
                  <CustomLinesEditor
                    lines={certForm.customCertifyLines}
                    onChange={(next) => setCertForm(prev => ({ ...prev, customCertifyLines: next }))}
                    placeholder="Optional — extra line printed right under 'This is to certify...'. Leave blank to hide."
                    accent="amber"
                  />
                </div>
                );

                // Custom Notes (shown after equipment list)
                certSectionBlocks.equipmentNotes = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Custom Notes (shown after equipment list)</label>
                  <CustomLinesEditor
                    lines={certForm.customEquipmentNotes}
                    onChange={(next) => setCertForm(prev => ({ ...prev, customEquipmentNotes: next }))}
                    placeholder="Optional — e.g. site-specific remark to print right below the equipment schedule table. Leave blank to hide."
                    accent="indigo"
                  />
                </div>
                );

                certSectionBlocks.formatSpecific = (
                <>
                {certForm.formatType === 'HP Testing' && (
                  <div className="grid grid-cols-2 gap-2 bg-blue-50 border border-blue-200 rounded-xl p-2.5">
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-blue-700 uppercase">Test Pressure</label><input type="text" value={certForm.hpTestPressure||''} onChange={e=>setCertForm(prev=>({...prev,hpTestPressure:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-blue-300 rounded-lg text-xs font-bold focus:outline-none" placeholder="e.g. 35 kg/cm²"/></div>
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-blue-700 uppercase">Test Result</label><input type="text" value={certForm.hpTestResult||''} onChange={e=>setCertForm(prev=>({...prev,hpTestResult:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-blue-300 rounded-lg text-xs font-bold text-emerald-700 focus:outline-none"/></div>
                  </div>
                )}
                {certForm.formatType === 'New Fire Extinguisher' && (
                  <div className="grid grid-cols-2 gap-2 bg-emerald-50 border border-emerald-200 rounded-xl p-2.5">
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-emerald-700 uppercase">ISI Mark / Std No.</label><input type="text" value={certForm.isiMarkNumber||''} onChange={e=>setCertForm(prev=>({...prev,isiMarkNumber:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-emerald-300 rounded-lg text-xs font-bold focus:outline-none"/></div>
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-emerald-700 uppercase">Warranty Period</label><input type="text" value={certForm.newExtinguisherWarranty||''} onChange={e=>setCertForm(prev=>({...prev,newExtinguisherWarranty:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-emerald-300 rounded-lg text-xs font-bold focus:outline-none"/></div>
                  </div>
                )}
                {certForm.formatType === 'System Installation' && (
                  <div className="grid grid-cols-2 gap-2 bg-violet-50 border border-violet-200 rounded-xl p-2.5">
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-violet-700 uppercase">System Type</label><input type="text" value={certForm.systemInstallationType||''} onChange={e=>setCertForm(prev=>({...prev,systemInstallationType:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-violet-300 rounded-lg text-xs font-bold focus:outline-none"/></div>
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-violet-700 uppercase">System Status</label><input type="text" value={certForm.systemStatus||''} onChange={e=>setCertForm(prev=>({...prev,systemStatus:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-violet-300 rounded-lg text-xs font-bold text-emerald-700 focus:outline-none"/></div>
                  </div>
                )}
                {certForm.formatType === 'AMC Certificate' && (
                  <div className="grid grid-cols-2 gap-2 bg-orange-50 border border-orange-200 rounded-xl p-2.5">
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-orange-700 uppercase">AMC Period</label><input type="text" value={certForm.amcPeriod||''} onChange={e=>setCertForm(prev=>({...prev,amcPeriod:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-orange-300 rounded-lg text-xs font-bold focus:outline-none"/></div>
                    <div className="space-y-1"><label className="block text-[10px] font-bold text-orange-700 uppercase">Inspection Frequency</label><input type="text" value={certForm.amcFrequency||''} onChange={e=>setCertForm(prev=>({...prev,amcFrequency:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-orange-300 rounded-lg text-xs font-bold focus:outline-none"/></div>
                  </div>
                )}
                {certForm.formatType === 'Visit Report' && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 space-y-1">
                    <label className="block text-[10px] font-bold text-slate-600 uppercase">Field Observations &amp; Recommendations</label>
                    <textarea rows={3} value={certForm.visitObservations||''} onChange={e=>setCertForm(prev=>({...prev,visitObservations:e.target.value}))} className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none resize-none"/>
                  </div>
                )}
                </>
                );

                certSectionBlocks.title = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Certificate Title</label>
                  <input
                    type="text"
                    value={certForm.title || ''}
                    onChange={e => setCertForm(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-slate-350 rounded-lg font-bold text-slate-800 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    placeholder="Enter Certificate Title (e.g. HYDRAULIC PRESSURE TESTING CERTIFICATE)"
                  />
                </div>
                );

                certSectionBlocks.statusBadge = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Compliance Status Badge</label>
                  <input type="text" value={certForm.status||'VERIFIED & COMPLIANT'} onChange={e => setCertForm(prev=>({...prev,status:e.target.value}))}
                    className="w-full px-3 py-2 bg-emerald-50 border border-emerald-300 rounded-lg font-bold text-emerald-800 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"/>
                </div>
                );

                // Certificate Number Builder settings
                certSectionBlocks.certNo = (
                <div className="bg-amber-50/50 border border-amber-250 rounded-xl p-2.5 space-y-2">
                  <div className="text-[10px] font-bold text-amber-900 uppercase tracking-wide flex items-center gap-1">
                    <span>⚙️ Certificate No Structure</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="block text-[9px] font-bold text-slate-500 uppercase">Prefix</label>
                      <input
                        type="text"
                        value={certForm.certPrefix || 'Expert/'}
                        onChange={e => handleUpdateCertNoFields({ certPrefix: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-xs font-bold text-slate-800 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[9px] font-bold text-slate-500 uppercase">Period (FY)</label>
                      <input
                        type="text"
                        value={certForm.certPeriod || '26-27'}
                        onChange={e => handleUpdateCertNoFields({ certPeriod: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-xs font-bold text-slate-800 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[9px] font-bold text-slate-500 uppercase">Seq / Suffix</label>
                      <input
                        type="text"
                        value={certForm.certSequence || 'R310'}
                        onChange={e => handleUpdateCertNoFields({ certSequence: e.target.value })}
                        className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-xs font-bold text-slate-800 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div className="text-[9px] text-slate-400 font-bold">
                    Resulting Cert No: <strong className="text-amber-900">{certForm.certificateNo}</strong>
                  </div>
                </div>
                );

                // Custom Columns Setup
                certSectionBlocks.customColumns = (
                <div className="bg-indigo-50/50 border border-indigo-200 rounded-xl p-2.5 space-y-2">
                  <div className="text-[10px] font-bold text-indigo-900 uppercase tracking-wide flex items-center gap-1">
                    <span>📊 Custom Table Columns</span>
                  </div>
                  
                  {/* List of existing custom columns */}
                  {(certForm.customColumns || []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1 bg-white border border-slate-100 rounded-lg">
                      {(certForm.customColumns || []).map(col => (
                        <div key={col.id} className="flex items-center gap-1 bg-indigo-50 border border-indigo-200 px-2 py-1 rounded text-xs font-bold text-indigo-950">
                          <span>{col.label}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setCertForm(prev => ({
                                ...prev,
                                customColumns: prev.customColumns.filter(c => c.id !== col.id),
                                // Also clean up the values from all items
                                itemsList: (prev.itemsList || []).map(item => {
                                  const nextVals = { ...(item.customValues || {}) };
                                  delete nextVals[col.id];
                                  return { ...item, customValues: nextVals };
                                })
                              }));
                            }}
                            className="p-0.5 text-rose-600 hover:bg-rose-100 hover:text-rose-800 rounded transition"
                            title="Remove Column"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-slate-400 italic font-bold">No custom columns added yet.</div>
                  )}

                  {/* Add new column row */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Column Label (e.g. Working Pressure)"
                      value={newColLabel}
                      onChange={e => setNewColLabel(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 bg-white border border-indigo-300 rounded-lg text-xs font-medium focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={!newColLabel.trim()}
                      onClick={() => {
                        if (!newColLabel.trim()) return;
                        const colId = 'col_' + Date.now();
                        const newCol = { id: colId, label: newColLabel.trim() };
                        setCertForm(prev => ({
                          ...prev,
                          customColumns: [...(prev.customColumns || []), newCol]
                        }));
                        setNewColLabel('');
                      }}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold transition"
                    >
                      + Add
                    </button>
                  </div>
                </div>
                );

                certSectionBlocks.validity = (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 space-y-2">
                  <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wide">Validity Period</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="block text-[10px] font-bold text-slate-500">Duration</label>
                      <select value={certForm.validityDuration||'1 Year'} onChange={e => {
                        const dur = e.target.value;
                        const refillStart = new Date(certForm.challanDate||getLocalDateStr());
                        let nextDt = new Date(refillStart);
                        if (dur === '1 Year') nextDt.setFullYear(nextDt.getFullYear()+1);
                        else if (dur === '3 Years') nextDt.setFullYear(nextDt.getFullYear()+3);
                        else if (dur === '5 Years') nextDt.setFullYear(nextDt.getFullYear()+5);
                        const nextDtStr = nextDt.toISOString().split('T')[0];
                        setCertForm(prev => ({
                          ...prev,
                          validityDuration: dur,
                          validUntil: dur === 'Custom' ? prev.validUntil : nextDtStr,
                          itemsList: (prev.itemsList || []).map(item => {
                            const itemStart = new Date(item.refillingDate || prev.challanDate);
                            let itemDue = new Date(itemStart);
                            if (dur === '1 Year') itemDue.setFullYear(itemDue.getFullYear()+1);
                            else if (dur === '3 Years') itemDue.setFullYear(itemDue.getFullYear()+3);
                            else if (dur === '5 Years') itemDue.setFullYear(itemDue.getFullYear()+5);
                            return {
                              ...item,
                              nextDate: dur === 'Custom' ? item.nextDate : itemDue.toISOString().split('T')[0]
                            };
                          })
                        }));
                        if (dur !== 'Custom') {
                          setNewItemNextDate(nextDtStr);
                        }
                      }} className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg font-bold text-xs text-slate-900 focus:outline-none">
                        <option value="1 Year">1 Year</option>
                        <option value="3 Years">3 Years</option>
                        <option value="5 Years">5 Years</option>
                        <option value="Custom">Custom</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[10px] font-bold text-slate-500">Issue Date</label>
                      <input type="date" value={certForm.issueDate} max={getLocalDateStr()} onChange={e => {
                        let newDt = e.target.value;
                        const today = getLocalDateStr();
                        if (newDt > today) {
                          alert("Issue Date cannot be in the future.");
                          newDt = today;
                        }
                        setCertForm(prev => {
                          const nextChallanDate = prev.challanDate > newDt ? newDt : prev.challanDate;
                          const dur = prev.validityDuration||'1 Year';
                          let nextDt = new Date(nextChallanDate);
                          if (dur === '1 Year') nextDt.setFullYear(nextDt.getFullYear()+1);
                          else if (dur === '3 Years') nextDt.setFullYear(nextDt.getFullYear()+3);
                          else if (dur === '5 Years') nextDt.setFullYear(nextDt.getFullYear()+5);
                          const nextDtStr = isNaN(nextDt.getTime()) ? prev.validUntil : nextDt.toISOString().split('T')[0];
                          
                          return {
                            ...prev,
                            issueDate: newDt,
                            challanDate: nextChallanDate,
                            validUntil: dur === 'Custom' ? prev.validUntil : nextDtStr,
                            itemsList: (prev.itemsList || []).map(item => {
                              const itemRefill = item.refillingDate > newDt ? newDt : item.refillingDate;
                              let itemDue = new Date(itemRefill);
                              if (dur === '1 Year') itemDue.setFullYear(itemDue.getFullYear()+1);
                              else if (dur === '3 Years') itemDue.setFullYear(itemDue.getFullYear()+3);
                              else if (dur === '5 Years') itemDue.setFullYear(itemDue.getFullYear()+5);
                              return {
                                ...item,
                                refillingDate: itemRefill,
                                nextDate: dur === 'Custom' ? item.nextDate : itemDue.toISOString().split('T')[0]
                              };
                            })
                          };
                        });
                        const nextCappedChallan = certForm.challanDate > newDt ? newDt : certForm.challanDate;
                        setNewItemRefillDate(nextCappedChallan);
                        if (certForm.validityDuration !== 'Custom') {
                          const years = certForm.validityDuration === '5 Years' ? 5 : certForm.validityDuration === '3 Years' ? 3 : 1;
                          const nextCappedDue = new Date(new Date(nextCappedChallan).setFullYear(new Date(nextCappedChallan).getFullYear() + years)).toISOString().split('T')[0];
                          setNewItemNextDate(nextCappedDue);
                        }
                      }} className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-medium focus:outline-none"/>
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[10px] font-bold text-slate-500">Valid Until</label>
                      <input type="date" value={certForm.validUntil} onChange={e => {
                        const newValidUntil = e.target.value;
                        setCertForm(prev => ({
                          ...prev,
                          validUntil: newValidUntil,
                          validityDuration: 'Custom',
                          itemsList: (prev.itemsList || []).map(item => ({
                            ...item,
                            nextDate: newValidUntil
                          }))
                        }));
                        setNewItemNextDate(newValidUntil);
                      }}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-rose-700 focus:outline-none"/>
                    </div>
                  </div>
                </div>
                );

                certSectionBlocks.signatory = (
                <div className="space-y-1">
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Authorized Signatory</label>
                  <input type="text" value={certForm.authorizedSignatory} onChange={e => setCertForm(prev=>({...prev,authorizedSignatory:e.target.value}))}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg font-medium text-slate-800 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none"/>
                </div>
                );

                return (
                  <>
                    <div className="flex items-center justify-between px-0.5 pb-1">
                      <div className="text-[9px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1">
                        <GripVertical className="w-3 h-3 text-slate-300" />
                        Drag to reorder · tick to print on certificate
                      </div>
                      {sectionOrder.join() !== CERT_SECTION_IDS.join() && (
                        <button
                          type="button"
                          onClick={() => setSectionOrder(CERT_SECTION_IDS)}
                          title="Reset section order to default"
                          className="flex items-center gap-1 text-[9px] font-bold text-slate-400 hover:text-amber-700 transition"
                        >
                          <RotateCcw className="w-3 h-3" /> RESET
                        </button>
                      )}
                    </div>

                    {sectionOrder.map((sectionId, idx) => {
                      const meta = CERT_SECTION_META[sectionId];
                      const block = certSectionBlocks[sectionId];
                      if (!meta || !block) return null;
                      const shown = isSectionVisible(sectionId);
                      return (
                        <div
                          key={sectionId}
                          onDragOver={e => { e.preventDefault(); if (draggingSectionId && dragOverSectionId !== sectionId) setDragOverSectionId(sectionId); }}
                          onDrop={e => { e.preventDefault(); moveCertSection(draggingSectionId, sectionId); setDraggingSectionId(null); setDragOverSectionId(null); }}
                          className={`rounded-xl transition-all ${draggingSectionId === sectionId ? 'opacity-40' : ''} ${dragOverSectionId === sectionId && draggingSectionId !== sectionId ? 'ring-2 ring-amber-400 ring-offset-1' : ''}`}
                        >
                          <div className="flex items-start gap-1.5">
                            <div className="flex flex-col items-center gap-0.5 pt-0.5 shrink-0">
                              <div
                                draggable
                                onDragStart={e => { setDraggingSectionId(sectionId); e.dataTransfer.effectAllowed = 'move'; }}
                                onDragEnd={() => { setDraggingSectionId(null); setDragOverSectionId(null); }}
                                title={`Drag to move "${meta.label}"`}
                                className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-amber-600 transition p-0.5 touch-none"
                              >
                                <GripVertical className="w-3.5 h-3.5" />
                              </div>
                              {meta.pdf ? (
                                <button
                                  type="button"
                                  onClick={() => toggleSectionVisible(sectionId)}
                                  title={shown ? `"${meta.label}" is printed on the certificate — click to hide it` : `"${meta.label}" is hidden from the certificate — click to show it`}
                                  className={`w-4 h-4 rounded border flex items-center justify-center transition shrink-0 ${shown ? 'bg-emerald-500 border-emerald-600 text-white hover:bg-emerald-600' : 'bg-white border-slate-300 text-transparent hover:border-emerald-400'}`}
                                >
                                  <CheckCircle2 className="w-3 h-3" strokeWidth={3} />
                                </button>
                              ) : (
                                <span title="Setting only — this never prints on the certificate" className="w-4 h-4 flex items-center justify-center text-slate-300 text-[10px] font-bold">—</span>
                              )}
                              <button
                                type="button"
                                onClick={() => nudgeCertSection(sectionId, -1)}
                                disabled={idx === 0}
                                title="Move up"
                                className="text-slate-300 hover:text-amber-600 disabled:opacity-20 disabled:hover:text-slate-300 transition leading-none"
                              >
                                <ChevronUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                onClick={() => nudgeCertSection(sectionId, 1)}
                                disabled={idx === sectionOrder.length - 1}
                                title="Move down"
                                className="text-slate-300 hover:text-amber-600 disabled:opacity-20 disabled:hover:text-slate-300 transition leading-none"
                              >
                                <ChevronDown className="w-3 h-3" />
                              </button>
                            </div>
                            <div className={`flex-1 min-w-0 transition-opacity ${meta.pdf && !shown ? 'opacity-45' : ''}`}>
                              {block}
                              {meta.pdf && !shown && (
                                <div className="text-[9px] font-bold text-slate-400 mt-0.5">Hidden from certificate — kept here for later use</div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
                })()}
                </div>

                {/* Save Settings & Lock buttons */}
                <div className="pt-2 flex flex-col gap-2">
                  {/* Unlock button — shown only when locked */}
                  {certForm.isSettingsLocked && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (window.confirm('Unlock settings to make changes?')) {
                          setCertForm(prev => ({ ...prev, isSettingsLocked: false }));
                          if (updateDocSettings) {
                            const patch = {
                              certificate_types: {
                                [certForm.formatType]: {
                                  ...docSettings?.certificate_types?.[certForm.formatType],
                                  isSettingsLocked: false
                                }
                              }
                            };
                            await updateDocSettings(patch);
                          }
                        }
                      }}
                      className="w-full py-2.5 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md transition"
                    >
                      🔓 UNLOCK
                    </button>
                  )}

                  {!certForm.isSettingsLocked && (
                    <>
                    {/* SAVE */}
                    <button
                      type="button"
                      disabled={Boolean(adminSubmitting)}
                      onClick={async () => {
                        try {
                          setAdminSubmitting('settings_save');
                          if (updateDocSettings) {
                            const patch = {
                              certificate_types: {
                                [certForm.formatType]: {
                                  title: certForm.title,
                                  bodyIntroLines: certForm.bodyIntroLines,
                                  customCertifyLines: certForm.customCertifyLines,
                                  customEquipmentNotes: certForm.customEquipmentNotes,
                                  customColumns: certForm.customColumns,
                                  sectionOrder: certForm.sectionOrder,
                                  sectionVisibility: certForm.sectionVisibility,
                                  status: certForm.status,
                                  authorizedSignatory: certForm.authorizedSignatory,
                                  certPrefix: certForm.certPrefix,
                                  certPeriod: certForm.certPeriod,
                                  certSequence: certForm.certSequence,
                                  hpTestPressure: certForm.hpTestPressure,
                                  hpTestResult: certForm.hpTestResult,
                                  newExtinguisherWarranty: certForm.newExtinguisherWarranty,
                                  isiMarkNumber: certForm.isiMarkNumber,
                                  systemInstallationType: certForm.systemInstallationType,
                                  systemStatus: certForm.systemStatus,
                                  amcPeriod: certForm.amcPeriod,
                                  amcFrequency: certForm.amcFrequency,
                                  visitObservations: certForm.visitObservations,
                                  isSettingsLocked: false
                                }
                              }
                            };
                            await updateDocSettings(patch);
                          }
                          alert('✅ Settings saved in the system!');
                        } catch (err) {
                          alert('Error saving settings: ' + err.message);
                        } finally {
                          setAdminSubmitting('');
                        }
                      }}
                      className="w-full py-2 px-4 rounded-xl bg-slate-700 hover:bg-slate-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md transition disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      <span>{adminSubmitting === 'settings_save' ? 'Saving…' : 'SAVE'}</span>
                    </button>

                    {/* LOCK */}
                    <button
                      type="button"
                      disabled={Boolean(adminSubmitting)}
                      onClick={async () => {
                        if (!isSettingsSetupComplete) {
                          alert('⚠️ Setup is not completed. Please fill in all required settings fields (Prefix, Period, Sequence, Signatory, and format-specific fields) before locking.');
                          return;
                        }
                        if (!window.confirm('Save and lock these settings in the system? Future certificates will be generated with this configuration.')) return;
                        try {
                          setAdminSubmitting('settings_lock');
                          if (updateDocSettings) {
                            const patch = {
                              certificate_types: {
                                [certForm.formatType]: {
                                  title: certForm.title,
                                  bodyIntroLines: certForm.bodyIntroLines,
                                  customCertifyLines: certForm.customCertifyLines,
                                  customEquipmentNotes: certForm.customEquipmentNotes,
                                  customColumns: certForm.customColumns,
                                  sectionOrder: certForm.sectionOrder,
                                  sectionVisibility: certForm.sectionVisibility,
                                  status: certForm.status,
                                  authorizedSignatory: certForm.authorizedSignatory,
                                  certPrefix: certForm.certPrefix,
                                  certPeriod: certForm.certPeriod,
                                  certSequence: certForm.certSequence,
                                  hpTestPressure: certForm.hpTestPressure,
                                  hpTestResult: certForm.hpTestResult,
                                  newExtinguisherWarranty: certForm.newExtinguisherWarranty,
                                  isiMarkNumber: certForm.isiMarkNumber,
                                  systemInstallationType: certForm.systemInstallationType,
                                  systemStatus: certForm.systemStatus,
                                  amcPeriod: certForm.amcPeriod,
                                  amcFrequency: certForm.amcFrequency,
                                  visitObservations: certForm.visitObservations,
                                  isSettingsLocked: true
                                }
                              }
                            };
                            await updateDocSettings(patch);
                          }
                          setCertForm(prev => ({ ...prev, isSettingsLocked: true }));
                          alert('🔒 Settings saved and locked in the system. Future certificates of this type will use this configuration.');
                        } catch (err) {
                          alert('Error locking settings: ' + err.message);
                        } finally {
                          setAdminSubmitting('');
                        }
                      }}
                      className={`w-full py-2 px-4 rounded-xl text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md transition ${isSettingsSetupComplete ? 'bg-amber-700 hover:bg-amber-800' : 'bg-amber-700/50 cursor-not-allowed opacity-50'}`}
                    >
                      <Lock className="w-4 h-4" />
                      <span>{adminSubmitting === 'settings_lock' ? 'Locking…' : 'LOCK'}</span>
                    </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Final Action Buttons — Docked at the end of the form/configuration panel */}
          <div className="pt-4 mt-2 border-t border-slate-200 shrink-0 space-y-2.5 lg:block hidden">
            <div className="flex flex-wrap gap-2 w-full">
              {/* Previous */}
              <button
                type="button"
                disabled={Boolean(adminSubmitting)}
                onClick={handleLoadPreviousCertificate}
                className="flex-1 min-w-[80px] py-2 px-2.5 rounded-xl bg-zinc-600 hover:bg-zinc-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Previous</span>
              </button>

              {/* Next */}
              <button
                type="button"
                disabled={Boolean(adminSubmitting)}
                onClick={handleLoadNextCertificate}
                className="flex-1 min-w-[80px] py-2 px-2.5 rounded-xl bg-zinc-600 hover:bg-zinc-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                <span>Next</span>
              </button>

              {/* Save & Download */}
              <button
                type="button"
                disabled={!readyToFinalize || Boolean(adminSubmitting)}
                onClick={async () => {
                  try {
                    setAdminSubmitting('save_download');
                    const result = await saveCertificateRecord({ isLocked: true });
                    setCertForm(prev => ({ ...prev, isLocked: true }));
                    const { pdf } = await buildCertificatePdf();
                    pdf.save(`${getDownloadFilename(certForm.certificateNo, certForm.customerName, certForm.issueDate)}.pdf`);
                    uploadToDriveBackground(pdf);
                    if (!result.isExisting && result.certificate) advanceToNextCertNumber(result.certificate);
                    alert('✅ Certificate saved & downloaded.');
                  } catch (err) { console.error(err); alert('Save & Download error: ' + err.message); }
                  finally { setAdminSubmitting(''); }
                }}
                className="flex-1 min-w-[120px] py-2 px-2.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{adminSubmitting === 'save_download' ? 'Processing…' : 'Save & Download'}</span>
              </button>

              {/* Print */}
              <button
                type="button"
                disabled={!readyToFinalize || Boolean(adminSubmitting)}
                onClick={async () => {
                  try {
                    setAdminSubmitting('print');
                    const { imgData } = await buildCertificatePdf();
                    const pw = window.open('', '_blank');
                    if (!pw) { alert('Popup blocked!'); return; }
                    pw.document.write(`<!DOCTYPE html><html><head><title>Print - ${certForm.certificateNo}</title><style>@page{size:A4 portrait;margin:0;}body{margin:0;padding:0;background:#fff;text-align:center;}img{width:210mm;height:auto;display:block;margin:0 auto;}</style></head><body><img src="${imgData}" onload="setTimeout(function(){window.print();window.close();},300);"/></body></html>`);
                    pw.document.close();
                  } catch (err) { alert('Print failed: ' + err.message); }
                  finally { setAdminSubmitting(''); }
                }}
                className="flex-1 min-w-[80px] py-2 px-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>{adminSubmitting === 'print' ? 'Preparing…' : 'Print'}</span>
              </button>

              {/* New Certificate */}
              <button
                type="button"
                disabled={Boolean(adminSubmitting)}
                onClick={handleNewBlankCertificate}
                className="flex-1 min-w-[80px] py-2 px-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>New Certificate</span>
              </button>
            </div>

            {task && readyToFinalize && (
              <button type="button" disabled={Boolean(adminSubmitting)} onClick={async () => {
                try {
                  setAdminSubmitting('cert');
                  await saveCertificateRecord({ isLocked: true });
                  const r = await fetch(`/api/tasks/${task.Task_ID}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ remarks: `[Certificate Issued: ${certForm.certificateNo}] Challan Date: ${certForm.challanDate} | Valid Until: ${certForm.validUntil}`, latLong: '0.0000, 0.0000' }) });
                  if (!r.ok) throw new Error('Failed to advance stage');
                  alert(`✅ Certificate ${certForm.certificateNo} issued and stage advanced!`); handleBack();
                } catch (err) { alert(err.message); }
                finally { setAdminSubmitting(''); }
              }} className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs flex items-center justify-center gap-1.5 shadow-md transition disabled:opacity-50">
                <CheckCircle2 className="w-3.5 h-3.5" /><span>{adminSubmitting === 'cert' ? 'Saving…' : '✅ Mark Certified & Advance Stage'}</span>
              </button>
            )}

            {!readyToFinalize && (
              <div className="px-3 py-2 bg-slate-100 border border-dashed border-slate-300 rounded-xl text-center">
                <span className="text-[10px] font-bold text-slate-400">Complete Certificate Details &amp; add at least one Equipment item to unlock Save, Download &amp; Print.</span>
              </div>
            )}

            {/* Mobile-only Next/Preview toggle button */}
            <div className="lg:hidden flex pt-1">
              <button
                type="button"
                onClick={() => setActiveMobileTab('preview')}
                className="w-full py-3 px-8 rounded-xl bg-amber-700 hover:bg-amber-800 active:scale-95 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg transition-all"
              >
                <span>Preview Certificate PDF</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN — Live A4 Preview */}
        <div
          onTouchStart={handlePreviewTouchStart}
          onTouchMove={handlePreviewTouchMove}
          className={`${activeMobileTab === 'preview' && !focusMode ? 'flex' : 'hidden'} ${focusMode ? '' : 'lg:flex'} lg:col-span-6 bg-slate-100 rounded-2xl p-2 sm:p-3 flex-col items-center justify-start overflow-y-auto shadow-inner pb-36 lg:pb-3`}
        >
          <div className="text-[10px] font-bold text-slate-400 mb-2 flex items-center gap-1.5">
            <Eye className="w-3 h-3 text-amber-600"/>
            <span>Live A4 Preview — {certForm.certificateNo}</span>
          </div>
          <div className="w-full overflow-x-hidden flex justify-center py-2 min-h-0">
            <div
              id="cert-scale-wrapper"
              style={{
                width: `${794 * previewScale}px`,
                height: `${1123 * previewScale}px`,
                position: 'relative',
                overflow: 'hidden'
              }}
              className="shrink-0 transition-all duration-200"
            >
              <div
                id="certificate-print-root"
                ref={certPreviewRef}
                className="bg-white text-slate-900 shadow-2xl relative select-none flex flex-col shrink-0 origin-top-left"
                style={{
                  width: '794px',
                  height: '1123px',
                  padding: '16px',
                  boxSizing: 'border-box',
                  fontFamily: "'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
                  isolation: 'isolate',
                  transform: `scale(${previewScale})`
                }}
              >
            {/* Inner wrapper with double border shifted slightly inside for margin printing */}
            <div
              className="w-full h-full flex flex-col justify-between border-4 border-solid border-red-700 p-6 flex-1 bg-white relative"
              style={{ boxSizing: 'border-box' }}
            >
              {(certCfg.show_watermark !== false) && (
                <img
                  src={certBase64Assets.watermark||branding.watermark_logo_url||'/assets/Watermark Logo.jpg'}
                  onError={e=>{e.target.onerror=null;e.target.src='/assets/watermark-logo.jpg';}}
                  alt="Watermark Logo"
                  aria-hidden="true"
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/5 object-contain pointer-events-none select-none transition-opacity"
                  style={{opacity:0.08}}
                />
              )}
              <div className="relative flex flex-col h-full">
                {(certCfg.show_header !== false) && (
                <div className={`border-b-2 border-red-700 pb-3 ${density.headerMb} shrink-0`}>
                  <img src={certBase64Assets.header||branding.header_image_url||'/assets/header_logo.png'} onError={e=>{e.target.onerror=null;e.target.src='/assets/header.jpg';}} alt="Expert Safety Solutions Header" className={`w-full h-auto ${density.imgMaxH} object-contain mx-auto shrink-0`}/>
                </div>
                )}

                <div className="flex justify-between items-center text-xs font-extrabold text-red-950 bg-red-50/80 px-4 rounded border border-red-300 mb-4" style={{ paddingTop: '8px', paddingBottom: '16px', lineHeight: '1' }}>
                  <div>{isSectionVisible('certNo') && <>Ref / Cert No:&nbsp;<span className="text-slate-900">{certForm.certificateNo}</span></>}</div>
                  <div>Date:&nbsp;<span className="text-slate-800 font-bold">{formatDateDDMMYYYY(certForm.issueDate)}</span></div>
                </div>
                {isSectionVisible('title') && (
                <div className="flex justify-center w-full my-4">
                  <span className="inline-block bg-red-700 text-white font-black text-sm px-5 rounded-md uppercase tracking-wider shadow-md border border-red-800 text-center" style={{ paddingTop: '10px', paddingBottom: '18px', lineHeight: '1' }}>{certForm.title}</span>
                </div>
                )}
                <div className={`${density.bodyText} leading-relaxed text-slate-800 text-justify ${density.bodySpace}`}>
                  {/* To Block (Fixed Location At Top of Page Content) */}
                  <div className="mb-3 text-left bg-red-50/20 rounded border border-red-300/80 text-[10.5px] font-bold text-slate-800 w-full shadow-2xs" style={{ paddingTop: '10px', paddingRight: '10px', paddingLeft: '10px', paddingBottom: '20px' }}>
                    <div className="text-red-950 font-black" style={{ lineHeight: '1.2' }}>TO,</div>
                    <div className="mt-1 text-slate-900 font-black uppercase tracking-wide break-words" style={{ lineHeight: '1.4' }}>{certForm.customerName || 'Valued Client'}</div>
                    <div className="mt-1 text-slate-700 font-bold break-words whitespace-pre-wrap" style={{ lineHeight: '1.4' }}>{certForm.address || 'Client Address'}</div>
                  </div>

                   {!isSectionVisible('bodyIntro') ? null : certForm.bodyIntroLines && certForm.bodyIntroLines.filter(l => l && l.trim()).length > 0 ? (
                     <div className="space-y-1 w-full">
                       {certForm.bodyIntroLines.filter(l => l && l.trim()).map((line, i) => (
                         <p key={i} className="w-full text-justify font-semibold text-slate-850 leading-relaxed break-words">{line}</p>
                       ))}
                     </div>
                   ) : (
                     <p className="w-full text-justify font-semibold text-slate-850 leading-relaxed">This is to certify that we have carried out the servicing, refilling and maintenance of the Fire Safety Equipment of the above client. The system has been tested, checked and found to be in complete working readiness. Detailed equipment scheduling summary is listed below:</p>
                   )}

                  {isSectionVisible('formatSpecific') && certForm.formatType === 'HP Testing' && (
                    <div className="bg-slate-50 px-4 py-2.5 rounded border border-slate-300 text-[11px] flex justify-between font-bold shadow-2xs leading-none">
                      <div>Test Pressure:&nbsp;<span className="text-indigo-855 font-black">{certForm.hpTestPressure}</span></div>
                      <div>Result:&nbsp;<span className="text-emerald-750 font-black">{certForm.hpTestResult}</span></div>
                    </div>
                  )}
                  {isSectionVisible('formatSpecific') && certForm.formatType === 'New Fire Extinguisher' && (
                    <div className="bg-slate-50 px-4 py-2.5 rounded border border-slate-300 text-[11px] flex justify-between font-bold shadow-2xs leading-none">
                      <div>ISI Mark:&nbsp;<span className="text-indigo-855 font-black">{certForm.isiMarkNumber}</span></div>
                      <div>Warranty:&nbsp;<span className="text-red-950 font-black">{certForm.newExtinguisherWarranty}</span></div>
                    </div>
                  )}
                  {isSectionVisible('formatSpecific') && certForm.formatType === 'System Installation' && (
                    <div className="bg-slate-50 px-4 py-2.5 rounded border border-slate-300 text-[11px] flex justify-between font-bold shadow-2xs leading-none">
                      <div>System:&nbsp;<span className="text-indigo-950 font-black">{certForm.systemInstallationType}</span></div>
                      <div className="text-emerald-750">Status:&nbsp;<span className="font-black">{certForm.systemStatus}</span></div>
                    </div>
                  )}
                  {isSectionVisible('formatSpecific') && certForm.formatType === 'AMC Certificate' && (
                    <div className="bg-slate-50 px-4 py-2.5 rounded border border-slate-300 text-[11px] flex justify-between font-bold shadow-2xs leading-none">
                      <div>Period:&nbsp;<span className="text-indigo-950 font-black">{certForm.amcPeriod}</span></div>
                      <div>Frequency:&nbsp;<span className="text-emerald-855 font-black">{certForm.amcFrequency}</span></div>
                    </div>
                  )}
                  {isSectionVisible('formatSpecific') && certForm.formatType === 'Visit Report' && (
                    <div className="bg-slate-50 p-2 rounded border border-slate-300 text-[11px]">
                      <strong>Engineer Observations:</strong>
                      <p className="mt-1 text-slate-800 font-medium whitespace-pre-wrap">{certForm.visitObservations}</p>
                    </div>
                  )}
                  {(!hideEquipmentSection && (certForm.itemsList||[]).length > 0) && (
                    <div className={density.tableMt}>
                      <div className="font-extrabold text-xs text-red-950 text-center border-b border-red-400 mb-2" style={{ paddingBottom: '10px', lineHeight: '1.2' }}>Certified Equipment &amp; Schedule Summary</div>
                      <table className={`w-full ${density.cellText} border-collapse border border-slate-400 shadow-2xs`}>
                        <thead>
                          <tr className="bg-transparent text-red-950 font-extrabold text-left">
                            {(certCfg.visible_columns?.sr_no !== false) && <th className={`border border-slate-400 ${density.cellPad} text-center w-8 align-middle leading-none`}>Sr.</th>}
                            {(!isMinimalItemFormat && certCfg.visible_columns?.item_name !== false) && <th className={`border border-slate-400 ${density.cellPad} align-middle leading-none`}>Item Name / Type</th>}
                            {(!isMinimalItemFormat && certCfg.visible_columns?.capacity !== false) && <th className={`border border-slate-400 ${density.cellPad} align-middle leading-none`}>Capacity</th>}
                            {(!isMinimalItemFormat && certCfg.visible_columns?.qty !== false) && <th className={`border border-slate-400 ${density.cellPad} text-center align-middle leading-none`}>Qty</th>}
                            {(!isMinimalItemFormat && certCfg.visible_columns?.refill_date !== false) && <th className={`border border-slate-400 ${density.cellPad} align-middle leading-none`}>{certForm.formatType === 'HP Testing' ? 'Date of Testing' : 'Date of Refilling'}</th>}
                            {(!isMinimalItemFormat && certCfg.visible_columns?.valid_until !== false) && <th className={`border border-slate-400 ${density.cellPad} align-middle leading-none`}>{certForm.formatType === 'HP Testing' ? 'Next Date of Testing' : 'Next Date of Refilling'}</th>}
                            {isSectionVisible('customColumns') && (certForm.customColumns||[]).map(c => (<th key={c.id} className={`border border-slate-400 ${density.cellPad} bg-transparent text-indigo-950 align-middle leading-none`}>{c.label}</th>))}
                          </tr>
                        </thead>
                        <tbody>
                          {(certForm.itemsList||[]).map((it, idx) => (
                            <tr key={it.id||idx} className="border border-slate-300 hover:bg-slate-50 font-semibold">
                              {(certCfg.visible_columns?.sr_no !== false) && <td className={`border border-slate-300 ${density.cellPad} text-center font-bold align-middle leading-none`}>{idx+1}</td>}
                              {(!isMinimalItemFormat && certCfg.visible_columns?.item_name !== false) && (
                                <td className={`border border-slate-300 ${density.cellPad} font-bold text-slate-950 align-middle leading-none`}>
                                  {it.itemName} {it.identificationNo ? `(Cyl No: ${it.identificationNo})` : ''}
                                </td>
                              )}
                              {(!isMinimalItemFormat && certCfg.visible_columns?.capacity !== false) && <td className={`border border-slate-300 ${density.cellPad} align-middle leading-none`}>{it.capacity}</td>}
                              {(!isMinimalItemFormat && certCfg.visible_columns?.qty !== false) && <td className={`border border-slate-300 ${density.cellPad} font-extrabold bg-transparent text-indigo-950 text-center align-middle leading-none`}>{formatQtyNos(it.qty || it.quantity || '1')}</td>}
                              {(!isMinimalItemFormat && certCfg.visible_columns?.refill_date !== false) && <td className={`border border-slate-300 ${density.cellPad} align-middle leading-none`}>{formatDateDDMMYYYY(it.refillingDate)}</td>}
                              {(!isMinimalItemFormat && certCfg.visible_columns?.valid_until !== false) && <td className={`border border-slate-300 ${density.cellPad} font-bold text-rose-700 align-middle leading-none`}>{formatDateDDMMYYYY(it.nextDate)}</td>}
                              {isSectionVisible('customColumns') && (certForm.customColumns||[]).map(c => (<td key={c.id} className={`border border-slate-300 ${density.cellPad} text-indigo-900 font-bold align-middle leading-none`}>{it.customValues?.[c.id]||'—'}</td>))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {isSectionVisible('customCertify') && (certForm.customCertifyLines || []).filter(l => l && l.trim()).map((line, i) => (
                    <p key={`certify-${i}`} className="w-full text-justify font-semibold text-slate-850 leading-relaxed whitespace-pre-wrap mt-1.5">{line}</p>
                  ))}
                  {isSectionVisible('equipmentNotes') && (certForm.customEquipmentNotes || []).filter(l => l && l.trim()).map((line, i) => (
                    <p key={i} className={`w-full text-justify font-semibold text-slate-850 leading-relaxed whitespace-pre-wrap${i === 0 ? ' border-t border-dashed border-slate-300 pt-1.5' : ''}`}>{line}</p>
                  ))}
                </div>

              <div className="relative mt-auto pt-4 border-t-2 border-amber-700 shrink-0">
                <div className="grid grid-cols-3 items-center gap-3 w-full shrink-0">
                  <div className="flex justify-start">
                    {(certCfg.show_qr_code !== false) && (
                    <div className="flex flex-col items-center justify-between text-center bg-slate-50 p-2.5 rounded-xl border border-slate-300 w-[130px] h-[140px] shrink-0 shadow-2xs">
                      <div className="bg-white p-1 rounded-lg border border-slate-200 shadow-2xs">
                        <QRCodeCanvas value={`${window.location.origin}/api/verify-certificate/${certForm.verificationGuid}`} size={84} level="H" includeMargin={false}/>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-[8.5px] font-extrabold text-indigo-900 uppercase leading-tight">Scan to Verify</span>
                        <span className="text-[7.5px] font-bold text-slate-500">{certForm.verificationGuid}</span>
                      </div>
                    </div>
                    )}
                  </div>

                  <div className="flex justify-center">
                    {/* Customer Support (top-aligned with QR) + 2x2 Emergency Contact Ribbon (bottom-aligned with QR) */}
                    <div className="flex flex-col items-center justify-between text-center w-[200px] h-[140px] shrink-0 mx-auto">
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-[9px] font-black text-slate-700 uppercase tracking-wide">Customer Support</span>
                        <div className="text-[11px] font-extrabold text-red-600 border border-red-300 rounded-md bg-red-50/50 block text-center w-full" style={{ paddingTop: '4px', paddingBottom: '14px', paddingLeft: '10px', paddingRight: '10px', lineHeight: '1' }}>8460699569</div>
                      </div>
                      <div className="w-full">
                        <div className="text-[10.5px] font-black text-red-600 uppercase tracking-widest w-full text-center border-b border-red-300 mb-2" style={{ paddingBottom: '10px', lineHeight: '1.2' }}>Emergency Contact</div>
                        <table className="w-full border-collapse text-[10px] text-center font-extrabold">
                          <tbody className="w-full">
                            <tr className="border-b border-slate-300 w-full flex">
                              <td className="border-r border-slate-300 py-2 px-1 text-red-600 font-extrabold w-1/2 flex items-center justify-center gap-1">
                                <span>🚒</span> Fire: <span className="text-slate-900 font-black">101</span>
                              </td>
                              <td className="py-2 px-1 text-blue-700 font-extrabold w-1/2 flex items-center justify-center gap-1">
                                <span>🚑</span> Amb: <span className="text-slate-900 font-black">108</span>
                              </td>
                            </tr>
                            <tr className="w-full flex">
                              <td className="border-r border-slate-300 py-2 px-1 text-blue-700 font-extrabold w-1/2 flex items-center justify-center gap-1">
                                <span>👮</span> Police: <span className="text-slate-900 font-black">100</span>
                              </td>
                              <td className="py-2 px-1 text-red-600 font-extrabold w-1/2 flex items-center justify-center gap-1">
                                <span>🚨</span> Emerg: <span className="text-slate-900 font-black">112</span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <div className="relative flex items-end shrink-0">
                      {(certCfg.show_signature !== false) ? (
                        <div className="text-center flex flex-col items-center justify-end min-w-[180px] shrink-0">
                          {/* Stamp placed above signature line (system signature removed) */}
                          {(certCfg.show_stamp !== false) && (
                            <img
                              src={certBase64Assets.stamp||branding.company_stamp_url||'/assets/company_stamp.png'}
                              onError={e=>{e.target.onerror=null;e.target.src='/assets/stamp.jpg';}}
                              alt="Official Seal Stamp"
                              className="w-28 h-auto object-contain mx-auto -mb-1 shrink-0"
                            />
                          )}
                          {isSectionVisible('signatory') && (
                            <>
                              <div className="border-t-2 border-slate-900 pt-1 font-black text-xs text-slate-950 w-full">{certForm.authorizedSignatory||'Mr. Nilesh Padaya'}</div>
                              <div className="text-[10px] text-slate-600 font-bold leading-tight">Authorized Signatory<br/>Expert Safety Solutions</div>
                            </>
                          )}
                        </div>
                      ) : (
                        /* If signature is hidden but stamp is shown */
                        (certCfg.show_stamp !== false) && (
                          <div className="flex flex-col items-center justify-end shrink-0">
                            <img src={certBase64Assets.stamp||branding.company_stamp_url||'/assets/company_stamp.png'} onError={e=>{e.target.onerror=null;e.target.src='/assets/stamp.jpg';}} alt="Official Seal Stamp" className="w-28 h-auto object-contain shrink-0"/>
                            <span className="text-[9px] font-bold text-slate-500 mt-1 uppercase">Official Company Seal</span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </div>
                <div className="w-full text-center border-t border-slate-300 mt-2 pt-1.5 shrink-0 flex flex-col items-center">
                  <span className="text-[8.5px] font-black text-red-650 tracking-wider uppercase mb-1 underline decoration-slate-950 decoration-1 underline-offset-2">🛡️ SECURITY NOTICE</span>
                  <span className="text-[8px] font-semibold text-slate-500 italic mb-0.5">This is system generated document, hence no physical signature is required.</span>
                  <span className="text-[8px] font-extrabold text-slate-500">Scan the QR code to verify the authenticity of this document. Any manual edit on this printed document is invalid.</span>
                </div>
                {(certCfg.show_footer !== false) && (
                <div className="mt-1 shrink-0">
                  <img src={certBase64Assets.footer||branding.footer_image_url||'/assets/Footer - Expert (2025).PNG'} alt="Expert Footer Branding" className={`w-full h-auto ${density.imgMaxH} object-contain mx-auto shrink-0`} onError={e=>{e.target.onerror=null;e.target.src='/assets/footer.png';}}/>
                </div>
                )}
              </div>
            </div>
          </div>
        </div>
          </div>
        </div>
        </div>
      </div>

      {/* Sticky Bottom Actions Bar for Mobile */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white/95 backdrop-blur-md border-t border-slate-200 p-3 pb-safe shadow-[0_-8px_30px_rgba(0,0,0,0.12)] flex flex-col gap-2">
        {/* Row 1: Quick Actions */}
        <div className="flex gap-2 w-full">
          {/* Previous */}
          <button
            type="button"
            disabled={Boolean(adminSubmitting)}
            onClick={handleLoadPreviousCertificate}
            className="flex-1 py-2.5 px-2 rounded-xl bg-zinc-600 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Prev</span>
          </button>

          {/* Next */}
          <button
            type="button"
            disabled={Boolean(adminSubmitting)}
            onClick={handleLoadNextCertificate}
            className="flex-1 py-2.5 px-2 rounded-xl bg-zinc-600 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            <span>Next</span>
          </button>

          {/* Save & Download */}
          <button
            type="button"
            disabled={!readyToFinalize || Boolean(adminSubmitting)}
            onClick={async () => {
              try {
                setAdminSubmitting('save_download');
                const result = await saveCertificateRecord({ isLocked: true });
                setCertForm(prev => ({ ...prev, isLocked: true }));
                const { pdf } = await buildCertificatePdf();
                pdf.save(`${getDownloadFilename(certForm.certificateNo, certForm.customerName, certForm.issueDate)}.pdf`);
                uploadToDriveBackground(pdf);
                if (!result.isExisting && result.certificate) advanceToNextCertNumber(result.certificate);
                alert('✅ Certificate saved & downloaded.');
              } catch (err) { console.error(err); alert('Save & Download error: ' + err.message); }
              finally { setAdminSubmitting(''); }
            }}
            className="flex-1 py-2.5 px-2 rounded-xl bg-amber-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{adminSubmitting === 'save_download' ? 'Processing…' : 'Save & Download'}</span>
          </button>

          {/* Print */}
          <button
            type="button"
            disabled={!readyToFinalize || Boolean(adminSubmitting)}
            onClick={async () => {
              try {
                setAdminSubmitting('print');
                const { imgData } = await buildCertificatePdf();
                const pw = window.open('', '_blank');
                if (!pw) { alert('Popup blocked!'); return; }
                pw.document.write(`<!DOCTYPE html><html><head><title>Print - ${certForm.certificateNo}</title><style>@page{size:A4 portrait;margin:0;}body{margin:0;padding:0;background:#fff;text-align:center;}img{width:210mm;height:auto;display:block;margin:0 auto;}</style></head><body><img src="${imgData}" onload="setTimeout(function(){window.print();window.close();},300);"/></body></html>`);
                pw.document.close();
              } catch (err) { alert('Print failed: ' + err.message); }
              finally { setAdminSubmitting(''); }
            }}
            className="flex-1 py-2.5 px-2 rounded-xl bg-indigo-600 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>{adminSubmitting === 'print' ? 'Preparing…' : 'Print'}</span>
          </button>

          {/* New Certificate */}
          <button
            type="button"
            disabled={Boolean(adminSubmitting)}
            onClick={handleNewBlankCertificate}
            className="flex-1 py-2.5 px-2 rounded-xl bg-emerald-700 active:scale-95 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition disabled:opacity-50"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>New</span>
          </button>
        </div>

        {!readyToFinalize && (
          <div className="px-3 py-1.5 bg-slate-50 border border-dashed border-slate-200 rounded-xl text-center">
            <span className="text-[10px] font-bold text-slate-400">Complete details &amp; add equipment to unlock Save / Download.</span>
          </div>
        )}

        {/* Row 2: Secondary / Navigation Toggles */}
        <div className="flex gap-2">
          {task && readyToFinalize && (
            <button type="button" disabled={Boolean(adminSubmitting)} onClick={async () => {
              try {
                setAdminSubmitting('cert');
                await saveCertificateRecord({ isLocked: true });
                const r = await fetch(`/api/tasks/${task.Task_ID}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ remarks: `[Certificate Issued: ${certForm.certificateNo}] Challan Date: ${certForm.challanDate} | Valid Until: ${certForm.validUntil}`, latLong: '0.0000, 0.0000' }) });
                if (!r.ok) throw new Error('Failed to advance stage');
                alert(`✅ Certificate ${certForm.certificateNo} issued and stage advanced!`); handleBack();
              } catch (err) { alert(err.message); }
              finally { setAdminSubmitting(''); }
            }} className="flex-1 py-2 bg-emerald-600 active:scale-95 text-white font-extrabold text-xs flex items-center justify-center gap-1.5 rounded-xl shadow-xs transition disabled:opacity-50">
              <CheckCircle2 className="w-3.5 h-3.5" /><span>{adminSubmitting === 'cert' ? 'Saving…' : 'Mark Certified'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setActiveMobileTab(activeMobileTab === 'edit' ? 'preview' : 'edit')}
            className={`flex-1 py-2 rounded-xl text-white font-black text-xs flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition-all ${
              activeMobileTab === 'edit' ? 'bg-amber-800' : 'bg-slate-800'
            }`}
          >
            {activeMobileTab === 'edit' ? (
              <>
                <Eye className="w-4 h-4 text-amber-400 animate-pulse" />
                <span>Show Preview</span>
              </>
            ) : (
              <>
                <Edit3 className="w-4 h-4 text-amber-400 animate-pulse" />
                <span>Back to Edit</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Floating Back Button for Mobile Preview */}
      {activeMobileTab === 'preview' && (
        <div className="lg:hidden fixed bottom-24 right-4 z-50">
          <button
            type="button"
            onClick={() => setActiveMobileTab('edit')}
            className="flex items-center justify-center bg-slate-900/90 backdrop-blur-xs text-white hover:bg-slate-800 active:scale-95 w-12 h-12 rounded-full font-black shadow-2xl transition-all border border-slate-700"
            title="Back to Edit"
          >
            <ChevronLeft className="w-6 h-6 text-amber-400" />
          </button>
        </div>
      )}

      {/* Full Screen Search Modal */}
      {showSearchModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-indigo-700" />
                <span className="font-bold text-indigo-955 text-xs uppercase tracking-wider">Search Issued Certificates</span>
              </div>
              <button
                type="button"
                onClick={() => { setShowSearchModal(false); setCertSearchQuery(''); }}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 flex-1 overflow-y-auto space-y-3.5">
              <div className="space-y-1">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide">
                  Type Certificate Number or Customer Name
                </label>
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search by Certificate No or Customer Name..."
                    value={certSearchQuery}
                    onChange={e => setCertSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-300 rounded-xl font-bold text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:bg-white focus:outline-none shadow-2xs transition"
                    autoFocus
                  />
                </div>
              </div>

              {/* Search Results Dropdown List */}
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100 bg-white max-h-80 overflow-y-auto">
                {allCertificates
                  .filter(c => {
                    const q = certSearchQuery.toLowerCase().trim();
                    if (!q) return true;
                    const cNo = (c.Certificate_No || c.certificateNo || '').toLowerCase();
                    const cName = (c.Customer_Name || c.customerName || '').toLowerCase();
                    return cNo.includes(q) || cName.includes(q);
                  })
                  .slice()
                  .sort((a, b) => {
                    // Newest-created first. Records with no recoverable creation time sink to the bottom
                    // rather than jumping to the top on a 0 timestamp.
                    const ta = getRecordCreatedAt(a)?.getTime();
                    const tb = getRecordCreatedAt(b)?.getTime();
                    if (ta === undefined && tb === undefined) return 0;
                    if (ta === undefined) return 1;
                    if (tb === undefined) return -1;
                    return tb - ta;
                  })
                  .slice(0, 15)
                  .map(c => (
                    <div
                      key={c.verificationGuid || c._id}
                      onClick={() => {
                        handleLoadCertificateToEdit(c);
                        setShowSearchModal(false);
                        setCertSearchQuery('');
                      }}
                      className="flex items-center justify-between px-3.5 py-2.5 hover:bg-amber-50 active:bg-amber-100 cursor-pointer transition"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="font-bold text-indigo-950 text-xs truncate">{c.Certificate_No || c.certificateNo}</div>
                        <div className="text-[10px] text-slate-600 font-bold truncate mt-0.5">
                          {c.Customer_Name || c.customerName}
                        </div>
                        <div className="text-[9px] text-slate-400 font-semibold mt-0.5">
                          Issued: {formatDateDDMMYYYY(c.Issue_Date || c.issueDate)}
                        </div>
                        {(() => {
                          const created = getRecordCreatedAt(c);
                          if (!created) return null;
                          return (
                            <div className="text-[9px] text-slate-400 font-semibold" title="When this certificate record was created">
                              Created: <span className="text-slate-500 font-bold">{formatDateTimeDDMMYYYYHHMMSS(created)}</span>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          title="Duplicate as a new certificate dated today, with the next available number"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicateCertificate(c);
                            setShowSearchModal(false);
                            setCertSearchQuery('');
                          }}
                          className="text-[10px] bg-emerald-50 hover:bg-emerald-100 text-emerald-800 px-2.5 py-1 rounded-md font-extrabold border border-emerald-200 transition"
                        >
                          DUPLICATE
                        </button>
                        <span className="text-[10px] bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded-md font-extrabold border border-indigo-200">
                          EDIT
                        </span>
                      </div>
                    </div>
                  ))}

                {allCertificates.filter(c => {
                  const q = certSearchQuery.toLowerCase().trim();
                  if (!q) return true;
                  const cNo = (c.Certificate_No || c.certificateNo || '').toLowerCase();
                  const cName = (c.Customer_Name || c.customerName || '').toLowerCase();
                  return cNo.includes(q) || cName.includes(q);
                }).length === 0 && (
                  <div className="px-4 py-8 text-xs text-slate-400 text-center font-bold">
                    No matching certificates found
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
