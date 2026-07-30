#!/usr/bin/env node
/**
 * Reverses field-level encryption: turns encrypted rows back into plaintext.
 *
 *   node scripts/decrypt-existing-data.js                          # DRY RUN
 *   node scripts/decrypt-existing-data.js --staff STAFF005 --confirm
 *   node scripts/decrypt-existing-data.js --staff STAFF005 --confirm --only Customer_Master
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * Encryption you cannot undo is a trap. Three situations need it:
 *   - rotating the key (decrypt under the old one, re-encrypt under the new one)
 *   - migrating to another system that does not share this key
 *   - abandoning field encryption without abandoning the data
 * Without this script the only way out would be restoring a pre-encryption backup, losing
 * everything written since.
 *
 * ── WHY IT DEMANDS AN ADMIN PASSWORD ─────────────────────────────────────────────────────────
 * Running this makes every protected field readable in the database and in every backup taken
 * afterwards. That is the exact opposite of what the encryption was turned on for, so it must be a
 * deliberate act by someone who can prove they are an Admin — not something a stray command or a
 * copied line from documentation can do. MONGO_URI alone is not sufficient authority here.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────────────────────
 * Dry run by default. Refuses to write without a backup taken today, because a half-finished
 * decryption is a mixed-state collection and the clean way out of that is a restore.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { decryptValue, isEncrypted, isEncryptionEnabled } = require('../server/src/utils/fieldCrypto');
const { ENCRYPTED_FIELDS, blindIndexFieldsFor } = require('../server/src/utils/encryptedFields');
const { INDEX_SUFFIX } = require('../server/src/utils/cryptoMiddleware');
const { verifyStaffPassword } = require('../server/src/utils/passwordUtils');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const CONFIRM = args.includes('--confirm');
const STAFF_ID = flag('staff', null);
const ONLY = flag('only', null) ? flag('only').split(',').map(s => s.trim()) : null;

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set (server/.env).');
  process.exit(1);
}
if (!isEncryptionEnabled()) {
  console.error('\nFIELD_ENCRYPTION_KEY is not set — there is nothing to decrypt with.');
  console.error('The key that encrypted the data is the only key that can read it back.\n');
  process.exit(1);
}

/** Same guard as the encrypt script: refuse to write without a backup from today. */
function backupTakenToday() {
  const roots = [path.join(__dirname, '../backups'), path.join(__dirname, '../backups/full')];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = fs.readdirSync(root).some(d => d.includes(today));
    if (hit) return true;
  }
  return false;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  // ── Admin proof, before anything is read or written ──────────────────────────────────────
  if (CONFIRM) {
    if (!STAFF_ID) {
      console.error('\n  --confirm also requires --staff <ADMIN_STAFF_ID> and that admin\'s password.');
      console.error('  Decrypting exposes every protected field; it must be an authorised act.\n');
      await mongoose.disconnect();
      process.exit(1);
    }

    const staff = await db.collection('Staff_Master').findOne({ Staff_ID: STAFF_ID.toUpperCase() });
    if (!staff) {
      console.error(`\n  No staff member "${STAFF_ID}".\n`);
      await mongoose.disconnect();
      process.exit(1);
    }
    if (String(staff.Role || '').toLowerCase() !== 'admin') {
      console.error(`\n  ${STAFF_ID} is not an Admin. Only an Admin can decrypt.\n`);
      await mongoose.disconnect();
      process.exit(1);
    }

    // Read the password without echoing it, so it does not land in shell history or scrollback.
    const password = await new Promise((resolve) => {
      process.stdout.write(`  Password for ${staff.Name} (${STAFF_ID}): `);
      const stdin = process.stdin;
      stdin.setEncoding('utf8');
      if (stdin.isTTY) stdin.setRawMode(true);
      let buf = '';
      stdin.on('data', function onData(ch) {
        if (ch === '\r' || ch === '\n' || ch === '') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '') { buf = buf.slice(0, -1); return; }
        buf += ch;
      });
      stdin.resume();
    });

    if (!verifyStaffPassword(staff, password)) {
      console.error('\n  Incorrect password. Nothing was changed.\n');
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log('  Admin verified.\n');

    if (!backupTakenToday()) {
      console.error('  REFUSING: no backup from today.');
      console.error('  Run `npm run backup` (or `npm run backup:full`) first — a partly-decrypted');
      console.error('  collection is recovered by restoring, not by re-running this.\n');
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  console.log(CONFIRM ? 'DECRYPTING (writes enabled)\n' : 'DRY RUN — no writes. Add --confirm to apply.\n');

  let totalDocs = 0, totalFields = 0;

  for (const [collection, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    if (ONLY && !ONLY.includes(collection)) continue;

    let docs;
    try {
      docs = await db.collection(collection).find({}).toArray();
    } catch (err) {
      console.log(`  ${collection.padEnd(26)} skipped (${err.message})`);
      continue;
    }
    if (!docs.length) continue;

    const indexed = blindIndexFieldsFor(collection) || [];
    let docsChanged = 0, fieldsChanged = 0;

    for (const doc of docs) {
      const update = {};
      const unset = {};

      for (const field of fields) {
        const value = doc[field];
        if (!isEncrypted(value)) continue;
        const plain = decryptValue(value);
        // A placeholder means this row was written under a DIFFERENT key. Overwriting it with
        // "[ENCRYPTED — cannot decrypt]" would destroy the ciphertext and with it any chance of
        // recovering the row once the right key turns up.
        if (typeof plain === 'string' && plain.startsWith('[ENCRYPTED')) {
          console.log(`  ${collection}: ${doc._id} field ${field} — WRONG KEY, left untouched`);
          continue;
        }
        update[field] = plain;
        fieldsChanged++;
      }

      // The blind-index columns exist only to search ciphertext; once plaintext is back they are
      // dead weight that also leaks an HMAC of the value.
      for (const field of indexed) {
        const col = `${field}${INDEX_SUFFIX}`;
        if (doc[col] !== undefined) unset[col] = '';
      }

      if (!Object.keys(update).length && !Object.keys(unset).length) continue;
      docsChanged++;
      if (CONFIRM) {
        const ops = {};
        if (Object.keys(update).length) ops.$set = update;
        if (Object.keys(unset).length) ops.$unset = unset;
        await db.collection(collection).updateOne({ _id: doc._id }, ops);
      }
    }

    totalDocs += docsChanged;
    totalFields += fieldsChanged;
    if (docsChanged) {
      console.log(`  ${collection.padEnd(26)} ${String(docsChanged).padStart(5)} docs / ${String(fieldsChanged).padStart(5)} fields ${CONFIRM ? 'decrypted' : 'would be decrypted'}`);
    }
  }

  await mongoose.disconnect();

  console.log(`\n${totalDocs} documents, ${totalFields} fields ${CONFIRM ? 'decrypted.' : 'pending.'}`);
  if (!CONFIRM && totalFields > 0) {
    console.log('Re-run with --staff <ADMIN_ID> --confirm to apply.');
  }
  if (CONFIRM && totalFields > 0) {
    console.log('\nThe data is now PLAINTEXT in the database and in every backup taken from now on.');
    console.log('Remove FIELD_ENCRYPTION_KEY from server/.env and Vercel only if you are done with');
    console.log('encryption entirely — leaving it set means new writes are encrypted again.');
  }
}

main().catch(err => {
  console.error('Decrypt failed:', err.message);
  process.exit(1);
});
