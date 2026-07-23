import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { Wifi, WifiOff, RefreshCw, User, LayoutDashboard, Briefcase, HelpCircle, PhoneCall, Bell, CheckCircle2, AlertCircle, Clock, X, Info } from 'lucide-react';
import { formatDateDDMMYYYY, getLocalTimeStr } from '../utils/dateUtils';

// __APP_BUILD_TIME__ is injected by Vite at build time (see vite.config.js `define`) — always
// reflects the actual last deployment, no manual date to keep updated.
const APP_LAST_UPDATED_DATE = formatDateDDMMYYYY(__APP_BUILD_TIME__);
const APP_LAST_UPDATED_TIME = getLocalTimeStr(new Date(__APP_BUILD_TIME__));

export default function Navbar({ currentView, setCurrentView }) {
  const { user, realUser, stopImpersonating, logout, isOnline, pendingSyncCount, syncOfflineData, refreshUserProfile } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  const fetchNotifications = useCallback(async () => {
    if (!user && !realUser) return;
    try {
      const res = await fetch('/api/notifications/my', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('expert_safety_token')}` }
      });
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (Array.isArray(data?.notifications) ? data.notifications : []);
        const userIdKey = (realUser || user)?.Staff_ID || (realUser || user)?.id || 'default';
        const dismissedKey = `expert_safety_dismissed_notifs_${userIdKey}`;
        const dismissedIds = JSON.parse(localStorage.getItem(dismissedKey) || '[]');
        const activeList = list.filter(item => !dismissedIds.includes(item.id));
        setNotifications(activeList);
        const readKey = `expert_safety_read_notifs_${userIdKey}`;
        const lastReadCount = parseInt(localStorage.getItem(readKey) || '0', 10);
        if (activeList.length > lastReadCount && activeList.length > 0) {
          setHasUnread(true);
        } else if (activeList.length === 0) {
          setHasUnread(false);
        }
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    }
  }, [user?.Staff_ID, user?.id, realUser?.Staff_ID, realUser?.id]);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  const handleMarkAllRead = () => {
    const userIdKey = (realUser || user)?.Staff_ID || (realUser || user)?.id || 'default';
    const dismissedKey = `expert_safety_dismissed_notifs_${userIdKey}`;
    const dismissedIds = JSON.parse(localStorage.getItem(dismissedKey) || '[]');
    const currentIds = notifications.map(item => item.id).filter(Boolean);
    const updatedDismissed = Array.from(new Set([...dismissedIds, ...currentIds]));
    localStorage.setItem(dismissedKey, JSON.stringify(updatedDismissed.slice(-1000)));

    const readKey = `expert_safety_read_notifs_${userIdKey}`;
    localStorage.setItem(readKey, '0');
    setHasUnread(false);
    setNotifications([]);
    setShowNotifications(false);
  };

  const handleNotificationClick = (n) => {
    // 1. Immediately dismiss/remove this specific notification on tap
    const userIdKey = (realUser || user)?.Staff_ID || (realUser || user)?.id || 'default';
    const dismissedKey = `expert_safety_dismissed_notifs_${userIdKey}`;
    const dismissedIds = JSON.parse(localStorage.getItem(dismissedKey) || '[]');
    if (n.id && !dismissedIds.includes(n.id)) {
      const updatedDismissed = [...dismissedIds, n.id];
      localStorage.setItem(dismissedKey, JSON.stringify(updatedDismissed.slice(-1000)));
    }
    setNotifications(prev => {
      const updated = prev.filter(item => item.id !== n.id);
      if (updated.length === 0) setHasUnread(false);
      return updated;
    });
    setShowNotifications(false);

    // 2. Identify targetType and reference ID dynamically (fallback to regex if not explicit)
    let targetType = n.targetType;
    let targetId = n.targetId;

    if (!targetId || !targetType) {
      const fullText = `${n.title || ''} ${n.message || ''} ${n.id || ''}`;
      const taskMatch = fullText.match(/TASK\d+/i);
      const leaveMatch = fullText.match(/LEAVE\d+/i);
      const staffMatch = fullText.match(/STAFF\d+/i);

      if (taskMatch) {
        targetType = 'TASK';
        targetId = taskMatch[0].toUpperCase();
      } else if (leaveMatch || n.id?.startsWith('leave') || n.id?.startsWith('leavereminder') || n.id?.startsWith('myleave')) {
        targetType = 'LEAVE';
        targetId = leaveMatch ? leaveMatch[0].toUpperCase() : n.id?.split('-')[1];
      } else if (staffMatch || n.id?.startsWith('photo') || n.id?.startsWith('myphoto')) {
        targetType = 'STAFF';
        targetId = staffMatch ? staffMatch[0].toUpperCase() : n.id?.split('-')[1];
      } else if (n.id?.startsWith('adv-')) {
        targetType = 'ADVANCE';
        targetId = n.id?.split('-')[1];
      }
    }

    // 3. Switch active view/role if needed when clicking from admin mode
    const isAdminUser = (realUser || user)?.Role === 'Admin';
    if (isAdminUser && setCurrentView) {
      if (currentView !== 'admin' && !localStorage.getItem('expert_safety_impersonation')) {
        setCurrentView('admin');
      }
    }

    // 4. Route/navigate by dispatching exact event handled across Staff and Admin Dashboards
    window.dispatchEvent(
      new CustomEvent('NAVIGATE_TO_TARGET', {
        detail: {
          targetType: targetType || 'TASK',
          targetId: targetId,
          action: n.action || 'VIEW',
          notification: n
        }
      })
    );
  };

  if (!user && !realUser) return null;

  const isAdmin = realUser?.Role === 'Admin' || user?.Role === 'Admin';
  const userPhoto = user?.Profile_Photo || user?.Pending_Photo_Request || user?.ProfilePhoto || user?.profilePhoto || user?.Photo || '';

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between">
        {/* Brand & Logo */}
        <div className="flex items-center space-x-2 sm:space-x-3 min-w-0">
          <div className="flex items-center justify-center p-1 rounded-xl bg-white border border-slate-200 shadow-sm shrink-0">
            <img src="/logo.jpg" alt="Expert Safety Solutions" className="h-8 sm:h-10 w-auto object-contain" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-lg font-bold tracking-tight text-slate-900 flex items-center gap-2 truncate">
              Expert Safety Solutions
            </h1>
            <p className="text-[10px] sm:text-xs text-slate-500 block">Task Management System</p>
          </div>
        </div>

        {/* View Switcher for Admins */}
        {isAdmin && (
          <div className="hidden md:flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => {
                if (stopImpersonating) stopImpersonating();
                setCurrentView('admin');
              }}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all ${
                currentView === 'admin' && !localStorage.getItem('expert_safety_impersonation')
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              Admin Control
            </button>
            <button
              onClick={() => setCurrentView('staff')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-all ${
                currentView === 'staff' || localStorage.getItem('expert_safety_impersonation')
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5" />
              User Dashboard
            </button>
          </div>
        )}

        {/* Status Indicators & User Profile */}
        <div className="flex items-center space-x-1 sm:space-x-3.5">
          {/* Help Button with Direct Contact Popover */}
          <div className="group relative hidden sm:flex items-center">
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold transition shadow-2xs"
            >
              <HelpCircle className="w-3.5 h-3.5 text-rose-600" />
              <span>Help</span>
            </button>

            {/* Hover Support Card */}
            <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-2xl shadow-xl border border-slate-200 p-3.5 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 space-y-2.5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-700">Direct Support Lines</span>
                <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-bold">Expert Safety</span>
              </div>
              <div className="space-y-1.5">
                <a
                  href="tel:8460699569"
                  className="flex items-center justify-between p-2 rounded-xl bg-slate-50 hover:bg-rose-50 border border-slate-200 hover:border-rose-300 transition group/item"
                >
                  <div className="flex items-center gap-2">
                    <PhoneCall className="w-3.5 h-3.5 text-rose-600" />
                    <span className="text-xs font-bold text-slate-800 group-hover/item:text-rose-700">Director</span>
                  </div>
                  <span className="text-xs font-extrabold text-rose-600">8460 699 569</span>
                </a>

                <a
                  href="tel:9429980244"
                  className="flex items-center justify-between p-2 rounded-xl bg-slate-50 hover:bg-rose-50 border border-slate-200 hover:border-rose-300 transition group/item"
                >
                  <div className="flex items-center gap-2">
                    <PhoneCall className="w-3.5 h-3.5 text-indigo-600" />
                    <span className="text-xs font-bold text-slate-800 group-hover/item:text-indigo-700">Office</span>
                  </div>
                  <span className="text-xs font-extrabold text-indigo-600">9429 980 244</span>
                </a>
              </div>
            </div>
          </div>

          {/* Online/Offline Badge */}
          <div
            onClick={!isOnline || pendingSyncCount > 0 ? syncOfflineData : undefined}
            className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer transition border ${
              isOnline
                ? pendingSyncCount > 0
                  ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-rose-50 text-rose-700 border-rose-200'
            }`}
            title={isOnline ? 'Connected to Server' : 'Offline Mode Active'}
          >
            {isOnline ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-rose-600 animate-pulse" />
            )}
            <span className="hidden sm:inline">{isOnline ? 'Online' : 'Offline Mode'}</span>
            {pendingSyncCount > 0 && (
              <span className="ml-1 px-1.5 py-0.2 rounded-full bg-amber-500 text-white font-bold text-[10px] flex items-center gap-1">
                {isSyncing && <RefreshCw className="w-2.5 h-2.5 animate-spin" />}
                {pendingSyncCount} queued
              </span>
            )}
          </div>
          {/* Mobile-only: compact online/offline indicator */}
          <div
            onClick={!isOnline || pendingSyncCount > 0 ? syncOfflineData : undefined}
            className={`sm:hidden flex items-center justify-center w-7 h-7 rounded-full cursor-pointer transition border ${
              isOnline
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-rose-50 border-rose-200'
            }`}
            title={isOnline ? 'Online' : 'Offline'}
          >
            {isOnline ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <WifiOff className="w-3 h-3 text-rose-600 animate-pulse" />
            )}
          </div>

          {/* Notification Bell right near profile */}
          <div className="relative flex items-center">
            <button
              type="button"
              onClick={() => {
                setShowNotifications(!showNotifications);
                if (!showNotifications && hasUnread) {
                  const readKey = `expert_safety_read_notifs_${user?.Staff_ID || user?.id || 'default'}`;
                  localStorage.setItem(readKey, notifications.length.toString());
                  setHasUnread(false);
                }
              }}
              className="w-9 h-9 rounded-full bg-slate-100 hover:bg-indigo-100 border border-slate-200 hover:border-indigo-300 flex items-center justify-center text-slate-700 hover:text-indigo-600 transition shadow-sm relative"
              title="Notifications & Approvals Updates"
            >
              <Bell className="w-4 h-4" />
              {/* Small Red Dot when updates received or data added from admin/staff */}
              {(hasUnread || notifications.length > 0) && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-rose-600 rounded-full ring-2 ring-white animate-pulse" />
              )}
            </button>

            {/* Notifications Popover Dropdown */}
            {showNotifications && (
              <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 z-50 animate-fadeIn max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
                  <div className="flex items-center gap-2">
                    <Bell className="w-4 h-4 text-indigo-600" />
                    <span className="text-sm font-bold text-slate-900">Notifications & Updates</span>
                    {notifications.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold">
                        {notifications.length}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowNotifications(false)}
                    className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
                  {notifications.length === 0 ? (
                    <div className="py-8 text-center text-slate-400">
                      <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-50 text-emerald-500" />
                      <p className="text-xs font-semibold">No new updates or pending approvals.</p>
                    </div>
                  ) : (
                    notifications.map((n, idx) => (
                      <div
                        key={n.id || idx}
                        onClick={() => handleNotificationClick(n)}
                        className={`p-3 rounded-xl border text-left transition cursor-pointer hover:scale-[1.01] hover:shadow-md active:scale-[0.99] ${
                          n.type === 'SUCCESS' ? 'bg-emerald-50/70 border-emerald-200 hover:bg-emerald-100/70' :
                          n.type === 'APPROVAL_NEEDED' ? 'bg-amber-50/80 border-amber-300 shadow-2xs hover:bg-amber-100/80' :
                          n.type === 'ALERT' ? 'bg-rose-50/80 border-rose-200 hover:bg-rose-100/80' :
                          'bg-slate-50 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                            {n.type === 'SUCCESS' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                            {n.type === 'APPROVAL_NEEDED' && <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />}
                            {n.type === 'ALERT' && <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />}
                            {(!n.type || n.type === 'TASK' || n.type === 'INFO') && <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                            {n.title}
                          </p>
                          <span className="text-[10px] text-slate-400 shrink-0 font-medium">{n.time}</span>
                        </div>
                        <p className="text-xs text-slate-600 font-medium mt-1 leading-snug">
                          {n.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>

                {notifications.length > 0 && (
                  <div className="pt-3 border-t border-slate-100 mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={handleMarkAllRead}
                      className="text-xs font-bold text-indigo-600 hover:text-indigo-800 transition"
                    >
                      Mark All as Read / Dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* User badge + right side Profile Button */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 pl-1.5 sm:pl-2 border-l border-slate-200">
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-slate-800">{user.Name}</p>
              <p className="text-[10px] uppercase font-bold tracking-wider text-rose-600">{user.Role}</p>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('OPEN_STAFF_PROFILE_POPUP'))}
              className="w-9 h-9 rounded-full bg-slate-100 hover:bg-rose-100 border border-slate-200 hover:border-rose-300 flex items-center justify-center text-slate-700 hover:text-rose-600 transition shadow-sm cursor-pointer overflow-hidden relative group"
              title="Open Profile & Quick Menu"
            >
              {userPhoto ? (
                <img src={userPhoto} alt={user.Name} className="w-full h-full object-cover" />
              ) : (
                <span className="text-sm font-extrabold text-slate-700 group-hover:text-rose-600">
                  {user.Name ? user.Name.charAt(0).toUpperCase() : 'S'}
                </span>
              )}
            </button>

            {/* Hover this blank strip (right of the profile photo) to see the last app update */}
            <div className="group relative w-3 sm:w-5 h-9 shrink-0 cursor-default">
              <div className="pointer-events-none absolute right-0 top-full mt-2 whitespace-nowrap px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 shadow-md text-[11px] font-semibold text-black text-center leading-tight opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-50">
                <div className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Last Updated</div>
                <div>{APP_LAST_UPDATED_DATE}</div>
                <div>{APP_LAST_UPDATED_TIME}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Admin Mode switcher bar */}
      {isAdmin && (
        <div className="flex md:hidden border-t border-slate-200 bg-slate-50 px-4 py-2 justify-center gap-2">
          <button
            onClick={() => {
              if (stopImpersonating) stopImpersonating();
              setCurrentView('admin');
            }}
            className={`flex-1 py-1 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 ${
              currentView === 'admin' && !localStorage.getItem('expert_safety_impersonation')
                ? 'bg-rose-600 text-white shadow-sm'
                : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            Admin Dashboard
          </button>
          <button
            onClick={() => setCurrentView('staff')}
            className={`flex-1 py-1 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 ${
              currentView === 'staff' || localStorage.getItem('expert_safety_impersonation')
                ? 'bg-rose-600 text-white shadow-sm'
                : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <Briefcase className="w-3.5 h-3.5" />
            User Dashboard
          </button>
        </div>
      )}
    </header>
  );
}
