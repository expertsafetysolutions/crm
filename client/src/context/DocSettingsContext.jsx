import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { DEFAULT_DOC_SETTINGS } from '../utils/defaultDocSettings';

const DOC_SETTINGS_CACHE_KEY = 'expert_doc_settings';

const DocSettingsContext = createContext(null);

// Deep merge: merges b into a recursively, so defaults always fill missing keys
function deepMerge(base, override) {
  if (!override) return base;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object' &&
      base[key] !== null
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else if (override[key] !== undefined) {
      result[key] = override[key];
    }
  }
  return result;
}

export function DocSettingsProvider({ children }) {
  const { token, user } = useAuth();
  const isAdmin = user?.Role === 'Admin';

  const [docSettings, setDocSettings] = useState(() => {
    // Hydrate from localStorage for instant offline access
    try {
      const cached = localStorage.getItem(DOC_SETTINGS_CACHE_KEY);
      if (cached) return deepMerge(DEFAULT_DOC_SETTINGS, JSON.parse(cached));
    } catch (e) { /* ignore */ }
    return DEFAULT_DOC_SETTINGS;
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch settings from server on mount / login. Staff fetch too — report templates and
  // checkpoint/recommendation libraries are admin-configured but consumed in the field.
  const fetchSettings = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/document-settings', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const merged = deepMerge(DEFAULT_DOC_SETTINGS, data);
        setDocSettings(merged);
        try { localStorage.setItem(DOC_SETTINGS_CACHE_KEY, JSON.stringify(merged)); } catch (e) { /* quota full */ }
      }
    } catch (err) {
      console.warn('DocSettings: failed to fetch, using cached/defaults', err);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Save full settings object to server + update local state
  const updateDocSettings = useCallback(async (patch) => {
    const next = deepMerge(docSettings, patch);
    setDocSettings(next);
    try { localStorage.setItem(DOC_SETTINGS_CACHE_KEY, JSON.stringify(next)); } catch (e) { /* quota full */ }

    if (!token || !isAdmin) return { success: false, error: 'Not authorized' };
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/document-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(next)
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Save failed');
      }
      const saved = await res.json();
      const merged = deepMerge(DEFAULT_DOC_SETTINGS, saved);
      setDocSettings(merged);
      try { localStorage.setItem(DOC_SETTINGS_CACHE_KEY, JSON.stringify(merged)); } catch (e) { /* quota full */ }
      return { success: true };
    } catch (err) {
      setSaveError(err.message);
      return { success: false, error: err.message };
    } finally {
      setIsSaving(false);
    }
  }, [docSettings, token, isAdmin]);

  return (
    <DocSettingsContext.Provider value={{ docSettings, updateDocSettings, isSaving, saveError, isLoading, refetch: fetchSettings }}>
      {children}
    </DocSettingsContext.Provider>
  );
}

export function useDocSettings() {
  const ctx = useContext(DocSettingsContext);
  if (!ctx) return { docSettings: DEFAULT_DOC_SETTINGS, updateDocSettings: async () => {}, isSaving: false, saveError: null, isLoading: false };
  return ctx;
}
