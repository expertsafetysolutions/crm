import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';

/**
 * CollapsibleSection — the auto-hide primitive the workshop forms are built from.
 *
 * A technician filling ten cylinders on a phone should never scroll past nine completed forms to
 * reach the tenth. Once a section has everything it needs it folds itself into a one-line summary;
 * tapping that line opens it again for editing. One implementation, so every module behaves the
 * same way rather than each page inventing its own accordion.
 *
 * Auto-collapse only fires on the transition into completeness, never on every render — otherwise
 * a section would slam shut while someone was still correcting a field inside it.
 *
 * Props:
 *   summary        node rendered on the collapsed row (identity facts only)
 *   isComplete     when it flips true the section folds itself
 *   autoCollapse   set false for sections the user should keep open regardless
 *   open/onToggle  optional control from a parent for accordion behaviour
 *   tone           'default' | 'warning' | 'danger' — the left status rail
 */
export default function CollapsibleSection({
  summary,
  children,
  isComplete = false,
  autoCollapse = true,
  defaultOpen = true,
  open: controlledOpen,
  onToggle,
  tone = 'default',
  badge = null,
  className = ''
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  // Tracks the previous completeness so the fold happens on the false -> true edge only.
  const wasComplete = useRef(isComplete);

  useEffect(() => {
    if (autoCollapse && isComplete && !wasComplete.current) {
      if (isControlled) onToggle?.(false);
      else setUncontrolledOpen(false);
    }
    wasComplete.current = isComplete;
  }, [isComplete, autoCollapse, isControlled, onToggle]);

  const toggle = () => {
    if (isControlled) onToggle?.(!isOpen);
    else setUncontrolledOpen(v => !v);
  };

  const rail = tone === 'danger'
    ? 'border-l-rose-500'
    : tone === 'warning'
      ? 'border-l-amber-500'
      : isComplete
        ? 'border-l-emerald-500'
        : 'border-l-slate-300';

  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 ${rail} bg-white shadow-sm overflow-hidden ${className}`}>
      {/* 48px minimum so it stays tappable one-handed on a phone. */}
      <button
        type="button"
        onClick={toggle}
        className="w-full min-h-[48px] px-3 py-2 flex items-center gap-2 text-left active:bg-slate-50 transition"
        aria-expanded={isOpen}
      >
        {isComplete && (
          <span className="shrink-0 w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
            <Check className="w-3 h-3" strokeWidth={3} />
          </span>
        )}
        <div className="flex-1 min-w-0">{summary}</div>
        {badge}
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="px-3 pb-3 pt-1 border-t border-slate-100 animate-fadeIn motion-reduce:animate-none">
          {children}
        </div>
      )}
    </div>
  );
}
