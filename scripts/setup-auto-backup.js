#!/usr/bin/env node
/**
 * Registers (or removes) a nightly full backup in Windows Task Scheduler.
 *
 *   node scripts/setup-auto-backup.js                 # show what would be scheduled
 *   node scripts/setup-auto-backup.js --install       # create the scheduled task
 *   node scripts/setup-auto-backup.js --time 21:30    # pick the hour (default 21:30 IST)
 *   node scripts/setup-auto-backup.js --uninstall
 *
 * WHY NOT A VERCEL CRON
 * Two reasons, both hard. A serverless filesystem is discarded when the invocation ends, so a
 * backup written there would not survive long enough to be useful — and the Hobby plan allows one
 * cron per day, which vercel.json already spends on reminder-dispatch. Adding a second entry makes
 * the deploy fail outright.
 *
 * The backup also has to end up on THIS machine to be copied to an external drive, which is the
 * whole point of the exercise. So the schedule belongs here.
 *
 * WHAT IT SCHEDULES
 * `npm run backup:full`, wrapped in a .cmd so the passphrase is not visible in the task's argument
 * list (Task Scheduler shows those to any user who can read the task).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TASK_NAME = 'ExpertCRM-NightlyFullBackup';
const RUNNER = path.join(ROOT, 'scripts', 'run-nightly-backup.cmd');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const INSTALL = args.includes('--install');
const UNINSTALL = args.includes('--uninstall');
const TIME = flag('time', '21:30');
const KEEP = flag('keep', '7');

if (process.platform !== 'win32') {
  console.error('\nThis helper targets Windows Task Scheduler. On macOS/Linux use cron:');
  console.error(`  30 21 * * *  cd "${ROOT}" && npm run backup:full\n`);
  process.exit(1);
}

if (!/^\d{1,2}:\d{2}$/.test(TIME)) {
  console.error(`\nInvalid --time "${TIME}". Use 24-hour HH:MM, e.g. 21:30.\n`);
  process.exit(1);
}

if (UNINSTALL) {
  try {
    execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe' });
    console.log(`\n  Removed scheduled task "${TASK_NAME}".\n`);
  } catch {
    console.log(`\n  No scheduled task named "${TASK_NAME}" was found.\n`);
  }
  if (fs.existsSync(RUNNER)) {
    fs.unlinkSync(RUNNER);
    console.log('  Removed scripts/run-nightly-backup.cmd\n');
  }
  process.exit(0);
}

const PASSWORD = process.env.ENV_BACKUP_PASSWORD || process.env.BACKUP_PASSWORD;

if (!INSTALL) {
  console.log('\n  Would schedule a nightly full backup:');
  console.log(`    task    : ${TASK_NAME}`);
  console.log(`    runs    : every day at ${TIME}`);
  console.log(`    command : npm run backup:full`);
  console.log(`    output  : backups/full/`);
  console.log(`    keeps   : the newest ${KEEP} bundles\n`);
  console.log('  Re-run with --install to create it.');
  console.log('  Set ENV_BACKUP_PASSWORD first — the bundle encrypts server/.env.\n');
  process.exit(0);
}

if (!PASSWORD) {
  console.error('\n  Set ENV_BACKUP_PASSWORD before installing:');
  console.error('      set ENV_BACKUP_PASSWORD=your-long-passphrase');
  console.error('      node scripts/setup-auto-backup.js --install\n');
  console.error('  It is written into scripts/run-nightly-backup.cmd, which is git-ignored.\n');
  process.exit(1);
}

/**
 * The passphrase lives in this .cmd rather than in the scheduled task's arguments, because
 * `schtasks /Query /V` prints arguments in clear text to anyone who can list tasks. The file is
 * covered by .gitignore (see the entry added alongside this script) so it cannot be committed.
 */
const runner = `@echo off
REM Nightly full backup for the Expert Safety CRM. Created by scripts/setup-auto-backup.js.
REM CONTAINS A PASSPHRASE — git-ignored, do not copy this file anywhere shared.
cd /d "${ROOT}"
set ENV_BACKUP_PASSWORD=${PASSWORD}
call npm run backup:full -- --gzip --keep ${KEEP} >> "${path.join(ROOT, 'backups', 'nightly.log')}" 2>&1
`;

fs.mkdirSync(path.join(ROOT, 'backups'), { recursive: true });
fs.writeFileSync(RUNNER, runner);

try {
  execFileSync('schtasks', [
    '/Create', '/TN', TASK_NAME, '/TR', `"${RUNNER}"`,
    '/SC', 'DAILY', '/ST', TIME, '/F'
  ], { stdio: 'pipe' });

  console.log(`\n  Scheduled "${TASK_NAME}" — runs daily at ${TIME}.`);
  console.log(`  Output goes to backups/full/, log to backups/nightly.log\n`);
  console.log('  Check it:   schtasks /Query /TN ' + TASK_NAME);
  console.log('  Run now:    schtasks /Run   /TN ' + TASK_NAME);
  console.log('  Remove:     node scripts/setup-auto-backup.js --uninstall\n');
  console.log('  The PC must be on at that time — Task Scheduler cannot wake a powered-off machine.\n');
} catch (err) {
  console.error('\n  Could not create the scheduled task.');
  console.error('  Run this terminal as Administrator and try again.\n');
  console.error(`  ${String(err.stderr || err.message).trim()}\n`);
  process.exit(1);
}
