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
 *
 * Also closes the topmost popup on Escape, for exactly the same reason and via the exact same
 * stack — a small number of screens (AdminDashboard's menu drawer, its tag popover) had hand-rolled
 * their own `keydown`+'Escape' listener next to their own state, but the other ~60 call sites across
 * the app had no Escape handling at all: dozens of modals could only be closed with a mouse click or
 * the phone back button, not the keyboard, on desktop. One listener here fixes all of them at once,
 * consistent with why back-button handling itself lives in a shared hook rather than being repeated
 * per popup. Screens with their own hand-rolled Escape handler are unaffected — this only reacts
 * when its own module-level `stack` is non-empty, and those two hand-rolled cases don't push onto it.
 */

// Module-level (not component-level): shared by every hook instance across the whole page, because
// the browser history stack itself is a single global resource — two independent components each
// keeping their own "did I push?" flag would race and could each try to push/pop past the other.
const stack = [];
let popstateBound = false;

function ensurePopstateListener() {
  if (popstateBound) return;
  popstateBound = true;
  window.addEventListener('popstate', (e) => {
    // A real back-press lowers __popupDepth by exactly one and the browser's history.state is
    // authoritative for what depth we landed on. Reconcile the stack to that depth rather than
    // blindly popping the array's current top: history.back() is ASYNC, so when one popup closes
    // programmatically (not via Back) and calls history.back() to consume its own entry, another
    // popup opened in the SAME click can already have pushed a newer entry on top of the stack by
    // the time this popstate finally fires. Blindly popping would then close that unrelated, still
    // -open popup instead of finishing the first one's own cleanup — exactly the bug that closed a
    // just-opened modal (e.g. View ID Card) a moment after a menu popup beneath it called
    // history.back() to tidy up its own entry.
    const landedDepth = e.state?.__popupDepth ?? 0;
    while (stack.length > landedDepth) {
      const entry = stack.pop();
      // Only close entries whose OWN pushed depth is above where we landed — i.e. entries that a
      // real back-press actually walked past. An entry already reconciled by its own isOpen:false
      // branch is removed from `stack` there, so it never reaches this loop.
      if (entry) entry.close();
    }
  });

  // Escape closes only the TOPMOST popup, same LIFO rule as the back button — so stacking a confirm
  // dialog on top of a modal takes two Escape presses, not one that closes both at once. Ignored
  // while focus is in a text input/textarea/contenteditable/select ONLY if that field itself is
  // still meaningfully editable-and-empty-of-intent — in practice every popup here is fine closing
  // even mid-typing (Escape-to-close-dialog is standard OS/browser behavior, e.g. native <dialog>),
  // so no such carve-out is added; a stray Escape while typing in a popup's field closing that popup
  // matches what every OS dialog already does.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    // Let the close() call go through the normal isOpen:false effect branch above (via React state
    // update), rather than popping here directly — popping here AND leaving the popup's own state
    // still "open" would desync the two, since the effect branch is what actually removes this
    // entry from `stack` and consumes its history entry.
    top.close();
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
      // Deferred to a microtask rather than called inline: this effect and a SIBLING popup's
      // opening effect (e.g. "close this menu, open that modal") both run synchronously in the
      // same React commit. If a sibling's isOpen:true branch pushes its own history entry AFTER
      // this line but BEFORE the guard below is read, the guard would still see the pre-push state
      // and wrongly schedule a back() — whose async popstate then lands after the sibling's fresh
      // push, undoing the very entry that "close this menu, open that modal" click just created
      // (this is what silently closed View ID Card / Change Password / Company Details a moment
      // after they opened, since all three close the profile menu in the same click). Queuing this
      // check as a microtask lets every synchronous effect in the commit — including that sibling's
      // push — finish first, so the guard reads the FINAL settled history state.
      queueMicrotask(() => {
        if (window.history.state?.__popupDepth === stack.length + 1) {
          window.history.back();
        }
      });
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
