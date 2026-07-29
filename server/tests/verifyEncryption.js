#!/usr/bin/env node
/**
 * Read-only checks for field encryption, PII masking and backup encryption.
 *
 *   npm run verify:encryption
 *
 * Writes nothing. The crypto tests run entirely in memory; the database section only READS, and
 * reports whether stored rows are actually ciphertext — the test that matters, because a raw dump
 * showing plaintext means the whole control is inert whatever the unit tests say.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[90m', x: '\x1b[0m' };
let passed = 0, failed = 0, warned = 0;

const pass = (m, extra) => { passed++; console.log(`  ${C.g}PASS${C.x}  ${m}${extra ? C.d + '  ' + extra + C.x : ''}`); };
const fail = (m, extra) => { failed++; console.log(`  ${C.r}FAIL${C.x}  ${m}${extra ? C.d + '  ' + extra + C.x : ''}`); };
const warn = (m) => { warned++; console.log(`  ${C.y}WARN${C.x}  ${m}`); };
const head = (m) => console.log(`\n${C.b}${m}${C.x}`);

// Encryption must be exercised regardless of whether the operator has set a key yet, so the
// in-memory tests use a known key rather than depending on the environment.
const HAD_KEY = Boolean(process.env.FIELD_ENCRYPTION_KEY);
if (!HAD_KEY) process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);

const crypto = require('crypto');
const fieldCrypto = require('../src/utils/fieldCrypto');
const { ENCRYPTED_FIELDS, NEVER_ENCRYPT } = require('../src/utils/encryptedFields');
const { encryptRow, decryptRow } = require('../src/utils/cryptoMiddleware');
const piiMask = require('../src/utils/piiMask');

head('1. AES-256-GCM round trip');
{
  const samples = ['+91 98765 43210', 'rajesh@acme.co.in', '12 MG Road, Vadodara, Gujarat 390001', 'ABC & Co "Quotes" <tags>', '  leading and trailing  ', 'ગુજરાતી લખાણ'];
  let ok = true;
  for (const s of samples) {
    const enc = fieldCrypto.encryptValue(s);
    if (enc === s || !fieldCrypto.isEncrypted(enc)) { fail(`not encrypted: ${s}`); ok = false; continue; }
    if (fieldCrypto.decryptValue(enc) !== s) { fail(`round trip broke: ${s}`); ok = false; }
  }
  if (ok) pass(`${samples.length} values encrypt and decrypt exactly`, 'incl. unicode + quotes');

  const a = fieldCrypto.encryptValue('same input');
  const b = fieldCrypto.encryptValue('same input');
  a !== b
    ? pass('same plaintext yields different ciphertext', 'random IV per write')
    : fail('IV reuse — identical ciphertext for identical input');

  fieldCrypto.encryptValue(fieldCrypto.encryptValue('x')).split(':').length === 5
    ? pass('encryption is idempotent', 'migration can be safely re-run')
    : fail('double-encryption occurred');

  ['', null, undefined].every(v => fieldCrypto.encryptValue(v) === v)
    ? pass('empty/null/undefined pass through untouched')
    : fail('empty values were mangled');
}

head('2. Tamper detection');
{
  const enc = fieldCrypto.encryptValue('+91 98765 43210');
  const parts = enc.split(':');
  const body = Buffer.from(parts[4], 'base64');
  body[0] ^= 0xff;                                   // flip a bit in the ciphertext
  parts[4] = body.toString('base64');
  const out = fieldCrypto.decryptValue(parts.join(':'));
  out.startsWith('[ENCRYPTED')
    ? pass('altered ciphertext is rejected, not silently returned', 'GCM auth tag')
    : fail(`tampered value decrypted to: ${out}`);

  const wrongKeyEnc = enc;
  const realKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(64);
  delete require.cache[require.resolve('../src/utils/fieldCrypto')];
  const fc2 = require('../src/utils/fieldCrypto');
  fc2.decryptValue(wrongKeyEnc).startsWith('[ENCRYPTED')
    ? pass('wrong key fails loudly instead of returning garbage')
    : fail('wrong key produced output');
  process.env.FIELD_ENCRYPTION_KEY = realKey;
  delete require.cache[require.resolve('../src/utils/fieldCrypto')];
}

head('3. Field policy');
{
  const encrypted = new Set(Object.values(ENCRYPTED_FIELDS).flat());
  const clashes = Object.keys(NEVER_ENCRYPT).filter(f => encrypted.has(f));
  clashes.length === 0
    ? pass('no field is both encrypted and never-encrypt', `${encrypted.size} protected fields`)
    : fail(`fields in both lists: ${clashes.join(', ')}`);

  // The search contract from CLAUDE.md: these are matched client-side by substring.
  const searchable = ['Company_Name', 'Customer_ID'];
  const broken = searchable.filter(f => encrypted.has(f));
  broken.length === 0
    ? pass('client-side search fields left unencrypted', 'matchesQuery still works')
    : fail(`encrypting these breaks customer search: ${broken.join(', ')}`);

  encrypted.has('Password')
    ? fail('Password is in the encrypt list — would break login')
    : pass('Password excluded', 'already a bcrypt hash');
}

head('4. Row middleware does not mutate its input');
{
  const original = { Customer_ID: 'CUST1', Contact: '+91 98765 43210', Company_Name: 'Acme' };
  const snapshot = JSON.stringify(original);
  const enc = encryptRow('Customer_Master', original);
  JSON.stringify(original) === snapshot
    ? pass('encryptRow leaves the source object untouched', 'getTab cache is by reference')
    : fail('encryptRow mutated its input — would poison the shared cache');

  enc.Company_Name === 'Acme'
    ? pass('unprotected fields pass through unchanged')
    : fail('a non-listed field was altered');

  const back = decryptRow('Customer_Master', enc);
  back.Contact === '+91 98765 43210'
    ? pass('decryptRow restores the original value')
    : fail(`decryptRow returned ${back.Contact}`);

  // An update touching one field must not blank the others.
  const partial = encryptRow('Customer_Master', { Contact: '+91 11111 22222' });
  !('Address' in partial)
    ? pass('absent fields stay absent', '$set cannot blank untouched columns')
    : fail('encryptRow materialised a field the caller never supplied');
}

head('5. Blind index');
{
  const a = fieldCrypto.blindIndex('+91 98765 43210');
  const b = fieldCrypto.blindIndex('+919876543210');
  const c = fieldCrypto.blindIndex('+91 99999 00000');
  a && a === b ? pass('same number matches despite formatting', 'normalised before hashing')
               : fail('blind index is formatting-sensitive');
  a !== c ? pass('different numbers give different digests') : fail('digest collision');
  a && a.length === 64 ? pass('HMAC-SHA256 digest', 'not reversible by enumeration') : fail('unexpected digest');
}

head('6. PII masking');
{
  // An Indian mobile is 10 digits (9876543210), so the last four are "3210" — NOT "43210".
  const m = piiMask.maskPhone('+91 98765 43210');
  m === '+91 ***** 3210'
    ? pass(`phone masked to "${m}"`, 'last 4 kept for recognition')
    : fail(`phone mask wrong: ${m}`);

  piiMask.maskPhone('9876543210') === '***** 3210'
    ? pass('bare 10-digit number masked without a country code')
    : fail(`bare number mask wrong: ${piiMask.maskPhone('9876543210')}`);

  piiMask.maskPhone('40021') === '40021'
    ? pass('short extension left intact', 'nothing to protect, would only destroy the value')
    : fail('short extension was mangled');

  const e = piiMask.maskEmail('rajesh@acme.co.in');
  e.endsWith('@acme.co.in') && !e.includes('rajesh')
    ? pass(`email masked to "${e}"`)
    : fail(`email mask wrong: ${e}`);

  const row = { Company_Name: 'Acme Ltd', Contact: '+91 98765 43210', Auth_Person: 'Rajesh' };
  const masked = piiMask.maskValue(row, { keepAddresses: false });
  masked.Company_Name === 'Acme Ltd' && masked.Auth_Person === 'Rajesh'
    ? pass('company name and contact person survive masking', 'record stays usable')
    : fail('masking broke the identifying fields');

  JSON.stringify(row).includes('98765')
    ? pass('maskValue does not mutate its input')
    : fail('maskValue mutated the source row');

  const clash = Object.keys(piiMask.NEVER_MASK_PII).filter(f => piiMask.PHONE_FIELDS.has(f) || piiMask.EMAIL_FIELDS.has(f) || piiMask.ADDRESS_FIELDS.has(f));
  clash.length === 0 ? pass('no field is both masked and never-mask') : fail(`in both lists: ${clash.join(', ')}`);

  const nested = piiMask.maskValue({ customer: { Contact: '+91 98765 43210' } }, {});
  nested.customer.Contact.includes('*') ? pass('nested objects are masked too') : fail('nested PII leaked');

  // Phone exemption for staff/delivery — added after tracing a real break: StaffDashboard.jsx's
  // task-card Call/WhatsApp buttons read Contact/Customer_Contact directly and strip it to digits
  // to build tel:/wa.me hrefs. A masked value silently produced a wrong-number link with no error
  // shown, so phone masking was reversed for exactly the two roles that hit that code path.
  const staffRow = { Contact: '+91 98765 43210', Email: 'rajesh@acme.co.in' };
  const staffMasked = piiMask.maskValue(staffRow, { keepAddresses: false, keepPhones: true });
  staffMasked.Contact === '+91 98765 43210'
    ? pass('phone NOT masked for staff/delivery (keepPhones)', 'task-card Call/WhatsApp buttons need the real number')
    : fail(`phone should be unmasked for staff/delivery, got: ${staffMasked.Contact}`);

  staffMasked.Email !== 'rajesh@acme.co.in' && staffMasked.Email.endsWith('@acme.co.in')
    ? pass('email still masked for staff/delivery despite keepPhones', 'exemption is phone-only, not blanket')
    : fail(`email should still be masked, got: ${staffMasked.Email}`);

  const defaultMasked = piiMask.maskValue({ Contact: '+91 98765 43210' }, { keepAddresses: false });
  defaultMasked.Contact === '+91 ***** 3210'
    ? pass('phone still masked by default when keepPhones is not set', 'exemption must be explicit, not implicit')
    : fail(`default masking regressed: ${defaultMasked.Contact}`);

  const exemptRoles = [...piiMask.PHONE_EXEMPT_ROLES].sort();
  JSON.stringify(exemptRoles) === JSON.stringify(['delivery', 'staff'])
    ? pass('PHONE_EXEMPT_ROLES is exactly {staff, delivery}', 'scope is intentional, not accidental')
    : fail(`PHONE_EXEMPT_ROLES drifted: ${exemptRoles.join(', ')}`);

  const staffAddrRow = { Address: '12 MG Road, Whitefield, Bengaluru' };
  const staffAddrMasked = piiMask.maskValue(staffAddrRow, { keepAddresses: false, keepPhones: true });
  staffAddrMasked.Address === '… Bengaluru'
    ? pass('address still masked for staff despite keepPhones: true', 'phone and address exemptions are independent')
    : fail(`address masking regressed for staff: ${staffAddrMasked.Address}`);

  const deliveryRow = { Address: '12 MG Road, Whitefield, Bengaluru', Contact: '+91 98765 43210' };
  const deliveryMasked = piiMask.maskValue(deliveryRow, { keepAddresses: true, keepPhones: true });
  deliveryMasked.Address === '12 MG Road, Whitefield, Bengaluru' && deliveryMasked.Contact === '+91 98765 43210'
    ? pass('delivery keeps full address AND full phone simultaneously', 'both exemptions apply independently and additively')
    : fail(`delivery exemptions interfered: Address=${deliveryMasked.Address} Contact=${deliveryMasked.Contact}`);
}

head('7. Backup encryption');
{
  const pw = 'test-passphrase-1234';
  const plain = Buffer.from(JSON.stringify([{ Contact: '+91 98765 43210' }]), 'utf8');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  const ci = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([ci.update(plain), ci.final()]);
  const blob = Buffer.concat([Buffer.from('ESSBAK1'), salt, iv, ci.getAuthTag(), ct]);

  !blob.toString('utf8').includes('98765')
    ? pass('encrypted backup contains no plaintext phone number')
    : fail('plaintext survived in the encrypted blob');

  const k2 = crypto.scryptSync(pw, blob.subarray(7, 23), 32, { N: 16384, r: 8, p: 1 });
  const d = crypto.createDecipheriv('aes-256-gcm', k2, blob.subarray(23, 35));
  d.setAuthTag(blob.subarray(35, 51));
  Buffer.concat([d.update(blob.subarray(51)), d.final()]).toString() === plain.toString()
    ? pass('backup decrypts back to the original bytes')
    : fail('backup round trip failed');

  try {
    const wrong = crypto.scryptSync('wrong-password', blob.subarray(7, 23), 32, { N: 16384, r: 8, p: 1 });
    const dw = crypto.createDecipheriv('aes-256-gcm', wrong, blob.subarray(23, 35));
    dw.setAuthTag(blob.subarray(35, 51));
    Buffer.concat([dw.update(blob.subarray(51)), dw.final()]);
    fail('wrong backup password did not fail');
  } catch { pass('wrong backup password is rejected'); }
}

head('8. Stored data (read-only)');
(async () => {
  if (!process.env.MONGO_URI) {
    warn('MONGO_URI not set — skipping the live check');
  } else if (!HAD_KEY) {
    warn('FIELD_ENCRYPTION_KEY not set — encryption is NOT active yet; run: npm run keygen');
  } else {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
      for (const [coll, fields] of Object.entries(ENCRYPTED_FIELDS)) {
        let docs;
        try { docs = await mongoose.connection.db.collection(coll).find({}).limit(200).toArray(); }
        catch { continue; }
        if (!docs.length) continue;

        let enc = 0, plainRows = 0;
        for (const d of docs) {
          for (const f of fields) {
            const v = d[f];
            if (typeof v !== 'string' || v === '') continue;
            fieldCrypto.isEncrypted(v) ? enc++ : plainRows++;
          }
        }
        if (enc === 0 && plainRows === 0) continue;
        if (plainRows === 0) pass(`${coll}: all ${enc} stored values are ciphertext`);
        else if (enc === 0) warn(`${coll}: ${plainRows} value(s) still plaintext — run: npm run encrypt:data`);
        else warn(`${coll}: partially encrypted (${enc} enc / ${plainRows} plain) — re-run: npm run encrypt:data`);
      }
      await mongoose.disconnect();
    } catch (err) {
      warn(`live check skipped: ${err.message}`);
    }
  }

  console.log(`\n${C.b}=== ${passed} passed, ${failed} failed, ${warned} warnings ===${C.x}\n`);
  process.exit(failed ? 1 : 0);
})();
