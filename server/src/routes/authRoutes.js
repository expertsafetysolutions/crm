const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const { verifyStaffPassword, validatePasswordPolicy } = require('../utils/passwordUtils');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Configure it in the environment (Vercel env vars / server/.env) — the app will not sign or verify logins without it.');
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
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

    // Check password
    const isMatch = verifyStaffPassword(staff, password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid Staff ID or Password' });
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
    const { Password, ...userProfile } = staff;
    res.json({
      success: true,
      token,
      user: {
        ...userProfile,
        Permissions: userProfile.Permissions || 'ASSIGNED_ONLY'
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
    res.json({ user: userProfile });
  } catch (err) {
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// PUT /api/auth/change-password — self-service password change for the logged-in user
// (Admin or Staff). Requires the current password; resetting SOMEONE ELSE's password as
// an Admin override goes through PUT /api/staff/:id/set-password instead.
router.put('/change-password', authenticateToken, async (req, res) => {
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

    const hashed = bcrypt.hashSync(newPassword, 8);
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
