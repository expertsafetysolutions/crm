#!/usr/bin/env node
/**
 * EMERGENCY RECOVERY — clears every auth obstacle for one staff member.
 *
 *   node scripts/reset-auth.js --staff STAFF005
 *   node scripts/reset-auth.js --staff STAFF005 --confirm
 *
 * Clears: brute-force lockout, failed-attempt counter, all registered devices, all active
 * sessions, and all pending OTPs. It does NOT change the password (use the admin set-password
 * route for that) — this is about removing the gates, not the credential.
 *
 * WHY THIS EXISTS, AND WHY IT IS WRITTEN FIRST
 * New-device OTP, session eviction and account lockout can each lock the last remaining Admin out
 * of production with no way back in — if the OTP email fails to arrive, there is otherwise no
 * recovery path at all, because every other route requires a working login. This script runs
 * directly against Mongo with no authentication of its own, so it works precisely when logging in
 * does not. Whoever holds the MONGO_URI can already read the whole database; this grants nothing
 * new.
 *
 * Dry run is the default, matching restore-db.js.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });

const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const CONFIRM = args.includes('--confirm');
const STAFF_ID = flag('staff', null);

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is not set (server/.env).');
  process.exit(1);
}
if (!STAFF_ID) {
  console.error('\nSpecify the account to unlock:  --staff STAFF005\n');
  process.exit(1);
}

// Fields the auth system sets on Staff_Master to gate a login. Cleared together — leaving any one
// of them set would keep the account locked while appearing to have been reset.
const LOCK_FIELDS = {
  Failed_Login_Attempts: 0,
  Locked_Until: '',
  Last_Failed_Login: '',
  Known_Devices: []
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const staff = await db.collection('Staff_Master').findOne({ Staff_ID: STAFF_ID });
  if (!staff) {
    console.error(`\nNo staff member with Staff_ID "${STAFF_ID}".\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const deviceCount = Array.isArray(staff.Known_Devices) ? staff.Known_Devices.length : 0;
  // These two collections may not exist yet on an older deployment — count defensively rather
  // than letting a missing collection abort the recovery.
  const countSafe = async (name, query) => {
    try { return await db.collection(name).countDocuments(query); } catch { return 0; }
  };
  const sessionCount = await countSafe('Auth_Sessions', { Staff_ID: STAFF_ID, Revoked_At: { $in: [null, '', undefined] } });
  const otpCount = await countSafe('Auth_OTPs', { Staff_ID: STAFF_ID, Consumed_At: { $in: [null, '', undefined] } });

  console.log(`\n  Account        : ${staff.Name} (${STAFF_ID}), role ${staff.Role}`);
  console.log(`  Status         : ${staff.Status}`);
  console.log(`  Locked until   : ${staff.Locked_Until || '(not locked)'}`);
  console.log(`  Failed attempts: ${staff.Failed_Login_Attempts || 0}`);
  console.log(`  Known devices  : ${deviceCount}`);
  console.log(`  Active sessions: ${sessionCount}`);
  console.log(`  Pending OTPs   : ${otpCount}`);
  console.log(`\n  Mode           : ${CONFIRM ? 'APPLYING CHANGES' : 'DRY RUN (no writes)'}\n`);

  if (!CONFIRM) {
    console.log('  Would clear the lockout, all devices, all sessions and all pending OTPs.');
    console.log('  Re-run with --confirm to apply.\n');
    await mongoose.disconnect();
    return;
  }

  await db.collection('Staff_Master').updateOne({ Staff_ID: STAFF_ID }, { $set: LOCK_FIELDS });
  try {
    await db.collection('Auth_Sessions').deleteMany({ Staff_ID: STAFF_ID });
    await db.collection('Auth_OTPs').deleteMany({ Staff_ID: STAFF_ID });
  } catch {
    // Collections may not exist yet — the Staff_Master reset above is the part that matters.
  }

  if (staff.Status !== 'Active') {
    console.log(`  NOTE: Status is "${staff.Status}" — login is blocked regardless of this reset.`);
    console.log('        Set Status to "Active" as well if this account should be able to log in.\n');
  }

  console.log('  Done. The account can log in with its existing password, from any device.\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('reset-auth failed:', err.message);
  process.exit(1);
});
