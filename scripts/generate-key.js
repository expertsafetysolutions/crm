#!/usr/bin/env node
/**
 * Generates a FIELD_ENCRYPTION_KEY.
 *
 *   npm run keygen
 *
 * Prints only — never writes to .env, because silently overwriting an existing key would render
 * every already-encrypted row permanently unreadable.
 */

const { generateKey } = require('../server/src/utils/fieldCrypto');

const key = generateKey();

console.log('\n  FIELD_ENCRYPTION_KEY=' + key + '\n');
console.log('  1. Add the line above to server/.env');
console.log('  2. Add the SAME value to the Vercel project environment variables');
console.log('  3. Store a copy in your password manager\n');
console.log('  This key is the only way to read encrypted customer data. If it is lost, the data');
console.log('  is lost — there is no recovery path. If it is replaced while rows are already');
console.log('  encrypted, those rows can no longer be decrypted.\n');
