/**
 * Client-side mirror of the server's password policy (server/src/utils/passwordUtils.js) —
 * used for instant validation feedback before submitting. The server re-validates
 * independently and is the actual source of truth.
 */
export function validatePasswordPolicy(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(password)) return 'Password must include at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include at least one special character.';
  return null;
}
