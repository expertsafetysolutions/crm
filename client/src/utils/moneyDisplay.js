import { useAuth } from '../context/AuthContext';

/**
 * Client-side half of the price masking. The server already strips money from responses for staff
 * without `finance:view` (server/src/utils/moneyMask.js) — this hides the columns that would
 * otherwise render as blanks, so a masked screen looks deliberate rather than broken.
 *
 * Order matters: the server is the control, this is the presentation. Never rely on this alone.
 */

/** Whether the current viewer may see rates, amounts and totals. */
export function useMoneyVisible() {
  const { canSeeMoney } = useAuth();
  return canSeeMoney;
}

/**
 * True when a payload came back masked. Lets a screen say "hidden" instead of showing a blank cell,
 * so a masking bug is visible rather than silent.
 */
export function isMasked(payload) {
  return Boolean(payload && payload._Money_Masked);
}

/** Placeholder for a hidden figure. An em-dash reads as "withheld" where an empty cell reads as a bug. */
export const HIDDEN_PLACEHOLDER = '—';
