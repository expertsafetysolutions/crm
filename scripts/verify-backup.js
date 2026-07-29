#!/usr/bin/env node
/**
 * Checks that a backup is actually restorable — before you need it to be.
 *
 *   node scripts/verify-backup.js                    # newest backup in ./backups
 *   node scripts/verify-backup.js --from backups/2026-07-29_213000
 *   node scripts/verify-backup.js --json             # machine-readable, for the cron job
 *
 * WHY A DOCUMENT COUNT WAS NOT ENOUGH
 * The manifest already recorded how many documents each collection held, and restore-db.js
 * checked the manifest existed. Neither catches the failure that actually happens: a file that is
 * present, has a plausible size, and is quietly damaged — a truncated write, a bad sector, an
 * interrupted cloud sync. So each dump now carries a SHA-256 taken at write time, and this script
 * recomputes it. One flipped bit anywhere in the file changes the digest completely.
 *
 * For unencrypted dumps it goes further and parses the JSON, comparing the real record count to
 * the manifest. That catches a file which is intact on disk but was written from a failed query.
 *
 * READ-ONLY. Touches no database and modifies no backup. Safe to run at any time.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const JSON_OUT = args.includes('--json');
const OUT_ROOT = path.resolve(flag('root', path.join(__dirname, '../backups')));

/** Newest completed backup directory — the one a restore would reach for first. */
function newestBackup(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(e.name))
    .filter(e => fs.existsSync(path.join(root, e.name, '_manifest.json')))
    .map(e => e.name)
    .sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

function verify(dir) {
  const result = {
    backup: dir,
    status: 'HEALTHY',
    checkedAt: new Date().toISOString(),
    istDate: null,
    collections: 0,
    documents: 0,
    problems: []
  };

  const manifestPath = path.join(dir, '_manifest.json');
  if (!fs.existsSync(manifestPath)) {
    result.status = 'FAILED';
    result.problems.push('No _manifest.json — this backup never finished writing.');
    return result;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    result.status = 'FAILED';
    result.problems.push(`_manifest.json is unreadable: ${err.message}`);
    return result;
  }

  result.istDate = manifest.istDate || null;
  result.documents = manifest.totalDocuments || 0;

  if (manifest.failedCollections > 0) {
    result.status = 'FAILED';
    result.problems.push(`${manifest.failedCollections} collection(s) failed during the backup itself.`);
  }

  const suffix = `${manifest.gzip ? '.gz' : ''}${manifest.encrypted ? '.enc' : ''}`;

  for (const [name, meta] of Object.entries(manifest.collections || {})) {
    if (meta.error) {
      result.problems.push(`${name}: was not backed up (${meta.error})`);
      result.status = 'FAILED';
      continue;
    }
    result.collections++;

    const file = path.join(dir, `${name}.json${suffix}`);
    if (!fs.existsSync(file)) {
      result.problems.push(`${name}: dump file is missing`);
      result.status = 'FAILED';
      continue;
    }

    const buf = fs.readFileSync(file);

    if (buf.length !== meta.bytes) {
      result.problems.push(`${name}: size changed (${meta.bytes} → ${buf.length} bytes)`);
      result.status = 'FAILED';
      continue;
    }

    // Older backups predate the checksum. Report that honestly rather than passing silently —
    // "not verifiable" is a different state from "verified good".
    if (!meta.sha256) {
      result.problems.push(`${name}: no checksum recorded (backup predates integrity checking)`);
      if (result.status === 'HEALTHY') result.status = 'UNVERIFIED';
      continue;
    }

    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== meta.sha256) {
      result.problems.push(`${name}: CORRUPTED — checksum does not match`);
      result.status = 'FAILED';
      continue;
    }

    // Encrypted dumps cannot be counted without the password; their AES-GCM auth tag already
    // provides tamper detection at restore time, so the checksum above is sufficient here.
    if (!manifest.encrypted) {
      try {
        const text = manifest.gzip ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        const docs = JSON.parse(text);
        if (Array.isArray(docs) && docs.length !== meta.documents) {
          result.problems.push(`${name}: expected ${meta.documents} records, file holds ${docs.length}`);
          result.status = 'FAILED';
        }
      } catch (err) {
        result.problems.push(`${name}: unreadable — ${err.message}`);
        result.status = 'FAILED';
      }
    }
  }

  if (result.collections === 0) {
    result.status = 'FAILED';
    result.problems.push('Backup contains no collections.');
  }

  // A backup that is intact but old is not a healthy backup — it just means nobody has taken one
  // recently. Surfaced as STALE so the dashboard can say so rather than showing a reassuring tick.
  if (result.status === 'HEALTHY' && manifest.finishedAt) {
    const ageHours = (Date.now() - Date.parse(manifest.finishedAt)) / 3600000;
    if (ageHours > 48) {
      result.status = 'STALE';
      result.problems.push(`Newest backup is ${Math.floor(ageHours / 24)} day(s) old.`);
    }
  }

  return result;
}

/**
 * Reports the verdict to the running app so the Admin dashboard can show it.
 *
 * Best-effort by design: this script's real job is to tell the operator whether the backup is
 * good. If the app is unreachable that must not turn a successful verification into a failure —
 * the exit code still reflects the BACKUP's health, not the network's.
 */
async function report(result) {
  const base = process.env.PUBLIC_BASE_URL || process.env.BACKUP_STATUS_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) return;
  if (!secret) {
    console.log('  (not reported — CRON_SECRET is not set)');
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/cron/backup-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(result)
    });
    console.log(res.ok ? '  (status reported to dashboard)' : `  (dashboard rejected the report: HTTP ${res.status})`);
  } catch (err) {
    console.log(`  (dashboard unreachable: ${err.message})`);
  }
}

function main() {
  const dir = flag('from', null) ? path.resolve(flag('from')) : newestBackup(OUT_ROOT);

  if (!dir) {
    const out = {
      status: 'FAILED', checkedAt: new Date().toISOString(),
      problems: [`No completed backup found in ${OUT_ROOT}. Run: npm run backup`],
      collections: 0, documents: 0
    };
    if (JSON_OUT) { console.log(JSON.stringify(out)); process.exit(1); }
    console.error(`\n  FAILED — no backup found in ${OUT_ROOT}`);
    console.error('  Run: npm run backup\n');
    process.exit(1);
  }

  const result = verify(dir);

  if (JSON_OUT) {
    console.log(JSON.stringify(result));
    process.exit(result.status === 'FAILED' ? 1 : 0);
  }

  const icon = { HEALTHY: 'HEALTHY  ✅', STALE: 'STALE  ⚠️', UNVERIFIED: 'UNVERIFIED  ⚠️', FAILED: 'FAILED  ❌' }[result.status];
  console.log(`\n  Backup : ${result.backup}`);
  console.log(`  Taken  : ${result.istDate || 'unknown'}`);
  console.log(`  Content: ${result.collections} collections, ${result.documents} documents`);
  console.log(`  Status : ${icon}\n`);

  if (result.problems.length) {
    for (const p of result.problems) console.log(`    - ${p}`);
    console.log('');
  } else {
    console.log('    Every file matches its checksum and record count.\n');
  }

  // Opt-in: --report sends the verdict to the dashboard. Off by default so simply checking a
  // backup never makes a network call the operator did not ask for.
  if (args.includes('--report')) {
    report(result).finally(() => process.exit(result.status === 'FAILED' ? 1 : 0));
    return;
  }
  process.exit(result.status === 'FAILED' ? 1 : 0);
}

main();

module.exports = { verify, newestBackup };
