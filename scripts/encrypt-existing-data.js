#!/usr/bin/env node
/**
 * One-time migration: encrypts the protected fields of rows already in the database.
 *
 *   node scripts/encrypt-existing-data.js                      # DRY RUN — reports, writes nothing
 *   node scripts/encrypt-existing-data.js --confirm            # actually encrypt
 *   node scripts/encrypt-existing-data.js --confirm --only Customer_Master
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────────────────────
 * Dry run is the DEFAULT, and the script refuses to write unless a backup exists from today —
 * this rewrites live customer records in place, and a wrong or lost key afterwards means the
 * data cannot be read back. Take a backup first:  npm run backup
 *
 * Idempotent: encryptValue() skips anything already carrying the `enc:v1:` prefix, so an
 * interrupted run can simply be re-run. It works document-by-document rather than in one
 * transaction, so a crash leaves a partially-encrypted collection — which the app handles
 * (plaintext and ciphertext coexist) and a re-run completes.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { encryptValue, isEncrypted, isEncryptionEnabled, blindIndex } = require('../server/src/utils/fieldCrypto');
const { ENCRYPTED_FIELDS, blindIndexFieldsFor } = require('../server/src/utils/encryptedFields');
const { INDEX_SUFFIX } = require('../server/src/utils/cryptoMiddleware');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const onlyIdx = args.indexOf('--only');
const ONLY = onlyIdx !== -1 && args[onlyIdx + 1] ? args[onlyIdx + 1].split(',').map(s => s.trim()) : null;

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set (server/.env).');
  process.exit(1);
}
if (!isEncryptionEnabled()) {
  console.error('\nFIELD_ENCRYPTION_KEY is not set — nothing to migrate to.');
  console.error('Generate one with:  npm run keygen\n');
  process.exit(1);
}

/** Refuses to write without a backup taken today. */
function backupTakenToday() {
  const root = path.join(__dirname, '../backups');
  if (!fs.existsSync(root)) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return fs.readdirSync(root).some(d =>
    d.startsWith(today) && fs.existsSync(path.join(root, d, '_manifest.json'))
  );
}

if (CONFIRM && !backupTakenToday()) {
  console.error('\nREFUSING: no completed backup from today in ./backups.');
  console.error('This rewrites live customer records. Run  npm run backup  first.\n');
  process.exit(1);
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  console.log(CONFIRM ? '\nENCRYPTING (writes enabled)\n' : '\nDRY RUN — no writes. Add --confirm to apply.\n');

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
    if (!docs.length) {
      console.log(`  ${collection.padEnd(26)} empty`);
      continue;
    }

    const indexed = blindIndexFieldsFor(collection) || [];
    let docsChanged = 0, fieldsChanged = 0;

    for (const doc of docs) {
      const update = {};

      for (const field of fields) {
        const value = doc[field];
        if (value === null || value === undefined || value === '') continue;
        if (isEncrypted(value)) continue;              // already done — idempotent
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        update[field] = encryptValue(value);
        fieldsChanged++;
      }

      // Blind index from the plaintext, before it is replaced above.
      for (const field of indexed) {
        const value = doc[field];
        if (value && !isEncrypted(value)) {
          const digest = blindIndex(value);
          if (digest) update[`${field}${INDEX_SUFFIX}`] = digest;
        }
      }

      if (Object.keys(update).length === 0) continue;
      docsChanged++;
      if (CONFIRM) {
        await db.collection(collection).updateOne({ _id: doc._id }, { $set: update });
      }
    }

    totalDocs += docsChanged;
    totalFields += fieldsChanged;
    console.log(`  ${collection.padEnd(26)} ${String(docsChanged).padStart(5)} docs / ${String(fieldsChanged).padStart(5)} fields ${CONFIRM ? 'encrypted' : 'would be encrypted'}`);
  }

  await mongoose.disconnect();

  console.log(`\n${totalDocs} documents, ${totalFields} fields ${CONFIRM ? 'encrypted.' : 'pending.'}`);
  if (!CONFIRM && totalFields > 0) {
    console.log('Re-run with --confirm to apply (a backup from today is required).');
  }
  if (CONFIRM) {
    console.log('\nVerify now:  npm run verify:encryption');
    console.log('Confirm a raw dump shows ciphertext before considering this done.');
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
