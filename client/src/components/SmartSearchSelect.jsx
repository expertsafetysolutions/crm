import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Check, Maximize2 } from 'lucide-react';
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
 *   expandable    adds an "expand" control that lifts the list into a full-screen sheet. Inside a
 *                 document line the dropdown is absolutely positioned in a table cell, so it is
 *                 clipped to a few rows and scrolls inside its own little box — picking from a
 *                 catalogue of hundreds through that slot is the slowest part of building a
 *                 document. Expanded, the same list gets the whole screen.
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
  className = '',
  expandable = false,
  expandedTitle = 'Select an item',
  // Opt-in (default false): when the trigger sits in a cramped row — a mobile line-item card with
  // a photo thumbnail and delete button either side leaves only ~150px for the search box — the
  // inline dropdown has nowhere good to go. On a narrow viewport, focusing the input jumps straight
  // to the full-screen sheet instead of opening that cramped inline list.
  expandOnMobileFocus = false
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef(null);
  const listRef = useRef(null);
  const expandedInputRef = useRef(null);

  const keyOf = getKey || (row => getLabel(row));
  const fieldsOf = getSearchable || (row => [getLabel(row), getSubtitle ? getSubtitle(row) : '']);

  // The 50-row cap exists because nobody scans past it in a 6-row dropdown slot — they type another
  // word. Expanded, the list has the whole screen and scrolling IS the way you browse a catalogue,
  // so the cap would just hide stock for no reason.
  const limit = expanded ? 500 : 50;
  const matches = useMemo(() => {
    if (!query.trim()) return options.slice(0, limit);
    const found = filterByQuery(options, query, fieldsOf);
    return rankByQuery(found, query, getLabel).slice(0, limit);
  }, [options, query, limit]);

  // Reset the highlight whenever the result set changes, or Enter picks a stale row.
  useEffect(() => { setCursor(0); }, [query]);

  // Close on an outside tap. Pointerdown rather than click so it fires before a focus change.
  // Skipped while expanded: the sheet is a portal-less overlay rendered OUTSIDE boxRef, so every
  // tap inside it would read as "outside" and close the thing the user is trying to use.
  useEffect(() => {
    if (!open || expanded) return;
    const away = e => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, expanded]);

  // Escape closes the sheet, and the search box takes focus on open so typing starts immediately.
  useEffect(() => {
    if (!expanded) return;
    const onEsc = e => { if (e.key === 'Escape') setExpanded(false); };
    document.addEventListener('keydown', onEsc);
    expandedInputRef.current?.focus();
    // The page behind must not scroll under the sheet — on a phone that leaves you somewhere else
    // entirely when it closes.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  // Keep the highlighted row in view during arrow-key navigation.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const commit = (row) => {
    onChange?.(row);
    setQuery('');
    setOpen(false);
    setExpanded(false);
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

  /**
   * One option row, shared by the inline dropdown and the expanded sheet so the two can never drift
   * apart — a row that highlights differently depending on which view you opened it from would read
   * as two different pickers.
   */
  const renderRow = (row, i, big = false) => (
    <button
      key={keyOf(row)}
      type="button"
      role="option"
      aria-selected={i === cursor}
      data-active={i === cursor}
      onPointerDown={e => e.preventDefault()}   /* keep focus so blur cannot close first */
      onClick={() => commit(row)}
      onMouseEnter={() => setCursor(i)}
      className={`w-full ${big ? 'min-h-[56px] px-4 py-2.5' : 'min-h-[48px] px-3 py-2'} flex items-center gap-2 text-left border-b border-slate-100 last:border-b-0 ${
        i === cursor ? 'bg-slate-50' : 'bg-white'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className={`${big ? 'text-sm' : 'text-xs'} font-bold text-slate-800 ${big ? '' : 'truncate'}`}>
          <Highlighted text={getLabel(row)} query={query} />
        </div>
        {getSubtitle && (
          <div className={`${big ? 'text-[11px]' : 'text-[10px]'} text-slate-400 ${big ? '' : 'truncate'}`}>
            <Highlighted text={getSubtitle(row)} query={query} />
          </div>
        )}
      </div>
      {value && keyOf(value) === keyOf(row) && (
        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
      )}
    </button>
  );

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
          {expandable && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Open the full item list"
              title="Open the full item list"
              onClick={e => { e.stopPropagation(); setExpanded(true); setOpen(true); }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setExpanded(true); setOpen(true); } }}
              className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-100"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </span>
          )}
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
          {/* Icon sits on the RIGHT so it never crowds the text the user is typing — on a narrow
              phone a left icon eats the first characters of a long company name. */}
          {!expandable && (
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          )}
          <input
            type="text"
            className={expandable ? 'jc-input pr-11' : 'jc-input pr-9'}
            value={query}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => {
              if (expandable && expandOnMobileFocus && window.innerWidth < 640) { setExpanded(true); setOpen(true); }
              else setOpen(true);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
          />
          {expandable && (
            <button
              type="button"
              disabled={disabled}
              onPointerDown={e => e.preventDefault()}
              onClick={() => { setExpanded(true); setOpen(true); }}
              title="Open the full item list"
              aria-label="Open the full item list"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 active:bg-slate-200 disabled:opacity-40"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {open && (
        <div
          ref={listRef}
          role="listbox"
          // min-w so a dropdown in a narrow table cell is still readable, and z-50 to clear the
          // ADD ITEM bar and the totals panel that sit below it in the same card. Per the CSS spec,
          // a conflicting min-width always wins over max-width — an inline minWidth of "100%" here
          // used to force the box wider than max-w-[90vw] whenever the trigger sat in a narrow,
          // deeply-nested row (a mobile line-item card), which pushed the WHOLE PAGE into
          // horizontal scroll instead of just this dropdown. min-w-full (a class, so it loses the
          // cascade tie to max-w- at equal specificity by source order) plus an explicit vw cap
          // keeps the box from ever exceeding the viewport, on any layout.
          className="absolute z-50 left-0 mt-1 w-max min-w-[min(16rem,90vw)] max-w-[min(32rem,90vw)] max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl"
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
            <>
              {matches.map((row, i) => renderRow(row, i))}
              {/* Surfaced at the bottom of a capped list: the row you want may simply not be
                  rendered yet, and there is nothing on screen to say so. */}
              {expandable && matches.length >= limit && (
                <button
                  type="button"
                  onPointerDown={e => e.preventDefault()}
                  onClick={() => setExpanded(true)}
                  className="w-full min-h-[44px] px-3 text-[11px] font-extrabold text-slate-600 bg-slate-50 active:bg-slate-100"
                >
                  Showing first {limit} — expand to see all
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Full-screen picker. Deliberately a plain fixed overlay rather than a portal: the builders
          render this inside a form, and a portal would break the form association on submit. */}
      {expanded && (
        <div className="fixed inset-0 z-[60] bg-white flex flex-col">
          <div className="shrink-0 border-b border-slate-200 px-3 py-3 flex items-center gap-2 bg-white">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
                {expandedTitle}
              </div>
              <div className="text-xs font-bold text-slate-700">
                {matches.length} {matches.length === 1 ? 'match' : 'matches'}
                {options.length > 0 && ` of ${options.length}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Close"
              className="w-11 h-11 shrink-0 rounded-xl border border-slate-200 flex items-center justify-center text-slate-500 active:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="shrink-0 px-3 py-2 border-b border-slate-100">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={expandedInputRef}
                type="text"
                className="jc-input pr-9"
                value={query}
                placeholder={placeholder}
                autoComplete="off"
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
          </div>

          <div ref={listRef} role="listbox" className="flex-1 overflow-y-auto overscroll-contain">
            {matches.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-xs text-slate-400">{emptyText}</p>
                {allowFreeText && query.trim() && (
                  <button
                    type="button"
                    onClick={() => commit(query.trim())}
                    className="mt-3 min-h-[44px] px-4 rounded-lg border border-slate-300 text-[11px] font-extrabold text-slate-700 active:bg-slate-50"
                  >
                    Use “{query.trim()}” anyway
                  </button>
                )}
              </div>
            ) : (
              matches.map((row, i) => renderRow(row, i, true))
            )}
          </div>
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
