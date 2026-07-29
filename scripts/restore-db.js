#!/usr/bin/env node
/**
 * Restores a backup produced by scripts/backup-db.js.
 *
 *   node scripts/restore-db.js --from backups/2026-07-29_043000 --dry-run
 *   node scripts/restore-db.js --from backups/2026-07-29_043000 --to mongodb://localhost:27017/crm_restore_test
 *   node scripts/restore-db.js --from backups/... --only Staff_Master,Task_Master --confirm-overwrite
 *
 * THIS SCRIPT WRITES. Three guards stand between a typo and a destroyed production database:
 *
 *   1. --dry-run is the DEFAULT. Without --confirm-overwrite it reports what it would do and
 *      exits without touching anything.
 *   2. Restoring over the URI in server/.env (production) additionally requires --i-know-this-is-production.
 *      The intended target is --to, pointing at a scratch database.
 *   3. Each collection is replaced inside a single deleteMany+insertMany, and only after its file
 *      parses — a corrupt dump aborts before the existing data is cleared.
 *
 * Restoring into a scratch database is also how the quarterly restore drill is performed. A
 * backup nobody has restored is a hypothesis, not a backup.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Reverses encryptBuffer() from backup-db.js.
 *   magic "ESSBAK1" | salt(16) | iv(12) | authTag(16) | ciphertext
 *
 * A wrong password fails on the GCM auth tag rather than yielding garbage, so a mistyped
 * passphrase is reported as such instead of producing a corrupt restore.
 */
function decryptBuffer(buf, password) {
  const magic = buf.subarray(0, 7).toString();
  if (magic !== 'ESSBAK1') throw new Error('not an encrypted ESS backup file');
  const salt = buf.subarray(7, 23);
  const iv = buf.subarray(23, 35);
  const tag = buf.subarray(35, 51);
  const data = buf.subarray(51);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error('decryption failed — wrong BACKUP_PASSWORD, or the file was altered');
  }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const FROM = flag('from', null);
const ONLY = flag('only', null);
const TARGET_URI = flag('to', process.env.MONGO_URI);
const CONFIRMED = has('confirm-overwrite');
const PROD_ACK = has('i-know-this-is-production');

if (!FROM) {
  console.error('Specify a backup directory:  --from backups/YYYY-MM-DD_HHMMSS');
  process.exit(1);
}
if (!TARGET_URI) {
  console.error('No target. Pass --to <uri>, or set MONGO_URI in server/.env.');
  process.exit(1);
}

const dir = path.resolve(FROM);
if (!fs.existsSync(path.join(dir, '_manifest.json'))) {
  console.error(`No _manifest.json in ${dir} — not a completed backup directory.`);
  process.exit(1);
}

const isProduction = TARGET_URI === process.env.MONGO_URI;
if (isProduction && CONFIRMED && !PROD_ACK) {
  console.error('\nREFUSING: target is the MONGO_URI from server/.env — the production cluster.');
  console.error('Restore into a scratch database with --to, or add --i-know-this-is-production.\n');
  process.exit(1);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '_manifest.json'), 'utf8'));
  const wanted = ONLY ? new Set(ONLY.split(',').map(s => s.trim())) : null;

  const files = fs.readdirSync(dir)
    .filter(f => f !== '_manifest.json' && /\.json(\.gz)?(\.enc)?$/.test(f))
    .filter(f => !wanted || wanted.has(f.replace(/\.json(\.gz)?(\.enc)?$/, '')));

  if (manifest.encrypted && !process.env.BACKUP_PASSWORD) {
    console.error('\nThis backup is encrypted. Set BACKUP_PASSWORD in the environment to restore it.\n');
    process.exit(1);
  }

  console.log(`Backup   : ${dir}`);
  console.log(`Taken    : ${manifest.istDate} (${manifest.totalDocuments} documents)`);
  console.log(`Target   : ${TARGET_URI.replace(/\/\/[^@]*@/, '//****:****@')}`);
  console.log(`Mode     : ${CONFIRMED ? 'WRITE — existing collections will be REPLACED' : 'DRY RUN (no writes)'}\n`);

  await mongoose.connect(TARGET_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  let restored = 0;
  for (const file of files.sort()) {
    const name = file.replace(/\.json(\.gz)?(\.enc)?$/, '');
    const raw = fs.readFileSync(path.join(dir, file));
    let docs;
    try {
      // Unwrap in the reverse order of writing: decrypt, then decompress, then parse. Parsing
      // happens BEFORE anything is deleted — a truncated or undecryptable dump must not clear a
      // good collection.
      let buf = raw;
      if (file.endsWith('.enc')) buf = decryptBuffer(buf, process.env.BACKUP_PASSWORD);
      if (/\.gz(\.enc)?$/.test(file)) buf = zlib.gunzipSync(buf);
      docs = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      console.error(`  ${name.padEnd(32)} SKIPPED — unreadable (${err.message})`);
      continue;
    }

    const existing = await db.collection(name).countDocuments();
    if (!CONFIRMED) {
      console.log(`  ${name.padEnd(32)} would replace ${String(existing).padStart(6)} with ${String(docs.length).padStart(6)} docs`);
      continue;
    }

    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    console.log(`  ${name.padEnd(32)} replaced ${String(existing).padStart(6)} → ${String(docs.length).padStart(6)} docs`);
    restored++;
  }

  await mongoose.disconnect();
  console.log(CONFIRMED
    ? `\nRestore complete — ${restored} collection(s).`
    : '\nDry run only. Re-run with --confirm-overwrite to apply.');
}

main().catch(err => {
  console.error('Restore failed:', err.message);
  process.exit(1);
});
