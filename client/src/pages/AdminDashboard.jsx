import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ClientEquipmentModal from '../components/ClientEquipmentModal';
import ServiceReportStatsPanel from '../components/servicereport/ServiceReportStatsPanel';
import { getAccurateGpsPosition } from '../utils/gpsHelper';
import {
  formatDateDDMMYYYY,
  formatDateWithDayName,
  formatTime24H,
  formatInteractionTimestamp,
  getLocalDateStr,
  getGoogleDirectionsUrl,
  getAvailableContacts,
  isTaskOverdueNoInteraction,
  formatDialerNumber
} from '../utils/dateUtils';
import { validatePasswordPolicy } from '../utils/passwordUtils';
import {
  Users,
  Briefcase,
  Building2,
  Activity,
  PlusCircle,
  Plus,
  MapPin,
  CheckCircle2,
  Clock,
  Layers,
  Search,
  Filter,
  TrendingUp,
  Image as ImageIcon,
  CalendarDays,
  IndianRupee,
  AlertTriangle,
  Check,
  Edit3,
  Navigation,
  PhoneCall,
  MessageSquare,
  History,
  UserCheck,
  Send,
  ExternalLink,
  UserPlus,
  Shield,
  Trash2,
  Key,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Banknote,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  GripVertical,
  X,
  MessageCircle,
  RefreshCw,
  LogOut,
  LayoutDashboard,
  Smartphone,
  Award,
  Printer,
  FileCheck,
  ShieldCheck,
  QrCode,
  Lock,
  Unlock,
  Download,
  Eye,
  Tag as TagIcon,
  Settings,
  CreditCard
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

const REMARK_TAGS = [
  'Call',
  'Call Received',
  'WhatsApp',
  'Pickup',
  'Delivery',
  'Meeting',
  'Quotation Mailed',
  'Invoice Mailed',
  'Quotation FLP',
  'Order FLP',
  'Task FLP',
  'Certification'
];

// Distinct badge colors for auto-generated task lifecycle remarks (see System_Generated remarks
// inserted by the server on task create/status-change) — falls back to the caller's default style.
const SYSTEM_REMARK_BADGE_STYLES = {
  'NEW TASK CREATED': 'bg-blue-100 text-blue-800 border border-blue-200',
  'TASK STATUS UPDATED': 'bg-amber-100 text-amber-800 border border-amber-200',
  'TASK COMPLETED': 'bg-emerald-100 text-emerald-800 border border-emerald-200'
};
const remarkBadgeClass = (type, fallback) => SYSTEM_REMARK_BADGE_STYLES[type] || fallback;

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { token, logout, user, realUser, startImpersonating } = useAuth();
  const isAdmin = (realUser?.Role || user?.Role) === 'Admin' || (realUser?.Role || user?.Role) === 'ADMIN';
  const taskTapTrackerRef = useRef({});
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('expert_admin_active_tab') || 'OVERVIEW'); // 'OVERVIEW' | 'PIPELINE' | 'STAFF' | 'CUSTOMERS' | 'LOGS' | 'ATTENDANCE'
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('expert_admin_filter_status') || 'Pending');
  const [lastNotificationTab, setLastNotificationTab] = useState(null);
  const [showStaffProgressReport, setShowStaffProgressReport] = useState(false);
  const [expandedOverviewModule, setExpandedOverviewModule] = useState(() => localStorage.getItem('expert_admin_expanded_module') || null); // null | 'PIPELINE' | 'STAFF' | 'CUSTOMERS' | 'ATTENDANCE' | 'LOGS'
  const [tagSearch, setTagSearch] = useState('');
  const [showTagList, setShowTagList] = useState(true);
  const [showRemarkInputs, setShowRemarkInputs] = useState(true);
  const [showInteractionTagList, setShowInteractionTagList] = useState(true);
  const [customRemarkTags, setCustomRemarkTags] = useState(() => {
    try {
      const saved = localStorage.getItem('expert_safety_custom_remark_tags');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const remarkTagsList = useMemo(() => {
    const combined = [...REMARK_TAGS, ...customRemarkTags];
    return Array.from(new Set(combined));
  }, [customRemarkTags]);

  const handleAddCustomTag = (e, isInteractionForm = false, forcePrompt = false) => {
    if (e) e.stopPropagation();
    const promptVal = (!forcePrompt && tagSearch.trim()) ? tagSearch.trim() : window.prompt('Enter new custom tag name (e.g., Follow-up Call, Site Inspection):');
    if (promptVal && promptVal.trim()) {
      const cleanTag = promptVal.trim();
      const updatedCustom = Array.from(new Set([...customRemarkTags, cleanTag]));
      setCustomRemarkTags(updatedCustom);
      try {
        localStorage.setItem('expert_safety_custom_remark_tags', JSON.stringify(updatedCustom));
      } catch {}
      if (isInteractionForm) {
        setInteractionForm({ ...interactionForm, type: cleanTag });
        setShowInteractionTagList(false);
      } else {
        setRemarkForm({ ...remarkForm, type: cleanTag });
        setShowTagList(false);
      }
      setTagSearch('');
    }
  };

  const handleDeleteCustomTag = (e, tagToDelete) => {
    if (e) e.stopPropagation();
    const updatedCustom = customRemarkTags.filter(t => t !== tagToDelete);
    setCustomRemarkTags(updatedCustom);
    try {
      localStorage.setItem('expert_safety_custom_remark_tags', JSON.stringify(updatedCustom));
    } catch {}
    if (remarkForm.type === tagToDelete) {
      setRemarkForm({ ...remarkForm, type: '' });
    }
    if (interactionForm.type === tagToDelete) {
      setInteractionForm({ ...interactionForm, type: 'Call' });
    }
  };
  const [searchQuery, setSearchQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchContainerRef = useRef(null);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const [analytics, setAnalytics] = useState(null);
  const [tasks, setTasks] = useState([]);
  
  // Date & User filters state
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterSelectedDates, setFilterSelectedDates] = useState([]);
  const [filterSelectedUsers, setFilterSelectedUsers] = useState([]);
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');

  // Company Details states
  const [showCompanyDetailsModal, setShowCompanyDetailsModal] = useState(false);
  const [companyDetailsTab, setCompanyDetailsTab] = useState('billing');
  const [zoomedImage, setZoomedImage] = useState(null);

  // I-Card states
  const [showICardModal, setShowICardModal] = useState(false);
  const [isEditingICard, setIsEditingICard] = useState(false);
  const [icardTargetUser, setIcardTargetUser] = useState(null);
  const [icardData, setIcardData] = useState({
    dob: '1998-04-12',
    bloodGroup: 'O+',
    emergencyContact: '8460699569'
  });

  const dateCounts = useMemo(() => {
    const counts = {};
    tasks.forEach(t => {
      const date = t.Created_At || t.Scheduled_Date;
      if (date) {
        counts[date] = (counts[date] || 0) + 1;
      }
    });
    return Object.entries(counts).sort((a, b) => b[0].localeCompare(a[0])); // newest first
  }, [tasks]);

  const userCounts = useMemo(() => {
    const counts = {};
    tasks.forEach(t => {
      const creator = t.Created_By || t.Assigned_Staff || 'Unknown';
      counts[creator] = (counts[creator] || 0) + 1;
    });
    return counts;
  }, [tasks]);

  const [staffList, setStaffList] = useState([]);
  const [customers, setCustomers] = useState([]);

  // O(1) customer lookup by Customer_ID or Company_Name, rebuilt only when the customers
  // list changes — replaces repeated customers.find(...) linear scans inside task list renders
  // and search filters, which were O(n*m) and re-ran on every unrelated re-render.
  const { customersById, customersByName } = useMemo(() => {
    const byId = new Map();
    const byName = new Map();
    customers.forEach(c => {
      if (c.Customer_ID) byId.set(String(c.Customer_ID).trim().toLowerCase(), c);
      if (c.Company_Name) byName.set(String(c.Company_Name).trim().toLowerCase(), c);
    });
    return { customersById: byId, customersByName: byName };
  }, [customers]);

  const findCustomerForTask = (t) => {
    if (!t) return {};
    const id = t.Customer_ID ? customersById.get(String(t.Customer_ID).trim().toLowerCase()) : null;
    if (id) return id;
    const name = t.Customer_Name ? customersByName.get(String(t.Customer_Name).trim().toLowerCase()) : null;
    return name || {};
  };

  const [logs, setLogs] = useState([]);
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [attStaffFilter, setAttStaffFilter] = useState(() => localStorage.getItem('expert_admin_att_staff_filter') || 'ALL');
  const [attSortOrder, setAttSortOrder] = useState('DESC'); // 'DESC' | 'ASC'
  const [attMonthFilter, setAttMonthFilter] = useState(() => localStorage.getItem('expert_admin_att_month_filter') || 'ALL'); // 'ALL' or 'YYYY-MM'
  const [attStatusFilter, setAttStatusFilter] = useState(() => localStorage.getItem('expert_admin_att_status_filter') || 'ALL'); // 'ALL' | 'ON_TIME' | 'LATE'
  const [attSearchQuery, setAttSearchQuery] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem('expert_admin_active_tab', activeTab);
      localStorage.setItem('expert_admin_filter_status', filterStatus);
      if (expandedOverviewModule) localStorage.setItem('expert_admin_expanded_module', expandedOverviewModule);
      else localStorage.removeItem('expert_admin_expanded_module');
      localStorage.setItem('expert_admin_att_staff_filter', attStaffFilter);
      localStorage.setItem('expert_admin_att_month_filter', attMonthFilter);
      localStorage.setItem('expert_admin_att_status_filter', attStatusFilter);
    } catch (e) {}
  }, [activeTab, filterStatus, expandedOverviewModule, attStaffFilter, attMonthFilter, attStatusFilter]);

  const attAvailableMonths = useMemo(() => {
    const monthsSet = new Set();
    const today = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      monthsSet.add(d.toISOString().slice(0, 7));
    }
    (attendanceLogs || []).forEach(log => {
      if (log.Date && log.Date.length >= 7) {
        monthsSet.add(log.Date.slice(0, 7));
      }
    });
    return Array.from(monthsSet).sort().reverse();
  }, [attendanceLogs]);

  const formatMonthLabel = (ym) => {
    if (!ym || !ym.includes('-')) return ym;
    const [y, m] = ym.split('-');
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const filteredAttendanceLogs = useMemo(() => {
    return attendanceLogs
      .filter(log => {
        if (attStaffFilter !== 'ALL' && log.Staff_ID !== attStaffFilter) return false;
        if (attMonthFilter !== 'ALL' && !String(log.Date || '').startsWith(attMonthFilter)) return false;
        const lateMins = Number(log.Late_Minutes || log.Late_By_Minutes || 0);
        if (attStatusFilter === 'ON_TIME' && lateMins > 0) return false;
        if (attStatusFilter === 'LATE' && lateMins <= 0) return false;
        if (attSearchQuery.trim()) {
          const q = attSearchQuery.toLowerCase();
          const staffObj = staffList.find(st => st.Staff_ID === log.Staff_ID);
          const matchId = (log.Staff_ID || '').toLowerCase().includes(q);
          const matchName = (staffObj?.Name || '').toLowerCase().includes(q);
          const matchDate = (log.Date || '').toLowerCase().includes(q);
          const matchIp = (log.IP_Address || '').toLowerCase().includes(q);
          if (!matchId && !matchName && !matchDate && !matchIp) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const dateA = new Date(a.Date || 0).getTime();
        const dateB = new Date(b.Date || 0).getTime();
        return attSortOrder === 'ASC' ? dateA - dateB : dateB - dateA;
      });
  }, [attendanceLogs, attStaffFilter, attMonthFilter, attStatusFilter, attSearchQuery, attSortOrder, staffList]);

  const [leaveRequests, setLeaveRequests] = useState([]);
  const [salaryAdvances, setSalaryAdvances] = useState([]);
  const [customerInteractions, setCustomerInteractions] = useState([]);
  const [loading, setLoading] = useState(true);

  // Advance Payment Modal State
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [advanceSubmitting, setAdvanceSubmitting] = useState(false);
  const [advanceForm, setAdvanceForm] = useState({
    staffId: '',
    amount: '',
    paymentMode: 'Cash',
    remarks: ''
  });

  const [showRemarksModal, setShowRemarksModal] = useState(false);
  const [remarkTask, setRemarkTask] = useState(null);
  const [remarkForm, setRemarkForm] = useState({
    type: '',
    remarks: ''
  });
  const [historySearchText, setHistorySearchText] = useState('');
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [isMasterRemarksSearch, setIsMasterRemarksSearch] = useState(false);
  const [masterRemarksSearchQuery, setMasterRemarksSearchQuery] = useState('');
  const [masterRemarksStaffFilter, setMasterRemarksStaffFilter] = useState('ALL');
  const [submittingRemark, setSubmittingRemark] = useState(false);

  // Admin Add Leave Modal State
  const [showAdminLeaveModal, setShowAdminLeaveModal] = useState(false);
  const [adminLeaveSubmitting, setAdminLeaveSubmitting] = useState(false);
  const [adminLeaveForm, setAdminLeaveForm] = useState({
    staffId: '',
    leaveDate: getLocalDateStr(),
    leaveType: 'Full Day',
    reason: 'Granted by Admin'
  });

  // Task Expand & Drag-and-Drop Route Reorder state
  const [expandedTaskIds, setExpandedTaskIds] = useState({});
  const [expandedRemarkTaskIds, setExpandedRemarkTaskIds] = useState({});
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverTaskId, setDragOverTaskId] = useState(null);
  const [reorderingTaskId, setReorderingTaskId] = useState(null);
  const [contactModal, setContactModal] = useState({ isOpen: false, mode: 'CALL', customer: null, task: null });
  const [callReceivedContactPicker, setCallReceivedContactPicker] = useState({ isOpen: false, contacts: [] });

  // Admin Task Action Modal State (Reschedule / Advance / Status / Reactivate)
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeModal, setActiveModal] = useState(null); // 'ADVANCE' | 'RESCHEDULE' | 'STATUS'
  const [adminRemarks, setAdminRemarks] = useState('');
  const [adminNewDate, setAdminNewDate] = useState('');
  const [adminTargetStatus, setAdminTargetStatus] = useState('');
  const [adminTargetStage, setAdminTargetStage] = useState('');
  const [adminAssignedStaff, setAdminAssignedStaff] = useState('');
  const [adminSubmitting, setAdminSubmitting] = useState('');
  const [showOnlyAdminForCert, setShowOnlyAdminForCert] = useState(true);

  // Certificate & Service Report Generator Module State
  const [certificatesRegistry, setCertificatesRegistry] = useState([]);
  const [equipmentMasterList, setEquipmentMasterList] = useState([]);
  const [serviceReportsList, setServiceReportsList] = useState([]);
  const [serviceReportFilter, setServiceReportFilter] = useState('ALL'); // 'ALL' | 'PENDING' | 'APPROVED'

  // Dynamic Task Tags (admin-editable, multi-select labels e.g. "New Inquiry", "Site Visit")
  const [tags, setTags] = useState([]);
  const [activeTagFilters, setActiveTagFilters] = useState([]); // array of tag ids, AND-less OR filter
  const [showTagManagerModal, setShowTagManagerModal] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6366f1');
  const [editingTagId, setEditingTagId] = useState(null);
  const [editingTagDraft, setEditingTagDraft] = useState({ name: '', color: '' });
  const [taskTagPickerId, setTaskTagPickerId] = useState(null); // Task_ID currently showing the tag-picker popover
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [showClientEquipmentModal, setShowClientEquipmentModal] = useState(false);
  const [selectedCustomerForEquipment, setSelectedCustomerForEquipment] = useState(null);
  const getFilteredStaffList = (deptOrStage) => {
    const isCert = deptOrStage === 'Certification' || deptOrStage === 'Certificate';
    if (isCert && showOnlyAdminForCert) {
      const adminList = staffList.filter(s => s.Role === 'Admin' || s.Role === 'ADMIN' || s.Department === 'Certification' || String(s.Staff_ID).toUpperCase() === 'ADMIN' || s.Role === 'Supervisor');
      return adminList.length > 0 ? adminList : staffList;
    }
    return staffList;
  };

  const openAdminModal = (task, type) => {
    setSelectedTask(task);
    setActiveModal(type);
    setAdminRemarks('');
    setAdminNewDate(task?.Scheduled_Date || getLocalDateStr());
    setAdminTargetStatus(task?.Status || '');
    setAdminTargetStage(task?.Stage || '');
    setShowOnlyAdminForCert(true);
    const isCert = task?.Department === 'Certification' || task?.Stage === 'Certificate' || task?.Stage === 'Certification';
    if (isCert) {
      const adminStaff = staffList.filter(s => s.Role === 'Admin' || s.Role === 'ADMIN' || s.Department === 'Certification' || String(s.Staff_ID).toUpperCase() === 'ADMIN' || s.Role === 'Supervisor');
      setAdminAssignedStaff(task?.Assigned_Staff || adminStaff[0]?.Staff_ID || staffList[0]?.Staff_ID || '');
    } else {
      setAdminAssignedStaff(task?.Assigned_Staff || staffList[0]?.Staff_ID || '');
    }
  };

  const closeAdminModal = () => {
    setActiveModal(null);
    setSelectedTask(null);
  };

  const handleAdminReschedule = async (e) => {
    e.preventDefault();
    if (!adminRemarks.trim()) { alert('Please enter reason for rescheduling.'); return; }
    try {
      setAdminSubmitting('reschedule');
      const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ newScheduledDate: adminNewDate, remarks: `[Admin: ${user?.Name || 'Admin'}] ${adminRemarks}`, latLong: '0.0000, 0.0000' })
      });
      if (!res.ok) throw new Error('Reschedule failed');
      closeAdminModal();
      loadAdminData();
    } catch (err) { alert(err.message); }
    finally { setAdminSubmitting(''); }
  };

  const handleAdminAdvanceStage = async (e) => {
    e.preventDefault();
    try {
      setAdminSubmitting('advance');
      const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ remarks: `[Admin: ${user?.Name || 'Admin'}] ${adminRemarks || 'Stage advanced by Admin'}`, latLong: '0.0000, 0.0000' })
      });
      if (!res.ok) throw new Error('Stage advancement failed');
      closeAdminModal();
      loadAdminData();
    } catch (err) { alert(err.message); }
    finally { setAdminSubmitting(''); }
  };

  const handleAdminStatusChange = async (e) => {
    e.preventDefault();
    if (!adminTargetStatus) { alert('Please select a status.'); return; }
    try {
      setAdminSubmitting('status');
      const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status: adminTargetStatus })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.details || errData.error || 'Status update failed');
      }
      closeAdminModal();
      loadAdminData();
    } catch (err) { alert(err.message); }
    finally { setAdminSubmitting(''); }
  };

  const handleAdminAssignTask = async (e) => {
    e.preventDefault();
    if (!adminAssignedStaff) { alert('Please select a staff member.'); return; }
    try {
      setAdminSubmitting('assign');
      const stInfo = staffList.find(s => String(s.Staff_ID) === String(adminAssignedStaff) || s.Name === adminAssignedStaff);
      const staffName = stInfo ? stInfo.Name : adminAssignedStaff;
      const res = await fetch(`/api/tasks/${selectedTask.Task_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          Assigned_Staff: adminAssignedStaff,
          assignedStaff: adminAssignedStaff,
          Assigned_Staff_Name: staffName
        })
      });
      if (!res.ok) throw new Error('Failed to assign task');
      closeAdminModal();
      loadAdminData();
      alert(`✅ Task #${selectedTask.Task_ID} successfully assigned to ${staffName} (${adminAssignedStaff})!`);
    } catch (err) { alert(err.message); }
    finally { setAdminSubmitting(''); }
  };

  const handleAdminReactivateTask = async (task) => {
    try {
      const res = await fetch(`/api/tasks/${task.Task_ID}/reschedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ newScheduledDate: getLocalDateStr(), remarks: `[Admin: ${user?.Name || 'Admin'}] Reactivated closed task` })
      });
      if (!res.ok) throw new Error('Failed to reactivate task');
      loadAdminData();
    } catch (err) { alert(err.message); }
  };

  const handleAdminDeleteTask = async (taskId, desc) => {
    if (!window.confirm(`Permanently delete task "${desc}"?`)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete task');
      loadAdminData();
    } catch (err) { alert(err.message); }
  };

  const toggleTaskExpand = (taskId) => {
    setExpandedTaskIds(prev => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  const toggleRemarkExpand = (taskId) => {
    setExpandedRemarkTaskIds(prev => ({ ...prev, [taskId]: !prev[taskId] }));
  };

  // Auto-collapse the expanded remark/interaction history box when the user taps anywhere outside it.
  useEffect(() => {
    const handleOutsideTap = (e) => {
      setExpandedRemarkTaskIds(prev => {
        if (!Object.values(prev).some(Boolean)) return prev;
        if (e.target.closest && e.target.closest('[data-remark-history-box]')) return prev;
        return {};
      });
    };
    document.addEventListener('mousedown', handleOutsideTap);
    document.addEventListener('touchstart', handleOutsideTap);
    return () => {
      document.removeEventListener('mousedown', handleOutsideTap);
      document.removeEventListener('touchstart', handleOutsideTap);
    };
  }, []);

  const handleApproveRemoval = async (taskId, desc) => {
    if (!window.confirm(`Approve removal and permanently delete task "${desc}"?`)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to delete task');
      loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRejectRemoval = async (taskId) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/reject-removal`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to reject task removal');
      loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const autoScrollYRef = useRef(0);
  const autoScrollActiveRef = useRef(false);
  const autoScrollRafRef = useRef(null);

  const stopAutoScroll = () => {
    autoScrollActiveRef.current = false;
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  };

  const runAutoScrollLoop = () => {
    if (!autoScrollActiveRef.current) return;
    const clientY = autoScrollYRef.current;
    const threshold = 150;
    const maxSpeed = 22;
    if (clientY > 0 && clientY < threshold) {
      const intensity = (threshold - clientY) / threshold;
      window.scrollBy(0, -Math.ceil(maxSpeed * intensity));
    } else if (clientY > window.innerHeight - threshold) {
      const intensity = Math.min(1, (clientY - (window.innerHeight - threshold)) / threshold);
      window.scrollBy(0, Math.ceil(maxSpeed * intensity));
    }
    autoScrollRafRef.current = requestAnimationFrame(runAutoScrollLoop);
  };

  const startAutoScroll = () => {
    if (autoScrollActiveRef.current) return;
    autoScrollActiveRef.current = true;
    autoScrollRafRef.current = requestAnimationFrame(runAutoScrollLoop);
  };

  // Continuously auto-scrolls the page while a task is being dragged near the
  // top/bottom edge, driven by rAF rather than the drag/touch event cadence —
  // dragover/touchmove don't fire reliably while the pointer is held still near an edge.
  const handleAutoScroll = (clientY) => {
    if (!clientY) return;
    autoScrollYRef.current = clientY;
    startAutoScroll();
  };

  useEffect(() => stopAutoScroll, []);

  // Close the per-task tag picker popover when clicking anywhere else
  useEffect(() => {
    if (!taskTagPickerId) return;
    const onDocClick = () => setTaskTagPickerId(null);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [taskTagPickerId]);

  // Track pointer position at the document level while dragging — the sticky navbar
  // (z-40) sits on top of the page once scrolled and has no drag/touch handlers, so
  // per-row dragover/touchmove events stop firing once the pointer crosses under it,
  // freezing the tracked Y position and breaking upward auto-scroll near the top edge.
  useEffect(() => {
    if (!draggedTaskId) return;
    const onDragOverDoc = (e) => handleAutoScroll(e.clientY);
    const onTouchMoveDoc = (e) => {
      const touch = e.touches[0];
      if (touch) handleAutoScroll(touch.clientY);
    };
    document.addEventListener('dragover', onDragOverDoc);
    document.addEventListener('touchmove', onTouchMoveDoc, { passive: true });
    return () => {
      document.removeEventListener('dragover', onDragOverDoc);
      document.removeEventListener('touchmove', onTouchMoveDoc);
    };
  }, [draggedTaskId]);

  const ORDER_KEY = 'expert_safety_task_sequence_order';

  const sortTasksByOrder = (taskList) => {
    if (!Array.isArray(taskList)) return taskList;
    try {
      const rawOrder = localStorage.getItem(ORDER_KEY);
      if (!rawOrder) return taskList;
      const orderArr = JSON.parse(rawOrder);
      if (!Array.isArray(orderArr) || orderArr.length === 0) return taskList;
      return [...taskList].sort((a, b) => {
        const idxA = orderArr.indexOf(a.Task_ID);
        const idxB = orderArr.indexOf(b.Task_ID);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
    } catch {
      return taskList;
    }
  };

  const saveTasksOrder = async (taskList) => {
    try {
      const orderArr = taskList.map(t => t.Task_ID);
      localStorage.setItem(ORDER_KEY, JSON.stringify(orderArr));

      if (filterSelectedUsers.length === 1) {
        const selectedStaffNameOrId = filterSelectedUsers[0];
        const staffMember = staffList.find(s => s.Name === selectedStaffNameOrId || s.Staff_ID === selectedStaffNameOrId);
        if (staffMember?.Staff_ID) {
          const staffTaskIds = taskList
            .filter(t => t.Assigned_Staff === staffMember.Staff_ID || t.Assigned_Staff_Name === staffMember.Name)
            .map(t => t.Task_ID);

          await fetch(`/api/staff/${staffMember.Staff_ID}/task-order`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ taskOrder: staffTaskIds })
          });

          setStaffList(prev => prev.map(s => s.Staff_ID === staffMember.Staff_ID ? { ...s, Task_Order: staffTaskIds } : s));
        }
      }
    } catch { }
  };

  const handleDropTask = (fromTaskId, toTaskId) => {
    stopAutoScroll();
    if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) {
      setDraggedTaskId(null);
      setDragOverTaskId(null);
      return;
    }
    const fromIdx = tasks.findIndex(t => t.Task_ID === fromTaskId);
    const toIdx = tasks.findIndex(t => t.Task_ID === toTaskId);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggedTaskId(null);
      setDragOverTaskId(null);
      return;
    }
    const newTasks = [...tasks];
    const [movedItem] = newTasks.splice(fromIdx, 1);
    newTasks.splice(toIdx, 0, movedItem);
    setTasks(newTasks);
    saveTasksOrder(newTasks);
    setDraggedTaskId(null);
    setDragOverTaskId(null);
  };

  // --- DYNAMIC TASK TAGS (admin-editable multi-select labels, independent of workflow Stage/Status) ---
  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newTagName.trim(), color: newTagColor })
      });
      if (!res.ok) throw new Error('Failed to create tag');
      const data = await res.json();
      setTags(prev => [...prev, data.tag]);
      setNewTagName('');
      setNewTagColor('#6366f1');
    } catch (err) { alert(err.message); }
  };

  const handleUpdateTag = async (tagId) => {
    if (!editingTagDraft.name.trim()) return;
    try {
      const res = await fetch(`/api/tags/${tagId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: editingTagDraft.name.trim(), color: editingTagDraft.color })
      });
      if (!res.ok) throw new Error('Failed to update tag');
      setTags(prev => prev.map(t => t.Tag_ID === tagId ? { ...t, name: editingTagDraft.name.trim(), color: editingTagDraft.color } : t));
      setEditingTagId(null);
    } catch (err) { alert(err.message); }
  };

  const handleDeleteTag = async (tagId) => {
    if (!window.confirm('Delete this tag? It will be removed from all tasks that use it.')) return;
    try {
      const res = await fetch(`/api/tags/${tagId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to delete tag');
      setTags(prev => prev.filter(t => t.Tag_ID !== tagId));
      setActiveTagFilters(prev => prev.filter(id => id !== tagId));
      setTasks(prev => prev.map(t => (t.Tags || []).includes(tagId) ? { ...t, Tags: t.Tags.filter(id => id !== tagId) } : t));
    } catch (err) { alert(err.message); }
  };

  const handleToggleTaskTag = async (task, tagId) => {
    const current = Array.isArray(task.Tags) ? task.Tags : [];
    const nextTags = current.includes(tagId) ? current.filter(id => id !== tagId) : [...current, tagId];
    setTasks(prev => prev.map(t => t.Task_ID === task.Task_ID ? { ...t, Tags: nextTags } : t));
    try {
      const res = await fetch(`/api/tasks/${task.Task_ID}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tags: nextTags })
      });
      if (!res.ok) throw new Error('Failed to save tags');
    } catch (err) {
      alert(err.message);
      setTasks(prev => prev.map(t => t.Task_ID === task.Task_ID ? { ...t, Tags: current } : t));
    }
  };

  const handleTagInputSubmit = async (task) => {
    const query = (tagSearchQuery || '').trim();
    if (!query) return;
    
    const matched = tags.find(t => (t.name || '').toLowerCase() === query.toLowerCase());
    if (matched) {
      await handleToggleTaskTag(task, matched.Tag_ID);
      setTagSearchQuery('');
    } else {
      if (user?.role === 'Admin') {
        await handleCreateAndAddTag(task, query);
      } else {
        alert(`Tag "${query}" not found. Only administrators can create new tags.`);
      }
    }
  };

  const handleCreateAndAddTag = async (task, tagName) => {
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: tagName, color: '#6366f1' })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create tag');
      }
      const data = await res.json();
      const newTag = data.tag;
      
      setTags(prev => [...prev, newTag]);
      await handleToggleTaskTag(task, newTag.Tag_ID);
      setTagSearchQuery('');
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleTagFilter = (tagId) => {
    setActiveTagFilters(prev => prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]);
  };

  const handleMoveTaskOrder = (taskId, direction, currentList = filteredTasks) => {
    if (!currentList || !Array.isArray(currentList)) return;
    const listIdx = currentList.findIndex(t => t.Task_ID === taskId);
    if (listIdx === -1) return;
    const targetListIdx = listIdx + direction;
    if (targetListIdx < 0 || targetListIdx >= currentList.length) return;

    const targetTaskId = currentList[targetListIdx].Task_ID;
    handleDropTask(taskId, targetTaskId);
  };

  // Salary Override Modal State
  const [salaryModalRecord, setSalaryModalRecord] = useState(null);
  const [salaryOverrideAmount, setSalaryOverrideAmount] = useState('');
  const [savingSalary, setSavingSalary] = useState(false);

  // New task creation modal state
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showEditTaskModal, setShowEditTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);
  const [showNewStaffModal, setShowNewStaffModal] = useState(false);
  const [passwordResetTarget, setPasswordResetTarget] = useState(null); // staff object being reset
  const [passwordResetForm, setPasswordResetForm] = useState({ adminPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordResetError, setPasswordResetError] = useState('');
  const [passwordResetSubmitting, setPasswordResetSubmitting] = useState(false);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [changePasswordForm, setChangePasswordForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [changePasswordError, setChangePasswordError] = useState('');
  const [changePasswordSubmitting, setChangePasswordSubmitting] = useState(false);
  const [showStaffAccessModal, setShowStaffAccessModal] = useState(false);
  const [creatingStaff, setCreatingStaff] = useState(false);
  const [newStaffForm, setNewStaffForm] = useState({
    name: '',
    email: '',
    mobile: '',
    role: 'Staff',
    department: 'Field Operations',
    dailySalaryRate: 1000,
    permissions: 'ASSIGNED_ONLY',
    password: ''
  });

  // New Task form state
  const [taskForm, setTaskForm] = useState({
    customerId: '',
    description: '',
    assignedStaff: '',
    department: 'Sales',
    type: 'One-time',
    scheduledDate: getLocalDateStr(),
    recurringInterval: 'Monthly',
    recurringPeriod: { type: 'Monthly', value: 1 }
  });
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [isNewCustomerMode, setIsNewCustomerMode] = useState(false);

  // New Customer form state
  const [customerForm, setCustomerForm] = useState({
    companyName: '',
    authPerson: '',
    contact: '',
    email: '',
    locationLink: '',
    address: '',
    contacts: [{ name: '', designation: '', contactNumber: '', email: '' }]
  });

  // Client Profile 360 Modal state
  const [selectedCustomerFor360, setSelectedCustomerFor360] = useState(null);
  const [selectedCustomerModal, setSelectedCustomerModal] = useState(null);
  const [interactionForm, setInteractionForm] = useState({ type: 'Call Logged', remarks: '' });
  const [newInteractionRemark, setNewInteractionRemark] = useState('');
  const [newInteractionType, setNewInteractionType] = useState('Note / Follow-up');
  const [loggingInteraction, setLoggingInteraction] = useState(false);

  // Admin profile popup (triggered from Navbar avatar click)
  const [showAdminProfilePopup, setShowAdminProfilePopup] = useState(false);
  // Staff member profile viewer (click on any staff card in the Staff tab)
  const [selectedStaffProfile, setSelectedStaffProfile] = useState(null);

  // Edit Customer modal state
  const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [editCustomerForm, setEditCustomerForm] = useState({
    companyName: '', authPerson: '', contact: '', email: '',
    locationLink: '', address: '', specialNotes: '',
    coordinators: []
  });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [isEditCustomerGpsUnlocked, setIsEditCustomerGpsUnlocked] = useState(false);
  const [isNewCustomerGpsUnlocked, setIsNewCustomerGpsUnlocked] = useState(false);
  const [isEditCustomerNotesUnlocked, setIsEditCustomerNotesUnlocked] = useState(false);

  const lastSyncRef = useRef(0);

  // Intercept back button to close modals instead of exiting/closing the app
  useEffect(() => {
    const isAnyModalOpen = showStaffProgressReport ||
                           showRemarksModal ||
                           showAdvanceModal ||
                           showAdminLeaveModal ||
                           showTagManagerModal ||
                           showClientEquipmentModal ||
                           showNewTaskModal ||
                           showEditTaskModal ||
                           showNewCustomerModal ||
                           showNewStaffModal ||
                           showChangePasswordModal ||
                           showStaffAccessModal ||
                           showAdminProfilePopup ||
                           showEditCustomerModal ||
                           showFilterModal ||
                           showCompanyDetailsModal ||
                           showICardModal ||
                           Boolean(zoomedImage) ||
                           Boolean(selectedStaffProfile) ||
                           (contactModal && contactModal.isOpen) ||
                           Boolean(activeModal);

    if (isAnyModalOpen) {
      if (window.history.state?.modalOpen !== true) {
        window.history.pushState({ modalOpen: true }, '');
      }
    } else {
      if (window.history.state?.modalOpen === true) {
        window.history.back();
      }
    }

    const handlePopState = (e) => {
      if (isAnyModalOpen) {
        // Prevent default back behavior by closing modals
        if (zoomedImage) {
          setZoomedImage(null);
        } else {
          setShowStaffProgressReport(false);
          setShowRemarksModal(false);
          setShowAdvanceModal(false);
          setShowAdminLeaveModal(false);
          setShowTagManagerModal(false);
          setShowClientEquipmentModal(false);
          setShowNewTaskModal(false);
          setShowEditTaskModal(false);
          setShowNewCustomerModal(false);
          setShowNewStaffModal(false);
          setShowChangePasswordModal(false);
          setShowStaffAccessModal(false);
          setShowAdminProfilePopup(false);
          setShowEditCustomerModal(false);
          setShowFilterModal(false);
          setShowCompanyDetailsModal(false);
          setShowICardModal(false);
          setSelectedStaffProfile(null);
          if (contactModal) setContactModal(prev => ({ ...prev, isOpen: false }));
          setActiveModal(null);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [
    showStaffProgressReport,
    showRemarksModal,
    showAdvanceModal,
    showAdminLeaveModal,
    showTagManagerModal,
    showClientEquipmentModal,
    showNewTaskModal,
    showEditTaskModal,
    showNewCustomerModal,
    showNewStaffModal,
    showChangePasswordModal,
    showStaffAccessModal,
    showAdminProfilePopup,
    showEditCustomerModal,
    showFilterModal,
    showCompanyDetailsModal,
    showICardModal,
    zoomedImage,
    selectedStaffProfile,
    contactModal,
    activeModal
  ]);

  const enrichTasksWithCustomers = (taskList, custList) => {
    if (!Array.isArray(taskList)) return taskList;
    const cList = Array.isArray(custList) ? custList : [];
    return taskList.map(t => {
      const custId = String(t.Customer_ID || '').trim().toLowerCase();
      const customer = cList.find(c => String(c.Customer_ID || '').trim().toLowerCase() === custId) || {};
      const company = customer.Company_Name || t.Customer_Name;
      return {
        ...t,
        Customer_Name: (company && company !== 'Unknown Company') ? company : (t.Customer_ID ? `Customer (${t.Customer_ID})` : 'General Client'),
        Customer_Contact: customer.Contact || t.Customer_Contact || '',
        Customer_Auth_Person: customer.Auth_Person || t.Customer_Auth_Person || '',
        Customer_Location_Link: customer.Location_Link || t.Customer_Location_Link || '',
        Customer_Address: customer.Address || t.Customer_Address || '',
        Customer_Coordinators: customer.Coordinators || t.Customer_Coordinators || ''
      };
    });
  };

  const loadAdminData = async (silent = false) => {
    const isSilent = typeof silent === 'boolean' ? silent : false;
    try {
      if (!isSilent) setLoading(true);
      const res = await fetch('/api/sync/all', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const cList = data.customers || customers;
        if (data.analytics) setAnalytics(data.analytics);
        if (data.customers) setCustomers(cList);
        if (data.staff) setStaffList(data.staff);
        if (data.logs) setLogs(data.logs);
        if (data.attendance) setAttendanceLogs(data.attendance);
        if (data.leaves) setLeaveRequests(data.leaves);
        if (data.customerInteractions) setCustomerInteractions(data.customerInteractions);
        if (data.advances) setSalaryAdvances(data.advances);
        if (data.certificates) setCertificatesRegistry(data.certificates);
        if (data.equipmentMaster) setEquipmentMasterList(data.equipmentMaster);
        if (data.serviceReports) setServiceReportsList(data.serviceReports);
        if (data.tags) setTags(data.tags);
        if (data.tasks) {
          const enriched = enrichTasksWithCustomers(data.tasks, cList);
          setTasks(sortTasksByOrder(enriched));
        }
        lastSyncRef.current = Date.now();
        try {
          localStorage.setItem('expert_admin_sync_cache_v1', JSON.stringify({
            analytics: data.analytics,
            tasks: data.tasks,
            staff: data.staff,
            customers: data.customers,
            logs: data.logs,
            attendance: data.attendance,
            leaves: data.leaves,
            customerInteractions: data.customerInteractions,
            advances: data.advances,
            timestamp: Date.now()
          }));
        } catch (e) {}
      } else {
        await loadAdminDataSeparate(isSilent);
      }
    } catch (err) {
      console.error('Failed to load admin dashboard data:', err);
      if (!isSilent) await loadAdminDataSeparate(isSilent);
    } finally {
      if (!isSilent) setLoading(false);
    }
  };

  const loadAdminDataSeparate = async (silent = false) => {
    try {
      const [resAnal, resTasks, resStaff, resCust, resLogs, resAtt, resLev, resInt, resAdv, resCert, resEquip, resTags] = await Promise.all([
        fetch('/api/analytics', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/tasks?all=true', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/staff', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/customers', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/logs', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/attendance', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/leaves', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/customer-interactions', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/advances?all=true', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/certificates', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/equipment-master', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/tags', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      if (resAnal.ok) setAnalytics(await resAnal.json());
      if (resCust.ok) setCustomers(await resCust.json());
      if (resTasks.ok) {
        const tData = await resTasks.json();
        const enriched = enrichTasksWithCustomers(tData, customers);
        setTasks(sortTasksByOrder(enriched));
      }
      if (resStaff.ok) setStaffList(await resStaff.json());
      if (resLogs.ok) setLogs(await resLogs.json());
      if (resAtt.ok) setAttendanceLogs(await resAtt.json());
      if (resLev.ok) setLeaveRequests(await resLev.json());
      if (resInt.ok) setCustomerInteractions(await resInt.json());
      if (resAdv.ok) setSalaryAdvances(await resAdv.json());
      try {
        if (resCert.ok) setCertificatesRegistry(await resCert.json());
        if (resEquip.ok) setEquipmentMasterList(await resEquip.json());
        if (resTags.ok) setTags(await resTags.json());
      } catch (e) {}
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (icardTargetUser) {
      const staffId = icardTargetUser.Staff_ID || icardTargetUser.staffId || 'default';
      const key = `expert_icard_data_${staffId}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          setIcardData(JSON.parse(saved));
        } catch (e) {
          setIcardData({
            dob: '1998-04-12',
            bloodGroup: 'O+',
            emergencyContact: '8460699569'
          });
        }
      } else {
        setIcardData({
          dob: '1998-04-12',
          bloodGroup: 'O+',
          emergencyContact: icardTargetUser.Mobile || '8460699569'
        });
      }
    }
  }, [icardTargetUser]);

  useEffect(() => {
    // 1. Instant Zero-Time Load from Cache
    try {
      const cached = localStorage.getItem('expert_admin_sync_cache_v1');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.tasks) {
          if (parsed.analytics) setAnalytics(parsed.analytics);
          const cList = parsed.customers || customers;
          if (parsed.customers) setCustomers(cList);
          if (parsed.staff) setStaffList(parsed.staff);
          if (parsed.logs) setLogs(parsed.logs);
          if (parsed.attendance) setAttendanceLogs(parsed.attendance);
          if (parsed.leaves) setLeaveRequests(parsed.leaves);
          if (parsed.customerInteractions) setCustomerInteractions(parsed.customerInteractions);
          if (parsed.advances) setSalaryAdvances(parsed.advances);
          const enriched = enrichTasksWithCustomers(parsed.tasks || [], cList);
          setTasks(sortTasksByOrder(enriched));
          setLoading(false);
        }
      }
    } catch (e) {}

    // 2. Immediate Background Revalidation
    loadAdminData(true);

    // 3. Focus & Visibility Auto-Sync (Instant reflection when Staff or Desktop updates)
    const handleFocusSync = () => {
      const now = Date.now();
      if (now - lastSyncRef.current > 3000) {
        loadAdminData(true);
      }
    };
    window.addEventListener('focus', handleFocusSync);
    const handleVis = () => { if (document.visibilityState === 'visible') handleFocusSync(); };
    document.addEventListener('visibilitychange', handleVis);

    // 4. Background polling — kept lighter on mobile since focus/visibility handlers above
    // already trigger an instant sync the moment the user actually looks at the screen.
    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadAdminData(true);
      }
    }, 20000);

    return () => {
      window.removeEventListener('focus', handleFocusSync);
      document.removeEventListener('visibilitychange', handleVis);
      clearInterval(pollInterval);
    };
  }, [token]);

  useEffect(() => {
    const openPopup = () => setShowAdminProfilePopup(true);
    window.addEventListener('OPEN_STAFF_PROFILE_POPUP', openPopup);
    return () => window.removeEventListener('OPEN_STAFF_PROFILE_POPUP', openPopup);
  }, []);

  useEffect(() => {
    const handleNav = (e) => {
      const n = e.detail;
      if (!n) return;
      setLastNotificationTab(activeTab || 'OVERVIEW');
      if (n.targetType === 'LEAVE') {
        setActiveTab('ATTENDANCE');
        setTimeout(() => document.getElementById('section-leave-queue')?.scrollIntoView({ behavior: 'smooth' }), 150);
      } else if (n.targetType === 'TASK') {
        setActiveTab('PIPELINE');
        if (n.targetId) setSearchQuery(n.targetId);
        setTimeout(() => document.getElementById('section-pipeline-list')?.scrollIntoView({ behavior: 'smooth' }), 150);
      } else if (n.targetType === 'STAFF') {
        setActiveTab('STAFF');
        setTimeout(() => document.getElementById('section-staff-roster')?.scrollIntoView({ behavior: 'smooth' }), 150);
      } else if (n.targetType === 'ADVANCE') {
        setActiveTab('ATTENDANCE');
        setTimeout(() => document.getElementById('section-attendance-logs')?.scrollIntoView({ behavior: 'smooth' }), 150);
      }
    };
    window.addEventListener('NAVIGATE_TO_TARGET', handleNav);
    return () => window.removeEventListener('NAVIGATE_TO_TARGET', handleNav);
  }, [activeTab]);

  const handleLeaveStatusUpdate = async (requestId, status) => {
    try {
      const res = await fetch('/api/leaves/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ requestId, status })
      });
      if (!res.ok) throw new Error('Failed to update leave status');
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSalaryOverrideSubmit = async (e) => {
    e.preventDefault();
    if (!salaryModalRecord) return;
    try {
      setSavingSalary(true);
      const res = await fetch('/api/attendance/salary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          recordId: salaryModalRecord.Record_ID,
          overrideSalary: Number(salaryOverrideAmount)
        })
      });
      if (!res.ok) throw new Error('Salary override failed');
      setSalaryModalRecord(null);
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingSalary(false);
    }
  };

  const handleUpdateStaffDailyRate = async (staffId, newRate) => {
    try {
      const res = await fetch('/api/staff/salary-rate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ staffId, dailySalaryRate: Number(newRate) })
      });
      if (!res.ok) throw new Error('Failed to update daily salary rate');
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateStaffSubmit = async (e) => {
    e.preventDefault();
    try {
      setCreatingStaff(true);
      const res = await fetch('/api/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(newStaffForm)
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to create staff member');
      }
      setShowNewStaffModal(false);
      setNewStaffForm({
        name: '',
        email: '',
        mobile: '',
        role: 'Staff',
        department: 'Field Operations',
        dailySalaryRate: 1000,
        permissions: 'ASSIGNED_ONLY',
        password: ''
      });
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setCreatingStaff(false);
    }
  };

  const handleDeleteStaff = async (staffId, staffName) => {
    if (!window.confirm(`Are you sure you want to remove staff member ${staffName} (${staffId})?`)) return;
    try {
      const res = await fetch(`/api/staff/${staffId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to remove staff member');
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleUpdateStaffPermission = async (staffId, newPerm) => {
    try {
      const res = await fetch(`/api/staff/${staffId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ Permissions: newPerm })
      });
      if (!res.ok) throw new Error('Failed to update staff access permissions');
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleAdminSetStaffPassword = async (e) => {
    e.preventDefault();
    setPasswordResetError('');
    const { adminPassword, newPassword, confirmPassword } = passwordResetForm;
    if (!adminPassword || !newPassword || !confirmPassword) {
      setPasswordResetError('All fields are required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordResetError('New password and confirmation do not match.');
      return;
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) {
      setPasswordResetError(policyError);
      return;
    }
    try {
      setPasswordResetSubmitting(true);
      const res = await fetch(`/api/staff/${passwordResetTarget.Staff_ID}/set-password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ adminPassword, newPassword, confirmPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set password');
      alert(`Password updated for ${passwordResetTarget.Name} (${passwordResetTarget.Staff_ID}).`);
      setPasswordResetTarget(null);
      setPasswordResetForm({ adminPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setPasswordResetError(err.message);
    } finally {
      setPasswordResetSubmitting(false);
    }
  };

  const handleChangeMyPassword = async (e) => {
    e.preventDefault();
    setChangePasswordError('');
    const { oldPassword, newPassword, confirmPassword } = changePasswordForm;
    if (!oldPassword || !newPassword || !confirmPassword) {
      setChangePasswordError('All fields are required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePasswordError('New password and confirmation do not match.');
      return;
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) {
      setChangePasswordError(policyError);
      return;
    }
    try {
      setChangePasswordSubmitting(true);
      const res = await fetch('/api/auth/change-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ oldPassword, newPassword, confirmPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to change password');
      alert('Your password has been updated.');
      setShowChangePasswordModal(false);
      setChangePasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setChangePasswordError(err.message);
    } finally {
      setChangePasswordSubmitting(false);
    }
  };

  const handleRecordAdvanceSubmit = async (e) => {
    e.preventDefault();
    try {
      setAdvanceSubmitting(true);
      const res = await fetch('/api/advances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(advanceForm)
      });
      if (!res.ok) throw new Error('Failed to record advance payment');
      setShowAdvanceModal(false);
      setAdvanceForm({ staffId: '', amount: '', paymentMode: 'Cash', remarks: '' });
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setAdvanceSubmitting(false);
    }
  };

  const handleDeleteAdvance = async (advId) => {
    if (!window.confirm('Delete this advance payment record?')) return;
    try {
      await fetch(`/api/advances/${advId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      await loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleLogCustomerCall = async (cust) => {
    try {
      await fetch('/api/customer-interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          customerId: cust.Customer_ID,
          type: 'Call Logged',
          remarks: `Call Button Pressed — Contacted ${cust.Auth_Person || cust.Company_Name} at ${cust.Contact}`
        })
      });
      const resInt = await fetch('/api/customer-interactions', { headers: { 'Authorization': `Bearer ${token}` } });
      if (resInt.ok) setCustomerInteractions(await resInt.json());
    } catch (err) {
      console.error('Call logging error:', err);
    }
  };

  // Opens the Discussion Log modal pre-tagged as 'Call'/'WhatsApp' with a prefilled title line,
  // and expands the task's remark history so it's visible right away — admin/staff just add
  // their notes below the title and save (no need to hunt for the tag in the dropdown).
  const triggerQuickInteraction = (type, task, contactName) => {
    if (!task) return;
    const staffName = user?.Name || user?.Staff_ID || 'Staff';
    const label = type === 'WhatsApp' ? 'WhatsApp Messaged' : 'Call Dialed';
    setRemarkTask(task);
    setRemarkForm({ type, remarks: `${label}: ${staffName} - ${contactName || 'Contact'}\n` });
    setShowTagList(false);
    setShowRemarkInputs(true);
    setShowRemarksModal(true);
    setExpandedRemarkTaskIds(prev => ({ ...prev, [task.Task_ID]: true }));
  };

  // Fills the Discussion Log's remarks with a title line for a client-initiated call, e.g.
  // "Call Received: Parth - Nilesh" — contact name first (they called), staff name second.
  const applyCallReceivedTag = (contactName) => {
    const staffName = user?.Name || user?.Staff_ID || 'Staff';
    setRemarkForm({ type: 'Call Received', remarks: `Call Received: ${contactName} - ${staffName}\n` });
    setShowTagList(false);
    setCallReceivedContactPicker({ isOpen: false, contacts: [] });
  };

  // Tag-dropdown click handler for the Discussion Log modal. 'Call Received' needs to know which
  // client contact called in, so when the customer has more than one contact on file it opens a
  // small picker first instead of assigning the tag immediately.
  const handleRemarkTagSelect = (tag) => {
    if (tag === 'Call Received') {
      const custObj = customersById.get(String(remarkTask?.Customer_ID || '').trim().toLowerCase()) || {};
      const contacts = getAvailableContacts(custObj, remarkTask);
      if (contacts.length > 1) {
        setCallReceivedContactPicker({ isOpen: true, contacts });
        return;
      }
      const contactName = contacts[0]?.name || custObj.Auth_Person || custObj.Company_Name || remarkTask?.Customer_Name || 'Client';
      applyCallReceivedTag(contactName);
      return;
    }
    setRemarkForm({ ...remarkForm, type: tag });
    setShowTagList(false);
  };

  const handlePhoneButtonClick = (custObj, task = null) => {
    const contacts = getAvailableContacts(custObj, task);
    if (contacts.length === 0) {
      alert('No contact number found for this customer');
      return;
    }
    if (contacts.length === 1) {
      if (task) {
        triggerQuickInteraction('Call', task, contacts[0].name);
      } else if (custObj?.Customer_ID) {
        handleLogCustomerCall(custObj);
      }
      window.location.href = `tel:${formatDialerNumber(contacts[0].cleanPhone)}`;
      return;
    }
    setContactModal({ isOpen: true, mode: 'CALL', customer: custObj, task });
  };

  const handleLogInteractionSubmit = async (e, custId) => {
    e.preventDefault();
    if (!interactionForm.remarks.trim()) return;
    try {
      setLoggingInteraction(true);
      const res = await fetch('/api/customer-interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          customerId: custId,
          type: interactionForm.type,
          remarks: interactionForm.remarks
        })
      });
      if (res.ok) {
        const newInt = await res.json();
        setCustomerInteractions(prev => [newInt, ...prev]);
        setInteractionForm({ type: 'Call Logged', remarks: '' });
        setShowInteractionTagList(true);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoggingInteraction(false);
    }
  };

  const handleEditTaskSubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/tasks/${editingTask.Task_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          description: editingTask.Description,
          scheduledDate: editingTask.Scheduled_Date,
          type: editingTask.Type,
          recurringInterval: editingTask.Recurring_Interval,
          recurringPeriod: editingTask.Type === 'Recurring' ? editingTask.Recurring_Period : undefined,
          assignedStaff: editingTask.Assigned_Staff,
          department: editingTask.Department,
          remarks: editingTask.Remarks,
          stage: editingTask.Stage,
          Updated_By: user?.Name || user?.Staff_ID || 'Admin',
          Updated_At: new Date().toISOString()
        })
      });
      if (!res.ok) throw new Error('Failed to update task');
      setShowEditTaskModal(false);
      setEditingTask(null);
      loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateTask = async (e) => {
    e.preventDefault();
    try {
      let targetCustomerId = selectedCustomer?.Customer_ID || taskForm.customerId;

      if (isNewCustomerMode) {
        if (!customerForm.companyName.trim()) {
          alert('Please enter Company Name');
          return;
        }
        const custRes = await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            companyName: customerForm.companyName,
            authPerson: customerForm.authPerson,
            contact: customerForm.contact,
            email: customerForm.email,
            locationLink: customerForm.locationLink,
            address: customerForm.address,
            contacts: customerForm.contacts
          })
        });
        if (!custRes.ok) throw new Error('Failed to save customer to database');
        const createdCust = await custRes.json();
        targetCustomerId = createdCust.Customer_ID;
      } else if (!targetCustomerId) {
        alert('Please select a company from Customer Database or click "+ New Customer"');
        return;
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          ...taskForm,
          customerId: targetCustomerId,
          stage: 'New Inquiry',
          recurringPeriod: taskForm.type === 'Recurring' ? taskForm.recurringPeriod : undefined,
          recurringInterval: taskForm.type === 'Recurring' ? taskForm.recurringInterval : undefined,
          Created_By: user?.Name || user?.Staff_ID || 'Admin',
          Updated_By: user?.Name || user?.Staff_ID || 'Admin'
        })
      });
      if (!res.ok) throw new Error('Failed to create task');
      setShowNewTaskModal(false);
      setSelectedCustomer(null);
      setIsNewCustomerMode(false);
      loadAdminData();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateCustomer = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(customerForm)
      });
      if (!res.ok) throw new Error('Failed to create customer');
      setShowNewCustomerModal(false);
      loadAdminData();
    } catch (err) {
    }
  };

  const handleEditCustomerSubmit = async (e) => {
    e.preventDefault();
    if (!editingCustomer) return;
    try {
      setSavingCustomer(true);
      const res = await fetch(`/api/customers/${editingCustomer.Customer_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(editCustomerForm)
      });
      if (!res.ok) throw new Error('Failed to update customer');
      setShowEditCustomerModal(false);
      setEditingCustomer(null);
      loadAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingCustomer(false);
    }
  };

  const [fetchingLocationFor, setFetchingLocationFor] = useState(null);

  const handleFetchAndSaveCustomerGps = async (customerObj, taskId = null) => {
    const targetId = customerObj?.Customer_ID || taskId || 'UNKNOWN';
    setFetchingLocationFor(targetId);

    try {
      const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 250 });
      const lat = pos.latitude.toFixed(6);
      const lng = pos.longitude.toFixed(6);
      const gpsUrl = `https://maps.google.com/?q=${lat},${lng}`;

      if (selectedCustomer && (selectedCustomer.Customer_ID === customerObj?.Customer_ID || selectedCustomer.Company_Name === customerObj?.Company_Name)) {
        setSelectedCustomer(prev => ({ ...prev, Location_Link: gpsUrl }));
      }
      if (editingCustomer && editingCustomer.Customer_ID === customerObj?.Customer_ID) {
        setEditCustomerForm(prev => ({ ...prev, locationLink: gpsUrl }));
      }
      setIsEditCustomerGpsUnlocked(false);
      setIsNewCustomerGpsUnlocked(false);
      setCustomers(prev => prev.map(c => (c.Customer_ID === customerObj?.Customer_ID || c.Company_Name === customerObj?.Company_Name) ? { ...c, Location_Link: gpsUrl } : c));
      setTasks(prev => prev.map(t => (t.Customer_ID === customerObj?.Customer_ID || t.Customer_Name === customerObj?.Company_Name || t.Task_ID === taskId) ? { ...t, Customer_Location_Link: gpsUrl } : t));

      try {
        if (token && customerObj?.Customer_ID) {
          await fetch(`/api/customers/${customerObj.Customer_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ Location_Link: gpsUrl })
          });
        }
        alert(`✅ Client GPS coordinates captured & verified accurately!\nCoordinates: ${lat}, ${lng} (Accuracy: ~${pos.accuracy}m)`);
      } catch (err) {
        console.error('Error saving GPS to backend:', err);
        alert(`✅ Client location captured locally! (${lat}, ${lng})`);
      }
    } catch (err) {
      alert(`❌ ${err.message || 'Failed to get accurate GPS location. Please turn on High-Accuracy GPS on your device.'}`);
    } finally {
      setFetchingLocationFor(null);
    }
  };

  const handleAddRemarkSubmit = async (e) => {
    e.preventDefault();
    if (!remarkTask || !remarkForm.remarks.trim()) return;
    try {
      setSubmittingRemark(true);
      const res = await fetch('/api/customer-interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          customerId: remarkTask.Customer_ID || '',
          taskId: remarkTask.Task_ID || '',
          type: remarkForm.type,
          remarks: remarkForm.remarks
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save remark');
      }
      setRemarkForm({ type: '', remarks: '' });
      setShowTagList(true);
      setShowRemarkInputs(false);
      loadAdminData();
    } catch (err) {
      alert(err instanceof TypeError ? "Couldn't reach the server. Check your internet connection and try again in a moment." : err.message);
    } finally {
      setSubmittingRemark(false);
    }
  };

  const handleAdminLeaveSubmit = async (e) => {
    e.preventDefault();
    const targetStaffId = adminLeaveForm.staffId || staffList[0]?.Staff_ID;
    if (!targetStaffId || !adminLeaveForm.leaveDate) return;
    try {
      setAdminLeaveSubmitting(true);
      const res = await fetch('/api/leaves', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          staffId: targetStaffId,
          leaveDate: adminLeaveForm.leaveDate,
          leaveType: adminLeaveForm.leaveType,
          reason: adminLeaveForm.reason,
          status: 'Approved'
        })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to assign leave');
      }
      setShowAdminLeaveModal(false);
      setAdminLeaveForm({
        staffId: staffList[0]?.Staff_ID || '',
        leaveDate: getLocalDateStr(),
        leaveType: 'Full Day',
        reason: 'Granted by Admin'
      });
      loadAdminData();
    } catch (err) {
      alert(err.message);
    } finally {
      setAdminLeaveSubmitting(false);
    }
  };

  const handleExportCustomers = async () => {
    const { default: Papa } = await import('papaparse');
    const csv = Papa.unparse(customers);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.setAttribute('download', `customers_export_${getLocalDateStr()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportCustomers = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoading(true);
    const { default: Papa } = await import('papaparse');
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        try {
          const res = await fetch('/api/customers/bulk', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ customers: results.data })
          });
          if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error || 'Failed to upload customers');
          }
          const data = await res.json();
          alert(`Successfully imported ${data.upsertedCount} customers.`);
          loadAdminData();
        } catch (err) {
          alert(`Bulk Import Error: ${err.message}`);
        } finally {
          setLoading(false);
          e.target.value = '';
        }
      },
      error: (err) => {
        alert('Error parsing CSV: ' + err.message);
        setLoading(false);
      }
    });
  };

  // Memoized so this O(n) scan (with per-task O(1) customer lookups) only re-runs when one of
  // its actual inputs changes, instead of on every render of this component (e.g. every 20s
  // poll tick or unrelated modal/state toggle elsewhere in this file).
  const filteredTasks = useMemo(() => {
    let list = tasks.filter(t => {
      if (filterStatus !== 'ALL' && t.Status !== filterStatus) return false;
      if (activeTagFilters.length > 0) {
        const taskTags = Array.isArray(t.Tags) ? t.Tags : [];
        if (!activeTagFilters.some(id => taskTags.includes(id))) return false;
      }
      // User filter: Created_By
      if (filterSelectedUsers.length > 0) {
        const creator = t.Created_By || t.Assigned_Staff || 'Unknown';
        if (!filterSelectedUsers.includes(creator)) return false;
      }
      // Date filter: Created_At
      if (filterSelectedDates.length > 0) {
        const createdAtDate = t.Created_At || t.Scheduled_Date;
        if (!filterSelectedDates.includes(createdAtDate)) return false;
      }
      if (filterStartDate) {
        const createdAtDate = t.Created_At || t.Scheduled_Date;
        if (createdAtDate < filterStartDate) return false;
      }
      if (filterEndDate) {
        const createdAtDate = t.Created_At || t.Scheduled_Date;
        if (createdAtDate > filterEndDate) return false;
      }
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const cust = findCustomerForTask(t);
      const matchCompany = (t.Customer_Name || cust.Company_Name || '').toLowerCase().includes(q);
      const matchMobile = (cust.Contact || t.Contact || t.Customer_Contact || '').toLowerCase().includes(q);
      const matchPerson = (cust.Auth_Person || t.Auth_Person || t.Customer_Auth_Person || '').toLowerCase().includes(q);
      const matchAddress = (cust.Address || t.Address || t.Customer_Address || '').toLowerCase().includes(q);
      const matchId = (t.Task_ID || '').toLowerCase().includes(q);
      const matchDesc = (t.Description || '').toLowerCase().includes(q);
      return matchCompany || matchMobile || matchPerson || matchAddress || matchId || matchDesc;
    });

    if (filterSelectedUsers.length === 1) {
      const selectedStaffNameOrId = filterSelectedUsers[0];
      const staffMember = staffList.find(s => s.Name === selectedStaffNameOrId || s.Staff_ID === selectedStaffNameOrId);
      const taskOrder = staffMember?.Task_Order;
      if (Array.isArray(taskOrder) && taskOrder.length > 0) {
        list = [...list].sort((a, b) => {
          const idxA = taskOrder.indexOf(a.Task_ID);
          const idxB = taskOrder.indexOf(b.Task_ID);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          return 0;
        });
      }
    }
    return list;
  }, [tasks, filterStatus, activeTagFilters, filterSelectedUsers, filterSelectedDates, filterStartDate, filterEndDate, searchQuery, customersById, customersByName, staffList]);

  const filteredCustomers = useMemo(() => customers.filter(c => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    const matchCompany = (c.Company_Name || '').toLowerCase().includes(q);
    const matchMobile = (c.Contact || '').toLowerCase().includes(q);
    const matchPerson = (c.Auth_Person || '').toLowerCase().includes(q);
    const matchAddress = (c.Address || '').toLowerCase().includes(q);
    const matchId = (c.Customer_ID || '').toLowerCase().includes(q);
    return matchCompany || matchMobile || matchPerson || matchAddress || matchId;
  }), [customers, searchQuery]);

  const getGroupedSuggestions = () => {
    if (!searchQuery || !searchQuery.trim()) return { customers: [], staff: [], tasks: [] };
    const q = searchQuery.toLowerCase().trim();

    const matchedCustomers = customers.filter(c => {
      return (c.Company_Name || '').toLowerCase().includes(q) ||
             (c.Contact || '').toLowerCase().includes(q) ||
             (c.Auth_Person || '').toLowerCase().includes(q) ||
             (c.Address || '').toLowerCase().includes(q) ||
             (c.Customer_ID || '').toLowerCase().includes(q);
    }).slice(0, 5);

    const matchedStaff = staffList.filter(s => {
      return (s.Name || '').toLowerCase().includes(q) ||
             (s.Mobile || '').toLowerCase().includes(q) ||
             (s.Role || '').toLowerCase().includes(q) ||
             (s.Department || '').toLowerCase().includes(q) ||
             (s.Staff_ID || '').toLowerCase().includes(q);
    }).slice(0, 5);

    const matchedTasks = tasks.filter(t => {
      const cust = findCustomerForTask(t);
      return (t.Task_ID || '').toLowerCase().includes(q) ||
             (t.Description || '').toLowerCase().includes(q) ||
             (t.Customer_Name || cust.Company_Name || '').toLowerCase().includes(q) ||
             (cust.Contact || t.Contact || t.Customer_Contact || '').toLowerCase().includes(q) ||
             (cust.Auth_Person || t.Auth_Person || t.Customer_Auth_Person || '').toLowerCase().includes(q) ||
             (cust.Address || t.Address || t.Customer_Address || '').toLowerCase().includes(q);
    }).slice(0, 5);

    return {
      customers: matchedCustomers,
      staff: matchedStaff,
      tasks: matchedTasks
    };
  };

  const suggestions = getGroupedSuggestions();
  const hasSuggestions = suggestions.customers.length > 0 || suggestions.staff.length > 0 || suggestions.tasks.length > 0;

  const handleSelectSuggestion = (item, type) => {
    setShowSuggestions(false);
    if (type === 'customer') {
      setActiveTab('CUSTOMERS');
      setSearchQuery(item.Company_Name || '');
      setTimeout(() => {
        const el = document.getElementById('section-customers-list');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    } else if (type === 'staff') {
      setActiveTab('STAFF');
      setSearchQuery(item.Name || '');
      setTimeout(() => {
        const el = document.getElementById('section-staff-roster');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    } else if (type === 'task') {
      setActiveTab('PIPELINE');
      setSearchQuery(item.Task_ID || '');
      setTimeout(() => {
        const el = document.getElementById('section-pipeline-list');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4 sm:space-y-8">
      {/* GLOBAL SEARCH BAR at the very top */}
      <div ref={searchContainerRef} className="relative z-30">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-slate-700 font-bold text-xs shrink-0">
            <Search className="w-4 h-4 text-rose-600 animate-pulse" />
            <span>Search All (Clients, Staff, Work Orders):</span>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto flex-1 max-w-3xl relative">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search by Company Name, Staff Name, Task ID, Description, Mobile..."
                value={searchQuery}
                onFocus={() => setShowSuggestions(true)}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                className="w-full pl-3.5 pr-8 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-medium"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setShowSuggestions(false);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  title="Clear Search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => {}}
              className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition shrink-0"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search</span>
            </button>

            <button
              type="button"
              onClick={() => setShowFilterModal(true)}
              className={`p-2.5 rounded-xl border transition shadow-sm shrink-0 flex items-center justify-center relative ${
                filterSelectedDates.length > 0 || filterSelectedUsers.length > 0 || filterStartDate || filterEndDate
                  ? 'bg-rose-50 border-rose-300 text-rose-600 hover:bg-rose-100'
                  : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-600'
              }`}
              title="Filter Tasks by Date / User"
            >
              <Filter className="w-4 h-4" />
              {(filterSelectedDates.length > 0 || filterSelectedUsers.length > 0 || filterStartDate || filterEndDate) && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-rose-600 rounded-full border-2 border-white" />
              )}
            </button>
          </div>
        </div>

        {/* Dropdown Suggestions */}
        {showSuggestions && hasSuggestions && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-2xl shadow-xl z-50 max-h-[380px] overflow-y-auto divide-y divide-slate-100 animate-fadeIn">
            
            {/* Customers Section */}
            {suggestions.customers.length > 0 && (
              <div className="p-2.5">
                <h4 className="text-[10px] font-black text-rose-650 uppercase tracking-widest px-2.5 py-1 mb-1.5 flex items-center gap-1">
                  <Building2 className="w-3 h-3" />
                  Customers / Clients ({suggestions.customers.length})
                </h4>
                <div className="space-y-0.5">
                  {suggestions.customers.map(c => (
                    <button
                      key={c.Customer_ID}
                      type="button"
                      onClick={() => handleSelectSuggestion(c, 'customer')}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 rounded-xl transition flex items-center justify-between text-xs group"
                    >
                      <div className="min-w-0">
                        <p className="font-extrabold text-slate-900 truncate group-hover:text-rose-600">{c.Company_Name}</p>
                        <p className="text-[10px] text-slate-500 truncate mt-0.5">
                          ID: <span className="font-semibold text-slate-700">{c.Customer_ID}</span> | Auth Person: {c.Auth_Person || 'N/A'}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-3 text-xs">
                        <p className="text-[10px] font-bold text-slate-700 font-mono">{c.Contact}</p>
                        <p className="text-[9px] text-slate-450 truncate max-w-[200px]">{c.Address}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Staff Section */}
            {suggestions.staff.length > 0 && (
              <div className="p-2.5">
                <h4 className="text-[10px] font-black text-indigo-650 uppercase tracking-widest px-2.5 py-1 mb-1.5 flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  Staff Members ({suggestions.staff.length})
                </h4>
                <div className="space-y-0.5">
                  {suggestions.staff.map(s => (
                    <button
                      key={s.Staff_ID}
                      type="button"
                      onClick={() => handleSelectSuggestion(s, 'staff')}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 rounded-xl transition flex items-center justify-between text-xs group"
                    >
                      <div className="min-w-0">
                        <p className="font-extrabold text-slate-900 truncate group-hover:text-indigo-600">{s.Name}</p>
                        <p className="text-[10px] text-slate-500 truncate mt-0.5">
                          ID: <span className="font-semibold text-slate-700">{s.Staff_ID}</span> | Role: {s.Role} ({s.Department || 'No Dept'})
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-3 text-xs">
                        <p className="text-[10px] font-bold text-slate-700 font-mono">{s.Mobile}</p>
                        <p className="text-[9px] px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded-md font-bold uppercase inline-block">Select Staff</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks Section */}
            {suggestions.tasks.length > 0 && (
              <div className="p-2.5">
                <h4 className="text-[10px] font-black text-amber-650 uppercase tracking-widest px-2.5 py-1 mb-1.5 flex items-center gap-1">
                  <Briefcase className="w-3 h-3" />
                  Work Orders / Tasks ({suggestions.tasks.length})
                </h4>
                <div className="space-y-0.5">
                  {suggestions.tasks.map(t => (
                    <button
                      key={t.Task_ID}
                      type="button"
                      onClick={() => handleSelectSuggestion(t, 'task')}
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 rounded-xl transition flex items-center justify-between text-xs group"
                    >
                      <div className="min-w-0">
                        <p className="font-extrabold text-slate-900 truncate group-hover:text-amber-600">
                          {t.Customer_Name || 'No Name'}
                        </p>
                        <p className="text-[10px] text-slate-500 truncate mt-0.5">
                          Task ID: <span className="font-bold text-slate-700">{t.Task_ID}</span> | {t.Description}
                        </p>
                      </div>
                      <div className="text-right shrink-0 ml-3 text-xs">
                        <p className="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase inline-block"
                           style={t.Status === 'Completed' ? { backgroundColor: '#dcfce7', color: '#15803d' } :
                                  t.Status === 'In Progress' ? { backgroundColor: '#dbeafe', color: '#1d4ed8' } :
                                  { backgroundColor: '#fef3c7', color: '#d97706' }}>
                          {t.Status}
                        </p>
                        <p className="text-[9px] text-slate-400 mt-0.5 font-medium">By: {t.Assigned_Staff || 'Unassigned'}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* ADMIN EXECUTIVE DASHBOARD TOP STATS BANNER (Clean Light & Professional Color Palette) */}
      <div className="bg-gradient-to-br from-white via-slate-50 to-indigo-50/40 rounded-3xl p-6 text-slate-900 shadow-xl border border-slate-200 relative overflow-hidden">
        <div className="absolute top-0 right-0 -mt-8 -mr-8 w-64 h-64 bg-rose-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
            <div>
              <span className="px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-extrabold tracking-wider uppercase border border-indigo-200/60">
                Admin Executive Dashboard
              </span>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900 mt-2 tracking-tight">
                Welcome back, {user?.Name || 'Nilesh Padaya'}
              </h2>
              <p className="text-xs text-slate-500 mt-1 font-medium">
                System-wide live analytics and module management for Expert Safety Solutions.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => {
                  if (customers.length > 0) {
                    setTaskForm(prev => ({ ...prev, customerId: customers[0].Customer_ID }));
                  }
                  if (staffList.length > 0) {
                    setTaskForm(prev => ({ ...prev, assignedStaff: staffList[1]?.Staff_ID || staffList[0].Staff_ID }));
                  }
                  setShowNewTaskModal(true);
                }}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-rose-600/20 transition active:scale-95 shrink-0"
              >
                <PlusCircle className="w-4 h-4" />
                <span>New Work Order</span>
              </button>
              <button
                onClick={() => setShowNewCustomerModal(true)}
                className="px-3.5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition border border-slate-300 active:scale-95 shrink-0 shadow-2xs"
              >
                <UserPlus className="w-4 h-4 text-indigo-600" />
                <span>New Customer</span>
              </button>
            </div>
          </div>

          {/* Statistic Data Cards Grid (Light Professional Scheme) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
            <div 
              onClick={() => {
                setActiveTab('PIPELINE');
                setTimeout(() => document.getElementById('section-pipeline-list')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-indigo-50/50 border border-slate-200 hover:border-indigo-300 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-indigo-600 uppercase tracking-wider">Work Orders</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                  <Layers className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">{tasks.length}</p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">
                {tasks.filter(t => t.Status === 'Started' || t.Status === 'In Progress').length} Active
              </p>
            </div>

            <div 
              onClick={() => {
                setActiveTab('PIPELINE');
                setTimeout(() => document.getElementById('section-pipeline-list')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-emerald-50/50 border border-slate-200 hover:border-emerald-300 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-emerald-600 uppercase tracking-wider">Completed</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">
                {tasks.filter(t => t.Status === 'Completed' || t.Status === 'Closed').length}
              </p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">Tasks resolved</p>
            </div>

            <div 
              onClick={() => {
                setActiveTab('STAFF');
                setTimeout(() => document.getElementById('section-staff-roster')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-amber-50/50 border border-slate-200 hover:border-amber-300 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-amber-600 uppercase tracking-wider">Staff Force</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-amber-50 flex items-center justify-center">
                  <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">{staffList.length}</p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">Active staff profiles</p>
            </div>

            <div 
              onClick={() => {
                setActiveTab('ATTENDANCE');
                setTimeout(() => document.getElementById('section-attendance-logs')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-teal-50/60 border border-slate-200 hover:border-teal-400 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-teal-600 uppercase tracking-wider">Present Today</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-teal-50 flex items-center justify-center">
                  <UserCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-teal-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">
                {new Set(attendanceLogs.filter(a => (a.Date === getLocalDateStr() || String(a.Date).trim() === getLocalDateStr()) && a.Punch_In_Time && a.Punch_In_Time !== '').map(a => a.Staff_ID)).size}
              </p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">Staff checked in</p>
            </div>

            <div 
              onClick={() => {
                setActiveTab('CUSTOMERS');
                setTimeout(() => document.getElementById('section-customers-list')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-sky-50/50 border border-slate-200 hover:border-sky-300 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-sky-600 uppercase tracking-wider">Clients</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-sky-50 flex items-center justify-center">
                  <Building2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">{customers.length}</p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">CRM directory</p>
            </div>

            <div 
              onClick={() => {
                setActiveTab('ATTENDANCE');
                setTimeout(() => document.getElementById('section-leave-queue')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
              className="p-2.5 sm:p-4 rounded-xl sm:rounded-2xl bg-white hover:bg-rose-50/50 border border-slate-200 hover:border-rose-300 shadow-sm transition-all duration-200 cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] sm:text-[11px] font-bold text-rose-600 uppercase tracking-wider">Leave Requests</span>
                <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-rose-50 flex items-center justify-center">
                  <AlertTriangle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-rose-600 group-hover:scale-110 transition" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1.5 sm:mt-2">
                {leaveRequests.filter(r => r.Status === 'Pending').length}
              </p>
              <p className="text-[9px] sm:text-[10px] text-slate-500 mt-0.5 sm:mt-1 font-medium">Pending approval</p>
            </div>
          </div>
        </div>
      </div>

      {/* COLLAPSIBLE STAFF PROGRESS REPORT & QUICK ACTIONS (Taps to Expand/Collapse, Mobile Friendly) */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden transition-all duration-200">
        {/* Main Title Tag - Click/Tap to Expand */}
        <div
          onClick={() => setShowStaffProgressReport(!showStaffProgressReport)}
          className="p-4 sm:p-5 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 cursor-pointer select-none hover:opacity-95 transition"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center shrink-0">
              <Briefcase className="w-5 h-5 text-rose-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-extrabold flex items-center gap-2 truncate">
                <span>Staff-Wise Task Progress Report — Pending & Closed Summary</span>
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-300 mt-0.5 truncate">
                Real-time breakdown of assigned work orders, pending tasks, and closed/completed tasks by staff personnel
              </p>
            </div>
          </div>
          <div className="flex items-center justify-between w-full sm:w-auto gap-3 shrink-0 pt-2 sm:pt-0 border-t border-white/10 sm:border-0">
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-white/10 text-white border border-white/10">
              {tasks.length} Total Assigned Tasks
            </span>
            <div className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl bg-rose-600 text-white shadow-sm">
              <span>{showStaffProgressReport ? 'Collapse Report' : 'Tap to Expand'}</span>
              {showStaffProgressReport ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </div>
        </div>

        {/* Expanded Content: Buttons + Table/Mobile Cards */}
        {showStaffProgressReport && (
          <div className="p-4 sm:p-5 space-y-4 bg-slate-50/50 animate-fadeIn border-t border-slate-200">
            {/* Quick Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('STAFF');
                  setExpandedOverviewModule(null);
                }}
                className="flex-1 sm:flex-initial px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition"
              >
                <Users className="w-4 h-4" />
                <span>Staffs ({staffList.length})</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActiveTab('CUSTOMERS');
                  setExpandedOverviewModule(null);
                }}
                className="flex-1 sm:flex-initial px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition"
              >
                <Building2 className="w-4 h-4" />
                <span>Clients ({customers.length})</span>
              </button>

              <button
                type="button"
                onClick={() => setShowStaffAccessModal(true)}
                className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 via-indigo-600 to-emerald-600 hover:opacity-95 text-white font-extrabold text-xs flex items-center justify-center gap-2 shadow-md transition active:scale-95"
              >
                <Shield className="w-4 h-4" />
                <span>Staff Access Accounts</span>
              </button>
            </div>

            {/* Table / Mobile Cards */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
              {/* Desktop Table view */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/80 text-slate-500 font-semibold">
                      <th className="py-3 px-4">Staff ID & Name</th>
                      <th className="py-3 px-4">Department</th>
                      <th className="py-3 px-4">Total Assigned</th>
                      <th className="py-3 px-4">Pending Tasks</th>
                      <th className="py-3 px-4">Closed / Completed</th>
                      <th className="py-3 px-4 w-48">Completion Progress</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {staffList.map(st => {
                      const staffTasks = tasks.filter(t => t.Assigned_Staff === st.Staff_ID);
                      const totalCount = staffTasks.length;
                      const closedCount = staffTasks.filter(t => t.Status === 'Completed').length;
                      const pendingCount = totalCount - closedCount;
                      const progressPct = totalCount > 0 ? Math.round((closedCount / totalCount) * 100) : 0;

                      return (
                        <tr key={st.Staff_ID} className="hover:bg-slate-50/80 transition">
                          <td className="py-3.5 px-4 font-bold text-slate-900">
                            {st.Name} <span className="text-slate-400 font-medium ml-1">({st.Staff_ID})</span>
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 font-medium">{st.Department || 'Field Service'}</td>
                          <td className="py-3.5 px-4 font-bold text-slate-800">{totalCount}</td>
                          <td className="py-3.5 px-4">
                            <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-bold border border-amber-200 text-[11px]">
                              {pendingCount} Pending
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-[11px]">
                              {closedCount} Closed
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-emerald-600 h-full rounded-full transition-all duration-300"
                                  style={{ width: `${progressPct}%` }}
                                />
                              </div>
                              <span className="font-bold text-slate-700 w-9 text-right">{progressPct}%</span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              onClick={() => {
                                setSearchQuery(st.Staff_ID);
                                setActiveTab('PIPELINE');
                                setExpandedOverviewModule(null);
                              }}
                              className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs transition active:scale-95"
                            >
                              View Tasks
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Friendly Cards View (shown on mobile devices) */}
              <div className="md:hidden divide-y divide-slate-100">
                {staffList.map(st => {
                  const staffTasks = tasks.filter(t => t.Assigned_Staff === st.Staff_ID);
                  const totalCount = staffTasks.length;
                  const closedCount = staffTasks.filter(t => t.Status === 'Completed').length;
                  const pendingCount = totalCount - closedCount;
                  const progressPct = totalCount > 0 ? Math.round((closedCount / totalCount) * 100) : 0;

                  return (
                    <div key={st.Staff_ID} className="p-4 space-y-3 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-extrabold text-slate-900">{st.Name}</h4>
                          <p className="text-xs text-slate-500 font-medium">{st.Department || 'Field Service'} • {st.Staff_ID}</p>
                        </div>
                        <button
                          onClick={() => {
                            setSearchQuery(st.Staff_ID);
                            setActiveTab('PIPELINE');
                            setExpandedOverviewModule(null);
                          }}
                          className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition active:scale-95 shrink-0"
                        >
                          View Tasks
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-2 py-1">
                        <div className="p-2 rounded-xl bg-slate-50 border border-slate-100 text-center">
                          <p className="text-[10px] text-slate-400 font-semibold uppercase">Assigned</p>
                          <p className="text-sm font-extrabold text-slate-800 mt-0.5">{totalCount}</p>
                        </div>
                        <div className="p-2 rounded-xl bg-amber-50 border border-amber-100 text-center">
                          <p className="text-[10px] text-amber-600 font-semibold uppercase">Pending</p>
                          <p className="text-sm font-extrabold text-amber-800 mt-0.5">{pendingCount}</p>
                        </div>
                        <div className="p-2 rounded-xl bg-emerald-50 border border-emerald-100 text-center">
                          <p className="text-[10px] text-emerald-600 font-semibold uppercase">Closed</p>
                          <p className="text-sm font-extrabold text-emerald-800 mt-0.5">{closedCount}</p>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-slate-500 font-medium">Completion Progress</span>
                          <span className="font-extrabold text-slate-800">{progressPct}%</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-emerald-600 h-full rounded-full transition-all duration-300"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>


      {/* ADMIN TOP NAV TABS & ACTION BUTTONS */}
      <div className="space-y-3.5 border-b border-slate-200 pb-4">
        {/* Row 1: Module Navigation Tabs Bar */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {[
            { id: 'OVERVIEW', label: 'Overview & Stats', shortLabel: 'Overview', icon: LayoutDashboard },
            { id: 'PIPELINE', label: '1. Work Orders & Pipeline', shortLabel: '1. Pipeline', icon: Layers },
            { id: 'STAFF', label: '2. Staff Roster & Scope', shortLabel: '2. Staff', icon: Users },
            { id: 'CUSTOMERS', label: '3. Client Database & CRM', shortLabel: '3. CRM', icon: Building2 },
            { id: 'ATTENDANCE', label: '4. Attendance & Leave Roster', shortLabel: '4. Attendance', icon: Clock },
            { id: 'LOGS', label: '5. Live Activity Logs', shortLabel: '5. Logs', icon: Activity },
            { id: 'CERTIFICATES', label: '6. Certificate Module', shortLabel: '6. Certificates', icon: Award },
            { id: 'SERVICE_REPORTS', label: '7. Service Reports Queue', shortLabel: '7. Reports', icon: FileCheck }
          ].map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 sm:px-3.5 py-2 sm:py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition shadow-2xs ${
                  activeTab === tab.id
                    ? 'bg-rose-600 text-white shadow-rose-600/25 ring-2 ring-rose-600/20'
                    : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="hidden md:inline">{tab.label}</span>
                <span className="md:hidden">{tab.shortLabel}</span>
              </button>
            );
          })}
        </div>

        {/* Row 2: Quick Action Buttons Bar */}
        <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-slate-100/80">
          <button
            onClick={() => navigate('/certificate-compliance/new')}
            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm border border-amber-400/30 shrink-0"
          >
            <Award className="w-4 h-4 text-amber-100 shrink-0" />
            <span>Generate Certificate</span>
          </button>
          <button
            onClick={() => setShowNewCustomerModal(true)}
            className="px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition shadow-sm shrink-0"
          >
            <PlusCircle className="w-4 h-4 text-indigo-600 shrink-0" />
            <span>New Customer</span>
          </button>
          <button
            onClick={() => setShowNewStaffModal(true)}
            className="px-3.5 py-2 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition shadow-sm shrink-0"
          >
            <UserPlus className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>New Staff Profile</span>
          </button>
          <button
            onClick={() => setShowStaffAccessModal(true)}
            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-rose-600 to-indigo-600 hover:opacity-95 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm shrink-0"
          >
            <Shield className="w-4 h-4 text-rose-200 shrink-0" />
            <span>Use Staff Interface</span>
          </button>
          <button
            onClick={() => {
              if (customers.length > 0) {
                setTaskForm(prev => ({ ...prev, customerId: customers[0].Customer_ID }));
              }
              if (staffList.length > 0) {
                setTaskForm(prev => ({ ...prev, assignedStaff: staffList[1]?.Staff_ID || staffList[0].Staff_ID }));
              }
              setShowNewTaskModal(true);
            }}
            className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition shrink-0"
          >
            <PlusCircle className="w-4 h-4 shrink-0" />
            <span>New Work Order</span>
          </button>
        </div>
      </div>

      {/* OVERVIEW & STATS FRONT PAGE WITH THE 5 MENU CARDS */}
      {activeTab === 'OVERVIEW' && (
        <div className="space-y-6 animate-fadeIn">
          {/* Clean Navigation Cards List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-extrabold text-slate-800 uppercase tracking-wider">
                Management Modules & Profiles
              </h3>
              <span className="text-xs text-slate-500">Select a section to manage records</span>
            </div>

            <div className="space-y-3">
              {/* Card 1 */}
              <div
                onClick={() => setExpandedOverviewModule(expandedOverviewModule === 'PIPELINE' ? null : 'PIPELINE')}
                className="group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-rose-300 shadow-sm hover:shadow-md transition-all duration-200 flex items-center justify-between cursor-pointer select-none"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-100 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Briefcase className="w-6 h-6 text-rose-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base font-extrabold text-slate-900 group-hover:text-rose-600 transition truncate">
                      1. Task Pipeline & Work Orders
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      Assign tasks, track work order progression, handle remarks, and manage client visits
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <span className="hidden sm:inline-block px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-bold">
                    {tasks.length} Orders
                  </span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-2xs ${
                    expandedOverviewModule === 'PIPELINE' ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-rose-50 group-hover:text-rose-600'
                  }`}>
                    <span>{expandedOverviewModule === 'PIPELINE' ? 'Collapse' : 'Tap to Expand'}</span>
                    {expandedOverviewModule === 'PIPELINE' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>

              {/* Card 2 */}
              <div
                onClick={() => setExpandedOverviewModule(expandedOverviewModule === 'STAFF' ? null : 'STAFF')}
                className="group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-300 shadow-sm hover:shadow-md transition-all duration-200 flex items-center justify-between cursor-pointer select-none"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Users className="w-6 h-6 text-indigo-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base font-extrabold text-slate-900 group-hover:text-indigo-600 transition truncate">
                      2. Staff Roster, Salary & Scope
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      Manage staff accounts, assign daily salary rates, set permission scopes, and view assigned work
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <span className="hidden sm:inline-block px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-bold">
                    {staffList.length} Staff
                  </span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-2xs ${
                    expandedOverviewModule === 'STAFF' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-indigo-50 group-hover:text-indigo-600'
                  }`}>
                    <span>{expandedOverviewModule === 'STAFF' ? 'Collapse' : 'Tap to Expand'}</span>
                    {expandedOverviewModule === 'STAFF' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>

              {/* Card 3 */}
              <div
                onClick={() => setExpandedOverviewModule(expandedOverviewModule === 'CUSTOMERS' ? null : 'CUSTOMERS')}
                className="group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-amber-300 shadow-sm hover:shadow-md transition-all duration-200 flex items-center justify-between cursor-pointer select-none"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-100 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Building2 className="w-6 h-6 text-amber-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base font-extrabold text-slate-900 group-hover:text-amber-600 transition truncate">
                      3. Client Database & CRM Profiles
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      Company directory, contact persons, GPS coordinates, location links, and site visit history
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <span className="hidden sm:inline-block px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-bold">
                    {customers.length} Clients
                  </span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-2xs ${
                    expandedOverviewModule === 'CUSTOMERS' ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-amber-50 group-hover:text-amber-600'
                  }`}>
                    <span>{expandedOverviewModule === 'CUSTOMERS' ? 'Collapse' : 'Tap to Expand'}</span>
                    {expandedOverviewModule === 'CUSTOMERS' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>

              {/* Card 4 */}
              <div
                onClick={() => setExpandedOverviewModule(expandedOverviewModule === 'ATTENDANCE' ? null : 'ATTENDANCE')}
                className="group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-emerald-300 shadow-sm hover:shadow-md transition-all duration-200 flex items-center justify-between cursor-pointer select-none"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Clock className="w-6 h-6 text-emerald-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base font-extrabold text-slate-900 group-hover:text-emerald-600 transition truncate">
                      4. Staff Attendance & Leave Roster
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      Check-in/out logs, live GPS attendance verification, salary calculation, and leave request management
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  {leaveRequests.filter(r => r.Status === 'Pending').length > 0 && (
                    <span className="hidden sm:inline-block px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 text-xs font-bold animate-pulse">
                      {leaveRequests.filter(r => r.Status === 'Pending').length} Pending Leaves
                    </span>
                  )}
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-2xs ${
                    expandedOverviewModule === 'ATTENDANCE' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-emerald-50 group-hover:text-emerald-600'
                  }`}>
                    <span>{expandedOverviewModule === 'ATTENDANCE' ? 'Collapse' : 'Tap to Expand'}</span>
                    {expandedOverviewModule === 'ATTENDANCE' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>

              {/* Card 5 */}
              <div
                onClick={() => setExpandedOverviewModule(expandedOverviewModule === 'LOGS' ? null : 'LOGS')}
                className="group p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 hover:border-teal-300 shadow-sm hover:shadow-md transition-all duration-200 flex items-center justify-between cursor-pointer select-none"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-teal-50 border border-teal-100 flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                    <Activity className="w-6 h-6 text-teal-600" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-base font-extrabold text-slate-900 group-hover:text-teal-600 transition truncate">
                      5. Live Activity Logs & Audit Trail
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      Real-time GPS tracking logs, system events, user actions, and audit trail records
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <span className="hidden sm:inline-block px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-bold">
                    {logs.length} Logs
                  </span>
                  <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-2xs ${
                    expandedOverviewModule === 'LOGS' ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-teal-50 group-hover:text-teal-600'
                  }`}>
                    <span>{expandedOverviewModule === 'LOGS' ? 'Collapse' : 'Tap to Expand'}</span>
                    {expandedOverviewModule === 'LOGS' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Return to Overview Banner when inside any module */}
      {activeTab !== 'OVERVIEW' && (
        <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-3 shadow-2xs mb-4">
          <button
            onClick={() => setActiveTab('OVERVIEW')}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs transition active:scale-95"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
            <span>← Back to Overview & Menu</span>
          </button>
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            {activeTab === 'PIPELINE' && '1. Work Orders & Pipeline'}
            {activeTab === 'STAFF' && '2. Staff Roster & Workload'}
            {activeTab === 'CUSTOMERS' && '3. Customer Directory & CRM'}
            {activeTab === 'ATTENDANCE' && '4. Attendance & Payroll'}
            {activeTab === 'LOGS' && '5. Field GPS Activity Logs'}
            {activeTab === 'CERTIFICATES' && '6. Certificate Generator & Compliance Module'}
          </span>
        </div>
      )}

      {/* TAB CONTENT 1: PIPELINE - SINGLE-ROW EXPANDABLE WITH UP/DOWN ROUTE SCROLLER */}
      {(activeTab === 'PIPELINE' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'PIPELINE')) && (
        <div className="space-y-3">
          {/* Status filter tags */}
          <div className="flex flex-wrap gap-2 pt-1 pb-2">
            {['Pending', 'Started', 'In Progress', 'Completed', 'ALL'].map(status => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={`px-3 py-1 text-xs font-bold rounded-lg border transition ${
                  filterStatus === status
                    ? 'bg-rose-100 border-rose-300 text-rose-800 shadow-sm'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          {/* Dynamic Tag Filter Chips (admin-editable, multi-select) */}
          <div className="flex flex-wrap items-center gap-1.5 pb-2 -mt-1">
            <button
              type="button"
              onClick={() => setShowTagManagerModal(true)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg border border-dashed border-indigo-300 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition"
              title="Create, rename or delete tags"
            >
              <Settings className="w-3 h-3" />
              <span>Manage Tags</span>
            </button>
            {tags.map(tag => {
              const isActive = activeTagFilters.includes(tag.Tag_ID);
              const tagCount = tasks.filter(t => (t.Tags || []).includes(tag.Tag_ID)).length;
              return (
                <button
                  key={tag.Tag_ID}
                  type="button"
                  onClick={() => toggleTagFilter(tag.Tag_ID)}
                  className="relative flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-full border transition"
                  style={isActive
                    ? { backgroundColor: tag.color, borderColor: tag.color, color: '#fff' }
                    : { backgroundColor: `${tag.color}14`, borderColor: `${tag.color}55`, color: tag.color }}
                >
                  <TagIcon className="w-2.5 h-2.5" />
                  <span>{tag.name}</span>
                  {tagCount > 0 && (
                    <span
                      className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full text-[9px] font-bold flex items-center justify-center shadow-sm"
                      style={isActive
                        ? { backgroundColor: '#fff', color: tag.color }
                        : { backgroundColor: tag.color, color: '#fff' }}
                    >
                      {tagCount}
                    </span>
                  )}
                </button>
              );
            })}
            {activeTagFilters.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTagFilters([])}
                className="text-[11px] font-bold text-slate-400 hover:text-rose-600 px-1.5"
              >
                Clear tag filters ✕
              </button>
            )}
          </div>

          <div className="space-y-2.5">
            {filteredTasks.map((task, idx) => {
              const isExpanded = !!expandedTaskIds[task.Task_ID];
              const custObj = findCustomerForTask(task);
              const availableContacts = getAvailableContacts(custObj, task);
              const hasContacts = availableContacts.length > 0;
              const hasLocation = Boolean(task.Customer_Location_Link || custObj.Location_Link || custObj.Google_Location);
              const mapUrl = getGoogleDirectionsUrl(
                task.Customer_Location_Link || custObj.Location_Link,
                task.Customer_Address || custObj.Address,
                task.Customer_Name || custObj.Company_Name
              );
              const isOverdueNoAction = isTaskOverdueNoInteraction(task, customerInteractions);

              const openCustomerEditModal = () => {
                const parsedCoords = (() => {
                  try {
                    if (typeof custObj.Coordinators === 'string' && custObj.Coordinators.startsWith('[')) return JSON.parse(custObj.Coordinators);
                    if (Array.isArray(custObj.Coordinators)) return custObj.Coordinators;
                  } catch { }
                  return [];
                })();
                const cust = Object.keys(custObj).length > 0 ? custObj : {
                  Customer_ID: task.Customer_ID,
                  Company_Name: task.Customer_Name,
                  Auth_Person: task.Customer_Auth_Person || '',
                  Contact: task.Customer_Contact || '',
                  Email: '',
                  Location_Link: task.Customer_Location_Link || '',
                  Address: task.Customer_Address || ''
                };
                setEditingCustomer(cust);
                setEditCustomerForm({
                  companyName: cust.Company_Name || '',
                  authPerson: cust.Auth_Person || '',
                  contact: (cust.Contact || '').replace(/^\+91\s?/, ''),
                  email: cust.Email || '',
                  locationLink: cust.Location_Link || task.Customer_Location_Link || '',
                  address: cust.Address || task.Customer_Address || '',
                  specialNotes: cust.Special_Notes || '',
                  coordinators: parsedCoords
                });
                setIsEditCustomerGpsUnlocked(false);
                setIsEditCustomerNotesUnlocked(!cust.Special_Notes);
                setShowEditCustomerModal(true);
              };

              return (
                <div
                  key={task.Task_ID}
                  data-task-id={task.Task_ID}
                  onDragOver={(e) => {
                    e.preventDefault();
                    handleAutoScroll(e.clientY);
                    if (draggedTaskId !== null && draggedTaskId !== task.Task_ID && dragOverTaskId !== task.Task_ID) {
                      setDragOverTaskId(task.Task_ID);
                    }
                  }}
                  onDragEnd={() => {
                    stopAutoScroll();
                    setDraggedTaskId(null);
                    setDragOverTaskId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (draggedTaskId !== null) {
                      handleDropTask(draggedTaskId, task.Task_ID);
                    }
                  }}
                  className={`rounded-none border shadow-sm transition overflow-hidden ${
                    draggedTaskId === task.Task_ID
                      ? 'border-indigo-500 bg-indigo-50/40 opacity-50 scale-[0.98]'
                      : dragOverTaskId === task.Task_ID
                      ? 'border-2 border-indigo-600 bg-indigo-50/80 shadow-md scale-[1.01]'
                      : isOverdueNoAction
                      ? 'border-rose-300 bg-rose-100'
                      : 'bg-white border-slate-200/90 hover:border-slate-300'
                  }`}
                  title={isOverdueNoAction ? 'No interaction logged within 2 days of the scheduled date — this task is overdue' : undefined}
                >
                  {/* SINGLE ROW BAR / CARD TOP */}
                  <div className="flex flex-col gap-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      {/* Company Name — Task Name (Clicking expands buttons/details, 3-tap opens edit modal) */}
                      <div
                        className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer select-none"
                        onClick={(e) => {
                          const now = Date.now();
                          const lastTap = taskTapTrackerRef.current[task.Task_ID]?.time || 0;
                          const count = taskTapTrackerRef.current[task.Task_ID]?.count || 0;
                          let newCount = (now - lastTap < 600) ? count + 1 : 1;
                          taskTapTrackerRef.current[task.Task_ID] = { time: now, count: newCount };

                          if (newCount >= 3 || e.detail === 3) {
                            e.stopPropagation();
                            taskTapTrackerRef.current[task.Task_ID] = { time: 0, count: 0 };
                            openCustomerEditModal();
                          } else {
                            toggleTaskExpand(task.Task_ID);
                          }
                        }}
                        title="Tap company name (or tap 3 times quickly to edit customer details)"
                      >
                        <span className="text-sm font-bold text-slate-900 truncate">
                          {(task.Customer_Name && task.Customer_Name !== 'General Client' && task.Customer_Name !== 'Unknown Company')
                            ? task.Customer_Name
                            : (customersById.get(String(task.Customer_ID || '').trim().toLowerCase())?.Company_Name || task.Customer_Name || (task.Customer_ID ? `Customer (${task.Customer_ID})` : 'General Client'))}
                        </span>
                        {(task.Tags || []).length > 0 && (
                          <span className="flex items-center gap-1 shrink-0">
                            {task.Tags.map(tagId => {
                              const tag = tags.find(t => t.Tag_ID === tagId);
                              if (!tag) return null;
                              return (
                                <span
                                  key={tagId}
                                  className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
                                  style={{ backgroundColor: `${tag.color}18`, color: tag.color, border: `1px solid ${tag.color}55` }}
                                >
                                  {tag.name}
                                </span>
                              );
                            })}
                          </span>
                        )}
                        {task.Status === 'Removal Requested' && (
                          <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300 animate-pulse">
                            ⚠️ Removal Requested by Staff
                          </span>
                        )}
                      </div>
                      {!hasContacts && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openCustomerEditModal();
                            }}
                            className="w-5 h-5 rounded-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center transition shrink-0 animate-pulse"
                            title="No Contact Number Found — Click to open Edit Customer Modal and add contact details"
                          >
                            <PhoneCall className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openCustomerEditModal();
                            }}
                            className="w-5 h-5 rounded-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center transition shrink-0 animate-pulse"
                            title="No WhatsApp Number Found — Click to open Edit Customer Modal and add contact details"
                          >
                            <MessageCircle className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      {!hasLocation && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openCustomerEditModal();
                          }}
                          className="w-5 h-5 rounded-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center transition shrink-0 animate-pulse"
                          title="Google Location Not Available — Click to open Edit Customer Modal (paste map link or click Fetch GPS)"
                        >
                          <MapPin className="w-3 h-3" />
                        </button>
                      )}

                      {/* Right side 6 dots button: exact like pencil button, supports touch/mouse dragging + sequence controls */}
                      <div
                        draggable={true}
                        onDragStart={(e) => {
                          e.stopPropagation();
                          setDraggedTaskId(task.Task_ID);
                          if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = 'move';
                            try {
                              e.dataTransfer.setData('text/plain', task.Task_ID);
                            } catch {}
                          }
                        }}
                        onDragEnd={() => {
                          stopAutoScroll();
                          setDraggedTaskId(null);
                          setDragOverTaskId(null);
                        }}
                        onTouchStart={(e) => {
                          e.stopPropagation();
                          setDraggedTaskId(task.Task_ID);
                          setDragOverTaskId(task.Task_ID);
                        }}
                        onTouchMove={(e) => {
                          if (!draggedTaskId) return;
                          const touch = e.touches[0];
                          handleAutoScroll(touch.clientY);
                          const elem = document.elementFromPoint(touch.clientX, touch.clientY);
                          if (elem) {
                            const card = elem.closest('[data-task-id]');
                            if (card) {
                              const targetId = card.getAttribute('data-task-id');
                              if (targetId && targetId !== dragOverTaskId) {
                                setDragOverTaskId(targetId);
                              }
                            }
                          }
                        }}
                        onTouchEnd={() => {
                          if (draggedTaskId && dragOverTaskId && draggedTaskId !== dragOverTaskId) {
                            handleDropTask(draggedTaskId, dragOverTaskId);
                          } else {
                            stopAutoScroll();
                            setDraggedTaskId(null);
                            setDragOverTaskId(null);
                          }
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setReorderingTaskId(prev => prev === task.Task_ID ? null : task.Task_ID);
                        }}
                        className="w-5 h-5 rounded-md bg-slate-100 hover:bg-indigo-100 active:bg-indigo-200 border border-slate-200 hover:border-indigo-300 flex items-center justify-center text-slate-400 hover:text-indigo-600 transition shrink-0 cursor-grab active:cursor-grabbing shadow-2xs touch-none"
                        title="The six-dot handle lets you drag-and-drop reorder tasks in the list (or tap it for Move Up / Move Down controls). This is just your own visual ordering preference — it is shown when the admin accesses the particular staff panel, showing tasks in your preferred order."
                      >
                        <GripVertical className="w-2.5 h-2.5" />
                      </div>
                    </div>

                    {/* Quick Sequence Reordering Controls when 6-dots is tapped */}
                    {reorderingTaskId === task.Task_ID && (
                      <div className="p-2 rounded-xl bg-indigo-50 border border-indigo-200 flex flex-wrap items-center justify-between gap-2 animate-fadeIn text-xs shadow-2xs">
                        <span className="font-bold text-indigo-900 flex items-center gap-1.5">
                          <GripVertical className="w-3.5 h-3.5 text-indigo-600" />
                          Move Task Sequence:
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveTaskOrder(task.Task_ID, -1, filteredTasks);
                            }}
                            disabled={idx === 0}
                            className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1 transition text-xs ${
                              idx === 0
                                ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                                : 'bg-white text-indigo-700 border border-indigo-300 hover:bg-indigo-600 hover:text-white shadow-2xs'
                            }`}
                          >
                            ▲ Move Up
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveTaskOrder(task.Task_ID, 1, filteredTasks);
                            }}
                            disabled={idx === filteredTasks.length - 1}
                            className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1 transition text-xs ${
                              idx === filteredTasks.length - 1
                                ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                                : 'bg-white text-indigo-700 border border-indigo-300 hover:bg-indigo-600 hover:text-white shadow-2xs'
                            }`}
                          >
                            ▼ Move Down
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReorderingTaskId(null);
                            }}
                            className="p-1 px-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition font-bold"
                            title="Close"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 2nd Line: Description (Clicking also expands buttons) */}
                    <div className="cursor-pointer" onClick={() => toggleTaskExpand(task.Task_ID)} title="Tap to view action buttons below">
                      <p className="text-xs text-slate-600 font-medium mt-0.5 pr-2">
                        {task.Description || 'Fire Safety Maintenance Task'}
                      </p>
                    </div>

                    {/* Admin Action Banner for Pending Removal Request */}
                    {task.Status === 'Removal Requested' && (
                      <div className="mt-2 p-2.5 rounded-xl bg-rose-50 border border-rose-200 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-bold text-rose-900">
                          Staff member requested approval to remove this task.
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleApproveRemoval(task.Task_ID, task.Description || task.Task_ID)}
                            className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-2xs"
                          >
                            Approve Removal (Delete)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRejectRemoval(task.Task_ID)}
                            className="px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold"
                          >
                            Reject Request
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 3rd Line: Last Remark with Date & Time */}
                    {(() => {
                      const isRemarkExpanded = !!expandedRemarkTaskIds[task.Task_ID];
                      const matchingRemarks = customerInteractions.filter(
                        i => i.Customer_ID === task.Customer_ID || (task.Task_ID && i.Task_ID === task.Task_ID)
                      );
                      const latestRemark = matchingRemarks.length > 0 ? matchingRemarks[matchingRemarks.length - 1] : null;
                      const remarkText = latestRemark ? latestRemark.Remarks : task.Remarks;
                      const remarkTime = latestRemark ? formatInteractionTimestamp(latestRemark.Timestamp) : null;

                      return (
                        <div
                          data-remark-history-box="true"
                          onClick={() => toggleRemarkExpand(task.Task_ID)}
                          className="mt-1 cursor-pointer select-none text-[11px] text-amber-900 bg-amber-50/90 hover:bg-amber-100/90 border border-amber-200/80 rounded-xl px-2.5 py-1.5 max-w-full shadow-2xs transition"
                          title="Tap to expand / collapse full remark history"
                        >
                          {!isRemarkExpanded ? (
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 truncate min-w-0 flex-1">
                                <MessageSquare className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                <span className="truncate text-slate-700 font-medium">
                                  {remarkText || 'No remarks logged yet'}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRemarkTask(task);
                                  setRemarkForm({ type: '', remarks: '' });
                                  setShowTagList(true);
                                  setShowRemarkInputs(true);
                                  setShowRemarksModal(true);
                                }}
                                className="shrink-0 p-1 rounded-md bg-indigo-600/75 hover:bg-indigo-600 active:bg-indigo-700 text-white inline-flex items-center justify-center shadow-2xs opacity-85 hover:opacity-100 transition ml-1.5"
                                title="Add Remark directly"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-2 py-1 animate-fadeIn">
                              <div className="flex items-center justify-between border-b border-amber-200/60 pb-1 gap-2">
                                <div className="flex items-center gap-2 font-bold text-amber-900 min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 truncate">
                                    <MessageSquare className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                    <span className="truncate">Complete Remarks & Interaction History</span>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRemarkTask(task);
                                      setRemarkForm({ type: '', remarks: '' });
                                      setShowTagList(true);
                                      setShowRemarkInputs(true);
                                      setShowRemarksModal(true);
                                    }}
                                    className="shrink-0 p-1 rounded-md bg-indigo-600/75 hover:bg-indigo-600 active:bg-indigo-700 text-white inline-flex items-center justify-center shadow-2xs opacity-85 hover:opacity-100 transition ml-1"
                                    title="Add Remark directly"
                                  >
                                    <Plus className="w-3 h-3" />
                                  </button>
                                </div>
                                <span className="text-[10px] text-amber-700 font-bold bg-amber-200/60 px-2 py-0.5 rounded-full">
                                  Tap again to collapse ▲
                                </span>
                              </div>

                              {matchingRemarks.length > 0 ? (
                                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                                  {matchingRemarks.slice().reverse().map((item, idx) => (
                                    <div key={idx} className="p-2 rounded-lg bg-white border border-amber-100 text-xs text-slate-800">
                                      <div className="flex items-start justify-between text-[10px] text-slate-500 mb-0.5 gap-2">
                                        <span className={`font-bold px-1.5 py-0.5 rounded ${remarkBadgeClass(item.Type, 'text-amber-800')}`}>{item.Type || 'Remark'}</span>
                                        <span className="flex flex-col items-end text-right shrink-0">
                                          <span className="font-bold text-slate-700">{item.Staff_Name || item.Staff_ID || 'Unknown'}</span>
                                          <span>{formatInteractionTimestamp(item.Timestamp)}</span>
                                        </span>
                                      </div>
                                      <p className="text-slate-700 font-medium whitespace-pre-wrap">{item.Remarks}</p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="p-2 rounded-lg bg-white border border-amber-100 text-xs text-slate-700 font-medium whitespace-pre-wrap">
                                  {remarkText || 'No remarks logged yet'}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Below on mobile/desktop: Action buttons (HIDDEN BY DEFAULT in normal/scrolling mode, expands when tapping company name or description) */}
                    {isExpanded && (
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap pt-2 mt-1 border-t border-slate-100 animate-fadeIn">
                        {/* CONVERSATION / REMARKS BUTTON (FIRST BUTTON) */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemarkTask(task);
                            setRemarkForm({ type: '', remarks: '' });
                            setShowTagList(true);
                            setShowRemarkInputs(true);
                            setShowRemarksModal(true);
                          }}
                          className="group relative w-8 h-8 rounded-xl bg-amber-50 hover:bg-amber-100 active:bg-amber-200 border border-amber-300 text-amber-800 flex items-center justify-center transition shrink-0"
                          title="Add Conversation / Remark"
                        >
                          <MessageSquare className="w-4 h-4 text-amber-600" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Conversation
                          </span>
                        </button>

                        {/* CALL BUTTON (Only show in bottom bar if hasContacts is true, else shown at top right near company name) */}
                        {hasContacts && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handlePhoneButtonClick(custObj, task); }}
                            className="group relative w-8 h-8 rounded-xl bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200 border border-emerald-200 text-emerald-700 flex items-center justify-center transition shrink-0"
                            title="Call Customer"
                          >
                            <PhoneCall className="w-4 h-4" />
                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                              Call
                            </span>
                          </button>
                        )}

                        {/* WHATSAPP BUTTON (Only show in bottom bar if hasContacts is true) */}
                        {hasContacts && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setContactModal({ isOpen: true, mode: 'WHATSAPP', customer: custObj, task }); }}
                            className="group relative w-8 h-8 rounded-xl bg-green-50 hover:bg-green-100 active:bg-green-200 border border-green-300 text-green-600 flex items-center justify-center transition shrink-0"
                            title="WhatsApp Chat"
                          >
                            <MessageCircle className="w-4 h-4" />
                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                              WhatsApp
                            </span>
                          </button>
                        )}

                        {/* LOCATION / DIRECTIONS BUTTON (Only show in bottom bar if hasLocation is true, else shown at top right near company name) */}
                        {hasLocation && (
                          <div className="flex items-center gap-1">
                            <a
                              href={mapUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="group relative w-8 h-8 rounded-xl bg-indigo-50 hover:bg-indigo-100 active:bg-indigo-200 border border-indigo-200 text-indigo-700 flex items-center justify-center transition shrink-0"
                              title="Open Google Directions"
                            >
                              <MapPin className="w-4 h-4" />
                              <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                                Directions
                              </span>
                            </a>
                          </div>
                        )}

                        {/* EDIT BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingTask({ ...task });
                            setShowEditTaskModal(true);
                          }}
                          className="group relative w-8 h-8 rounded-xl bg-sky-50 hover:bg-sky-100 active:bg-sky-200 border border-sky-200 text-sky-700 flex items-center justify-center transition shrink-0"
                          title="Edit Task"
                        >
                          <Edit3 className="w-4 h-4" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Edit
                          </span>
                        </button>

                        {/* RESCHEDULE BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openAdminModal(task, 'RESCHEDULE'); }}
                          className="group relative w-8 h-8 rounded-xl bg-sky-50 hover:bg-sky-100 active:bg-sky-200 border border-sky-200 text-sky-700 flex items-center justify-center transition shrink-0"
                          title="Reschedule Task"
                        >
                          <CalendarDays className="w-4 h-4 text-sky-600" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Reschedule
                          </span>
                        </button>

                        {/* STATUS BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openAdminModal(task, 'STATUS'); }}
                          className="group relative w-8 h-8 rounded-xl bg-orange-50 hover:bg-orange-100 active:bg-orange-200 border border-orange-200 text-orange-700 flex items-center justify-center transition shrink-0"
                          title="Change Status"
                        >
                          <Activity className="w-4 h-4 text-orange-600" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Status
                          </span>
                        </button>

                        {/* TAGS BUTTON — dynamic, admin-editable, multi-select labels */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setTagSearchQuery(''); setTaskTagPickerId(prev => prev === task.Task_ID ? null : task.Task_ID); }}
                            className="group relative w-8 h-8 rounded-xl bg-teal-50 hover:bg-teal-100 active:bg-teal-200 border border-teal-200 text-teal-700 flex items-center justify-center transition shrink-0"
                            title="Add/Edit Tags"
                          >
                            <TagIcon className="w-4 h-4 text-teal-600" />
                            {(task.Tags || []).length > 0 && (
                              <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 rounded-full bg-teal-600 text-white text-[9px] font-black flex items-center justify-center">
                                {task.Tags.length}
                              </span>
                            )}
                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                              Tags
                            </span>
                          </button>

                          {taskTagPickerId === task.Task_ID && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="absolute right-0 top-9 z-30 w-56 bg-white border border-slate-200 rounded-xl shadow-xl p-2.5 space-y-1.5 animate-fadeIn"
                            >
                              <div className="flex items-center gap-2 mb-1.5 border-b border-slate-100 pb-1.5">
                                <input
                                  type="text"
                                  placeholder="Search or type tag..."
                                  value={tagSearchQuery}
                                  onChange={(e) => setTagSearchQuery(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      handleTagInputSubmit(task);
                                    }
                                  }}
                                  className="flex-1 min-w-0 px-2 py-1 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-rose-500 bg-slate-50 focus:bg-white"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTaskTagPickerId(null);
                                    setTagSearchQuery('');
                                  }}
                                  className="text-slate-400 hover:text-slate-700 p-0.5"
                                  title="Close"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="max-h-52 overflow-y-auto space-y-1 pr-0.5">
                                {(() => {
                                  const query = (tagSearchQuery || '').trim().toLowerCase();
                                  const filtered = tags.filter(tag => (tag.name || '').toLowerCase().includes(query));
                                  const isExactMatch = tags.some(tag => (tag.name || '').toLowerCase() === query);
                                  
                                  return (
                                    <>
                                      {filtered.map(tag => {
                                        const checked = (task.Tags || []).includes(tag.Tag_ID);
                                        return (
                                          <button
                                            key={tag.Tag_ID}
                                            type="button"
                                            onClick={() => {
                                              handleToggleTaskTag(task, tag.Tag_ID);
                                              setTagSearchQuery('');
                                            }}
                                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border text-[11px] font-bold transition ${checked ? 'border-transparent' : 'border-slate-200 hover:bg-slate-50 text-slate-600'}`}
                                            style={checked ? { backgroundColor: tag.color, color: '#fff' } : undefined}
                                          >
                                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                                            <span className="truncate flex-1 text-left">{tag.name}</span>
                                            {checked && <Check className="w-3.5 h-3.5 shrink-0" />}
                                          </button>
                                        );
                                      })}
                                      
                                      {query !== '' && !isExactMatch && (
                                        <button
                                          type="button"
                                          onClick={() => handleCreateAndAddTag(task, tagSearchQuery.trim())}
                                          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 text-indigo-700 text-[11px] font-bold transition text-left"
                                        >
                                          <span className="shrink-0 text-xs">➕</span>
                                          <span className="truncate flex-1">Create & Add "{tagSearchQuery.trim()}"</span>
                                        </button>
                                      )}
                                      
                                      {filtered.length === 0 && query === '' && (
                                        <p className="text-[11px] text-slate-400 py-2 text-center">No tags yet. Use "Manage Tags" to create some.</p>
                                      )}
                                      
                                      {filtered.length === 0 && query !== '' && !isExactMatch && (
                                        <p className="text-[11px] text-slate-400 py-2 text-center">No matching tags found.</p>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* ADVANCE STAGE BUTTON */}
                        {task.Status !== 'Completed' && task.Status !== 'Closed' && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openAdminModal(task, 'ADVANCE'); }}
                            className="group relative w-8 h-8 rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 border border-rose-300 text-rose-700 flex items-center justify-center transition shrink-0"
                            title="Advance Work Stage"
                          >
                            <ChevronRight className="w-4 h-4 text-rose-600 font-extrabold" />
                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                              Advance
                            </span>
                          </button>
                        )}

                        {/* ASSIGN STAFF BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openAdminModal(task, 'ASSIGN'); }}
                          className="group relative w-8 h-8 rounded-xl bg-violet-50 hover:bg-violet-100 active:bg-violet-200 border border-violet-200 text-violet-700 flex items-center justify-center transition shrink-0"
                          title="Assign Staff"
                        >
                          <UserCheck className="w-4 h-4 text-violet-600" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Assign
                          </span>
                        </button>

                        {/* GENERATE CERTIFICATE BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); navigate(`/certificate-compliance/task/${task.Task_ID}`); }}
                          className={`group relative h-8 px-2.5 rounded-xl border flex items-center justify-center gap-1 transition shrink-0 ${
                            task.Department === 'Certification' || task.Stage === 'Certificate' || task.Stage === 'Certification'
                              ? 'bg-amber-500 hover:bg-amber-600 active:bg-amber-700 border-amber-600 text-white font-bold shadow-sm'
                              : 'bg-amber-50 hover:bg-amber-100 active:bg-amber-200 border-amber-300 text-amber-800 font-semibold'
                          }`}
                          title="Generate Fire Safety Certificate"
                        >
                          <Award className="w-4 h-4 text-current" />
                          <span className="text-[11px] font-bold hidden sm:inline">Cert</span>
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Generate Certificate
                          </span>
                        </button>

                        {/* REACTIVATE BUTTON (IF CLOSED/COMPLETED) */}
                        {(task.Status === 'Completed' || task.Status === 'Closed') && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleAdminReactivateTask(task); }}
                            className="group relative w-8 h-8 rounded-xl bg-purple-50 hover:bg-purple-100 active:bg-purple-200 border border-purple-200 text-purple-700 flex items-center justify-center transition shrink-0"
                            title="Reactivate Task"
                          >
                            <RefreshCw className="w-4 h-4 text-purple-600" />
                            <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                              Reactivate
                            </span>
                          </button>
                        )}

                        {/* DELETE BUTTON */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleAdminDeleteTask(task.Task_ID, task.Description || task.Task_ID); }}
                          className="group relative w-8 h-8 rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 border border-rose-200 text-rose-600 flex items-center justify-center transition shrink-0"
                          title="Delete Task"
                        >
                          <Trash2 className="w-4 h-4 text-rose-600" />
                          <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                            Delete
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB CONTENT 2: STAFF MANAGEMENT, SALARY & ACCESS PERMISSION ROSTER */}
      {(activeTab === 'STAFF' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'STAFF')) && (
        <div id="section-staff-roster" className="space-y-6">
          <div className="bg-slate-900 text-white rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
            <div>
              <h3 className="text-base font-bold flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-400" />
                Staff Profiles, Daily Salary & Access Permission Control
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                Manage staff profiles, daily salary rates, and grant specific access scopes (Assigned Work Only, All Customer List, or Full Access).
              </p>
            </div>
            <button
              onClick={() => setShowNewStaffModal(true)}
              className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition shrink-0"
            >
              <UserPlus className="w-4 h-4" />
              + Add New Staff Profile
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {staffList.map(staff => (
              <div key={staff.Staff_ID} className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-sm hover:shadow-md transition flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                      {staff.Staff_ID}
                    </span>
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {staff.Status || 'Active'}
                    </span>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-slate-900 flex items-center justify-between">
                      <span>{staff.Name}</span>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">
                        {staff.Role}
                      </span>
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5">{staff.Department} Department</p>
                  </div>

                  <div className="py-2.5 px-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1">
                    <p>📞 {staff.Mobile || 'N/A'}</p>
                    <p>✉️ {staff.Email || 'N/A'}</p>
                  </div>

                  {/* Daily Salary Rate Control */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-bold text-slate-600 flex items-center gap-1">
                      <IndianRupee className="w-3.5 h-3.5 text-emerald-600" />
                      Daily Salary Rate (₹ / Day)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        defaultValue={staff.Daily_Salary_Rate || 1000}
                        onBlur={e => handleUpdateStaffDailyRate(staff.Staff_ID, e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      <span className="text-[10px] text-slate-400 shrink-0 font-medium">Auto-Saves</span>
                    </div>
                  </div>

                  {/* Access Point Permissions Selector */}
                  <div className="space-y-1">
                    <label className="block text-[11px] font-bold text-slate-600 flex items-center gap-1">
                      <Key className="w-3.5 h-3.5 text-indigo-600" />
                      Staff Access Point & Scope Permission
                    </label>
                    <select
                      value={staff.Permissions || 'ASSIGNED_ONLY'}
                      onChange={e => handleUpdateStaffPermission(staff.Staff_ID, e.target.value)}
                      className="w-full px-3 py-1.5 bg-indigo-50/50 border border-indigo-200 rounded-xl text-xs font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="ASSIGNED_ONLY">Assigned Work Only (Sees own tasks & shifts)</option>
                      <option value="ALL_CUSTOMERS">All Customer Directory & CRM Access</option>
                      <option value="ALL_TASKS">All Company Work Orders & Pipeline</option>
                      <option value="FULL_ACCESS">Full Access (Supervisor / All Scope)</option>
                    </select>
                  </div>
                </div>

                {/* Staff Actions */}
                <div className="pt-3 border-t border-slate-200 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => {
                        if (startImpersonating) startImpersonating(staff);
                      }}
                      className="flex-1 min-w-[130px] px-3 py-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-indigo-600 hover:from-rose-700 hover:to-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm active:scale-95"
                      title="Access Account & Interface of this staff member"
                    >
                      <Shield className="w-3.5 h-3.5 text-rose-200 shrink-0" />
                      <span>Access Account</span>
                    </button>
                    <button
                      onClick={() => setSelectedStaffProfile(staff)}
                      className="flex-1 min-w-[120px] px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-sm"
                    >
                      <History className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span>Task Assigned ({tasks.filter(t => t.Assigned_Staff === staff.Staff_ID || t.Assigned_Staff_Name === staff.Name).length})</span>
                    </button>
                    <button
                      onClick={() => {
                        setIcardTargetUser(staff);
                        setShowICardModal(true);
                      }}
                      className="flex-1 min-w-[100px] px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-xs"
                      title="View ID Card of this staff member"
                    >
                      <CreditCard className="w-3.5 h-3.5 shrink-0" />
                      <span>ID Card</span>
                    </button>
                  </div>

                  {/* Login Credentials: Staff ID acts as the username — password can only be set/reset, never viewed (it's hashed) */}
                  <div className="flex items-center gap-2 p-2 rounded-xl bg-slate-50 border border-slate-200">
                    <div className="flex-1 min-w-0 text-[11px]">
                      <span className="text-slate-400 font-semibold">Login ID:</span>{' '}
                      <span className="font-bold text-slate-800">{staff.Staff_ID}</span>
                    </div>
                    <button
                      onClick={() => { setPasswordResetTarget(staff); setPasswordResetForm({ adminPassword: '', newPassword: '', confirmPassword: '' }); setPasswordResetError(''); }}
                      className="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 text-[11px] font-bold flex items-center gap-1.5 transition shrink-0"
                      title="Set / Reset Password"
                    >
                      <Key className="w-3.5 h-3.5" />
                      <span>Set Password</span>
                    </button>
                    <button
                      onClick={() => handleDeleteStaff(staff.Staff_ID, staff.Name)}
                      className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 transition shrink-0"
                      title="Remove Staff"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* SET / RESET STAFF PASSWORD MODAL (Admin override — requires Admin's own password) */}
          {passwordResetTarget && (
            <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
              <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full p-4 sm:p-6 shadow-2xl space-y-4 animate-fadeIn">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Key className="w-4 h-4 text-amber-600" />
                    <span>Set Password</span>
                  </h3>
                  <button
                    onClick={() => setPasswordResetTarget(null)}
                    className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
                  >
                    ✕
                  </button>
                </div>

                <div className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <p className="font-bold text-slate-900">{passwordResetTarget.Name}</p>
                  <p className="text-slate-500 mt-0.5">Login ID: {passwordResetTarget.Staff_ID}</p>
                </div>

                <form onSubmit={handleAdminSetStaffPassword} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Your Admin Password *</label>
                    <input
                      type="password"
                      required
                      value={passwordResetForm.adminPassword}
                      onChange={e => setPasswordResetForm(p => ({ ...p, adminPassword: e.target.value }))}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      placeholder="Confirm it's really you"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">New Password for {passwordResetTarget.Staff_ID} *</label>
                    <input
                      type="password"
                      required
                      value={passwordResetForm.newPassword}
                      onChange={e => setPasswordResetForm(p => ({ ...p, newPassword: e.target.value }))}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">Min 8 characters, with at least one letter, one number & one special character.</p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm New Password *</label>
                    <input
                      type="password"
                      required
                      value={passwordResetForm.confirmPassword}
                      onChange={e => setPasswordResetForm(p => ({ ...p, confirmPassword: e.target.value }))}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>

                  {passwordResetError && (
                    <p className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{passwordResetError}</p>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                    <button
                      type="button"
                      onClick={() => setPasswordResetTarget(null)}
                      className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={passwordResetSubmitting}
                      className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50"
                    >
                      {passwordResetSubmitting ? 'Saving...' : 'Set Password'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* NEW STAFF PROFILE MODAL */}
          {showNewStaffModal && (
            <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
              <div className="bg-white border border-slate-200 rounded-3xl max-w-lg w-full p-4 sm:p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                  <div className="flex items-center gap-2">
                    <UserPlus className="w-5 h-5 text-emerald-600" />
                    <h3 className="text-base font-bold text-slate-900">Add New Staff Member Profile</h3>
                  </div>
                  <button
                    onClick={() => setShowNewStaffModal(false)}
                    className="text-slate-400 hover:text-slate-600 font-bold text-sm"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleCreateStaffSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Full Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Amit Verma"
                      value={newStaffForm.name}
                      onChange={e => setNewStaffForm({ ...newStaffForm, name: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Login Email *</label>
                      <input
                        type="email"
                        required
                        placeholder="amit.v@expertsafety.in"
                        value={newStaffForm.email}
                        onChange={e => setNewStaffForm({ ...newStaffForm, email: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Login Password *</label>
                      <input
                        type="text"
                        required
                        placeholder="Default: staff123"
                        value={newStaffForm.password}
                        onChange={e => setNewStaffForm({ ...newStaffForm, password: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Mobile Phone</label>
                      <input
                        type="text"
                        placeholder="+91 98000 11223"
                        value={newStaffForm.mobile}
                        onChange={e => setNewStaffForm({ ...newStaffForm, mobile: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Daily Salary Rate (₹)</label>
                      <input
                        type="number"
                        required
                        value={newStaffForm.dailySalaryRate}
                        onChange={e => setNewStaffForm({ ...newStaffForm, dailySalaryRate: Number(e.target.value) })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Role</label>
                      <select
                        value={newStaffForm.role}
                        onChange={e => setNewStaffForm({ ...newStaffForm, role: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="Staff">Staff</option>
                        <option value="Supervisor">Supervisor</option>
                        <option value="Admin">Admin</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">Department</label>
                      <select
                        value={newStaffForm.department}
                        onChange={e => setNewStaffForm({ ...newStaffForm, department: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="Field Operations">Field Operations</option>
                        <option value="Sales">Sales</option>
                        <option value="Production">Production</option>
                        <option value="Service">Service</option>
                        <option value="Certification">Certification</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Initial Access Point Permission Scope *</label>
                    <select
                      value={newStaffForm.permissions}
                      onChange={e => setNewStaffForm({ ...newStaffForm, permissions: e.target.value })}
                      className="w-full px-3 py-2 border border-indigo-200 bg-indigo-50/40 rounded-xl text-xs font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="ASSIGNED_ONLY">Assigned Work Only (Sees own tasks & shifts)</option>
                      <option value="ALL_CUSTOMERS">All Customer Directory & CRM Access</option>
                      <option value="ALL_TASKS">All Company Work Orders & Pipeline</option>
                      <option value="FULL_ACCESS">Full Access (Supervisor / All Scope)</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200">
                    <button
                      type="button"
                      onClick={() => setShowNewStaffModal(false)}
                      className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold transition"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={creatingStaff}
                      className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition"
                    >
                      {creatingStaff ? 'Creating...' : '+ Create Staff Profile'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT 3: CUSTOMER DIRECTORY & 360 CLIENT PROFILE */}
      {(activeTab === 'CUSTOMERS' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'CUSTOMERS')) && (
        <div id="section-customers-list" className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Bulk Customer Management</h3>
              <p className="text-xs text-slate-500">Export list to edit in Excel, or upload a CSV to create/update records in bulk.</p>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleExportCustomers}
                className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition"
              >
                Export CSV
              </button>
              <label className="flex-1 sm:flex-initial px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer">
                Upload CSV
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleImportCustomers}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {customers.map(cust => {
              const custTasksCount = tasks.filter(t => t.Customer_ID === cust.Customer_ID).length;
              const custInteractionsCount = customerInteractions.filter(i => i.Customer_ID === cust.Customer_ID).length;
              return (
                <div key={cust.Customer_ID} className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-sm hover:shadow-md transition flex flex-col justify-between space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-rose-600 px-2 py-0.5 rounded-full bg-rose-50 border border-rose-200">
                        {cust.Customer_ID}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {(cust.Location_Link || cust.Address) && (
                          <a
                            href={getGoogleDirectionsUrl(cust.Location_Link, cust.Address, cust.Company_Name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-indigo-600 hover:underline flex items-center gap-1 font-semibold bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100"
                            title="Open Google Directions"
                          >
                            <MapPin className="w-3.5 h-3.5" />
                            Directions
                          </a>
                        )}
                        <button
                          type="button"
                          disabled={fetchingLocationFor === cust.Customer_ID}
                          onClick={() => handleFetchAndSaveCustomerGps(cust)}
                          className="text-xs text-amber-700 hover:bg-amber-100 bg-amber-50 px-2 py-0.5 rounded-lg border border-amber-200 flex items-center gap-1 font-bold transition shadow-2xs"
                          title="Update location accurately directly from your current GPS coordinates"
                        >
                          <Navigation className={`w-3 h-3 ${fetchingLocationFor === cust.Customer_ID ? 'animate-spin text-amber-600' : ''}`} />
                          <span>{fetchingLocationFor === cust.Customer_ID ? 'Locating...' : '📍 Fetch GPS'}</span>
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-base font-bold text-slate-900 flex-1 min-w-0 truncate">{cust.Company_Name}</h4>
                        <button
                          type="button"
                          title="Edit Customer Details"
                          onClick={() => {
                            const parsedCoords = (() => {
                              try {
                                if (typeof cust.Coordinators === 'string' && cust.Coordinators.startsWith('[')) return JSON.parse(cust.Coordinators);
                                if (Array.isArray(cust.Coordinators)) return cust.Coordinators;
                              } catch { }
                              return [];
                            })();
                            setEditingCustomer(cust);
                            setEditCustomerForm({
                              companyName: cust.Company_Name || '',
                              authPerson: cust.Auth_Person || '',
                              contact: (cust.Contact || '').replace(/^\+91\s?/, ''),
                              email: cust.Email || '',
                              locationLink: cust.Location_Link || '',
                              address: cust.Address || '',
                              specialNotes: cust.Special_Notes || '',
                              coordinators: parsedCoords.length > 0 ? parsedCoords : []
                            });
                            setIsEditCustomerNotesUnlocked(!cust.Special_Notes);
                            setShowEditCustomerModal(true);
                          }}
                          className="w-6 h-6 rounded-lg bg-slate-100 hover:bg-indigo-100 border border-slate-200 hover:border-indigo-300 flex items-center justify-center text-slate-400 hover:text-indigo-600 transition shrink-0"
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-xs text-slate-500">Auth Person: {cust.Auth_Person}</p>
                    </div>
                    <p className="text-xs text-slate-700 line-clamp-2">{cust.Address}</p>
                  </div>

                  <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handlePhoneButtonClick(cust, null)}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      Call {getAvailableContacts(cust, null).length > 1 ? 'Options' : `(${cust.Contact})`}
                    </button>
                    
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCustomerForEquipment(cust);
                        setShowClientEquipmentModal(true);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                      title="Manage Client's Pre-loaded Equipment Inventory Master"
                    >
                      <span>🧯 Equipment Master</span>
                    </button>

                    <button
                      onClick={() => setSelectedCustomerModal(cust)}
                      className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                    >
                      <History className="w-3.5 h-3.5 text-rose-400" />
                      Profile ({custTasksCount + custInteractionsCount})
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ADMIN TASK ACTION MODALS (RESCHEDULE / ADVANCE / STATUS / ASSIGN) */}
      {activeModal && selectedTask && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                {activeModal === 'ADVANCE' && 'Advance Workflow Stage'}
                {activeModal === 'RESCHEDULE' && 'Reschedule Service Date'}
                {activeModal === 'STATUS' && 'Update Task Status'}
                {activeModal === 'ASSIGN' && 'Assign Task to Staff'}
              </h3>
              <button
                onClick={closeAdminModal}
                className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            {selectedTask && (
              <div className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-200">
                <p className="font-bold text-slate-900">{selectedTask.Customer_Name}</p>
                <p className="text-slate-500 mt-0.5">{selectedTask.Description}</p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded-md bg-rose-50 border border-rose-200 text-rose-700 font-bold">Stage: {selectedTask.Stage}</span>
                  <span className="px-2 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-bold">Staff: {selectedTask.Assigned_Staff_Name || selectedTask.Assigned_Staff || 'Unassigned'}</span>
                </div>
              </div>
            )}

            {/* FORM OR ACTIONS */}
            {activeModal === 'STATUS' ? (
              <div className="space-y-3 pt-2">
                {['Started', 'In Progress', 'Completed'].map(status => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => {
                      setAdminTargetStatus(status);
                      const submitDirect = async () => {
                        try {
                          setAdminSubmitting('status');
                          const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/status`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ status })
                          });
                          if (!res.ok) {
                            const errData = await res.json().catch(() => ({}));
                            throw new Error(errData.details || errData.error || 'Status update failed');
                          }
                          closeAdminModal();
                          loadAdminData();
                        } catch (err) { alert(err.message); }
                        finally { setAdminSubmitting(''); }
                      };
                      submitDirect();
                    }}
                    className={`w-full py-3 rounded-xl font-bold text-sm transition shadow-sm border ${
                      selectedTask.Status === status
                        ? 'bg-rose-50 border-rose-300 text-rose-700'
                        : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    {status}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setAdminTargetStatus('');
                    const submitDirect = async () => {
                      try {
                        setAdminSubmitting('status');
                        const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/status`, {
                          method: 'PUT',
                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                          body: JSON.stringify({ status: '' })
                        });
                        if (!res.ok) {
                          const errData = await res.json().catch(() => ({}));
                          throw new Error(errData.details || errData.error || 'Status update failed');
                        }
                        closeAdminModal();
                        loadAdminData();
                      } catch (err) { alert(err.message); }
                      finally { setAdminSubmitting(''); }
                    };
                    submitDirect();
                  }}
                  className="w-full py-3 rounded-xl font-bold text-sm transition shadow-sm border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-500"
                  title="Reset an accidentally-set status — hides this task from the Started/In Progress/Completed/Closed tabs, still visible under ALL"
                >
                  ⟲ Reset to No Status
                </button>
              </div>
            ) : activeModal === 'ASSIGN' ? (
              <form onSubmit={handleAdminAssignTask} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Select Staff Member to Assign *
                  </label>
                  {(selectedTask?.Department === 'Certification' || selectedTask?.Stage === 'Certificate' || selectedTask?.Stage === 'Certification') && (
                    <div className="p-2.5 mb-2 bg-amber-50 border border-amber-200 rounded-xl space-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-amber-900">🛡️ Certification Option: Restricted to Admin staff (`as on now`).</span>
                        <label className="flex items-center gap-1.5 cursor-pointer text-indigo-700 font-bold">
                          <input
                            type="checkbox"
                            checked={!showOnlyAdminForCert}
                            onChange={e => setShowOnlyAdminForCert(!e.target.checked)}
                            className="rounded text-indigo-600 focus:ring-indigo-500"
                          />
                          <span>Allow Assigning to Other Staff</span>
                        </label>
                      </div>
                      <p className="text-[11px] text-amber-800 font-medium">By default, Certification tasks are assigned to Admin/Supervisor staff only. Check the box above to assign to other field personnel.</p>
                    </div>
                  )}
                  <select
                    required
                    value={adminAssignedStaff}
                    onChange={(e) => setAdminAssignedStaff(e.target.value)}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-slate-900 text-xs font-bold focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="">-- Select Staff --</option>
                    {getFilteredStaffList(selectedTask?.Department || selectedTask?.Stage).map(st => (
                      <option key={st.Staff_ID} value={st.Staff_ID}>
                        {st.Name} ({st.Staff_ID || st.Department || 'Staff'})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={closeAdminModal}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={adminSubmitting === 'assign'}
                    className="px-5 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    <span>{adminSubmitting === 'assign' ? 'Assigning...' : 'Confirm Assignment'}</span>
                  </button>
                </div>
              </form>
            ) : (
              <form
                onSubmit={
                  activeModal === 'ADVANCE'
                    ? handleAdminAdvanceStage
                    : handleAdminReschedule
                }
                className="space-y-4"
              >
                {activeModal === 'RESCHEDULE' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      New Scheduled Date *
                    </label>
                    <input
                      type="date"
                      required
                      value={adminNewDate}
                      onChange={(e) => setAdminNewDate(e.target.value)}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {activeModal === 'RESCHEDULE' ? 'Mandatory Reschedule Remarks *' : 'Admin Remarks / Notes'}
                  </label>
                  <textarea
                    rows={3}
                    required={activeModal === 'RESCHEDULE'}
                    placeholder={
                      activeModal === 'RESCHEDULE'
                        ? 'Why is this work order being rescheduled? (Mandatory)'
                        : 'Enter stage advancement notes or instructions...'
                    }
                    value={adminRemarks}
                    onChange={(e) => setAdminRemarks(e.target.value)}
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={closeAdminModal}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={Boolean(adminSubmitting)}
                    className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50"
                  >
                    {adminSubmitting ? 'Saving...' : activeModal === 'ADVANCE' ? 'Advance Stage Now' : 'Confirm Reschedule'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* MANAGE TAGS MODAL — create/rename/recolor/delete dynamic task tags */}
      {showTagManagerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <TagIcon className="w-4 h-4 text-teal-600" />
                <span>Manage Task Tags</span>
              </h3>
              <button
                onClick={() => { setShowTagManagerModal(false); setEditingTagId(null); }}
                className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <p className="text-[11px] text-slate-500 -mt-2">
              Create custom labels (New Inquiry, Site Visit, Pickup, Documentation...) and assign as many as needed to any task via the tag button on the task card. Edits here apply everywhere instantly.
            </p>

            {/* Create New Tag */}
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5">
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="w-9 h-9 rounded-lg border border-slate-300 cursor-pointer shrink-0 bg-white"
                title="Tag color"
              />
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTag(); }}
                placeholder="New tag name (e.g. Site Visit)"
                className="flex-1 min-w-0 px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-bold focus:ring-2 focus:ring-teal-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCreateTag}
                disabled={!newTagName.trim()}
                className="px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-40 shrink-0 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>

            {/* Existing Tags List */}
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {tags.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-6">No tags created yet. Add your first one above.</p>
              )}
              {tags.map(tag => (
                <div key={tag.Tag_ID} className="flex items-center gap-2 p-2 rounded-xl border border-slate-200 bg-white">
                  {editingTagId === tag.Tag_ID ? (
                    <>
                      <input
                        type="color"
                        value={editingTagDraft.color}
                        onChange={(e) => setEditingTagDraft(d => ({ ...d, color: e.target.value }))}
                        className="w-8 h-8 rounded-lg border border-slate-300 cursor-pointer shrink-0 bg-white"
                      />
                      <input
                        type="text"
                        value={editingTagDraft.name}
                        onChange={(e) => setEditingTagDraft(d => ({ ...d, name: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleUpdateTag(tag.Tag_ID); }}
                        className="flex-1 min-w-0 px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold focus:ring-2 focus:ring-teal-500 focus:outline-none"
                        autoFocus
                      />
                      <button type="button" onClick={() => handleUpdateTag(tag.Tag_ID)} className="w-7 h-7 rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-700 flex items-center justify-center shrink-0" title="Save">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => setEditingTagId(null)} className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center shrink-0" title="Cancel">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="flex-1 min-w-0 truncate text-xs font-bold text-slate-800">{tag.name}</span>
                      <button
                        type="button"
                        onClick={() => { setEditingTagId(tag.Tag_ID); setEditingTagDraft({ name: tag.name, color: tag.color }); }}
                        className="w-7 h-7 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-700 flex items-center justify-center shrink-0"
                        title="Rename / Recolor"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTag(tag.Tag_ID)}
                        className="w-7 h-7 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 flex items-center justify-center shrink-0"
                        title="Delete Tag"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* REMARKS & INTERACTION HISTORY MODAL (ADMIN) — full-screen with back button, so the History list gets maximum screen space */}
      {showRemarksModal && remarkTask && (
            <div className="fixed inset-0 z-50 bg-white flex flex-col">
              <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3 sm:px-6 shrink-0">
                <button
                  onClick={() => {
                    setShowRemarksModal(false);
                    setRemarkTask(null);
                    setShowTagList(true);
                    setShowRemarkInputs(true);
                    setHistorySearchText('');
                    setShowHistorySearch(false);
                    setIsMasterRemarksSearch(false);
                    setMasterRemarksSearchQuery('');
                  }}
                  className="p-1.5 -ml-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition shrink-0"
                  title="Back"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-amber-600 shrink-0" />
                    Discussion Log
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">
                    Client: <strong className="text-slate-800">
                      {(remarkTask.Customer_Name && remarkTask.Customer_Name !== 'General Client' && remarkTask.Customer_Name !== 'Unknown Company')
                        ? remarkTask.Customer_Name
                        : (customersById.get(String(remarkTask.Customer_ID || '').trim().toLowerCase())?.Company_Name || remarkTask.Customer_Name || (remarkTask.Customer_ID ? `Customer (${remarkTask.Customer_ID})` : 'General Client'))}
                    </strong> • Task: #{remarkTask.Task_ID}
                  </p>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-5 animate-fadeIn">

                {/* ADD NEW REMARK FORM (Auto-hidden after submit or when search / full-page history mode is active) */}
                {!showHistorySearch && !isMasterRemarksSearch && (
                  !showRemarkInputs ? (
                    <div
                      onClick={() => setShowRemarkInputs(true)}
                      className="bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white rounded-2xl p-3.5 shadow-sm border-2 border-amber-600 flex items-center justify-between cursor-pointer transition"
                      title="Click to add another remark"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-xl bg-white text-amber-600 flex items-center justify-center font-extrabold text-base shadow-2xs shrink-0">
                          +
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-xs font-extrabold flex items-center gap-1.5 truncate">
                            <span>1. Select Tag & 2. Discussion Details</span>
                          </h4>
                          <p className="text-[10px] text-amber-100 font-bold mt-0.5 truncate">
                            Tap here to open fields and add another remark
                          </p>
                        </div>
                      </div>
                      <span className="px-3 py-1.5 rounded-xl bg-amber-700 hover:bg-amber-800 text-white text-xs font-extrabold shadow-2xs flex items-center gap-1 shrink-0 ml-2">
                        + Add New
                      </span>
                    </div>
                  ) : (
                    <form onSubmit={handleAddRemarkSubmit} className="bg-amber-50/50 border border-amber-200 rounded-2xl p-4 space-y-3 animate-fadeIn">
                    <div className="space-y-4">
                      {/* 1. TAG SELECTION FIELD (DROPDOWN FORMAT) */}
                      <div className="space-y-1.5">
                        <label className="block text-xs font-bold text-slate-800">
                          1. Select Tag / Interaction Type *
                        </label>
                        <div className="relative">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setShowTagList(!showTagList)}
                              className="flex-1 min-w-0 flex items-center justify-between px-3.5 py-2.5 bg-white border-2 border-slate-300 hover:border-amber-500 rounded-xl text-xs font-bold text-slate-800 shadow-2xs transition cursor-pointer text-left"
                            >
                              <span className="flex items-center gap-2 min-w-0 flex-1">
                                {remarkForm.type ? (
                                  <span className="px-2.5 py-0.5 rounded-lg bg-amber-600 text-white font-extrabold text-xs shrink-0 shadow-2xs">
                                    {remarkForm.type}
                                  </span>
                                ) : (
                                  <span className="px-2.5 py-0.5 rounded-lg bg-slate-100 text-slate-500 font-bold text-xs shrink-0 border border-dashed border-slate-300">
                                    Select Tag
                                  </span>
                                )}
                                <span className="text-slate-500 font-normal truncate">
                                  {remarkForm.type
                                    ? (!showTagList ? '(Click to change tag or correct mistake)' : '(Choose tag from dropdown below)')
                                    : '(Tap to search & select a tag)'}
                                </span>
                              </span>
                              <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${showTagList ? 'rotate-180 text-amber-600' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleAddCustomTag(e, false, true)}
                              className="shrink-0 w-10 h-10 rounded-xl bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white flex items-center justify-center shadow-2xs transition"
                              title="Add New Tag"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Dropdown Menu when showTagList is true */}
                          {showTagList && (
                            <div className="mt-2 bg-white border-2 border-amber-300 rounded-2xl shadow-xl overflow-hidden animate-fadeIn space-y-2 p-2.5 z-30">
                              <div className="flex items-center gap-1.5 pb-1.5 border-b border-amber-100">
                                <div className="relative flex-1">
                                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                                  <input
                                    type="text"
                                    placeholder="🔍 Search Tag (e.g. Call, FLP)..."
                                    value={tagSearch}
                                    onChange={(e) => setTagSearch(e.target.value)}
                                    className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-xl text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500 font-semibold"
                                    autoFocus
                                  />
                                </div>
                              </div>
                              <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                                {remarkTagsList.filter(t => !tagSearch.trim() || t.toLowerCase().includes(tagSearch.toLowerCase())).map(tag => {
                                  const isCustom = customRemarkTags.includes(tag) && !REMARK_TAGS.includes(tag);
                                  return (
                                    <div
                                      key={tag}
                                      onClick={() => handleRemarkTagSelect(tag)}
                                      className={`flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold cursor-pointer transition group ${remarkForm.type === tag
                                        ? 'bg-amber-600 text-white font-extrabold shadow-sm'
                                        : 'hover:bg-amber-50 text-slate-700'
                                        }`}
                                    >
                                      <div className="flex items-center gap-1.5 min-w-0 truncate">
                                        <span className="truncate">{tag}</span>
                                        {isCustom && (
                                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-extrabold shrink-0 ${remarkForm.type === tag ? 'bg-amber-700 text-amber-100' : 'bg-amber-100 text-amber-800'
                                            }`}>
                                            Custom
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-1.5 shrink-0">
                                        {remarkForm.type === tag && <span className="text-[11px] bg-amber-700/60 px-1.5 py-0.5 rounded text-white">✓ Selected</span>}
                                        {isCustom && (
                                          <button
                                            type="button"
                                            onClick={(e) => handleDeleteCustomTag(e, tag)}
                                            className={`p-1 rounded-lg transition ${remarkForm.type === tag
                                              ? 'hover:bg-amber-700 text-white'
                                              : 'hover:bg-rose-100 text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100'
                                              }`}
                                            title="Delete custom tag"
                                          >
                                            <X className="w-3.5 h-3.5" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                                {remarkTagsList.filter(t => !tagSearch.trim() || t.toLowerCase().includes(tagSearch.toLowerCase())).length === 0 && (
                                  <div className="p-4 text-center space-y-2">
                                    <p className="text-xs text-slate-400 font-medium">No matching tag found.</p>
                                    <button
                                      type="button"
                                      onClick={handleAddCustomTag}
                                      className="px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold text-xs rounded-xl inline-flex items-center gap-1 cursor-pointer transition shadow-2xs"
                                    >
                                      <Plus className="w-3.5 h-3.5 text-amber-700" />
                                      <span>Add "{tagSearch}" as new tag</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 2. DISCUSSION DETAILS & REMARKS FIELD (Opens once tag is selected) */}
                      {!showTagList && remarkForm.type && (
                        <div className="space-y-2.5 animate-fadeIn pt-3 border-t border-amber-200/60">
                          <div className="flex items-center justify-between flex-wrap gap-1">
                            <label className="block text-xs font-bold text-slate-800">
                              2. Discussion Details & Remarks * <span className="text-amber-800 font-normal">({remarkForm.type})</span>
                            </label>
                            <span className="text-[10px] text-amber-700 font-bold bg-amber-100/80 px-2 py-0.5 rounded-md">
                              ⚡ Press Ctrl+Enter or click Save below
                            </span>
                          </div>
                          <textarea
                            required
                            rows={5}
                            autoFocus
                            placeholder={`Write detailed discussion points, outcomes, and remarks for [${remarkForm.type}]...\n\nProvide all relevant details clearly.`}
                            value={remarkForm.remarks}
                            onChange={(e) => setRemarkForm({ ...remarkForm, remarks: e.target.value })}
                            onKeyDown={(e) => {
                              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && remarkForm.remarks.trim()) {
                                e.preventDefault();
                                handleAddRemarkSubmit(e);
                              }
                            }}
                            className="w-full px-3.5 py-3 border-2 border-slate-300 rounded-xl text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500 font-medium leading-relaxed resize-y min-h-[130px] shadow-2xs"
                          />
                          <div className="flex justify-end pt-1">
                            <button
                              type="submit"
                              disabled={submittingRemark}
                              className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-bold text-xs shadow-sm transition disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              <span>{submittingRemark ? 'Saving...' : 'Save & Share Remark'}</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </form>
                  )
                )}

                {/* PREVIOUS SHARED INTERACTION HISTORY (Full page when search mode is active) */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between pb-1 border-b border-slate-100">
                    <span className="text-xs font-bold text-slate-800 tracking-wider">HISTORY</span>

                        {/* Search buttons on right side of page along with Back button */}
                        <div className="flex items-center gap-1.5">
                          {/* Regular Search Magnifier */}
                          <button
                            type="button"
                            onClick={() => {
                              const newVal = !showHistorySearch;
                              setShowHistorySearch(newVal);
                              if (newVal) setIsMasterRemarksSearch(false);
                            }}
                            className={`p-1.5 rounded-lg text-sm font-bold inline-flex items-center justify-center transition shadow-2xs cursor-pointer ${
                              showHistorySearch || historySearchText
                                ? 'bg-amber-100 text-amber-900 border border-amber-300 ring-2 ring-amber-400'
                                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
                            }`}
                            title="Search & filter remarks history for this client/task"
                          >
                            <span>🔎</span>
                          </button>

                          {/* Master Search Magnifier in RED right side of page */}
                          <button
                            type="button"
                            onClick={() => {
                              const newMaster = !isMasterRemarksSearch;
                              setIsMasterRemarksSearch(newMaster);
                              if (newMaster) setShowHistorySearch(false);
                            }}
                            className={`p-1.5 rounded-lg text-sm font-bold inline-flex items-center justify-center transition shadow-2xs cursor-pointer border ${
                              isMasterRemarksSearch
                                ? 'bg-red-600 hover:bg-red-700 text-white border-red-700 ring-2 ring-red-400 shadow-sm'
                                : 'bg-red-100/90 hover:bg-red-600 hover:text-white text-red-700 border-red-300'
                            }`}
                            title="Master Search — Search ALL remarks for this company across all staff and tasks"
                          >
                            <span>🔍</span>
                          </button>

                          {/* Back button when search / full-page history mode is open */}
                          {(showHistorySearch || isMasterRemarksSearch) && (
                            <button
                              type="button"
                              onClick={() => {
                                setShowHistorySearch(false);
                                setIsMasterRemarksSearch(false);
                                setHistorySearchText('');
                                setMasterRemarksSearchQuery('');
                                setMasterRemarksStaffFilter('ALL');
                              }}
                              className="px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs inline-flex items-center gap-1 transition cursor-pointer shadow-sm ml-1"
                              title="Back to previous view (Restore form & select tag)"
                            >
                              <span>← Back</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {showHistorySearch && !isMasterRemarksSearch && (
                        <div className="relative animate-fadeIn">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            placeholder="🔍 Search this client's remarks by text, tag, or staff name..."
                            value={historySearchText}
                            onChange={(e) => setHistorySearchText(e.target.value)}
                            className="w-full pl-8 pr-8 py-1.5 border border-amber-300 rounded-xl text-xs bg-amber-50/40 focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500 font-semibold"
                          />
                          {historySearchText && (
                            <button
                              type="button"
                              onClick={() => setHistorySearchText('')}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-bold text-xs"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )}

                      {isMasterRemarksSearch ? (
                        <div className="space-y-3 animate-fadeIn bg-indigo-50/60 p-3.5 rounded-2xl border border-indigo-200">
                          {(() => {
                            const companyInteractions = customerInteractions.filter(item => {
                              return (remarkTask?.Customer_ID && item.Customer_ID === remarkTask.Customer_ID) ||
                                     (remarkTask?.Customer_Name && item.Customer_Name && item.Customer_Name.trim().toLowerCase() === remarkTask.Customer_Name.trim().toLowerCase()) ||
                                     (item.Task_ID && remarkTask?.Task_ID && item.Task_ID === remarkTask.Task_ID);
                            });
                            const uniqueStaffNames = Array.from(new Set(companyInteractions.map(item => item.Staff_Name || item.Staff_ID || 'Unknown Staff').filter(Boolean)));

                            const allRemarks = companyInteractions.filter(item => {
                              if (masterRemarksStaffFilter !== 'ALL') {
                                const staffLabel = item.Staff_Name || item.Staff_ID || 'Unknown Staff';
                                if (staffLabel !== masterRemarksStaffFilter) return false;
                              }
                              if (!masterRemarksSearchQuery.trim()) return true;
                              const q = masterRemarksSearchQuery.toLowerCase();
                              return (
                                (item.Remarks && item.Remarks.toLowerCase().includes(q)) ||
                                (item.Type && item.Type.toLowerCase().includes(q)) ||
                                (item.Staff_Name && item.Staff_Name.toLowerCase().includes(q)) ||
                                (item.Staff_ID && item.Staff_ID.toLowerCase().includes(q))
                              );
                            });

                            return (
                              <>
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                  <span className="text-xs font-bold text-indigo-950 flex items-center gap-1.5">
                                    <span>🌐 Company Master Remarks ({remarkTask?.Customer_Name || remarkTask?.Customer_ID || 'Client'})</span>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-200 text-indigo-900 font-extrabold">
                                      {allRemarks.length} total found
                                    </span>
                                  </span>
                                </div>

                                <div className="flex flex-col sm:flex-row gap-2">
                                  <select
                                    value={masterRemarksStaffFilter}
                                    onChange={(e) => setMasterRemarksStaffFilter(e.target.value)}
                                    className="py-2 px-3 border border-indigo-300 rounded-xl text-xs bg-white font-bold text-indigo-950 focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-2xs sm:w-56"
                                  >
                                    <option value="ALL">All Staff & Admin ({companyInteractions.length})</option>
                                    {uniqueStaffNames.map(staffName => (
                                      <option key={staffName} value={staffName}>
                                        {staffName} ({companyInteractions.filter(i => (i.Staff_Name || i.Staff_ID || 'Unknown Staff') === staffName).length})
                                      </option>
                                    ))}
                                  </select>

                                  <div className="relative flex-1">
                                    <Search className="w-4 h-4 text-indigo-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                                    <input
                                      type="text"
                                      placeholder="🔍 Search all staff remarks for this company by text or tag..."
                                      value={masterRemarksSearchQuery}
                                      onChange={(e) => setMasterRemarksSearchQuery(e.target.value)}
                                      className="w-full pl-10 pr-8 py-2 border border-indigo-300 rounded-xl text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 font-semibold shadow-2xs"
                                      autoFocus
                                    />
                                    {masterRemarksSearchQuery && (
                                      <button
                                        type="button"
                                        onClick={() => setMasterRemarksSearchQuery('')}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-bold text-xs"
                                      >
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                </div>

                                <div className="space-y-2.5 pr-1">
                                  {allRemarks.length === 0 ? (
                                    <div className="p-6 text-center text-xs text-slate-400 bg-white rounded-xl border border-dashed border-indigo-200 font-medium">
                                      No matching remarks found for this company{masterRemarksSearchQuery ? ` ("${masterRemarksSearchQuery}")` : ''}{masterRemarksStaffFilter !== 'ALL' ? ` by ${masterRemarksStaffFilter}` : ''}.
                                    </div>
                                  ) : (
                                    allRemarks.slice().reverse().map((item, idx) => (
                                      <div key={item.Interaction_ID || idx} className="p-3.5 rounded-xl bg-white border border-indigo-100 shadow-2xs space-y-1.5 hover:border-indigo-300 transition">
                                        <div className="flex items-center justify-between flex-wrap gap-2">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`px-2 py-0.5 rounded font-extrabold text-[10px] ${remarkBadgeClass(item.Type, 'bg-indigo-600 text-white')}`}>
                                              {item.Type || 'Remark'}
                                            </span>
                                            <span className="text-xs font-extrabold text-indigo-950">
                                              Client: {item.Customer_Name || item.Customer_ID || 'General'} {item.Task_ID ? `• #${item.Task_ID}` : ''}
                                            </span>
                                            <span className="text-[11px] font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">
                                              👤 {item.Staff_Name || item.Staff_ID || 'Staff'}
                                            </span>
                                          </div>
                                          <span className="text-[11px] font-semibold text-slate-400">
                                            {formatInteractionTimestamp(item.Timestamp)}
                                          </span>
                                        </div>
                                        <p className="text-xs text-slate-700 leading-relaxed font-medium pl-1 whitespace-pre-wrap">
                                          {item.Remarks}
                                        </p>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      ) : (
                    (() => {
                      const history = customerInteractions.filter(
                        i => (i.Customer_ID === remarkTask.Customer_ID || (remarkTask.Task_ID && i.Task_ID === remarkTask.Task_ID)) &&
                             (!historySearchText.trim() ||
                              (i.Remarks && i.Remarks.toLowerCase().includes(historySearchText.toLowerCase())) ||
                              (i.Type && i.Type.toLowerCase().includes(historySearchText.toLowerCase())) ||
                              (i.Staff_Name && i.Staff_Name.toLowerCase().includes(historySearchText.toLowerCase())) ||
                              (i.Staff_ID && i.Staff_ID.toLowerCase().includes(historySearchText.toLowerCase()))
                             )
                      );
                      if (history.length === 0) {
                        return (
                          <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                            {historySearchText ? `No remarks matching "${historySearchText}" for this client.` : 'No previous remarks found for this task or client yet.'}
                          </div>
                        );
                      }
                      return (
                        <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                          {history.slice().reverse().map((item, idx) => (
                            <div key={item.Interaction_ID || idx} className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 shadow-2xs">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-0.5 rounded font-extrabold text-[10px] ${remarkBadgeClass(item.Type, 'bg-amber-600 text-white')}`}>
                                    {item.Type || 'Remark'}
                                  </span>
                                  <span className="text-xs font-bold text-slate-800">{item.Staff_Name || 'Staff'}</span>
                                </div>
                                <span className="text-[11px] font-semibold text-slate-500">
                                  {formatInteractionTimestamp(item.Timestamp)}
                                </span>
                              </div>
                              <p className="text-xs text-slate-700 leading-relaxed font-medium pl-1 whitespace-pre-wrap">
                                {item.Remarks}
                              </p>
                            </div>
                          ))}
                        </div>
                      );
                    })()
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 360 CLIENT PROFILE & INTERACTION MODAL */}
          {selectedCustomerModal && (
            <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
              <div className="bg-white border border-slate-200 rounded-3xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
                {/* Modal Header */}
                <div className="p-4 sm:p-6 bg-slate-900 text-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0 border-b border-slate-800">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-2.5 py-0.5 rounded-full bg-rose-600 text-white text-xs font-bold">
                        {selectedCustomerModal.Customer_ID}
                      </span>
                      <h3 className="text-lg font-bold">{selectedCustomerModal.Company_Name}</h3>
                    </div>
                    <p className="text-xs text-slate-300">
                      Auth Contact: {selectedCustomerModal.Auth_Person} | Phone: {selectedCustomerModal.Contact} | Email: {selectedCustomerModal.Email}
                    </p>
                  </div>
                  <button
                    onClick={() => setSelectedCustomerModal(null)}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold transition"
                  >
                    Close Profile
                  </button>
                </div>

                {/* Modal Content - Scrollable */}
                <div className="p-4 sm:p-6 overflow-y-auto space-y-4 sm:space-y-6 flex-1">
                  {/* Quick Action & Log New Conversation Note */}
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
                    <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-rose-600" />
                      Record Client Conversation / Call Remarks
                    </h4>
                    <form
                      onSubmit={e => handleLogInteractionSubmit(e, selectedCustomerModal.Customer_ID)}
                      className="space-y-3"
                    >
                      <div className="space-y-4">
                        {/* 1. TAG SELECTION FIELD (DROPDOWN FORMAT) */}
                        <div className="space-y-1.5">
                          <label className="block text-[11px] font-bold text-slate-800">
                            1. Select Tag / Interaction Type *
                          </label>
                          <div className="relative">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setShowInteractionTagList(!showInteractionTagList)}
                                className="flex-1 min-w-0 flex items-center justify-between px-3.5 py-2.5 bg-white border-2 border-slate-300 hover:border-rose-500 rounded-xl text-xs font-bold text-slate-800 shadow-2xs transition cursor-pointer text-left"
                              >
                                <span className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className="px-2.5 py-0.5 rounded-lg bg-rose-600 text-white font-extrabold text-xs shrink-0 shadow-2xs">
                                    {interactionForm.type || 'Select Tag'}
                                  </span>
                                  <span className="text-slate-500 font-normal truncate">
                                    {!showInteractionTagList ? '(Click to change tag or correct mistake)' : '(Choose tag from dropdown below)'}
                                  </span>
                                </span>
                                <ChevronDown className={`w-4 h-4 text-slate-400 shrink-0 transition-transform ${showInteractionTagList ? 'rotate-180 text-rose-600' : ''}`} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => handleAddCustomTag(e, true, true)}
                                className="shrink-0 w-10 h-10 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white flex items-center justify-center shadow-2xs transition"
                                title="Add New Tag"
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            </div>

                            {showInteractionTagList && (
                              <div className="mt-2 bg-white border-2 border-rose-300 rounded-2xl shadow-xl overflow-hidden animate-fadeIn space-y-2 p-2.5 z-30">
                                <div className="flex items-center gap-1.5 pb-1.5 border-b border-rose-100">
                                  <div className="relative flex-1">
                                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                                    <input
                                      type="text"
                                      placeholder="🔍 Search Tag (e.g. Call, FLP)..."
                                      value={tagSearch}
                                      onChange={(e) => setTagSearch(e.target.value)}
                                      className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-xl text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-semibold"
                                      autoFocus
                                    />
                                  </div>
                                </div>
                                <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                                  {remarkTagsList.filter(t => !tagSearch.trim() || t.toLowerCase().includes(tagSearch.toLowerCase())).map(tag => {
                                    const isCustom = customRemarkTags.includes(tag) && !REMARK_TAGS.includes(tag);
                                    return (
                                      <div
                                        key={tag}
                                        onClick={() => {
                                          setInteractionForm({ ...interactionForm, type: tag });
                                          setShowInteractionTagList(false);
                                        }}
                                        className={`flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold cursor-pointer transition group ${
                                          interactionForm.type === tag
                                            ? 'bg-rose-600 text-white font-extrabold shadow-sm'
                                            : 'hover:bg-rose-50 text-slate-700'
                                        }`}
                                      >
                                        <div className="flex items-center gap-1.5 min-w-0 truncate">
                                          <span className="truncate">{tag}</span>
                                          {isCustom && (
                                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-extrabold shrink-0 ${
                                              interactionForm.type === tag ? 'bg-rose-700 text-rose-100' : 'bg-rose-100 text-rose-800'
                                            }`}>
                                              Custom
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                          {interactionForm.type === tag && <span className="text-[11px] bg-rose-700/60 px-1.5 py-0.5 rounded text-white">✓ Selected</span>}
                                          {isCustom && (
                                            <button
                                              type="button"
                                              onClick={(e) => handleDeleteCustomTag(e, tag)}
                                              className={`p-1 rounded-lg transition ${
                                                interactionForm.type === tag
                                                  ? 'hover:bg-rose-700 text-white'
                                                  : 'hover:bg-rose-100 text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100'
                                              }`}
                                              title="Delete custom tag"
                                            >
                                              <X className="w-3.5 h-3.5" />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                  {remarkTagsList.filter(t => !tagSearch.trim() || t.toLowerCase().includes(tagSearch.toLowerCase())).length === 0 && (
                                    <div className="p-4 text-center space-y-2">
                                      <p className="text-xs text-slate-400 font-medium">No matching tag found.</p>
                                      <button
                                        type="button"
                                        onClick={(e) => handleAddCustomTag(e, true)}
                                        className="px-3 py-1.5 bg-rose-100 hover:bg-rose-200 text-rose-900 font-bold text-xs rounded-xl inline-flex items-center gap-1 cursor-pointer transition shadow-2xs"
                                      >
                                        <Plus className="w-3.5 h-3.5 text-rose-700" />
                                        <span>Add "{tagSearch}" as new tag</span>
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* 2. CONVERSATION DETAILS & REMARKS FIELD (Opens once tag is selected) */}
                        {!showInteractionTagList && (
                          <div className="space-y-2.5 animate-fadeIn pt-3 border-t border-slate-200">
                            <div className="flex items-center justify-between flex-wrap gap-1">
                              <label className="block text-[11px] font-bold text-slate-800">
                                2. Conversation Details & Client Remarks * <span className="text-rose-800 font-normal">({interactionForm.type})</span>
                              </label>
                              <span className="text-[10px] text-rose-700 font-bold bg-rose-100/80 px-2 py-0.5 rounded-md">
                                ⚡ Press Ctrl+Enter or click Save below
                              </span>
                            </div>
                            <textarea
                              required
                              rows={5}
                              autoFocus
                              placeholder={`Enter detailed conversation notes and client remarks for [${interactionForm.type}]...\n\nProvide all relevant details clearly.`}
                              value={interactionForm.remarks}
                              onChange={e => setInteractionForm({ ...interactionForm, remarks: e.target.value })}
                              onKeyDown={e => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && interactionForm.remarks.trim()) {
                                  e.preventDefault();
                                  handleLogInteractionSubmit(e, selectedCustomerModal.Customer_ID);
                                }
                              }}
                              className="w-full px-3.5 py-3 bg-white border-2 border-slate-300 rounded-xl text-xs sm:text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 font-medium leading-relaxed resize-y min-h-[130px] shadow-2xs"
                            />
                            <div className="flex justify-end pt-1">
                              <button
                                type="submit"
                                disabled={loggingInteraction}
                                className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
                              >
                                <Send className="w-3.5 h-3.5" />
                                {loggingInteraction ? 'Saving...' : 'Save Log'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </form>
                  </div>

                  {/* Chronological Client CRM Interaction & Call Feed */}
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <History className="w-4 h-4 text-emerald-600" />
                      Chronological Client CRM Conversation & Call Feed
                    </h4>
                    <div className="border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100">
                      {customerInteractions.filter(i => i.Customer_ID === selectedCustomerModal.Customer_ID).length === 0 ? (
                        <div className="p-6 text-center text-xs text-slate-400">
                          No conversation logs or call button presses recorded for this client yet.
                        </div>
                      ) : (
                        customerInteractions
                          .filter(i => i.Customer_ID === selectedCustomerModal.Customer_ID)
                          .slice()
                          .reverse()
                          .map(item => (
                            <div key={item.Interaction_ID} className="p-4 bg-white hover:bg-slate-50/70 transition flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold text-[11px]">
                                    {item.Type}
                                  </span>
                                  <span className="text-xs font-semibold text-slate-900">
                                    Staff: {item.Staff_Name}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-700 leading-relaxed font-medium">
                                  {item.Remarks}
                                </p>
                              </div>
                              <span className="text-[11px] text-slate-500 shrink-0 font-medium">
                                {formatInteractionTimestamp(item.Timestamp)}
                              </span>
                            </div>
                          ))
                      )}
                    </div>
                  </div>

                  {/* Staff Work Order & Site Visit Activity History */}
                  <div className="space-y-3">
                    <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <UserCheck className="w-4 h-4 text-indigo-600" />
                      Staff Work Order & Site Visit Activity History
                    </h4>
                    <div className="border border-slate-200 rounded-2xl overflow-x-auto">
                      <table className="w-full text-left text-xs min-w-[700px]">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 font-semibold">
                            <th className="py-2.5 px-3">Task ID</th>
                            <th className="py-2.5 px-3">Work Order Description</th>
                            <th className="py-2.5 px-3">Assigned Staff</th>
                            <th className="py-2.5 px-3">Scheduled Date</th>
                            <th className="py-2.5 px-3">Workflow Stage</th>
                            <th className="py-2.5 px-3">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {tasks.filter(t => t.Customer_ID === selectedCustomerModal.Customer_ID).length === 0 ? (
                            <tr>
                              <td colSpan="6" className="py-4 text-center text-slate-400">
                                No work orders assigned to this customer.
                              </td>
                            </tr>
                          ) : (
                            tasks
                              .filter(t => t.Customer_ID === selectedCustomerModal.Customer_ID)
                              .map(tsk => {
                                const stInfo = staffList.find(s => s.Staff_ID === tsk.Assigned_Staff);
                                return (
                                  <tr key={tsk.Task_ID} className="hover:bg-slate-50/80 transition">
                                    <td className="py-3 px-3 font-bold text-rose-600">{tsk.Task_ID}</td>
                                    <td className="py-3 px-3 font-semibold text-slate-900">{tsk.Description}</td>
                                    <td className="py-3 px-3 text-slate-700 font-medium">
                                      {tsk.Assigned_Staff} ({stInfo?.Name || 'Staff Member'})
                                    </td>
                                    <td className="py-3 px-3 text-slate-600 font-medium">{formatDateDDMMYYYY(tsk.Scheduled_Date)}</td>
                                    <td className="py-3 px-3">
                                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold text-[11px]">
                                        {tsk.Stage}
                                      </span>
                                    </td>
                                    <td className="py-3 px-3">
                                      <span className={`px-2 py-0.5 rounded-full font-bold text-[11px] border ${
                                        tsk.Status === 'Completed'
                                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                          : 'bg-amber-50 text-amber-700 border-amber-200'
                                      }`}>
                                        {tsk.Status}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

      {/* EDIT CUSTOMER MODAL */}
      {showEditCustomerModal && editingCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-5 my-4">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Edit3 className="w-4 h-4 text-indigo-600" />
                  Edit Customer Details
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{editingCustomer.Customer_ID} — changes sync to Google Sheet</p>
              </div>
              <button onClick={() => { setShowEditCustomerModal(false); setEditingCustomer(null); }} className="text-slate-400 hover:text-slate-700 font-bold text-sm p-1">✕</button>
            </div>

            <form onSubmit={handleEditCustomerSubmit} className="space-y-4 text-xs">
              {/* Company Name */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Company / Business Name *</label>
                <input
                  type="text" required
                  value={editCustomerForm.companyName}
                  onChange={e => setEditCustomerForm({ ...editCustomerForm, companyName: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Apex Pharmaceuticals Ltd."
                />
              </div>

              {/* Auth Person & Contact */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Auth Person / Contact Name</label>
                  <input
                    type="text"
                    value={editCustomerForm.authPerson}
                    onChange={e => setEditCustomerForm({ ...editCustomerForm, authPerson: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="e.g. Suresh Patil"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Mobile Number</label>
                  <input
                    type="text" maxLength={10}
                    value={editCustomerForm.contact}
                    onChange={e => setEditCustomerForm({ ...editCustomerForm, contact: e.target.value.replace(/\D/g, '') })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="10-digit mobile"
                  />
                </div>
              </div>

              {/* Email */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Email Address</label>
                <input
                  type="email"
                  value={editCustomerForm.email}
                  onChange={e => setEditCustomerForm({ ...editCustomerForm, email: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. info@company.com"
                />
              </div>

              {/* Address */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Full Address</label>
                <textarea
                  rows={2}
                  value={editCustomerForm.address}
                  onChange={e => setEditCustomerForm({ ...editCustomerForm, address: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                  placeholder="Plot 42, MIDC Industrial Area, Andheri East, Mumbai"
                />
              </div>

              {/* Location Link — GPS Map */}
              <div className="p-3.5 rounded-2xl bg-indigo-50 border border-indigo-200 space-y-2">
                <label className="block font-bold text-indigo-900">📍 GPS Map Location Link</label>
                <p className="text-[11px] text-indigo-700">Paste the Google Maps URL for this business location. Staff will use this to navigate directly.</p>
                <div className="flex items-center gap-1.5">
                  <input
                    type="url"
                    value={editCustomerForm.locationLink}
                    onChange={e => setEditCustomerForm({ ...editCustomerForm, locationLink: e.target.value })}
                    className="flex-1 px-3 py-2 bg-white border border-indigo-300 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="https://maps.google.com/?q=..."
                  />
                  <button
                    type="button"
                    disabled={fetchingLocationFor === (editingCustomer?.Customer_ID || 'EDIT_MODAL')}
                    onClick={() => handleFetchAndSaveCustomerGps(editingCustomer || { Customer_ID: 'EDIT_MODAL' })}
                    className="px-3 py-2 bg-white hover:bg-indigo-100 text-indigo-700 font-bold text-xs rounded-xl border border-indigo-300 flex items-center gap-1 transition shrink-0 shadow-2xs"
                    title="Fetch GPS directly from current client location"
                  >
                    <Navigation className={`w-3.5 h-3.5 text-indigo-600 ${fetchingLocationFor === (editingCustomer?.Customer_ID || 'EDIT_MODAL') ? 'animate-spin' : ''}`} />
                    <span>{fetchingLocationFor === (editingCustomer?.Customer_ID || 'EDIT_MODAL') ? 'Fetching...' : 'Fetch GPS'}</span>
                  </button>
                </div>
                {editCustomerForm.locationLink && (
                  <a href={editCustomerForm.locationLink} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-700 hover:text-indigo-900 font-semibold text-[11px] underline">
                    <MapPin className="w-3 h-3" /> Test this link →
                  </a>
                )}
              </div>

              {/* Special Notes / Party Related Data */}
              <div className="p-3.5 rounded-2xl bg-amber-50/50 border border-amber-200 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-bold text-amber-900 flex items-center gap-1">
                    <span>🔒 Special Party Notes (Secure)</span>
                  </label>
                  {editCustomerForm.specialNotes?.trim() && !isEditCustomerNotesUnlocked ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Unlock Special Notes field to edit?')) {
                          setIsEditCustomerNotesUnlocked(true);
                        }
                      }}
                      className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white font-extrabold text-[11px] rounded-lg shadow-2xs flex items-center gap-1 transition"
                    >
                      🔓 Unlock Notes
                    </button>
                  ) : (
                    editCustomerForm.specialNotes?.trim() && (
                      <button
                        type="button"
                        onClick={() => setIsEditCustomerNotesUnlocked(false)}
                        className="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-[10px] rounded-md transition"
                      >
                        🔒 Lock Notes
                      </button>
                    )
                  )}
                </div>
                <p className="text-[11px] text-amber-700">
                  {editCustomerForm.specialNotes?.trim() && !isEditCustomerNotesUnlocked
                    ? '🔒 Notes are locked to prevent accidental overwrite. Click "Unlock Notes" above if you need to update.'
                    : 'Add special client-specific instructions or party-related secure details below.'}
                </p>
                <textarea
                  rows={2}
                  readOnly={Boolean(editCustomerForm.specialNotes?.trim() && !isEditCustomerNotesUnlocked)}
                  value={editCustomerForm.specialNotes}
                  onChange={e => setEditCustomerForm({ ...editCustomerForm, specialNotes: e.target.value })}
                  className={`w-full px-3 py-2 border rounded-xl text-slate-900 focus:outline-none focus:ring-2 ${
                    editCustomerForm.specialNotes?.trim() && !isEditCustomerNotesUnlocked
                      ? 'bg-slate-100 border-slate-300 text-slate-600 cursor-not-allowed'
                      : 'bg-white border-amber-300 focus:ring-amber-500 focus:border-transparent'
                  } resize-none`}
                  placeholder="e.g. Requires permission to enter Server Room 2, call Mahesh before dispatch."
                />
              </div>

              {/* Additional Coordinators */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block font-bold text-slate-700">Additional Contact Persons</label>
                  <button
                    type="button"
                    onClick={() => setEditCustomerForm({ ...editCustomerForm, coordinators: [...editCustomerForm.coordinators, { name: '', designation: '', phone: '', email: '' }] })}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 underline"
                  >+ Add Contact</button>
                </div>
                {editCustomerForm.coordinators.map((c, i) => (
                  <div key={i} className="p-2.5 border border-slate-200 rounded-xl space-y-2 bg-slate-50 relative">
                    <button type="button" onClick={() => setEditCustomerForm({ ...editCustomerForm, coordinators: editCustomerForm.coordinators.filter((_, idx) => idx !== i) })} className="absolute top-1.5 right-1.5 text-slate-400 hover:text-rose-600 text-xs font-bold">✕</button>
                    <div className="grid grid-cols-2 gap-2">
                      <input type="text" placeholder="Name" value={c.name || ''} onChange={e => { const nc = [...editCustomerForm.coordinators]; nc[i] = { ...nc[i], name: e.target.value }; setEditCustomerForm({ ...editCustomerForm, coordinators: nc }); }} className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px]" />
                      <input type="text" placeholder="Designation" value={c.designation || ''} onChange={e => { const nc = [...editCustomerForm.coordinators]; nc[i] = { ...nc[i], designation: e.target.value }; setEditCustomerForm({ ...editCustomerForm, coordinators: nc }); }} className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px]" />
                      <input type="text" placeholder="Phone" maxLength={10} value={(c.phone || c.contactNumber || '').replace(/^\+91\s?/, '')} onChange={e => { const nc = [...editCustomerForm.coordinators]; nc[i] = { ...nc[i], phone: e.target.value.replace(/\D/g, ''), contactNumber: e.target.value.replace(/\D/g, '') }; setEditCustomerForm({ ...editCustomerForm, coordinators: nc }); }} className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px]" />
                      <input type="email" placeholder="Email" value={c.email || ''} onChange={e => { const nc = [...editCustomerForm.coordinators]; nc[i] = { ...nc[i], email: e.target.value }; setEditCustomerForm({ ...editCustomerForm, coordinators: nc }); }} className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px]" />
                    </div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button type="button" onClick={() => { setShowEditCustomerModal(false); setEditingCustomer(null); }} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={savingCustomer} className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-sm transition disabled:opacity-60 flex items-center gap-2">
                  {savingCustomer ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB CONTENT 4: ACTIVITY LOGS */}
      {(activeTab === 'LOGS' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'LOGS')) && (
        <div className="space-y-4">
          <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 text-[11px] uppercase font-bold tracking-wider">
                  <th className="py-3.5 px-4">Log ID</th>
                  <th className="py-3.5 px-4">Timestamp</th>
                  <th className="py-3.5 px-4">Staff</th>
                  <th className="py-3.5 px-4">Task ID</th>
                  <th className="py-3.5 px-4">Action Taken</th>
                  <th className="py-3.5 px-4">GPS Coordinate</th>
                  <th className="py-3.5 px-4">Photo Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs text-slate-700">
                {logs.map(log => (
                  <tr key={log.Log_ID} className="hover:bg-slate-50 transition">
                    <td className="py-3.5 px-4 font-bold text-slate-500">{log.Log_ID}</td>
                    <td className="py-3.5 px-4 text-slate-600 font-medium">{formatInteractionTimestamp(log.Timestamp)}</td>
                    <td className="py-3.5 px-4 font-semibold text-rose-600">{log.Staff_ID}</td>
                    <td className="py-3.5 px-4 font-bold text-slate-900">{log.Task_ID}</td>
                    <td className="py-3.5 px-4">
                      <p className="font-medium text-slate-800">{log.Action_Taken}</p>
                      {log.Remarks && <p className="text-slate-500 text-[11px] italic mt-0.5">{log.Remarks}</p>}
                    </td>
                    <td className="py-3.5 px-4">
                      <a
                        href={`https://maps.google.com/?q=${log.Lat_Long_Location}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:underline flex items-center gap-1 font-semibold"
                      >
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        {log.Lat_Long_Location}
                      </a>
                    </td>
                    <td className="py-3.5 px-4">
                      {log.Image_URL ? (
                        <a href={log.Image_URL} target="_blank" rel="noopener noreferrer" className="inline-block">
                          <img
                            src={log.Image_URL}
                            alt="Proof"
                            className="w-10 h-10 rounded-lg object-cover border border-slate-700 hover:scale-150 transition transform"
                          />
                        </a>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(activeTab === 'ATTENDANCE' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'ATTENDANCE')) && (
        <div id="section-leave-queue" className="space-y-6">
          {/* Section 1: Leave Approval Queue */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <CalendarDays className="w-5 h-5 text-rose-600" />
                  Staff Leave Request & Approval Queue
                </h3>
                <span className="text-xs text-slate-500 font-semibold">
                  Admin direct leave assignment instantly syncs to Staff Panel
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAdminLeaveForm(prev => ({
                    ...prev,
                    staffId: staffList[0]?.Staff_ID || ''
                  }));
                  setShowAdminLeaveModal(true);
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition shrink-0"
              >
                <PlusCircle className="w-4 h-4" />
                <span>+ Assign Leave to Staff</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[700px]">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-2.5 px-3">Staff ID & Name</th>
                    <th className="py-2.5 px-3">Leave Date</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Priority / Notice</th>
                    <th className="py-2.5 px-3">Reason</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {leaveRequests.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="py-6 text-center text-slate-400">
                        No leave requests submitted.
                      </td>
                    </tr>
                  ) : (
                    leaveRequests.map(lev => {
                      const staffInfo = staffList.find(st => st.Staff_ID === lev.Staff_ID);
                      const staffName = lev.Staff_Name || staffInfo?.Name || 'Staff Member';
                      return (
                        <tr key={lev.Request_ID} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-3">
                            <div className="font-bold text-slate-900">{lev.Staff_ID}</div>
                            <div className="text-[11px] font-semibold text-slate-600">{staffName}</div>
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-800">{formatDateWithDayName(lev.Leave_Date)}</td>
                          <td className="py-3 px-3 text-slate-700 font-medium">{lev.Leave_Type}</td>
                          <td className="py-3 px-3">
                            {lev.Is_Urgent ? (
                              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-bold text-[11px] inline-flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3 text-amber-600" />
                                Urgent Emergency
                              </span>
                            ) : (
                              <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium text-[11px]">
                                Standard Advance
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-slate-600 max-w-xs truncate">{lev.Reason}</td>
                          <td className="py-3 px-3">
                            <span className={`px-2.5 py-1 rounded-full font-bold text-[11px] border ${
                              lev.Status === 'Approved'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : lev.Status === 'Rejected'
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                              {lev.Status}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right space-x-1.5">
                            {lev.Status !== 'Approved' && (
                              <button
                                onClick={() => handleLeaveStatusUpdate(lev.Request_ID, 'Approved')}
                                className="px-3 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs inline-flex items-center gap-1 shadow-sm transition"
                              >
                                <Check className="w-3 h-3" />
                                Approve
                              </button>
                            )}
                            {lev.Status !== 'Rejected' && (
                              <button
                                onClick={() => handleLeaveStatusUpdate(lev.Request_ID, 'Rejected')}
                                className="px-3 py-1 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs inline-flex items-center gap-1 shadow-sm transition"
                              >
                                <X className="w-3 h-3" />
                                Reject
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 2: Staff Daily Salary Rate Settings */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <h3 className="text-base font-bold text-slate-900 mb-3 flex items-center gap-2">
              <IndianRupee className="w-5 h-5 text-emerald-600" />
              Staff Master — Standard Daily Salary Rates
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[700px]">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-2.5 px-3">Staff ID</th>
                    <th className="py-2.5 px-3">Photo</th>
                    <th className="py-2.5 px-3">Name</th>
                    <th className="py-2.5 px-3">Standard Rate</th>
                    <th className="py-2.5 px-3">Earned This Month</th>
                    <th className="py-2.5 px-3">Advance Paid</th>
                    <th className="py-2.5 px-3">Net Balance Payable</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staffList.map(st => {
                    const currentMonthStr = getLocalDateStr().slice(0, 7);
                    const monthLogs = attendanceLogs.filter(
                      a => a.Staff_ID === st.Staff_ID && a.Date && a.Date.startsWith(currentMonthStr)
                    );
                    const totalDaysWorked = monthLogs.reduce((sum, log) => sum + Number(log.Worked_Days || 0), 0);
                    const monthlyEarned = Math.round(totalDaysWorked * Number(st.Daily_Salary_Rate || 1000));
                    const monthAdvances = salaryAdvances.filter(
                      adv =>
                        adv.Staff_ID === st.Staff_ID &&
                        (adv.Date_Timestamp || adv.Timestamp || '').startsWith(currentMonthStr)
                    );
                    const totalAdvance = monthAdvances.reduce((sum, adv) => sum + Number(adv.Amount || 0), 0);
                    const netBalance = monthlyEarned - totalAdvance;

                    return (
                      <tr key={st.Staff_ID} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-3 font-bold text-slate-900">{st.Staff_ID}</td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <label title="Click to upload/change photo directly for this staff" className="relative group w-9 h-9 rounded-full bg-slate-200 overflow-hidden flex items-center justify-center font-bold text-slate-700 shrink-0 border border-slate-300 cursor-pointer">
                              {st.Profile_Photo ? (
                                <img src={st.Profile_Photo} alt={st.Name} className="w-full h-full object-cover" />
                              ) : (
                                st.Name?.charAt(0).toUpperCase()
                              )}
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-[10px] text-white font-bold transition">
                                📷
                              </div>
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  const reader = new FileReader();
                                  reader.onload = async (ev) => {
                                    const img = new Image();
                                    img.onload = async () => {
                                      const canvas = document.createElement('canvas');
                                      const maxW = 300, maxH = 300;
                                      let w = img.width, h = img.height;
                                      if (w > maxW) { h = (maxW / w) * h; w = maxW; }
                                      if (h > maxH) { w = (maxH / h) * w; h = maxH; }
                                      canvas.width = w; canvas.height = h;
                                      const ctx = canvas.getContext('2d');
                                      ctx.drawImage(img, 0, 0, w, h);
                                      const photoDataUrl = canvas.toDataURL('image/jpeg', 0.8);
                                      try {
                                        const res = await fetch(`/api/staff/${st.Staff_ID}/photo-direct`, {
                                          method: 'PUT',
                                          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                          body: JSON.stringify({ photoDataUrl })
                                        });
                                        if (res.ok) {
                                          fetchStaffList();
                                          alert(`✅ Profile photo updated directly for ${st.Name}!`);
                                        }
                                      } catch (err) {
                                        alert('Error updating photo: ' + err.message);
                                      }
                                    };
                                    img.src = ev.target.result;
                                  };
                                  reader.readAsDataURL(file);
                                }}
                              />
                            </label>
                            {st.Pending_Photo_Request && (
                              <div className="flex flex-col gap-1">
                                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
                                  Pending New Photo
                                </span>
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={async () => {
                                      const res = await fetch(`/api/staff/${st.Staff_ID}/photo-approve`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                        body: JSON.stringify({ action: 'APPROVE', directPhotoUrl: st.Pending_Photo_Request || st.Profile_Photo })
                                      });
                                      if (res.ok) {
                                        fetchStaffList();
                                        alert('✅ Staff photo approved & updated!');
                                      } else {
                                        let err = {};
                                        try { err = await res.json(); } catch (e) {}
                                        alert('❌ Approval failed: ' + (err.error || 'Unknown error'));
                                      }
                                    }}
                                    className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    onClick={async () => {
                                      const res = await fetch(`/api/staff/${st.Staff_ID}/photo-approve`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                        body: JSON.stringify({ action: 'REJECT' })
                                      });
                                      if (res.ok) {
                                        fetchStaffList();
                                      }
                                    }}
                                    className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-semibold text-slate-800">{st.Name}</td>
                        <td className="py-3 px-3 font-bold text-emerald-600">
                          ₹{(st.Daily_Salary_Rate || 1000).toLocaleString()} / 10h
                        </td>
                        <td className="py-3 px-3 font-bold text-slate-800">
                          ₹{monthlyEarned.toLocaleString()}
                        </td>
                        <td className="py-3 px-3 font-bold text-rose-600">
                          ₹{totalAdvance.toLocaleString()}
                        </td>
                        <td className="py-3 px-3 font-bold text-indigo-700">
                          ₹{netBalance.toLocaleString()}
                        </td>
                        <td className="py-3 px-3 text-right space-x-1.5">
                          <button
                            onClick={() => {
                              const rate = prompt(`Enter new daily salary rate (in ₹) for ${st.Name}:`, st.Daily_Salary_Rate || 1000);
                              if (rate && !isNaN(rate)) {
                                handleUpdateStaffDailyRate(st.Staff_ID, rate);
                              }
                            }}
                            className="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs border border-slate-200 transition"
                          >
                            Set Rate
                          </button>
                          <button
                            onClick={() => {
                              setAdvanceForm({
                                staffId: st.Staff_ID,
                                amount: '',
                                paymentMode: 'Cash / Bank Transfer',
                                remarks: ''
                              });
                              setShowAdvanceModal(true);
                            }}
                            className="px-3 py-1 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm transition inline-flex items-center gap-1"
                          >
                            <Banknote className="w-3.5 h-3.5" />
                            + Pay Advance
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 3: Staff Salary Advance Payments History Log */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Banknote className="w-5 h-5 text-rose-600" />
                Staff Salary Advance Payments Log (Date/Time Timestamped)
              </h3>
              <button
                onClick={() => {
                  setAdvanceForm({
                    staffId: staffList[0]?.Staff_ID || '',
                    amount: '',
                    paymentMode: 'Cash',
                    remarks: ''
                  });
                  setShowAdvanceModal(true);
                }}
                className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm"
              >
                + Record New Advance
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[700px]">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-semibold">
                    <th className="py-2.5 px-3">Advance ID</th>
                    <th className="py-2.5 px-3">Date & Time Stamp</th>
                    <th className="py-2.5 px-3">Staff ID & Name</th>
                    <th className="py-2.5 px-3">Amount</th>
                    <th className="py-2.5 px-3">Payment Mode</th>
                    <th className="py-2.5 px-3">Remarks</th>
                    <th className="py-2.5 px-3 text-right">Delete</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {salaryAdvances.length === 0 ? (
                    <tr>
                      <td colSpan="7" className="py-6 text-center text-slate-400">
                        No advance payments recorded yet.
                      </td>
                    </tr>
                  ) : (
                    salaryAdvances.map(adv => (
                      <tr key={adv.Advance_ID} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-3 font-bold text-rose-600">{adv.Advance_ID}</td>
                        <td className="py-3 px-3 text-slate-600 font-medium">{formatInteractionTimestamp(adv.Date_Timestamp || adv.Timestamp)}</td>
                        <td className="py-3 px-3 font-bold text-slate-900">{adv.Staff_ID} ({adv.Staff_Name})</td>
                        <td className="py-3 px-3 font-bold text-rose-600">₹{Number(adv.Amount || 0).toLocaleString()}</td>
                        <td className="py-3 px-3 font-semibold text-slate-700">{adv.Payment_Mode}</td>
                        <td className="py-3 px-3 text-slate-600 italic">{adv.Remarks || '—'}</td>
                        <td className="py-3 px-3 text-right">
                          <button
                            onClick={() => handleDeleteAdvance(adv.Advance_ID)}
                            className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 transition"
                            title="Delete record"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section 4: Geotagged Attendance & Payroll Overview */}
          <div id="section-attendance-logs" className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Clock className="w-5 h-5 text-rose-600" />
                Geotagged Shift Attendance & Pro-Rata Payroll Log
              </h3>
              <span className="text-xs font-semibold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                Showing {filteredAttendanceLogs.length} of {attendanceLogs.length} records
              </span>
            </div>

            {/* Attendance Filter Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5 bg-slate-50 p-3.5 rounded-xl border border-slate-200/80">
              {/* Staff Filter */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Staff Member</label>
                <select
                  value={attStaffFilter}
                  onChange={(e) => setAttStaffFilter(e.target.value)}
                  className="w-full text-xs font-semibold bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="ALL">All Staff Members</option>
                  {staffList.map(st => (
                    <option key={st.Staff_ID} value={st.Staff_ID}>{st.Name} ({st.Staff_ID})</option>
                  ))}
                </select>
              </div>

              {/* Sort Asc/Desc Mode */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Date Order</label>
                <select
                  value={attSortOrder}
                  onChange={(e) => setAttSortOrder(e.target.value)}
                  className="w-full text-xs font-semibold bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="DESC">Newest First (Descending)</option>
                  <option value="ASC">Oldest First (Ascending)</option>
                </select>
              </div>

              {/* Month Selection */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Month Filter</label>
                <select
                  value={attMonthFilter}
                  onChange={(e) => setAttMonthFilter(e.target.value)}
                  className="w-full text-xs font-semibold bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="ALL">All Months</option>
                  {attAvailableMonths.map(ym => (
                    <option key={ym} value={ym}>{formatMonthLabel(ym)}</option>
                  ))}
                </select>
              </div>

              {/* Status Filter */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Punctuality</label>
                <select
                  value={attStatusFilter}
                  onChange={(e) => setAttStatusFilter(e.target.value)}
                  className="w-full text-xs font-semibold bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="ALL">All Status</option>
                  <option value="ON_TIME">On Time Only</option>
                  <option value="LATE">Late Only</option>
                </select>
              </div>

              {/* Search Box */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Search</label>
                <input
                  type="text"
                  placeholder="ID, Name, or IP..."
                  value={attSearchQuery}
                  onChange={(e) => setAttSearchQuery(e.target.value)}
                  className="w-full text-xs font-medium bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>

              {/* Reset Button */}
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => {
                    setAttStaffFilter('ALL');
                    setAttSortOrder('DESC');
                    setAttMonthFilter('ALL');
                    setAttStatusFilter('ALL');
                    setAttSearchQuery('');
                  }}
                  className="w-full py-1.5 px-3 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs transition flex items-center justify-center gap-1 shadow-2xs"
                >
                  Reset Filters
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[750px]">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-semibold bg-slate-50/50">
                    <th className="py-2.5 px-3">Staff ID & Name</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Punch In / Out</th>
                    <th className="py-2.5 px-3">Geotag Coordinates & Mobile IP</th>
                    <th className="py-2.5 px-3">Punctuality Status</th>
                    <th className="py-2.5 px-3">Worked Hours</th>
                    <th className="py-2.5 px-3">Daily Salary</th>
                    <th className="py-2.5 px-3 text-right">Override</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAttendanceLogs.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="py-8 text-center text-slate-400 font-medium">
                        No attendance records matching the selected filters.
                      </td>
                    </tr>
                  ) : (
                    filteredAttendanceLogs.map(log => {
                      const isLate = Number(log.Late_By_Minutes) > 0;
                      const staffInfo = staffList.find(st => st.Staff_ID === log.Staff_ID);
                      return (
                        <tr key={log.Record_ID} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-3">
                            <div className="font-bold text-slate-900">{log.Staff_ID}</div>
                            <div className="text-[11px] font-semibold text-slate-600">{staffInfo?.Name || 'Staff Member'}</div>
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-800">{formatDateWithDayName(log.Date)}</td>
                          <td className="py-3 px-3 text-slate-600">
                            <span className="font-medium">
                              {formatTime24H(log.Punch_In_Time)} → {log.Punch_Out_Time ? formatTime24H(log.Punch_Out_Time) : 'In Shift'}
                            </span>
                          </td>
                          <td className="py-3 px-3">
                            <div className="space-y-1">
                              {log.In_Location_LatLong ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] font-bold text-slate-500 w-6">IN:</span>
                                  <a
                                    href={`https://maps.google.com/?q=${log.In_Location_LatLong}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-indigo-600 hover:underline inline-flex items-center gap-1 font-semibold"
                                  >
                                    <MapPin className="w-3.5 h-3.5 shrink-0" />
                                    {log.In_Location_LatLong}
                                  </a>
                                </div>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}

                              {log.Out_Location_LatLong && log.Out_Location_LatLong !== '' && (
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] font-bold text-slate-500 w-6">OUT:</span>
                                  <a
                                    href={`https://maps.google.com/?q=${log.Out_Location_LatLong}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-indigo-600 hover:underline inline-flex items-center gap-1 font-semibold"
                                  >
                                    <MapPin className="w-3.5 h-3.5 shrink-0" />
                                    {log.Out_Location_LatLong}
                                  </a>
                                </div>
                              )}

                              <div className="pt-0.5">
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-bold text-[10px] border border-slate-200 shadow-2xs">
                                  <Smartphone className="w-3 h-3 text-indigo-600 shrink-0" />
                                  IP: {log.IP_Address || 'Detected via Server'}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            {isLate ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-bold text-[11px]">
                                <AlertTriangle className="w-3 h-3 text-rose-600" />
                                Late ({log.Late_By_Minutes}m)
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold text-[11px]">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                On Time
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-semibold text-slate-800">
                            {log.Total_Worked_Hours || 0} hrs
                          </td>
                          <td className="py-3 px-3 font-bold text-emerald-600">
                            ₹{Number(log.Calculated_Daily_Salary || 0).toLocaleString()}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <button
                              onClick={() => {
                                setSalaryModalRecord(log);
                                setSalaryOverrideAmount(String(log.Calculated_Daily_Salary || 0));
                              }}
                              className="px-2.5 py-1 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold inline-flex items-center gap-1 border border-slate-200 transition"
                            >
                              <Edit3 className="w-3 h-3" />
                              Override
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT 6: CERTIFICATE MODULE - FIRE SAFETY & IS:2190 COMPLIANCE CERTIFICATES */}
      {(activeTab === 'CERTIFICATES' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'CERTIFICATES')) && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-y border-slate-200 text-slate-600 font-bold">
                    <th className="p-3">Order # / Stage</th>
                    <th className="p-3">Client / Company Name</th>
                    <th className="p-3">Scope of Work & Equipment</th>
                    <th className="p-3">Service Date</th>
                    <th className="p-3">Assigned Staff</th>
                    <th className="p-3 text-right">Certificate Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tasks
                    .filter(t => t.Department === 'Certification' || t.Stage === 'Certificate' || t.Stage === 'Certification' || t.Status === 'Completed')
                    .map(task => (
                      <tr key={task.Task_ID} className="hover:bg-amber-50/40 transition">
                        <td className="p-3 font-bold text-slate-900">
                          <div>#{task.Task_ID}</div>
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300 mt-1">
                            {task.Stage || task.Department}
                          </span>
                        </td>
                        <td className="p-3 font-semibold text-slate-800">
                          <div className="font-bold text-slate-900">{task.Customer_Name}</div>
                          <div className="text-[11px] text-slate-500">{task.Customer_Contact || task.Customer_Address || 'Corporate Client'}</div>
                        </td>
                        <td className="p-3 text-slate-600 max-w-xs truncate">{task.Description}</td>
                        <td className="p-3 text-slate-700 font-medium">{task.Scheduled_Date}</td>
                        <td className="p-3 text-slate-700 font-semibold">{task.Assigned_Staff_Name || task.Assigned_Staff || 'Unassigned'}</td>
                        <td className="p-3 text-right">
                          <button
                            type="button"
                            onClick={() => navigate(`/certificate-compliance/task/${task.Task_ID}`)}
                            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-bold text-xs inline-flex items-center gap-1.5 shadow-sm transition hover:scale-105 active:scale-95"
                          >
                            <Award className="w-3.5 h-3.5" />
                            <span>🏆 Generate & Print</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  {tasks.filter(t => t.Department === 'Certification' || t.Stage === 'Certificate' || t.Stage === 'Certification' || t.Status === 'Completed').length === 0 && (
                    <tr>
                      <td colSpan="6" className="p-8 text-center text-slate-400 font-medium">
                        No work orders currently in Certification stage.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT 7: SERVICE REPORTS MODULE (PENDING APPROVALS QUEUE & MAKER-CHECKER) */}
      {(activeTab === 'SERVICE_REPORTS' || (activeTab === 'OVERVIEW' && expandedOverviewModule === 'SERVICE_REPORTS')) && (
        <div className="space-y-6">
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-6 shadow-xl relative overflow-hidden">
            <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-white/5 transform skew-x-12 pointer-events-none"></div>
            <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/30 border border-indigo-300/40 text-indigo-200 text-xs font-bold mb-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-indigo-300" />
                  <span>Maker-Checker Approval Workflow & A4 Landscape PDF Engine</span>
                </div>
                <h2 className="text-xl sm:text-2xl font-black text-white">🛠️ Field Service Reports & Pending Approvals Queue</h2>
                <p className="text-indigo-200 text-xs sm:text-sm mt-1 max-w-2xl">
                  Review, edit/overwrite technician field observations, approve service reports, and export multi-page A4 Landscape PDF documents with repeating company seals &amp; signatures.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => navigate('/field-visit/new')}
                  className="px-5 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-extrabold text-xs flex items-center gap-2 shadow-lg transition hover:scale-105 active:scale-95"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>+ Start Field Visit</span>
                </button>
                <button
                  onClick={() => navigate('/certificate/new')}
                  className="px-3 py-3 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-indigo-100 font-bold text-xs transition"
                  title="Single-type report (skip the guided field visit)"
                >
                  Single-Type Report
                </button>
              </div>
            </div>
          </div>

          <ServiceReportStatsPanel token={token} />

          {/* Pending Queue & All Reports Table */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-indigo-600" />
                <h3 className="font-extrabold text-slate-900 text-sm">Service Reports Directory & Queue</h3>
                <span className="bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded-full text-xs font-bold">
                  {serviceReportsList.length} total
                </span>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl">
                {['ALL', 'PENDING', 'APPROVED'].map(f => (
                  <button
                    key={f}
                    onClick={() => setServiceReportFilter(f)}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition ${
                      serviceReportFilter === f ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f === 'PENDING' ? '⏳ Pending Approval' : f === 'APPROVED' ? '✅ Approved' : 'All Reports'}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-700 border-b border-slate-200 font-extrabold">
                    <th className="p-3">Report Ref ID</th>
                    <th className="p-3">Customer / Client Name</th>
                    <th className="p-3">Service Date</th>
                    <th className="p-3">Technicians</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {serviceReportsList
                    .filter(r => {
                      if (serviceReportFilter === 'PENDING') return r.Status === 'Pending Approval' || r.Status === 'Revision Requested';
                      if (serviceReportFilter === 'APPROVED') return r.Status === 'Approved';
                      return true;
                    })
                    // Group sibling reports from the same field visit next to each other (stable
                    // sort keeps everything else in its original order).
                    .slice()
                    .sort((a, b) => String(a.Visit_ID || '').localeCompare(String(b.Visit_ID || '')))
                    .map(r => (
                      <tr key={r.Report_ID} className="hover:bg-slate-50/80 font-medium">
                        <td className="p-3 font-bold text-indigo-900">
                          {r.Report_ID}
                          {r.Visit_ID && (
                            <div className="text-[9px] font-bold text-indigo-400 mt-0.5" title="Reports created from the same field visit share this tag">
                              Visit #{String(r.Visit_ID).slice(-6)}
                            </div>
                          )}
                        </td>
                        <td className="p-3 font-bold text-slate-900">
                          {r.customerName}
                          <div className="text-[10px] text-slate-400 font-normal truncate max-w-xs">{r.address}</div>
                        </td>
                        <td className="p-3 text-slate-700">{r.serviceDate}</td>
                        <td className="p-3 text-slate-800 font-bold">{r.technicians}</td>
                        <td className="p-3">
                          <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
                            r.Status === 'Approved'
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                              : r.Status === 'Pending Approval'
                              ? 'bg-amber-100 text-amber-900 border border-amber-300 animate-pulse'
                              : r.Status === 'Revision Requested'
                              ? 'bg-rose-100 text-rose-800 border border-rose-300'
                              : 'bg-slate-100 text-slate-700 border border-slate-300'
                          }`}>
                            {r.Status === 'Pending Approval' ? '⏳ Pending Approval' : r.Status}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <button
                            type="button"
                            onClick={() => navigate(`/certificate/${r.Report_ID}`)}
                            className={`px-3 py-1.5 rounded-xl font-bold text-xs inline-flex items-center gap-1.5 transition ${
                              r.Status === 'Pending Approval'
                                ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm'
                                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm'
                            }`}
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>{r.Status === 'Pending Approval' ? '🔍 Review & Overwrite' : 'View Report'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  {serviceReportsList.length === 0 && (
                    <tr>
                      <td colSpan="6" className="p-8 text-center text-slate-400 font-medium">
                        No service reports found. Click "+ Create New Service Report" above to generate a report.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SALARY OVERRIDE MODAL */}
      {salaryModalRecord && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <IndianRupee className="w-5 h-5 text-emerald-600" />
                Override Daily Calculated Salary
              </h3>
              <button
                onClick={() => setSalaryModalRecord(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div className="text-xs bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-1 text-slate-700">
              <p><span className="font-semibold text-slate-500">Staff ID:</span> <span className="font-bold text-slate-900">{salaryModalRecord.Staff_ID}</span></p>
              <p><span className="font-semibold text-slate-500">Date:</span> {salaryModalRecord.Date}</p>
              <p><span className="font-semibold text-slate-500">Worked Hours:</span> {salaryModalRecord.Total_Worked_Hours || 0} hrs</p>
              <p><span className="font-semibold text-slate-500">Auto Pro-Rata Salary:</span> ₹{salaryModalRecord.Calculated_Daily_Salary}</p>
            </div>

            <form onSubmit={handleSalaryOverrideSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">New Approved Daily Salary (₹) *</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={salaryOverrideAmount}
                  onChange={(e) => setSalaryOverrideAmount(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-bold focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setSalaryModalRecord(null)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSalary}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold shadow-sm"
                >
                  {savingSalary ? 'Saving...' : 'Save Override'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CORPORATE STAFF I-CARD MODAL */}
      {showICardModal && icardTargetUser && (() => {
        const isAdmin = user?.Role === 'Admin' || user?.role === 'Admin';
        // Read from server fields (DOB, Blood_Group, Emergency_Contact) or fall back to icardData
        const liveStaff = staffList.find(s => s.Staff_ID === (icardTargetUser.Staff_ID || icardTargetUser.staffId)) || icardTargetUser;
        const dob = liveStaff.DOB || icardData.dob || '';
        const bloodGroup = liveStaff.Blood_Group || icardData.bloodGroup || 'O+';
        const emergencyContact = liveStaff.Emergency_Contact || icardData.emergencyContact || '8460699569';
        const aadharNo = liveStaff.Aadhar_No || icardData.aadharNo || '';
        const hasPending = liveStaff.ICard_Status === 'Pending Approval';

        const formatAadhar = (val) => {
          if (!val) return '–';
          const clean = val.replace(/\s+/g, '');
          if (clean.length < 6) return clean;
          const maskedLength = clean.length - 6;
          const masked = 'X'.repeat(maskedLength);
          const visible = clean.substring(maskedLength);
          return `${masked} ${visible}`;
        };

        // Age calculator
        const calcAge = (dobStr) => {
          if (!dobStr) return '';
          const b = new Date(dobStr);
          if (isNaN(b.getTime())) return '';
          const t = new Date();
          let a = t.getFullYear() - b.getFullYear();
          const m = t.getMonth() - b.getMonth();
          if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
          return a;
        };
        const fmtDob = (d) => {
          if (!d) return '';
          const p = d.split('-');
          return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d;
        };

        return (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
            <div className="bg-white border border-slate-200 rounded-3xl max-w-sm w-full p-4 shadow-2xl flex flex-col items-center space-y-4 max-h-[95vh] overflow-y-auto">

              {/* Modal Title Bar */}
              <div className="flex items-center justify-between w-full border-b border-slate-100 pb-2.5">
                <span className="text-xs font-black text-slate-800 flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-rose-600" />
                  Staff Identity Card
                  {isAdmin && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-md bg-rose-100 text-rose-700 text-[9px] font-extrabold tracking-wide">ADMIN</span>
                  )}
                </span>
                <button onClick={() => { setShowICardModal(false); setIsEditingICard(false); }} className="text-slate-400 hover:text-slate-600 font-bold text-sm">✕</button>
              </div>

              {/* Pending approval badge for admin */}
              {isAdmin && hasPending && (
                <div className="w-full bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[11px] space-y-2">
                  <p className="font-black text-amber-800 flex items-center gap-1.5">⚠️ Pending Staff I-Card Update Request</p>
                  <div className="text-amber-700 space-y-0.5 font-medium">
                    {liveStaff.Pending_ICard_DOB && <p>DOB: {fmtDob(liveStaff.Pending_ICard_DOB)}</p>}
                    {liveStaff.Pending_ICard_Blood_Group && <p>Blood Group: {liveStaff.Pending_ICard_Blood_Group}</p>}
                    {liveStaff.Pending_ICard_Emergency_Contact && <p>Emergency: {liveStaff.Pending_ICard_Emergency_Contact}</p>}
                    {liveStaff.Pending_ICard_Aadhar_No && <p>Aadhar: {formatAadhar(liveStaff.Pending_ICard_Aadhar_No)}</p>}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/staff/${liveStaff.Staff_ID}/icard-approve`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ action: 'APPROVE' })
                          });
                          if (res.ok) { await refreshData(); alert('✅ I-Card request approved!'); }
                        } catch (e) { alert('Error: ' + e.message); }
                      }}
                      className="flex-1 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] transition"
                    >✓ Approve</button>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/staff/${liveStaff.Staff_ID}/icard-approve`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ action: 'REJECT' })
                          });
                          if (res.ok) { await refreshData(); alert('❌ I-Card request rejected.'); }
                        } catch (e) { alert('Error: ' + e.message); }
                      }}
                      className="flex-1 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px] transition"
                    >✕ Reject</button>
                  </div>
                </div>
              )}

              <div className="w-[272px] rounded-2xl overflow-hidden shadow-xl border border-slate-200 flex flex-col font-sans bg-white">

                {/* ── CARD HEADER: White patch with logo maximized and bold red bottom border ── */}
                <div className="flex items-center justify-center pt-2.5 pb-1 bg-white border-b-[4px] border-rose-600 w-full shrink-0">
                  <img src="/expert_logo.jpg?v=4" alt="Expert Safety Logo" className="w-[190px] h-auto object-contain p-0.5" onError={e => { e.target.style.display='none'; }} />
                </div>

                {/* ── PHOTO SECTION ── */}
                <div className="flex flex-col items-center pt-3 pb-1 px-3 bg-white">
                  <div className="w-[140px] h-[140px] rounded-xl border-2 border-rose-600 shadow-md bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                    {(liveStaff.Profile_Photo || liveStaff.Pending_Photo_Request || liveStaff.profilePhoto || liveStaff.ProfilePhoto) ? (
                      <img src={liveStaff.Profile_Photo || liveStaff.Pending_Photo_Request || liveStaff.profilePhoto || liveStaff.ProfilePhoto} alt={liveStaff.Name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-slate-500 text-2xl font-black">{String(liveStaff.Name || 'S').charAt(0).toUpperCase()}</span>
                    )}
                  </div>

                  <h4 className="text-slate-900 font-black text-[13px] uppercase tracking-wide mt-2 text-center leading-tight">{liveStaff.Name}</h4>
                  <span className="text-rose-700 font-extrabold text-[9.5px] tracking-wider mt-0.5 text-center">
                    ({liveStaff.Role || liveStaff.Department || 'Staff'})
                  </span>
                </div>

                {/* ── DETAILS GRID ── */}
                <div className="px-4 pb-2.5 pt-1.5 space-y-2 bg-white text-xs border-t border-slate-100">
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Employee ID</span>
                      <span className="text-slate-950 font-black text-[10.5px]">{liveStaff.Staff_ID || liveStaff.staffId}</span>
                    </div>
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Blood Group</span>
                      <span className="text-slate-950 font-black text-[10.5px]">{bloodGroup}</span>
                    </div>
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Date of Birth</span>
                      <span className="text-slate-950 font-bold text-[10px]">{fmtDob(dob) || '–'}</span>
                    </div>
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Age</span>
                      <span className="text-slate-950 font-bold text-[10px]">{dob ? `${calcAge(dob)} yrs` : '–'}</span>
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-1.5 space-y-1.5">
                    <div className="grid grid-cols-2 gap-x-2">
                      <div>
                        <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Emergency Contact</span>
                        <span className="text-slate-950 font-black text-[10px] font-mono">{emergencyContact}</span>
                      </div>
                      <div>
                        <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Aadhaar Card No</span>
                        <span className="text-slate-950 font-black text-[10px] font-mono">{formatAadhar(aadharNo)}</span>
                      </div>
                    </div>
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Office Contact</span>
                      <span className="text-slate-950 font-bold text-[10px] font-mono">+91 84606 99569</span>
                    </div>
                  </div>
                </div>

                {/* ── CARD FOOTER: Solid Rose Patch with white text ── */}
                <div className="px-4 py-3 bg-rose-700 flex flex-col justify-center shrink-0 border-t border-rose-800 text-center">
                  <span className="text-white font-black text-[11.5px] uppercase tracking-wider block">Expert Safety Solutions</span>
                  <span className="text-rose-100 text-[9px] font-bold mt-1 block leading-tight">Survey No. 775/2, Dashrath, Vadodara – 391740</span>
                </div>
              </div>
              {/* ─────────────────────────────────────── */}

              {/* ICard_Status badge */}
              {liveStaff.ICard_Status === 'Pending Approval' && !isAdmin && (
                <div className="w-full bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[11px] text-amber-700 font-semibold text-center">
                  ⏳ Your ID card update request is pending Admin approval.
                </div>
              )}

              {/* ── ACTIONS ── */}
              {isEditingICard ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const targetId = liveStaff.Staff_ID || 'default';
                      const res = await fetch(`/api/staff/${targetId}/icard-approve`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ action: 'DIRECT_EDIT', dob: icardData.dob, bloodGroup: icardData.bloodGroup, emergencyContact: icardData.emergencyContact, aadharNo: icardData.aadharNo })
                      });
                      const data = await res.json();
                      if (res.ok) {
                        // Update local staffList
                        setStaffList(prev => prev.map(s => s.Staff_ID === targetId ? { ...s, DOB: icardData.dob, Blood_Group: icardData.bloodGroup, Emergency_Contact: icardData.emergencyContact, Aadhar_No: icardData.aadharNo, ICard_Status: 'Approved' } : s));
                        setIsEditingICard(false);
                        alert('✅ ID Card updated successfully!');
                      } else {
                        alert('❌ Error: ' + (data.error || 'Failed to save'));
                      }
                    } catch (err) {
                      alert('Error: ' + err.message);
                    }
                  }}
                  className="w-full space-y-3 border-t border-slate-100 pt-3"
                >
                  <p className="text-[10px] font-black text-rose-600 uppercase tracking-wider flex items-center gap-1">
                    🛡️ Admin Direct Edit — Changes apply immediately
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Date of Birth:</label>
                      <input type="date" required value={icardData.dob} onChange={e => setIcardData({ ...icardData, dob: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-400" />
                    </div>
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Blood Group:</label>
                      <input type="text" required placeholder="O+ / AB-" value={icardData.bloodGroup} onChange={e => setIcardData({ ...icardData, bloodGroup: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700 font-bold mb-1">Emergency Contact:</label>
                    <input type="text" required placeholder="e.g. 9876543210" value={icardData.emergencyContact} onChange={e => setIcardData({ ...icardData, emergencyContact: e.target.value })}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-400 font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700 font-bold mb-1">Aadhaar Card Number:</label>
                    <input type="text" required placeholder="12 digit Aadhaar No" value={icardData.aadharNo || ''} onChange={e => setIcardData({ ...icardData, aadharNo: e.target.value })}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-400 font-mono" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setIsEditingICard(false)}
                      className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50 transition">Cancel</button>
                    <button type="submit"
                      className="flex-1 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs transition shadow-sm">💾 Save to DB</button>
                  </div>
                </form>
              ) : (
                <div className="w-full flex gap-2 border-t border-slate-100 pt-3">
                  <button type="button" onClick={() => { setIcardData({ dob: liveStaff.DOB || '', bloodGroup: liveStaff.Blood_Group || 'O+', emergencyContact: liveStaff.Emergency_Contact || '', aadharNo: liveStaff.Aadhar_No || '' }); setIsEditingICard(true); }}
                    className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs transition flex items-center justify-center gap-1.5 shadow-sm">
                    ✏️ Edit Details
                  </button>
                  <button type="button" onClick={() => setShowICardModal(false)}
                    className="flex-1 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition">Done</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* COMPANY DETAILS & QR CODES MODAL */}
      {showCompanyDetailsModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-fadeIn">
          <div className="bg-white border border-slate-200 rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[92vh] flex flex-col">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 shrink-0">
              <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                <Building2 className="w-5 h-5 text-rose-600" />
                Company Details & QRs
              </h3>
              <button
                onClick={() => setShowCompanyDetailsModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            {/* Premium Tab Bar */}
            <div className="flex bg-slate-100 p-1 rounded-xl shrink-0">
              {['billing', 'bank', 'qr'].map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setCompanyDetailsTab(tab)}
                  className={`flex-1 py-2 text-center text-xs font-bold rounded-lg transition-all ${
                    companyDetailsTab === tab
                      ? 'bg-white text-rose-600 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab === 'billing' && 'Billing Details'}
                  {tab === 'bank' && 'Bank Details'}
                  {tab === 'qr' && 'Google Review QR'}
                </button>
              ))}
            </div>

            {/* Tab Contents */}
            <div className="flex-1 overflow-y-auto min-h-0 pr-1 py-1 text-xs">
              
              {/* Tab 1: Billing Details */}
              {companyDetailsTab === 'billing' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="p-4 rounded-2xl bg-rose-50/50 border border-rose-100 space-y-3 relative group">
                    <button
                      type="button"
                      onClick={() => {
                        const billingText = `Expert Safety Solutions\n\nAddress:\nSurvey No. 775/2, Sub Plot No. 737/1, NH No. 8, Beside Jeep Compass Showroom, Opp. GSFC Nagar Gate, Dashrath, Vadodara. - 391740 (Gujarat) (India)\n\nMr. Nilesh Padaya\nMo. 8460699569\n\nEmail: expertsafetysolution@gmail.com\nGST No.: 24COMPP8380J1Z9`;
                        navigator.clipboard.writeText(billingText);
                        alert('📋 Billing details copied to clipboard!');
                      }}
                      className="absolute top-3 right-3 px-2.5 py-1 text-[10px] font-bold bg-white text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition shadow-2xs"
                    >
                      Copy Details
                    </button>
                    <div>
                      <h4 className="text-sm font-black text-rose-950">Expert Safety Solutions</h4>
                      <p className="text-[10px] text-rose-700 font-semibold mt-0.5">Fire Safety & Rescue Equipment Specialists</p>
                    </div>

                    <div className="space-y-2.5 text-slate-700 pt-1">
                      <div>
                        <span className="font-bold text-slate-900 block mb-0.5">🏭 Registered Address:</span>
                        <p className="leading-relaxed">
                          Survey No. 775/2, Sub Plot No. 737/1, NH No. 8, Beside Jeep Compass Showroom, Opp. GSFC Nagar Gate, Dashrath, Vadodara - 391740 (Gujarat, India)
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/50">
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Contact Person:</span>
                          <p className="font-semibold text-slate-800">Mr. Nilesh Padaya</p>
                          <p className="text-rose-600 font-bold">Mo. 8460699569</p>
                        </div>
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Email Support:</span>
                          <p className="font-semibold text-indigo-600">expertsafetysolution@gmail.com</p>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-200/50">
                        <span className="font-bold text-slate-900 mr-1.5">GSTIN/GST No.:</span>
                        <span className="font-extrabold text-slate-955 px-2 py-0.5 rounded bg-slate-100 border border-slate-200 font-mono tracking-wide text-[11px]">
                          24COMPP8380J1Z9
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Bank Details */}
              {companyDetailsTab === 'bank' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="p-4 rounded-2xl bg-rose-50/50 border border-rose-100 space-y-3 relative group">
                    <button
                      type="button"
                      onClick={() => {
                        const bankText = `Company's Bank Details\n\nBank A/c Name : Expert Safety Solutions\nBank Name : HDFC BANK\nA/c No. : 50200097994640\nIFS Code : HDFC0005028\nBranch : Sama-Nizampura Link Road\n\nGoogle Pay : 8460699569`;
                        navigator.clipboard.writeText(bankText);
                        alert('📋 Bank details copied to clipboard!');
                      }}
                      className="absolute top-3 right-3 px-2.5 py-1 text-[10px] font-bold bg-white text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition shadow-2xs"
                    >
                      Copy Details
                    </button>
                    <div>
                      <h4 className="text-sm font-black text-rose-955">Company's Bank Details</h4>
                    </div>

                    <div className="space-y-2 text-slate-700 pt-1">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Bank A/c Name:</span>
                          <span className="font-semibold text-slate-800">Expert Safety Solutions</span>
                        </div>
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Bank Name:</span>
                          <span className="font-semibold text-slate-800">HDFC BANK</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/50">
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Account No:</span>
                          <span className="font-extrabold text-slate-950 font-mono tracking-wide text-xs">50200097994640</span>
                        </div>
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">IFSC Code:</span>
                          <span className="font-extrabold text-slate-955 font-mono tracking-wide text-xs">HDFC0005028</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/50">
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Branch:</span>
                          <span className="font-semibold text-slate-800">Sama-Nizampura Link Road</span>
                        </div>
                        <div>
                          <span className="font-bold text-slate-900 block mb-0.5">Google Pay / Mo:</span>
                          <span className="font-extrabold text-rose-600 font-mono tracking-wide text-xs">8460699569</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div className="space-y-1.5 text-center">
                      <span className="text-[10px] text-slate-500 font-bold block">1. QR Code - HDFC Bank</span>
                      <div 
                        onClick={() => setZoomedImage('/assets/HDFC Bank Details.jpeg')}
                        className="border border-slate-200 rounded-2xl overflow-hidden cursor-zoom-in hover:shadow-md transition bg-slate-100/50 flex items-center justify-center p-1.5 aspect-video"
                      >
                        <img 
                          src="/assets/HDFC Bank Details.jpeg" 
                          alt="HDFC Bank Details" 
                          className="max-h-28 object-contain rounded-lg"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5 text-center">
                      <span className="text-[10px] text-slate-500 font-bold block">2. HDFC Cancel Cheque Image</span>
                      <div 
                        onClick={() => setZoomedImage('/assets/HDFC - Cancel Cheque - Expert Safety Solutions..jpeg')}
                        className="border border-slate-200 rounded-2xl overflow-hidden cursor-zoom-in hover:shadow-md transition bg-slate-100/50 flex items-center justify-center p-1.5 aspect-video"
                      >
                        <img 
                          src="/assets/HDFC - Cancel Cheque - Expert Safety Solutions..jpeg" 
                          alt="HDFC Cancel Cheque" 
                          className="max-h-28 object-contain rounded-lg"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Google Review QR */}
              {companyDetailsTab === 'qr' && (
                <div className="space-y-4 text-center py-2 animate-fadeIn flex flex-col items-center">
                  {/* Google Review Widget Container */}
                  <div className="w-full max-w-sm bg-white border border-slate-100 rounded-2xl p-4 shadow-sm space-y-3.5">
                    
                    {/* Google Brand Header */}
                    <div className="flex items-center justify-center gap-1.5">
                      <span className="text-blue-500 font-black text-lg tracking-tight">G</span>
                      <span className="text-red-500 font-black text-lg tracking-tight">o</span>
                      <span className="text-yellow-500 font-black text-lg tracking-tight">o</span>
                      <span className="text-blue-500 font-black text-lg tracking-tight">g</span>
                      <span className="text-green-500 font-black text-lg tracking-tight">l</span>
                      <span className="text-red-500 font-black text-lg tracking-tight">e</span>
                      <span className="text-slate-500 font-bold text-xs ml-1 bg-slate-100 px-2 py-0.5 rounded-full">Reviews</span>
                    </div>

                    {/* Company info & Star Ratings */}
                    <div className="space-y-1">
                      <h4 className="text-sm font-black text-slate-800">Expert Safety Solutions</h4>
                      
                      {/* Golden Stars Rating Row */}
                      <div className="flex items-center justify-center gap-1">
                        <span className="text-yellow-500 font-black text-base">5.0</span>
                        <div className="flex text-yellow-500 gap-0.5 text-sm">
                          <span>★</span>
                          <span>★</span>
                          <span>★</span>
                          <span>★</span>
                          <span>★</span>
                        </div>
                        <span className="text-slate-400 font-medium text-[10px] ml-1">(Active Client Reviews)</span>
                      </div>
                    </div>

                    {/* QR Code Container */}
                    <div className="flex flex-col items-center">
                      <div 
                        onClick={() => setZoomedImage('/assets/Google Review QR.jpeg')}
                        className="w-44 h-44 bg-slate-50 border border-slate-200/80 rounded-2xl flex items-center justify-center p-3 cursor-zoom-in hover:shadow-md transition duration-300"
                      >
                        <img 
                          src="/assets/Google Review QR.jpeg" 
                          alt="Google Review QR Code" 
                          className="max-w-full max-h-full object-contain rounded-lg"
                        />
                      </div>
                      <span className="text-[10px] text-slate-400 font-bold mt-2">Tap QR code to zoom full screen</span>
                    </div>

                    {/* Bottom Call to Action banner */}
                    <div className="pt-2.5 border-t border-slate-100">
                      <p className="text-[11px] text-slate-500 font-semibold leading-relaxed">
                        Scan with your phone camera to write a review.
                      </p>
                    </div>

                  </div>
                </div>
              )}

            </div>

            {/* Close Button */}
            <div className="border-t border-slate-200 pt-3 flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => setShowCompanyDetailsModal(false)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FULL-SCREEN IMAGE ZOOM OVERLAY */}
      {zoomedImage && (
        <div 
          className="fixed inset-0 z-[99] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 transition-all duration-300 animate-fadeIn"
          onClick={() => setZoomedImage(null)}
        >
          <button 
            onClick={(e) => { e.stopPropagation(); setZoomedImage(null); }}
            className="absolute top-4 right-4 bg-white/20 hover:bg-white/30 text-white rounded-full p-2.5 transition text-lg z-[99]"
            title="Close Zoom"
          >
            ✕
          </button>
          <img 
            src={zoomedImage} 
            alt="Zoomed Details" 
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl animate-scaleIn cursor-zoom-out"
            onClick={(e) => { e.stopPropagation(); setZoomedImage(null); }}
          />
        </div>
      )}

      {/* TASK FILTER MODAL */}
      {showFilterModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                <Filter className="w-5 h-5 text-rose-600" />
                Filter Tasks
              </h3>
              <button
                onClick={() => setShowFilterModal(false)}
                className="text-slate-400 hover:text-slate-700 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Date Filter Selection Checklist */}
              <div>
                <label className="block text-slate-800 font-bold mb-1.5">Select Dates (Created Date):</label>
                <div className="border border-slate-200 rounded-xl p-2.5 max-h-36 overflow-y-auto bg-slate-50 space-y-1">
                  {dateCounts.length === 0 ? (
                    <div className="text-slate-400 text-center py-2">No dates available</div>
                  ) : (
                    dateCounts.map(([date, count]) => {
                      const isChecked = filterSelectedDates.includes(date);
                      return (
                        <label key={date} className="flex items-center gap-2 py-1.5 px-2 hover:bg-white rounded-lg cursor-pointer transition select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setFilterSelectedDates(filterSelectedDates.filter(d => d !== date));
                              } else {
                                setFilterSelectedDates([...filterSelectedDates, date]);
                              }
                            }}
                            className="rounded text-rose-600 focus:ring-rose-500 border-slate-300 w-4 h-4"
                          />
                          <span className="text-slate-700 font-semibold">{date}</span>
                          <span className="text-slate-400 font-bold ml-auto bg-white border border-slate-100 text-[10px] px-1.5 py-0.5 rounded-full">{count} {count === 1 ? 'task' : 'tasks'}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Custom Date Range */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Custom Start Date:</label>
                  <input
                    type="date"
                    value={filterStartDate}
                    onChange={e => setFilterStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Custom End Date:</label>
                  <input
                    type="date"
                    value={filterEndDate}
                    onChange={e => setFilterEndDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              </div>

              {/* User Filter Selection Checklist */}
              <div>
                <label className="block text-slate-800 font-bold mb-1.5">Select Users (Created By):</label>
                <div className="border border-slate-200 rounded-xl p-2.5 max-h-36 overflow-y-auto bg-slate-50 space-y-1">
                  {Object.keys(userCounts).length === 0 ? (
                    <div className="text-slate-400 text-center py-2">No creators available</div>
                  ) : (
                    Object.entries(userCounts).map(([staffId, count]) => {
                      const isChecked = filterSelectedUsers.includes(staffId);
                      const staffDoc = staffList.find(s => String(s.Staff_ID) === String(staffId) || s.Name === staffId);
                      const name = staffDoc ? staffDoc.Name : (staffId === 'SYSTEM' ? 'SYSTEM (Auto)' : staffId);
                      return (
                        <label key={staffId} className="flex items-center gap-2 py-1.5 px-2 hover:bg-white rounded-lg cursor-pointer transition select-none">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setFilterSelectedUsers(filterSelectedUsers.filter(u => u !== staffId));
                              } else {
                                setFilterSelectedUsers([...filterSelectedUsers, staffId]);
                              }
                            }}
                            className="rounded text-rose-600 focus:ring-rose-500 border-slate-300 w-4 h-4"
                          />
                          <span className="text-slate-700 font-semibold">{name}</span>
                          <span className="text-slate-400 font-bold ml-auto bg-white border border-slate-100 text-[10px] px-1.5 py-0.5 rounded-full">{count} {count === 1 ? 'task' : 'tasks'}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => {
                  setFilterSelectedDates([]);
                  setFilterSelectedUsers([]);
                  setFilterStartDate('');
                  setFilterEndDate('');
                }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-rose-600 border border-rose-200 hover:bg-rose-50 transition"
              >
                Reset All
              </button>
              <button
                type="button"
                onClick={() => setShowFilterModal(false)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs transition"
              >
                Apply Filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT WORK ORDER MODAL */}
      {showEditTaskModal && editingTask && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-bold text-slate-900">Edit Work Order</h3>
            <form onSubmit={handleEditTaskSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Work Description *</label>
                <input
                  type="text"
                  required
                  value={editingTask.Description}
                  onChange={e => setEditingTask({ ...editingTask, Description: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Department</label>
                  <select
                    value={editingTask.Department}
                    onChange={e => setEditingTask({ ...editingTask, Department: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    <option value="Sales">Sales</option>
                    <option value="Production">Production</option>
                    <option value="Certification">Certification</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-slate-700 font-semibold">Assign Staff</label>
                    {(editingTask.Department === 'Certification' || editingTask.Stage === 'Certificate' || editingTask.Stage === 'Certification') && (
                      <label className="flex items-center gap-1 cursor-pointer text-[10px] text-indigo-600 font-bold">
                        <input
                          type="checkbox"
                          checked={!showOnlyAdminForCert}
                          onChange={e => setShowOnlyAdminForCert(!e.target.checked)}
                          className="rounded text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>Show All Staff</span>
                      </label>
                    )}
                  </div>
                  <select
                    value={editingTask.Assigned_Staff}
                    onChange={e => setEditingTask({ ...editingTask, Assigned_Staff: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    {getFilteredStaffList(editingTask.Department || editingTask.Stage).map(s => (
                      <option key={s.Staff_ID} value={s.Staff_ID}>{s.Name} ({s.Role})</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Service Type</label>
                  <select
                    value={editingTask.Type}
                    onChange={e => setEditingTask({ ...editingTask, Type: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    <option value="Recurring">Recurring</option>
                    <option value="One-time">One-time</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Scheduled Date</label>
                  <input
                    type="date"
                    required
                    value={editingTask.Scheduled_Date}
                    onChange={e => setEditingTask({ ...editingTask, Scheduled_Date: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              </div>

              {editingTask.Type === 'Recurring' && (
                <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 border border-indigo-100 rounded-xl animate-fadeIn">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Repeat Every</label>
                    <input
                      type="number"
                      min="1"
                      value={editingTask.Recurring_Period?.value ?? 1}
                      onChange={e => setEditingTask({
                        ...editingTask,
                        Recurring_Period: { type: editingTask.Recurring_Period?.type || editingTask.Recurring_Interval || 'Monthly', value: e.target.value }
                      })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Period</label>
                    <select
                      value={editingTask.Recurring_Period?.type || editingTask.Recurring_Interval || 'Monthly'}
                      onChange={e => setEditingTask({
                        ...editingTask,
                        Recurring_Interval: e.target.value,
                        Recurring_Period: { type: e.target.value, value: editingTask.Recurring_Period?.value ?? 1 }
                      })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Daily">Daily</option>
                      <option value="Weekly">Weekly</option>
                      <option value="Monthly">Monthly</option>
                      <option value="Quarterly">Quarterly</option>
                      <option value="Half-Yearly">Half-Yearly</option>
                      <option value="Yearly">Yearly</option>
                    </select>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Stage</label>
                <input
                  type="text"
                  required
                  value={editingTask.Stage}
                  onChange={e => setEditingTask({ ...editingTask, Stage: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowEditTaskModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-bold shadow-sm"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NEW WORK ORDER MODAL */}
      {showNewTaskModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-bold text-slate-900">Create New Work Order</h3>
            <form onSubmit={handleCreateTask} className="space-y-4 text-xs">
              {/* Smart Customer Database Search or Add New */}
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800">1. Select Company from Database</span>
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewCustomerMode(!isNewCustomerMode);
                      setSelectedCustomer(null);
                    }}
                    className="text-[11px] font-bold text-indigo-600 hover:underline"
                  >
                    {isNewCustomerMode ? '← Search Database' : '+ New Customer? Add to Database'}
                  </button>
                </div>

                {!isNewCustomerMode ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder="Search Company Name or Contact..."
                      value={customerSearchQuery}
                      onChange={e => {
                        setCustomerSearchQuery(e.target.value);
                        setSelectedCustomer(null);
                      }}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                    />
                    {selectedCustomer ? (
                      <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl space-y-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-xs font-bold text-indigo-950 block">
                              ✓ Selected: {selectedCustomer.Company_Name} ({selectedCustomer.Customer_ID})
                            </span>
                            <span className="text-[11px] text-indigo-800">
                              Contact: {selectedCustomer.Auth_Person || selectedCustomer.Contact} | {selectedCustomer.Address || 'No address specified'}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setSelectedCustomer(null)}
                            className="text-xs text-rose-600 font-bold hover:underline shrink-0"
                          >
                            Change
                          </button>
                        </div>

                        {/* Customer Location Link / Fetch Location Button */}
                        <div className="pt-2 border-t border-indigo-100 flex flex-wrap items-center justify-between gap-2">
                          {selectedCustomer.Location_Link ? (
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                              <a
                                href={selectedCustomer.Location_Link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 hover:bg-emerald-200 px-2.5 py-1 rounded-lg transition truncate"
                              >
                                <MapPin className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">Client Location Available</span>
                              </a>
                              <button
                                type="button"
                                disabled={fetchingLocationFor === selectedCustomer.Customer_ID}
                                onClick={() => handleFetchAndSaveCustomerGps(selectedCustomer)}
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-700 hover:text-indigo-900 bg-white border border-indigo-200 px-2.5 py-1 rounded-lg transition shadow-2xs"
                                title="Update directly to your exact current GPS position"
                              >
                                <Navigation className={`w-3 h-3 ${fetchingLocationFor === selectedCustomer.Customer_ID ? 'animate-spin text-indigo-600' : ''}`} />
                                {fetchingLocationFor === selectedCustomer.Customer_ID ? 'Locating...' : 'Update GPS'}
                              </button>
                            </div>
                          ) : (
                            <div className="w-full flex items-center justify-between gap-2 bg-amber-50/90 border border-amber-200 p-2 rounded-xl flex-wrap">
                              <span className="text-[11px] font-semibold text-amber-900 flex items-center gap-1.5">
                                <MapPin className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                                Location not available
                              </span>
                              <button
                                type="button"
                                disabled={fetchingLocationFor === selectedCustomer.Customer_ID}
                                onClick={() => handleFetchAndSaveCustomerGps(selectedCustomer)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition shadow-sm shrink-0"
                              >
                                <Navigation className={`w-3.5 h-3.5 ${fetchingLocationFor === selectedCustomer.Customer_ID ? 'animate-spin' : ''}`} />
                                {fetchingLocationFor === selectedCustomer.Customer_ID ? 'Fetching GPS...' : '📍 Fetch & Save Location'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : customerSearchQuery.trim().length > 0 ? (
                      <div className="max-h-32 overflow-y-auto space-y-1 bg-white border border-slate-200 rounded-xl p-1">
                        {customers
                          .filter(c => c.Company_Name?.toLowerCase().includes(customerSearchQuery.toLowerCase()))
                          .slice(0, 5)
                          .map(c => (
                            <div
                              key={c.Customer_ID}
                              onClick={() => setSelectedCustomer(c)}
                              className="p-1.5 hover:bg-indigo-50 cursor-pointer rounded-lg flex items-center justify-between"
                            >
                              <div>
                                <span className="font-bold block">{c.Company_Name}</span>
                                <span className="text-[10px] text-slate-500">{c.Auth_Person} • {c.Contact}</span>
                              </div>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">Select</span>
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2 pt-1">
                    <p className="text-[10px] text-indigo-700 font-bold">New customer will be saved to database automatically:</p>
                    <input
                      type="text"
                      required={isNewCustomerMode}
                      placeholder="Company Name *"
                      value={customerForm.companyName}
                      onChange={e => setCustomerForm({ ...customerForm, companyName: e.target.value })}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="Contact Person"
                        value={customerForm.authPerson}
                        onChange={e => setCustomerForm({ ...customerForm, authPerson: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl"
                      />
                      <input
                        type="text"
                        placeholder="Mobile Number *"
                        maxLength={10}
                        required={isNewCustomerMode}
                        value={customerForm.contact}
                        onChange={e => {
                          const val = e.target.value.replace(/\D/g, '');
                          setCustomerForm({ ...customerForm, contact: val });
                        }}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl"
                      />
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        placeholder="Google Maps GPS Link (or click Fetch 👉)"
                        value={customerForm.locationLink}
                        onChange={e => setCustomerForm({ ...customerForm, locationLink: e.target.value })}
                        className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-xl"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 250 });
                            const lat = pos.latitude.toFixed(6);
                            const lng = pos.longitude.toFixed(6);
                            setCustomerForm({ ...customerForm, locationLink: `https://maps.google.com/?q=${lat},${lng}` });
                            alert(`✅ Current GPS coordinates verified & added! (${lat}, ${lng} — Accuracy: ~${pos.accuracy}m)`);
                          } catch (err) {
                            alert(`⚠️ High-Accuracy GPS Required!\n\n${err.message || 'Failed to get accurate GPS coordinates.'}\n\nPlease turn ON mobile GPS and try again.`);
                          }
                        }}
                        className="px-2.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs rounded-xl border border-indigo-200 flex items-center gap-1 transition shrink-0"
                        title="Fetch current GPS coordinates right from client location"
                      >
                        <Navigation className="w-3.5 h-3.5 text-indigo-600" />
                        <span>Fetch GPS</span>
                      </button>
                    </div>
                    <input
                      type="text"
                      placeholder="Company Address"
                      value={customerForm.address}
                      onChange={e => setCustomerForm({ ...customerForm, address: e.target.value })}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl"
                    />

                    <div className="space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-semibold text-slate-700">Additional Contact Persons</label>
                        <button type="button" onClick={() => setCustomerForm({ ...customerForm, contacts: [...customerForm.contacts, { name: '', designation: '', contactNumber: '', email: '' }] })} className="text-[10px] font-bold text-indigo-600 hover:underline">+ Add Contact</button>
                      </div>
                      {customerForm.contacts.map((c, i) => (
                        <div key={i} className="p-2 border border-slate-200 rounded-lg space-y-2 bg-white relative">
                          {i > 0 && (
                            <button type="button" onClick={() => setCustomerForm({ ...customerForm, contacts: customerForm.contacts.filter((_, idx) => idx !== i) })} className="absolute top-1 right-1 text-slate-400 hover:text-rose-600">✕</button>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <input type="text" placeholder="Name" value={c.name} onChange={e => { const newC = [...customerForm.contacts]; newC[i].name = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="text" placeholder="Designation" value={c.designation} onChange={e => { const newC = [...customerForm.contacts]; newC[i].designation = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="text" placeholder="Phone" maxLength={10} value={c.contactNumber} onChange={e => { const val = e.target.value.replace(/\D/g, ''); const newC = [...customerForm.contacts]; newC[i].contactNumber = val; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="email" placeholder="Email" value={c.email} onChange={e => { const newC = [...customerForm.contacts]; newC[i].email = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Work Description *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Fire Extinguisher Refilling & Inspection"
                  value={taskForm.description}
                  onChange={e => setTaskForm({ ...taskForm, description: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Department</label>
                  <select
                    value={taskForm.department}
                    onChange={e => setTaskForm({ ...taskForm, department: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    <option value="Sales">Sales</option>
                    <option value="Production">Production</option>
                    <option value="Certification">Certification</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-slate-700 font-semibold">Assign Staff</label>
                    {taskForm.department === 'Certification' && (
                      <label className="flex items-center gap-1 cursor-pointer text-[10px] text-indigo-600 font-bold">
                        <input
                          type="checkbox"
                          checked={!showOnlyAdminForCert}
                          onChange={e => setShowOnlyAdminForCert(!e.target.checked)}
                          className="rounded text-indigo-600 focus:ring-indigo-500"
                        />
                        <span>Show All Staff</span>
                      </label>
                    )}
                  </div>
                  <select
                    value={taskForm.assignedStaff}
                    onChange={e => setTaskForm({ ...taskForm, assignedStaff: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    {getFilteredStaffList(taskForm.department).map(s => (
                      <option key={s.Staff_ID} value={s.Staff_ID}>{s.Name} ({s.Role})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Service Type</label>
                  <select
                    value={taskForm.type}
                    onChange={e => setTaskForm({ ...taskForm, type: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    <option value="Recurring">Recurring</option>
                    <option value="One-time">One-time</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Scheduled Date</label>
                  <input
                    type="date"
                    required
                    value={taskForm.scheduledDate}
                    onChange={e => setTaskForm({ ...taskForm, scheduledDate: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              </div>

              {taskForm.type === 'Recurring' && (
                <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 border border-indigo-100 rounded-xl">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Repeat Every</label>
                    <input
                      type="number"
                      min="1"
                      value={taskForm.recurringPeriod.value}
                      onChange={e => setTaskForm({ ...taskForm, recurringPeriod: { ...taskForm.recurringPeriod, value: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Period</label>
                    <select
                      value={taskForm.recurringPeriod.type}
                      onChange={e => setTaskForm({ ...taskForm, recurringPeriod: { ...taskForm.recurringPeriod, type: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Daily">Daily</option>
                      <option value="Weekly">Weekly</option>
                      <option value="Monthly">Monthly</option>
                      <option value="Quarterly">Quarterly</option>
                      <option value="Half-Yearly">Half-Yearly</option>
                      <option value="Yearly">Yearly</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowNewTaskModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-sm"
                >
                  Create Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NEW CUSTOMER MODAL */}
      {showNewCustomerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-bold text-slate-900">Add New Corporate Customer</h3>
            <form onSubmit={handleCreateCustomer} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Company Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Reliance Logistics Park"
                  value={customerForm.companyName}
                  onChange={e => setCustomerForm({ ...customerForm, companyName: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Auth Person</label>
                  <input
                    type="text"
                    placeholder="Facility Head"
                    value={customerForm.authPerson}
                    onChange={e => setCustomerForm({ ...customerForm, authPerson: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Contact Phone *</label>
                  <input
                    type="text"
                    required
                    maxLength={10}
                    placeholder="+91 99888 77665"
                    value={customerForm.contact}
                    onChange={e => {
                      const val = e.target.value.replace(/\D/g, '');
                      setCustomerForm({ ...customerForm, contact: val });
                    }}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Google Maps GPS Link</label>
                <input
                  type="text"
                  placeholder="https://maps.app.goo.gl/... or GPS URL"
                  value={customerForm.locationLink}
                  onChange={e => setCustomerForm({ ...customerForm, locationLink: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Full Facility Address</label>
                <textarea
                  rows={2}
                  placeholder="Plot 10, Industrial Estate..."
                  value={customerForm.address}
                  onChange={e => setCustomerForm({ ...customerForm, address: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <div className="space-y-2 mt-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-semibold text-slate-700">Additional Contact Persons</label>
                  <button type="button" onClick={() => setCustomerForm({ ...customerForm, contacts: [...customerForm.contacts, { name: '', designation: '', contactNumber: '', email: '' }] })} className="text-[10px] font-bold text-indigo-600 hover:underline">+ Add Contact</button>
                </div>
                {customerForm.contacts.map((c, i) => (
                  <div key={i} className="p-2 border border-slate-200 rounded-lg space-y-2 bg-white relative">
                    {i > 0 && (
                      <button type="button" onClick={() => setCustomerForm({ ...customerForm, contacts: customerForm.contacts.filter((_, idx) => idx !== i) })} className="absolute top-1 right-1 text-slate-400 hover:text-rose-600">✕</button>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <input type="text" placeholder="Name" value={c.name} onChange={e => { const newC = [...customerForm.contacts]; newC[i].name = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                      <input type="text" placeholder="Designation" value={c.designation} onChange={e => { const newC = [...customerForm.contacts]; newC[i].designation = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                      <input type="text" placeholder="Phone" maxLength={10} value={c.contactNumber} onChange={e => { const val = e.target.value.replace(/\D/g, ''); const newC = [...customerForm.contacts]; newC[i].contactNumber = val; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                      <input type="email" placeholder="Email" value={c.email} onChange={e => { const newC = [...customerForm.contacts]; newC[i].email = e.target.value; setCustomerForm({ ...customerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowNewCustomerModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-sm"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADVANCE PAYMENT RECORD MODAL */}
      {showAdvanceModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Banknote className="w-5 h-5 text-rose-600" />
                Record Staff Salary Advance Payment
              </h3>
              <button
                onClick={() => setShowAdvanceModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRecordAdvanceSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Select Staff Member *</label>
                <select
                  required
                  value={advanceForm.staffId}
                  onChange={e => setAdvanceForm({ ...advanceForm, staffId: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 font-semibold"
                >
                  <option value="">-- Choose Staff --</option>
                  {staffList.map(st => (
                    <option key={st.Staff_ID} value={st.Staff_ID}>
                      {st.Name} ({st.Staff_ID}) — {st.Role}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Advance Amount (₹) *</label>
                <input
                  type="number"
                  required
                  min="1"
                  placeholder="e.g. 5000"
                  value={advanceForm.amount}
                  onChange={e => setAdvanceForm({ ...advanceForm, amount: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 font-bold text-rose-600"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Payment Mode *</label>
                <select
                  value={advanceForm.paymentMode}
                  onChange={e => setAdvanceForm({ ...advanceForm, paymentMode: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 font-semibold"
                >
                  <option value="Cash">Cash</option>
                  <option value="Bank Transfer / UPI">Bank Transfer / UPI</option>
                  <option value="Cheque">Cheque</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Remarks / Reason</label>
                <textarea
                  rows="2"
                  placeholder="Medical emergency / Festival advance..."
                  value={advanceForm.remarks}
                  onChange={e => setAdvanceForm({ ...advanceForm, remarks: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAdvanceModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={advanceSubmitting}
                  className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-sm"
                >
                  {advanceSubmitting ? 'Saving...' : 'Save Advance Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADMIN ASSIGN LEAVE MODAL */}
      {showAdminLeaveModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-xl border border-slate-200 animate-fadeIn max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-rose-600" />
                Assign Leave to Staff
              </h3>
              <button
                onClick={() => setShowAdminLeaveModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAdminLeaveSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Select Staff Member *</label>
                <select
                  value={adminLeaveForm.staffId}
                  onChange={e => setAdminLeaveForm({ ...adminLeaveForm, staffId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white font-semibold"
                >
                  {staffList.map(st => (
                    <option key={st.Staff_ID} value={st.Staff_ID}>
                      {st.Staff_ID} - {st.Name} ({st.Role})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Leave Date *</label>
                  <input
                    type="date"
                    required
                    value={adminLeaveForm.leaveDate}
                    onChange={e => setAdminLeaveForm({ ...adminLeaveForm, leaveDate: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl font-semibold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Leave Type *</label>
                  <select
                    value={adminLeaveForm.leaveType}
                    onChange={e => setAdminLeaveForm({ ...adminLeaveForm, leaveType: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl font-semibold"
                  >
                    <option value="Full Day">Full Day</option>
                    <option value="Half Day">Half Day</option>
                    <option value="Short Leave">Short Leave</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Remarks / Reason</label>
                <input
                  type="text"
                  placeholder="e.g. Approved annual leave / medical leave"
                  value={adminLeaveForm.reason}
                  onChange={e => setAdminLeaveForm({ ...adminLeaveForm, reason: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl font-medium"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowAdminLeaveModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={adminLeaveSubmitting}
                  className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-sm"
                >
                  {adminLeaveSubmitting ? 'Assigning...' : 'Assign Approved Leave'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CALL RECEIVED — CONTACT PICKER (which client contact called in, when there's more than one on file) */}
      {callReceivedContactPicker.isOpen && (
        <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="p-4 bg-slate-900 flex items-center justify-between">
              <h3 className="text-white font-bold flex items-center gap-2 text-sm">
                <PhoneCall className="w-4 h-4 text-emerald-400" /> Who Called?
              </h3>
              <button onClick={() => setCallReceivedContactPicker({ isOpen: false, contacts: [] })} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-2">
              <p className="text-xs text-slate-500 mb-1 font-medium">Select which contact person called in</p>
              {callReceivedContactPicker.contacts.map((contact, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => applyCallReceivedTag(contact.name)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border-2 border-slate-200 hover:border-amber-500 hover:bg-amber-50 text-left transition"
                >
                  <span className="min-w-0">
                    <span className="block font-bold text-slate-800 text-sm truncate">{contact.name || 'Unknown Contact'}</span>
                    {(contact.designation || contact.phone) && (
                      <span className="block text-[11px] text-slate-500 truncate">{contact.designation ? `${contact.designation} • ` : ''}{contact.phone}</span>
                    )}
                  </span>
                  {contact.isPrimary && <span className="shrink-0 text-[9px] px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold uppercase">Primary</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* CONTACT CHOICE MODAL */}
      {contactModal.isOpen && contactModal.customer && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="p-4 bg-slate-900 flex items-center justify-between">
              <h3 className="text-white font-bold flex items-center gap-2 text-sm">
                {contactModal.mode === 'CALL' ? (
                  <><PhoneCall className="w-4 h-4 text-emerald-400" /> Select Number to Call</>
                ) : (
                  <><MessageCircle className="w-4 h-4 text-green-400" /> Send WhatsApp</>
                )}
              </h3>
              <button onClick={() => setContactModal({ isOpen: false, mode: 'CALL', customer: null, task: null })} className="text-slate-400 hover:text-white">✕</button>
            </div>
            
            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              <p className="text-xs text-slate-500 mb-2 font-medium">Select a contact person for {contactModal.customer.Company_Name}</p>
              
              {(() => {
                const renderContactBlock = (contact, keyIdx) => {
                  if (!contact.phone) return null;
                  const cleanPhone = contact.cleanPhone;
                  const waPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

                  return (
                    <div key={keyIdx} className="p-3 border border-slate-200 rounded-xl bg-slate-50 space-y-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800 text-sm">{contact.name || 'Unknown Contact'}</span>
                          {contact.isPrimary && <span className="text-[9px] px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded font-bold uppercase">Primary</span>}
                        </div>
                        {(contact.designation || contact.phone) && <p className="text-[11px] text-slate-500">{contact.designation ? `${contact.designation} • ` : ''}{contact.phone}</p>}
                      </div>

                      {contactModal.mode === 'CALL' ? (
                        <a href={`tel:${formatDialerNumber(cleanPhone)}`} onClick={() => {
                          if (contactModal.task) {
                            triggerQuickInteraction('Call', contactModal.task, contact.name);
                          } else if (contactModal.customer?.Customer_ID) {
                            handleLogCustomerCall(contactModal.customer);
                          }
                          setContactModal({ isOpen: false, mode: 'CALL', customer: null, task: null });
                        }} className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-sm">
                          <PhoneCall className="w-3.5 h-3.5" />
                          Call Now
                        </a>
                      ) : (
                        <div className="space-y-2">
                          {(() => {
                            const handleWaLinkClick = () => {
                              if (contactModal.task) {
                                triggerQuickInteraction('WhatsApp', contactModal.task, contact.name);
                              }
                              setContactModal({ isOpen: false, mode: 'WHATSAPP', customer: null, task: null });
                            };
                            return (
                              <>
                                <p className="text-[10px] font-bold text-slate-400 uppercase">Choose App (Android OS):</p>
                                <div className="grid grid-cols-2 gap-2">
                                  <a href={`intent://send?phone=${waPhone}#Intent;package=com.whatsapp;scheme=whatsapp;end;`} onClick={handleWaLinkClick} className="flex items-center justify-center gap-1.5 py-2 rounded-lg bg-green-500 hover:bg-green-600 text-white text-[10px] font-bold transition shadow-sm">
                                    <MessageCircle className="w-3.5 h-3.5" />
                                    WhatsApp
                                  </a>
                                  <a href={`intent://send?phone=${waPhone}#Intent;package=com.whatsapp.w4b;scheme=whatsapp;end;`} onClick={handleWaLinkClick} className="flex items-center justify-center gap-1.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[10px] font-bold transition shadow-sm">
                                    <Briefcase className="w-3.5 h-3.5" />
                                    WA Business
                                  </a>
                                </div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase mt-2">iOS / Web Desktop:</p>
                                <a href={`https://wa.me/${waPhone}`} target="_blank" rel="noopener noreferrer" onClick={handleWaLinkClick} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 text-[10px] font-bold transition shadow-sm">
                                  Open Standard Web Link
                                </a>
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                };

                const contactsList = getAvailableContacts(contactModal.customer, contactModal.task);
                return contactsList.map((contact, idx) => renderContactBlock(contact, idx));
              })()}
            </div>
          </div>
        </div>
      )}

      {/* RIGHT SIDE ADMIN PROFILE & QUICK MENU POPUP */}
      {showAdminProfilePopup && (
        <div className="fixed inset-0 z-50 bg-slate-900/10 flex items-start justify-end p-4 sm:p-6">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-slate-200 animate-fadeIn space-y-5 max-h-[95vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-12 h-12 rounded-full bg-slate-900 text-white flex items-center justify-center text-base font-extrabold shadow-sm overflow-hidden border-2 border-rose-600 shrink-0">
                  <Shield className="w-6 h-6 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 leading-tight">{user?.Name || 'System Director'}</h3>
                  <p className="text-xs font-semibold text-slate-500">Role: {user?.Role || 'Admin'} • Executive Control</p>
                  <span className="mt-1 inline-block px-2 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-bold">
                    Full Admin Access
                  </span>
                </div>
              </div>
              <button
                onClick={() => setShowAdminProfilePopup(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm p-1"
              >
                ✕
              </button>
            </div>

            {/* SYSTEM STATS SUMMARY */}
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">CRM System Status</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                  <p className="text-[10px] text-slate-500 font-semibold">Staff</p>
                  <p className="text-base font-bold text-slate-900">{staffList.length}</p>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                  <p className="text-[10px] text-indigo-600 font-semibold">Customers</p>
                  <p className="text-base font-bold text-indigo-700">{customers.length}</p>
                </div>
                <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                  <p className="text-[10px] text-emerald-600 font-semibold">Tasks</p>
                  <p className="text-base font-bold text-emerald-700">{tasks.length}</p>
                </div>
              </div>
            </div>

            {/* QUICK MENU NAVIGATION */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setActiveTab('PIPELINE'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Briefcase className="w-4 h-4 text-rose-600" />
                  <span>Task Pipeline & Work Orders</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setActiveTab('STAFF'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Users className="w-4 h-4 text-indigo-600" />
                  <span>Staff Roster, Salary & Scope</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setActiveTab('CUSTOMERS'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Building2 className="w-4 h-4 text-amber-600" />
                  <span>Client Database & CRM Profiles</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setActiveTab('ATTENDANCE'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Clock className="w-4 h-4 text-emerald-600" />
                  <span>Staff Attendance & Leave Roster</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setActiveTab('LOGS'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Activity className="w-4 h-4 text-teal-600" />
                  <span>Live Activity Logs & Audit Trail</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setShowCompanyDetailsModal(true); setCompanyDetailsTab('billing'); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <Building2 className="w-4 h-4 text-rose-600" />
                  <span>Company Details & QR Codes</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowAdminProfilePopup(false);
                  setIcardTargetUser({
                    Name: user?.Name || 'System Director',
                    Staff_ID: user?.Staff_ID || user?.staffId || 'ADMIN',
                    Role: user?.Role || 'Admin',
                    Mobile: user?.Mobile || '8460699569'
                  });
                  setShowICardModal(true);
                }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2.5">
                  <CreditCard className="w-4 h-4 text-indigo-650" />
                  <span>View My ID Card</span>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowAdminProfilePopup(false); setShowChangePasswordModal(true); setChangePasswordError(''); }}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold text-xs transition border border-amber-200"
              >
                <div className="flex items-center gap-2.5">
                  <Key className="w-4 h-4 text-amber-600" />
                  <span>Change My Password</span>
                </div>
                <ChevronRight className="w-4 h-4 text-amber-400" />
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200 space-y-2">
              <button
                type="button"
                onClick={() => setShowAdminProfilePopup(false)}
                className="w-full py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition"
              >
                Close Menu
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdminProfilePopup(false);
                  logout();
                }}
                className="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-2 transition shadow-sm"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out / Logout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CHANGE MY OWN PASSWORD MODAL (self-service — requires current password) */}
      {showChangePasswordModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full p-4 sm:p-6 shadow-2xl space-y-4 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-600" />
                <span>Change My Password</span>
              </h3>
              <button
                onClick={() => setShowChangePasswordModal(false)}
                className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleChangeMyPassword} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Current Password *</label>
                <input
                  type="password"
                  required
                  value={changePasswordForm.oldPassword}
                  onChange={e => setChangePasswordForm(p => ({ ...p, oldPassword: e.target.value }))}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">New Password *</label>
                <input
                  type="password"
                  required
                  value={changePasswordForm.newPassword}
                  onChange={e => setChangePasswordForm(p => ({ ...p, newPassword: e.target.value }))}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
                <p className="text-[10px] text-slate-400 mt-1">Min 8 characters, with at least one letter, one number & one special character.</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Confirm New Password *</label>
                <input
                  type="password"
                  required
                  value={changePasswordForm.confirmPassword}
                  onChange={e => setChangePasswordForm(p => ({ ...p, confirmPassword: e.target.value }))}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              {changePasswordError && (
                <p className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{changePasswordError}</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowChangePasswordModal(false)}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={changePasswordSubmitting}
                  className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50"
                >
                  {changePasswordSubmitting ? 'Saving...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* COMPREHENSIVE STAFF MEMBER 360 PROFILE & HISTORY MODAL */}
      {selectedStaffProfile && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
          <div className="bg-white rounded-3xl max-w-3xl w-full shadow-2xl border border-slate-200 p-5 sm:p-7 max-h-[92vh] overflow-y-auto space-y-6 my-auto animate-fadeIn">
            {/* Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-slate-200 pb-4 gap-3">
              <div className="flex items-center gap-3.5">
                <div className="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center text-xl font-extrabold shadow-md shrink-0">
                  {selectedStaffProfile.Name?.charAt(0) || 'S'}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-bold text-slate-900">{selectedStaffProfile.Name}</h3>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200">
                      {selectedStaffProfile.Staff_ID}
                    </span>
                    <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                      {selectedStaffProfile.Status || 'Active'}
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-slate-500 mt-0.5">
                    {selectedStaffProfile.Role} • {selectedStaffProfile.Department} Department
                  </p>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-slate-600">
                    <span>📞 {selectedStaffProfile.Mobile || 'N/A'}</span>
                    <span>✉️ {selectedStaffProfile.Email || 'N/A'}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedStaffProfile(null)}
                className="text-slate-400 hover:text-slate-700 font-bold text-base p-1 self-end sm:self-auto"
              >
                ✕
              </button>
            </div>

            {/* Stats Overview */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-2xl bg-indigo-50/70 border border-indigo-100">
                <p className="text-[11px] font-bold text-indigo-600 uppercase">Assigned Tasks</p>
                <p className="text-lg font-extrabold text-indigo-900 mt-0.5">
                  {tasks.filter(t => t.Assigned_Staff === selectedStaffProfile.Staff_ID || t.Assigned_Staff_Name === selectedStaffProfile.Name).length}
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-emerald-50/70 border border-emerald-100">
                <p className="text-[11px] font-bold text-emerald-600 uppercase">Completed Work</p>
                <p className="text-lg font-extrabold text-emerald-900 mt-0.5">
                  {tasks.filter(t => (t.Assigned_Staff === selectedStaffProfile.Staff_ID || t.Assigned_Staff_Name === selectedStaffProfile.Name) && (t.Status === 'Completed' || t.Status === 'Closed')).length}
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-amber-50/70 border border-amber-100">
                <p className="text-[11px] font-bold text-amber-600 uppercase">Total Attendance</p>
                <p className="text-lg font-extrabold text-amber-900 mt-0.5">
                  {attendanceLogs.filter(a => a.Staff_ID === selectedStaffProfile.Staff_ID).length} Days
                </p>
              </div>
              <div className="p-3 rounded-2xl bg-rose-50/70 border border-rose-100">
                <p className="text-[11px] font-bold text-rose-600 uppercase">Leave Requests</p>
                <p className="text-lg font-extrabold text-rose-900 mt-0.5">
                  {leaveRequests.filter(l => l.Staff_ID === selectedStaffProfile.Staff_ID).length}
                </p>
              </div>
            </div>

            {/* Quick Controls Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-700 flex items-center gap-1">
                  <IndianRupee className="w-3.5 h-3.5 text-emerald-600" />
                  Daily Salary Rate (₹ / Day)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    defaultValue={selectedStaffProfile.Daily_Salary_Rate || 1000}
                    onBlur={e => handleUpdateStaffDailyRate(selectedStaffProfile.Staff_ID, e.target.value)}
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <span className="text-[10px] text-slate-400 shrink-0 font-medium">Auto-Saves</span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-700 flex items-center gap-1">
                  <Key className="w-3.5 h-3.5 text-indigo-600" />
                  Access Point & Permission Scope
                </label>
                <select
                  value={selectedStaffProfile.Permissions || 'ASSIGNED_ONLY'}
                  onChange={e => handleUpdateStaffPermission(selectedStaffProfile.Staff_ID, e.target.value)}
                  className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="ASSIGNED_ONLY">Assigned Work Only</option>
                  <option value="ALL_CUSTOMERS">All Customer Directory & CRM Access</option>
                  <option value="ALL_TASKS">All Company Work Orders & Pipeline</option>
                  <option value="FULL_ACCESS">Full Access (Supervisor Scope)</option>
                </select>
              </div>
            </div>

            {/* Assigned Tasks Section */}
            <div className="space-y-3">
              <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-indigo-600" />
                Current & Recent Assigned Tasks
              </h4>
              <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
                {(() => {
                  let staffTasks = tasks.filter(t => t.Assigned_Staff === selectedStaffProfile.Staff_ID || t.Assigned_Staff_Name === selectedStaffProfile.Name);
                  const taskOrder = selectedStaffProfile?.Task_Order;
                  if (Array.isArray(taskOrder) && taskOrder.length > 0) {
                    staffTasks = [...staffTasks].sort((a, b) => {
                      const idxA = taskOrder.indexOf(a.Task_ID);
                      const idxB = taskOrder.indexOf(b.Task_ID);
                      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                      if (idxA !== -1) return -1;
                      if (idxB !== -1) return 1;
                      return 0;
                    });
                  }
                  if (staffTasks.length === 0) {
                    return <p className="text-xs text-slate-400 italic p-3 bg-slate-50 rounded-xl text-center">No tasks currently assigned to this staff member.</p>;
                  }
                  return staffTasks.slice(0, 10).map(t => (
                    <div key={t.Task_ID} className="p-3 rounded-xl border border-slate-200 bg-white flex items-center justify-between text-xs gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-slate-800 truncate">{t.Description || 'Work Order'}</p>
                        <p className="text-[11px] text-slate-500 truncate">
                          {(t.Customer_Name && t.Customer_Name !== 'General Client' && t.Customer_Name !== 'Unknown Company')
                            ? t.Customer_Name
                            : (customersById.get(String(t.Customer_ID || '').trim().toLowerCase())?.Company_Name || t.Customer_Name || (t.Customer_ID ? `Customer (${t.Customer_ID})` : 'General Client'))} • Due: {formatDateDDMMYYYY(t.Scheduled_Date)}
                        </p>
                      </div>
                      <span className={`px-2 py-0.5 rounded font-bold text-[10px] shrink-0 ${
                        t.Status === 'Completed' || t.Status === 'Closed' ? 'bg-emerald-100 text-emerald-800' :
                        t.Status === 'In Progress' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'
                      }`}>
                        {t.Status || 'Assigned'}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </div>

            {/* Attendance & Leaves Quick Logs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Attendance */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-emerald-600" />
                  Recent Attendance Logs
                </h4>
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1 text-xs">
                  {(() => {
                    const logsList = attendanceLogs.filter(a => a.Staff_ID === selectedStaffProfile.Staff_ID);
                    if (logsList.length === 0) return <p className="text-[11px] text-slate-400 italic p-2 bg-slate-50 rounded-lg text-center">No attendance records.</p>;
                    return logsList.slice(0, 5).map(a => (
                      <div key={a.Log_ID} className="p-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between">
                        <span className="font-semibold text-slate-700">{formatDateDDMMYYYY(a.Date)}</span>
                        <span className="font-bold text-[11px] text-emerald-700">In: {formatTime24H(a.Punch_In_Time || a.Punch_In)} {(a.Punch_Out_Time || a.Punch_Out) ? `| Out: ${formatTime24H(a.Punch_Out_Time || a.Punch_Out)}` : ''}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>

              {/* Leaves */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <CalendarDays className="w-3.5 h-3.5 text-rose-600" />
                  Leave Request History
                </h4>
                <div className="max-h-40 overflow-y-auto space-y-1.5 pr-1 text-xs">
                  {(() => {
                    const lList = leaveRequests.filter(l => l.Staff_ID === selectedStaffProfile.Staff_ID);
                    if (lList.length === 0) return <p className="text-[11px] text-slate-400 italic p-2 bg-slate-50 rounded-lg text-center">No leave requests.</p>;
                    return lList.slice(0, 5).map(l => (
                      <div key={l.Request_ID} className="p-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between">
                        <div>
                          <span className="font-bold text-slate-800">{formatDateDDMMYYYY(l.Leave_Date)}</span>
                          <span className="block text-[10px] text-slate-500">{l.Leave_Type}</span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          l.Status === 'Approved' ? 'bg-emerald-100 text-emerald-800' :
                          l.Status === 'Rejected' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {l.Status || 'Pending'}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>

            {/* Actions Footer */}
            <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdminLeaveModal(true);
                    setAdminLeaveForm(prev => ({ ...prev, staffId: selectedStaffProfile.Staff_ID }));
                  }}
                  className="px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-xs flex items-center gap-1.5 transition"
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                  Assign Leave
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdvanceModal(true);
                    setAdvanceForm(prev => ({ ...prev, staffId: selectedStaffProfile.Staff_ID }));
                  }}
                  className="px-3.5 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold text-xs flex items-center gap-1.5 transition"
                >
                  <IndianRupee className="w-3.5 h-3.5" />
                  Record Advance
                </button>
              </div>

              <button
                type="button"
                onClick={() => setSelectedStaffProfile(null)}
                className="px-5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-sm transition"
              >
                Close Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STAFF ACCESS ACCOUNTS DIRECTORY MODAL */}
      {showStaffAccessModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto animate-fadeIn">
          <div className="bg-white rounded-3xl max-w-3xl w-full p-5 sm:p-7 shadow-2xl border border-slate-200 max-h-[90vh] flex flex-col space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-600 via-indigo-600 to-emerald-600 flex items-center justify-center text-white shadow-md">
                  <Shield className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-extrabold text-slate-900">All Staff Account Access Directory</h3>
                  <p className="text-xs text-slate-500 font-medium">
                    Use interface & account directly as staff. Add, remove, or modify data exactly like that staff member.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowStaffAccessModal(false)}
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition font-bold"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {staffList.length === 0 ? (
                <div className="p-8 text-center text-slate-400 font-semibold text-sm">
                  No staff accounts found.
                </div>
              ) : (
                staffList.map(st => {
                  const assignedCount = tasks.filter(t => t.Assigned_Staff === st.Staff_ID || t.Assigned_Staff_Name === st.Name).length;
                  return (
                    <div
                      key={st.Staff_ID}
                      className="p-4 rounded-2xl bg-slate-50 hover:bg-indigo-50/40 border border-slate-200/80 transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center text-base font-extrabold shadow-sm shrink-0 overflow-hidden border border-indigo-200">
                          {(st.Profile_Photo || st.Pending_Photo_Request || st.ProfilePhoto) ? (
                            <img src={st.Profile_Photo || st.Pending_Photo_Request || st.ProfilePhoto} alt={st.Name} className="w-full h-full object-cover" />
                          ) : (
                            st.Name ? st.Name.charAt(0).toUpperCase() : 'S'
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm sm:text-base font-bold text-slate-900">{st.Name}</h4>
                            <span className="px-2 py-0.5 rounded-lg bg-indigo-100 text-indigo-800 text-[10px] font-bold">
                              {st.Role || 'Staff'}
                            </span>
                            <span className="px-2 py-0.5 rounded-lg bg-slate-200 text-slate-700 text-[10px] font-bold">
                              ID: {st.Staff_ID}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">
                            📞 {st.Mobile || 'N/A'} • ✉️ {st.Email || 'N/A'}
                          </p>
                          <p className="text-[11px] font-semibold text-emerald-600 mt-1">
                            📋 Assigned Work Orders: {assignedCount} tasks
                          </p>
                        </div>
                      </div>

                      <div className="w-full sm:w-auto flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setShowStaffAccessModal(false);
                            if (startImpersonating) startImpersonating(st);
                          }}
                          className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 via-indigo-600 to-emerald-600 hover:opacity-95 text-white font-extrabold text-xs shadow-md transition flex items-center justify-center gap-2 active:scale-95"
                        >
                          <Shield className="w-4 h-4 text-white shrink-0" />
                          <span>Use Interface as {st.Name.split(' ')[0]} →</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setShowStaffAccessModal(false)}
                className="px-6 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-sm transition"
              >
                Close Directory
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLIENT EQUIPMENT MASTER MODAL */}
      {showClientEquipmentModal && (
        <ClientEquipmentModal
          isOpen={showClientEquipmentModal}
          onClose={() => {
            setShowClientEquipmentModal(false);
            setSelectedCustomerForEquipment(null);
          }}
          customer={selectedCustomerForEquipment}
          token={token}
          onSaveSuccess={loadAdminData}
        />
      )}
    </div>
  );
}
