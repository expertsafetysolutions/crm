import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Languages } from 'lucide-react';
import { useTour } from './TourContext';
import { TOUR_STRINGS } from './tourStrings';

const FIND_RETRY_MS = 120;
const FIND_TIMEOUT_MS = 1800;
const SCROLL_SETTLE_MS = 350;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Polls for the target element, dispatching the tab/popup navigation events a step declares
// first. Resolves null if the element never appears (e.g. permission-gated in a way the static
// filter in tourSteps.js didn't catch) so the caller can skip the step instead of freezing a
// spotlight over empty space.
function useStepTarget(step) {
  const [rect, setRect] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const elRef = useRef(null);

  useEffect(() => {
    if (!step) return undefined;
    setRect(null);
    setNotFound(false);
    elRef.current = null;

    if (step.requiresTab) {
      window.dispatchEvent(new CustomEvent('TOUR_NAVIGATE_TAB', { detail: { tab: step.requiresTab } }));
    }
    if (step.requiresPopup === 'PROFILE_POPUP') {
      window.dispatchEvent(new CustomEvent('OPEN_STAFF_PROFILE_POPUP'));
    }

    let cancelled = false;
    const startedAt = Date.now();

    const measure = (el) => {
      const r = el.getBoundingClientRect();
      if (cancelled) return;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const tryFind = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${step.id}"]`);
      if (el) {
        elRef.current = el;
        el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        setTimeout(() => { if (!cancelled) measure(el); }, prefersReducedMotion() ? 0 : SCROLL_SETTLE_MS);
        return;
      }
      if (Date.now() - startedAt > FIND_TIMEOUT_MS) {
        if (!cancelled) setNotFound(true);
        return;
      }
      setTimeout(tryFind, FIND_RETRY_MS);
    };

    // No target step (e.g. the centered welcome step) — nothing to find or measure.
    if (step.placement === 'center') {
      return () => { cancelled = true; };
    }

    tryFind();
    return () => { cancelled = true; };
  }, [step]);

  // Re-measure on resize/scroll so rotating a phone or manual scrolling doesn't leave a stale
  // spotlight behind.
  useEffect(() => {
    if (!elRef.current) return undefined;
    const remeasure = () => {
      if (!elRef.current) return;
      const r = elRef.current.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, { passive: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure);
    };
  }, [rect === null]);

  return { rect, notFound };
}

function TooltipCard({ step, rect, language, i, total, onNext, onBack, onSkip, onToggleLanguage }) {
  const t = TOUR_STRINGS[language];
  const isCentered = step.placement === 'center' || !rect;

  let style = {};
  if (!isCentered && rect) {
    const margin = 12;
    const cardWidth = Math.min(320, window.innerWidth - margin * 2);
    let top;
    let placement = step.placement || 'bottom';
    const spaceBelow = window.innerHeight - (rect.top + rect.height);
    const spaceAbove = rect.top;
    if (placement === 'bottom' && spaceBelow < 160 && spaceAbove > spaceBelow) placement = 'top';
    if (placement === 'top' && spaceAbove < 160 && spaceBelow > spaceAbove) placement = 'bottom';

    if (placement === 'top') {
      top = rect.top - margin;
      style.transform = 'translateY(-100%)';
    } else if (placement === 'left') {
      top = rect.top + rect.height / 2;
      style.transform = 'translateY(-50%)';
    } else {
      top = rect.top + rect.height + margin;
    }

    let left = rect.left + rect.width / 2 - cardWidth / 2;
    if (placement === 'left') left = rect.left - cardWidth - margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - cardWidth - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - margin));

    style = { ...style, position: 'fixed', top, left, width: cardWidth };
  } else {
    style = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: Math.min(340, window.innerWidth - 32),
    };
  }

  return (
    <div
      style={style}
      className="z-[101] bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 space-y-3 animate-fadeIn"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600">
          {t.stepOf(i + 1, total)}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleLanguage}
            className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-600 transition"
            title="EN / ગુ"
          >
            <Languages className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition"
            title={t.skip}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-extrabold text-slate-900">{step.title[language]}</h3>
        <p className="text-xs text-slate-600 font-medium mt-1 leading-relaxed">{step.body[language]}</p>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          disabled={i === 0}
          className="min-h-[44px] px-3 rounded-xl bg-slate-100 text-slate-700 font-bold text-xs flex items-center gap-1 disabled:opacity-0 disabled:pointer-events-none transition"
        >
          <ChevronLeft className="w-4 h-4" />
          {t.back}
        </button>
        <button
          type="button"
          onClick={onNext}
          className="min-h-[48px] flex-1 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm flex items-center justify-center gap-1 shadow-sm transition"
        >
          {i + 1 === total ? t.done : t.next}
          {i + 1 !== total && <ChevronRight className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export default function TourOverlay() {
  const { isActive, currentStepIndex, steps, language, next, back, skip, toggleLanguage } = useTour();
  const step = isActive ? steps[currentStepIndex] : null;
  const { rect, notFound } = useStepTarget(step);
  const reducedMotion = prefersReducedMotion();

  // A permission-filtered step whose element still never mounts (e.g. conditionally rendered on
  // something the static permission filter didn't cover) is skipped automatically rather than
  // shown as a broken/empty spotlight. Keyed per step index so navigating Back into a
  // previously-skipped step re-arms the auto-skip instead of leaving the tour stuck rendering
  // nothing (skippingRef would otherwise still read true from the earlier forward pass).
  const skippingRef = useRef(null);
  useEffect(() => {
    if (notFound && skippingRef.current !== currentStepIndex) {
      skippingRef.current = currentStepIndex;
      next();
    }
  }, [notFound, next, currentStepIndex]);

  if (!isActive || !step || notFound) return null;

  const hasSpotlight = step.placement !== 'center' && rect;
  const backdropTransition = reducedMotion ? '' : 'transition-all duration-200';

  return (
    <div className="fixed inset-0 z-[100]" aria-live="polite">
      {hasSpotlight ? (
        <>
          <div className={`fixed left-0 right-0 top-0 bg-black/60 ${backdropTransition}`} style={{ height: Math.max(0, rect.top - 4) }} />
          <div className={`fixed left-0 right-0 bg-black/60 ${backdropTransition}`} style={{ top: rect.top + rect.height + 4, bottom: 0 }} />
          <div className={`fixed bg-black/60 ${backdropTransition}`} style={{ top: rect.top - 4, height: rect.height + 8, left: 0, width: Math.max(0, rect.left - 4) }} />
          <div className={`fixed bg-black/60 ${backdropTransition}`} style={{ top: rect.top - 4, height: rect.height + 8, left: rect.left + rect.width + 4, right: 0 }} />
          <div
            className={`fixed rounded-xl ring-2 ring-rose-500 pointer-events-none ${backdropTransition}`}
            style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: '0 0 0 4px rgba(225,29,72,0.25)' }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60" />
      )}

      <TooltipCard
        step={step}
        rect={rect}
        language={language}
        i={currentStepIndex}
        total={steps.length}
        onNext={next}
        onBack={back}
        onSkip={skip}
        onToggleLanguage={toggleLanguage}
      />
    </div>
  );
}
