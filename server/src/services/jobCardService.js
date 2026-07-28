const sheetsService = require('./sheetsService');
const inventoryService = require('./inventoryService');
const equipmentCategoryService = require('./equipmentCategoryService');
const quotationEngine = require('./quotationEngine');
const interactionLogger = require('./interactionLogger');

/**
 * jobCardService — the workshop side of the pipeline: equipment arrives, is inspected item by item,
 * is worked on over several days, and is then reconciled before a delivery challan can be raised.
 *
 * Two structural decisions drive this file:
 *
 * 1. Items are their own collection (Job_Card_Item), not an array on the header. updateRow() only
 *    supports $set, so incremental part-fitting against an array would be a read-modify-write; two
 *    technicians on two devices — or one offline queue draining after another's live write — would
 *    silently overwrite each other. One document per cylinder confines every write to one row.
 *
 * 2. Every write that a phone can originate is idempotent. Rows are keyed on a client-generated
 *    Job_Card_Item_ID and parts on a client-generated lineId, so replaying a queued action after a
 *    partial flush converges instead of duplicating work.
 */

const STATUS = {
  INWARD: 'Inward',
  IN_SERVICE: 'InService',
  SERVICE_COMPLETE: 'ServiceComplete',
  CHALLAN_DRAFTED: 'Challan_Drafted',
  CHALLAN_ISSUED: 'Challan_Issued',
  CLOSED: 'Closed'
};

const SERVICE_STATUS = {
  PENDING: 'Pending',
  IN_PROGRESS: 'InProgress',
  DONE: 'Done',
  REJECTED: 'Rejected'
};

const RECHECK = {
  FITTED: 'FITTED',
  CLIENT_REFUSED: 'CLIENT_REFUSED',
  NOT_REQUIRED: 'NOT_REQUIRED'
};

const CHECKPOINT_NOT_OK = 'NOT OK';

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function rand2() {
  return Math.floor(Math.random() * 100).toString().padStart(2, '0');
}

function newJobCardId() {
  return `JC${Date.now().toString().slice(-6)}${rand2()}`;
}

function newJobCardItemId() {
  return `JCI${Date.now().toString().slice(-6)}${rand2()}`;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Canonical capacity label: '6kg', '6 KG' and '6.0 Kg' all become '6 Kg'.
 *
 * Not optional. The capacity field is free text, so the same product reaches the challan under
 * several spellings; without this the grouping emits three lines where the paper challan has one,
 * which is the most likely real-world failure of the whole feature. Applied on write here and again
 * when grouping, so legacy rows normalise too.
 */
function normalizeCapacity(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^([\d.]+)\s*(kg|ltr|l|litre|liter)?/i);
  if (!m) return s;
  const unit = (m[2] || 'kg').toLowerCase();
  const label = unit.startsWith('l') ? 'Ltr' : 'Kg';
  return `${parseFloat(m[1])} ${label}`;
}

/**
 * "(8 ABC 6 Kg, 2 CO2 4.5 Kg)" from recomputeSummary's byType map, whose keys are "TYPE|Capacity".
 * Returns '' for an empty map so the caller's sentence still reads correctly without it.
 */
function describeByType(byType) {
  const parts = Object.entries(byType || {}).map(([key, count]) => {
    const [type, capacity] = key.split('|');
    return `${count} ${[type, capacity].filter(Boolean).join(' ')}`.trim();
  });
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * Snapshot of the party, frozen onto the card the same way quotations freeze theirs.
 *
 * `Contact` first: that is the field POST /api/customers actually writes (apiRoutes.js). The
 * Contact_Number/contact spellings are kept as fallbacks for rows imported under older shapes —
 * reading only those left every job card, and every challan built from one, with a blank number.
 */
function buildCustomerSnapshot(customer) {
  return {
    Customer_Name_Snapshot: customer?.Company_Name || customer?.companyName || customer?.Customer_Name || '',
    // Site address, not Billing_Address — a challan is a goods-movement document.
    Customer_Address_Snapshot: customer?.Address || customer?.address || '',
    Customer_Contact_Snapshot: customer?.Contact || customer?.Contact_Number || customer?.contact || '',
    // Carried so a challan raised from this card can be emailed without a second lookup. Challans
    // raised before this existed have it blank, which the dispatch route falls back from.
    Customer_Email_Snapshot: customer?.Email || customer?.email || '',
    Customer_GSTIN_Snapshot: customer?.GSTIN || customer?.gstin || ''
  };
}

// ─── LOOKUPS ───────────────────────────────────────────────────────────────────────────────────

/**
 * Last hydro-test date for a cylinder, from the customer's equipment register.
 *
 * Matched most-specific-first: a EUID or cylinder number identifies one physical body, whereas a
 * client asset tag can be reassigned. Returns source 'UNKNOWN' when nothing matches, which is the
 * signal for the UI to make the technician choose whether HP testing is due rather than defaulting.
 */
async function resolveLastHpTestDate(customerId, { euidNo, cylinderNo, serialNo, clientIdNo } = {}) {
  if (!customerId) return { date: '', source: 'UNKNOWN' };

  const rows = await sheetsService.getTab('Client_Equipment_Master');
  const target = norm(customerId);
  const items = rows
    .filter(r => norm(r.Customer_ID || r.customerId) === target)
    .flatMap(r => (Array.isArray(r.items) ? r.items : []));

  if (items.length === 0) return { date: '', source: 'UNKNOWN' };

  const probes = [
    ['euidNo', euidNo],
    ['cylinderNo', cylinderNo],
    ['serialNo', serialNo],
    ['clientIdNo', clientIdNo]
  ].filter(([, v]) => norm(v));

  for (const [field, value] of probes) {
    const hit = items.find(it => norm(it[field]) === norm(value));
    if (hit && (hit.hptDate || hit.hpTestDate)) {
      return { date: hit.hptDate || hit.hpTestDate, source: 'CLIENT_EQUIPMENT', matchedOn: field, equipment: hit };
    }
    if (hit) return { date: '', source: 'UNKNOWN', matchedOn: field, equipment: hit };
  }

  return { date: '', source: 'UNKNOWN' };
}

// ─── JOB CARD HEADER ───────────────────────────────────────────────────────────────────────────

async function createJobCard({ taskId, customerId, notes }, actor) {
  if (!taskId) throw new Error('taskId is required');

  const existing = await sheetsService.getJobCardByTask(taskId);
  if (existing) throw new Error(`Task ${taskId} already has job card ${existing.Job_Card_ID}`);

  const task = await sheetsService.getTaskById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const resolvedCustomerId = customerId || task.Customer_ID;
  const customers = await sheetsService.getAllCustomers();
  const customer = customers.find(c => norm(c.Customer_ID) === norm(resolvedCustomerId)) || null;

  const nowMs = Date.now();
  const card = {
    Job_Card_ID: newJobCardId(),
    Task_ID: taskId,
    Customer_ID: resolvedCustomerId || '',
    ...buildCustomerSnapshot(customer),
    Status: STATUS.INWARD,
    Inward_Date: istToday(),
    Inward_By: actor?.staffId || 'SYSTEM',
    Service_Started_At: '',
    Service_Completed_At: '',
    Completed_By: '',
    Item_Count: 0,
    Summary: { totalItems: 0, byType: {}, refillCount: 0, hpTestCount: 0 },
    Standby_Issued: [],
    Linked_Challan_IDs: [],
    Notes: notes || '',
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: istToday(),
    Created_At_Ms: nowMs,
    Updated_At: new Date().toISOString()
  };

  await sheetsService.insertRow('Job_Card_Master', card);
  // Denormalised onto the task so the staff dashboard can render Create-vs-Open from the task list
  // it already holds, with no extra fetch per card.
  await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, { Job_Card_ID: card.Job_Card_ID });

  return card;
}

async function getJobCardFull(jobCardId) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) return null;
  const items = await sheetsService.getJobCardItems(jobCardId);
  return { card, items };
}

async function getJobCardByTask(taskId) {
  const card = await sheetsService.getJobCardByTask(taskId);
  if (!card) return null;
  const items = await sheetsService.getJobCardItems(card.Job_Card_ID);
  return { card, items };
}

/**
 * Rebuilds the header's derived counts from the live item rows.
 *
 * Recomputed rather than incremented: offline replay and concurrent edits both make a running
 * counter drift, and at ~10 rows a card the recount is free.
 */
async function recomputeSummary(jobCardId) {
  const items = await sheetsService.getJobCardItems(jobCardId);
  const byType = {};
  let refillCount = 0;
  let hpTestCount = 0;

  for (const it of items) {
    if (it.Service_Status === SERVICE_STATUS.REJECTED) continue;
    const key = `${it.Equipment_Type || 'UNKNOWN'}|${normalizeCapacity(it.Capacity)}`;
    byType[key] = (byType[key] || 0) + 1;
    if (it.Refilling_Required) refillCount += 1;
    if (it.HP_Testing_Required) hpTestCount += 1;
  }

  const summary = { totalItems: items.length, byType, refillCount, hpTestCount };
  await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Summary: summary,
    Item_Count: items.length,
    Updated_At: new Date().toISOString()
  });
  return summary;
}

// ─── ITEMS ─────────────────────────────────────────────────────────────────────────────────────

/** Seeds every checkpoint for the row's category to OK, preserving anything already supplied. */
async function buildInwardCheckpoints(equipmentType, supplied) {
  const checkpoints = await equipmentCategoryService.getCheckpointsForCode(equipmentType);
  const out = {};
  for (const cp of checkpoints) {
    out[cp.id] = supplied?.[cp.id] || 'OK';
  }
  return out;
}

// Statutory hydro-test interval for portable extinguishers. A constant rather than a magic 3 so the
// rule is findable if the standard ever changes.
const HP_DUE_YEARS = 3;

/** Whole and fractional years between a stored date and today. Null when the date is unparseable. */
function yearsSince(dateStr) {
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return null;
  const years = (Date.now() - then.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years < 0 ? 0 : Math.round(years * 10) / 10;
}

async function buildItemRow(card, row, srNo, actor) {
  const equipmentType = String(row.Equipment_Type || row.equipmentType || 'ABC').trim().toUpperCase();

  // Only look the date up when the technician has not already typed one — a manual entry is a
  // deliberate override and must not be replaced by register data.
  let lastHpDate = row.Last_HP_Test_Date || '';
  let lastHpSource = lastHpDate ? 'MANUAL' : 'UNKNOWN';
  let known = null;
  if (!lastHpDate) {
    const resolved = await resolveLastHpTestDate(card.Customer_ID, {
      euidNo: row.EUID_No,
      cylinderNo: row.Cylinder_No,
      serialNo: row.Serial_No,
      clientIdNo: row.Client_ID_No
    });
    lastHpDate = resolved.date;
    lastHpSource = resolved.source;
    known = resolved.equipment || null;
  }

  // Hydro testing falls due every HP_DUE_YEARS. Flagged rather than enforced: the technician has the
  // cylinder in their hands and may know something the register does not, so this colours the row
  // instead of ticking HP_Testing_Required for them.
  const overdueYears = lastHpDate ? yearsSince(lastHpDate) : null;
  const hpOverdue = overdueYears !== null && overdueYears >= HP_DUE_YEARS;

  const nowMs = Date.now();
  return {
    Job_Card_Item_ID: row.Job_Card_Item_ID || newJobCardItemId(),
    Job_Card_ID: card.Job_Card_ID,
    Task_ID: card.Task_ID,
    Customer_ID: card.Customer_ID,
    Sr_No: Number(row.Sr_No) || srNo,

    Equipment_Type: equipmentType,
    Type_Description: row.Type_Description || '',
    // Capacity and manufacturing year fall back to the customer's register when the technician has
    // not typed them — the same cylinder was booked in before and the details have not changed.
    // Through normalizeCapacity either way, or "6kg" from the register and "6 KG" typed here would
    // split into two lines on the grouped challan.
    Capacity: normalizeCapacity(row.Capacity || known?.capacity || ''),
    EUID_No: String(row.EUID_No || '').trim(),
    Client_ID_No: String(row.Client_ID_No || '').trim(),
    Serial_No: String(row.Serial_No || '').trim(),
    Cylinder_No: String(row.Cylinder_No || '').trim(),
    Mfg_Year: String(row.Mfg_Year || known?.mfgYear || known?.manufacturingYear || '').trim(),

    Refilling_Required: Boolean(row.Refilling_Required),
    HP_Testing_Required: Boolean(row.HP_Testing_Required),
    Last_HP_Test_Date: lastHpDate,
    Last_HP_Test_Source: lastHpSource,
    HP_Test_Overdue: hpOverdue,
    HP_Test_Overdue_Years: overdueYears,

    Inward_Checkpoints: await buildInwardCheckpoints(equipmentType, row.Inward_Checkpoints),
    Inward_Notes: row.Inward_Notes || '',
    Empty_Weight: String(row.Empty_Weight || '').trim(),
    Full_Weight: String(row.Full_Weight || '').trim(),

    Parts_Fitted: Array.isArray(row.Parts_Fitted) ? row.Parts_Fitted : [],
    Service_Status: row.Service_Status || SERVICE_STATUS.PENDING,
    Service_Remarks: row.Service_Remarks || '',
    Serviced_By: '',
    Serviced_At: '',

    Recheck_Done: false,
    Recheck_Resolution: {},
    Recheck_Reason: {},
    Recheck_By: '',
    Recheck_At: '',

    Refilling_Date: row.Refilling_Date || '',
    HP_Test_Date: row.HP_Test_Date || '',

    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: istToday(),
    Created_At_Ms: nowMs,
    Updated_At: new Date().toISOString()
  };
}

async function addJobCardItems(jobCardId, rows, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('At least one item row is required');

  const existing = await sheetsService.getJobCardItems(jobCardId);
  let srNo = existing.length;

  const inserted = [];
  for (const row of rows) {
    srNo += 1;
    const item = await buildItemRow(card, row, srNo, actor);
    await sheetsService.insertRow('Job_Card_Item', item);
    inserted.push(item);
  }

  if (card.Status === STATUS.INWARD) {
    await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
      Status: STATUS.IN_SERVICE,
      Service_Started_At: card.Service_Started_At || new Date().toISOString()
    });
  }
  const summary = await recomputeSummary(jobCardId);

  // One entry for the whole batch, not one per cylinder: the offline queue drains these in a loop
  // and ten separate "1 cylinder received" rows would bury the timeline.
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.MATERIAL_RECEIVED,
    summary: `${inserted.length} Nos received${describeByType(summary.byType)} | Job Card ${jobCardId}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  return inserted;
}

const ITEM_EDITABLE_FIELDS = [
  'Equipment_Type', 'Type_Description', 'Capacity', 'EUID_No', 'Client_ID_No', 'Serial_No',
  'Cylinder_No', 'Mfg_Year', 'Refilling_Required', 'HP_Testing_Required', 'Last_HP_Test_Date',
  'Last_HP_Test_Source', 'Inward_Checkpoints', 'Inward_Notes', 'Empty_Weight', 'Full_Weight',
  'Service_Status', 'Service_Remarks', 'Refilling_Date', 'HP_Test_Date', 'Sr_No'
];

async function updateJobCardItem(itemId, patch, actor) {
  const item = await sheetsService.getJobCardItemById(itemId);
  if (!item) throw new Error(`Job card item ${itemId} not found`);

  const update = { Updated_At: new Date().toISOString() };
  for (const field of ITEM_EDITABLE_FIELDS) {
    if (patch?.[field] === undefined) continue;
    update[field] = field === 'Capacity' ? normalizeCapacity(patch[field]) : patch[field];
  }

  if (update.Service_Status === SERVICE_STATUS.DONE && !item.Serviced_At) {
    update.Serviced_By = actor?.staffId || 'SYSTEM';
    update.Serviced_At = new Date().toISOString();
  }

  const saved = await sheetsService.updateRow('Job_Card_Item', 'Job_Card_Item_ID', itemId, update);
  await recomputeSummary(item.Job_Card_ID);
  return saved;
}

/**
 * Insert-or-update for the offline queue. Rows created on a phone carry a client-generated
 * Job_Card_Item_ID, so a replayed action updates the row it created the first time rather than
 * inserting a second copy of the same cylinder.
 */
async function upsertJobCardItemOffline(payload, actor) {
  const itemId = payload?.Job_Card_Item_ID;
  if (itemId) {
    const existing = await sheetsService.getJobCardItemById(itemId);
    if (existing) return updateJobCardItem(itemId, payload, actor);
  }
  const [created] = await addJobCardItems(payload.Job_Card_ID, [payload], actor);
  return created;
}

async function deleteJobCardItem(itemId) {
  const item = await sheetsService.getJobCardItemById(itemId);
  if (!item) throw new Error(`Job card item ${itemId} not found`);
  const ok = await sheetsService.deleteRow('Job_Card_Item', 'Job_Card_Item_ID', itemId);
  await recomputeSummary(item.Job_Card_ID);
  return ok;
}

// ─── PARTS ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Merges parts into one cylinder's Parts_Fitted.
 *
 * Deduped on the client-generated lineId: without it a single flush retry fits every part twice and
 * the challan over-bills. Stock is consumed here rather than at invoice time because the pin
 * physically leaves the shelf now, and the job runs for several days before any invoice exists.
 *
 * A stock failure never blocks the fit — the part is already in the cylinder, so refusing to record
 * it would only put the ledger further out of step. Mirrors deductForInvoice's stance.
 */
async function addPartsToItem(itemId, parts, actor, { consumeStock = true, date } = {}) {
  const item = await sheetsService.getJobCardItemById(itemId);
  if (!item) throw new Error(`Job card item ${itemId} not found`);
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('At least one part is required');

  const existing = Array.isArray(item.Parts_Fitted) ? item.Parts_Fitted : [];
  const seen = new Set(existing.map(p => p.lineId).filter(Boolean));

  const added = [];
  for (const raw of parts) {
    const lineId = raw?.lineId;
    if (!lineId) throw new Error('Each part requires a client-generated lineId');
    if (seen.has(lineId)) continue;

    const part = {
      lineId,
      Item_ID: raw.Item_ID || '',
      Item_Name: raw.Item_Name || '',
      Qty: Number(raw.Qty) || 1,
      Unit: raw.Unit || 'Nos',
      source: raw.source === 'CHECKLIST' ? 'CHECKLIST' : 'EXTRA',
      checkpointId: raw.checkpointId || '',
      fittedBy: actor?.staffId || 'SYSTEM',
      fittedAt: new Date().toISOString(),
      Stock_Txn_ID: '',
      Inventory_Error: ''
    };

    // A part typed by name with no Item_ID used to leave stock untouched, yet the challan resolves
    // that same name against Item_Master and bills it — and convertChallanToInvoice deliberately
    // skips accessory deduction because "it already left the shelf at the job card". So the item was
    // charged and never deducted anywhere. Resolve it here, with the challan's own resolver, so both
    // sides agree. Only an EXACT/ALIAS hit is adopted: a FUZZY guess must not silently move stock.
    if (!part.Item_ID && part.Item_Name.trim()) {
      try {
        const challanService = require('./challanService');
        const match = challanService.resolveItemByName(
          await sheetsService.getAllItems(),
          part.Item_Name,
          item.Equipment_Type
        );
        if (match.itemId && (match.confidence === challanService.CONFIDENCE.EXACT || match.confidence === challanService.CONFIDENCE.ALIAS)) {
          part.Item_ID = match.itemId;
          part.Item_Name = match.itemName || part.Item_Name;
          part.Item_Resolved_By_Name = match.confidence;
        }
      } catch (e) {
        console.error(`Could not resolve part name "${part.Item_Name}" to an item:`, e.message);
      }
    }

    if (consumeStock && part.Item_ID) {
      try {
        const { transaction } = await inventoryService.recordUsage({
          itemId: part.Item_ID,
          qty: part.Qty,
          unit: part.Unit,
          clientId: item.Customer_ID,
          notes: `Job Card ${item.Job_Card_ID} — ${item.Cylinder_No || item.Serial_No || `Sr ${item.Sr_No}`}`,
          recordedBy: actor?.staffId || 'SYSTEM',
          // The technician's own date, not sync time: a Friday fit synced on Monday would
          // otherwise land in the wrong week of the consumption report.
          date: date || istToday()
        });
        part.Stock_Txn_ID = transaction.Transaction_ID;
      } catch (e) {
        console.error(`Stock usage failed for part ${part.Item_Name} on ${itemId}:`, e.message);
        part.Inventory_Error = e.message;
      }
    }

    seen.add(lineId);
    added.push(part);
  }

  // Nothing new after de-duplication — a replayed offline action. Returning here keeps the replay
  // from writing a second timeline entry for work that was already recorded.
  if (added.length === 0) return item;

  const saved = await sheetsService.updateRow('Job_Card_Item', 'Job_Card_Item_ID', itemId, {
    Parts_Fitted: [...existing, ...added],
    Service_Status: item.Service_Status === SERVICE_STATUS.PENDING
      ? SERVICE_STATUS.IN_PROGRESS
      : item.Service_Status,
    Updated_At: new Date().toISOString()
  });

  const label = item.Cylinder_No || item.Serial_No || item.EUID_No || `Sr ${item.Sr_No}`;
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.WORK_IN_PROGRESS,
    summary: `${added.map(p => `${p.Item_Name} ×${p.Qty}`).join(', ')} | ${label} | Job Card ${item.Job_Card_ID}`,
    taskId: item.Task_ID,
    customerId: item.Customer_ID,
    actor
  });

  return saved;
}

/** Removes a fitted part. The stock movement is deliberately NOT reversed — see below. */
async function removePartFromItem(itemId, lineId, actor) {
  const item = await sheetsService.getJobCardItemById(itemId);
  if (!item) throw new Error(`Job card item ${itemId} not found`);

  const existing = Array.isArray(item.Parts_Fitted) ? item.Parts_Fitted : [];
  const target = existing.find(p => p.lineId === lineId);
  if (!target) throw new Error(`Part ${lineId} not found on item ${itemId}`);

  // Stock_Transactions is append-only, so an un-fit is recorded as a compensating Adjustment
  // rather than by deleting the original Usage row. The ledger keeps both halves of the story.
  if (target.Stock_Txn_ID && target.Item_ID) {
    try {
      await inventoryService.recordAdjustment({
        itemId: target.Item_ID,
        qty: Math.abs(Number(target.Qty) || 0),
        unit: target.Unit,
        clientId: item.Customer_ID,
        notes: `Reversal — part removed from Job Card ${item.Job_Card_ID} (${target.Stock_Txn_ID})`,
        recordedBy: actor?.staffId || 'SYSTEM'
      });
    } catch (e) {
      console.error(`Stock reversal failed for part ${lineId}:`, e.message);
    }
  }

  return sheetsService.updateRow('Job_Card_Item', 'Job_Card_Item_ID', itemId, {
    Parts_Fitted: existing.filter(p => p.lineId !== lineId),
    Updated_At: new Date().toISOString()
  });
}

// ─── RECHECK GUARD ─────────────────────────────────────────────────────────────────────────────

/**
 * Every checkpoint still marked NOT OK at inward that carries no resolution.
 *
 * This is what stands between "we noticed the safety pin was missing" and "we handed the cylinder
 * back without one". generateChallanDraft refuses while this list is non-empty.
 */
async function getPendingRechecks(jobCardId) {
  const items = await sheetsService.getJobCardItems(jobCardId);
  const categories = await equipmentCategoryService.getCategories({ includeInactive: true });
  const labelsByCode = {};
  for (const cat of categories) {
    labelsByCode[String(cat.Code).toUpperCase()] = Object.fromEntries(
      (cat.Checkpoints || []).map(cp => [cp.id, cp.label])
    );
  }

  const pending = [];
  for (const it of items) {
    if (it.Service_Status === SERVICE_STATUS.REJECTED) continue;
    const labels = labelsByCode[String(it.Equipment_Type || '').toUpperCase()] || {};
    const checkpoints = it.Inward_Checkpoints || {};
    const resolution = it.Recheck_Resolution || {};

    for (const [id, value] of Object.entries(checkpoints)) {
      if (value !== CHECKPOINT_NOT_OK) continue;
      if (resolution[id]) continue;
      pending.push({
        Job_Card_Item_ID: it.Job_Card_Item_ID,
        srNo: it.Sr_No,
        equipmentLabel: it.Cylinder_No || it.Serial_No || it.Client_ID_No || `Sr ${it.Sr_No}`,
        equipmentType: it.Equipment_Type,
        capacity: it.Capacity,
        checkpointId: id,
        checkpointLabel: labels[id] || id,
        partAlreadyFitted: (it.Parts_Fitted || []).some(p => p.checkpointId === id)
      });
    }
  }
  return pending;
}

/**
 * Records what actually happened to each NOT OK checkpoint.
 *
 * CLIENT_REFUSED demands a written reason: it is the one outcome where the equipment goes back
 * with a known defect, so the business needs a record of who accepted that and why.
 *
 * `resolutions` is [{ Job_Card_Item_ID, checkpointId, resolution, reason }].
 */
async function applyRecheck(jobCardId, resolutions, actor) {
  if (!Array.isArray(resolutions)) throw new Error('resolutions must be an array');

  const byItem = new Map();
  for (const r of resolutions) {
    const itemId = r?.Job_Card_Item_ID;
    const checkpointId = r?.checkpointId;
    if (!itemId || !checkpointId) throw new Error('Each resolution needs Job_Card_Item_ID and checkpointId');
    if (!Object.values(RECHECK).includes(r.resolution)) {
      throw new Error(`Invalid resolution "${r.resolution}" for ${checkpointId}`);
    }
    if (r.resolution === RECHECK.CLIENT_REFUSED && !String(r.reason || '').trim()) {
      throw new Error(`A reason is required when a client refuses a replacement (${checkpointId})`);
    }
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push(r);
  }

  const updated = [];
  for (const [itemId, rows] of byItem) {
    const item = await sheetsService.getJobCardItemById(itemId);
    if (!item) throw new Error(`Job card item ${itemId} not found`);

    const resolution = { ...(item.Recheck_Resolution || {}) };
    const reason = { ...(item.Recheck_Reason || {}) };
    for (const r of rows) {
      resolution[r.checkpointId] = r.resolution;
      if (r.resolution === RECHECK.CLIENT_REFUSED) reason[r.checkpointId] = String(r.reason).trim();
    }

    const saved = await sheetsService.updateRow('Job_Card_Item', 'Job_Card_Item_ID', itemId, {
      Recheck_Resolution: resolution,
      Recheck_Reason: reason,
      Recheck_Done: true,
      Recheck_By: actor?.staffId || 'SYSTEM',
      Recheck_At: new Date().toISOString(),
      Updated_At: new Date().toISOString()
    });
    updated.push(saved);

    // A refusal is the one outcome that leaves the site with a known defect, so it goes in the
    // activity log where it survives independently of the job card row.
    for (const r of rows.filter(x => x.resolution === RECHECK.CLIENT_REFUSED)) {
      await sheetsService.insertRow('Activity_Logs', {
        Log_ID: `LOG${Date.now()}`,
        Task_ID: item.Task_ID,
        Staff_ID: actor?.staffId || 'SYSTEM',
        Action_Taken: `Client refused replacement of ${r.checkpointId} on ${item.Cylinder_No || `Sr ${item.Sr_No}`} (Job Card ${jobCardId})`,
        Lat_Long_Location: '0.0000, 0.0000',
        Remarks: String(r.reason).trim(),
        Timestamp: new Date().toISOString(),
        Image_URL: ''
      });
    }
  }

  // One entry for the whole recheck pass. The first item carries the task/customer ids — every
  // item on a card shares them, so any of them will do.
  const first = updated[0];
  if (first) {
    const refused = resolutions.filter(r => r.resolution === RECHECK.CLIENT_REFUSED).length;
    await interactionLogger.logEvent({
      tag: interactionLogger.EVENT_TAG.RECHECK_DONE,
      summary: `${resolutions.length} issue(s) resolved${refused ? `, ${refused} refused by client` : ''} | Job Card ${jobCardId}`,
      taskId: first.Task_ID,
      customerId: first.Customer_ID,
      actor
    });
  }

  return updated;
}

// ─── COMPLETION ────────────────────────────────────────────────────────────────────────────────

async function completeService(jobCardId, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);

  const pending = await getPendingRechecks(jobCardId);
  if (pending.length > 0) {
    const err = new Error(`${pending.length} inward issue(s) still need a resolution before this job card can be completed`);
    err.pendingRechecks = pending;
    err.statusCode = 409;
    throw err;
  }

  const saved = await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Status: STATUS.SERVICE_COMPLETE,
    Service_Completed_At: new Date().toISOString(),
    Completed_By: actor?.staffId || 'SYSTEM',
    Updated_At: new Date().toISOString()
  });

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.SERVICE_COMPLETE,
    summary: `${card.Item_Count || 0} items serviced | Job Card ${jobCardId}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  // Service is done and the goods are ready to go back — that is the Pickup/Delivery stage. Uses
  // the existing production stage rather than introducing a new one.
  if (card.Task_ID) {
    await quotationEngine.safeAdvanceTask(card.Task_ID, 'Pickup/Delivery', actor, `Job card ${jobCardId} service completed`);
  }

  return saved;
}

// ─── STANDBY (LOANER) UNITS ────────────────────────────────────────────────────────────────────

/**
 * Issues loaner extinguishers so the customer's site is never left unprotected while their own
 * equipment is on our bench.
 *
 * Each unit is tracked by its own EUID rather than as a count, because getting them all back is the
 * point — a count cannot tell you WHICH cylinder is still out.
 */
async function issueStandby(jobCardId, units, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);
  if (!Array.isArray(units) || units.length === 0) throw new Error('At least one standby unit is required');

  const existing = Array.isArray(card.Standby_Issued) ? card.Standby_Issued : [];
  const seen = new Set(existing.filter(u => !u.returned && !u.retained).map(u => norm(u.EUID_No)));

  const added = [];
  for (const u of units) {
    const euid = String(u?.EUID_No || '').trim();
    if (!euid) throw new Error('Each standby unit needs an EUID number');
    if (seen.has(norm(euid))) throw new Error(`Standby unit ${euid} is already out on this job card`);
    seen.add(norm(euid));
    added.push({
      standbyId: `SB${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
      EUID_No: euid,
      Equipment_Type: u.Equipment_Type || '',
      Capacity: u.Capacity ? normalizeCapacity(u.Capacity) : '',
      // The customer signs for the unit against this number, so one is always minted rather than
      // left blank. A number typed by the office wins — they may be copying a paper gate-pass book.
      gatePassNo: String(u.gatePassNo || '').trim()
        || `GP${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
      Item_ID: String(u.Item_ID || '').trim(),
      Stock_Txn_ID: '',
      Inventory_Error: '',
      issuedAt: new Date().toISOString(),
      issuedBy: actor?.staffId || 'SYSTEM',
      returned: false,
      returnedAt: '',
      returnedBy: '',
      // Set when a customer keeps the loaner rather than returning it — see retainStandby().
      retained: false,
      retentionReason: '',
      retainedAt: '',
      retainedBy: ''
    });
  }

  // Take the loaner off the shelf where it maps to a catalogue item. Best-effort on purpose: a
  // missing Item_ID must not stop a unit going out, or an incomplete catalogue would leave a
  // customer's site unprotected. Same reasoning as deductForInvoice's refusal to block.
  for (const unit of added) {
    if (!unit.Item_ID) continue;
    try {
      const { transaction } = await inventoryService.recordStandbyOut({
        itemId: unit.Item_ID,
        qty: 1,
        clientId: card.Customer_ID,
        notes: `Standby ${unit.EUID_No} issued on job card ${jobCardId} (gate pass ${unit.gatePassNo})`,
        recordedBy: actor?.staffId || 'SYSTEM'
      });
      unit.Stock_Txn_ID = transaction.Transaction_ID;
    } catch (e) {
      unit.Inventory_Error = e.message;
    }
  }

  const saved = await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Standby_Issued: [...existing, ...added],
    Updated_At: new Date().toISOString()
  });

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.STANDBY_ISSUED,
    summary: `${added.length} unit(s) issued (${added.map(u => u.EUID_No).join(', ')}) | Job Card ${jobCardId}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  return saved;
}

/**
 * Standby units still out on a job card. Empty means the loaner loop is closed.
 *
 * A RETAINED unit is excluded. It is still physically on the customer's site, but somebody has
 * recorded in writing that the customer is keeping it, so it is no longer an outstanding collection
 * blocking the delivery. Without this the POD gate is unpassable whenever a customer legitimately
 * keeps a loaner — the driver cannot collect it and cannot close the delivery either.
 */
async function getPendingStandby(jobCardId) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);
  return (card.Standby_Issued || []).filter(u => !u.returned && !u.retained);
}

/** Marks loaners as recovered. Matching is on EUID, case-insensitively. */
async function returnStandby(jobCardId, euids, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);

  const wanted = new Set((Array.isArray(euids) ? euids : []).map(norm));
  if (wanted.size === 0) throw new Error('No standby units specified');

  const now = new Date().toISOString();
  let matched = 0;
  const recovered = [];
  const updated = (card.Standby_Issued || []).map(u => {
    if (u.returned || u.retained || !wanted.has(norm(u.EUID_No))) return u;
    matched += 1;
    recovered.push(u);
    return { ...u, returned: true, returnedAt: now, returnedBy: actor?.staffId || 'SYSTEM' };
  });

  if (matched === 0) throw new Error('None of those EUID numbers are currently out on this job card');

  // Put each recovered loaner back on the shelf, mirroring the STANDBY_OUT written at issue. Only
  // units that actually moved stock on the way out are reversed, so the ledger stays balanced.
  for (const unit of recovered) {
    if (!unit.Item_ID || !unit.Stock_Txn_ID) continue;
    try {
      await inventoryService.recordStandbyIn({
        itemId: unit.Item_ID,
        qty: 1,
        clientId: card.Customer_ID,
        notes: `Standby ${unit.EUID_No} recovered from job card ${jobCardId}`,
        recordedBy: actor?.staffId || 'SYSTEM'
      });
    } catch (e) {
      console.error(`Standby return stock write failed for ${unit.EUID_No}:`, e.message);
    }
  }

  const saved = await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Standby_Issued: updated,
    Updated_At: new Date().toISOString()
  });

  const stillOut = updated.filter(u => !u.returned).length;
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.STANDBY_RETURNED,
    summary: `${matched} unit(s) collected${stillOut ? `, ${stillOut} still out` : ' — all recovered'} | Job Card ${jobCardId}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  return saved;
}

/**
 * Records that the customer is keeping a loaner rather than returning it.
 *
 * This is the one way past the proof-of-delivery standby block, so it is deliberately expensive to
 * use: a written reason is mandatory, and every retention leaves three separate traces — an
 * Activity_Logs row, a customer-timeline event, and a permanent stock movement. The unit has left
 * the company for good, so the STANDBY_OUT written at issue is never reversed and the loaner simply
 * stops being counted as available.
 *
 * The alternative was leaving the gate absolute, which sounds safer and is not: a driver who cannot
 * close a delivery will get it closed some other way, and the truth stops being recorded at all.
 */
async function retainStandby(jobCardId, euids, { reason } = {}, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);

  const text = String(reason || '').trim();
  if (!text) throw new Error('A reason is required when the customer keeps a standby unit');

  const wanted = new Set((Array.isArray(euids) ? euids : []).map(norm));
  if (wanted.size === 0) throw new Error('No standby units specified');

  const now = new Date().toISOString();
  let matched = 0;
  const kept = [];
  const updated = (card.Standby_Issued || []).map(u => {
    if (u.returned || u.retained || !wanted.has(norm(u.EUID_No))) return u;
    matched += 1;
    kept.push(u);
    return { ...u, retained: true, retentionReason: text, retainedAt: now, retainedBy: actor?.staffId || 'SYSTEM' };
  });

  if (matched === 0) throw new Error('None of those EUID numbers are currently out on this job card');

  const saved = await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Standby_Issued: updated,
    Updated_At: new Date().toISOString()
  });

  // Written to the activity log as well as the timeline so it survives independently of the job
  // card row — the same reasoning as a refused recheck.
  for (const unit of kept) {
    await sheetsService.insertRow('Activity_Logs', {
      Log_ID: `LOG${Date.now()}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
      Task_ID: card.Task_ID,
      Staff_ID: actor?.staffId || 'SYSTEM',
      Action_Taken: `Customer retained standby unit ${unit.EUID_No} (gate pass ${unit.gatePassNo || 'n/a'}, Job Card ${jobCardId})`,
      Lat_Long_Location: '0.0000, 0.0000',
      Remarks: text,
      Timestamp: now,
      Image_URL: ''
    });
  }

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.STANDBY_RETAINED,
    summary: `${matched} unit(s) kept by customer (${kept.map(u => u.EUID_No).join(', ')}) | ${text}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  return saved;
}

module.exports = {
  STATUS,
  SERVICE_STATUS,
  RECHECK,
  normalizeCapacity,
  istToday,
  createJobCard,
  getJobCardFull,
  getJobCardByTask,
  recomputeSummary,
  resolveLastHpTestDate,
  addJobCardItems,
  updateJobCardItem,
  upsertJobCardItemOffline,
  deleteJobCardItem,
  addPartsToItem,
  removePartFromItem,
  getPendingRechecks,
  applyRecheck,
  completeService,
  issueStandby,
  getPendingStandby,
  returnStandby,
  retainStandby
};
