const webpush = require('web-push');
const sheetsService = require('./sheetsService');

const NOTIFICATION_TYPES = {
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_STAGE_HANDOFF: 'TASK_STAGE_HANDOFF',
  LEAVE_STATUS: 'LEAVE_STATUS',
  PHOTO_ICARD_APPROVAL: 'PHOTO_ICARD_APPROVAL'
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

module.exports = { NOTIFICATION_TYPES, notifyStaff, isEnabled };
