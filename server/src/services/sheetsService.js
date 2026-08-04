const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encryptRow, decryptRows, decryptRow } = require('../utils/cryptoMiddleware');

// Flexible Schemas mapping to the old "Tabs"
const createModel = (name) => {
  const schema = new mongoose.Schema({}, { strict: false, collection: name });
  return mongoose.models[name] || mongoose.model(name, schema);
};

const models = {
  Staff_Master: createModel('Staff_Master'),
  Customer_Master: createModel('Customer_Master'),
  Task_Master: createModel('Task_Master'),
  Activity_Logs: createModel('Activity_Logs'),
  Attendance_Log: createModel('Attendance_Log'),
  Leave_Requests: createModel('Leave_Requests'),
  // Out-of-office punch requests awaiting Admin sign-off. Its own collection rather than a field on
  // Attendance_Log because there IS no attendance row yet when the request is raised — the whole
  // point is that the punch has not happened.
  Attendance_Approvals: createModel('Attendance_Approvals'),
  Customer_Interactions: createModel('Customer_Interactions'),
  Salary_Advances: createModel('Salary_Advances'),
  Document_Registry: createModel('Document_Registry'),
  Equipment_Master: createModel('Equipment_Master'),
  Service_Reports: createModel('Service_Reports'),
  Client_Equipment_Master: createModel('Client_Equipment_Master'),
  Document_Settings: createModel('Document_Settings'),
  Tag_Master: createModel('Tag_Master'),
  // Discussion Log interaction-type tags ("Call Dialed", "Site Visit"...). Deliberately separate
  // from Tag_Master, which labels TASK cards — sharing one list would mix the two pickers and let
  // a task label get chosen as a remark type or vice versa.
  Remark_Tag_Master: createModel('Remark_Tag_Master'),
  Field_Visits: createModel('Field_Visits'),
  Certificate_Type_Master: createModel('Certificate_Type_Master'),
  // Due-certificate tracking rows for legacy/paper customers with no certificate ever generated in
  // this system. Kept separate from Document_Registry rather than faked as a certificate — it has
  // no Verification_GUID/QR/PDF, and mixing it into certificate save/edit logic would risk the two
  // paths corrupting each other's state.
  Manual_Due_Entries: createModel('Manual_Due_Entries'),
  Notification_Settings: createModel('Notification_Settings'),
  Attendance_Settings: createModel('Attendance_Settings'),
  Quotation_Settings: createModel('Quotation_Settings'),
  Item_Master: createModel('Item_Master'),
  Quotation_Master: createModel('Quotation_Master'),
  PI_Master: createModel('PI_Master'),
  Sales_Invoice_Master: createModel('Sales_Invoice_Master'),
  Inventory_Master: createModel('Inventory_Master'),
  Stock_Transactions: createModel('Stock_Transactions'),
  Counter_Master: createModel('Counter_Master'),
  Media_Store: createModel('Media_Store'),

  // Workshop job card. Items live in their own collection rather than as an array on the header:
  // updateRow() only supports $set, so multi-day, multi-device part fitting against an array would
  // be a read-modify-write and two technicians (or an offline queue draining after a live write)
  // would silently clobber each other. One document per cylinder confines every write to one row.
  Job_Card_Master: createModel('Job_Card_Master'),
  Job_Card_Item: createModel('Job_Card_Item'),
  Delivery_Challan_Master: createModel('Delivery_Challan_Master'),
  Customer_Price_List: createModel('Customer_Price_List'),
  Equipment_Category_Master: createModel('Equipment_Category_Master'),

  // Procurement. Purchase_Quote is its own collection rather than an array on the RFQ because each
  // vendor answers independently — one reply must never overwrite another's, which is the same
  // reasoning that keeps Job_Card_Item separate from its header.
  Vendor_Master: createModel('Vendor_Master'),
  Purchase_RFQ: createModel('Purchase_RFQ'),
  Purchase_Quote: createModel('Purchase_Quote'),
  Purchase_Order: createModel('Purchase_Order'),
  Goods_Receipt: createModel('Goods_Receipt'),

  // Security. Audit_Logs is separate from Activity_Logs on purpose — see utils/auditLog.js.
  // Auth_Sessions and Auth_OTPs are their own collections rather than arrays on Staff_Master for
  // the same reason Job_Card_Item is: updateRow() only does $set, so two logins landing together
  // would clobber each other's array.
  Audit_Logs: createModel('Audit_Logs'),
  Auth_Sessions: createModel('Auth_Sessions'),
  Auth_OTPs: createModel('Auth_OTPs'),
  Security_Settings: createModel('Security_Settings')
};

class MongoService {
  constructor() {
    this.isConnected = false;
    this.cache = {};
    this.cacheTTL = 3000; // 3 seconds TTL for ultra-fast queries without DB thrashing
  }

  async connect(uri) {
    const targetUri = uri || process.env.MONGO_URI;
    if (!targetUri) {
      throw new Error('MONGO_URI is not set. Configure it in the environment (Vercel env vars / server/.env).');
    }
    if (mongoose.connection.readyState === 1) {
      this.isConnected = true;
      return;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    // Timed so a slow cold start (serverless) is visible in logs distinctly from a slow query
    // inside getTab() — the two used to be indistinguishable from a single "it's slow" report.
    const connectStarted = Date.now();
    // Explicit pool/timeout tuning: unset, Mongoose's per-instance defaults mean every serverless
    // cold start opens a fresh, unbounded-wait connection instead of failing fast and letting the
    // caller retry. The timeouts bound how long a stalled handshake/query can hang before erroring
    // out. maxPoolSize must clear the widest single fan-out in the app (/sync/all alone issues 13
    // parallel getTab() calls) with real headroom — at 10 it was BELOW that, so /sync/all's own
    // queries queued behind each other, and /api/notifications/my (polled independently every 30s,
    // often landing mid-/sync/all) queued behind those, which is what stretched a punch-approval
    // notification's arrival from a normal poll delay into a much longer wait.
    this.connectionPromise = mongoose.connect(targetUri, {
      maxPoolSize: 50,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    }).then(() => {
      this.isConnected = true;
      console.log(`✅ Connected to MongoDB Atlas [PERF] connect() took ${Date.now() - connectStarted}ms`);
      this.ensureIndexes();
    }).catch(err => {
      this.connectionPromise = null;
      console.error(`❌ MongoDB Connection Error after ${Date.now() - connectStarted}ms:`, err);
      throw err;
    });
    return this.connectionPromise;
  }

  /**
   * Database-level guard against duplicate certificate numbers.
   *
   * Check-then-insert cannot be made safe on its own: getAllCertificates() reads a 3s cache, so two
   * saves in the same window both see the same pre-write snapshot and both pass. Only a unique index
   * makes a duplicate impossible.
   *
   * It is PARTIAL on purpose. 34 legacy rows already share a number (and one has no number at all);
   * a plain unique index could not be built over that data and would reject edits to it. Indexing
   * only rows that carry Number_Locked:true — which only the new save path sets — constrains every
   * certificate issued from now on while leaving the historical rows exactly as they are.
   *
   * Best-effort: a failed index build must never stop the server booting.
   */
  async ensureIndexes() {
    try {
      await models['Document_Registry'].collection.createIndex(
        { Certificate_No: 1 },
        { unique: true, partialFilterExpression: { Number_Locked: true }, name: 'cert_no_unique_locked' }
      );
    } catch (err) {
      console.error('⚠️  Certificate number index not created:', err.message);
    }

    // Lookup/filter indexes for the fields routes actually query on once filtering is pushed into
    // Mongo (see queryTab). Each build is independent and best-effort — one failing must never
    // block another or stop the server booting.
    const lookupIndexes = [
      ['Customer_Master', { Customer_ID: 1 }, 'customer_id'],
      ['Task_Master', { Task_ID: 1 }, 'task_id'],
      ['Task_Master', { Customer_ID: 1 }, 'task_customer_id'],
      ['Task_Master', { Assigned_Staff: 1 }, 'task_assigned_staff'],
      ['Task_Master', { Status: 1 }, 'task_status'],
      ['Staff_Master', { Staff_ID: 1 }, 'staff_id'],
      ['Item_Master', { Item_ID: 1 }, 'item_id'],
      ['Item_Master', { Category: 1 }, 'item_category'],
      ['Quotation_Master', { Customer_ID: 1 }, 'quotation_customer_id'],
      ['Quotation_Master', { Status: 1 }, 'quotation_status'],
      ['Quotation_Master', { Created_At_Ms: -1 }, 'quotation_created_at'],
      ['Vendor_Master', { Vendor_ID: 1 }, 'vendor_id'],
      ['Purchase_Order', { PO_ID: 1 }, 'po_id'],
      ['Document_Registry', { Customer_ID: 1 }, 'doc_customer_id'],
      // Compound, matching exactly how punchIn/punchOut/supersedePendingApprovals filter — a punch
      // looks up one staff member's own rows for one date, not the whole collection.
      ['Attendance_Log', { Staff_ID: 1, Date: 1 }, 'attendance_staff_date'],
      ['Attendance_Approvals', { Staff_ID: 1, Requested_Date: 1, Punch_Type: 1, Status: 1 }, 'approvals_staff_date_type_status']
    ];
    for (const [collection, spec, name] of lookupIndexes) {
      try {
        await models[collection].collection.createIndex(spec, { name, background: true });
      } catch (err) {
        console.error(`⚠️  Index ${name} on ${collection} not created:`, err.message);
      }
    }
  }

  async getTab(sheetName) {
    const now = Date.now();
    if (this.cache[sheetName] && (now - this.cache[sheetName].timestamp < this.cacheTTL)) {
      return this.cache[sheetName].data;
    }
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    // Separates the raw Mongo round-trip from the decrypt pass so a slow query and slow crypto
    // show up as distinct numbers in logs instead of one opaque getTab() total — confirmed via
    // direct measurement that Atlas round-trip latency, not decrypt, is what varies (0-30ms decrypt
    // vs. hundreds of ms to several seconds of query time on this cluster).
    const queryStarted = Date.now();
    const data = await Model.find({}).lean();
    const queryMs = Date.now() - queryStarted;
    // Remove _id and __v for backward compatibility with existing JSON code. If a document has no
    // app-level `id` field of its own (legacy rows inserted before an `id` convention existed),
    // backfill it from Mongo's real, always-unique _id — otherwise every such row collapses to
    // `id: undefined` and editing/deleting one wipes all of them from the client's perspective.
    const cleanData = data.map(doc => {
      const fallbackId = doc._id ? String(doc._id) : undefined;
      delete doc._id;
      delete doc.__v;
      if (doc.id === undefined && fallbackId) doc.id = fallbackId;
      return doc;
    });
    // Decrypt BEFORE caching, so the cached array holds plaintext and a second reader inside the
    // 3s TTL never re-decrypts an already-decrypted value. decryptRows returns new objects and
    // leaves `cleanData` untouched, matching the read-only contract this cache relies on.
    const decryptStarted = Date.now();
    const decrypted = decryptRows(sheetName, cleanData);
    const decryptMs = Date.now() - decryptStarted;
    if (queryMs > 200 || decryptMs > 200) {
      console.log(`[PERF] getTab('${sheetName}') rows=${data.length} query=${queryMs}ms decrypt=${decryptMs}ms`);
    }
    this.cache[sheetName] = { timestamp: now, data: decrypted };
    return decrypted;
  }

  /**
   * Like getTab(), but pushes a filter down to Mongo instead of loading the whole collection and
   * filtering in JS. Bypasses the getTab() cache on purpose — callers pass different filters on
   * every request, so a shared cache keyed only on sheetName couldn't serve them correctly anyway.
   * Only use this for collections that are large/growing AND already indexed for the fields being
   * filtered on (see ensureIndexes); for small master lists getTab() + client-side search is the
   * established, intentional pattern (see CLAUDE.md's UI Standard).
   */
  async queryTab(sheetName, filter = {}, options = {}) {
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    let query = Model.find(filter).lean();
    if (options.sort) query = query.sort(options.sort);
    if (options.limit) query = query.limit(options.limit);
    const data = await query;
    const cleanData = data.map(doc => {
      const fallbackId = doc._id ? String(doc._id) : undefined;
      delete doc._id;
      delete doc.__v;
      if (doc.id === undefined && fallbackId) doc.id = fallbackId;
      return doc;
    });
    return decryptRows(sheetName, cleanData);
  }

  async insertRow(sheetName, data) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    // Encrypt on the way in. The caller gets its ORIGINAL plaintext object back, not the encrypted
    // one — several routes return the inserted row straight to the client as the API response.
    const doc = new Model(encryptRow(sheetName, data));
    await doc.save();
    return data;
  }

  async updateRow(sheetName, idColumn, idValue, updateData) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    let query = { [idColumn]: idValue };
    if (typeof idValue === 'string') {
      query = {
        $or: [
          { [idColumn]: idValue },
          { [idColumn]: idValue.trim() },
          { [idColumn]: new RegExp(`^${idValue.trim()}$`, 'i') }
        ]
      };
      // getTab() backfills a missing app-level `id` from Mongo's real _id (see getTab) — if this
      // looks like that fallback (a raw ObjectId string), also match on _id so legacy documents
      // without their own `id` field can still be found and updated.
      if (idColumn === 'id' && mongoose.Types.ObjectId.isValid(idValue.trim())) {
        query.$or.push({ _id: idValue.trim() });
      }
    }

    let oldDoc = null;
    if (sheetName === 'Task_Master') {
      try {
        oldDoc = await Model.findOne(query).lean();
      } catch (e) {
        console.error('Error fetching oldDoc inside updateRow:', e);
      }
    }

    // $set only the fields the caller supplied, encrypted. encryptRow never materialises a key
    // that was absent, so an update touching one field cannot blank out the others.
    const updated = await Model.findOneAndUpdate(
      query,
      { $set: encryptRow(sheetName, updateData) },
      { new: true, returnDocument: 'after' }
    ).lean();
    if (updated) {
      delete updated._id;
      delete updated.__v;

      // Automatically handle recurring task re-opening/creation
      if (sheetName === 'Task_Master' && oldDoc) {
        const wasCompleted = oldDoc.Status === 'Completed' || oldDoc.Status === 'Closed';
        const isCompleted = updated.Status === 'Completed' || updated.Status === 'Closed';
        const isRecurring = String(updated.Type || oldDoc.Type).toLowerCase() === 'recurring';
        
        if (isRecurring && isCompleted && !wasCompleted) {
          try {
            const interval = updated.Recurring_Interval || oldDoc.Recurring_Interval || 'Monthly';
            const period = updated.Recurring_Period || oldDoc.Recurring_Period;
            const currentSchedDate = updated.Scheduled_Date || oldDoc.Scheduled_Date;
            
            const calculateNextDate = (dateStr, rInterval, rPeriod) => {
              let d = new Date();
              if (dateStr) {
                const parts = dateStr.split('-');
                if (parts.length === 3) {
                  if (parts[0].length === 4) {
                    d = new Date(parts[0], parts[1] - 1, parts[2]);
                  } else {
                    d = new Date(parts[2], parts[1] - 1, parts[0]);
                  }
                }
              }
              
              let val = 1;
              let norm = String(rInterval).trim().toLowerCase();
              if (rPeriod) {
                try {
                  const p = typeof rPeriod === 'string' ? JSON.parse(rPeriod) : rPeriod;
                  if (p.value && !isNaN(p.value)) val = Number(p.value);
                  if (p.type) norm = String(p.type).trim().toLowerCase();
                } catch (e) {}
              }
              
              if (norm === 'daily') d.setDate(d.getDate() + 1 * val);
              else if (norm === 'weekly') d.setDate(d.getDate() + 7 * val);
              else if (norm === 'quarterly') d.setMonth(d.getMonth() + 3 * val);
              else if (norm === 'half-yearly' || norm === 'half-year') d.setMonth(d.getMonth() + 6 * val);
              else if (norm === 'yearly') d.setFullYear(d.getFullYear() + 1 * val);
              else d.setMonth(d.getMonth() + 1 * val); // default to monthly
              
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              return `${y}-${m}-${day}`;
            };
            
            const nextDate = calculateNextDate(currentSchedDate, interval, period);
            const newTask = {
              Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
              Customer_ID: updated.Customer_ID || oldDoc.Customer_ID,
              Description: updated.Description || oldDoc.Description,
              Assigned_Staff: updated.Assigned_Staff || oldDoc.Assigned_Staff,
              Department: 'Sales',
              Stage: 'New Inquiry',
              Type: 'Recurring',
              Recurring_Interval: interval,
              Recurring_Period: period,
              Scheduled_Date: nextDate,
              Status: 'Pending'
            };
            
            const newDoc = new Model(newTask);
            await newDoc.save();
            console.log(`[Recurring Schedule] Auto-created task ${newTask.Task_ID} scheduled for ${nextDate} (Interval: ${interval})`);
          } catch (e) {
            console.error('Error auto-scheduling recurring task:', e);
          }
        }
      }

      // Decrypt on the way out: `updated` came back from Mongo and holds ciphertext, but callers
      // (and the routes that return this straight to the client) expect plaintext.
      return decryptRow(sheetName, updated);
    }
    const allDocs = await this.getTab(sheetName);
    const existing = allDocs.find(d => String(d[idColumn]).trim().toLowerCase() === String(idValue).trim().toLowerCase());
    if (existing) {
      delete this.cache[sheetName];
      // Second write path — must encrypt too, or an update routed through here would silently
      // store plaintext into a collection whose other rows are encrypted.
      await Model.updateOne({ [idColumn]: existing[idColumn] }, { $set: encryptRow(sheetName, updateData) });
      // `existing` came from getTab and is already decrypted, so merging the plaintext update
      // over it yields the plaintext row the caller expects.
      return { ...existing, ...updateData };
    }
    return null;
  }

  async deleteRow(sheetName, idColumn, idValue) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    // See updateRow: getTab() backfills a missing app-level `id` from Mongo's real _id, so also
    // match on _id when idValue looks like that fallback, or legacy rows without their own `id`
    // field can never actually be deleted by this route.
    const query = (idColumn === 'id' && typeof idValue === 'string' && mongoose.Types.ObjectId.isValid(idValue.trim()))
      ? { $or: [{ [idColumn]: idValue }, { _id: idValue.trim() }] }
      : { [idColumn]: idValue };
    // Report whether a row was actually removed. This used to return a hardcoded `true`, which
    // made every caller's `if (!deleted) return 404` unreachable — deleting a non-existent id
    // answered 200 "success". deleteMediaById already used deletedCount this way; match it.
    const result = await Model.deleteOne(query);
    return result.deletedCount > 0;
  }

  // Backwards compatible specific methods
  async getAllStaff() { return this.getTab('Staff_Master'); }
  async getStaffByEmail(email) {
    const staff = await this.getAllStaff();
    return staff.find(s => s.Email === email) || null;
  }
  async getStaffById(staffId) {
    if (!staffId) return null;
    const staff = await this.getAllStaff();
    const target = staffId.toString().trim().toUpperCase();
    return staff.find(s => s.Staff_ID && s.Staff_ID.toString().trim().toUpperCase() === target) || null;
  }
  async getAllCustomers() { return this.getTab('Customer_Master'); }
  async getAllTasks() { return this.getTab('Task_Master'); }
  async getTasksByStaff(staffId) {
    const tasks = await this.getAllTasks();
    return tasks.filter(t => t.Assigned_Staff === staffId);
  }
  async getTaskById(taskId) {
    const tasks = await this.getAllTasks();
    return tasks.find(t => t.Task_ID === taskId) || null;
  }
  async getAllLogs() { return this.getTab('Activity_Logs'); }
  async getAllAttendance() { return this.getTab('Attendance_Log'); }
  async getAttendanceByStaff(staffId) {
    const records = await this.getAllAttendance();
    return records.filter(r => r.Staff_ID === staffId);
  }
  async getAllLeaves() { return this.getTab('Leave_Requests'); }
  async getLeavesByStaff(staffId) {
    const leaves = await this.getAllLeaves();
    return leaves.filter(l => l.Staff_ID === staffId);
  }
  async getCustomerInteractions() { return this.getTab('Customer_Interactions'); }
  async getAdvances() { return this.getTab('Salary_Advances'); }
  async getAllCertificates() { return this.getTab('Document_Registry'); }
  async getCertificateByGuid(guid) {
    const certs = await this.getAllCertificates();
    return certs.find(c => c.verificationGuid === guid || c.Certificate_No === guid || String(c.verificationGuid || '').toLowerCase() === String(guid || '').toLowerCase()) || null;
  }

  /**
   * Every certificate matching a GUID *or* a certificate number, most recent first.
   *
   * getCertificateByGuid() takes the first match, which is correct for a GUID (they are unique) but
   * silently picks one arbitrary customer when the caller passed a certificate number that 34
   * legacy rows share. Verification uses this to show a disambiguation page instead of confidently
   * vouching for the wrong document.
   */
  async getCertificatesByGuidOrNumber(value) {
    const needle = String(value || '').trim().toLowerCase();
    if (!needle) return [];
    const certs = await this.getAllCertificates();
    const byGuid = certs.filter(c => String(c.verificationGuid || c.Verification_GUID || '').trim().toLowerCase() === needle);
    // A GUID match is exact and unique — never dilute it with number matches.
    if (byGuid.length > 0) return byGuid;
    return certs
      .filter(c => String(c.Certificate_No || c.certificateNo || '').trim().toLowerCase() === needle)
      .sort((a, b) => String(b.Issue_Date || b.issueDate || '').localeCompare(String(a.Issue_Date || a.issueDate || '')));
  }

  /**
   * Next certificate number for a prefix, from the atomic Counter_Master sequence.
   *
   * Certificate numbers used to be computed in the browser from a max+1 scan of whatever that tab
   * had loaded, with the letters stripped off before comparing — so R311, T311 and HPT311 all
   * counted as "311" and every type independently started from the same floor. 34 of 100 rows ended
   * up sharing a number. This routes numbering through the same race-free $inc counter the
   * quotation engine uses, keyed per prefix so R and T advance independently.
   */
  async getNextCertificateNumber(stem, letters) {
    const counterKey = `CERT:${stem}/${letters}`;
    // Seed a brand-new counter from the highest number already issued under this exact stem+letters
    // so switching on this feature cannot re-issue a number a customer already holds.
    const certs = await this.getAllCertificates();
    let seed = 0;
    for (const c of certs) {
      const raw = String(c.Certificate_No || c.certificateNo || '').trim();
      const cut = raw.lastIndexOf('/');
      if (cut <= 0 || raw.slice(0, cut) !== stem) continue;
      const m = raw.slice(cut + 1).match(/^([A-Za-z]*)(\d+)$/);
      if (m && m[1].toUpperCase() === String(letters).toUpperCase()) {
        const n = parseInt(m[2], 10);
        if (n > seed) seed = n;
      }
    }
    const next = await this.getNextSequence(counterKey, { seedIfNew: seed });
    return { number: `${stem}/${letters}${next}`, sequence: `${letters}${next}`, value: next };
  }
  async getEquipmentMaster() {
    const items = await this.getTab('Equipment_Master');
    if (items && items.length > 0) return items;
    // refillValidityYears / hptValidityYears seed the two intervals the certificate module needs.
    // Only the CO2 cylinder is a 5-year hydro-test vessel (Gas Cylinder Rules); every other body is
    // 3 years per IS 2190 — including Water CO2, which is a water body with a CO2 cartridge and is
    // routinely mistaken for a gas cylinder because of its name. Non-cylinder equipment (hose,
    // sprinkler, alarm panel) is never hydro-tested; it keeps the 3-year default only so the field
    // is always present, and those items are simply not used on an HP Testing certificate.
    return [
      { id: 'eq-1', type: 'Dry Chemical Powder (ABC Type IS:15683)', capacities: ['1 Kg', '2 Kg', '4 Kg', '4.5 Kg', '6 Kg', '9 Kg'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-2', type: 'CO2 Fire Extinguisher (IS:15683 / IS:2878)', capacities: ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'], refillValidityYears: 1, hptValidityYears: 5 },
      { id: 'eq-3', type: 'Clean Agent / HFC-236fa Extinguisher', capacities: ['1 Kg', '2 Kg', '4 Kg', '6 Kg'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-4', type: 'Foam Type Fire Extinguisher (Mechanical Foam)', capacities: ['9 Ltr', '50 Ltr (Trolley)', '150 Ltr'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-5', type: 'Water CO2 Type Fire Extinguisher', capacities: ['9 Ltr', '50 Ltr (Trolley)'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-6', type: 'Automatic Modular Extinguisher (Clean Agent / ABC)', capacities: ['2 Kg', '5 Kg', '10 Kg', '15 Kg'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-7', type: 'Wet Chemical Fire Extinguisher (Kitchen Safety)', capacities: ['2 Ltr', '4 Ltr', '6 Ltr', '9 Ltr'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-8', type: 'Fire Hydrant Hose Reel & Branch Pipe Unit', capacities: ['30 Meter (3/4")', '30 Meter (1")', 'Standard Branch Pipe'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-9', type: 'Sprinkler Head & Alarm Valve Unit', capacities: ['68°C Pendent Type', '68°C Upright Type', 'Sprinkler Alarm Valve'], refillValidityYears: 1, hptValidityYears: 3 },
      { id: 'eq-10', type: 'Conventional / Addressable Fire Alarm Panel', capacities: ['2 Zone Panel', '4 Zone Panel', '8 Zone Panel', 'Loop Addressable'], refillValidityYears: 1, hptValidityYears: 3 }
    ];
  }
  async getAllServiceReports() { return this.getTab('Service_Reports'); }
  async getAllTags() { return this.getTab('Tag_Master'); }
  async getAllRemarkTags() { return this.getTab('Remark_Tag_Master'); }

  async getAllCertificateTypes() { return this.getTab('Certificate_Type_Master'); }

  async getDocumentSettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Document_Settings'];
    const doc = await Model.findOne({ company_id: companyId }).lean();
    if (doc) { delete doc._id; delete doc.__v; }
    return doc || null;
  }

  async saveDocumentSettings(companyId = 'DEFAULT', settingsData) {
    await this.connect();
    const Model = models['Document_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }

  async getAttendanceSettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Attendance_Settings'];
    const doc = await Model.findOne({ company_id: companyId }).lean();
    if (doc) { delete doc._id; delete doc.__v; }
    return doc || null;
  }

  async saveAttendanceSettings(companyId = 'DEFAULT', settingsData) {
    await this.connect();
    const Model = models['Attendance_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }

  async getAttendanceApprovals() { return this.getTab('Attendance_Approvals'); }

  /**
   * updateRow with an extra condition folded into the FILTER, so the database decides the winner.
   *
   * updateRow() matches on the key column alone. That is fine for ordinary edits but not for
   * claiming a pending approval: two Admins tapping Approve at the same moment would both read
   * Status 'Pending', both pass an if(), and both write a punch — two attendance rows for one
   * arrival. Putting the expected state in the query means the loser matches zero documents and
   * gets null back, which is the only reliable guard available without transactions.
   *
   * Returns the updated row, or null when the condition no longer held.
   */
  async updateRowIf(sheetName, idColumn, idValue, extraFilter, updateData) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);

    const updated = await Model.findOneAndUpdate(
      { [idColumn]: idValue, ...extraFilter },
      { $set: encryptRow(sheetName, updateData) },
      { new: true, returnDocument: 'after' }
    ).lean();

    if (!updated) return null;
    delete updated._id; delete updated.__v;
    delete this.cache[sheetName];
    return decryptRow(sheetName, updated);
  }

  async getNotificationSettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Notification_Settings'];
    const doc = await Model.findOne({ company_id: companyId }).lean();
    if (doc) { delete doc._id; delete doc.__v; }
    return doc || null;
  }

  async saveNotificationSettings(companyId = 'DEFAULT', settingsData) {
    await this.connect();
    const Model = models['Notification_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }

  /**
   * Security settings — currently the backup-health verdict reported by scripts/verify-backup.js.
   * Same singleton shape as the other *_Settings collections above.
   */
  async getSecuritySettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Security_Settings'];
    const doc = await Model.findOne({ company_id: companyId }).lean();
    if (doc) { delete doc._id; delete doc.__v; }
    return doc || null;
  }

  async saveSecuritySettings(settingsData, companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Security_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }

  async getQuotationSettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Quotation_Settings'];
    const doc = await Model.findOne({ company_id: companyId });
    if (doc) {
      const oldBody = 'Dear {customer_name},\n\nA gentle reminder regarding quotation {quote_no} for {amount}. Do let us know your feedback.\n\n{view_link}\n\nRegards,\nExpert Safety Solutions';
      const newBody = 'Dear {customer_name},\n\nA gentle reminder regarding quotation {quote_no} for {amount}. Do let us know your feedback.\n\nYou can view and download the quotation from the following link:\n{view_link}\n\nRegards,\nExpert Safety Solutions';
      if (doc.draft_templates?.followup_reminder?.body === oldBody) {
        if (!doc.draft_templates) doc.draft_templates = {};
        if (!doc.draft_templates.followup_reminder) doc.draft_templates.followup_reminder = {};
        doc.draft_templates.followup_reminder.body = newBody;
        doc.markModified('draft_templates');
        await doc.save();
      }
      const raw = doc.toObject();
      delete raw._id; delete raw.__v;
      return raw;
    }
    return null;
  }

  async saveQuotationSettings(companyId = 'DEFAULT', settingsData) {
    await this.connect();
    const Model = models['Quotation_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }

  async getAllItems() { return this.getTab('Item_Master'); }
  async getItemById(itemId) {
    const items = await this.getAllItems();
    return items.find(i => i.Item_ID === itemId) || null;
  }

  /**
   * Media (product photos etc.) is stored as base64 in its own collection and served by
   * GET /api/media/:id. These deliberately query Mongo directly instead of going through
   * getTab() — that helper loads and caches an entire collection, which would pull every
   * image blob into memory on any read.
   */
  async insertMedia(doc) {
    const Model = models['Media_Store'];
    await Model.create(doc);
    return doc;
  }

  async getMediaById(mediaId) {
    const Model = models['Media_Store'];
    const found = await Model.findOne({ Media_ID: String(mediaId || '') }).lean();
    if (found) { delete found._id; delete found.__v; }
    return found || null;
  }

  async deleteMediaById(mediaId) {
    const Model = models['Media_Store'];
    const result = await Model.deleteOne({ Media_ID: String(mediaId || '') });
    return result.deletedCount > 0;
  }

  async getAllQuotations() { return this.getTab('Quotation_Master'); }
  async getQuotationById(quotationId) {
    const quotes = await this.getAllQuotations();
    return quotes.find(q => q.Quotation_ID === quotationId) || null;
  }
  // Matches either the long legacy Portal_Guid or the short Portal_Code, so links mailed before
  // short codes existed keep resolving forever. One lookup serves both URL shapes.
  async getQuotationByPortalGuid(guid) {
    if (!guid) return null;
    const quotes = await this.getAllQuotations();
    const target = String(guid).trim().toLowerCase();
    return quotes.find(q =>
      String(q.Portal_Guid || '').toLowerCase() === target ||
      String(q.Portal_Code || '').toLowerCase() === target
    ) || null;
  }
  // All revisions of one quotation share a Root_Quotation_ID (R0's own ID), so the whole
  // version history is one filter rather than a recursive walk up Parent_Quotation_ID.
  async getQuotationRevisions(rootId) {
    const quotes = await this.getAllQuotations();
    return quotes
      .filter(q => (q.Root_Quotation_ID || q.Quotation_ID) === rootId)
      .sort((a, b) => (a.Revision_No || 0) - (b.Revision_No || 0));
  }

  async getAllPIs() { return this.getTab('PI_Master'); }
  async getPIById(piId) {
    const pis = await this.getAllPIs();
    return pis.find(p => p.PI_ID === piId) || null;
  }
  async getAllSalesInvoices() { return this.getTab('Sales_Invoice_Master'); }
  async getSalesInvoiceById(invoiceId) {
    const invoices = await this.getAllSalesInvoices();
    return invoices.find(i => i.Invoice_ID === invoiceId) || null;
  }

  async getInventory() { return this.getTab('Inventory_Master'); }
  async getInventoryByItem(itemId) {
    const rows = await this.getInventory();
    return rows.find(r => r.Item_ID === itemId) || null;
  }
  async getStockTransactions() { return this.getTab('Stock_Transactions'); }

  async getAllJobCards() { return this.getTab('Job_Card_Master'); }
  async getJobCardById(jobCardId) {
    const cards = await this.getAllJobCards();
    return cards.find(c => c.Job_Card_ID === jobCardId) || null;
  }
  // One task carries at most one job card, so this doubles as the uniqueness check on create.
  async getJobCardByTask(taskId) {
    if (!taskId) return null;
    const target = String(taskId).trim().toLowerCase();
    const cards = await this.getAllJobCards();
    return cards.find(c => String(c.Task_ID || '').trim().toLowerCase() === target) || null;
  }
  async getAllJobCardItems() { return this.getTab('Job_Card_Item'); }
  async getJobCardItems(jobCardId) {
    const rows = await this.getAllJobCardItems();
    return rows
      .filter(r => r.Job_Card_ID === jobCardId)
      .sort((a, b) => (Number(a.Sr_No) || 0) - (Number(b.Sr_No) || 0));
  }
  async getJobCardItemById(itemId) {
    const rows = await this.getAllJobCardItems();
    return rows.find(r => r.Job_Card_Item_ID === itemId) || null;
  }

  async getAllChallans() { return this.getTab('Delivery_Challan_Master'); }
  async getChallanById(challanId) {
    const rows = await this.getAllChallans();
    return rows.find(c => c.Challan_ID === challanId) || null;
  }
  async getChallansByJobCard(jobCardId) {
    const rows = await this.getAllChallans();
    return rows.filter(c => c.Job_Card_ID === jobCardId);
  }

  async getCustomerPriceList(customerId) {
    const rows = await this.getTab('Customer_Price_List');
    if (!customerId) return rows;
    const target = String(customerId).trim().toLowerCase();
    return rows.filter(r => String(r.Customer_ID || '').trim().toLowerCase() === target);
  }

  async getEquipmentCategories() { return this.getTab('Equipment_Category_Master'); }

  // Atomic per-key sequence used for customer-facing document numbers (quotations, PIs,
  // invoices). $inc inside findOneAndUpdate is the only safe way to hand out gap-free numbers
  // here — computing "max existing + 1" from getTab() would race under concurrent requests and
  // could issue the same number twice.
  //
  // `seedIfNew` is the high-water mark to start a BRAND NEW counter from. It exists because a
  // counter key is derived from the admin-configurable prefix: edit the prefix and the old key is
  // abandoned, a fresh one starts at zero, and the next document re-issues a number that is already
  // on a customer's invoice. Seeding a new counter from the highest number already issued makes a
  // prefix change safe. The seed is applied via $setOnInsert, so it only ever affects creation and
  // two concurrent callers still cannot both take the same value.
  async getNextSequence(counterKey, { seedIfNew = 0 } = {}) {
    await this.connect();
    const Model = models['Counter_Master'];

    if (seedIfNew > 0) {
      await Model.updateOne(
        { Counter_Key: counterKey },
        { $setOnInsert: { Counter_Key: counterKey, Current_Value: seedIfNew } },
        { upsert: true }
      );
    }

    const result = await Model.findOneAndUpdate(
      { Counter_Key: counterKey },
      { $inc: { Current_Value: 1 } },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    delete this.cache['Counter_Master'];
    return result.Current_Value;
  }

  /**
   * Read-modify-write since updateRow only supports $set (no array-push primitive) — dedupes by
   * endpoint so re-subscribing the same device (e.g. after a SW update) doesn't create duplicates.
   *
   * A push endpoint identifies a BROWSER, not a person, so it must belong to exactly one staff row
   * at a time. It is detached from every other staff member first: two people sharing a workshop
   * phone otherwise leave the endpoint on both rows, and each then receives the other's alerts —
   * attendance, leave decisions and task assignments meant for someone else. Logout already tries
   * to unsubscribe, but it is best-effort and never runs when a browser is simply closed, so the
   * guarantee has to live here on the write that actually claims the device.
   */
  async addPushSubscription(staffId, subscription) {
    const staff = await this.getStaffById(staffId);
    if (!staff) return null;

    await this.detachPushEndpointFromOthers(subscription.endpoint, staffId);

    const existing = Array.isArray(staff.Push_Subscriptions) ? staff.Push_Subscriptions : [];
    const filtered = existing.filter(s => s.endpoint !== subscription.endpoint);
    filtered.push({ ...subscription, subscribedAt: new Date().toISOString() });
    return this.updateRow('Staff_Master', 'Staff_ID', staffId, { Push_Subscriptions: filtered });
  }

  /**
   * Strips one push endpoint from every staff row except `keepStaffId`, so a device can never be
   * registered to two people at once. Returns the Staff_IDs it was removed from — the caller logs
   * them, because a non-empty result means a shared device was just reassigned.
   */
  async detachPushEndpointFromOthers(endpoint, keepStaffId) {
    if (!endpoint) return [];
    const allStaff = await this.getAllStaff();
    const stripped = [];

    for (const s of allStaff) {
      if (s.Staff_ID === keepStaffId) continue;
      const subs = Array.isArray(s.Push_Subscriptions) ? s.Push_Subscriptions : [];
      if (!subs.some(x => x.endpoint === endpoint)) continue;
      await this.updateRow('Staff_Master', 'Staff_ID', s.Staff_ID, {
        Push_Subscriptions: subs.filter(x => x.endpoint !== endpoint)
      });
      stripped.push(s.Staff_ID);
    }
    return stripped;
  }

  async removePushSubscription(staffId, endpoint) {
    const staff = await this.getStaffById(staffId);
    if (!staff) return null;
    const existing = Array.isArray(staff.Push_Subscriptions) ? staff.Push_Subscriptions : [];
    const filtered = existing.filter(s => s.endpoint !== endpoint);
    return this.updateRow('Staff_Master', 'Staff_ID', staffId, { Push_Subscriptions: filtered });
  }
}

module.exports = new MongoService();
