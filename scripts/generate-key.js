#!/usr/bin/env node
/**
 * Generates a FIELD_ENCRYPTION_KEY, and optionally emails a copy as a recovery measure.
 *
 *   npm run keygen                 # print it only
 *   npm run keygen -- --email      # print it AND email a copy to the administrator
 *
 * Never writes to server/.env itself. Overwriting an existing key would make every already-
 * encrypted row permanently unreadable, and that is not a thing a script should be able to do by
 * accident — the operator pastes it in deliberately.
 *
 * ── WHY EMAILING THE KEY IS OFFERED AT ALL ───────────────────────────────────────────────────
 * This key has no recovery path: lose it and the encrypted customer records are gone for good, with
 * no reset, no override and no support line. Weighed against that, a copy sitting in the
 * administrator's own inbox is the lesser risk — the same inbox that already receives every
 * password-reset and new-device code for this system.
 *
 * It does NOT make the key a second factor, and it cannot "unlock" anything on its own: the server
 * needs the key in its environment on EVERY request (to render a customer name, build a PDF, send a
 * WhatsApp), so it must live in .env or the Vercel env vars. The emailed copy exists purely so the
 * value can be put back if it is lost.
 *
 * If the inbox is not trusted, use `npm run keygen` without --email and store it in a password
 * manager instead. That is strictly safer; it just depends on the operator remembering to do it.
 */

const { generateKey } = require('../server/src/utils/fieldCrypto');

const EMAIL_IT = process.argv.includes('--email');
const key = generateKey();

async function emailKey(value) {
  const emailService = require('../server/src/services/emailService');
  const quotationEngine = require('../server/src/services/quotationEngine');
  const { OTP_RECIPIENT } = require('../server/src/utils/otpService');

  const settings = await quotationEngine.getSettings();
  const smtpConfig = settings?.smtp_config;
  if (!smtpConfig) throw new Error('SMTP is not configured — cannot email the key');

  const body = [
    'FIELD_ENCRYPTION_KEY (recovery copy)',
    '',
    value,
    '',
    'WHAT THIS IS',
    'The key that encrypts customer phone numbers, addresses and emails in the CRM database.',
    '',
    'WHAT TO DO WITH IT',
    '  1. Keep this email. Do not delete it.',
    '  2. Also copy the key into your password manager — one copy in one place is not a backup.',
    '',
    'IF THE KEY IS EVER LOST',
    '  Put this line into server/.env and into the Vercel environment variables:',
    `      FIELD_ENCRYPTION_KEY=${value}`,
    '  The data becomes readable again immediately. Nothing else is needed.',
    '',
    'IMPORTANT',
    '  - This key alone does not unlock anything: it only works inside the running server.',
    '  - Replacing it with a DIFFERENT key while data is already encrypted makes that data',
    '    unreadable. Never change it without decrypting first (npm run decrypt:data).',
    '  - Anyone holding both this key and a database dump can read the protected fields, so',
    '    treat this email as you would the database password.',
    '',
    'Expert Safety Solutions CRM'
  ].join('\n');

  const result = await emailService.sendEmail(smtpConfig, {
    to: OTP_RECIPIENT,
    subject: 'CRM encryption key — recovery copy (keep this email)',
    body
  });
  if (!result || !result.ok) throw new Error(result?.error || 'Email delivery failed');
  return result;
}

(async () => {
  console.log('\n  FIELD_ENCRYPTION_KEY=' + key + '\n');
  console.log('  1. Add the line above to server/.env');
  console.log('  2. Add the SAME value to the Vercel project environment variables');
  console.log('  3. Store a copy in your password manager\n');

  if (EMAIL_IT) {
    try {
      const r = await emailKey(key);
      console.log(`  A recovery copy has been emailed to ${r.recipient || 'the administrator'}.`);
      if (r.safeModeRedirectedTo) console.log(`  (safe mode redirected it to ${r.safeModeRedirectedTo})`);
      console.log('');
    } catch (err) {
      // The key on screen is still valid — the operator can use it and store it by hand.
      console.error(`  Could not email the key: ${err.message}`);
      console.error('  Copy it from above manually before closing this window.\n');
    }
  } else {
    console.log('  Tip: `npm run keygen -- --email` also sends a recovery copy to the admin inbox.\n');
  }

  console.log('  This key is the only way to read encrypted customer data. If it is lost, the data');
  console.log('  is lost — there is no recovery path. If it is replaced while rows are already');
  console.log('  encrypted, those rows can no longer be decrypted.\n');
  process.exit(0);
})();
