const bcrypt = require('bcryptjs');

// Same match logic used at login: bcrypt hash, legacy plaintext match, or the hardcoded
// admin123/staff123 demo bypass. Kept in one place so login, admin password-reset, and
// self-service change-password never drift apart.
function verifyStaffPassword(staff, password) {
  if (!staff || !password) return false;
  if (staff.Password && typeof staff.Password === 'string' && staff.Password.startsWith('$2') && bcrypt.compareSync(password, staff.Password)) {
    return true;
  }
  if (password === staff.Password) return true;
  if (password === 'admin123' && (staff.Role === 'Admin' || staff.Staff_ID === 'STAFF001' || staff.Staff_ID === 'STAFF005')) {
    return true;
  }
  if (password === 'staff123' && (staff.Role !== 'Admin' || staff.Staff_ID === 'STAFF002' || staff.Staff_ID === 'STAFF003' || staff.Staff_ID === 'STAFF004' || staff.Staff_ID === 'STAFF006')) {
    return true;
  }
  return false;
}

// Minimum 8 chars, at least one letter, one number, one special character.
function validatePasswordPolicy(password) {
  if (!password || typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Za-z]/.test(password)) return 'Password must include at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include at least one special character.';
  return null;
}

module.exports = { verifyStaffPassword, validatePasswordPolicy };
