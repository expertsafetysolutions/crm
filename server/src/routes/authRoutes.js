const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const { verifyStaffPassword, validatePasswordPolicy, needsRehash, BCRYPT_COST } = require('../utils/passwordUtils');
const { resolvePermissions } = require('../utils/permissions');
const { loginLimiter, passwordChangeLimiter } = require('../middleware/security');
const loginGuard = require('../utils/loginGuard');
const { recordAudit } = require('../utils/auditLog');

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

    // Generate JWT
    const tokenPayload = {
      staffId: staff.Staff_ID,
      role: staff.Role,
      name: staff.Name,
      permissions: staff.Permissions || 'ASSIGNED_ONLY'
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    // Return user info (exclude password)
    //
    // Three similarly-named things live on this object and must not be confused:
    //   Permissions           legacy STRING ('ASSIGNED_ONLY') controlling task visibility scope
    //   Module_Permissions    the raw per-staff override map, sparse and often absent
    //   Effective_Permissions the RESOLVED map (role defaults + overrides), computed fresh below
    //
    // The client can only evaluate the last one — the raw map alone says nothing about what a role
    // grants by default. It is deliberately NOT put in the JWT: a 7-day token would keep serving
    // grants an Admin had already revoked.
    const { Password, ...userProfile } = staff;
    res.json({
      success: true,
      token,
      user: {
        ...userProfile,
        Permissions: userProfile.Permissions || 'ASSIGNED_ONLY',
        Effective_Permissions: resolvePermissions(staff, staff.Role)
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during authentication' });
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
