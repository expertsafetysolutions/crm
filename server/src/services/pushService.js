const webpush = require('web-push');
const sheetsService = require('./sheetsService');

const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_STAGE_HANDOFF: 'TASK_STAGE_HANDOFF',
  LEAVE_STATUS: 'LEAVE_STATUS',
  PHOTO_ICARD_APPROVAL: 'PHOTO_ICARD_APPROVAL',
  // Admin-facing: who arrived, when, and how late. Unlike the types above this one fans out to
  // every Admin rather than to the person the event is about — the staff member punching in
  // already knows they punched in.
  ATTENDANCE_PUNCH: 'ATTENDANCE_PUNCH',
  // Its own type rather than riding on ATTENDANCE_PUNCH: an Admin who has muted routine punch
  // chatter must STILL be interrupted by something that is actively blocking someone from starting
  // work. Also carries the staff-facing approve/reply.
  ATTENDANCE_APPROVAL: 'ATTENDANCE_APPROVAL',
  // Mirrors the OTP email that already goes to OTP_RECIPIENT, so the owner does not have to open
  // their inbox to relay a code. Deliberately carries ONLY the staff name and the code — every
  // other detail (role, purpose, expiry, what-to-do-if-unexpected) stays email-only. See
  // otpService.buildOtpPushPayload for why.
  OTP_CODE: 'OTP_CODE'
};

let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
} else {
  console.warn('[pushService] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.');
}

async function isEnabled(type) {
  try {
    const settings = await sheetsService.getNotificationSettings();
    if (!settings || settings[type] === undefined) return true;
    return !!settings[type];
  } catch (e) {
    console.error('[pushService] Failed to read notification settings, defaulting to enabled:', e);
    return true;
  }
}

async function notifyStaff(staffId, { type, title, body, url, tag }) {
  if (!vapidConfigured || !staffId) return;
  try {
    if (!(await isEnabled(type))) return;

    const staff = await sheetsService.getStaffById(staffId);
    const subscriptions = Array.isArray(staff?.Push_Subscriptions) ? staff.Push_Subscriptions : [];
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({ title, body, url, tag });
    const deadEndpoints = [];

    await Promise.all(subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deadEndpoints.push(sub.endpoint);
        } else {
          console.error('[pushService] sendNotification failed:', err.statusCode || err.message);
        }
      }
    }));

    for (const endpoint of deadEndpoints) {
      await sheetsService.removePushSubscription(staffId, endpoint);
    }
  } catch (e) {
    console.error('[pushService] notifyStaff error:', e);
  }
}

/**
 * Sends to every Admin, skipping `exceptStaffId` (an Admin punching in should not be told about
 * their own punch). Role is compared lower-cased because Role is free-form on Staff_Master and
 * 'Admin'/'admin' both occur — an exact match would silently notify nobody.
 *
 * Failures are swallowed per-recipient by notifyStaff, so one Admin with a dead subscription can
 * never stop the others being told.
 */
async function notifyAdmins({ type, title, body, url, tag }, exceptStaffId) {
  if (!vapidConfigured) return;
  try {
    if (!(await isEnabled(type))) return;

    const allStaff = await sheetsService.getAllStaff();
    const admins = allStaff.filter(s => (
      String(s.Role || '').trim().toLowerCase() === 'admin'
      && s.Staff_ID !== exceptStaffId
      && s.Status !== 'Inactive'
    ));

    await Promise.all(admins.map(a => notifyStaff(a.Staff_ID, { type, title, body, url, tag })));
  } catch (e) {
    console.error('[pushService] notifyAdmins error:', e);
  }
}

module.exports = { NOTIFICATION_TYPES, notifyStaff, notifyAdmins, isEnabled };
