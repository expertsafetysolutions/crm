import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Check } from 'lucide-react';
import { filterByQuery, rankByQuery, highlightSegments } from '../utils/searchUtils';

/**
 * SmartSearchSelect — the picker for customers, items, vendors and anything else with a long list.
 *
 * `<datalist>` is what the forms reached for first, and it has two problems that matter here: it can
 * only match a prefix, and it cannot show anything but the value — no company code, no city, no
 * "already low on stock". On a phone the native dropdown is also inconsistent between browsers.
 *
 * This matches ANYWHERE and in ANY WORD ORDER (see searchUtils), highlights what the user typed so
 * they can see WHY a row matched, and renders each option as a 48px row with a subtitle. Keyboard
 * arrows for the desk, big touch rows for the field.
 *
 * Props:
 *   options       array of rows
 *   value         currently selected row (or null)
 *   onChange      (row) => void, called with null when cleared
 *   getLabel      row => primary text          (required)
 *   getSubtitle   row => secondary line        (optional)
 *   getKey        row => stable key            (defaults to the label)
 *   getSearchable row => array of fields to search (defaults to label + subtitle)
 *   allowFreeText when true, whatever is typed can be committed even with no match — for fields
 *                 where the catalogue is incomplete and blocking entry would be worse
 */
export default function SmartSearchSelect({
  options = [],
  value = null,
  onChange,
  getLabel,
  getSubtitle,
  getKey,
  getSearchable,
  label,
  placeholder = 'Type to search…',
  disabled = false,
  allowFreeText = false,
  emptyText = 'Nothing matches that.',
  className = ''
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);

  const keyOf = getKey || (row => getLabel(row));
  const fieldsOf = getSearchable || (row => [getLabel(row), getSubtitle ? getSubtitle(row) : '']);

  const matches = useMemo(() => {
    if (!query.trim()) return options.slice(0, 50);
    const found = filterByQuery(options, query, fieldsOf);
    // Cap the list: past ~50 rows nobody is scanning, they type another word instead.
    return rankByQuery(found, query, getLabel).slice(0, 50);
  }, [options, query]);

  // Reset the highlight whenever the result set changes, or Enter picks a stale row.
  useEffect(() => { setCursor(0); }, [query]);

  // Close on an outside tap. Pointerdown rather than click so it fires before a focus change.
  useEffect(() => {
    if (!open) return;
    const away = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Keep the highlighted row in view during arrow-key navigation.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const commit = (row) => {
    onChange?.(row);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return; }
    if (!open) return;

    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[cursor]) commit(matches[cursor]);
      else if (allowFreeText && query.trim()) commit(query.trim());
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  const selectedLabel = value ? (typeof value === 'string' ? value : getLabel(value)) : '';

  return (
    <div className={`relative ${className}`} ref={boxRef}>
      {label && (
        <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
          {label}
        </span>
      )}

      {/* A committed selection reads as a chip, not as text in a box — it is a chosen thing, and it
          takes one tap to clear rather than a full manual delete. */}
      {value && !open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => { setOpen(true); setQuery(''); }}
          className="w-full min-h-[48px] px-3 rounded-xl border border-slate-200 bg-white flex items-center gap-2 text-left active:bg-slate-50 disabled:opacity-50"
        >
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-slate-800 truncate">{selectedLabel}</div>
            {getSubtitle && typeof value !== 'string' && (
              <div className="text-[10px] text-slate-400 truncate">{getSubtitle(value)}</div>
            )}
          </div>
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear selection"
            onClick={e => { e.stopPropagation(); onChange?.(null); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onChange?.(null); } }}
            className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-100"
          >
            <X className="w-3.5 h-3.5" />
          </span>
        </button>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            className="jc-input pl-9"
            style={{ minHeight: '48px' }}
            value={query}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
          />
        </div>
      )}

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-40 left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-[11px] text-slate-400">{emptyText}</p>
              {allowFreeText && query.trim() && (
                <button
                  type="button"
                  onClick={() => commit(query.trim())}
                  className="mt-2 w-full min-h-[44px] rounded-lg border border-slate-300 text-[11px] font-extrabold text-slate-700 active:bg-slate-50"
                >
                  Use “{query.trim()}” anyway
                </button>
              )}
            </div>
          ) : (
            matches.map((row, i) => (
              <button
                key={keyOf(row)}
                type="button"
                role="option"
                aria-selected={i === cursor}
                data-active={i === cursor}
                onPointerDown={e => e.preventDefault()}   /* keep focus so blur cannot close first */
                onClick={() => commit(row)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full min-h-[48px] px-3 py-2 flex items-center gap-2 text-left border-b border-slate-100 last:border-b-0 ${
                  i === cursor ? 'bg-slate-50' : 'bg-white'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-800 truncate">
                    <Highlighted text={getLabel(row)} query={query} />
                  </div>
                  {getSubtitle && (
                    <div className="text-[10px] text-slate-400 truncate">
                      <Highlighted text={getSubtitle(row)} query={query} />
                    </div>
                  )}
                </div>
                {value && keyOf(value) === keyOf(row) && (
                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Shows WHY a row matched, which matters most when the reason is a word buried mid-string. */
function Highlighted({ text, query }) {
  return (
    <>
      {highlightSegments(text, query).map((seg, i) =>
        seg.match
          ? <mark key={i} className="bg-amber-200 text-slate-900 rounded-sm px-0.5">{seg.text}</mark>
          : <React.Fragment key={i}>{seg.text}</React.Fragment>
      )}
    </>
  );
}
