/**
 * emailService — Nodemailer/SMTP sender for quotation dispatch and reminders.
 *
 * Credentials come from Quotation_Settings.smtp_config, except the password, which is read from
 * the environment variable NAMED by smtp_config.pass_ref (default SMTP_PASS). The secret itself is
 * never stored in Mongo, matching how CRON_SECRET is handled.
 *
 * nodemailer is require()d lazily so the server still boots if the dependency isn't installed yet
 * (email simply reports as unconfigured rather than crashing the whole API).
 */

let nodemailer = null;
let nodemailerLoadError = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailerLoadError = e.message;
}

function resolveSecret(ref, fallbackEnvName) {
  const name = ref || fallbackEnvName;
  return process.env[name] || '';
}

function isConfigured(smtpConfig) {
  if (!nodemailer) return false;
  if (!smtpConfig || !smtpConfig.enabled) return false;
  const pass = resolveSecret(smtpConfig.pass_ref, 'SMTP_PASS');
  return Boolean(smtpConfig.host && smtpConfig.user && pass && (smtpConfig.from_email || smtpConfig.user));
}

function buildTransport(smtpConfig) {
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: Number(smtpConfig.port) || 587,
    // Port 465 is implicit TLS; everything else upgrades via STARTTLS.
    secure: smtpConfig.secure !== undefined ? Boolean(smtpConfig.secure) : Number(smtpConfig.port) === 465,
    auth: {
      user: smtpConfig.user,
      pass: resolveSecret(smtpConfig.pass_ref, 'SMTP_PASS')
    }
  });
}

/**
 * Sends one email. Returns a result object rather than throwing so a multi-channel dispatch can
 * record a per-channel outcome and still attempt the other channel.
 */
async function sendEmail(smtpConfig, { to, subject, body, html, attachments }) {
  if (!nodemailer) {
    return { ok: false, channel: 'Email', recipient: to, error: `nodemailer not installed (${nodemailerLoadError || 'module missing'})` };
  }
  if (!isConfigured(smtpConfig)) {
    return { ok: false, channel: 'Email', recipient: to, error: 'SMTP is not configured or is disabled in settings' };
  }
  if (!to) {
    return { ok: false, channel: 'Email', recipient: '', error: 'No recipient email address on record' };
  }

  try {
    const transport = buildTransport(smtpConfig);
    const fromEmail = smtpConfig.from_email || smtpConfig.user;
    const info = await transport.sendMail({
      from: smtpConfig.from_name ? `"${smtpConfig.from_name}" <${fromEmail}>` : fromEmail,
      to,
      subject: subject || '',
      text: body || '',
      html: html || undefined,
      attachments: Array.isArray(attachments) ? attachments : undefined
    });
    return { ok: true, channel: 'Email', recipient: to, messageId: info.messageId };
  } catch (e) {
    return { ok: false, channel: 'Email', recipient: to, error: e.message };
  }
}

async function verifyConnection(smtpConfig) {
  if (!nodemailer) return { ok: false, error: 'nodemailer not installed' };
  if (!isConfigured(smtpConfig)) return { ok: false, error: 'SMTP is not configured or is disabled' };
  try {
    await buildTransport(smtpConfig).verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendEmail, isConfigured, verifyConnection };
