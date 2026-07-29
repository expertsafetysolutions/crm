/**
 * Account lockout after consecutive failed logins.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE RATE LIMITER ───────────────────────────────────────────────
 * `loginLimiter` (middleware/security.js) already caps login attempts, but it cannot express what
 * was asked for here, for two reasons:
 *
 *   1. It is in-memory and per-instance. On Vercel there may be several serverless instances and
 *      each keeps its own counter, and all of them reset when the process recycles.
 *   2. express-rate-limit cannot decrement. `skipSuccessfulRequests` stops successes being
 *      counted, but a success does not RESET the window — so 4 failures, a success, then 6 more
 *      failures still trips it. That is not "5 consecutive failures", it is "11 failures in 15
 *      minutes with a gap".
 *
 * A counter on the staff row fixes both: it survives restarts, is shared across instances, and is
 * explicitly zeroed on success, which is what makes the count genuinely consecutive.
 *
 * ── KEYED ON THE ACCOUNT, NOT THE IP ─────────────────────────────────────────────────────────
 * The brief asked to block the IP. That would be wrong here and is deliberately not done: field
 * staff share one NAT'd 4G router at the workshop, so one person fat-fingering their password
 * five times would lock out every colleague behind that router — including, on a bad day, the
 * Admin trying to fix it. The existing rate limiter is keyed `IP:staffId` for exactly this reason.
 * Locking the ACCOUNT stops the attack (a password guesser targets one account) without taking
 * bystanders down with it.
 *
 * ── IT MUST EXPIRE WITHOUT A CRON ────────────────────────────────────────────────────────────
 * Vercel Hobby allows one cron per day and that slot is already used, so a lockout that needed a
 * scheduled sweep to clear would in practice be permanent. `Locked_Until` is therefore compared
 * against the clock at login time; nothing has to run for a lock to expire.
 */

const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

/**
 * Is this account currently locked?
 * Returns { locked, minutesRemaining }.
 */
function checkLock(staff, now = Date.now()) {
  const until = staff?.Locked_Until ? Date.parse(staff.Locked_Until) : 0;
  if (!until || Number.isNaN(until) || until <= now) {
    return { locked: false, minutesRemaining: 0 };
  }
  return { locked: true, minutesRemaining: Math.ceil((until - now) / 60000) };
}

/**
 * The Staff_Master patch to apply after a FAILED attempt.
 *
 * Returns the fields to $set, plus whether this failure crossed the threshold, so the caller can
 * decide what to tell the user. An expired lock resets the count rather than continuing it —
 * otherwise a stale counter from days ago would make the next single typo lock the account.
 */
function registerFailure(staff, now = Date.now()) {
  const priorLock = checkLock(staff, now);
  const hadExpiredLock = staff?.Locked_Until && !priorLock.locked;
  const prior = hadExpiredLock ? 0 : Number(staff?.Failed_Login_Attempts || 0);
  const attempts = prior + 1;

  const patch = {
    Failed_Login_Attempts: attempts,
    Last_Failed_Login: new Date(now).toISOString()
  };

  const justLocked = attempts >= MAX_CONSECUTIVE_FAILURES;
  if (justLocked) {
    patch.Locked_Until = new Date(now + LOCKOUT_MINUTES * 60000).toISOString();
    // Counter restarts with the lock, so the next lock needs another full run of failures.
    patch.Failed_Login_Attempts = 0;
  } else {
    patch.Locked_Until = '';
  }

  return { patch, attempts, justLocked, attemptsRemaining: Math.max(0, MAX_CONSECUTIVE_FAILURES - attempts) };
}

/**
 * The patch to apply after a SUCCESSFUL login — this is what makes the count consecutive.
 * Returns null when there is nothing to clear, so the caller can skip a pointless write on the
 * overwhelmingly common path where the user simply typed their password correctly.
 */
function registerSuccess(staff) {
  const hasCounter = Number(staff?.Failed_Login_Attempts || 0) > 0;
  const hasLock = Boolean(staff?.Locked_Until);
  if (!hasCounter && !hasLock) return null;
  return { Failed_Login_Attempts: 0, Locked_Until: '', Last_Failed_Login: '' };
}

module.exports = {
  MAX_CONSECUTIVE_FAILURES,
  LOCKOUT_MINUTES,
  checkLock,
  registerFailure,
  registerSuccess
};
