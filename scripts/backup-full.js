#!/usr/bin/env node
/**
 * ONE archive that brings the whole system back: code + data + secrets.
 *
 *   node scripts/backup-full.js            # → backups/full/full-<date>/
 *   node scripts/backup-full.js --gzip     # smaller data dump
 *
 * WHY THIS EXISTS ALONGSIDE THE OTHER TWO SCRIPTS
 * backup-db.js captures the database and backup-env.js captures the secrets, but neither carries
 * the application itself — restoring from them still needs a working `git clone`, which assumes
 * GitHub is reachable and the account is intact. This bundles all three so a single folder is
 * sufficient to stand the system up on a machine that has never seen the project.
 *
 * WHAT IS DELIBERATELY NOT INCLUDED
 * `node_modules` — 713 MB across the three copies, every byte of it reproducible by `npm install`
 * from the lockfiles that ARE included. Carrying it would multiply the archive size by a hundred
 * and still be the wrong thing to trust: native modules are compiled per-platform, so a copy taken
 * on Windows can fail on the Linux box you are restoring onto. The lockfiles pin exact versions,
 * which is the part that actually matters for reproducibility.
 *
 * SECRETS ARE ENCRYPTED, THE REST IS NOT
 * `.env` holds the database URI and signing keys, so it is AES-256-GCM encrypted inside the
 * archive and needs ENV_BACKUP_PASSWORD to unpack. The code is already public to anyone with repo
 * access and the data dump is guarded by the folder it sits in — encrypting those too would mean
 * one lost passphrase makes the entire archive worthless, which is a worse failure than the one it
 * would prevent.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const GZIP = args.includes('--gzip');
const flagValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
// How many bundles to retain. Each is ~28 MB, so an unbounded nightly job would fill a disk in a
// couple of months. 0 disables pruning.
const KEEP = Number(flagValue('keep', '7'));
const PASSWORD = process.env.ENV_BACKUP_PASSWORD || process.env.BACKUP_PASSWORD;

// Everything needed to rebuild and run, minus anything regenerable or machine-specific.
const EXCLUDE = new Set([
  'node_modules', '.git', 'backups', 'dist', '.vercel',
  'client_stderr.log', 'client_stdout.log', 'server_stderr.log', 'server_stdout.log'
]);

function istStamp() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
}

/** Recursive copy that skips the excluded names at any depth. */
function copyTree(src, dest, stats) {
  const name = path.basename(src);
  if (EXCLUDE.has(name)) return;

  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dest, entry), stats);
    }
    return;
  }
  // .env is handled separately and encrypted — never copy it in the clear.
  if (name === '.env') return;
  fs.copyFileSync(src, dest);
  stats.files++;
  stats.bytes += st.size;
}

function encrypt(buf, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('ESSENV1'), salt, iv, c.getAuthTag(), ct]);
}

function main() {
  const stamp = istStamp();
  const target = path.join(ROOT, 'backups', 'full', `full-${stamp}`);

  if (!PASSWORD) {
    console.error('\nSet ENV_BACKUP_PASSWORD (or BACKUP_PASSWORD) first — the archive includes');
    console.error('server/.env and that file is always encrypted.\n');
    process.exit(1);
  }
  if (PASSWORD.length < 12) {
    console.error('The passphrase must be at least 12 characters.');
    process.exit(1);
  }

  fs.mkdirSync(target, { recursive: true });
  console.log(`\nBuilding a full restore bundle → backups/full/full-${stamp}\n`);

  // ── 1. CODE ────────────────────────────────────────────────────────────────────────────────
  const codeDir = path.join(target, 'code');
  fs.mkdirSync(codeDir, { recursive: true });
  const stats = { files: 0, bytes: 0 };
  for (const entry of fs.readdirSync(ROOT)) {
    if (EXCLUDE.has(entry)) continue;
    copyTree(path.join(ROOT, entry), path.join(codeDir, entry), stats);
  }
  console.log(`  code      ${String(stats.files).padStart(5)} files  ${(stats.bytes / 1048576).toFixed(1)} MB`);

  // ── 2. DATA ────────────────────────────────────────────────────────────────────────────────
  // Delegated to backup-db.js rather than reimplemented, so the dump format and its checksums
  // stay identical to what verify-backup.js and restore-db.js already understand.
  const dataDir = path.join(target, 'data');
  const dbArgs = [path.join(__dirname, 'backup-db.js'), '--out', dataDir, '--keep', '0'];
  if (GZIP) dbArgs.push('--gzip');
  const dbOut = execFileSync(process.execPath, dbArgs, { encoding: 'utf8' });
  const dbLine = dbOut.trim().split('\n').filter(l => l.includes('Done.')).pop() || '';
  console.log(`  data      ${dbLine.replace('Done. ', '')}`);

  // ── 3. SECRETS ─────────────────────────────────────────────────────────────────────────────
  const envPath = path.join(ROOT, 'server', '.env');
  let envVars = 0;
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath);
    envVars = raw.toString('utf8').split('\n').filter(l => /^\s*[A-Z_]+=/.test(l)).length;
    fs.writeFileSync(path.join(target, 'server.env.enc'), encrypt(raw, PASSWORD));
    console.log(`  secrets   ${envVars} variables (encrypted)`);
  } else {
    console.log('  secrets   server/.env not found — SKIPPED');
  }

  // ── 4. RESTORE INSTRUCTIONS ────────────────────────────────────────────────────────────────
  // Written into the bundle itself: whoever opens this may not have the repo, the chat history,
  // or any memory of how it was built.
  const readme = `RESTORE THIS SYSTEM
===================
Bundle taken: ${stamp} (IST)
Contents:  code/  data/  server.env.enc

You need: Node.js 20+, a MongoDB database (Atlas or local), and the passphrase
used when this bundle was created.

1. COPY THE CODE
   Copy the  code/  folder to where the app should live, then install ALL THREE
   dependency sets — the root one is not optional, several scripts import from it:
       cd <that folder>
       npm install
       npm --prefix client install
       npm --prefix server install

2. RESTORE THE SECRETS
       set ENV_BACKUP_PASSWORD=<the passphrase>
       node scripts/backup-env.js --restore ../server.env.enc
   (adjust the path to server.env.enc as needed)

   If the database is DIFFERENT from the original, edit server/.env and change
   MONGO_URI to the new connection string before continuing.

3. RESTORE THE DATA
       node scripts/verify-backup.js --from ../data/<folder>
       node scripts/restore-db.js --from ../data/<folder> --confirm-overwrite --i-know-this-is-production
   Verify first. If verification fails, do not restore — the dump is damaged.

4. START IT
       npm run dev:server      (port 5000)
       npm run dev:client      (port 5174)
   Or deploy the folder to Vercel and set every variable from server/.env in the
   project's environment settings.

   Use those npm scripts rather than "node server/src/server.js" directly. The
   server calls dotenv.config() with no path, so it reads .env relative to the
   working directory; launched from the project root it finds nothing and exits
   with "JWT_SECRET is not set". The npm scripts set the working directory
   correctly. (Verified — this is the first thing that goes wrong on a restore.)

NOTES
  - node_modules is not in this bundle on purpose; npm install rebuilds it from
    the lockfiles, correctly for the machine you are restoring onto.
  - Log in with an existing staff account. If nobody can get in, run:
        node scripts/reset-auth.js --staff <STAFF_ID> --confirm
    which clears device checks and lockouts directly in the database.
  - Sending email needs SMTP_PASS in server/.env; without it the app runs but
    cannot send.
`;
  fs.writeFileSync(path.join(target, 'RESTORE-README.txt'), readme);

  // ── SUMMARY ────────────────────────────────────────────────────────────────────────────────
  const total = (function size(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? size(p) : fs.statSync(p).size;
    }
    return n;
  })(target);

  console.log(`  readme    RESTORE-README.txt`);
  console.log(`\n  Total: ${(total / 1048576).toFixed(1)} MB`);

  // Prune older bundles. Only directories matching the generated name pattern AND containing a
  // RESTORE-README.txt are considered, so an unrelated folder someone parked under backups/full
  // is never deleted.
  if (Number.isFinite(KEEP) && KEEP > 0) {
    const fullRoot = path.join(ROOT, 'backups', 'full');
    const bundles = fs.readdirSync(fullRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^full-\d{4}-\d{2}-\d{2}_\d{4}$/.test(e.name))
      .filter(e => fs.existsSync(path.join(fullRoot, e.name, 'RESTORE-README.txt')))
      .map(e => e.name)
      .sort();

    const excess = bundles.slice(0, Math.max(0, bundles.length - KEEP));
    for (const name of excess) {
      fs.rmSync(path.join(fullRoot, name), { recursive: true, force: true });
    }
    if (excess.length) console.log(`  Pruned ${excess.length} older bundle(s), keeping the newest ${KEEP}.`);
  }
  console.log(`\n  Keep this folder OFF this machine — external drive or cloud storage.`);
  console.log(`  Store the passphrase separately; without it the secrets cannot be recovered.\n`);
}

main();
