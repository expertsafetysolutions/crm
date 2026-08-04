import React, { useState, useEffect, useRef } from 'react';
import { X, ChevronLeft, ChevronRight, Languages } from 'lucide-react';
import { useTour } from './TourContext';
import { TOUR_STRINGS } from './tourStrings';

const FIND_RETRY_MS = 150;
// Generous on purpose: right after login the dashboard is often still fetching its task/customer
// list, so the first real target (e.g. the first task card) may not exist for several seconds.
// The old 1.8s timeout used to fire mid-fetch and silently auto-skip the step — which looked
// exactly like "the tour is running itself" because nothing was shown while it waited or when it
// gave up. This version shows a visible waiting card instead of blank nothing, and skipping now
// requires deliberately tapping Skip on that waiting card — never an automatic silent jump.
const FIND_TIMEOUT_MS = 8000;
const SCROLL_SETTLE_MS = 350;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// A matched element that is display:none (e.g. Navbar's view-switcher pill, which is `hidden
// md:flex` on mobile) still satisfies querySelector — CSS visibility doesn't affect DOM presence
// — but getBoundingClientRect() on it returns an all-zero rect. Treating that as "found" used to
// draw a zero-size spotlight, i.e. no visible ring anywhere on screen.
function isRenderedSize(r) {
  return r.width > 0 && r.height > 0;
}

// Polls for the target element, dispatching the tab/popup/expand events a step declares first.
// Reports 'waiting' while still searching (shown to the user, never hidden) and 'timeout' only
// once the generous window above elapses — at which point the user decides whether to skip, not
// the timer.
function useStepTarget(step) {
  const [rect, setRect] = useState(null);
  const [status, setStatus] = useState('waiting'); // 'waiting' | 'found' | 'timeout'
  const elRef = useRef(null);

  useEffect(() => {
    if (!step) return undefined;
    setRect(null);
    setStatus('waiting');
    elRef.current = null;

    if (step.requiresTab) {
      window.dispatchEvent(new CustomEvent('TOUR_NAVIGATE_TAB', { detail: { tab: step.requiresTab } }));
    }
    if (step.requiresPopup === 'PROFILE_POPUP') {
      window.dispatchEvent(new CustomEvent('OPEN_STAFF_PROFILE_POPUP'));
    }
    if (step.requiresExpand) {
      window.dispatchEvent(new CustomEvent('TOUR_EXPAND_TARGET', { detail: { expandId: step.requiresExpand } }));
    }

    let cancelled = false;
    const startedAt = Date.now();

    const measure = (el) => {
      const r = el.getBoundingClientRect();
      if (cancelled) return;
      if (!isRenderedSize(r)) return false;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      setStatus('found');
      return true;
    };

    const tryFind = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${step.id}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        if (isRenderedSize(r)) {
          elRef.current = el;
          el.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          setTimeout(() => {
            if (cancelled) return;
            if (!measure(el)) setTimeout(tryFind, FIND_RETRY_MS);
          }, prefersReducedMotion() ? 0 : SCROLL_SETTLE_MS);
          return;
        }
        // Element exists in the DOM but renders at zero size right now (hidden by a responsive
        // class, an ancestor mid-collapse, etc.) — keep polling instead of treating it as found.
      }
      if (Date.now() - startedAt > FIND_TIMEOUT_MS) {
        if (!cancelled) setStatus('timeout');
        return;
      }
      setTimeout(tryFind, FIND_RETRY_MS);
    };

    // No target step (e.g. the centered welcome step) — nothing to find or measure.
    if (step.placement === 'center') {
      setStatus('found');
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
      if (!isRenderedSize(r)) return;
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, { passive: true });
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure);
    };
  }, [rect === null]);

  return { rect, status };
}

function TooltipCard({ step, rect, language, i, total, onNext, onBack, onSkip, onToggleLanguage, waiting }) {
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

      {waiting ? (
        <div className="py-2 flex items-center gap-2.5">
          <span className="w-4 h-4 rounded-full border-2 border-rose-200 border-t-rose-600 animate-spin shrink-0" />
          <p className="text-xs text-slate-500 font-semibold">{t.locating}</p>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-extrabold text-slate-900">{step.title[language]}</h3>
          <p className="text-xs text-slate-600 font-medium mt-1 leading-relaxed">{step.body[language]}</p>
        </div>
      )}

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
          disabled={waiting}
          className="min-h-[48px] flex-1 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm flex items-center justify-center gap-1 shadow-sm transition disabled:opacity-40"
        >
          {waiting ? t.skip : (i + 1 === total ? t.done : t.next)}
          {!waiting && i + 1 !== total && <ChevronRight className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

export default function TourOverlay() {
  const { isActive, currentStepIndex, steps, language, next, back, skip, toggleLanguage } = useTour();
  const step = isActive ? steps[currentStepIndex] : null;
  const { rect, status } = useStepTarget(step);
  const reducedMotion = prefersReducedMotion();

  if (!isActive || !step) return null;

  // 'timeout' means the target genuinely never appeared inside the generous window — the user is
  // shown the same waiting card with an active Skip button rather than the tour silently jumping
  // ahead on its own. Nothing here ever calls next()/skip() without a tap.
  const waiting = status === 'waiting' || status === 'timeout';
  const hasSpotlight = step.placement !== 'center' && status === 'found' && rect;
  const backdropTransition = reducedMotion ? '' : 'transition-all duration-200';

  return (
    <div className="fixed inset-0 z-[100]" aria-live="polite">
      {hasSpotlight ? (
        <>
          <div className={`fixed left-0 right-0 top-0 bg-black/60 ${backdropTransition}`} style={{ height: Math.max(0, rect.top - 4) }} />
          <div className={`fixed left-0 right-0 bg-black/60 ${backdropTransition}`} style={{ top: rect.top + rect.height + 4, bottom: 0 }} />
          <div className={`fixed bg-black/60 ${backdropTransition}`} style={{ top: rect.top - 4, height: rect.height + 8, left: 0, width: Math.max(0, rect.left - 4) }} />
          <div className={`fixed bg-black/60 ${backdropTransition}`} style={{ top: rect.top - 4, height: rect.height + 8, left: rect.left + rect.width + 4, right: 0 }} />
          {/* Transparent cutout-cover: the 4 backdrop rects above only dim OUTSIDE the spotlight,
              so without this the real element underneath (e.g. the Conversation icon button) is
              still fully clickable through the "hole." Tapping it opened a modal the tour has no
              awareness of — the tour's own Done/Skip would then close leaving that modal (and the
              browser history entry its own back-button handling pushed) stranded. The tour is
              meant to be look-only; Next/Back/Skip are the only supposed to drive it. */}
          <div
            className="fixed"
            style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
          />
          {/* A solid border here instead of a Tailwind `ring-*` class: ring utilities are
              implemented as box-shadow, and this element also needs an inline boxShadow for the
              soft glow — the inline style silently overwrote the Tailwind ring's box-shadow
              (same CSS property, inline wins), so the ring itself never actually rendered even
              though status/rect were correct. A real border can't be clobbered that way. */}
          <div
            className={`fixed rounded-xl border-2 border-rose-500 pointer-events-none ${backdropTransition}`}
            style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8, boxShadow: '0 0 0 4px rgba(225,29,72,0.35)' }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60" />
      )}

      <TooltipCard
        step={step}
        rect={hasSpotlight ? rect : null}
        language={language}
        i={currentStepIndex}
        total={steps.length}
        onNext={next}
        onBack={back}
        onSkip={skip}
        onToggleLanguage={toggleLanguage}
        waiting={waiting}
      />
    </div>
  );
}
