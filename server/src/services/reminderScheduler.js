const sheetsService = require('./sheetsService');
const { mergeQuotationSettings } = require('./defaultQuotationSettings');

/**
 * reminderScheduler — turns one hourly cron tick into "which reminder jobs are due right now?".
 *
 * Vercel's cron schedule lives in vercel.json and cannot be changed from the database, so an admin
 * cannot pick a send time by editing the cron entry. Instead vercel.json fires ONE dispatcher every
 * hour, and this module answers, per job, whether the current IST hour is the hour the admin chose
 * in Quotation_Settings.reminder_schedule.
 *
 * Consequences of that design, all deliberate:
 *  - Granularity is one hour. "11:00" means "the tick that lands inside the 11 o'clock hour", not
 *    11:00:00 exactly. Vercel does not guarantee a precise minute anyway.
 *  - Two jobs may share an hour; they simply both run on that tick, sequentially.
 *  - The hour is IST, because that is the office's clock. The deployment clock is UTC, which is why
 *    every date/time here goes through Asia/Kolkata rather than the host's local time.
 */

const JOBS = {
  QUOTATION_FOLLOWUP: 'quotation_followup',
  PAYMENT_DUE: 'payment_due',
  REFILLING_DUE: 'refilling_due',
  ANNUAL_PROSPECT: 'annual_prospect'
};

/** Current hour (0-23) on the office's clock, regardless of where the server runs. */
function istHour(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);
  // 'en-GB' renders midnight as "24" in some ICU versions; normalise it back to 0.
  return Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24;
}

function istToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

/**
 * Normalises whatever is stored for a job's hour.
 *
 * Returns null for "never run" — an explicit null from the settings UI, but also anything
 * unparseable or out of range, because silently running a job at hour 0 because someone typed
 * "eleven" would be worse than not running it.
 */
function normalizeHour(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) return null;
  return n;
}

async function getSchedule() {
  const settings = mergeQuotationSettings(await sheetsService.getQuotationSettings('DEFAULT'));
  const stored = settings.reminder_schedule || {};
  const out = {};
  for (const job of Object.values(JOBS)) out[job] = normalizeHour(stored[job]);
  return out;
}

/**
 * Whether `job` should run on this tick.
 *
 * `force` is what the manual "Run now" button and any ad-hoc invocation pass — it bypasses the
 * hour check but nothing else, so a human can always trigger a run without waiting for the clock.
 */
async function isDueNow(job, { force = false, now = new Date() } = {}) {
  if (force) return { due: true, reason: 'forced', hour: istHour(now) };

  const schedule = await getSchedule();
  const scheduledHour = schedule[job];
  const currentHour = istHour(now);

  if (scheduledHour === null) {
    return { due: false, reason: 'disabled', scheduledHour: null, currentHour };
  }
  return {
    due: scheduledHour === currentHour,
    reason: scheduledHour === currentHour ? 'scheduled' : 'not-this-hour',
    scheduledHour,
    currentHour
  };
}

/**
 * Guard against a job running twice in its own hour.
 *
 * Vercel can retry a cron invocation, and the manual Run-now button exists alongside it. Without
 * this, a retry inside the same hour would re-send every reminder whose per-document idempotency
 * flag had not yet been written. Keyed on date+hour in Counter_Master, which already provides an
 * atomic upsert — the first caller in an hour gets sequence 1 and proceeds, later ones see >1.
 *
 * Deliberately NOT applied to forced runs: pressing Run now twice is an explicit human decision.
 */
async function claimHourlySlot(job, now = new Date()) {
  const key = `REMINDER_RUN::${job}::${istToday(now)}::${String(istHour(now)).padStart(2, '0')}`;
  const seq = await sheetsService.getNextSequence(key);
  return { claimed: seq === 1, attempt: seq, key };
}

module.exports = {
  JOBS,
  istHour,
  istToday,
  normalizeHour,
  getSchedule,
  isDueNow,
  claimHourlySlot
};
