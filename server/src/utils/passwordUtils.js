const bcrypt = require('bcryptjs');

/**
 * Password verification, shared by login, admin password-reset and self-service change-password so
 * the three can never drift apart.
 *
 * This function used to contain a demo bypass: `admin123` logged in as any Admin and `staff123`
 * matched on `staff.Role !== 'Admin'` — i.e. EVERY non-admin account in the database, whatever
 * password that person had actually set. That included `accounts`, the role carrying finance
 * visibility and full purchase rights. Anyone who knew a staff ID could sign in as them, so every
 * other control in the system (module permissions, money masking, the finance strip-gate) was
 * effectively optional. Both bypasses are removed. Do not reintroduce them, in any form, for any
 * "just for testing" reason — a demo login belongs in seeded data with a real hashed password.
 *
 * Legacy plaintext comparison is retained deliberately: rows predating hashing still store a bare
 * password, and dropping the branch would lock those people out with no way back in. It is now
 * fenced so it can only ever apply to a value that is NOT a bcrypt hash, and it upgrades on use
 * (see needsRehash) so the plaintext estate shrinks toward zero instead of persisting forever.
 */

/** True when the stored value is a bcrypt hash rather than legacy plaintext. */
function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]?\$/.test(value);
}

function verifyStaffPassword(staff, password) {
  if (!staff || !password || typeof password !== 'string') return false;

  const stored = staff.Password;
  if (typeof stored !== 'string' || stored.length === 0) return false;

  if (isBcryptHash(stored)) {
    return bcrypt.compareSync(password, stored);
  }

  // Legacy plaintext row. Constant-time-ish comparison via bcrypt is not possible here (there is
  // no hash to compare against), but these rows are a shrinking remnant, not the norm.
  return password === stored;
}

/**
 * Whether this account's stored password should be re-hashed after a successful login.
 *
 * Lets the login route transparently upgrade a legacy plaintext row to bcrypt using the password
 * the user just proved they know — no reset email, no admin intervention, and the plaintext is
 * gone from the database the next time that person signs in.
 */
function needsRehash(staff) {
  return typeof staff?.Password === 'string'
    && staff.Password.length > 0
    && !isBcryptHash(staff.Password);
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

module.exports = { verifyStaffPassword, validatePasswordPolicy, isBcryptHash, needsRehash };
