/**
 * inquiryService — turns one public /inquiry submission into CRM records.
 *
 * Ingestion is ordered by how much it would hurt to lose. The customer row, the lead task and the
 * timeline entry are the record of the enquiry; the draft quotation and the messages are
 * conveniences built on top. So the first group runs inside `ingestInquiry` and its failure fails
 * the request, while the second runs in `runPostIngestion` where every step is individually
 * guarded — a Meta outage or an unpriced settings row must never lose a sales lead that a real
 * person just typed in.
 *
 * DUPLICATE HANDLING is by mobile number, normalised to bare 10 digits by inquiryValidator. The
 * office identifies customers by phone (it is what they call), and matching on company name would
 * fragment "Expert Safety", "Expert Safety Solutions" and "expert safety solutions pvt ltd" into
 * three registers. An existing customer therefore gains a new lead under their profile, never a
 * second profile — and, importantly, their stored company name/address are NOT overwritten by
 * whatever was typed into the public form. A stranger who knows a customer's mobile number could
 * otherwise rewrite that customer's billing address through an unauthenticated endpoint.
 */

const sheetsService = require('./sheetsService');
const quotationEngine = require('./quotationEngine');
const interactionLogger = require('./interactionLogger');
const inquiryValidator = require('../utils/inquiryValidator');

// The badge every record from this channel carries, so a lead's origin survives in the register,
// on the task and on the draft quotation.
const ONLINE_INQUIRY_TAG = 'Online Inquiry';
const SOURCE = 'ONLINE_INQUIRY';

/** IST calendar date. The deployment clock is not necessarily Indian — see CLAUDE.md. */
function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/**
 * Sequential, human-quotable inquiry number: INQ/26-27/001.
 *
 * Drawn from the atomic Counter_Master sequence for the same reason quotation numbers are — the
 * number is read back over the phone ("I submitted INQ/26-27/014"), so two enquiries arriving in
 * the same second must not collide. Financial-year period matches the rest of the app's numbering.
 */
async function nextInquiryNo() {
  const now = new Date();
  const istYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(now));
  const istMonth = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', month: 'numeric' }).format(now));
  // Indian FY starts in April: January–March still belongs to the year before.
  const fyStart = istMonth >= 4 ? istYear : istYear - 1;
  const period = `${String(fyStart).slice(-2)}-${String(fyStart + 1).slice(-2)}`;
  const stem = `INQ/${period}`;
  const seq = await sheetsService.getNextSequence(stem, { seedIfNew: 0 });
  return `${stem}/${String(seq).padStart(3, '0')}`;
}

/**
 * Finds an existing customer by normalised mobile.
 *
 * Every stored Contact shape has to be compared on equal terms: the register holds `+91 98765 43210`,
 * `9876543210` and `098765 43210` for what is one number. Both sides are reduced to their last 10
 * digits before comparing, which is exactly what normalizeMobile does.
 *
 * Secondary_Contact and the Coordinators list are searched too — a site supervisor's number is
 * often the one that reaches the form, and creating a duplicate company for it is the specific
 * failure this feature is meant to avoid.
 */
async function findCustomerByMobile(mobile) {
  if (!mobile) return null;
  const customers = await sheetsService.getAllCustomers();

  const matches = (value) => inquiryValidator.normalizeMobile(value) === mobile;

  return customers.find(c => {
    if (matches(c.Contact) || matches(c.Secondary_Contact)) return true;

    // Coordinators is stored as a JSON string on most rows and an array on a few — both occur.
    let coords = c.Coordinators;
    if (typeof coords === 'string') {
      try { coords = JSON.parse(coords); } catch { return false; }
    }
    return Array.isArray(coords) && coords.some(co => matches(co?.phone));
  }) || null;
}

/**
 * Creates a customer from a public submission.
 *
 * Contact is stored as `+91 XXXXXXXXXX` to match POST /api/customers, so the register stays
 * uniform and existing phone/WhatsApp links keep working. Everything else is already sanitised.
 */
/**
 * Builds the Coordinators array in the shape the CRM's customer editor already reads and writes:
 * `{ name, designation, phone, contactNumber, email }`. `whatsapp` is added alongside — additive,
 * so existing rows without it keep working and the editor simply shows a blank when it grows a
 * field for it.
 *
 * `phone` and `contactNumber` carry the same value because the editor writes both and different
 * screens read one or the other; setting only one would make a number vanish from half the UI.
 */
function buildCoordinators(data) {
  const toEntry = (c, role) => ({
    name: c.name || '',
    designation: c.designation || '',
    phone: c.mobile ? `+91 ${c.mobile}` : '',
    contactNumber: c.mobile || '',
    whatsapp: c.whatsapp ? `+91 ${c.whatsapp}` : '',
    email: c.email || '',
    role
  });

  return [
    toEntry(
      { name: data.name, designation: data.designation, mobile: data.mobile, whatsapp: data.whatsapp, email: data.email },
      'Company Coordinator'
    ),
    ...(data.extraContacts || []).map(c => toEntry(c, c.designation || 'Contact Person'))
  ];
}

async function createCustomerFromInquiry(data) {
  const gstUtils = require('../utils/gstUtils');
  const gstin = data.gstin || '';

  const customer = {
    Customer_ID: `CUST${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 10)}`,
    Company_Name: data.companyName,
    Auth_Person: data.name,
    Auth_Person_Designation: data.designation || '',
    Contact: `+91 ${data.mobile}`,
    Whatsapp_Number: data.whatsapp ? `+91 ${data.whatsapp}` : '',
    Email: data.email,
    Address: data.address,
    Billing_Address: data.address,
    GSTIN: gstin,
    State_Code: gstin ? gstUtils.extractStateCode(gstin) : '',
    Customer_Type: gstin ? 'B2B' : 'B2C',
    Location_Link: '',
    Coordinators: JSON.stringify(buildCoordinators(data)),
    Source: SOURCE,
    Tags: [ONLINE_INQUIRY_TAG],
    Created_At: istToday()
  };

  await sheetsService.insertRow('Customer_Master', customer);
  return customer;
}

/**
 * Adds any NEW contact people from this enquiry onto an existing customer's Coordinators.
 *
 * This is the one place a public submission is allowed to change an existing customer row, and it
 * is strictly additive by design (see the header note on why public input never overwrites a
 * profile): a person whose number is already on file is skipped, so a returning customer cannot
 * have their stored contacts renamed or replaced by whoever filled the form. Worst case a genuinely
 * new colleague is appended, which is exactly what the office wants from a company with several
 * departments.
 *
 * Best-effort: a failure here must not lose the lead, so it is caught by the caller.
 */
async function mergeCoordinatorsIntoCustomer(customer, data) {
  let existing = customer.Coordinators;
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch { existing = []; }
  }
  if (!Array.isArray(existing)) existing = [];

  const known = new Set(
    existing.flatMap(c => [
      inquiryValidator.normalizeMobile(c?.phone || c?.contactNumber),
      inquiryValidator.normalizeMobile(c?.whatsapp)
    ]).filter(Boolean)
  );

  const additions = buildCoordinators(data).filter(c => {
    const digits = inquiryValidator.normalizeMobile(c.contactNumber);
    // Without a number there is nothing to dedupe on, and appending every anonymous row would grow
    // the list without bound across repeat enquiries.
    if (!digits) return false;
    return !known.has(digits);
  });

  if (!additions.length) return { added: 0 };

  await sheetsService.updateRow('Customer_Master', 'Customer_ID', customer.Customer_ID, {
    Coordinators: JSON.stringify([...existing, ...additions])
  });
  return { added: additions.length };
}

/**
 * Ensures the "Online Inquiry" tag exists in Tag_Master and returns its id.
 *
 * Created on first use rather than seeded by a migration, which is the same approach the quotation
 * follow-up tag takes. Best-effort: the lead is far more important than its colour chip, so a
 * failure here returns '' and the task simply carries the text badge.
 */
async function ensureOnlineInquiryTag() {
  try {
    const tags = await sheetsService.getAllTags();
    const existing = tags.find(t => String(t.name || '').trim().toLowerCase() === ONLINE_INQUIRY_TAG.toLowerCase());
    if (existing) return existing.Tag_ID;

    const tagId = `TAG${Date.now().toString().slice(-6)}`;
    await sheetsService.insertRow('Tag_Master', {
      Tag_ID: tagId,
      name: ONLINE_INQUIRY_TAG,
      color: '#ea580c' // the app's orange, matching the badge in the UI
    });
    return tagId;
  } catch (e) {
    console.error('[inquiryService] Could not ensure Online Inquiry tag:', e.message);
    return '';
  }
}

/**
 * The lead itself: a Task_Master row on the Sales "New Inquiry" stage, which is where the existing
 * workflow expects a fresh enquiry to enter.
 *
 * Deliberately UNASSIGNED (Assigned_Staff: ''). A web lead has no owner until someone in the office
 * picks it up, and auto-assigning to a fixed person would silently drop leads whenever that person
 * is on leave. It surfaces as unassigned work on the dashboard instead.
 */
async function createLeadTask({ customer, data, inquiryNo, tagId }) {
  const summary = inquiryValidator.summarizeRequirements(data);
  const task = {
    Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
    Customer_ID: customer.Customer_ID,
    Description: `${ONLINE_INQUIRY_TAG} ${inquiryNo} — ${summary}`,
    Assigned_Staff: '',
    Department: 'Sales',
    Stage: 'New Inquiry',
    Type: 'One-time',
    Status: 'Pending',
    Priority: 'High', // a web lead is cold and time-sensitive; slow replies lose it
    Scheduled_Date: istToday(),
    Tags: tagId ? [tagId] : [],
    Source: SOURCE,
    Inquiry_No: inquiryNo,
    Inquiry_Requirements: data.requirements,
    Inquiry_Other_Text: data.otherRequirement,
    Contact_Person: data.name,
    Contact_Designation: data.designation || '',
    Contact_Phone: `+91 ${data.mobile}`,
    Contact_Whatsapp: data.whatsapp ? `+91 ${data.whatsapp}` : '',
    Contact_Email: data.email,
    // Denormalised onto the task so the lead view can show every department's contact without a
    // second lookup into Customer_Master — the salesperson calling back needs them in one place.
    Extra_Contacts: data.extraContacts || [],
    Site_Address: data.address,
    Created_By: 'PUBLIC_INQUIRY',
    Created_At: istToday(),
    Created_At_Ms: Date.now()
  };

  await sheetsService.insertRow('Task_Master', task);
  return task;
}

/**
 * Auto-drafts a quotation carrying the selected requirements as zero-rate placeholder lines.
 *
 * The point is to remove typing, not to quote a price: staff open the draft, fill in rates against
 * lines that already name the right work for the right customer, and issue it. Rates are 0 because
 * nothing here knows what the job costs — a guessed figure on a real quotation is worse than a
 * blank one.
 *
 * Runs through quotationEngine.createQuotation rather than writing Quotation_Master directly, so
 * the draft gets the same GST resolution, customer snapshot and portal code as any other
 * quotation. That does consume a quote number from the counter, which is the accepted cost of
 * having one canonical creation path — a gap in the sequence is a normal, explainable thing
 * (a withdrawn quotation looks the same), whereas a hand-rolled row that skips snapshotting
 * would break conversion later.
 */
async function createDraftQuotation({ customer, data, task, inquiryNo }) {
  const lineItems = data.requirements.map((key, index) => ({
    Sr_No: index + 1,
    Item_Name: key === 'OTHER' && data.otherRequirement
      ? data.otherRequirement.slice(0, 150)
      : inquiryValidator.labelForRequirement(key),
    Description: '',
    Qty: 1,
    Unit: 'Nos',
    Rate: 0,
    Discount_Pct: 0,
    GST_Rate: 18,
    Requirement_Key: key
  }));

  return quotationEngine.createQuotation({
    customerId: customer.Customer_ID,
    lineItems,
    taskId: task.Task_ID,
    subject: `${ONLINE_INQUIRY_TAG} ${inquiryNo}`,
    notes: [
      `Auto-drafted from online inquiry ${inquiryNo}.`,
      `Requirements: ${inquiryValidator.summarizeRequirements(data)}`,
      '',
      'Rates are blank — please price each line before issuing.'
    ].join('\n')
  }, { staffId: 'PUBLIC_INQUIRY', name: ONLINE_INQUIRY_TAG });
}

/**
 * Core ingestion. Everything here is load-bearing: if it throws, the customer is told to phone in
 * rather than being shown a false success for an enquiry nobody received.
 */
async function ingestInquiry(data, meta = {}) {
  const inquiryNo = await nextInquiryNo();

  const existingCustomer = await findCustomerByMobile(data.mobile);
  const isReturning = Boolean(existingCustomer);

  // A returning customer's stored profile is READ, never rewritten from public input. See the file
  // header: this endpoint is unauthenticated, so treating it as a source of truth for an existing
  // register row would let anyone who knows a mobile number edit that customer's details.
  const customer = existingCustomer || await createCustomerFromInquiry(data);

  // The single exception, and it is additive only: a NEW colleague named on this enquiry is
  // appended to the contact list. Nothing already on file is renamed or removed. Best-effort —
  // a contact list is worth less than the lead itself.
  if (existingCustomer) {
    try {
      await mergeCoordinatorsIntoCustomer(existingCustomer, data);
    } catch (e) {
      console.error('[inquiryService] Coordinator merge failed:', e.message);
    }
  }

  const tagId = await ensureOnlineInquiryTag();
  const task = await createLeadTask({ customer, data, inquiryNo, tagId });

  // The enquiry verbatim, on the customer's timeline. This is the durable record of what was
  // actually submitted — the task description is a summary, and the draft quotation will be edited.
  await interactionLogger.logEvent({
    tag: ONLINE_INQUIRY_TAG,
    summary: [
      `${inquiryNo} received via the website.`,
      `Contact: ${data.name}${data.designation ? ` (${data.designation})` : ''} · +91 ${data.mobile}`
        + `${data.whatsapp && data.whatsapp !== data.mobile ? ` · WhatsApp +91 ${data.whatsapp}` : ''}`
        + ` · ${data.email}`,
      ...(data.extraContacts || []).map(c =>
        `Also: ${c.name || 'Unnamed'}${c.designation ? ` (${c.designation})` : ''}`
        + `${c.mobile ? ` · +91 ${c.mobile}` : ''}`
        + `${c.whatsapp && c.whatsapp !== c.mobile ? ` · WhatsApp +91 ${c.whatsapp}` : ''}`
        + `${c.email ? ` · ${c.email}` : ''}`
      ),
      `Site: ${data.address}`,
      `Requirements: ${inquiryValidator.summarizeRequirements(data)}`,
      isReturning ? 'Existing customer — added to their profile.' : 'New customer profile created.'
    ].join('\n'),
    taskId: task.Task_ID,
    customerId: customer.Customer_ID,
    actor: { staffId: 'PUBLIC_INQUIRY', name: ONLINE_INQUIRY_TAG }
  });

  return {
    inquiryNo,
    customer,
    task,
    isReturning,
    submittedAt: new Date().toISOString(),
    submittedIp: meta.ip || ''
  };
}

/**
 * Everything that must not be able to fail the request: the draft quotation, the internal alerts
 * and the customer's confirmation.
 *
 * Each step is caught independently so one broken channel cannot suppress the others — an
 * unapproved WhatsApp template must still leave the admin email delivered. Awaited (not
 * fire-and-forget) because this runs in a serverless function, where the process can be frozen the
 * moment the response is sent and detached promises would simply never run.
 */
async function runPostIngestion(ingested, data) {
  const outcome = { quotation: null, adminAlert: null, customerAck: null, errors: [] };

  try {
    outcome.quotation = await createDraftQuotation({
      customer: ingested.customer,
      data,
      task: ingested.task,
      inquiryNo: ingested.inquiryNo
    });
  } catch (e) {
    console.error('[inquiryService] Draft quotation failed:', e.message);
    outcome.errors.push(`Draft quotation: ${e.message}`);
  }

  // Required inline to avoid a require cycle: inquiryDispatch pulls dispatchService, which reaches
  // back into this module's formatting helpers.
  const inquiryDispatch = require('./inquiryDispatch');

  try {
    outcome.adminAlert = await inquiryDispatch.sendAdminAlert({
      ...ingested,
      data,
      quotation: outcome.quotation
    });
  } catch (e) {
    console.error('[inquiryService] Admin alert failed:', e.message);
    outcome.errors.push(`Admin alert: ${e.message}`);
  }

  try {
    outcome.customerAck = await inquiryDispatch.sendCustomerAcknowledgement({ ...ingested, data });
  } catch (e) {
    console.error('[inquiryService] Customer acknowledgement failed:', e.message);
    outcome.errors.push(`Customer acknowledgement: ${e.message}`);
  }

  return outcome;
}

module.exports = {
  ONLINE_INQUIRY_TAG,
  SOURCE,
  istToday,
  nextInquiryNo,
  findCustomerByMobile,
  buildCoordinators,
  mergeCoordinatorsIntoCustomer,
  createCustomerFromInquiry,
  createLeadTask,
  createDraftQuotation,
  ingestInquiry,
  runPostIngestion
};
