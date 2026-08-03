import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { getStepsForRole } from './tourSteps';

const TourContext = createContext(null);

export function TourProvider({ children }) {
  const { user, realUser, permissions } = useAuth();
  const [isActive, setIsActive] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [language, setLanguage] = useState('gu');

  const effectiveUser = realUser || user;
  const role = effectiveUser?.Role;

  const steps = useMemo(() => {
    if (!role) return [];
    return getStepsForRole(role, permissions);
  }, [role, permissions]);

  const start = useCallback((forRole) => {
    setCurrentStepIndex(0);
    setIsActive(true);
    // forRole is accepted for API clarity at call sites (Navbar knows isAdmin) but the actual
    // script is always derived from the real role/permissions above, so an impersonated admin
    // never gets shown the Admin script just because a stale caller passed 'Admin'.
    void forRole;
  }, []);

  const stop = useCallback(() => setIsActive(false), []);

  const next = useCallback(() => {
    setCurrentStepIndex(i => {
      if (i + 1 >= steps.length) {
        setIsActive(false);
        return i;
      }
      return i + 1;
    });
  }, [steps.length]);

  const back = useCallback(() => {
    setCurrentStepIndex(i => Math.max(0, i - 1));
  }, []);

  const skip = useCallback(() => setIsActive(false), []);

  const toggleLanguage = useCallback(() => {
    setLanguage(l => (l === 'en' ? 'gu' : 'en'));
  }, []);

  // First-run auto-start: fires once per user, flag set immediately (not on completion) so a
  // refresh mid-tour never re-triggers it. Manual "Start Guided Tour" never touches this flag.
  useEffect(() => {
    if (!effectiveUser || steps.length === 0) return;
    const userIdKey = effectiveUser?.Staff_ID || effectiveUser?.id || 'default';
    const seenKey = `expert_safety_tour_seen_${userIdKey}`;
    if (localStorage.getItem(seenKey)) return;
    localStorage.setItem(seenKey, '1');
    const timer = setTimeout(() => {
      setCurrentStepIndex(0);
      setIsActive(true);
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUser?.Staff_ID, effectiveUser?.id, steps.length]);

  const value = useMemo(() => ({
    isActive,
    currentStepIndex,
    steps,
    language,
    start,
    stop,
    next,
    back,
    skip,
    toggleLanguage,
  }), [isActive, currentStepIndex, steps, language, start, stop, next, back, skip, toggleLanguage]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within a TourProvider');
  return ctx;
}
