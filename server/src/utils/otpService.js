/**
 * One-time passcodes for password reset and first-time device approval.
 *
 * ── WHERE THE CODE IS SENT, AND WHY ──────────────────────────────────────────────────────────
 * Every OTP goes to OTP_RECIPIENT below — never to the staff member's own address — on the
 * owner's explicit instruction. A technician who forgets their password cannot quietly reset it
 * from their own inbox; the owner reads the code and passes it on, so every reset and every new
 * device is something the owner sees. That is the point, not an oversight: it makes the owner the
 * single checkpoint for account recovery.
 *
 * The consequence is that the email must say WHO it is for and WHY, because one inbox receives
 * every staff member's codes and they are otherwise indistinguishable.
 *
 * ── THE CODE IS STORED HASHED ────────────────────────────────────────────────────────────────
 * Auth_OTPs holds bcrypt hashes, never the digits. An OTP is a live credential for its lifetime;
 * a collection of plaintext codes would be a list of working keys, and this database is already
 * dumped nightly to backup files. Same reasoning as Staff_Master.Password.
 *
 * ── WHY NOT TOTP / AN AUTHENTICATOR APP ──────────────────────────────────────────────────────
 * Considered and rejected for this deployment: an authenticator app is stronger, but it binds the
 * second factor to the staff member's own phone, which is exactly what the owner does not want —
 * they would lose visibility of resets. Email to one supervised inbox matches the operating model.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const { BCRYPT_COST } = require('./passwordUtils');

/**
 * Fixed recipient for every OTP, for every staff member. See the header.
 * Deliberately a constant and not an env var: making it configurable would invite it being
 * pointed at an individual's mailbox, which removes the supervision this design exists for.
 */
const OTP_RECIPIENT = 'expertsafetysolution@gmail.com';

const PURPOSES = {
  FORGOT_PASSWORD: 'FORGOT_PASSWORD',
  NEW_DEVICE: 'NEW_DEVICE'
};

const CODE_LENGTH = 6;
const EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;

/**
 * Six digits from crypto.randomInt, not Math.random.
 *
 * Math.random is seeded from a predictable source and is not safe for anything that gates access;
 * randomInt draws from the same CSPRNG as key generation. Leading zeros are preserved by padding,
 * so every code is exactly six characters and "038421" is as likely as any other value.
 */
function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/**
 * Issues an OTP and returns the plaintext code for the caller to email.
 *
 * Any earlier unconsumed OTP for the same staff member and purpose is invalidated first, so a
 * second "resend" click cannot leave two valid codes alive at once.
 */
async function issueOtp(staffId, purpose) {
  const now = Date.now();
  const code = generateCode();

  const existing = await sheetsService.getTab('Auth_OTPs');
  const stale = existing.filter(o =>
    o.Staff_ID === staffId && o.Purpose === purpose && !o.Consumed_At
  );
  for (const row of stale) {
    try {
      await sheetsService.updateRow('Auth_OTPs', 'OTP_ID', row.OTP_ID, {
        Consumed_At: new Date(now).toISOString(),
        Consumed_Reason: 'superseded'
      });
    } catch (err) {
      console.error('Failed to supersede an earlier OTP:', err.message);
    }
  }

  const rand2 = Math.floor(Math.random() * 90 + 10);
  const record = {
    OTP_ID: `OTP${now.toString().slice(-6)}${rand2}`,
    Staff_ID: staffId,
    Purpose: purpose,
    Code_Hash: bcrypt.hashSync(code, BCRYPT_COST),
    Created_At: new Date(now).toISOString(),
    Expires_At: new Date(now + EXPIRY_MINUTES * 60000).toISOString(),
    Attempts: 0,
    Consumed_At: ''
  };
  await sheetsService.insertRow('Auth_OTPs', record);

  return { code, otpId: record.OTP_ID, expiresAt: record.Expires_At };
}

/**
 * Checks a submitted code.
 *
 * Returns { ok, reason }. Reasons are deliberately coarse in what the ROUTE surfaces to the
 * caller — see the routes — but precise here so failures can be logged usefully.
 *
 * A wrong guess increments Attempts and burns the OTP at MAX_ATTEMPTS, which is what stops a
 * six-digit code being brute-forced: 10^6 possibilities are meaningless at 5 tries, but trivial
 * without a cap.
 */
async function verifyOtp(staffId, purpose, code) {
  if (!code || typeof code !== 'string') return { ok: false, reason: 'missing' };

  const all = await sheetsService.getTab('Auth_OTPs');
  const row = all
    .filter(o => o.Staff_ID === staffId && o.Purpose === purpose && !o.Consumed_At)
    .sort((a, b) => String(b.Created_At).localeCompare(String(a.Created_At)))[0];

  if (!row) return { ok: false, reason: 'none_pending' };

  if (Date.parse(row.Expires_At) < Date.now()) {
    await consume(row.OTP_ID, 'expired');
    return { ok: false, reason: 'expired' };
  }

  const attempts = Number(row.Attempts || 0) + 1;

  if (!bcrypt.compareSync(code.trim(), row.Code_Hash || '')) {
    if (attempts >= MAX_ATTEMPTS) {
      await consume(row.OTP_ID, 'too_many_attempts');
      return { ok: false, reason: 'too_many_attempts' };
    }
    try {
      await sheetsService.updateRow('Auth_OTPs', 'OTP_ID', row.OTP_ID, { Attempts: attempts });
    } catch (err) {
      console.error('Failed to record an OTP attempt:', err.message);
    }
    return { ok: false, reason: 'wrong_code', attemptsRemaining: MAX_ATTEMPTS - attempts };
  }

  // Correct: consume immediately so the same code can never be replayed.
  await consume(row.OTP_ID, 'used');
  return { ok: true, otpId: row.OTP_ID };
}

async function consume(otpId, reason) {
  try {
    await sheetsService.updateRow('Auth_OTPs', 'OTP_ID', otpId, {
      Consumed_At: new Date().toISOString(),
      Consumed_Reason: reason
    });
  } catch (err) {
    console.error('Failed to consume OTP:', err.message);
  }
}

/** Plain-text email body. Names the staff member because one inbox receives everyone's codes. */
function buildOtpEmail(staff, purpose, code) {
  const what = purpose === PURPOSES.FORGOT_PASSWORD
    ? 'reset the password for'
    : 'sign in from a new device on';

  const subject = purpose === PURPOSES.FORGOT_PASSWORD
    ? `Password reset code for ${staff.Name} (${staff.Staff_ID}) — ${code}`
    : `New device sign-in code for ${staff.Name} (${staff.Staff_ID}) — ${code}`;

  const body = [
    `Verification code: ${code}`,
    '',
    `Someone is trying to ${what} the account below.`,
    '',
    `  Staff  : ${staff.Name} (${staff.Staff_ID})`,
    `  Role   : ${staff.Role || 'Staff'}`,
    `  Valid  : ${EXPIRY_MINUTES} minutes from now`,
    '',
    'Give this code to that person only if you expected this request.',
    'If you did not expect it, ignore this email — the code alone changes nothing,',
    'and it expires on its own.',
    '',
    'Expert Safety Solutions CRM'
  ].join('\n');

  return { subject, body };
}

/**
 * Push counterpart to buildOtpEmail — deliberately much smaller.
 *
 * Everything the email says beyond the staff name and the code (role, purpose, expiry, what to do
 * if this wasn't expected) stays email-only: a push notification renders on a lock screen, where
 * anyone glancing at the phone sees it, not just the owner. Title + code is the minimum needed for
 * the owner to relay the code without opening their inbox; the fuller context is one tap away in
 * the email itself.
 */
function buildOtpPushPayload(staff, code) {
  return {
    title: `OTP for ${staff.Name}`,
    body: code
  };
}

module.exports = {
  OTP_RECIPIENT,
  PURPOSES,
  EXPIRY_MINUTES,
  MAX_ATTEMPTS,
  CODE_LENGTH,
  generateCode,
  issueOtp,
  verifyOtp,
  buildOtpEmail,
  buildOtpPushPayload
};
