/**
 * AES-256-GCM field-level encryption for sensitive customer data at rest.
 *
 * ── WHAT THIS PROTECTS AGAINST ────────────────────────────────────────────────────────────────
 * A stolen database dump. If the Atlas cluster is exposed, a backup file leaks, or someone reads
 * the collection directly, the protected fields are ciphertext rather than customer phone numbers
 * and addresses. That is the realistic threat for this app and this control addresses it squarely.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────────────────────────
 * This is NOT end-to-end encryption. The server holds the key and decrypts on read, because it has
 * to: dispatchService needs a real phone number to send a WhatsApp message, the PDF templates need
 * a real address, and the public certificate page needs a real customer name. Anything that can
 * still send a customer an email can, by definition, still read that customer's data.
 *
 * So an attacker with LIVE SERVER ACCESS (a shell, or the ability to call the API as an Admin) can
 * still read plaintext. Defending against that is what the auth, permission and masking layers are
 * for — not this file. Claiming otherwise would be false comfort.
 *
 * ── ALGORITHM CHOICE ──────────────────────────────────────────────────────────────────────────
 * AES-256-GCM, not CBC. GCM is authenticated: tampering with stored ciphertext is detected on
 * decrypt instead of silently yielding corrupted plaintext. For a record that feeds a legal
 * compliance certificate, silent corruption is worse than a loud failure.
 *
 * ── STORED FORMAT ─────────────────────────────────────────────────────────────────────────────
 *   enc:v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
 *
 * The `enc:v1:` prefix makes the scheme self-describing, which buys three things:
 *   - encryption can be rolled out gradually; plaintext and ciphertext coexist in one collection
 *   - decrypting an already-plaintext legacy row is a no-op instead of an error
 *   - a future v2 (new algorithm or rotated key) can be told apart from v1 without a migration flag
 *
 * ── KEY DERIVATION ────────────────────────────────────────────────────────────────────────────
 * The key comes from FIELD_ENCRYPTION_KEY: 64 hex chars (32 bytes), generated with
 * `openssl rand -hex 32` or `npm run keygen`. A passphrase is NOT accepted — scrypt-stretching a
 * human-chosen phrase would invite a weak key and hide that weakness behind a strong algorithm.
 *
 * LOSING THIS KEY MEANS LOSING THE DATA. There is no recovery path. It belongs in a password
 * manager and in the Vercel env vars, and it must NOT live only in server/.env on one laptop.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_BYTES = 12;   // 96-bit nonce — the size GCM is specified for
const KEY_BYTES = 32;  // AES-256

let cachedKey = null;
let keyWarningIssued = false;

/**
 * Loads and validates the key.
 *
 * Returns null (rather than throwing) when unset, so the app runs un-encrypted until a key is
 * configured. That is what allows this to ship without a big-bang migration — but it warns once
 * at startup, because silently storing customer data in plaintext when someone believes it is
 * encrypted is the worst possible outcome here.
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    if (!keyWarningIssued) {
      console.warn('⚠️  FIELD_ENCRYPTION_KEY is not set — customer fields are being stored in PLAINTEXT.');
      console.warn('   Generate one with: npm run keygen   (then add it to server/.env and Vercel)');
      keyWarningIssued = true;
    }
    return null;
  }

  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    // Fatal rather than a warning: a malformed key means every write would silently fall back to
    // plaintext while the operator believes encryption is on.
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). ' +
      'Generate one with: npm run keygen'
    );
  }

  cachedKey = Buffer.from(trimmed, 'hex');
  if (cachedKey.length !== KEY_BYTES) {
    throw new Error(`FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes.`);
  }
  return cachedKey;
}

/** True when encryption is configured and active. */
function isEncryptionEnabled() {
  try {
    return getKey() !== null;
  } catch {
    return false;
  }
}

/** True when a value is already in our ciphertext envelope. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypts a single value.
 *
 * Non-strings, empty strings and already-encrypted values pass through untouched. That
 * idempotence is what makes the migration script safe to re-run after an interruption — a
 * half-migrated collection can simply be migrated again.
 */
function encryptValue(value) {
  const key = getKey();
  if (!key) return value;
  if (value === null || value === undefined || value === '') return value;
  if (isEncrypted(value)) return value;

  const plain = typeof value === 'string' ? value : String(value);

  // A fresh random IV per encryption. Reusing an IV under one key is the classic GCM failure and
  // breaks confidentiality outright, so it is never derived from the record.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a single value.
 *
 * A value without the prefix is returned as-is — that is a legacy plaintext row, not an error.
 *
 * On genuine failure (wrong key, tampered ciphertext) this returns a placeholder instead of
 * throwing. A hard throw inside getTab would take down every screen that lists customers; the
 * placeholder degrades one field, makes the problem visible in the UI, and logs it loudly. The
 * data is not lost — it is unreadable with the CURRENT key, which is a key-management incident.
 */
function decryptValue(value) {
  if (!isEncrypted(value)) return value;

  const key = getKey();
  if (!key) {
    console.error('Encrypted value found but FIELD_ENCRYPTION_KEY is not set — cannot decrypt.');
    return '[ENCRYPTED — key missing]';
  }

  try {
    const [, , ivB64, tagB64, dataB64] = value.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return '[ENCRYPTED — malformed]';

    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    // Reaching here means the auth tag failed: wrong key, or the stored bytes were altered.
    console.error('Field decryption failed (wrong key or tampered data):', err.message);
    return '[ENCRYPTED — cannot decrypt]';
  }
}

/**
 * Deterministic blind index for looking up a value we cannot search directly.
 *
 * HMAC-SHA256 of the normalised value. Same input always gives the same digest, so an EXACT-match
 * lookup ("is there already a customer with this phone number?") still works against encrypted
 * data. Substring and prefix search do not, and cannot — see docs/ENCRYPTION.md.
 *
 * HMAC rather than a bare hash because a plain SHA-256 of a 10-digit Indian mobile number is
 * brute-forceable in seconds; the secret key is what stops a dump being reversed by enumeration.
 */
function blindIndex(value) {
  const key = getKey();
  if (!key || value === null || value === undefined || value === '') return null;
  const normalised = String(value).toLowerCase().replace(/\s+/g, '');
  return crypto.createHmac('sha256', key).update(normalised).digest('hex');
}

/** Generates a fresh key. Used by scripts/generate-key.js. */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

module.exports = {
  encryptValue,
  decryptValue,
  isEncrypted,
  isEncryptionEnabled,
  blindIndex,
  generateKey,
  PREFIX
};
