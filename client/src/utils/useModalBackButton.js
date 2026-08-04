import { useEffect, useRef } from 'react';

/**
 * Makes the phone's back button close an open popup/modal/drawer instead of exiting the app.
 *
 * WHY THIS EXISTS
 * The manifest runs this PWA in `display: standalone`. In that mode Android's back button walks
 * the SAME browser session-history stack a normal tab would — but a popup that only toggles React
 * state (`useState` + conditional render) never touches that stack. So the first back press after
 * opening a popup lands on empty history, which Android/the OS reads as "nothing left, close the
 * app" and the whole PWA exits or minimizes instead of the popup closing. In an ordinary browser
 * tab this is barely noticeable (back just leaves the page); in an installed app it reads as a
 * crash, so every popup needs to claim a spot on the stack for itself.
 *
 * WHY A SHARED REGISTRY, NOT ONE pushState PER HOOK CALL
 * A page can have several independent popups (Menu drawer, a filter sheet, a confirm dialog opened
 * from inside another modal). If every `useModalBackButton` call pushed its own history entry, N
 * simultaneously-mounted popups would need N back-presses to get back to the underlying page even
 * though only the topmost one is visibly "in front" — confusing, and easy to get out of sync with
 * React state on fast taps. Instead every hook instance on the page shares ONE module-level stack;
 * the stack owns exactly one pushed history entry for as long as it's non-empty. Back always closes
 * the most-recently-opened popup (LIFO), which matches how a stack of dialogs visually nests, and
 * the page needs exactly one more back press than the number of popups actually open.
 *
 * HOW TO USE
 *   useModalBackButton(isOpen, () => setIsOpen(false));
 * Call it unconditionally (hook rules) with the popup's own open flag and its own close callback.
 * That's the whole integration — no shared list to remember to update, which is what let the Admin
 * Menu drawer (`headerOpen`) slip through the old hand-maintained OR-chain in AdminDashboard.jsx.
 */

// Module-level (not component-level): shared by every hook instance across the whole page, because
// the browser history stack itself is a single global resource — two independent components each
// keeping their own "did I push?" flag would race and could each try to push/pop past the other.
const stack = [];
let popstateBound = false;

function ensurePopstateListener() {
  if (popstateBound) return;
  popstateBound = true;
  window.addEventListener('popstate', () => {
    // Only the TOPMOST popup reacts to a given back press — that is what makes nested popups close
    // one at a time instead of all at once. Pop before calling close(), so a close() that itself
    // synchronously triggers another render/effect sees a consistent stack.
    const top = stack.pop();
    if (top) top.close();
  });
}

/**
 * @param {boolean} isOpen - the popup's own open/visible flag.
 * @param {() => void} onClose - closes the popup (usually `() => setShowX(false)`). Called when the
 *   user presses back while this popup is the topmost one on the stack. Must be safe to call even
 *   if the popup is already closing for another reason.
 */
export default function useModalBackButton(isOpen, onClose) {
  // Always the latest onClose without re-running the open/close effect on every render (callers
  // often pass a fresh arrow function each render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Identifies this hook instance's own entry within the shared stack, so closing THIS popup only
  // ever pops entries up to and including its own — never a sibling popup's.
  const entryRef = useRef(null);

  useEffect(() => {
    ensurePopstateListener();

    if (isOpen) {
      if (!entryRef.current) {
        // First history entry on the page pushes from whatever the browser already has; every
        // popup after that pushes on top of the previous one, so back presses unwind them in
        // reverse order — last opened, first closed.
        window.history.pushState({ __popupDepth: stack.length + 1 }, '');
        const entry = { close: () => onCloseRef.current() };
        entryRef.current = entry;
        stack.push(entry);
      }
    } else if (entryRef.current) {
      // Popup closed some OTHER way (backdrop click, X button, Escape, Save) — the history entry
      // it pushed is still sitting there unconsumed. Consume it with history.back() so the stack
      // and the browser's real history stay in sync; skip popstate's own close() call by removing
      // this entry from the shared stack first, since the popup is already closed.
      const idx = stack.indexOf(entryRef.current);
      if (idx !== -1) stack.splice(idx, 1);
      entryRef.current = null;
      // Only step back if THIS popup's entry is still the current one on top of the browser's
      // actual history — if a later popup already pushed on top (this one closed while buried
      // under another), stepping back now would incorrectly consume that other popup's entry
      // instead of this one's. That case wants no action: whichever popup is still open keeps
      // its own entry, and this one simply had nothing left to clean up.
      if (window.history.state?.__popupDepth === stack.length + 1) {
        window.history.back();
      }
    }
    // No cleanup here on every dep change — cleanup only matters on unmount (below), otherwise a
    // normal isOpen:true -> false transition would double-handle the back() this branch already did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    // True unmount safety net: if the component is torn down (e.g. parent conditionally stops
    // rendering it) while its popup was still open and its history entry still live, leaving that
    // entry behind would strand the NEXT popup's pushState comparison. Clean up exactly like the
    // isOpen -> false branch above.
    return () => {
      if (entryRef.current) {
        const idx = stack.indexOf(entryRef.current);
        if (idx !== -1) stack.splice(idx, 1);
        entryRef.current = null;
        if (window.history.state?.__popupDepth === stack.length + 1) {
          window.history.back();
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
