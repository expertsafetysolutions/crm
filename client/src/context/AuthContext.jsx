import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getOfflineQueue, flushOfflineQueue } from '../utils/offlineQueue';

const AuthContext = createContext();

// ── Helpers to safely read/write localStorage ──────────────────────────────
// Profile photos are large base64 strings (~100–300 KB). Storing them inside
// the user JSON blob can silently fail when the overall localStorage size
// approaches the 5 MB browser limit. We therefore keep the photo in its own
// dedicated key so that even if the main user record omits it we can still
// restore it reliably.

const PHOTO_KEY  = 'expert_safety_profile_photo';
const USER_KEY   = 'expert_safety_user';
const TOKEN_KEY  = 'expert_safety_token';
const IMPERSON_KEY = 'expert_safety_impersonation';

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn(`localStorage write failed for key "${key}":`, e.message);
  }
}

/** Persist user object WITHOUT the photo blob, then persist the photo separately. */
function persistUser(userObj) {
  if (!userObj) return;
  // Save photo separately
  const photo = userObj.Profile_Photo || '';
  if (photo) safeSet(PHOTO_KEY, photo);

  // Strip photo from the main user record to keep it small
  const { Profile_Photo, ...lean } = userObj;
  safeSet(USER_KEY, JSON.stringify(lean));
}

/** Read user from localStorage and re-attach the photo from the dedicated key. */
function readPersistedUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const userObj = JSON.parse(raw);
    const photo = localStorage.getItem(PHOTO_KEY) || '';
    if (photo) userObj.Profile_Photo = photo;
    return userObj;
  } catch (e) {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const isLoggedOutRef = useRef(false);
  const [user, setUser] = useState(readPersistedUser);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  const [impersonatedStaff, setImpersonatedStaff] = useState(() => {
    try {
      const saved = localStorage.getItem(IMPERSON_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });

  // Check offline queue count
  const updateQueueCount = useCallback(async () => {
    try {
      const queue = await getOfflineQueue();
      setPendingSyncCount(queue.length);
    } catch (e) {
      console.error('Failed to get queue count', e);
    }
  }, []);

  const updateUser = useCallback((newUserData) => {
    if (isLoggedOutRef.current || !localStorage.getItem(TOKEN_KEY)) return;
    setUser(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...newUserData };
      persistUser(updated);
      return updated;
    });
  }, []);

  // Fetch updated user profile (including Profile_Photo) from backend
  const refreshUserProfile = useCallback(async () => {
    if (isLoggedOutRef.current || !token || !isOnline || !localStorage.getItem(TOKEN_KEY)) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.user) {
          updateUser(data.user);
        }
      }
    } catch (err) {
      console.error('Error refreshing user profile:', err);
    }
  }, [token, isOnline, updateUser]);

  // Sync offline data
  const syncOfflineData = useCallback(async () => {
    if (!token || !isOnline || isSyncing) return;
    try {
      setIsSyncing(true);
      const result = await flushOfflineQueue(token);
      if (result && result.synced > 0) {
        console.log(`Successfully synced ${result.synced} offline items`);
      }
      await updateQueueCount();
    } catch (err) {
      console.error('Offline sync failed:', err);
    } finally {
      setIsSyncing(false);
    }
  }, [token, isOnline, isSyncing, updateQueueCount]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncOfflineData();
      refreshUserProfile();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', refreshUserProfile);
    updateQueueCount();
    refreshUserProfile();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', refreshUserProfile);
    };
  }, [syncOfflineData, updateQueueCount, refreshUserProfile]);

  const login = async (staffId, password) => {
    isLoggedOutRef.current = false;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, password })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    safeSet(TOKEN_KEY, data.token);
    // Persist user & photo separately so large base64 never kills the quota
    persistUser(data.user);
    localStorage.removeItem(IMPERSON_KEY);
    setToken(data.token);
    setUser(data.user);
    setImpersonatedStaff(null);

    // Immediately fetch the latest profile (ensures photo is always fresh)
    try {
      const meRes = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${data.token}` }
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData && meData.user) {
          persistUser(meData.user);
          setUser(meData.user);
        }
      }
    } catch (e) {
      // Non-fatal: the data from login is still valid
    }

    return data.user;
  };

  const logout = () => {
    isLoggedOutRef.current = true;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(IMPERSON_KEY);
    localStorage.removeItem(PHOTO_KEY);   // ← clear photo on logout too
    localStorage.removeItem('expert_safety_current_view');
    localStorage.removeItem('expert_staff_filter_status');
    localStorage.removeItem('expert_staff_active_tab');
    localStorage.removeItem('expert_staff_filter_stage');
    localStorage.removeItem('expert_admin_filter_status');
    localStorage.removeItem('expert_admin_active_tab');
    setToken(null);
    setUser(null);
    setImpersonatedStaff(null);
    window.location.replace('/');
    window.location.reload();
  };

  const startImpersonating = useCallback((staffObj) => {
    setImpersonatedStaff(staffObj);
    localStorage.setItem(IMPERSON_KEY, JSON.stringify(staffObj));
  }, []);

  const stopImpersonating = useCallback(() => {
    setImpersonatedStaff(null);
    localStorage.removeItem(IMPERSON_KEY);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: impersonatedStaff || user,
        realUser: user,
        impersonatedStaff,
        token,
        isOnline,
        pendingSyncCount,
        isSyncing,
        login,
        logout,
        updateUser,
        updateQueueCount,
        syncOfflineData,
        refreshUserProfile,
        startImpersonating,
        stopImpersonating
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
