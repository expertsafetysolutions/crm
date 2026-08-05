import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getOfflineQueue, flushOfflineQueue } from '../utils/offlineQueue';
import { subscribeToPush, unsubscribeFromPush } from '../utils/pushNotifications';

const AuthContext = createContext();

// ── Helpers to safely read/write localStorage ──────────────────────────────
// Profile photos are large base64 strings (~100–300 KB). Storing them inside
// the user JSON blob can silently fail when the overall localStorage size
// approaches the 5 MB browser limit. We therefore keep the photo in its own
// dedicated key so that even if the main user record omits it we can still
// restore it reliably.

const PHOTO_KEY = 'expert_safety_profile_photo';
const USER_KEY = 'expert_safety_user';
const TOKEN_KEY = 'expert_safety_token';
const IMPERSON_KEY = 'expert_safety_impersonation';
const DEVICE_KEY = 'expert_safety_device_id';

/**
 * A stable random id for this browser profile, minted once and kept.
 *
 * It identifies a BROWSER, not a machine: clearing site data or opening a private window looks
 * like a new device and will ask for a code once. That is inherent to storing it client-side.
 *
 * It is not a credential and grants nothing on its own — the server only uses it to decide
 * whether to demand the emailed second factor, which still requires the correct password first.
 */
function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Private mode with storage blocked: fall back to a per-session id. The user is asked for a
    // code each time, which is correct — we genuinely cannot recognise this browser again.
    return `ephemeral-${Math.random().toString(36).slice(2)}`;
  }
}

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

  // Dev-only convenience: on localhost, with no session already saved, try the server's
  // dev-auto-login route before ever painting the Login screen — so a dev machine never has to
  // type Staff ID/password/OTP. The route itself 404s unless the server ALSO has NODE_ENV !==
  // 'production' AND DEV_AUTO_LOGIN_STAFF_ID set, so this is inert against the deployed backend
  // even if a build somehow shipped with this code (hostname check is the second, independent
  // gate — belt and suspenders, since only one of the two needs to hold for real users to be safe).
  const [autoLoginPending, setAutoLoginPending] = useState(() => {
    const isLocalhost = typeof window !== 'undefined' &&
      ['localhost', '127.0.0.1'].includes(window.location.hostname);
    return isLocalhost && !localStorage.getItem(TOKEN_KEY);
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

    // Returning user with an already-valid token from a previous session (page reload, not a
    // fresh login): re-register the push subscription only if permission was already granted
    // earlier — never trigger a fresh browser permission prompt outside the login action.
    const existingToken = localStorage.getItem(TOKEN_KEY);
    if (existingToken && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      subscribeToPush(existingToken);
    }

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
      body: JSON.stringify({ staffId, password, deviceId: getDeviceId() })
    });
    const data = await res.json();

    // 202 = credentials accepted, but this browser has not been used before and the server is
    // waiting for the emailed code. Surfaced as a value rather than an Error because it is a
    // normal step in the flow, not a failure — the Login page switches to the code prompt.
    if (res.status === 202 && data.otpRequired) {
      return { otpRequired: true, staffId: data.staffId, message: data.message };
    }

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    return establishSession(data);
  };

  /**
   * Completes a sign-in from a successful /login or /verify-otp payload.
   * Shared so a session created after an OTP is identical to a direct one.
   */
  const establishSession = async (data) => {
    // A response without a token means the server and this bundle disagree about the login
    // protocol — which is exactly what a stale service-worker cache produces after the auth flow
    // changes. Throwing a plain Error here is caught by the Login page and shown as a message;
    // proceeding would store `undefined` as the token and crash the tree on the next render,
    // which is what closed the tab.
    if (!data || !data.token || !data.user) {
      throw new Error('Sign-in could not be completed. Please reload the page and try again.');
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

    // Fire-and-forget: prompts for notification permission and registers the push
    // subscription. Never blocks login if the browser denies/lacks push support.
    subscribeToPush(data.token);

    return data.user;
  };

  // Runs once, only when autoLoginPending started true (localhost + no saved session). A 404
  // means the server-side gate is closed (production, or DEV_AUTO_LOGIN_STAFF_ID unset) — that is
  // the expected result on every deployed environment, so it falls through to the normal Login
  // screen silently rather than surfacing an error.
  useEffect(() => {
    if (!autoLoginPending) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/dev-auto-login');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) await establishSession(data);
      } catch (e) {
        // Offline or server not running yet — fall through to the normal login screen.
      } finally {
        if (!cancelled) setAutoLoginPending(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Second step of a new-device sign-in: exchange the emailed code for a session. */
  const verifyOtp = async (staffId, password, code) => {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, password, code, deviceId: getDeviceId() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not verify the code');
    return establishSession(data);
  };

  const logout = () => {
    isLoggedOutRef.current = true;
    // Best-effort: remove this device's push subscription before the token it needs to
    // authenticate the removal call is cleared below.
    if (token) unsubscribeFromPush(token);
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
    // ONE navigation, not two. This previously called replace('/') and then reload() back to back;
    // the second call fires while the first navigation is already in flight, and Chrome can treat
    // that as an unstable page and discard the tab outright rather than land on the login screen.
    // replace() alone both leaves the current route and drops it from history, which is all logout
    // needs — the fresh document load re-runs AuthProvider with the cleared localStorage.
    window.location.replace('/');
  };

  const startImpersonating = useCallback((staffObj) => {
    setImpersonatedStaff(staffObj);
    localStorage.setItem(IMPERSON_KEY, JSON.stringify(staffObj));
  }, []);

  const stopImpersonating = useCallback(() => {
    setImpersonatedStaff(null);
    localStorage.removeItem(IMPERSON_KEY);
  }, []);

  // ── Effective permissions ───────────────────────────────────────────────────────────────────
  // Resolved server-side (role defaults + per-staff overrides) and delivered on /login and /me, so
  // refreshUserProfile() keeps it current without a re-login.
  const permissions = (impersonatedStaff || user)?.Effective_Permissions || null;

  /**
   * Whether the current viewer may see money — rates, amounts, discounts, taxes, totals.
   *
   * The AND across both identities is deliberate. Impersonation swaps the displayed user but does
   * NOT re-issue the token, so the backend still authenticates as the real Admin and keeps sending
   * prices. That means:
   *   - impersonation can never GRANT prices a real user lacks (the real user's flag gates it), and
   *   - an Admin previewing a Technician sees the masked screen the Technician actually gets.
   *
   * This is an honest preview, not a privilege drop. An Admin genuinely holds this data; hiding it
   * here is a UI courtesy. Anything needing a real privilege drop must re-issue a scoped token.
   *
   * A profile cached before this field existed has no map at all. Rather than hide prices from the
   * office staff who have always seen them — a wrong-direction failure that would look like a bug,
   * and which an OFFLINE user could not clear, since /me needs a connection — an absent map falls
   * back to the roles that were price-visible before this feature shipped. The next /me overwrites
   * it with the real answer.
   */
  const LEGACY_PRICE_ROLES = new Set(['admin', 'sales', 'supervisor', 'accounts']);
  const canSeeFinance = (profile) => {
    const map = profile?.Effective_Permissions;
    if (map?.finance) return Boolean(map.finance.view);
    return LEGACY_PRICE_ROLES.has(String(profile?.Role || '').trim().toLowerCase());
  };
  const canSeeMoney = canSeeFinance(user)
    && (!impersonatedStaff || canSeeFinance(impersonatedStaff));

  return (
    <AuthContext.Provider
      value={{
        user: impersonatedStaff || user,
        realUser: user,
        impersonatedStaff,
        permissions,
        canSeeMoney,
        token,
        autoLoginPending,
        isOnline,
        pendingSyncCount,
        isSyncing,
        login,
        verifyOtp,
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
