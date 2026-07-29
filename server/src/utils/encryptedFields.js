/**
 * Which fields are encrypted at rest, and — just as importantly — which are deliberately NOT.
 *
 * ── THE CONSTRAINT THAT SHAPES THIS WHOLE FILE ───────────────────────────────────────────────
 * AES ciphertext does not substring-match. The CRM's search is client-side token matching
 * (utils/searchUtils.js `matchesQuery`), running over rows already in memory from /sync/all:
 *
 *     matchesQuery(q, [c.Company_Name, c.Contact, c.Auth_Person, c.Address, c.Customer_ID])
 *
 * Encrypting a field and decrypting it on read keeps that working, because the client still
 * receives plaintext. But it means the protection is against a STOLEN DUMP, not against the API.
 * Anything readable through the API stays readable through the API.
 *
 * ── WHY Company_Name IS NOT ENCRYPTED ────────────────────────────────────────────────────────
 * It is the primary human identifier: it appears on every task list, quotation, challan and
 * certificate, is matched against the paper register, and is rendered on the PUBLIC certificate
 * verification page (server.js) which has no authenticated user and therefore no decryption
 * context in the sense that matters. Encrypting it buys little — a dump of addresses and phone
 * numbers without company names is still a serious leak, and one with company names but no
 * contact details is far less useful to an attacker. The cost, meanwhile, is high and lands on
 * every screen. Contact details are the sensitive part; that is what is protected.
 *
 * ── WHY THE SNAPSHOT FIELDS ARE ENCRYPTED TOO ────────────────────────────────────────────────
 * Quotations, invoices and challans copy the customer's address and phone onto the document as
 * `*_Snapshot` fields, frozen at issue time. Encrypting Customer_Master but not the snapshots
 * would leave the same phone number sitting in plaintext across four other collections — the
 * dump would leak anyway and the control would be theatre.
 */

/**
 * collection → [fields to encrypt]
 *
 * Only fields that are (a) genuinely sensitive personal data and (b) never used for server-side
 * exact-match lookups without a blind index.
 */
const ENCRYPTED_FIELDS = {
  // The customer register — the primary target of a dump.
  Customer_Master: [
    'Contact',            // phone
    'Email',
    'Address',
    'Billing_Address',
    'Shipping_Address',
    'Auth_Person',        // named individual
    'Location_Link',      // maps link — pinpoints a physical site
    'Coordinators'        // JSON blob of names, phones and emails
  ],

  // Denormalised copies carried on the task record.
  Task_Master: [
    'Customer_Contact',
    'Customer_Auth_Person'
  ],

  // Staff personal data. Field names verified against the live collection — Staff_Master has no
  // Address, bank-account or PAN columns today; do not add them speculatively, add them when the
  // app actually gains them. Salary figures are NOT here: moneyMask already governs who sees
  // money, and encrypting them would break the payroll arithmetic that runs server-side.
  Staff_Master: [
    'Mobile',
    'Email',
    'Emergency_Contact',
    'Pending_ICard_Emergency_Contact',
    'Aadhar_No',                 // NOT "Aadhaar_Number" — matches the actual stored field
    'Pending_ICard_Aadhar_No'
  ],

  // Document snapshots — see the note above on why these matter.
  Quotation_Master:     ['Customer_Contact_Snapshot', 'Customer_Address_Snapshot', 'Customer_Email_Snapshot'],
  PI_Master:            ['Customer_Contact_Snapshot', 'Customer_Address_Snapshot', 'Customer_Email_Snapshot'],
  Sales_Invoice_Master: ['Customer_Contact_Snapshot', 'Customer_Address_Snapshot', 'Customer_Email_Snapshot'],
  Delivery_Challan_Master: ['Customer_Contact_Snapshot', 'Customer_Address_Snapshot', 'Customer_Email_Snapshot'],

  // Vendor contact details are commercially sensitive in the same way customer ones are.
  // Field names per purchaseService's column map — NOT the same names as Customer_Master.
  Vendor_Master: ['Phone', 'Email', 'Address', 'Contact_Person'],

  // Free-text notes from customer conversations routinely contain personal detail.
  Customer_Interactions: ['Remarks']

  // Field_Visits deliberately has no entry: it stores Visit_ID/Customer_ID/Staff_ID/Status/
  // timestamps only (see the /field-visits POST route) — no address or contact fields exist on
  // it to protect. Add one here if the schema ever grows to carry them.
};

/**
 * Fields that must NEVER be encrypted, with the reason. Asserted by the test suite so a future
 * edit cannot quietly add one and break a workflow in a way that only shows up in production.
 */
const NEVER_ENCRYPT = {
  Company_Name: 'primary human identifier; on public certificate pages and every list/search',
  Customer_ID: 'join key across 8 collections',
  Staff_ID: 'join key and login identifier',
  GSTIN: 'validated, state code extracted from it, and printed on tax documents',
  State_Code: 'drives the GST split calculation',
  Certificate_No: 'uniquely indexed; public verification looks it up directly',
  Verification_GUID: 'the public QR lookup key',
  Password: 'already a bcrypt hash — encrypting it would break login',
  Status: 'filtered on constantly',
  Task_ID: 'join key',
  Quotation_ID: 'join key',
  Invoice_ID: 'join key',
  Challan_ID: 'join key'
};

/** Fields that get a searchable blind index alongside the ciphertext, for exact-match lookup. */
const BLIND_INDEXED = {
  Customer_Master: ['Contact'],  // "does a customer with this phone already exist?"
  Staff_Master: ['Mobile']
};

function fieldsFor(collection) {
  return ENCRYPTED_FIELDS[collection] || null;
}

function blindIndexFieldsFor(collection) {
  return BLIND_INDEXED[collection] || null;
}

function isProtectedCollection(collection) {
  return Boolean(ENCRYPTED_FIELDS[collection]);
}

module.exports = {
  ENCRYPTED_FIELDS,
  NEVER_ENCRYPT,
  BLIND_INDEXED,
  fieldsFor,
  blindIndexFieldsFor,
  isProtectedCollection
};
