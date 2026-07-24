import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { enqueueOfflineAction } from '../utils/offlineQueue';
import { compressImageToDataURL } from '../utils/imageCompression';
import { getAccurateGpsPosition } from '../utils/gpsHelper';
import {
  formatDateDDMMYYYY,
  formatDateWithDayName,
  formatTime24H,
  formatInteractionTimestamp,
  getLocalDateStr,
  getLocalTimeStr,
  getGoogleDirectionsUrl,
  getAvailableContacts,
  isTaskOverdueNoInteraction,
  formatDialerNumber
} from '../utils/dateUtils';
import { validatePasswordPolicy } from '../utils/passwordUtils';
import {
  Phone,
  Building2,
  CreditCard,
  Navigation,
  MapPin,
  Camera,
  Calendar,
  CheckCircle,
  Clock,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Layers,
  FileText,
  UserCheck,
  Briefcase,
  IndianRupee,
  CalendarDays,
  AlertTriangle,
  Play,
  Square,
  CheckCircle2,
  ChevronUp,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Search,
  X,
  PhoneCall,
  MessageSquare,
  MessageCircle,
  Trash2,
  PlusCircle,
  Plus,
  Activity,
  Edit3,
  LogOut,
  Filter,
  Tag as TagIcon,
  Check,
  Key
} from 'lucide-react';

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

const ROLE_LEVELS = {
  'Admin': 4,
  'ADMIN': 4,
  'Manager': 3,
  'Supervisor': 2,
  'Staff': 1,
  'Technician': 1
};

export default function StaffDashboard() {
  const navigate = useNavigate();
  const { user, realUser, token, isOnline, updateQueueCount, logout, updateUser } = useAuth();
  const isAdmin = (realUser?.Role || user?.Role) === 'Admin' || (realUser?.Role || user?.Role) === 'ADMIN';
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStage, setFilterStage] = useState(() => localStorage.getItem('expert_staff_filter_stage') || 'ALL');
  const [filterStatus, setFilterStatus] = useState(() => localStorage.getItem('expert_staff_filter_status') || 'Pending');
  const [showFilterBar, setShowFilterBar] = useState(true); // status/tag filter row auto-hides while scrolling, shows near top
  const [searchQuery, setSearchQuery] = useState('');
  const [customersList, setCustomersList] = useState([]);
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [isNewCustomerMode, setIsNewCustomerMode] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState({
    companyName: '',
    authPerson: '',
    contact: '',
    address: '',
    locationLink: '',
    contacts: [{ name: '', designation: '', contactNumber: '', email: '' }]
  });
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [showEditTaskModal, setShowEditTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [contactModal, setContactModal] = useState({ isOpen: false, mode: 'CALL', customer: null, task: null });
  const [callReceivedContactPicker, setCallReceivedContactPicker] = useState({ isOpen: false, contacts: [] });
  const [serviceReportsList, setServiceReportsList] = useState([]);
  const [equipmentMasterList, setEquipmentMasterList] = useState([]);
  const [showChangePasswordModal, setShowChangePasswordModal] = useState(false);
  const [changePasswordForm, setChangePasswordForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [changePasswordError, setChangePasswordError] = useState('');
  const [changePasswordSubmitting, setChangePasswordSubmitting] = useState(false);

  // Dynamic Task Tags (created by Admin; staff can view and toggle them on their own tasks)
  const [tags, setTags] = useState([]);
  
  // Date & User filters state
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterSelectedDates, setFilterSelectedDates] = useState([]);
  const [filterSelectedUsers, setFilterSelectedUsers] = useState([]);
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [staffList, setStaffList] = useState([]);

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

  const [taskTagPickerId, setTaskTagPickerId] = useState(null);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [activeTagFilters, setActiveTagFilters] = useState([]); // array of Tag_ID, OR-filter
  const [newTaskForm, setNewTaskForm] = useState({
    customerId: 'CUST001',
    description: '',
    scheduledDate: getLocalDateStr(),
    type: 'One-time',
    recurringPeriod: { type: 'Monthly', value: 1 },
    assignedStaff: ''
  });

  // Active Tab
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('expert_staff_active_tab') || 'TASKS'); // 'TASKS' | 'ATTENDANCE'
  const [lastNotificationTab, setLastNotificationTab] = useState(null);
  const [attendanceLogs, setAttendanceLogs] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [salaryAdvances, setSalaryAdvances] = useState([]);
  const [customerInteractions, setCustomerInteractions] = useState([]);

  const targetStaffId = user?.Staff_ID || user?.staffId || user?.id;
  const targetStaffName = user?.Name;
  const isTargetStaff = user?.Role !== 'Admin' || localStorage.getItem('expert_safety_impersonation');

  const myAttendanceLogs = useMemo(() => isTargetStaff ? attendanceLogs.filter(r => r.Staff_ID === targetStaffId) : attendanceLogs, [attendanceLogs, isTargetStaff, targetStaffId]);
  const myLeaveRequests = useMemo(() => isTargetStaff ? leaveRequests.filter(r => r.Staff_ID === targetStaffId) : leaveRequests, [leaveRequests, isTargetStaff, targetStaffId]);
  const mySalaryAdvances = useMemo(() => isTargetStaff ? salaryAdvances.filter(r => r.Staff_ID === targetStaffId) : salaryAdvances, [salaryAdvances, isTargetStaff, targetStaffId]);
  // Task remarks/conversation history are shared per-task — every staff member and admin should see
  // all remarks logged by anyone on a task, not just their own. Unlike attendance/leave/advances
  // (genuinely personal records), this must NOT be filtered down to the current staff member.
  const myCustomerInteractions = customerInteractions;

  // Attendance History Filter States
  const [attMonthFilter, setAttMonthFilter] = useState(() => localStorage.getItem('expert_staff_att_month_filter') || 'ALL');
  const [attSortOrder, setAttSortOrder] = useState('DESC'); // 'DESC' (newest first) | 'ASC' (oldest first)
  const [attStatusFilter, setAttStatusFilter] = useState(() => localStorage.getItem('expert_staff_att_status_filter') || 'ALL'); // 'ALL' | 'ON_TIME' | 'LATE'

  useEffect(() => {
    try {
      localStorage.setItem('expert_staff_filter_stage', filterStage);
      localStorage.setItem('expert_staff_filter_status', filterStatus);
      localStorage.setItem('expert_staff_active_tab', activeTab);
      localStorage.setItem('expert_staff_att_month_filter', attMonthFilter);
      localStorage.setItem('expert_staff_att_status_filter', attStatusFilter);
    } catch (e) {}
  }, [filterStage, filterStatus, activeTab, attMonthFilter, attStatusFilter]);

  const attAvailableMonths = useMemo(() => {
    const monthsSet = new Set();
    const today = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      monthsSet.add(d.toISOString().slice(0, 7));
    }
    (myAttendanceLogs || []).forEach(log => {
      if (log.Date && log.Date.length >= 7) {
        monthsSet.add(log.Date.slice(0, 7));
      }
    });
    return Array.from(monthsSet).sort().reverse();
  }, [myAttendanceLogs]);

  const formatMonthLabel = (ym) => {
    if (!ym || !ym.includes('-')) return ym;
    const [y, m] = ym.split('-');
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const filteredMyAttendanceLogs = useMemo(() => {
    return (myAttendanceLogs || [])
      .filter(log => {
        if (attMonthFilter !== 'ALL' && !String(log.Date || '').startsWith(attMonthFilter)) return false;
        const lateMins = Number(log.Late_Minutes || log.Late_By_Minutes || 0);
        if (attStatusFilter === 'ON_TIME' && lateMins > 0) return false;
        if (attStatusFilter === 'LATE' && lateMins <= 0) return false;
        return true;
      })
      .sort((a, b) => {
        const dateA = new Date(a.Date || 0).getTime();
        const dateB = new Date(b.Date || 0).getTime();
        return attSortOrder === 'ASC' ? dateA - dateB : dateB - dateA;
      });
  }, [myAttendanceLogs, attMonthFilter, attStatusFilter, attSortOrder]);

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
  const [tagSearch, setTagSearch] = useState('');
  const [showTagList, setShowTagList] = useState(true);
  const [showRemarkInputs, setShowRemarkInputs] = useState(true);
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

  const handleAddCustomTag = (e, forcePrompt = false) => {
    if (e) e.stopPropagation();
    const promptVal = (!forcePrompt && tagSearch.trim()) ? tagSearch.trim() : window.prompt('Enter new custom tag name (e.g., Follow-up Call, Site Inspection):');
    if (promptVal && promptVal.trim()) {
      const cleanTag = promptVal.trim();
      const updatedCustom = Array.from(new Set([...customRemarkTags, cleanTag]));
      setCustomRemarkTags(updatedCustom);
      try {
        localStorage.setItem('expert_safety_custom_remark_tags', JSON.stringify(updatedCustom));
      } catch { }
      setRemarkForm({ ...remarkForm, type: cleanTag });
      setShowTagList(false);
      setTagSearch('');
    }
  };

  const handleDeleteCustomTag = (e, tagToDelete) => {
    if (e) e.stopPropagation();
    const updatedCustom = customRemarkTags.filter(t => t !== tagToDelete);
    setCustomRemarkTags(updatedCustom);
    try {
      localStorage.setItem('expert_safety_custom_remark_tags', JSON.stringify(updatedCustom));
    } catch { }
    if (remarkForm.type === tagToDelete) {
      setRemarkForm({ ...remarkForm, type: '' });
    }
  };
  const [editingInteractionId, setEditingInteractionId] = useState(null);
  const [editingRemarkText, setEditingRemarkText] = useState('');
  const [submittingRemark, setSubmittingRemark] = useState(false);
  const [punching, setPunching] = useState(false);
  const [showPunchOutConfirmModal, setShowPunchOutConfirmModal] = useState(false);
  const [showProfilePopup, setShowProfilePopup] = useState(false);
  const [leaveSubmitting, setLeaveSubmitting] = useState(false);

  // Edit Customer modal state (shared with admin-style editing)
  const [showEditCustomerModal, setShowEditCustomerModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [editCustomerForm, setEditCustomerForm] = useState({
    companyName: '', authPerson: '', contact: '', email: '',
    locationLink: '', address: '', specialNotes: '', coordinators: []
  });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [isEditCustomerGpsUnlocked, setIsEditCustomerGpsUnlocked] = useState(false);
  const [isNewCustomerGpsUnlocked, setIsNewCustomerGpsUnlocked] = useState(false);
  const [isEditCustomerNotesUnlocked, setIsEditCustomerNotesUnlocked] = useState(false);

  // Task Expand & Up-Down Drag-and-Drop Route sequence ordering state
  const [expandedTaskIds, setExpandedTaskIds] = useState({});
  const [expandedRemarkTaskIds, setExpandedRemarkTaskIds] = useState({});
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverTaskId, setDragOverTaskId] = useState(null);
  const [reorderingTaskId, setReorderingTaskId] = useState(null);

  // Intercept back button to close modals instead of exiting/closing the app
  useEffect(() => {
    const isAnyModalOpen = showNewTaskModal || 
                           showEditTaskModal || 
                           showRemarksModal || 
                           showEditCustomerModal || 
                           (contactModal && contactModal.isOpen) || 
                           showPunchOutConfirmModal || 
                           showProfilePopup || 
                           showChangePasswordModal ||
                           showFilterModal ||
                           showCompanyDetailsModal ||
                           showICardModal ||
                           Boolean(zoomedImage);

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
          setShowNewTaskModal(false);
          setShowEditTaskModal(false);
          setShowRemarksModal(false);
          setShowEditCustomerModal(false);
          if (contactModal) setContactModal(prev => ({ ...prev, isOpen: false }));
          setShowPunchOutConfirmModal(false);
          setShowProfilePopup(false);
          setShowChangePasswordModal(false);
          setShowFilterModal(false);
          setShowCompanyDetailsModal(false);
          setShowICardModal(false);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [
    showNewTaskModal,
    showEditTaskModal,
    showRemarksModal,
    showEditCustomerModal,
    contactModal,
    showPunchOutConfirmModal,
    showProfilePopup,
    showChangePasswordModal,
    showFilterModal,
    showCompanyDetailsModal,
    showICardModal,
    zoomedImage
  ]);

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

  // ── Continuous auto-scroll during drag ──────────────────────────────────────
  // Starts a requestAnimationFrame loop when the pointer is within the scroll
  // zone at the top or bottom of the viewport. The scroll speed is proportional
  // to how deep into the zone the pointer is (max 18 px/frame ≈ smooth 1080px/s).
  const SCROLL_ZONE = 120;  // px from viewport edge that triggers scrolling
  const MAX_SPEED   = 18;   // px per animation frame at zone edge

  const stopAutoScroll = () => {
    if (autoScrollRef.current) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = null;
    }
  };

  // clientYRef keeps the latest pointer position so the RAF loop always uses the current value.
  const clientYRef = useRef(null);

  const startAutoScrollLoop = () => {
    // Prevent multiple loops running in parallel
    if (autoScrollRef.current) return;
    const tick = () => {
      const y = clientYRef.current;
      if (y === null) { autoScrollRef.current = null; return; }
      let delta = 0;
      if (y < SCROLL_ZONE) {
        // Proportional speed: deeper into zone → faster scroll
        delta = -Math.round(MAX_SPEED * (1 - y / SCROLL_ZONE));
      } else if (y > window.innerHeight - SCROLL_ZONE) {
        delta = Math.round(MAX_SPEED * (1 - (window.innerHeight - y) / SCROLL_ZONE));
      }
      if (delta !== 0) {
        window.scrollBy({ top: delta, behavior: 'instant' });
        autoScrollRef.current = requestAnimationFrame(tick);
      } else {
        // Out of scroll zone — stop loop until pointer re-enters zone
        autoScrollRef.current = null;
      }
    };
    autoScrollRef.current = requestAnimationFrame(tick);
  };

  const handleAutoScroll = (clientY) => {
    if (clientY === undefined || clientY === null) return;
    clientYRef.current = clientY;
    if (clientY < SCROLL_ZONE || clientY > window.innerHeight - SCROLL_ZONE) {
      startAutoScrollLoop();
    } else {
      stopAutoScroll();
    }
  };

  // Track pointer position at the document level while dragging — the app's sticky
  // top navbar (z-40) has no drag/touch handlers, so once the pointer crosses under it
  // the per-row dragover/touchmove events stop firing entirely, freezing clientYRef and
  // breaking upward auto-scroll near the top edge (downward works fine since nothing
  // fixed covers the bottom of the page).
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
  // ─────────────────────────────────────────────────────────────────────────────

  // Close the per-task tag picker popover when clicking anywhere else
  useEffect(() => {
    if (!taskTagPickerId) return;
    const onDocClick = (e) => {
      const dropdown = document.getElementById(`tag-picker-${taskTagPickerId}`);
      const btn = document.getElementById(`tag-btn-${taskTagPickerId}`);
      if (dropdown && dropdown.contains(e.target)) return;
      if (btn && btn.contains(e.target)) return;
      setTaskTagPickerId(null);
    };
    document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('click', onDocClick);
    };
  }, [taskTagPickerId]);

  // Auto-hide the status/tag filter row while scrolling to free up screen space on mobile;
  // it reappears once the user scrolls back near the top of the page (or on a fresh load).
  // Hysteresis is used to prevent scroll-recalculation feedback loops and flickering/blinking.
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const sy = window.scrollY;
        setShowFilterBar((prev) => {
          if (prev && sy > 120) {
            return false;
          }
          if (!prev && sy < 40) {
            return true;
          }
          return prev;
        });
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const ORDER_KEY = `expert_safety_task_sequence_order_${user?.Staff_ID || 'default'}`;

  const sortTasksByOrder = (taskList) => {
    if (!Array.isArray(taskList)) return taskList;
    try {
      let orderArr = null;
      const rawOrder = localStorage.getItem(ORDER_KEY);
      if (rawOrder) {
        orderArr = JSON.parse(rawOrder);
      }
      if ((!orderArr || orderArr.length === 0) && user?.Task_Order) {
        orderArr = user.Task_Order;
      }
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
      
      if (navigator.onLine && token && user?.Staff_ID) {
        await fetch(`/api/staff/${user.Staff_ID}/task-order`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ taskOrder: orderArr })
        });
      }
    } catch { }
  };

  const handleDropTask = (fromTaskId, toTaskId) => {
    stopAutoScroll();
    clientYRef.current = null;
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

  const handleMoveTaskOrder = (taskId, direction, currentList = tasks) => {
    if (!currentList || !Array.isArray(currentList)) return;
    const listIdx = currentList.findIndex(t => t.Task_ID === taskId);
    if (listIdx === -1) return;
    const targetListIdx = listIdx + direction;
    if (targetListIdx < 0 || targetListIdx >= currentList.length) return;

    const targetTaskId = currentList[targetListIdx].Task_ID;
    handleDropTask(taskId, targetTaskId);
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
      await fetchAttendanceAndLeaves();
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
      setCustomersList(prev => prev.map(c => (c.Customer_ID === customerObj?.Customer_ID || c.Company_Name === customerObj?.Company_Name) ? { ...c, Location_Link: gpsUrl } : c));
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
      alert(`❌ ${err.message || 'Failed to get accurate GPS location. Please turn on High-Accuracy GPS on your mobile device.'}`);
    } finally {
      setFetchingLocationFor(null);
    }
  };

  // Leave Form state
  const [leaveForm, setLeaveForm] = useState({
    leaveDate: '',
    leaveType: 'Full Day',
    startTime: '10:00',
    endTime: '12:00',
    isUrgent: false,
    reason: ''
  });
  const [leaveError, setLeaveError] = useState('');

  const handleUpdateStatus = async (taskId, newStatus) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) throw new Error('Failed to update status');
      fetchTasks();
    } catch (err) {
      alert(err.message);
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

  // Opens the Discussion Log modal pre-tagged as 'Call'/'WhatsApp' with a prefilled title line,
  // and expands the task's remark history so it's visible right away — staff just add
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
      const custObj = customersList.find(c => String(c.Customer_ID || '').trim().toLowerCase() === String(remarkTask?.Customer_ID || '').trim().toLowerCase()) || {};
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

  const handlePhoneButtonClick = (custObj, task) => {
    const contacts = getAvailableContacts(custObj, task);
    if (contacts.length === 0) {
      alert('No contact number found for this customer');
      return;
    }
    if (contacts.length === 1) {
      if (task) triggerQuickInteraction('Call', task, contacts[0].name);
      window.location.href = `tel:${formatDialerNumber(contacts[0].cleanPhone)}`;
      return;
    }
    setContactModal({ isOpen: true, mode: 'CALL', customer: custObj, task });
  };

  // Modal states
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeModal, setActiveModal] = useState(null); // 'ADVANCE' | 'RESCHEDULE' | 'LOG'
  const [actionForm, setActionForm] = useState({
    actionTaken: '',
    remarks: '',
    imageUrl: '',
    latLong: '19.0760, 72.8777' // Mock GPS
  });
  const [targetStage, setTargetStage] = useState('');
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState('');
  const [capturedLocation, setCapturedLocation] = useState('');
  const [locating, setLocating] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [newDate, setNewDate] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [compressingPhoto, setCompressingPhoto] = useState(false);

  const lastSyncRef = useRef(0);
  const autoScrollRef = useRef(null); // RAF handle for continuous auto-scroll during drag

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

  const syncAllData = async (silent = false) => {
    const isSilent = typeof silent === 'boolean' ? silent : false;
    try {
      if (!isSilent) setLoading(true);
      const res = await fetch('/api/sync/all', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const cList = data.customers || customersList;
        if (data.customers) setCustomersList(cList);
        if (data.attendance) setAttendanceLogs(data.attendance);
        if (data.leaves) setLeaveRequests(data.leaves);
        if (data.advances) setSalaryAdvances(data.advances);
        if (data.customerInteractions) setCustomerInteractions(data.customerInteractions);
        if (data.serviceReports) setServiceReportsList(data.serviceReports);
        if (data.equipmentMaster) setEquipmentMasterList(data.equipmentMaster);
        if (data.tags) setTags(data.tags);
        if (data.tasks) {
          const enriched = enrichTasksWithCustomers(data.tasks, cList);
          setTasks(sortTasksByOrder(enriched));
        }
        lastSyncRef.current = Date.now();
        try {
          localStorage.setItem('expert_staff_sync_cache_v1', JSON.stringify({
            tasks: data.tasks,
            attendance: data.attendance,
            leaves: data.leaves,
            advances: data.advances,
            customerInteractions: data.customerInteractions,
            customers: data.customers,
            timestamp: Date.now()
          }));
        } catch (e) {}
      } else {
        await Promise.all([fetchTasksSeparate(isSilent), fetchAttendanceSeparate()]);
      }
    } catch (err) {
      console.error('Sync failed:', err);
      if (!isSilent) await Promise.all([fetchTasksSeparate(isSilent), fetchAttendanceSeparate()]);
    } finally {
      if (!isSilent) setLoading(false);
    }
  };

  const fetchTasksSeparate = async (silent = false) => {
    try {
      const res = await fetch('/api/tasks?all=true', { headers: { 'Authorization': `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        const enriched = enrichTasksWithCustomers(data, customersList);
        setTasks(sortTasksByOrder(enriched));
      }
    } catch (err) { console.error(err); }
    try {
      const resTags = await fetch('/api/tags', { headers: { 'Authorization': `Bearer ${token}` } });
      if (resTags.ok) setTags(await resTags.json());
    } catch (err) { console.error(err); }
    try {
      const resStaff = await fetch('/api/staff', { headers: { 'Authorization': `Bearer ${token}` } });
      if (resStaff.ok) setStaffList(await resStaff.json());
    } catch (err) { console.error(err); }
  };

  const fetchAttendanceSeparate = async () => {
    try {
      const [resAtt, resLev, resAdv, resInt, resCust] = await Promise.all([
        fetch('/api/attendance', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/leaves', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/advances', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/customer-interactions', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/customers', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);
      if (resAtt.ok) setAttendanceLogs(await resAtt.json());
      if (resLev.ok) setLeaveRequests(await resLev.json());
      if (resAdv.ok) setSalaryAdvances(await resAdv.json());
      if (resInt.ok) setCustomerInteractions(await resInt.json());
      if (resCust.ok) setCustomersList(await resCust.json());
    } catch (err) { console.error(err); }
  };

  const fetchTasks = async (silent = false) => {
    await syncAllData(typeof silent === 'boolean' ? silent : false);
  };

  const fetchAttendanceAndLeaves = async () => {
    await syncAllData(true);
  };

  useEffect(() => {
    // 1. Instant Zero-Time Load from Cache
    try {
      const cached = localStorage.getItem('expert_staff_sync_cache_v1');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.tasks) {
          const cList = parsed.customers || customersList;
          if (parsed.customers) setCustomersList(cList);
          if (parsed.attendance) setAttendanceLogs(parsed.attendance);
          if (parsed.leaves) setLeaveRequests(parsed.leaves);
          if (parsed.advances) setSalaryAdvances(parsed.advances);
          if (parsed.customerInteractions) setCustomerInteractions(parsed.customerInteractions);
          const enriched = enrichTasksWithCustomers(parsed.tasks || [], cList);
          setTasks(sortTasksByOrder(enriched));
          setLoading(false);
        }
      }
    } catch (e) {}

    // 2. Immediate Background Revalidation
    syncAllData(true);

    // 3. Focus & Visibility Auto-Sync (Instant Reflection when Desktop feeds data)
    const handleFocusSync = () => {
      const now = Date.now();
      if (now - lastSyncRef.current > 3000) {
        syncAllData(true);
      }
    };
    window.addEventListener('focus', handleFocusSync);
    const handleVis = () => { if (document.visibilityState === 'visible') handleFocusSync(); };
    document.addEventListener('visibilitychange', handleVis);

    // 4. Background polling — kept lighter on mobile since focus/visibility handlers above
    // already trigger an instant sync the moment the user actually looks at the screen.
    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        syncAllData(true);
      }
    }, 20000);

    const handleOpenProfile = () => setShowProfilePopup(true);
    const handleNavbarPunchIn = () => handlePunchIn();
    const handleNavbarPunchOut = () => setShowPunchOutConfirmModal(true);
    window.addEventListener('OPEN_STAFF_PROFILE_POPUP', handleOpenProfile);
    window.addEventListener('NAVBAR_PUNCH_IN', handleNavbarPunchIn);
    window.addEventListener('NAVBAR_PUNCH_OUT', handleNavbarPunchOut);
    return () => {
      window.removeEventListener('focus', handleFocusSync);
      document.removeEventListener('visibilitychange', handleVis);
      clearInterval(pollInterval);
      window.removeEventListener('OPEN_STAFF_PROFILE_POPUP', handleOpenProfile);
      window.removeEventListener('NAVBAR_PUNCH_IN', handleNavbarPunchIn);
      window.removeEventListener('NAVBAR_PUNCH_OUT', handleNavbarPunchOut);
    };
  }, [token]);

  useEffect(() => {
    const handleNav = (e) => {
      const n = e.detail;
      if (!n) return;
      setLastNotificationTab(activeTab || 'TASKS');
      if (n.targetType === 'TASK') {
        setActiveTab('TASKS');
        const found = tasks.find(t => t.Task_ID === n.targetId);
        if (found) {
          openModal(found, 'STATUS');
        }
        setTimeout(() => {
          const card = document.getElementById(`task-card-${n.targetId}`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      } else if (n.targetType === 'LEAVE') {
        setActiveTab('ATTENDANCE');
      } else if (n.targetType === 'STAFF') {
        setShowProfilePopup(true);
      }
    };
    window.addEventListener('NAVIGATE_TO_TARGET', handleNav);
    return () => window.removeEventListener('NAVIGATE_TO_TARGET', handleNav);
  }, [activeTab, tasks]);

  const handleSmartCreateTask = async (e) => {
    e.preventDefault();
    try {
      let targetCustomerId = selectedCustomer?.Customer_ID;

      if (isNewCustomerMode) {
        if (!newCustomerForm.companyName.trim()) {
          alert('Please enter Company Name');
          return;
        }
        const custRes = await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            companyName: newCustomerForm.companyName,
            authPerson: newCustomerForm.authPerson,
            contact: newCustomerForm.contact,
            locationLink: newCustomerForm.locationLink,
            address: newCustomerForm.address,
            contacts: newCustomerForm.contacts
          })
        });
        if (!custRes.ok) throw new Error('Failed to save new customer to database');
        const createdCust = await custRes.json();
        targetCustomerId = createdCust.Customer_ID;
      } else if (!targetCustomerId) {
        alert('Please search and select a company from database OR click "+ New Customer? Add to Database"');
        return;
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          customerId: targetCustomerId,
          description: newTaskForm.description || 'Fire Safety Maintenance & Inspection',
          scheduledDate: newTaskForm.scheduledDate,
          type: newTaskForm.type,
          stage: 'New Inquiry',
          assignedStaff: newTaskForm.assignedStaff || user.staffId || user.Staff_ID || 'STAFF002',
          recurringPeriod: newTaskForm.type === 'Recurring' ? newTaskForm.recurringPeriod : undefined
        })
      });
      if (!res.ok) throw new Error('Failed to create task');

      setShowNewTaskModal(false);
      setSelectedCustomer(null);
      setIsNewCustomerMode(false);
      setCustomerSearchQuery('');
      setNewCustomerForm({ companyName: '', authPerson: '', contact: '', address: '', locationLink: '', contacts: [{ name: '', designation: '', contactNumber: '', email: '' }] });
      setNewTaskForm({ customerId: 'CUST001', description: '', scheduledDate: getLocalDateStr(), type: 'One-time', recurringPeriod: { type: 'Monthly', value: 1 } });
      fetchTasks();
    } catch (err) {
      alert(err.message);
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
          stage: editingTask.Stage,
          assignedStaff: editingTask.Assigned_Staff
        })
      });
      if (!res.ok) throw new Error('Failed to update task');
      setShowEditTaskModal(false);
      setEditingTask(null);
      fetchTasks();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDeleteTask = async (taskId, desc) => {
    if (!window.confirm(`Request Admin permission to remove task: "${desc}"?\n\nTask will be permanently removed from staff panel once Admin confirms.`)) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}/request-removal`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ reason: `Removal requested by staff for task: ${desc}` })
      });
      if (!res.ok) throw new Error('Failed to request task removal');
      alert('Removal request sent to Admin! Task will be removed from staff panel once Admin confirms.');
      fetchTasks();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReactivateTask = async (task) => {
    const todayStr = getLocalDateStr();
    try {
      const res = await fetch(`/api/tasks/${task.Task_ID}/reactivate`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          newScheduledDate: todayStr,
          remarks: 'Reactivated closed task for new field service requirement'
        })
      });
      if (!res.ok) throw new Error('Failed to reactivate task');
      fetchTasks();
    } catch (err) {
      alert(err.message);
    }
  };

  const handlePunchIn = async () => {
    try {
      setPunching(true);
      let coords = capturedLocation;
      try {
        const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 300 });
        coords = pos.formatted;
        setCapturedLocation(coords);
      } catch (gpsErr) {
        setPunching(false);
        alert(`⚠️ High-Accuracy GPS Required!\n\n${gpsErr.message || 'Your mobile GPS is turned OFF or signal is weak.'}\n\nPlease turn ON High-Accuracy GPS / Location services on your device and try Punch In again.`);
        return;
      }

      let clientIp = '';
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
        if (ipRes.ok) {
          const ipData = await ipRes.json();
          clientIp = ipData.ip;
        }
      } catch (e) { }
      const now = new Date();
      const overrideDate = getLocalDateStr(now);
      const overrideTime = getLocalTimeStr(now);
      const res = await fetch('/api/attendance/punch-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ latLong: coords, ipAddress: clientIp, overrideDate, overrideTime })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Punch in failed');
      await fetchAttendanceAndLeaves();
      window.dispatchEvent(new CustomEvent('ATTENDANCE_REFRESHED', { detail: data.log }));
    } catch (err) {
      alert(err.message);
    } finally {
      setPunching(false);
    }
  };

  const handlePunchOut = async () => {
    try {
      setPunching(true);
      let coords = capturedLocation;
      try {
        const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 300 });
        coords = pos.formatted;
        setCapturedLocation(coords);
      } catch (gpsErr) {
        setPunching(false);
        alert(`⚠️ High-Accuracy GPS Required!\n\n${gpsErr.message || 'Your mobile GPS is turned OFF or signal is weak.'}\n\nPlease turn ON High-Accuracy GPS / Location services on your device and try Punch Out again.`);
        return;
      }

      let clientIp = '';
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
        if (ipRes.ok) {
          const ipData = await ipRes.json();
          clientIp = ipData.ip;
        }
      } catch (e) { }
      const now = new Date();
      const overrideDate = getLocalDateStr(now);
      const overrideTime = getLocalTimeStr(now);
      const res = await fetch('/api/attendance/punch-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ latLong: coords, ipAddress: clientIp, overrideDate, overrideTime })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Punch out failed');
      await fetchAttendanceAndLeaves();
      window.dispatchEvent(new CustomEvent('ATTENDANCE_REFRESHED', { detail: null }));
    } catch (err) {
      alert(err.message);
    } finally {
      setPunching(false);
    }
  };

  const handleLeaveSubmit = async (e) => {
    e.preventDefault();
    setLeaveError('');
    if (!leaveForm.leaveDate) {
      setLeaveError('Please select a leave date.');
      return;
    }
    // Dynamic 7-day rule check on client
    if (!leaveForm.isUrgent) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const reqDate = new Date(leaveForm.leaveDate);
      reqDate.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((reqDate - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 7) {
        setLeaveError('Standard leave requests require at least 7 days advance notice. Check "Urgent Leave" to bypass this restriction for emergencies.');
        return;
      }
    }
    try {
      setLeaveSubmitting(true);
      const formattedType = leaveForm.leaveType === 'Short Leave'
        ? `Short Leave (${leaveForm.startTime} - ${leaveForm.endTime})`
        : leaveForm.leaveType;

      const res = await fetch('/api/leaves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...leaveForm, leaveType: formattedType })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Leave request submission failed');
      setLeaveForm({ leaveDate: '', leaveType: 'Full Day', startTime: '10:00', endTime: '12:00', isUrgent: false, reason: '' });
      await fetchAttendanceAndLeaves();
    } catch (err) {
      setLeaveError(err.message);
    } finally {
      setLeaveSubmitting(false);
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
      if (!res.ok) throw new Error('Failed to save remark');
      setRemarkForm({ type: '', remarks: '' });
      setShowTagList(true);
      setShowRemarkInputs(false);
      await fetchAttendanceAndLeaves();
    } catch (err) {
      alert(err.message);
    } finally {
      setSubmittingRemark(false);
    }
  };

  const isRemarkWithin5Minutes = (item) => {
    if (!item) return false;
    if (item.Created_At) {
      return (Date.now() - Number(item.Created_At)) <= 5 * 60 * 1000;
    }
    if (item.Interaction_ID && item.Interaction_ID.startsWith('INT_')) {
      const ts = Number(item.Interaction_ID.split('_')[1]);
      if (!isNaN(ts) && ts > 0) {
        return (Date.now() - ts) <= 5 * 60 * 1000;
      }
    }
    return false;
  };

  const canEditRemark = (item) => {
    if (!item) return false;
    const isAuthor = item.Staff_ID === user?.Staff_ID || item.Staff_Name === user?.Name || user?.Role === 'Admin';
    return isAuthor && isRemarkWithin5Minutes(item);
  };

  const handleUpdateRemarkSubmit = async (interactionId) => {
    if (!editingRemarkText.trim()) return;
    try {
      const res = await fetch(`/api/customer-interactions/${interactionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ remarks: editingRemarkText })
      });
      if (res.ok) {
        setEditingInteractionId(null);
        await fetchAttendanceAndLeaves();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Capture Geolocation Lat/Long
  // Capture Geolocation Lat/Long with high accuracy enforcement
  const captureGeolocation = async () => {
    setLocating(true);
    try {
      const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 250 });
      setCapturedLocation(pos.formatted);
      alert(`✅ Accurate GPS captured: ${pos.formatted} (Accuracy: ~${pos.accuracy}m)`);
    } catch (err) {
      alert(`⚠️ High-Accuracy GPS Required!\n\n${err.message || 'Failed to get GPS coordinates.'}\n\nPlease turn on mobile GPS services and try capturing again.`);
    } finally {
      setLocating(false);
    }
  };

  // Handle Photo input & compression
  const handlePhotoSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setCompressingPhoto(true);
      const compressedBase64 = await compressImageToDataURL(file, 800, 180000);
      setPhotoDataUrl(compressedBase64);
    } catch (err) {
      alert('Image compression failed.');
    } finally {
      setCompressingPhoto(false);
    }
  };

  // Advance Stage Submit
  // Advance Stage Submit
  const handleAdvanceStage = async (e) => {
    e.preventDefault();
    if (!selectedTask) return;
    setSubmitting(true);
    setFeedbackMsg('');

    let coords = capturedLocation;
    if (!coords || coords === '0.0000, 0.0000') {
      try {
        const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 300 });
        coords = pos.formatted;
        setCapturedLocation(coords);
      } catch (gpsErr) {
        setSubmitting(false);
        alert(`⚠️ High-Accuracy GPS Required!\n\n${gpsErr.message || 'Please turn ON mobile GPS to record your location.'}`);
        return;
      }
    }

    const payload = {
      taskId: selectedTask.Task_ID,
      latLong: coords || '0.0000, 0.0000',
      remarks: remarks || `Advanced stage for ${selectedTask.Task_ID}`,
      imageUrl: photoDataUrl
    };

    if (isOnline) {
      try {
        const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/stage`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Stage advancement failed');
        const data = await res.json();
        const newStageName = (data && data.updatedTask && (data.updatedTask.Stage || data.updatedTask.stage)) || (data && data.Stage) || 'Next Stage';
        setFeedbackMsg(`Stage advanced to "${newStageName}"!`);
        fetchTasks();
        closeModal();
      } catch (err) {
        setFeedbackMsg(err.message);
      } finally {
        setSubmitting(false);
      }
    } else {
      // Offline mode -> store in IndexedDB
      await enqueueOfflineAction('ADVANCE_STAGE', payload);
      await updateQueueCount();
      // Optimistic update locally
      setTasks(prev => prev.map(t => t.Task_ID === selectedTask.Task_ID ? { ...t, Stage: 'Advancing (Queued Offline)' } : t));
      closeModal();
      setSubmitting(false);
    }
  };

  // Reschedule Submit
  const handleReschedule = async (e) => {
    e.preventDefault();
    if (!remarks || remarks.trim() === '') {
      alert('Mandatory manual remarks are required when rescheduling.');
      return;
    }
    setSubmitting(true);

    let coords = capturedLocation;
    if (!coords || coords === '0.0000, 0.0000') {
      try {
        const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 300 });
        coords = pos.formatted;
        setCapturedLocation(coords);
      } catch (gpsErr) {
        setSubmitting(false);
        alert(`⚠️ High-Accuracy GPS Required!\n\n${gpsErr.message || 'Please turn ON mobile GPS to record your location.'}`);
        return;
      }
    }

    const payload = {
      taskId: selectedTask.Task_ID,
      newScheduledDate: newDate,
      remarks,
      latLong: coords || '0.0000, 0.0000'
    };

    if (isOnline) {
      try {
        const res = await fetch(`/api/tasks/${selectedTask.Task_ID}/reschedule`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Rescheduling failed');
        fetchTasks();
        closeModal();
      } catch (err) {
        alert(err.message);
      } finally {
        setSubmitting(false);
      }
    } else {
      await enqueueOfflineAction('RESCHEDULE', payload);
      await updateQueueCount();
      setTasks(prev => prev.map(t => t.Task_ID === selectedTask.Task_ID ? { ...t, Scheduled_Date: `${newDate} (Queued)` } : t));
      closeModal();
      setSubmitting(false);
    }
  };

  // Submit Field Activity Log
  const handleActivityLog = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    let coords = capturedLocation;
    if (!coords || coords === '0.0000, 0.0000') {
      try {
        const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 300 });
        coords = pos.formatted;
        setCapturedLocation(coords);
      } catch (gpsErr) {
        setSubmitting(false);
        alert(`⚠️ High-Accuracy GPS Required!\n\n${gpsErr.message || 'Please turn ON mobile GPS to record your location.'}`);
        return;
      }
    }

    const payload = {
      taskId: selectedTask?.Task_ID || 'GENERAL',
      actionTaken: actionTaken || 'Field Check-in',
      latLong: coords || '0.0000, 0.0000',
      remarks,
      imageUrl: photoDataUrl
    };

    if (isOnline) {
      try {
        const res = await fetch('/api/logs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Failed to save log');
        closeModal();
      } catch (err) {
        alert(err.message);
      } finally {
        setSubmitting(false);
      }
    } else {
      await enqueueOfflineAction('ACTIVITY_LOG', payload);
      await updateQueueCount();
      closeModal();
      setSubmitting(false);
    }
  };

  const openModal = (task, type) => {
    setSelectedTask(task);
    setActiveModal(type);
    setRemarks('');
    setNewDate(task?.Scheduled_Date || getLocalDateStr());
    setActionTaken('');
    setPhotoDataUrl('');
    setCapturedLocation('');
    captureGeolocation();
  };

  const closeModal = () => {
    setActiveModal(null);
    setSelectedTask(null);
    if (lastNotificationTab && lastNotificationTab !== activeTab) {
      setActiveTab(lastNotificationTab);
      setLastNotificationTab(null);
    }
  };

  // Memoized so this scan only re-runs when one of its actual inputs changes, instead of on
  // every render of this component (e.g. every 20s poll tick or unrelated state toggle).
  const filteredTasks = useMemo(() => tasks.filter(t => {
    const targetStaffId = user?.Staff_ID || user?.staffId || user?.id;
    const targetStaffName = user?.Name;
    
    // User Filter: Created_By
    if (filterSelectedUsers.length > 0) {
      const creator = t.Created_By || t.Assigned_Staff || 'Unknown';
      if (!filterSelectedUsers.includes(creator)) return false;
    } else {
      // Apply default visibility rules
      const userRole = user?.Role || 'Staff';
      const userPerms = user?.Permissions || '';
      
      const hasTaskVisibility = (task) => {
        // Admin has full access
        if (['Admin', 'ADMIN'].includes(userRole) && !localStorage.getItem('expert_safety_impersonation')) {
          return true;
        }
        // Full Access / All Tasks scope sees all tasks
        if (userPerms === 'FULL_ACCESS' || userPerms === 'ALL_TASKS') {
          return true;
        }

        // Direct assignee sees it
        const assignedToId = task.Assigned_Staff;
        if (assignedToId === targetStaffId || assignedToId === targetStaffName) {
          return true;
        }

        // Creator / Assigner sees it
        const createdById = task.Created_By;
        if (createdById === targetStaffId || createdById === targetStaffName) {
          return true;
        }

        // Superior role level check:
        // If the task is assigned to someone whose role level is LESS THAN the logged-in user's role level
        const assignedStaffObj = staffList.find(s => s.Staff_ID === assignedToId || s.Name === assignedToId);
        if (assignedStaffObj) {
          const userLevel = ROLE_LEVELS[userRole] || 1;
          const targetLevel = ROLE_LEVELS[assignedStaffObj.Role] || 1;
          if (userLevel > targetLevel) {
            return true;
          }
        }

        return false;
      };

      if (!hasTaskVisibility(t)) return false;
    }

    if (filterStage !== 'ALL' && t.Stage !== filterStage) return false;
    if (filterStatus !== 'ALL' && t.Status !== filterStatus) return false;

    // Date Filters:
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

    if (activeTagFilters.length > 0) {
      const taskTags = Array.isArray(t.Tags) ? t.Tags : [];
      if (!activeTagFilters.some(id => taskTags.includes(id))) return false;
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase().trim();
      const matchesId = t.Task_ID?.toLowerCase().includes(q);
      const matchesCustomer = t.Customer_Name?.toLowerCase().includes(q);
      const matchesDesc = t.Description?.toLowerCase().includes(q);
      const matchesType = t.Type?.toLowerCase().includes(q);
      const matchesMobile = (t.Customer_Contact || t.Contact || '')?.toLowerCase().includes(q);
      const matchesPerson = (t.Customer_Auth_Person || t.Auth_Person || '')?.toLowerCase().includes(q);
      const matchesAddress = (t.Customer_Address || t.Address || '')?.toLowerCase().includes(q);
      return matchesId || matchesCustomer || matchesDesc || matchesType || matchesMobile || matchesPerson || matchesAddress;
    }
    return true;
  }), [tasks, user, staffList, filterSelectedUsers, filterStage, filterStatus, filterSelectedDates, filterStartDate, filterEndDate, activeTagFilters, searchQuery]);

  const { todayTasks, tomorrowTasks, upcomingTasks } = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayList = [];
    const tomorrowList = [];
    const upcomingList = [];

    filteredTasks.forEach(t => {
      const dateStr = t.Scheduled_Date || t.Date;
      if (!dateStr) {
        todayList.push(t);
        return;
      }
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) {
        todayList.push(t);
        return;
      }
      d.setHours(0, 0, 0, 0);

      if (d.getTime() <= today.getTime()) {
        todayList.push(t);
      } else if (d.getTime() === tomorrow.getTime()) {
        tomorrowList.push(t);
      } else {
        upcomingList.push(t);
      }
    });

    return { todayTasks: todayList, tomorrowTasks: tomorrowList, upcomingTasks: upcomingList };
  })();

  const taskTapTrackerRef = useRef({});

  const renderTaskCard = (task, idx, currentList = tasks) => {
    const custObj = customersList.find(c => c.Customer_ID === task.Customer_ID || c.Company_Name === task.Customer_Name) || {};
    const availableContacts = getAvailableContacts(custObj, task);
    const hasContacts = availableContacts.length > 0;
    const hasLocation = Boolean(task.Customer_Location_Link || custObj.Location_Link || custObj.Google_Location);
    const isExpanded = !!expandedTaskIds[task.Task_ID];
    const mapUrl = getGoogleDirectionsUrl(
      task.Customer_Location_Link || custObj.Location_Link,
      task.Customer_Address || custObj.Address,
      task.Customer_Name || custObj.Company_Name
    );
    const isCompleted = task.Status === 'Completed' || task.Status === 'Closed';
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
        id={`task-card-${task.Task_ID}`}
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
          clientYRef.current = null;
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
        className={`rounded-none border shadow-sm transition overflow-visible ${draggedTaskId === task.Task_ID
          ? 'border-indigo-500 bg-indigo-50/40 opacity-50 scale-[0.98]'
          : dragOverTaskId === task.Task_ID
            ? 'border-2 border-indigo-600 bg-indigo-50/80 shadow-md scale-[1.01]'
            : isOverdueNoAction
              ? 'border-rose-300 bg-rose-100'
              : 'bg-white border-slate-200/90 hover:border-slate-300'
          }`}
        title={isOverdueNoAction ? 'No interaction logged within 2 days of the scheduled date — this task is overdue' : undefined}
      >
        <div className="flex flex-col gap-2 p-3">
          {/* Top Line: Company Name + Status Badges + 6-dots drag/sequence buttons on right */}
          <div className="flex items-center justify-between gap-2">
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
                  : (customersList.find(c => String(c.Customer_ID || '').trim().toLowerCase() === String(task.Customer_ID || '').trim().toLowerCase())?.Company_Name || task.Customer_Name || (task.Customer_ID ? `Customer (${task.Customer_ID})` : 'General Client'))}
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
              {!hasContacts && (
                <>
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
                </>
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
              {isCompleted && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                  Closed / Completed
                </span>
              )}
              {task.Status === 'Removal Requested' && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                  ⏳ Removal Requested
                </span>
              )}
              {!isCompleted && task.Status !== 'Removal Requested' && (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${task.Status === 'In Progress'
                  ? 'bg-amber-100 text-amber-900'
                  : task.Status === 'Started'
                    ? 'bg-sky-100 text-sky-800'
                    : 'bg-slate-100 text-slate-600'
                  }`}>
                  {task.Status || 'Pending'}
                </span>
              )}
            </div>

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
                  } catch { }
                }
              }}
              onDragEnd={() => {
                stopAutoScroll();
                clientYRef.current = null;
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
                stopAutoScroll();
                clientYRef.current = null;
                if (draggedTaskId && dragOverTaskId && draggedTaskId !== dragOverTaskId) {
                  handleDropTask(draggedTaskId, dragOverTaskId);
                } else {
                  setDraggedTaskId(null);
                  setDragOverTaskId(null);
                }
              }}
              onClick={(e) => {
                e.stopPropagation();
                setReorderingTaskId(prev => prev === task.Task_ID ? null : task.Task_ID);
              }}
              className="w-5 h-5 rounded-md bg-slate-100 hover:bg-indigo-100 active:bg-indigo-200 border border-slate-200 hover:border-indigo-300 flex items-center justify-center text-slate-400 hover:text-indigo-600 transition shrink-0 cursor-grab active:cursor-grabbing shadow-2xs touch-none"
              title="The six-dot handle lets you drag-and-drop reorder tasks in the list (or tap it for Move Up / Move Down controls). This is your visual ordering preference — it is shown when the admin accesses the particular staff panel, showing tasks in your preferred order."
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
                    handleMoveTaskOrder(task.Task_ID, -1, currentList);
                  }}
                  disabled={idx === 0}
                  className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1 transition text-xs ${idx === 0
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
                    handleMoveTaskOrder(task.Task_ID, 1, currentList);
                  }}
                  disabled={idx === (currentList ? currentList.length - 1 : 0)}
                  className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1 transition text-xs ${idx === (currentList ? currentList.length - 1 : 0)
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

          {/* 2nd Line: Description (Clicking this also toggles bottom buttons) */}
          <div className="cursor-pointer" onClick={() => toggleTaskExpand(task.Task_ID)} title="Tap to view buttons below">
            <p className="text-xs text-slate-600 font-medium mt-0.5 pr-2">
              {task.Description || 'Fire Safety Maintenance Task'}
            </p>
          </div>

          {/* 3rd Line: Last Remark with Date & Time */}
          {(() => {
            const isRemarkExpanded = !!expandedRemarkTaskIds[task.Task_ID];
            const matchingRemarks = myCustomerInteractions.filter(
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
                          <span className="truncate">Complete Remarks</span>
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
              {/* CONVERSATION / ADD REMARK BUTTON (FIRST BUTTON) */}
              <button
                type="button"
                onClick={() => {
                  setRemarkTask(task);
                  setRemarkForm({ type: '', remarks: '' });
                  setShowTagList(true);
                  setShowRemarkInputs(true);
                  setShowRemarksModal(true);
                }}
                className="group relative w-8 h-8 rounded-xl bg-amber-50 hover:bg-amber-100 active:bg-amber-200 border border-amber-300 text-amber-700 flex items-center justify-center transition shrink-0"
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

              {/* REACTIVATE BUTTON (IF CLOSED) */}
              {isCompleted && (
                <button
                  type="button"
                  onClick={() => handleReactivateTask(task)}
                  className="group relative w-8 h-8 rounded-xl bg-purple-50 hover:bg-purple-100 active:bg-purple-200 border border-purple-200 text-purple-700 flex items-center justify-center transition shrink-0"
                  title="Reactivate Task"
                >
                  <RefreshCw className="w-4 h-4 text-purple-600" />
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                    Reactivate
                  </span>
                </button>
              )}

              {/* EDIT BUTTON */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setEditingTask({ ...task }); setShowEditTaskModal(true); }}
                className="group relative w-8 h-8 rounded-xl bg-teal-50 hover:bg-teal-100 active:bg-teal-200 border border-teal-200 text-teal-700 flex items-center justify-center transition shrink-0"
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
                onClick={(e) => { e.stopPropagation(); openModal(task, 'RESCHEDULE'); }}
                className="group relative w-8 h-8 rounded-xl bg-sky-50 hover:bg-sky-100 active:bg-sky-200 border border-sky-200 text-sky-700 flex items-center justify-center transition shrink-0"
                title="Reschedule Task"
              >
                <Calendar className="w-4 h-4 text-sky-600" />
                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                  Reschedule
                </span>
              </button>

              {/* STATUS BUTTON */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openModal(task, 'STATUS'); }}
                className="group relative w-8 h-8 rounded-xl bg-orange-50 hover:bg-orange-100 active:bg-orange-200 border border-orange-200 text-orange-700 flex items-center justify-center transition shrink-0"
                title="Change Status"
              >
                <Activity className="w-4 h-4 text-orange-600" />
                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                  Status
                </span>
              </button>

              {/* TAGS BUTTON — view/toggle dynamic tags (created by Admin) on this task */}
              <div className="relative">
                <button
                  type="button"
                  id={`tag-btn-${task.Task_ID}`}
                  onClick={(e) => { e.stopPropagation(); setTagSearchQuery(''); setTaskTagPickerId(prev => prev === task.Task_ID ? null : task.Task_ID); }}
                  className="group relative w-8 h-8 rounded-xl bg-teal-50 hover:bg-teal-100 active:bg-teal-200 border border-teal-200 text-teal-700 flex items-center justify-center transition shrink-0"
                  title="View/Toggle Tags"
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
                    id={`tag-picker-${task.Task_ID}`}
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
                            
                            {query !== '' && !isExactMatch && user?.role === 'Admin' && (
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
                              <p className="text-[11px] text-slate-400 py-2 text-center">No tags yet.</p>
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
              {!isCompleted && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); openModal(task, 'ADVANCE'); }}
                  className="group relative w-8 h-8 rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 border border-rose-300 text-rose-700 flex items-center justify-center transition shrink-0"
                  title="Advance Work Stage"
                >
                  <ChevronRight className="w-4 h-4 text-rose-600 font-extrabold" />
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                    Advance
                  </span>
                </button>
              )}

              {/* REMOVE BUTTON */}
              <button
                type="button"
                onClick={() => handleDeleteTask(task.Task_ID, task.Description || task.Task_ID)}
                className="group relative w-8 h-8 rounded-xl bg-rose-50 hover:bg-rose-100 active:bg-rose-200 border border-rose-200 text-rose-600 flex items-center justify-center transition shrink-0"
                title="Remove Task"
              >
                <Trash2 className="w-4 h-4 text-rose-600" />
                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md bg-slate-900 text-white text-[10px] font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 group-active:opacity-100 pointer-events-none transition shadow-md z-20">
                  Remove
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6">
      {/* Global Search Bar & Actions - Sticky Header */}
      {activeTab === 'TASKS' && (
        <div className="sticky top-[57px] sm:top-[65px] z-30 bg-white/95 backdrop-blur-md pb-3 pt-1 border-b border-slate-200">
          <div className="flex flex-col gap-2.5 w-full">
            {/* Top Row: Search Input & Action Buttons */}
            <div className="flex flex-row items-center gap-1.5 sm:gap-2 w-full">
              <div className="relative flex-1 min-w-0">
                <input
                  type="text"
                  placeholder="Search Company, Mobile, Person..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-3.5 pr-8 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-sm"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    title="Clear Search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => { }}
                className="p-2 sm:p-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center shadow-sm transition shrink-0"
                title="Search by Company Name, Mobile No, Person Name, Address"
              >
                <Search className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={fetchTasks}
                className="p-2 sm:p-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 transition shadow-sm shrink-0 flex items-center justify-center"
                title="Refresh Tasks"
              >
                <RefreshCw className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setShowFilterModal(true)}
                className={`p-2 sm:p-2.5 rounded-xl border transition shadow-sm shrink-0 flex items-center justify-center relative ${
                  filterSelectedDates.length > 0 || filterSelectedUsers.length > 0 || filterStartDate || filterEndDate
                    ? 'bg-rose-50 border-rose-300 text-rose-600 hover:bg-rose-100'
                    : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-600'
                }`}
                title="Filter Tasks by Date / User"
              >
                <Filter className="w-4 h-4" />
                {(filterSelectedDates.length > 0 || filterSelectedUsers.length > 0 || filterStartDate || filterEndDate) && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-600 animate-pulse" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setShowNewTaskModal(true)}
                className="p-2 sm:p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center shadow-sm transition shrink-0"
                title="Add New Field Task"
              >
                <PlusCircle className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => navigate('/field-visit/new')}
                className="p-2 sm:px-3 sm:py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition shrink-0"
                title="Start a Field Visit — search any equipment type for a client in one walk-through"
              >
                <FileText className="w-4 h-4" />
                <span className="hidden sm:inline">Service Report</span>
              </button>

              <button
                type="button"
                onClick={() => navigate('/certificate/new')}
                className="p-2 sm:px-2.5 sm:py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold text-xs flex items-center justify-center shadow-sm transition shrink-0"
                title="Single-type report (skip the guided field visit)"
              >
                <FileText className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Status/Tag Filter Rows — auto-hide while scrolling, reappear near the top */}
            <div className={`overflow-hidden transition-all duration-300 ease-in-out ${showFilterBar ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}`}>
              <div className="flex flex-col gap-2.5">
                {/* Bottom Row: Task status tags */}
                <div className="flex flex-wrap gap-1.5">
                  {['Pending', 'Started', 'In Progress', 'Completed', 'ALL'].map(status => (
                    <button
                      key={status}
                      onClick={() => setFilterStatus(status)}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition ${filterStatus === status
                        ? 'bg-rose-100 border-rose-300 text-rose-800 shadow-sm'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>

                {/* Dynamic Tag Filter Chips (created by Admin in "Manage Tags") */}
                {tags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tags.map(tag => {
                      const isActive = activeTagFilters.includes(tag.Tag_ID);
                      const tagCount = tasks.filter(t => t.Assigned_Staff === user?.Staff_ID && (t.Tags || []).includes(tag.Tag_ID)).length;
                      return (
                        <button
                          key={tag.Tag_ID}
                          type="button"
                          onClick={() => toggleTagFilter(tag.Tag_ID)}
                          className="relative flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold rounded-full border transition"
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
                        className="text-[10px] font-bold text-slate-400 hover:text-rose-600 px-1.5"
                      >
                        Clear tag filters ✕
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {feedbackMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs flex items-center gap-2 shadow-sm">
          <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
          <span>{feedbackMsg}</span>
        </div>
      )}

      {activeTab === 'TASKS' && (
        <>
          {/* Task List */}
          {loading ? (
            <div className="py-16 text-center text-slate-500 flex flex-col items-center gap-3">
              <RefreshCw className="w-7 h-7 animate-spin text-rose-600" />
              <p className="text-sm">Loading assigned tasks...</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl border border-slate-200">
              <Layers className="w-10 h-10 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-bold text-slate-700">No work orders assigned for this stage</p>
              <p className="text-xs text-slate-400 mt-1">Select another stage or ask Admin to assign a work order</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* TODAY TASKS */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between bg-rose-50 border border-rose-200 rounded-xl px-4 py-2.5 shadow-2xs">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-rose-600" />
                    <span className="text-xs font-bold text-rose-950 uppercase tracking-wider">
                      Today Task ({todayTasks.length})
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold text-rose-700">Calendar: Today & Due</span>
                </div>
                {todayTasks.length > 0 ? (
                  todayTasks.map((task, idx) => renderTaskCard(task, idx, todayTasks))
                ) : (
                  <div className="p-4 rounded-xl bg-white border border-slate-200 text-center text-xs text-slate-500">
                    No tasks scheduled for today.
                  </div>
                )}
              </div>

              {/* TOMORROW TASKS */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 shadow-2xs">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-amber-600" />
                    <span className="text-xs font-bold text-amber-950 uppercase tracking-wider">
                      Tomorrow Task ({tomorrowTasks.length})
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold text-amber-700">Calendar: Tomorrow</span>
                </div>
                {tomorrowTasks.length > 0 ? (
                  tomorrowTasks.map((task, idx) => renderTaskCard(task, idx, tomorrowTasks))
                ) : (
                  <div className="p-4 rounded-xl bg-white border border-slate-200 text-center text-xs text-slate-500">
                    No tasks scheduled for tomorrow.
                  </div>
                )}
              </div>

              {/* UPCOMING TASKS */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-2.5 shadow-2xs">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-indigo-600" />
                    <span className="text-xs font-bold text-indigo-950 uppercase tracking-wider">
                      Upcoming Task ({upcomingTasks.length})
                    </span>
                  </div>
                  <span className="text-[11px] font-semibold text-indigo-700">Calendar: Future Dates</span>
                </div>
                {upcomingTasks.length > 0 ? (
                  upcomingTasks.map((task, idx) => renderTaskCard(task, idx, upcomingTasks))
                ) : (
                  <div className="p-4 rounded-xl bg-white border border-slate-200 text-center text-xs text-slate-500">
                    No upcoming tasks scheduled.
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {(activeTab === 'ATTENDANCE_HISTORY' || activeTab === 'ATTENDANCE') && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Clock className="w-5 h-5 text-emerald-600" />
              Attendance History
            </h2>
            <button
              type="button"
              onClick={() => setActiveTab('TASKS')}
              className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
            >
              ← Back to Scheduled Work
            </button>
          </div>

          {/* Attendance Filters Bar */}
          <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-emerald-600" />
                Filter & Sort Records
              </span>
              <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">
                Showing {filteredMyAttendanceLogs.length} of {myAttendanceLogs.length} records
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Month Filter */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Select Month</label>
                <select
                  value={attMonthFilter}
                  onChange={(e) => setAttMonthFilter(e.target.value)}
                  className="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
                >
                  <option value="ALL">All Months</option>
                  {attAvailableMonths.map(ym => (
                    <option key={ym} value={ym}>{formatMonthLabel(ym)}</option>
                  ))}
                </select>
              </div>

              {/* Ascending / Descending Option */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Date Order</label>
                <select
                  value={attSortOrder}
                  onChange={(e) => setAttSortOrder(e.target.value)}
                  className="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
                >
                  <option value="DESC">Newest First (Descending)</option>
                  <option value="ASC">Oldest First (Ascending)</option>
                </select>
              </div>

              {/* On Time / Late Punch Filter */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Punctuality Filter</label>
                <select
                  value={attStatusFilter}
                  onChange={(e) => setAttStatusFilter(e.target.value)}
                  className="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:outline-none transition"
                >
                  <option value="ALL">All Punches</option>
                  <option value="ON_TIME">On Time Only</option>
                  <option value="LATE">Late Punches Only</option>
                </select>
              </div>
            </div>

            {(attMonthFilter !== 'ALL' || attSortOrder !== 'DESC' || attStatusFilter !== 'ALL') && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAttMonthFilter('ALL');
                    setAttSortOrder('DESC');
                    setAttStatusFilter('ALL');
                  }}
                  className="text-xs font-bold text-rose-600 hover:text-rose-700 underline transition"
                >
                  Reset All Filters
                </button>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {filteredMyAttendanceLogs.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 text-xs font-semibold">
                No attendance records found matching the selected filters.
              </div>
            ) : (
              filteredMyAttendanceLogs.map((log, index) => {
                const isLate = log.Late_Minutes && Number(log.Late_Minutes) > 0;
                return (
                  <div key={index} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow-md transition space-y-3">
                    {/* Vertical Table Header: Date & Punctuality Status */}
                    <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                      <span className="font-bold text-slate-900 text-xs sm:text-sm flex items-center gap-2">
                        <CalendarDays className="w-4 h-4 text-emerald-600 shrink-0" />
                        {formatDateWithDayName(log.Date)}
                      </span>
                      {isLate ? (
                        <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 font-bold text-[11px] border border-rose-200 inline-flex items-center gap-1 shrink-0">
                          <AlertTriangle className="w-3 h-3" />
                          Late by {log.Late_Minutes}m
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[11px] border border-emerald-200 inline-flex items-center gap-1 shrink-0">
                          <CheckCircle2 className="w-3 h-3" />
                          On Time
                        </span>
                      )}
                    </div>

                    {/* Vertical Table Data Fields */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                      <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-100">
                        <span className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider">Punch In → Out</span>
                        <span className="font-bold text-slate-800 mt-0.5 block">
                          {log.Punch_In_Time || '--:--'} → {log.Punch_Out_Time || 'In Progress'}
                        </span>
                      </div>
                      <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-100">
                        <span className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider">Hours Worked</span>
                        <span className="font-bold text-slate-800 mt-0.5 block">{log.Total_Worked_Hours || 0} hrs</span>
                      </div>
                      <div className="bg-emerald-50/60 p-2.5 rounded-xl border border-emerald-100">
                        <span className="text-[10px] font-bold text-emerald-600 block uppercase tracking-wider">Daily Salary</span>
                        <span className="font-bold text-emerald-700 mt-0.5 block">₹{Number(log.Calculated_Daily_Salary || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {activeTab === 'APPLY_LEAVE' && (
        <div className="space-y-4 max-w-xl mx-auto">
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-indigo-600" />
              Apply for Leave
            </h2>
            <button
              type="button"
              onClick={() => setActiveTab('TASKS')}
              className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
            >
              ← Back to Scheduled Work
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            {leaveError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{leaveError}</span>
              </div>
            )}

            <form onSubmit={handleLeaveSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Leave Date *</label>
                <input
                  type="date"
                  required
                  value={leaveForm.leaveDate}
                  onChange={e => setLeaveForm({ ...leaveForm, leaveDate: e.target.value })}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-semibold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Leave Duration *</label>
                <select
                  value={leaveForm.leaveType}
                  onChange={e => setLeaveForm({ ...leaveForm, leaveType: e.target.value })}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-semibold"
                >
                  <option value="Full Day">Full Day Leave</option>
                  <option value="Half Day">Half Day Leave</option>
                  <option value="Short Leave">Short Leave</option>
                </select>
              </div>

              {leaveForm.leaveType === 'Short Leave' && (
                <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Start Time</label>
                    <input
                      type="time"
                      required
                      value={leaveForm.startTime}
                      onChange={e => setLeaveForm({ ...leaveForm, startTime: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">End Time</label>
                    <input
                      type="time"
                      required
                      value={leaveForm.endTime}
                      onChange={e => setLeaveForm({ ...leaveForm, endTime: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={leaveForm.isUrgent}
                    onChange={e => setLeaveForm({ ...leaveForm, isUrgent: e.target.checked })}
                    className="rounded border-slate-300 text-rose-600 focus:ring-rose-500 w-4 h-4"
                  />
                  <div>
                    <span className="text-xs font-bold text-slate-900">Urgent Emergency Leave</span>
                    <p className="text-[11px] text-slate-500">
                      Bypasses mandatory 7-day advance notice rule.
                    </p>
                  </div>
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Reason / Remarks *</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Enter reason for leave request..."
                  value={leaveForm.reason}
                  onChange={e => setLeaveForm({ ...leaveForm, reason: e.target.value })}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>

              <button
                type="submit"
                disabled={leaveSubmitting}
                className="w-full py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm transition"
              >
                {leaveSubmitting ? 'Submitting Request...' : 'Submit Leave Request'}
              </button>
            </form>
          </div>
        </div>
      )}

      {activeTab === 'LEAVE_APPLICATIONS' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-amber-600" />
              My Leave Applications
            </h2>
            <button
              type="button"
              onClick={() => setActiveTab('TASKS')}
              className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
            >
              ← Back to Scheduled Work
            </button>
          </div>

          <div className="space-y-3">
            {myLeaveRequests.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 text-xs font-semibold">
                No leave applications submitted yet.
              </div>
            ) : (
              myLeaveRequests.map(lev => (
                <div key={lev.Request_ID} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow-md transition space-y-3">
                  {/* Vertical Table Header: Date & Status */}
                  <div className="flex items-center justify-between pb-2.5 border-b border-slate-100">
                    <span className="font-bold text-slate-900 text-xs sm:text-sm flex items-center gap-2">
                      <CalendarDays className="w-4 h-4 text-amber-600 shrink-0" />
                      {formatDateWithDayName(lev.Leave_Date)}
                    </span>
                    <span className={`px-2.5 py-1 rounded-full font-bold text-[11px] border shrink-0 ${lev.Status === 'Approved'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : lev.Status === 'Rejected'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}>
                      {lev.Status}
                    </span>
                  </div>

                  {/* Vertical Table Data Fields */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider">Leave Type</span>
                      <span className="font-bold text-slate-800 mt-0.5 block">{lev.Leave_Type}</span>
                    </div>
                    <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider">Notice Type</span>
                      <div className="mt-0.5">
                        {lev.Is_Urgent ? (
                          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px]">
                            Urgent Emergency
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium text-[10px]">
                            Standard (7d+)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Vertical Table Reason Field (Taken as it is without truncation) */}
                  <div className="pt-2 border-t border-slate-100">
                    <span className="text-[10px] font-bold text-slate-400 block uppercase tracking-wider mb-1">Reason / Remarks</span>
                    <div className="text-xs text-slate-700 font-medium bg-slate-50 p-3 rounded-xl border border-slate-100/80 leading-relaxed whitespace-pre-wrap break-words">
                      {lev.Reason || 'No remarks provided'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {(activeTab === 'EARNINGS' || activeTab === 'REPORTS') && (
        <div className="space-y-4">
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <IndianRupee className="w-5 h-5 text-emerald-600" />
              My Earnings & Pro-Rata Salary Breakdown
            </h2>
            <button
              type="button"
              onClick={() => setActiveTab('TASKS')}
              className="px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
            >
              ← Back to Scheduled Work
            </button>
          </div>

          <div className="space-y-6">
            {/* Automated Pro-Rata Earnings KPI Card */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">

              {(() => {
                const todayStr = getLocalDateStr();
                const currentMonthStr = todayStr.slice(0, 7);
                const monthRecords = myAttendanceLogs.filter(r => r.Date?.startsWith(currentMonthStr));
                const monthlyTotal = monthRecords.reduce((sum, r) => sum + Number(r.Calculated_Daily_Salary || 0), 0);
                const todayTotal = myAttendanceLogs
                  .filter(r => r.Date === todayStr)
                  .reduce((sum, r) => sum + Number(r.Calculated_Daily_Salary || 0), 0);
                const totalAdvance = mySalaryAdvances.reduce((sum, a) => sum + Number(a.Amount || 0), 0);
                const netBalance = monthlyTotal - totalAdvance;

                return (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">This Month Earned</p>
                        <p className="text-2xl font-bold text-emerald-600 mt-1">₹{monthlyTotal.toLocaleString()}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">Today's Earned</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">₹{todayTotal.toLocaleString()}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">Standard Daily Rate</p>
                        <p className="text-2xl font-bold text-indigo-600 mt-1">₹{(myAttendanceLogs[0]?.Daily_Salary_Rate || 1000).toLocaleString()}</p>
                      </div>
                    </div>

                    {totalAdvance > 0 && (
                      <div className="p-4 rounded-xl bg-amber-50/80 border border-amber-200 space-y-2">
                        <div className="flex items-center justify-between text-xs font-bold text-amber-900">
                          <span>This Month — Advance Deduction Calculation</span>
                          <span className="px-2 py-0.5 rounded bg-amber-200 text-amber-950 text-[10px]">Advance Deducted</span>
                        </div>
                        <div className="grid grid-cols-3 gap-3 text-center pt-1">
                          <div className="bg-white p-3 rounded-xl border border-amber-100">
                            <p className="text-[10px] text-slate-500 font-semibold">Total Earned</p>
                            <p className="text-base font-bold text-slate-900">₹{monthlyTotal.toLocaleString()}</p>
                          </div>
                          <div className="bg-white p-3 rounded-xl border border-amber-100">
                            <p className="text-[10px] text-rose-500 font-semibold">- Total Advance</p>
                            <p className="text-base font-bold text-rose-600">₹{totalAdvance.toLocaleString()}</p>
                          </div>
                          <div className="bg-emerald-600 p-3 rounded-xl text-white">
                            <p className="text-[10px] text-emerald-100 font-semibold">= Net Payable Balance</p>
                            <p className="text-base font-bold">₹{netBalance.toLocaleString()}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Staff Performance & Task Summary Report */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 mb-3">
                <FileText className="w-5 h-5 text-rose-600" />
                Staff Performance & Task Progress Report
              </h3>
              {(() => {
                const totalAssigned = tasks.length;
                const completedTasks = tasks.filter(t => t.Status === 'Completed' || t.Stage === 'Completed').length;
                const pendingTasks = totalAssigned - completedTasks;
                const completionRate = totalAssigned > 0 ? Math.round((completedTasks / totalAssigned) * 100) : 0;

                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                    <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                      <p className="text-[11px] font-semibold text-slate-500">Total Assigned</p>
                      <p className="text-xl font-bold text-slate-900 mt-1">{totalAssigned}</p>
                    </div>
                    <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
                      <p className="text-[11px] font-semibold text-emerald-700">Completed</p>
                      <p className="text-xl font-bold text-emerald-800 mt-1">{completedTasks}</p>
                    </div>
                    <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200">
                      <p className="text-[11px] font-semibold text-amber-700">Pending</p>
                      <p className="text-xl font-bold text-amber-800 mt-1">{pendingTasks}</p>
                    </div>
                    <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200">
                      <p className="text-[11px] font-semibold text-indigo-700">Completion Rate</p>
                      <p className="text-xl font-bold text-indigo-800 mt-1">{completionRate}%</p>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* DOUBLE CONFIRMATION MODAL FOR PUNCH OUT */}
      {showPunchOutConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl border border-slate-200 animate-fadeIn space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Confirm Shift Punch Out</h3>
                <p className="text-xs text-slate-500 mt-0.5">Please double confirm to end your active shift session.</p>
              </div>
            </div>

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs text-slate-700 leading-relaxed">
              Are you sure you want to punch out now? Your shift hours will be calculated up to this moment.
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowPunchOutConfirmModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowPunchOutConfirmModal(false);
                  await handlePunchOut();
                }}
                disabled={punching}
                className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-sm transition"
              >
                {punching ? 'Punching Out...' : 'Yes, Confirm Punch Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODALS */}
      {activeModal && selectedTask && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                {activeModal === 'ADVANCE' && 'Advance Workflow Stage'}
                {activeModal === 'RESCHEDULE' && 'Reschedule Service Date'}
                {activeModal === 'LOG' && 'Submit Field Activity Log'}
                {activeModal === 'STATUS' && 'Update Task Status'}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-700 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-200">
              <p className="font-bold text-slate-900">{selectedTask.Customer_Name}</p>
              <p className="text-slate-500 mt-0.5">{selectedTask.Description}</p>
              <p className="mt-2 text-rose-600 font-semibold">Current Stage: {selectedTask.Stage}</p>
            </div>

            {/* FORM OR ACTIONS */}
            {activeModal === 'STATUS' ? (
              <div className="space-y-3 pt-2">
                {['Started', 'In Progress', 'Completed'].map(status => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => {
                      handleUpdateStatus(selectedTask.Task_ID, status);
                      closeModal();
                    }}
                    className={`w-full py-3 rounded-xl font-bold text-sm transition shadow-sm border ${selectedTask.Status === status
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
                    handleUpdateStatus(selectedTask.Task_ID, '');
                    closeModal();
                  }}
                  className="w-full py-3 rounded-xl font-bold text-sm transition shadow-sm border border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-500"
                  title="Reset an accidentally-set status — hides this task from the Started/In Progress/Completed tabs, still visible under ALL"
                >
                  ⟲ Reset to No Status
                </button>
              </div>
            ) : (
              <form
                onSubmit={
                  activeModal === 'ADVANCE'
                    ? handleAdvanceStage
                    : activeModal === 'RESCHEDULE'
                      ? handleReschedule
                      : handleActivityLog
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
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                )}

                {activeModal === 'LOG' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Action Taken *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Completed hydraulic pressure test"
                      value={actionTaken}
                      onChange={(e) => setActionTaken(e.target.value)}
                      className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {activeModal === 'RESCHEDULE' ? 'Mandatory Reschedule Remarks *' : 'Field Remarks / Notes'}
                  </label>
                  <textarea
                    rows={3}
                    required={activeModal === 'RESCHEDULE'}
                    placeholder={
                      activeModal === 'RESCHEDULE'
                        ? 'Why is this work order being rescheduled? (Mandatory)'
                        : 'Enter inspection notes or customer requests...'
                    }
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                </div>

                {/* Photo Upload & Client-side Compression (<200KB) */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                    <span>Photo Proof Upload (Auto-Compressed &lt;200KB)</span>
                    {compressingPhoto && <span className="text-amber-600 font-bold">Compressing...</span>}
                  </label>
                  <div className="flex items-center gap-3">
                    <label className="cursor-pointer px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 text-xs font-semibold flex items-center gap-1.5 transition">
                      <Camera className="w-4 h-4 text-rose-600" />
                      Take/Select Photo
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handlePhotoSelect}
                        className="hidden"
                      />
                    </label>
                    {photoDataUrl && (
                      <span className="text-xs text-emerald-600 font-semibold">✓ Photo compressed ready</span>
                    )}
                  </div>
                  {photoDataUrl && (
                    <div className="mt-2.5 rounded-xl overflow-hidden border border-slate-200 max-h-32">
                      <img src={photoDataUrl} alt="Compressed Service Proof" className="w-full h-32 object-cover" />
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || compressingPhoto}
                    className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm transition disabled:opacity-50"
                  >
                    {submitting ? 'Saving...' : activeModal === 'ADVANCE' ? 'Advance Stage Now' : 'Confirm Action'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* REMARKS & INTERACTION HISTORY MODAL */}
      {showRemarksModal && remarkTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-4 sm:p-6 shadow-xl border border-slate-200 max-h-[90vh] overflow-y-auto space-y-4 sm:space-y-5 animate-fadeIn">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-amber-600" />
                  Discussion Log
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Client: <strong className="text-slate-800">
                    {(remarkTask.Customer_Name && remarkTask.Customer_Name !== 'General Client' && remarkTask.Customer_Name !== 'Unknown Company')
                      ? remarkTask.Customer_Name
                      : (customersList.find(c => String(c.Customer_ID || '').trim().toLowerCase() === String(remarkTask.Customer_ID || '').trim().toLowerCase())?.Company_Name || remarkTask.Customer_Name || (remarkTask.Customer_ID ? `Customer (${remarkTask.Customer_ID})` : 'General Client'))}
                  </strong> • Task: #{remarkTask.Task_ID}
                </p>
              </div>
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
                className="text-slate-400 hover:text-slate-600 font-bold text-sm p-1"
              >
                ✕
              </button>
            </div>

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
                          onClick={(e) => handleAddCustomTag(e, true)}
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
                          <span>{submittingRemark ? 'Saving...' : 'Save'}</span>
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

                        <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
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
                  const history = myCustomerInteractions.filter(
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
                        {historySearchText ? `No remarks matching "${historySearchText}" for this client.` : 'No remarks recorded yet for this client or task. Add the first interaction remark above!'}
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                      {history.slice().reverse().map((item, idx) => (
                        <div key={item.Interaction_ID || idx} className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${remarkBadgeClass(item.Type, 'bg-amber-100 text-amber-800')}`}>
                                {item.Type || 'Call Discussion'}
                              </span>
                              <span className="text-xs font-bold text-slate-800">
                                {item.Staff_Name || item.Staff_ID}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {canEditRemark(item) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingInteractionId(item.Interaction_ID);
                                    setEditingRemarkText(item.Remarks || '');
                                  }}
                                  className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold transition cursor-pointer"
                                  title="Editable for 5 minutes after creation"
                                >
                                  ✏️ Edit (5m left)
                                </button>
                              )}
                              <span className="text-[11px] text-slate-500 font-semibold">{formatInteractionTimestamp(item.Timestamp)}</span>
                            </div>
                          </div>

                          {editingInteractionId === item.Interaction_ID ? (
                            <div className="space-y-2 pt-1">
                              <textarea
                                value={editingRemarkText}
                                onChange={(e) => setEditingRemarkText(e.target.value)}
                                className="w-full px-3 py-2 border border-amber-300 rounded-xl text-xs bg-white focus:outline-none focus:ring-2 focus:ring-amber-500 font-medium"
                                rows={2}
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingInteractionId(null)}
                                  className="px-3 py-1 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleUpdateRemarkSubmit(item.Interaction_ID)}
                                  className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <p className="text-xs text-slate-700 leading-relaxed font-medium">
                              {item.Remarks}
                            </p>
                          )}
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

      {/* RIGHT SIDE STAFF PROFILE & QUICK MENU POPUP */}
      {showProfilePopup && (
        <div className="fixed inset-0 z-50 bg-slate-900/10 flex items-start justify-end p-3 sm:p-5">
          <div className="bg-white rounded-2xl max-w-sm w-full p-4 sm:p-5 shadow-2xl border border-slate-200 animate-fadeIn space-y-3.5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-11 h-11 rounded-full bg-rose-600 text-white flex items-center justify-center text-base font-extrabold shadow-sm overflow-hidden border-2 border-rose-200 shrink-0">
                  {(user.Profile_Photo || user.Pending_Photo_Request || user.ProfilePhoto || user.profilePhoto) ? (
                    <img src={user.Profile_Photo || user.Pending_Photo_Request || user.ProfilePhoto || user.profilePhoto} alt={user.Name} className="w-full h-full object-cover" />
                  ) : (
                    user.Name ? user.Name.charAt(0).toUpperCase() : 'S'
                  )}
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-slate-900 leading-tight">{user.Name}</h3>
                  <p className="text-[11px] font-semibold text-slate-500">ID: {user.Staff_ID || user.staffId || user.id} • {user.Role}</p>
                  <label className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[10px] font-bold cursor-pointer border border-indigo-200 transition">
                    📷 {(user.Profile_Photo || user.Pending_Photo_Request || user.ProfilePhoto || user.profilePhoto) ? 'Change Photo (Approval)' : '+ Upload Profile Photo'}
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
                              const res = await fetch('/api/staff/profile-photo-request', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                body: JSON.stringify({ photoDataUrl })
                              });
                              let data = {};
                              try { data = await res.json(); } catch (e) { }
                              if (res.ok) {
                                updateUser({ Pending_Photo_Request: photoDataUrl, Photo_Status: 'Pending Approval' });
                                alert('✅ Profile photo uploaded! Waiting for Admin approval.');
                              } else {
                                alert('❌ Upload failed: ' + (data.error || `Server error (${res.status})`));
                              }
                            } catch (err) {
                              alert('Error uploading photo: ' + err.message);
                            }
                          };
                          img.src = ev.target.result;
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setShowProfilePopup(false);
                      setIcardTargetUser(user);
                      setShowICardModal(true);
                    }}
                    className="mt-1 ml-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-50 hover:bg-rose-105 text-rose-700 text-[10px] font-bold border border-rose-200 transition shadow-2xs"
                  >
                    View ID Card
                  </button>
                </div>
              </div>
              <button
                onClick={() => setShowProfilePopup(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm p-1"
              >
                ✕
              </button>
            </div>

            {/* PUNCH IN / PUNCH OUT SECTION */}
            {(() => {
              const todayStr = getLocalDateStr();
              const openShift = myAttendanceLogs.find(r => r.Date === todayStr && (!r.Punch_Out_Time || r.Punch_Out_Time === ''));
              return (
                <div className={`p-3 rounded-xl border space-y-2 ${openShift ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold text-slate-800">Daily Attendance</p>
                      <p className="text-[10px] text-slate-500">Shift: 09:00 AM – 07:00 PM</p>
                    </div>
                    <div className="text-right text-xs">
                      <p className="text-slate-500 font-medium text-[11px]">In: <span className="font-bold text-emerald-700">{openShift?.Punch_In_Time || '--:--'}</span></p>
                      <p className="text-slate-500 font-medium text-[11px]">Out: <span className="font-bold text-amber-700">{openShift ? 'Active' : '--:--'}</span></p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={punching}
                    onClick={async () => {
                      if (openShift) {
                        setShowProfilePopup(false);
                        setShowPunchOutConfirmModal(true);
                      } else {
                        setShowProfilePopup(false);
                        await handlePunchIn();
                      }
                    }}
                    className={`w-full py-2 rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition ${openShift
                      ? 'bg-rose-600 hover:bg-rose-700 text-white'
                      : 'bg-amber-600 hover:bg-amber-700 text-white'
                      }`}
                  >
                    {openShift ? <Square className="w-3 h-3 fill-white" /> : <Clock className="w-3 h-3" />}
                    {punching ? 'Processing...' : openShift ? 'Punch Out — End Shift' : 'Punch In — Start Shift'}
                  </button>
                </div>
              );
            })()}

            {/* POPUP MENU ITEMS */}
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  setActiveTab('TASKS');
                }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <Briefcase className="w-3.5 h-3.5 text-rose-600" />
                  <span>My Profile & Scheduled Work</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  setActiveTab('APPLY_LEAVE');
                }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Apply for Leave</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  setActiveTab('LEAVE_APPLICATIONS');
                }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-3.5 h-3.5 text-amber-600" />
                  <span>My Leave Applications</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  setActiveTab('ATTENDANCE_HISTORY');
                }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Attendance History</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  setActiveTab('EARNINGS');
                }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <IndianRupee className="w-3.5 h-3.5 text-emerald-600" />
                  <span>My Earnings & Pro-Rata Salary</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowProfilePopup(false); setShowCompanyDetailsModal(true); setCompanyDetailsTab('billing'); }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-800 font-bold text-xs transition border border-slate-200/80"
              >
                <div className="flex items-center gap-2">
                  <Building2 className="w-3.5 h-3.5 text-rose-600" />
                  <span>Company Details & QR Codes</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                type="button"
                onClick={() => { setShowProfilePopup(false); setShowChangePasswordModal(true); setChangePasswordError(''); }}
                className="w-full flex items-center justify-between p-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 font-bold text-xs transition border border-amber-200"
              >
                <div className="flex items-center gap-2">
                  <Key className="w-3.5 h-3.5 text-amber-600" />
                  <span>Change My Password</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-amber-400" />
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200 flex gap-2">
              <button
                type="button"
                onClick={() => setShowProfilePopup(false)}
                className="w-1/3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowProfilePopup(false);
                  logout();
                }}
                className="w-2/3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out / Logout
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CHANGE MY PASSWORD MODAL (self-service — requires current password) */}
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

      {/* EDIT CUSTOMER MODAL (STAFF) */}
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
                <div className="flex items-center justify-between">
                  <label className="block font-bold text-indigo-900">📍 GPS Map Location Link</label>
                  {editCustomerForm.locationLink?.trim() && !isEditCustomerGpsUnlocked ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm('Unlock location field to fetch or edit GPS position?')) {
                          setIsEditCustomerGpsUnlocked(true);
                        }
                      }}
                      className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-white font-extrabold text-[11px] rounded-lg shadow-2xs flex items-center gap-1 transition"
                    >
                      🔓 Unlock to Edit/Fetch
                    </button>
                  ) : (
                    editCustomerForm.locationLink?.trim() && (
                      <button
                        type="button"
                        onClick={() => setIsEditCustomerGpsUnlocked(false)}
                        className="px-2 py-0.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-[10px] rounded-md transition"
                      >
                        🔒 Lock Location
                      </button>
                    )
                  )}
                </div>
                <p className="text-[11px] text-indigo-700">
                  {editCustomerForm.locationLink?.trim() && !isEditCustomerGpsUnlocked
                    ? '🔒 Location is locked to prevent accidental overwrite. Click "Unlock to Edit/Fetch" above if you need to update it.'
                    : 'Paste the Google Maps share URL or tap Fetch GPS from current client location.'}
                </p>
                <div className="flex items-center gap-1.5">
                  <input
                    type="url"
                    readOnly={Boolean(editCustomerForm.locationLink?.trim() && !isEditCustomerGpsUnlocked)}
                    value={editCustomerForm.locationLink}
                    onChange={e => setEditCustomerForm({ ...editCustomerForm, locationLink: e.target.value })}
                    className={`flex-1 px-3 py-2 border rounded-xl text-slate-900 focus:outline-none focus:ring-2 ${
                      editCustomerForm.locationLink?.trim() && !isEditCustomerGpsUnlocked
                        ? 'bg-slate-100 border-slate-300 text-slate-600 cursor-not-allowed'
                        : 'bg-white border-indigo-300 focus:ring-indigo-500'
                    }`}
                    placeholder="https://maps.google.com/?q=..."
                  />
                  {(!editCustomerForm.locationLink?.trim() || isEditCustomerGpsUnlocked) && (
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
                  )}
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
                <button type="submit" disabled={savingCustomer} className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-sm transition disabled:opacity-60">
                  {savingCustomer ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SMART COMPANY SEARCH & TASK ACTIVATE MODAL (STAFF) */}
      {showNewTaskModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-3xl max-w-xl w-full p-4 sm:p-6 shadow-2xl space-y-4 sm:space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <PlusCircle className="w-5 h-5 text-indigo-600" />
                  Activate Task / Add Work Order
                </h3>
                <p className="text-xs text-slate-500">Search Company from Database or Add New Customer</p>
              </div>
              <button
                onClick={() => {
                  setShowNewTaskModal(false);
                  setSelectedCustomer(null);
                  setIsNewCustomerMode(false);
                }}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSmartCreateTask} className="space-y-4">
              {/* Step 1: Company Selection or New Customer */}
              <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-800">
                    1. Select Company / Customer Database
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setIsNewCustomerMode(!isNewCustomerMode);
                      setSelectedCustomer(null);
                    }}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 underline"
                  >
                    {isNewCustomerMode ? '← Back to Search Database' : '+ New Customer? Add to Database'}
                  </button>
                </div>

                {!isNewCustomerMode ? (
                  <div className="space-y-2.5">
                    <input
                      type="text"
                      placeholder="Type Company Name to search in Customer Database..."
                      value={customerSearchQuery}
                      onChange={e => {
                        setCustomerSearchQuery(e.target.value);
                        setSelectedCustomer(null);
                      }}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
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
                          {(selectedCustomer.Location_Link || selectedCustomer.locationLink) ? (
                            <div className="w-full flex items-center justify-between gap-2 bg-emerald-50/90 border border-emerald-200 p-2 rounded-xl flex-wrap">
                              <a
                                href={selectedCustomer.Location_Link || selectedCustomer.locationLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-100/80 hover:bg-emerald-200 px-2.5 py-1 rounded-lg transition truncate"
                              >
                                <MapPin className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">🔒 Client Location Locked</span>
                              </a>
                              {!isNewCustomerGpsUnlocked ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (window.confirm('Unlock location field to fetch and overwrite GPS coordinates?')) {
                                      setIsNewCustomerGpsUnlocked(true);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 hover:text-amber-900 bg-amber-200/80 hover:bg-amber-300 border border-amber-300 px-2.5 py-1 rounded-lg transition shadow-2xs"
                                >
                                  <span>🔓 Unlock to Re-fetch</span>
                                </button>
                              ) : (
                                <div className="flex items-center gap-1.5">
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
                                  <button
                                    type="button"
                                    onClick={() => setIsNewCustomerGpsUnlocked(false)}
                                    className="text-[10px] font-bold px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg"
                                  >
                                    🔒 Lock
                                  </button>
                                </div>
                              )}
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
                      <div className="max-h-36 overflow-y-auto space-y-1.5 border border-slate-200 rounded-xl p-1.5 bg-white">
                        {customersList
                          .filter(c =>
                            c.Company_Name?.toLowerCase().includes(customerSearchQuery.toLowerCase()) ||
                            c.Contact?.includes(customerSearchQuery)
                          )
                          .slice(0, 5)
                          .map(c => (
                            <div
                              key={c.Customer_ID}
                              onClick={() => {
                                setSelectedCustomer(c);
                                setIsNewCustomerGpsUnlocked(false);
                              }}
                              className="p-2 rounded-lg hover:bg-indigo-50 cursor-pointer transition flex items-center justify-between border border-transparent hover:border-indigo-200"
                            >
                              <div>
                                <span className="text-xs font-bold text-slate-800 block">{c.Company_Name}</span>
                                <span className="text-[10px] text-slate-500">{c.Auth_Person} • {c.Contact}</span>
                              </div>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">
                                Select
                              </span>
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  /* New Customer Form */
                  <div className="space-y-2.5 pt-1">
                    <p className="text-[11px] text-indigo-700 font-semibold">
                      New customer data will be saved to Customer Database automatically:
                    </p>
                    <input
                      type="text"
                      required={isNewCustomerMode}
                      placeholder="Company Name *"
                      value={newCustomerForm.companyName}
                      onChange={e => setNewCustomerForm({ ...newCustomerForm, companyName: e.target.value })}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="Contact Person Name"
                        value={newCustomerForm.authPerson}
                        onChange={e => setNewCustomerForm({ ...newCustomerForm, authPerson: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                      />
                      <input
                        type="text"
                        placeholder="Mobile Number *"
                        maxLength={10}
                        required={isNewCustomerMode}
                        value={newCustomerForm.contact}
                        onChange={e => {
                          const val = e.target.value.replace(/\D/g, '');
                          setNewCustomerForm({ ...newCustomerForm, contact: val });
                        }}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                      />
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        placeholder="Google Maps GPS Link (or click Fetch 👉)"
                        value={newCustomerForm.locationLink || ''}
                        onChange={e => setNewCustomerForm({ ...newCustomerForm, locationLink: e.target.value })}
                        className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const pos = await getAccurateGpsPosition({ timeout: 15000, maxAccuracy: 250 });
                            const lat = pos.latitude.toFixed(6);
                            const lng = pos.longitude.toFixed(6);
                            setNewCustomerForm({ ...newCustomerForm, locationLink: `https://maps.google.com/?q=${lat},${lng}` });
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
                      placeholder="Company Address / Location"
                      value={newCustomerForm.address}
                      onChange={e => setNewCustomerForm({ ...newCustomerForm, address: e.target.value })}
                      className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs"
                    />

                    <div className="space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-semibold text-slate-700">Additional Contact Persons</label>
                        <button type="button" onClick={() => setNewCustomerForm({ ...newCustomerForm, contacts: [...newCustomerForm.contacts, { name: '', designation: '', contactNumber: '', email: '' }] })} className="text-[10px] font-bold text-indigo-600 hover:underline">+ Add Contact</button>
                      </div>
                      {newCustomerForm.contacts.map((c, i) => (
                        <div key={i} className="p-2 border border-slate-200 rounded-lg space-y-2 bg-white relative">
                          {i > 0 && (
                            <button type="button" onClick={() => setNewCustomerForm({ ...newCustomerForm, contacts: newCustomerForm.contacts.filter((_, idx) => idx !== i) })} className="absolute top-1 right-1 text-slate-400 hover:text-rose-600">✕</button>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <input type="text" placeholder="Name" value={c.name} onChange={e => { const newC = [...newCustomerForm.contacts]; newC[i].name = e.target.value; setNewCustomerForm({ ...newCustomerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="text" placeholder="Designation" value={c.designation} onChange={e => { const newC = [...newCustomerForm.contacts]; newC[i].designation = e.target.value; setNewCustomerForm({ ...newCustomerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="text" placeholder="Phone" maxLength={10} value={c.contactNumber} onChange={e => { const val = e.target.value.replace(/\D/g, ''); const newC = [...newCustomerForm.contacts]; newC[i].contactNumber = val; setNewCustomerForm({ ...newCustomerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                            <input type="email" placeholder="Email" value={c.email} onChange={e => { const newC = [...newCustomerForm.contacts]; newC[i].email = e.target.value; setNewCustomerForm({ ...newCustomerForm, contacts: newC }); }} className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-[11px]" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Step 2: Work Description & Date */}
              <div className="space-y-3">
                <span className="text-xs font-bold text-slate-800 block">
                  2. Work Order Details & Flow Date
                </span>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Work Description *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Fire Extinguisher Refilling (45 ABC & CO2 Cylinders)"
                    value={newTaskForm.description}
                    onChange={e => setNewTaskForm({ ...newTaskForm, description: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Scheduled Date *</label>
                    <input
                      type="date"
                      required
                      value={newTaskForm.scheduledDate}
                      onChange={e => setNewTaskForm({ ...newTaskForm, scheduledDate: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Task Type</label>
                    <select
                      value={newTaskForm.type}
                      onChange={e => setNewTaskForm({ ...newTaskForm, type: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="One-time">One-time</option>
                      <option value="Recurring">Recurring</option>
                    </select>
                  </div>
                </div>
                {newTaskForm.type === 'Recurring' && (
                  <div className="grid grid-cols-2 gap-3 p-3 bg-white border border-indigo-100 rounded-xl">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">Repeat Every</label>
                      <input
                        type="number"
                        min="1"
                        value={newTaskForm.recurringPeriod.value}
                        onChange={e => setNewTaskForm({ ...newTaskForm, recurringPeriod: { ...newTaskForm.recurringPeriod, value: e.target.value } })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">Period</label>
                      <select
                        value={newTaskForm.recurringPeriod.type}
                        onChange={e => setNewTaskForm({ ...newTaskForm, recurringPeriod: { ...newTaskForm.recurringPeriod, type: e.target.value } })}
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
                {(() => {
                  const userRole = user?.Role || 'Staff';
                  const userPerms = user?.Permissions || '';
                  const hasAssignAccess = ['Admin', 'ADMIN', 'Manager', 'Supervisor'].includes(userRole) || userPerms === 'FULL_ACCESS' || userPerms === 'ALL_TASKS';
                  
                  if (!hasAssignAccess) return null;

                  const userLevel = ROLE_LEVELS[userRole] || 1;
                  const effectiveUserLevel = userPerms === 'ALL_TASKS' ? Math.max(userLevel, 2) : userLevel;

                  const assignableStaff = staffList.filter(s => {
                    if (s.Status === 'Inactive') return false;
                    const targetLevel = ROLE_LEVELS[s.Role] || 1;
                    if (['Admin', 'ADMIN'].includes(userRole) || userPerms === 'FULL_ACCESS') return true;
                    return effectiveUserLevel >= targetLevel;
                  });

                  return (
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">Assign Staff Member</label>
                      <select
                        value={newTaskForm.assignedStaff || user.staffId || user.Staff_ID}
                        onChange={e => setNewTaskForm({ ...newTaskForm, assignedStaff: e.target.value })}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 bg-white"
                      >
                        <option value="">Assign to Me ({user.Name || user.staffId})</option>
                        {assignableStaff.map(s => (
                          <option key={s.Staff_ID} value={s.Staff_ID}>
                            {s.Name} ({s.Role || s.Department})
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })()}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewTaskModal(false);
                    setSelectedCustomer(null);
                    setIsNewCustomerMode(false);
                  }}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-sm"
                >
                  Create & Activate in Flow
                </button>
              </div>
            </form>
          </div>
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
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
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

      {/* CORPORATE STAFF I-CARD MODAL */}
      {showICardModal && icardTargetUser && (() => {
        const dob = (user?.DOB || icardData.dob || '');
        const bloodGroup = (user?.Blood_Group || icardData.bloodGroup || 'O+');
        const emergencyContact = (user?.Emergency_Contact || icardData.emergencyContact || '8460699569');
        const aadharNo = (user?.Aadhar_No || icardData.aadharNo || '');
        const isPending = user?.ICard_Status === 'Pending Approval';

        const formatAadhar = (val) => {
          if (!val) return '–';
          const clean = val.replace(/\s+/g, '');
          if (clean.length < 6) return clean;
          const maskedLength = clean.length - 6;
          const masked = 'X'.repeat(maskedLength);
          const visible = clean.substring(maskedLength);
          return `${masked} ${visible}`;
        };

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

              <div className="w-[272px] rounded-2xl overflow-hidden shadow-xl border border-slate-200 flex flex-col font-sans bg-white">

                {/* ── CARD HEADER: White patch with logo maximized and bold red bottom border ── */}
                <div className="flex items-center justify-center pt-2.5 pb-1 bg-white border-b-[4px] border-rose-600 w-full shrink-0">
                  <img src="/expert_logo.jpg?v=4" alt="Expert Safety Logo" className="w-[190px] h-auto object-contain p-0.5" onError={e => { e.target.style.display='none'; }} />
                </div>

                {/* ── PHOTO SECTION ── */}
                <div className="flex flex-col items-center pt-3 pb-1 px-3 bg-white">
                  <div className="w-[140px] h-[140px] rounded-xl border-2 border-rose-600 shadow-md bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                    {(user?.Profile_Photo || user?.Pending_Photo_Request || user?.profilePhoto || user?.ProfilePhoto) ? (
                      <img src={user?.Profile_Photo || user?.Pending_Photo_Request || user?.profilePhoto || user?.ProfilePhoto} alt={user?.Name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-slate-500 text-2xl font-black">{String(user?.Name || 'S').charAt(0).toUpperCase()}</span>
                    )}
                  </div>

                  <h4 className="text-slate-900 font-black text-[13px] uppercase tracking-wide mt-2 text-center leading-tight">{user?.Name}</h4>
                  <span className="text-rose-700 font-extrabold text-[9.5px] tracking-wider mt-0.5 text-center">
                    ({user?.Role || user?.Department || 'Staff'})
                  </span>
                </div>

                {/* ── DETAILS GRID ── */}
                <div className="px-4 pb-2.5 pt-1.5 space-y-2 bg-white text-xs border-t border-slate-100">
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                    <div>
                      <span className="text-[7.5px] text-rose-700 font-extrabold uppercase tracking-wider block leading-none mb-0.5">Employee ID</span>
                      <span className="text-slate-950 font-black text-[10.5px]">{user?.Staff_ID || user?.staffId}</span>
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

              {/* STAFF ACTIONS — Request only (no direct edit) */}
              {isEditingICard ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const res = await fetch('/api/staff/icard-request', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ dob: icardData.dob, bloodGroup: icardData.bloodGroup, emergencyContact: icardData.emergencyContact, aadharNo: icardData.aadharNo })
                      });
                      const data = await res.json();
                      if (res.ok) {
                        setIsEditingICard(false);
                        alert('✅ Request submitted! Admin will review and approve your ID card changes.');
                      } else {
                        alert('❌ Error: ' + (data.error || 'Failed to submit'));
                      }
                    } catch (err) {
                      alert('Error: ' + err.message);
                    }
                  }}
                  className="w-full space-y-3 border-t border-slate-100 pt-3"
                >
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-2.5">
                    <p className="text-[10px] font-black text-blue-700 uppercase tracking-wider">Request ID Card Update</p>
                    <p className="text-[9px] text-blue-500 mt-0.5">Changes require Admin approval before reflecting on card.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Date of Birth:</label>
                      <input type="date" required value={icardData.dob} onChange={e => setIcardData({ ...icardData, dob: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400" />
                    </div>
                    <div>
                      <label className="block text-slate-700 font-bold mb-1">Blood Group:</label>
                      <input type="text" required placeholder="O+ / AB-" value={icardData.bloodGroup} onChange={e => setIcardData({ ...icardData, bloodGroup: e.target.value })}
                        className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700 font-bold mb-1">Emergency Contact:</label>
                    <input type="text" required placeholder="Emergency Number" value={icardData.emergencyContact} onChange={e => setIcardData({ ...icardData, emergencyContact: e.target.value })}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-700 font-bold mb-1">Aadhaar Card Number:</label>
                    <input type="text" required placeholder="12 digit Aadhaar No" value={icardData.aadharNo || ''} onChange={e => setIcardData({ ...icardData, aadharNo: e.target.value })}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono" />
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setIsEditingICard(false)}
                      className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50 transition">Cancel</button>
                    <button type="submit"
                      className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition shadow-sm">📤 Submit Request</button>
                  </div>
                </form>
              ) : (
                <div className="w-full flex gap-2 border-t border-slate-100 pt-3">
                  <button type="button"
                    onClick={() => { setIcardData({ dob: user?.DOB || '', bloodGroup: user?.Blood_Group || 'O+', emergencyContact: user?.Emergency_Contact || '', aadharNo: user?.Aadhar_No || '' }); setIsEditingICard(true); }}
                    disabled={isPending}
                    className={`flex-1 py-2.5 rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 ${isPending ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-slate-700 hover:bg-slate-800 text-white shadow-sm'}`}
                  >
                    {isPending ? '⏳ Pending Approval...' : '📝 Request Update'}
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
                          <span className="font-extrabold text-slate-955 font-mono tracking-wide text-xs">50200097994640</span>
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
              {(() => {
                const userRole = user?.Role || 'Staff';
                const userPerms = user?.Permissions || '';
                const hasAssignAccess = ['Admin', 'ADMIN', 'Manager', 'Supervisor'].includes(userRole) || userPerms === 'FULL_ACCESS' || userPerms === 'ALL_TASKS';
                
                if (!hasAssignAccess) return null;

                const userLevel = ROLE_LEVELS[userRole] || 1;
                const effectiveUserLevel = userPerms === 'ALL_TASKS' ? Math.max(userLevel, 2) : userLevel;

                const assignableStaff = staffList.filter(s => {
                  if (s.Status === 'Inactive') return false;
                  const targetLevel = ROLE_LEVELS[s.Role] || 1;
                  if (['Admin', 'ADMIN'].includes(userRole) || userPerms === 'FULL_ACCESS') return true;
                  return effectiveUserLevel >= targetLevel;
                });

                return (
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Assign Staff Member</label>
                    <select
                      value={editingTask.Assigned_Staff || ''}
                      onChange={e => setEditingTask({ ...editingTask, Assigned_Staff: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                    >
                      <option value="">Select Staff</option>
                      {assignableStaff.map(s => (
                        <option key={s.Staff_ID} value={s.Staff_ID}>
                          {s.Name} ({s.Role || s.Department})
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })()}
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
                  className="px-5 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-bold shadow-sm"
                >
                  Save
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
                        {(contact.designation || contact.phone) && (
                          <p className="text-[11px] text-slate-500">
                            {contact.designation ? `${contact.designation} • ` : ''}
                            <a href={`tel:${formatDialerNumber(cleanPhone)}`} className="text-emerald-600 hover:text-emerald-700 font-bold hover:underline">
                              {contact.phone}
                            </a>
                          </p>
                        )}
                      </div>

                      {contactModal.mode === 'CALL' ? (
                        <a href={`tel:${formatDialerNumber(cleanPhone)}`} onClick={() => {
                          if (contactModal.task) triggerQuickInteraction('Call', contactModal.task, contact.name);
                          setContactModal({ isOpen: false, mode: 'CALL', customer: null, task: null });
                        }} className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-sm">
                          <PhoneCall className="w-3.5 h-3.5" />
                          Call Now
                        </a>
                      ) : (
                        <div className="space-y-2">
                          {(() => {
                            const handleWaLinkClick = () => {
                              if (contactModal.task) triggerQuickInteraction('WhatsApp', contactModal.task, contact.name);
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
    </div>
  );
}
