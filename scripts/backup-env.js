#!/usr/bin/env node
/**
 * Encrypted backup of server/.env — the one file the database backup cannot contain.
 *
 *   node scripts/backup-env.js                 # writes backups/env/env-<date>.enc
 *   node scripts/backup-env.js --restore <file>
 *
 * WHY THIS IS SEPARATE FROM backup-db.js
 * `.env` holds MONGO_URI, JWT_SECRET, SMTP_PASS and (once configured) FIELD_ENCRYPTION_KEY. Those
 * are the keys to everything else, so they must never sit in the same archive as the data they
 * protect — a single leaked folder would otherwise hand over both the database dump and the means
 * to decrypt it. It is also excluded from git by design, which means a lost laptop currently loses
 * it outright: the code comes back from GitHub and the data from a dump, but without these values
 * the app will not start.
 *
 * ALWAYS ENCRYPTED. There is no plaintext mode, deliberately — an unencrypted copy of this file is
 * a strictly worse thing to have lying around than no copy at all.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const ENV_PATH = path.join(__dirname, '../server/.env');
const OUT_DIR = path.join(__dirname, '../backups/env');
const PASSWORD = process.env.ENV_BACKUP_PASSWORD || process.env.BACKUP_PASSWORD;
const MAGIC = 'ESSENV1';

if (!PASSWORD) {
  console.error('\nSet ENV_BACKUP_PASSWORD (or reuse BACKUP_PASSWORD) before running this.');
  console.error('Use a long passphrase and keep it in your password manager — NOT in .env,');
  console.error('because that is the very file being encrypted.\n');
  process.exit(1);
}
if (PASSWORD.length < 12) {
  console.error('The passphrase must be at least 12 characters — this file is offline-attackable.');
  process.exit(1);
}

/** Same construction as backup-db.js: scrypt KDF, AES-256-GCM, salt+iv+tag in the header. */
function encrypt(buf, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC), salt, iv, cipher.getAuthTag(), ct]);
}

function decrypt(buf, password) {
  if (buf.subarray(0, 7).toString() !== MAGIC) throw new Error('not an encrypted .env backup');
  const key = crypto.scryptSync(password, buf.subarray(7, 23), 32, { N: 16384, r: 8, p: 1 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(23, 35));
  d.setAuthTag(buf.subarray(35, 51));
  try {
    return Buffer.concat([d.update(buf.subarray(51)), d.final()]);
  } catch {
    throw new Error('decryption failed — wrong passphrase, or the file was altered');
  }
}

function istDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const restoreTarget = flag('restore', null);

if (restoreTarget) {
  const src = path.resolve(restoreTarget);
  if (!fs.existsSync(src)) {
    console.error(`\nNo such file: ${src}\n`);
    process.exit(1);
  }
  let plain;
  try {
    plain = decrypt(fs.readFileSync(src), PASSWORD);
  } catch (err) {
    // A stack trace here is noise: the only useful information is that the passphrase is wrong.
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }

  // Never overwrite a working .env without keeping the current one — recovering from a bad restore
  // here means recovering the ability to start the app at all.
  if (fs.existsSync(ENV_PATH)) {
    const aside = `${ENV_PATH}.replaced-${Date.now()}`;
    fs.copyFileSync(ENV_PATH, aside);
    console.log(`  Existing .env kept as: ${path.basename(aside)}`);
  }
  fs.writeFileSync(ENV_PATH, plain);
  console.log(`\n  Restored server/.env (${plain.length} bytes).\n`);
  process.exit(0);
}

if (!fs.existsSync(ENV_PATH)) {
  console.error('\nserver/.env does not exist — nothing to back up.\n');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const raw = fs.readFileSync(ENV_PATH);
const out = path.join(OUT_DIR, `env-${istDate()}.enc`);
fs.writeFileSync(out, encrypt(raw, PASSWORD));

// Count the variables so the operator can sanity-check the copy without decrypting it.
const varCount = raw.toString('utf8').split('\n').filter(l => /^\s*[A-Z_]+=/.test(l)).length;

console.log(`\n  Encrypted server/.env → ${path.relative(process.cwd(), out)}`);
console.log(`  ${varCount} variables, ${fs.statSync(out).size} bytes on disk.`);
console.log('\n  Keep a copy OFF this machine (password manager attachment or a cloud folder).');
console.log('  Without the passphrase this file cannot be recovered — store that separately.\n');
