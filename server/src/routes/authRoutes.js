const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const { verifyStaffPassword, validatePasswordPolicy, needsRehash, BCRYPT_COST } = require('../utils/passwordUtils');
const { resolvePermissions } = require('../utils/permissions');
const { loginLimiter, passwordChangeLimiter } = require('../middleware/security');
const loginGuard = require('../utils/loginGuard');
const { recordAudit } = require('../utils/auditLog');
const otpService = require('../utils/otpService');
const deviceRegistry = require('../utils/deviceRegistry');
const emailService = require('../services/emailService');
const quotationEngine = require('../services/quotationEngine');
const pushService = require('../services/pushService');

/**
 * Mirrors the OTP to Admin push subscriptions alongside the email — best-effort, and never
 * allowed to affect the login flow. notifyAdmins already swallows its own errors per-recipient,
 * but issueOtp/sendOtpEmail must never fail because a phone was unreachable.
 */
function pushOtpCode(staff, code) {
  try {
    const payload = otpService.buildOtpPushPayload(staff, code);
    pushService.notifyAdmins({ type: pushService.NOTIFICATION_TYPES.OTP_CODE, ...payload });
  } catch (err) {
    console.error('Failed to push OTP notification:', err.message);
  }
}

/**
 * Sends an OTP to the fixed administrator inbox.
 *
 * Throws on failure — the callers treat "the code could not be sent" as a hard error, because
 * silently continuing would leave the user waiting for a code that will never arrive.
 */
async function sendOtpEmail(staff, purpose, code) {
  const settings = await quotationEngine.getSettings();
  const smtpConfig = settings?.smtp_config;
  if (!smtpConfig) throw new Error('SMTP is not configured');

  const { subject, body } = otpService.buildOtpEmail(staff, purpose, code);
  const result = await emailService.sendEmail(smtpConfig, {
    to: otpService.OTP_RECIPIENT,
    subject,
    body
  });
  // sendEmail reports failure by returning { ok: false } rather than throwing.
  if (!result || !result.ok) throw new Error(result?.error || 'Email delivery failed');
  return result;
}

/**
 * Records a device against the account. Best-effort: a write failure here must not block a login
 * whose password and second factor have both already been accepted.
 */
async function rememberDevice(staff, deviceId, req) {
  try {
    const devices = deviceRegistry.registerDevice(
      staff, deviceId, req.headers['user-agent'], req.ip
    );
    await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, {
      Known_Devices: devices
    });
  } catch (err) {
    console.error(`Failed to record device for ${staff.Staff_ID}:`, err.message);
  }
}

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Configure it in the environment (Vercel env vars / server/.env) — the app will not sign or verify logins without it.');
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { staffId, password } = req.body;
    if (!staffId || !password) {
      return res.status(400).json({ error: 'Staff ID and Password are required' });
    }

    const staff = await sheetsService.getStaffById(staffId.trim().toUpperCase());
    if (!staff) {
      return res.status(401).json({ error: 'Invalid Staff ID or Password' });
    }

    if (staff.Status !== 'Active') {
      return res.status(403).json({ error: 'Account is inactive. Please contact Admin.' });
    }

    // Locked accounts are turned away before the password is even checked, so a locked account
    // cannot be used as an oracle to test passwords.
    const lock = loginGuard.checkLock(staff);
    if (lock.locked) {
      await recordAudit(req, {
        entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'LOGIN_BLOCKED',
        note: `Attempt while locked; ${lock.minutesRemaining} min remaining`
      });
      return res.status(423).json({
        error: `Account locked after too many failed attempts. Try again in ${lock.minutesRemaining} minute(s), or ask an Admin to unlock it.`,
        lockedMinutesRemaining: lock.minutesRemaining
      });
    }

    // Check password
    const isMatch = verifyStaffPassword(staff, password);

    if (!isMatch) {
      // Count the failure. Best-effort: if this write fails the login must still be refused,
      // so a DB problem can never turn a wrong password into a successful login.
      const { patch, justLocked, attemptsRemaining } = loginGuard.registerFailure(staff);
      try {
        await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, patch);
      } catch (guardErr) {
        console.error(`Login guard write failed for ${staff.Staff_ID}:`, guardErr.message);
      }
      await recordAudit(req, {
        entity: 'Staff_Master', entityId: staff.Staff_ID,
        action: justLocked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        note: justLocked
          ? `Locked for ${loginGuard.LOCKOUT_MINUTES} minutes after ${loginGuard.MAX_CONSECUTIVE_FAILURES} consecutive failures`
          : `Failed login; ${attemptsRemaining} attempt(s) before lockout`
      });

      if (justLocked) {
        return res.status(423).json({
          error: `Too many failed attempts. This account is locked for ${loginGuard.LOCKOUT_MINUTES} minutes.`,
          lockedMinutesRemaining: loginGuard.LOCKOUT_MINUTES
        });
      }
      return res.status(401).json({ error: 'Invalid Staff ID or Password' });
    }

    // Success clears the counter — this is what makes the failure count CONSECUTIVE rather than
    // cumulative. Skipped entirely when there is nothing to clear, which is the normal path.
    const clearPatch = loginGuard.registerSuccess(staff);
    if (clearPatch) {
      try {
        await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, clearPatch);
      } catch (clearErr) {
        console.error(`Login guard clear failed for ${staff.Staff_ID}:`, clearErr.message);
      }
    }

    // Opportunistic upgrade of a legacy plaintext row, using the password just proven correct.
    // Best-effort on purpose: a write failure here must never turn a valid login into an error,
    // so it is logged and swallowed rather than awaited into the response path.
    if (needsRehash(staff)) {
      try {
        await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, {
          Password: bcrypt.hashSync(password, BCRYPT_COST)
        });
      } catch (rehashErr) {
        console.error(`Password rehash failed for ${staff.Staff_ID}:`, rehashErr.message);
      }
    }

    // ── Unrecognised device? Demand a code before issuing a token ──────────────────────────
    //
    // Deliberately placed AFTER the password check: a code is only ever sent to someone who has
    // already proved the password, so this cannot be used to spam the owner's inbox with codes
    // for accounts the sender knows nothing about.
    //
    // EVERY unrecognised browser is challenged, including the very first one on an account — the
    // owner's explicit choice over the gentler "first device is free" rule, which left a stolen
    // password usable from anywhere until someone happened to log in once. See deviceRegistry.
    //
    // An old client that sends no deviceId at all is also challenged: treating a missing id as
    // "trusted" would let anyone skip the check by simply omitting the field.
    const deviceId = String(req.body.deviceId || '').trim();
    const breakGlass = process.env.AUTH_BREAK_GLASS_STAFF_ID;
    const isBreakGlass = breakGlass && breakGlass === staff.Staff_ID;

    const needsDeviceApproval =
      !isBreakGlass &&
      !(deviceId && deviceRegistry.isKnownDevice(staff, deviceId));

    if (needsDeviceApproval) {
      try {
        const { code } = await otpService.issueOtp(staff.Staff_ID, otpService.PURPOSES.NEW_DEVICE);
        await sendOtpEmail(staff, otpService.PURPOSES.NEW_DEVICE, code);
        pushOtpCode(staff, code);
      } catch (otpErr) {
        // If the code cannot be sent, refusing the login would strand the user with no way in.
        // Report it as a server error so they can retry or call the owner, and leave a loud trace.
        console.error(`Failed to issue new-device OTP for ${staff.Staff_ID}:`, otpErr.message);
        await recordAudit(req, {
          entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'OTP_SEND_FAILED',
          note: `New-device code could not be sent: ${otpErr.message}`
        });
        return res.status(500).json({ error: 'Could not send the verification code. Please try again, or ask an Admin.' });
      }

      await recordAudit(req, {
        entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'OTP_SENT',
        note: `New device (${deviceRegistry.describeDevice(req.headers['user-agent'])}) — code sent`
      });

      // 202: the credentials were right, but the session is not granted yet.
      return res.status(202).json({
        otpRequired: true,
        purpose: otpService.PURPOSES.NEW_DEVICE,
        staffId: staff.Staff_ID,
        message: `This device has not been used before. A verification code has been emailed to the administrator — ask them for it.`
      });
    }

    // Known (or first-ever, or break-glass) device — remember it and continue.
    if (deviceId && !isBreakGlass) {
      await rememberDevice(staff, deviceId, req);
    }

    // Token + user payload, built by issueSession below.
    //
    // Three similarly-named things live on that object and must not be confused:
    //   Permissions           legacy STRING ('ASSIGNED_ONLY') controlling task visibility scope
    //   Module_Permissions    the raw per-staff override map, sparse and often absent
    //   Effective_Permissions the RESOLVED map (role defaults + overrides), computed fresh
    //
    // The client can only evaluate the last one — the raw map alone says nothing about what a role
    // grants by default. It is deliberately NOT put in the JWT: a 7-day token would keep serving
    // grants an Admin had already revoked.
    res.json(issueSession(staff));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
});

/**
 * Issues the token + user payload. Shared by /login and /verify-otp so the two can never drift
 * into handing out differently-shaped sessions.
 */
function issueSession(staff) {
  const token = jwt.sign(
    {
      staffId: staff.Staff_ID,
      role: staff.Role,
      name: staff.Name,
      permissions: staff.Permissions || 'ASSIGNED_ONLY'
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  const { Password, ...userProfile } = staff;
  return {
    success: true,
    token,
    user: {
      ...userProfile,
      Permissions: userProfile.Permissions || 'ASSIGNED_ONLY',
      Effective_Permissions: resolvePermissions(staff, staff.Role)
    }
  };
}

/**
 * POST /api/auth/verify-otp — second step of a new-device login.
 *
 * Requires the password again alongside the code. Without that, the 202 from /login would be a
 * standing invitation to brute-force a six-digit code against a known staff id; with it, an
 * attacker must already hold the password, which is the whole premise of a second factor.
 */
router.post('/verify-otp', loginLimiter, async (req, res) => {
  try {
    const { staffId, password, code, deviceId } = req.body;
    if (!staffId || !password || !code) {
      return res.status(400).json({ error: 'Staff ID, password and verification code are all required' });
    }

    const staff = await sheetsService.getStaffById(String(staffId).trim().toUpperCase());
    if (!staff || staff.Status !== 'Active' || !verifyStaffPassword(staff, password)) {
      return res.status(401).json({ error: 'Invalid Staff ID or Password' });
    }

    const lock = loginGuard.checkLock(staff);
    if (lock.locked) {
      return res.status(423).json({ error: `Account locked. Try again in ${lock.minutesRemaining} minute(s).` });
    }

    const result = await otpService.verifyOtp(staff.Staff_ID, otpService.PURPOSES.NEW_DEVICE, String(code));
    if (!result.ok) {
      await recordAudit(req, {
        entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'OTP_FAILED',
        note: `New-device verification failed (${result.reason})`
      });
      const message = result.reason === 'expired' ? 'That code has expired. Please sign in again to get a new one.'
        : result.reason === 'too_many_attempts' ? 'Too many incorrect codes. Please sign in again to get a new one.'
        : result.reason === 'none_pending' ? 'No code is waiting. Please sign in again.'
        : 'That code is not correct.';
      return res.status(401).json({ error: message, reason: result.reason });
    }

    if (deviceId) {
      const evicted = deviceRegistry.devicesEvictedBy(staff, deviceId, req.headers['user-agent'], req.ip);
      await rememberDevice(staff, deviceId, req);
      if (evicted.length) {
        await recordAudit(req, {
          entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'DEVICE_EVICTED',
          note: `Device limit reached; removed ${evicted.length} least-recently-used device(s)`
        });
      }
    }

    await recordAudit(req, {
      entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'DEVICE_APPROVED',
      note: `New device approved: ${deviceRegistry.describeDevice(req.headers['user-agent'])}`
    });

    const fresh = await sheetsService.getStaffById(staff.Staff_ID);
    res.json(issueSession(fresh || staff));
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ error: 'Could not verify the code' });
  }
});

/**
 * GET /api/auth/dev-auto-login — local-dev convenience only.
 *
 * Skips Staff ID, password AND the new-device OTP entirely and hands back a normal session for a
 * single, explicitly-named account. Two independent gates keep this from ever reaching production:
 * NODE_ENV must not be 'production' (Vercel sets this automatically; a plain `node server.js` on a
 * dev machine does not), AND DEV_AUTO_LOGIN_STAFF_ID must be set — it is absent from .env.example
 * and must never be added to Vercel's project env vars. Either gate alone would be reversible by a
 * single misconfigured environment; both together require two independent mistakes.
 */
router.get('/dev-auto-login', async (req, res) => {
  try {
    const devStaffId = process.env.DEV_AUTO_LOGIN_STAFF_ID;
    if (process.env.NODE_ENV === 'production' || !devStaffId) {
      return res.status(404).json({ error: 'Not found' });
    }
    const staff = await sheetsService.getStaffById(String(devStaffId).trim().toUpperCase());
    if (!staff || staff.Status !== 'Active') {
      return res.status(500).json({ error: `DEV_AUTO_LOGIN_STAFF_ID '${devStaffId}' does not match an active staff record` });
    }
    res.json(issueSession(staff));
  } catch (err) {
    console.error('dev-auto-login error:', err);
    res.status(500).json({ error: 'Dev auto-login failed' });
  }
});

/**
 * POST /api/auth/forgot-password — step 1, request a reset code.
 *
 * Always answers 200, even for a staff id that does not exist. Confirming which ids are real
 * would turn this into a free directory of valid accounts to attack.
 */
router.post('/forgot-password', loginLimiter, async (req, res) => {
  const generic = { success: true, message: 'If that Staff ID exists, a reset code has been emailed to the administrator.' };
  try {
    const { staffId } = req.body;
    if (!staffId) return res.status(400).json({ error: 'Staff ID is required' });

    const staff = await sheetsService.getStaffById(String(staffId).trim().toUpperCase());
    if (!staff || staff.Status !== 'Active') {
      await recordAudit(req, {
        entity: 'Staff_Master', entityId: String(staffId).toUpperCase(), action: 'PASSWORD_RESET_REQUESTED',
        note: 'Requested for an unknown or inactive account — no code sent'
      });
      return res.json(generic);
    }

    const { code } = await otpService.issueOtp(staff.Staff_ID, otpService.PURPOSES.FORGOT_PASSWORD);
    await sendOtpEmail(staff, otpService.PURPOSES.FORGOT_PASSWORD, code);
    pushOtpCode(staff, code);

    await recordAudit(req, {
      entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'PASSWORD_RESET_REQUESTED',
      note: 'Reset code emailed to the administrator'
    });
    res.json(generic);
  } catch (err) {
    console.error('forgot-password error:', err);
    // Reported honestly: a silent 200 here would leave the user waiting for a code that never
    // arrives, with nothing to act on.
    res.status(500).json({ error: 'Could not send the reset code. Please contact your Admin.' });
  }
});

/**
 * POST /api/auth/reset-password — step 2, set a new password with the code.
 *
 * Clears any lockout on success: someone who has proved possession of the reset code and chosen a
 * new password should not then be told to wait fifteen minutes.
 */
router.post('/reset-password', loginLimiter, async (req, res) => {
  try {
    const { staffId, code, newPassword, confirmPassword } = req.body;
    if (!staffId || !code || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Staff ID, code, new password and confirmation are all required' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });

    const staff = await sheetsService.getStaffById(String(staffId).trim().toUpperCase());
    if (!staff || staff.Status !== 'Active') {
      return res.status(401).json({ error: 'That code is not valid.' });
    }

    const result = await otpService.verifyOtp(staff.Staff_ID, otpService.PURPOSES.FORGOT_PASSWORD, String(code));
    if (!result.ok) {
      await recordAudit(req, {
        entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'PASSWORD_RESET_FAILED',
        note: `Reset code rejected (${result.reason})`
      });
      const message = result.reason === 'expired' ? 'That code has expired. Please request a new one.'
        : result.reason === 'too_many_attempts' ? 'Too many incorrect codes. Please request a new one.'
        : 'That code is not correct.';
      return res.status(401).json({ error: message, reason: result.reason });
    }

    await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, {
      Password: bcrypt.hashSync(newPassword, BCRYPT_COST),
      Failed_Login_Attempts: 0,
      Locked_Until: '',
      Last_Failed_Login: ''
    });

    await recordAudit(req, {
      entity: 'Staff_Master', entityId: staff.Staff_ID, action: 'PASSWORD_RESET',
      note: 'Password reset via emailed code'
    });

    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Could not reset the password' });
  }
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const staff = await sheetsService.getStaffById(req.user.staffId);
    if (!staff) return res.status(404).json({ error: 'User not found' });
    const { Password, ...userProfile } = staff;
    // Resolved here as well as on login, and this is the path that matters most: AuthContext calls
    // /me on mount, on window focus and on reconnect, so a permission change an Admin makes reaches
    // the user without forcing them to log out and back in.
    res.json({ user: { ...userProfile, Effective_Permissions: resolvePermissions(staff, staff.Role) } });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// PUT /api/auth/change-password — self-service password change for the logged-in user
// (Admin or Staff). Requires the current password; resetting SOMEONE ELSE's password as
// an Admin override goes through PUT /api/staff/:id/set-password instead.
router.put('/change-password', authenticateToken, passwordChangeLimiter, async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Old password, new password, and confirmation are all required' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });

    const staff = await sheetsService.getStaffById(req.user.staffId);
    if (!staff) return res.status(404).json({ error: 'Account not found' });
    if (!verifyStaffPassword(staff, oldPassword)) {
      return res.status(401).json({ error: 'Old password is incorrect' });
    }

    const hashed = bcrypt.hashSync(newPassword, BCRYPT_COST);
    await sheetsService.updateRow('Staff_Master', 'Staff_ID', staff.Staff_ID, { Password: hashed });
    res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = {
  authRouter: router,
  authenticateToken
};
