#!/usr/bin/env node
/**
 * Daily backup of every collection to timestamped JSON, plus pruning of old backups.
 *
 *   node scripts/backup-db.js                 # write a backup, prune to the retention window
 *   node scripts/backup-db.js --out D:/bak    # somewhere other than ./backups
 *   node scripts/backup-db.js --keep 30       # retention in days (default 14)
 *   node scripts/backup-db.js --gzip          # compress each dump
 *
 * READ-ONLY against the database: it opens the connection, reads, and writes files locally. It
 * never updates, deletes or emails anything, so it is safe to run against production — which
 * matters here, because dev and production share one Atlas cluster.
 *
 * JSON per collection rather than mongodump/BSON deliberately: no external binary to install on
 * the operator's Windows machine, and a dump stays greppable when someone needs to answer "what
 * did this certificate say last Tuesday" without restoring anything.
 *
 * Atlas already takes its own snapshots. This is the second copy that lives somewhere Atlas does
 * not control — a backup you cannot restore without the vendor that lost your data is not a
 * backup. See DISASTER_RECOVERY.md for the restore procedure and the drill schedule.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const OUT_ROOT = path.resolve(flag('out', path.join(__dirname, '../backups')));
const KEEP_DAYS = Number(flag('keep', 14));
const GZIP = has('gzip');

// --encrypt turns each dump into an AES-256-GCM file readable only with BACKUP_PASSWORD.
// This is what makes it safe to push backups to Google Drive / OneDrive: a plaintext dump in a
// cloud folder is the entire customer database sitting in someone else's datacentre.
const ENCRYPT = has('encrypt');
const BACKUP_PASSWORD = process.env.BACKUP_PASSWORD;

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI is not set. Populate server/.env before running a backup.');
  process.exit(1);
}
if (ENCRYPT && !BACKUP_PASSWORD) {
  console.error('--encrypt requires BACKUP_PASSWORD in the environment (server/.env).');
  console.error('Use a long random passphrase and store it in your password manager.');
  process.exit(1);
}
if (ENCRYPT && BACKUP_PASSWORD.length < 12) {
  // A backup password is offline-attackable: whoever holds the file can grind it forever.
  console.error('BACKUP_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

/**
 * Encrypts one dump with AES-256-GCM, key derived from the passphrase with scrypt.
 *
 * scrypt (not a bare hash) because the password is human-chosen and the attacker is offline with
 * the file in hand; scrypt's memory-hardness is what makes brute force expensive. A fresh random
 * salt per FILE means two dumps of the same collection never share a key, and a fresh IV means
 * they never share a keystream.
 *
 * Header layout, so restore can read it without a sidecar:
 *   magic "ESSBAK1" | salt(16) | iv(12) | authTag(16) | ciphertext
 */
function encryptBuffer(plainBuffer, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  return Buffer.concat([Buffer.from('ESSBAK1'), salt, iv, cipher.getAuthTag(), ciphertext]);
}

/** IST, matching the rest of the app — the deployment clock may not be local time. */
function istStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}${parts.minute}${parts.second}`
  };
}

async function main() {
  const { date, time } = istStamp();
  const target = path.join(OUT_ROOT, `${date}_${time}`);
  fs.mkdirSync(target, { recursive: true });

  console.log(`Backup starting → ${target}`);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 20000 });

  const collections = await mongoose.connection.db.listCollections().toArray();
  // `encrypted`/`gzip` are recorded so restore-db.js can read the dump without being told, and so
  // an operator can tell at a glance whether an archived folder is safe to hand to anyone.
  const manifest = {
    startedAt: new Date().toISOString(),
    istDate: date,
    encrypted: ENCRYPT,
    gzip: GZIP,
    collections: {},
    totalDocuments: 0
  };
  let failed = 0;

  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const docs = await mongoose.connection.db.collection(name).find({}).toArray();
      const body = JSON.stringify(docs, null, GZIP ? 0 : 2);

      // Compress BEFORE encrypting. Ciphertext is indistinguishable from random and does not
      // compress, so gzipping afterwards would cost CPU and save nothing.
      let payload = GZIP ? zlib.gzipSync(body) : Buffer.from(body, 'utf8');
      if (ENCRYPT) payload = encryptBuffer(payload, BACKUP_PASSWORD);

      const file = path.join(target, `${name}.json${GZIP ? '.gz' : ''}${ENCRYPT ? '.enc' : ''}`);
      fs.writeFileSync(file, payload);

      const bytes = fs.statSync(file).size;
      // SHA-256 of the bytes actually written to disk (after gzip/encrypt), so verification can
      // detect silent corruption — a truncated write, a bad disk sector, a half-finished cloud
      // sync. A document count alone cannot: a file can hold the right number of records and
      // still be damaged.
      const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
      manifest.collections[name] = { documents: docs.length, bytes, sha256 };
      manifest.totalDocuments += docs.length;
      console.log(`  ${name.padEnd(32)} ${String(docs.length).padStart(6)} docs  ${(bytes / 1024).toFixed(1)} KB`);
    } catch (err) {
      // One unreadable collection must not abandon the other thirty-five.
      failed++;
      manifest.collections[name] = { error: err.message };
      console.error(`  ${name.padEnd(32)} FAILED: ${err.message}`);
    }
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.failedCollections = failed;
  fs.writeFileSync(path.join(target, '_manifest.json'), JSON.stringify(manifest, null, 2));

  // Prune only well-formed backup directories, so an unrelated folder under --out is never
  // deleted by a mistyped path.
  let pruned = 0;
  if (Number.isFinite(KEEP_DAYS) && KEEP_DAYS > 0) {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const entry of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(entry.name)) continue;
      const dir = path.join(OUT_ROOT, entry.name);
      // Requires a manifest: never delete a directory this script did not finish writing.
      if (!fs.existsSync(path.join(dir, '_manifest.json'))) continue;
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned++;
      }
    }
  }

  await mongoose.disconnect();

  console.log(`\nDone. ${manifest.totalDocuments} documents from ${collections.length} collections.`);
  if (pruned) console.log(`Pruned ${pruned} backup(s) older than ${KEEP_DAYS} days.`);
  if (failed) {
    console.error(`${failed} collection(s) failed — this backup is INCOMPLETE.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
