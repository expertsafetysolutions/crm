/**
 * safeMode — a development kill-switch that stops any outbound message reaching a real customer.
 *
 * The dev environment talks to the SAME MongoDB Atlas cluster and the SAME live SMTP account as
 * production, so "just testing" a dispatch mails an actual customer. This redirects every email and
 * WhatsApp message to one address instead, and records who it would really have gone to.
 *
 * Enabled purely by the presence of MAIL_SAFE_MODE in the environment:
 *
 *   MAIL_SAFE_MODE=expertsafetysolution@gmail.com     # local .env — testing
 *   (variable absent)                                  # production — normal behaviour
 *
 * Read fresh from process.env on every call rather than cached at require() time, so a test can
 * flip it without restarting and there is no stale copy to reason about.
 *
 * DANGER: if this is ever set in the production environment, customers silently stop receiving
 * quotations and invoices. announceOnBoot() prints a loud banner at startup for exactly that
 * reason — a silent kill-switch is worse than none.
 */

const ENV_VAR = 'MAIL_SAFE_MODE';

/** The redirect address, or '' when safe mode is off. */
function redirectTo() {
  return String(process.env[ENV_VAR] || '').trim();
}

function isActive() {
  return redirectTo() !== '';
}

/**
 * Decides what to do with one outbound message.
 *
 * Returns the address to actually use plus whether a redirect happened, so the caller can label the
 * message and report the real intended recipient back up the stack.
 */
function applyToEmail(intendedRecipient) {
  const to = redirectTo();
  if (!to) return { recipient: intendedRecipient, redirected: false, intendedRecipient };
  return { recipient: to, redirected: true, intendedRecipient: intendedRecipient || '(none)' };
}

/** Prefix that makes a redirected message impossible to mistake for a real one in an inbox. */
function subjectPrefix(intendedRecipient) {
  return `[SAFE MODE → ${intendedRecipient || 'no recipient'}] `;
}

/** Banner prepended to the plaintext body. */
function textBanner(intendedRecipient) {
  return [
    '=========================================================',
    ' SAFE MODE — this message was NOT delivered to the customer.',
    ` It would have gone to: ${intendedRecipient || '(no recipient on record)'}`,
    ` Redirected to: ${redirectTo()}`,
    ' Unset MAIL_SAFE_MODE in the environment to send for real.',
    '=========================================================',
    '',
    ''
  ].join('\n');
}

/** Same banner for HTML bodies. Inline styles only — email clients strip <style> blocks. */
function htmlBanner(intendedRecipient) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-family:Arial,sans-serif;font-size:13px;color:#78350f">
<strong style="display:block;font-size:14px;margin-bottom:6px">⚠ SAFE MODE — not delivered to the customer</strong>
Would have gone to: <strong>${esc(intendedRecipient) || '(no recipient on record)'}</strong><br>
Redirected to: <strong>${esc(redirectTo())}</strong><br>
<span style="opacity:.75">Unset MAIL_SAFE_MODE in the environment to send for real.</span>
</div>`;
}

/**
 * WhatsApp has no subject line and its templates are fixed by Meta, so a banner cannot be injected
 * into the message. Blocking outright is the only honest option — a redirected WhatsApp template
 * would look identical to a real one.
 */
function blockWhatsapp(intendedRecipient) {
  return {
    ok: false,
    channel: 'WhatsApp',
    recipient: intendedRecipient || '',
    safeModeBlocked: true,
    error: `SAFE MODE is on (${ENV_VAR}) — WhatsApp to ${intendedRecipient || 'this number'} was blocked. `
      + 'WhatsApp cannot be redirected the way email can, because Meta templates carry no banner or subject line.'
  };
}

/** Loud startup banner. A kill-switch nobody notices is how customers stop getting mail for a week. */
function announceOnBoot() {
  if (!isActive()) return;
  const line = '='.repeat(72);
  console.warn(`\n${line}`);
  console.warn(`  ⚠  SAFE MODE IS ACTIVE  (${ENV_VAR}=${redirectTo()})`);
  console.warn('     Every email is redirected to that address. WhatsApp is blocked.');
  console.warn('     NO CUSTOMER WILL RECEIVE ANYTHING while this is set.');
  console.warn('     Remove the variable from the environment to send for real.');
  console.warn(`${line}\n`);
}

module.exports = {
  ENV_VAR,
  isActive,
  redirectTo,
  applyToEmail,
  subjectPrefix,
  textBanner,
  htmlBanner,
  blockWhatsapp,
  announceOnBoot
};
