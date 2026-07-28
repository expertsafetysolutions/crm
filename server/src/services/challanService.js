const sheetsService = require('./sheetsService');
const jobCardService = require('./jobCardService');
const quotationEngine = require('./quotationEngine');
const priceListService = require('./priceListService');
const inventoryService = require('./inventoryService');
const interactionLogger = require('./interactionLogger');

/**
 * challanService — turns a finished job card into a delivery challan.
 *
 * Rates are resolved and STORED on every line as the draft is built, so converting a challan to an
 * invoice is a copy rather than a fresh pricing run and the figures cannot drift in between.
 * Whether they are PRINTED is a separate question, answered by the admin's challan_config.show_price
 * setting — a delivery challan is a goods-movement document and the person signing for the goods at
 * the gate is usually not the person who should see the pricing.
 *
 * buildChallanLines itself stays price-free; pricing is applied as a distinct pass afterwards, so
 * the grouping logic can never accidentally depend on money.
 *
 * Deliberately separate from conversionService, whose documented contract is that conversions copy
 * already-computed money forward without re-pricing. Challan -> Invoice does the opposite, so it
 * would contradict that file's own premise to live there.
 */

const STATUS = { DRAFT: 'Draft', ISSUED: 'Issued', CANCELLED: 'Cancelled' };
const LINE_TYPE = { SERVICE: 'SERVICE', ACCESSORY: 'ACCESSORY', MANUAL: 'MANUAL' };
const CONFIDENCE = { EXACT: 'EXACT', ALIAS: 'ALIAS', FUZZY: 'FUZZY', NONE: 'NONE' };
const SERVICE = { REFILLING: 'Refilling', HP_TESTING: 'HP Testing' };

const { normalizeCapacity, istToday } = jobCardService;

function rand2() {
  return Math.floor(Math.random() * 100).toString().padStart(2, '0');
}

function newChallanId() {
  return `DC${Date.now().toString().slice(-6)}${rand2()}`;
}

function newLineId() {
  return `CL${Date.now().toString(36)}${Math.random().toString(36).substring(2, 7)}`;
}

function normalizeName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Comparison key that ignores punctuation and spacing, so "O-Ring", "O Ring" and "ORing" are one
 * thing. Item names are typed by hand across a thousand-row catalogue and the separators are not
 * consistent.
 */
function looseKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether an item name carries a specific capacity, e.g. '6 Kg' matching "…ABC 06 Kg".
 *
 * The unit is REQUIRED, which is the whole point: a bare digit search for "2 Kg" otherwise matches
 * the 2 in "Co2", and "Refilling CO2 2 Kg" silently resolves to the generic "Refilling of Co2"
 * instead of "Refilling of Fire Ext. Co2 02 Kg". Leading zeros are tolerated because the catalogue
 * writes both "6 Kg" and "06 Kg".
 */
function nameHasCapacity(name, capacity) {
  const num = parseFloat(capacity);
  if (!num) return false;
  const unit = /ltr|litre|liter/i.test(capacity) ? '(?:ltr|litre|liter|l)' : '(?:kg|kgs)';
  const digits = String(num).replace('.', '\\.');
  return new RegExp(`(?:^|[^\\d.])0*${digits}\\s*${unit}\\b`, 'i').test(String(name || ''));
}

/** True when a name mentions no capacity at all — a generic "HP Testing - ABC" style catalogue row. */
function nameHasAnyCapacity(name) {
  return /\d\s*(?:kg|kgs|ltr|litre|liter)\b/i.test(String(name || ''));
}

/**
 * Whether a service was actually carried out, as opposed to merely flagged on arrival.
 *
 * A cylinder booked in for hydro testing that never made it onto the rig must not appear on the
 * challan — the customer would be billed for a test that did not happen. An explicit service date
 * counts on its own, since a technician who filled the date in has done the work whatever the row
 * status says.
 */
function wasDone(item, kind) {
  if (kind === 'REFILL' && item.Refilling_Date) return true;
  if (kind === 'HPT' && item.HP_Test_Date) return true;
  return item.Service_Status === jobCardService.SERVICE_STATUS.DONE;
}

// ─── ITEM MASTER RESOLUTION ────────────────────────────────────────────────────────────────────

function pickItem(item, confidence) {
  return {
    itemId: item.Item_ID,
    itemName: item.Item_Name,
    hsnCode: item.HSN_Code || '',
    unit: item.Unit || 'Nos',
    confidence
  };
}

function activeItems(items) {
  return items.filter(i =>
    i.Active !== false &&
    !i.Is_Deleted &&
    i.Delete_Status !== 'Deleted' &&
    i.Delete_Status !== 'PendingApproval'
  );
}

/**
 * Maps a service group to a catalogue item, most trustworthy signal first.
 *
 * Tier 4 returns nothing rather than guessing. A wrong item silently attaches a wrong HSN code and
 * a wrong rate to a real tax invoice, whereas an unmapped line still delivers correctly — the
 * challan has no money on it — and simply blocks at invoice time, which is where a pricing problem
 * belongs.
 */
function resolveItemForGroup(items, group) {
  const active = activeItems(items);

  // TIER 1 — the explicit admin mapping. Authoritative by definition.
  const mapped = active.find(i => {
    const m = i.Job_Card_Mapping;
    return m &&
      m.serviceType === group.Service_Type &&
      String(m.equipmentType || '').toUpperCase() === String(group.Equipment_Type).toUpperCase() &&
      normalizeCapacity(m.capacity) === group.Capacity;
  });
  if (mapped) return pickItem(mapped, CONFIDENCE.EXACT);

  // TIER 2 — an alias the admin put on the item for exactly this purpose, e.g. REFILLING-ABC-6KG.
  const aliasKey = `${group.Service_Type}-${group.Equipment_Type}-${group.Capacity}`
    .toUpperCase().replace(/\s+/g, '');
  const byAlias = active.find(i =>
    (Array.isArray(i.Aliases) ? i.Aliases : [])
      .some(a => String(a).toUpperCase().replace(/\s+/g, '') === aliasKey)
  );
  if (byAlias) return pickItem(byAlias, CONFIDENCE.ALIAS);

  // TIER 3 — token match on the item name. Synonyms are grouped because the catalogue is
  // admin-written free text: "DCP Refill 6Kg" and "Refilling ABC 6 Kg" are the same product.
  const serviceTokens = group.Service_Type === SERVICE.REFILLING
    ? ['refill', 'refilling', 'recharge']
    : ['hp test', 'hp testing', 'hydro', 'hydraulic', 'pressure test'];
  const typeTokens = String(group.Equipment_Type).toUpperCase() === 'CO2'
    ? ['co2', 'carbon', 'dioxide']
    : ['abc', 'dcp', 'powder'];

  const matchesServiceAndType = (name) =>
    serviceTokens.some(t => name.includes(t)) && typeTokens.some(t => name.includes(t));

  const candidates = active.filter(i => matchesServiceAndType(String(i.Item_Name || '').toLowerCase()));

  // 3a — the item that names this exact capacity. Shortest wins, so "Refilling of Fire Ext. ABC
  // 06 Kg" beats a longer variant that merely mentions the same figure.
  const withCapacity = candidates
    .filter(i => nameHasCapacity(i.Item_Name, group.Capacity))
    .sort((a, b) => String(a.Item_Name).length - String(b.Item_Name).length);
  if (withCapacity.length > 0) return pickItem(withCapacity[0], CONFIDENCE.FUZZY);

  // 3b — a capacity-agnostic catalogue row such as "HP Testing - ABC", used only when no
  // capacity-specific item exists. Items that name a DIFFERENT capacity are excluded, so a request
  // for 6 Kg can never land on the 2 Kg row.
  const generic = candidates
    .filter(i => !nameHasAnyCapacity(i.Item_Name))
    .sort((a, b) => String(a.Item_Name).length - String(b.Item_Name).length);
  if (generic.length > 0) return pickItem(generic[0], CONFIDENCE.FUZZY);

  return { itemId: '', itemName: '', hsnCode: '', unit: 'Nos', confidence: CONFIDENCE.NONE };
}

/**
 * Resolves a part by name, punctuation-insensitively.
 *
 * Preference order within a partial match matters more than it looks: searching "Pressure Gauge"
 * against a thousand-row catalogue hits both "Pressure Gauge for ABC" and
 * "1/2\" SS 304 Syphun U Type Pipe for Pressure Gauge". A name that STARTS with the term is the
 * product itself; one that merely mentions it is usually a fitting for it. Shortest breaks ties.
 */
function resolveItemByName(items, name, equipmentTypeHint) {
  const target = looseKey(name);
  if (!target) return { itemId: '', itemName: name, hsnCode: '', unit: 'Nos', confidence: CONFIDENCE.NONE };

  const active = activeItems(items);
  const hint = looseKey(equipmentTypeHint);

  // The catalogue stocks the same accessory for several equipment families — a bare "Pressure Gauge"
  // search hits the CNG one as readily as the extinguisher one. When the caller knows which family
  // the part is going into, items naming it sort first; length breaks the remaining ties.
  const rank = (a, b) => {
    if (hint) {
      const aHit = looseKey(a.Item_Name).includes(hint) ? 0 : 1;
      const bHit = looseKey(b.Item_Name).includes(hint) ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
    }
    return String(a.Item_Name).length - String(b.Item_Name).length;
  };

  const exact = active.filter(i => looseKey(i.Item_Name) === target).sort(rank);
  if (exact.length > 0) return pickItem(exact[0], CONFIDENCE.EXACT);

  const byAlias = active.find(i =>
    (Array.isArray(i.Aliases) ? i.Aliases : []).some(a => looseKey(a) === target)
  );
  if (byAlias) return pickItem(byAlias, CONFIDENCE.ALIAS);

  const startsWith = active.filter(i => looseKey(i.Item_Name).startsWith(target)).sort(rank);
  if (startsWith.length > 0) return pickItem(startsWith[0], CONFIDENCE.FUZZY);

  const contains = active.filter(i => looseKey(i.Item_Name).includes(target)).sort(rank);
  if (contains.length > 0) return pickItem(contains[0], CONFIDENCE.FUZZY);

  return { itemId: '', itemName: name, hsnCode: '', unit: 'Nos', confidence: CONFIDENCE.NONE };
}

// ─── GROUPING ──────────────────────────────────────────────────────────────────────────────────

const SERVICE_ORDER = { [SERVICE.REFILLING]: 0, [SERVICE.HP_TESTING]: 1 };

function describeService(group) {
  return `${group.Service_Type} — ${group.Equipment_Type} ${group.Capacity}`.trim();
}

/**
 * Turns N job card rows into the grouped lines a customer actually reads.
 *
 * Services group by Service x Equipment_Type x Capacity: the delivery note says
 * "Refilling ABC 6 Kg — 5 Nos", not five cylinder serial numbers. Accessories do NOT fold into
 * those lines; they aggregate across the whole job by item, because a safety pin fitted to an ABC
 * and one fitted to a CO2 are the same product coming off the same shelf.
 *
 * One cylinder can legitimately produce two service lines — a body can be both refilled and
 * hydro-tested, and they are two separately priced jobs.
 */
function buildChallanLines(jobCardItems, itemMaster) {
  const serviceGroups = new Map();
  const accessoryTotals = new Map();

  for (const it of jobCardItems) {
    if (it.Service_Status === jobCardService.SERVICE_STATUS.REJECTED) continue;

    const capacity = normalizeCapacity(it.Capacity);
    const type = String(it.Equipment_Type || 'ABC').toUpperCase();

    const services = [];
    if (it.Refilling_Required && wasDone(it, 'REFILL')) services.push(SERVICE.REFILLING);
    if (it.HP_Testing_Required && wasDone(it, 'HPT')) services.push(SERVICE.HP_TESTING);

    for (const svc of services) {
      const key = `${svc}|${type}|${capacity}`;
      if (!serviceGroups.has(key)) {
        serviceGroups.set(key, {
          Group_Key: key,
          Line_Type: LINE_TYPE.SERVICE,
          Service_Type: svc,
          Equipment_Type: type,
          Capacity: capacity,
          Qty: 0,
          Unit: 'Nos',
          Source_Item_IDs: [],
          UID_Numbers: []
        });
      }
      const g = serviceGroups.get(key);
      g.Qty += 1;
      g.Source_Item_IDs.push(it.Job_Card_Item_ID);
      // Carried for the HP test certificate, which is a per-cylinder legal record and needs the
      // identity of every body it covers.
      if (svc === SERVICE.HP_TESTING && it.EUID_No) g.UID_Numbers.push(it.EUID_No);
    }

    for (const p of (it.Parts_Fitted || [])) {
      const key = p.Item_ID || `NAME:${normalizeName(p.Item_Name)}`;
      if (!accessoryTotals.has(key)) {
        accessoryTotals.set(key, {
          Group_Key: '',
          Line_Type: LINE_TYPE.ACCESSORY,
          Service_Type: '',
          Equipment_Type: '',
          Capacity: '',
          Item_ID: p.Item_ID || '',
          // Trimmed: an unmapped part keeps whatever the technician typed, and stray whitespace
          // would otherwise print on the customer's challan exactly as entered.
          Item_Name: String(p.Item_Name || '').trim(),
          // Which family the part went into, so an unmapped name resolves to the extinguisher
          // variant rather than, say, the CNG one.
          _typeHint: type,
          Qty: 0,
          Unit: p.Unit || 'Nos',
          Source_Item_IDs: [],
          UID_Numbers: []
        });
      }
      const a = accessoryTotals.get(key);
      a.Qty += Number(p.Qty) || 1;
      a.Source_Item_IDs.push(it.Job_Card_Item_ID);
    }
  }

  const serviceLines = [...serviceGroups.values()].map(g => {
    const match = resolveItemForGroup(itemMaster, g);
    return {
      ...g,
      lineId: newLineId(),
      Item_ID: match.itemId,
      Item_Name: match.itemName || describeService(g),
      Description: describeService(g),
      HSN_Code: match.hsnCode,
      Unit: match.unit || 'Nos',
      Item_Match_Confidence: match.confidence
    };
  });

  const accessoryLines = [...accessoryTotals.values()].map(entry => {
    const { _typeHint, ...a } = entry;
    const match = a.Item_ID
      ? (() => {
          const found = activeItems(itemMaster).find(i => i.Item_ID === a.Item_ID);
          return found ? pickItem(found, CONFIDENCE.EXACT)
            : { itemId: a.Item_ID, itemName: a.Item_Name, hsnCode: '', unit: a.Unit, confidence: CONFIDENCE.EXACT };
        })()
      : resolveItemByName(itemMaster, a.Item_Name, _typeHint);
    return {
      ...a,
      lineId: newLineId(),
      Item_ID: match.itemId,
      Item_Name: match.itemName || a.Item_Name,
      Description: match.itemName || a.Item_Name,
      HSN_Code: match.hsnCode,
      Unit: match.unit || a.Unit,
      Item_Match_Confidence: match.confidence
    };
  });

  // Refilling before HP testing, ABC before CO2, then ascending capacity — the order the challan
  // is written by hand today, so the printed document reads the way the office expects.
  serviceLines.sort((a, b) =>
    (SERVICE_ORDER[a.Service_Type] ?? 9) - (SERVICE_ORDER[b.Service_Type] ?? 9) ||
    a.Equipment_Type.localeCompare(b.Equipment_Type) ||
    (parseFloat(a.Capacity) || 0) - (parseFloat(b.Capacity) || 0)
  );
  accessoryLines.sort((a, b) => String(a.Item_Name).localeCompare(String(b.Item_Name)));

  return [...serviceLines, ...accessoryLines];
}

// ─── DRAFT / ISSUE ─────────────────────────────────────────────────────────────────────────────

function totalQty(lines) {
  return lines.reduce((sum, l) => sum + (Number(l.Qty) || 0), 0);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Attaches the rate we would charge this customer to every line, plus where it came from.
 *
 * Run as a separate pass over already-grouped lines so the grouping never depends on pricing. A
 * line with no rate on record keeps Rate 0 and source NONE rather than being dropped — the goods
 * still ship, and the gap surfaces at invoice time where a pricing problem belongs.
 *
 * Preserves any rate a human has already typed on the draft: regenerating from the bench must not
 * discard a correction someone made deliberately.
 */
async function priceChallanLines(customerId, lines, previousLines = []) {
  const previousByKey = new Map();
  for (const p of previousLines) {
    if (p.Rate_Touched) previousByKey.set(p.Group_Key || `NAME:${normalizeName(p.Item_Name)}`, p);
  }

  const resolved = await priceListService.resolveRates(
    customerId,
    lines.map(l => l.Item_ID).filter(Boolean)
  );

  return lines.map(line => {
    const key = line.Group_Key || `NAME:${normalizeName(line.Item_Name)}`;
    const kept = previousByKey.get(key);
    if (kept) {
      const rate = Number(kept.Rate) || 0;
      return { ...line, Rate: rate, Rate_Source: kept.Rate_Source || 'MANUAL', Rate_Source_Label: kept.Rate_Source_Label || 'Entered by staff', Rate_Touched: true, Amount: round2(rate * line.Qty) };
    }

    const match = line.Item_ID ? resolved[line.Item_ID] : null;
    const rate = match ? Number(match.rate) || 0 : 0;
    return {
      ...line,
      Rate: rate,
      Rate_Source: match ? match.source : priceListService.RATE_SOURCE.NONE,
      Rate_Source_Label: match ? match.sourceLabel : 'No rate on record — please enter',
      Rate_Touched: false,
      Amount: round2(rate * line.Qty)
    };
  });
}

function totalAmount(lines) {
  return round2(lines.reduce((sum, l) => sum + (Number(l.Amount) || 0), 0));
}

/**
 * Builds (or rebuilds) the draft from the job card's current state.
 *
 * Pass itemIds to raise a partial challan when only some of the equipment is ready to go back.
 * Regenerating a draft discards manual edits by design — it is a "recompute from the bench" action,
 * and an issued challan is refused outright since it has already left the building.
 */
async function generateChallanDraft(jobCardId, { itemIds, challanDate } = {}, actor) {
  const card = await sheetsService.getJobCardById(jobCardId);
  if (!card) throw new Error(`Job card ${jobCardId} not found`);

  const pending = await jobCardService.getPendingRechecks(jobCardId);
  if (pending.length > 0) {
    const err = new Error(
      `${pending.length} item(s) flagged NOT OK at inward still need a resolution before a challan can be raised`
    );
    err.pendingRechecks = pending;
    err.statusCode = 409;
    throw err;
  }

  let items = await sheetsService.getJobCardItems(jobCardId);
  const isPartial = Array.isArray(itemIds) && itemIds.length > 0;
  if (isPartial) {
    const wanted = new Set(itemIds);
    items = items.filter(i => wanted.has(i.Job_Card_Item_ID));
    if (items.length === 0) throw new Error('None of the selected items belong to this job card');
  }

  const itemMaster = await sheetsService.getAllItems();
  const grouped = buildChallanLines(items, itemMaster);
  if (grouped.length === 0) {
    throw new Error('Nothing to deliver yet — no completed service or fitted parts on this job card');
  }

  const existingDrafts = (await sheetsService.getChallansByJobCard(jobCardId))
    .filter(c => c.Status === STATUS.DRAFT);

  // Rates are attached now and stored, whether or not this challan will print them.
  const lines = await priceChallanLines(card.Customer_ID, grouped, existingDrafts[0]?.Line_Items || []);

  const payload = {
    Job_Card_ID: jobCardId,
    Task_ID: card.Task_ID,
    Customer_ID: card.Customer_ID,
    Customer_Name_Snapshot: card.Customer_Name_Snapshot || '',
    Customer_Address_Snapshot: card.Customer_Address_Snapshot || '',
    Customer_Contact_Snapshot: card.Customer_Contact_Snapshot || '',
    Customer_Email_Snapshot: card.Customer_Email_Snapshot || '',
    Customer_GSTIN_Snapshot: card.Customer_GSTIN_Snapshot || '',
    Is_Partial: isPartial,
    Challan_Date: challanDate || istToday(),
    Line_Items: lines,
    Total_Qty: totalQty(lines),
    Total_Amount: totalAmount(lines),
    Item_Count: lines.length,
    Updated_At: new Date().toISOString()
  };

  // Regenerating replaces the open draft rather than accumulating one per attempt.
  if (existingDrafts.length > 0) {
    const target = existingDrafts[0];
    return sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', target.Challan_ID, payload);
  }

  const challan = {
    Challan_ID: newChallanId(),
    // Deliberately blank. The office writes challan numbers by hand and the app must match that
    // book exactly, so a number is only ever typed by a human at issue time.
    Challan_No: '',
    Challan_No_Suggested: await suggestNextChallanNo(),
    Status: STATUS.DRAFT,
    ...payload,
    POD: null,
    Issued_By: '',
    Issued_At: '',
    Linked_Invoice_ID: '',
    Linked_Certificate_Guids: [],
    Duplicate_Warning_Ack: false,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: istToday(),
    Created_At_Ms: Date.now()
  };

  await sheetsService.insertRow('Delivery_Challan_Master', challan);
  await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', jobCardId, {
    Status: jobCardService.STATUS.CHALLAN_DRAFTED,
    Linked_Challan_IDs: [...(card.Linked_Challan_IDs || []), challan.Challan_ID],
    Updated_At: new Date().toISOString()
  });

  // Only a brand-new draft is logged. Regenerating replaces the open draft in the branch above and
  // is a "recompute from the bench" action, not a business event worth a timeline row each time.
  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.CHALLAN_GENERATED,
    summary: `${lines.length} line(s), ${payload.Total_Qty} Nos${isPartial ? ' (partial)' : ''} | Job Card ${jobCardId}`,
    taskId: card.Task_ID,
    customerId: card.Customer_ID,
    actor
  });

  return challan;
}

/**
 * A non-binding hint at what the next number probably is, from the numeric tail of the numbers
 * already issued. Shown as placeholder text only — it is never written to the document, because the
 * paper book is the authority and guessing ahead of it would create exactly the mismatch this
 * design avoids.
 */
async function suggestNextChallanNo() {
  const challans = await sheetsService.getAllChallans();
  let max = 0;
  let template = '';
  for (const c of challans) {
    const no = String(c.Challan_No || '').trim();
    if (!no) continue;
    const tail = no.match(/(\d+)\s*$/);
    if (!tail) continue;
    const value = parseInt(tail[1], 10);
    if (value > max) {
      max = value;
      template = no;
    }
  }
  if (!template) return '';
  const tail = template.match(/(\d+)\s*$/)[1];
  return template.replace(/(\d+)\s*$/, String(max + 1).padStart(tail.length, '0'));
}

const DRAFT_EDITABLE = ['Challan_Date', 'Notes', 'Vehicle_No', 'Received_By_Name'];

async function updateChallanDraft(challanId, patch, actor) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);
  if (challan.Status !== STATUS.DRAFT) {
    throw new Error(`Challan ${challan.Challan_No || challanId} has already been issued and can no longer be edited`);
  }

  const update = { Updated_At: new Date().toISOString(), Updated_By: actor?.staffId || 'SYSTEM' };
  for (const field of DRAFT_EDITABLE) {
    if (patch?.[field] !== undefined) update[field] = patch[field];
  }

  if (Array.isArray(patch?.Line_Items)) {
    const previous = Array.isArray(challan.Line_Items) ? challan.Line_Items : [];

    const lines = patch.Line_Items.map(l => {
      const before = previous.find(p => p.lineId === l.lineId);
      const rate = Number(l.Rate) || 0;
      // A rate that differs from what we resolved is a human decision, so it is marked touched and
      // survives the next regenerate. Rates arriving unchanged keep their original provenance.
      const touched = Boolean(l.Rate_Touched) || (before ? rate !== (Number(before.Rate) || 0) : rate > 0);
      const qty = Number(l.Qty) || 0;

      return {
        lineId: l.lineId || newLineId(),
        Group_Key: l.Group_Key || '',
        Line_Type: l.Line_Type === LINE_TYPE.MANUAL ? LINE_TYPE.MANUAL : (l.Line_Type || LINE_TYPE.MANUAL),
        Service_Type: l.Service_Type || '',
        Equipment_Type: l.Equipment_Type || '',
        Capacity: l.Capacity ? normalizeCapacity(l.Capacity) : '',
        Item_ID: l.Item_ID || '',
        Item_Name: l.Item_Name || '',
        Description: l.Description || l.Item_Name || '',
        HSN_Code: l.HSN_Code || '',
        Qty: qty,
        Unit: l.Unit || 'Nos',
        Rate: rate,
        Rate_Source: touched && !l.Rate_Source ? 'MANUAL' : (l.Rate_Source || before?.Rate_Source || 'NONE'),
        Rate_Source_Label: touched && !l.Rate_Source ? 'Entered by staff' : (l.Rate_Source_Label || before?.Rate_Source_Label || ''),
        Rate_Touched: touched,
        Amount: round2(rate * qty),
        Item_Match_Confidence: l.Item_Match_Confidence || CONFIDENCE.NONE,
        Source_Item_IDs: Array.isArray(l.Source_Item_IDs) ? l.Source_Item_IDs : [],
        UID_Numbers: Array.isArray(l.UID_Numbers) ? l.UID_Numbers : []
      };
    }).filter(l => l.Qty > 0 && l.Item_Name);

    update.Line_Items = lines;
    update.Total_Qty = totalQty(lines);
    update.Total_Amount = totalAmount(lines);
    update.Item_Count = lines.length;
  }

  return sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', challanId, update);
}

/**
 * Draft -> Issued. The challan number is typed by a human here and is required.
 *
 * A number already in use raises a warning rather than a rejection: the paper book is the authority
 * and there are legitimate reasons for a repeat (a cancelled book page, a reprint), so the decision
 * belongs to the person holding it. The warning has to be acknowledged explicitly, though, so it
 * cannot be issued by accident.
 */
async function issueChallan(challanId, { challanNo, challanDate, acknowledgeDuplicate, acknowledgeStandby } = {}, actor) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);
  if (challan.Status === STATUS.ISSUED) {
    throw new Error(`Challan ${challan.Challan_No} has already been issued`);
  }

  const number = String(challanNo || '').trim();
  if (!number) throw new Error('A challan number is required — enter the number from your challan book');

  // Warn about outstanding loaners here, in the office, rather than only at proof of delivery — by
  // then the van is at the customer's gate and the collection is somebody else's problem. This one
  // is advisory (acknowledgeable) because the driver will often collect the unit on arrival; the
  // POD gate stays absolute. Advisory here, hard there.
  if (challan.Job_Card_ID && !acknowledgeStandby) {
    const pending = await jobCardService.getPendingStandby(challan.Job_Card_ID);
    if (pending.length > 0) {
      const err = new Error(`${pending.length} standby unit(s) are still with the customer — collect them on this trip or acknowledge to continue`);
      err.pendingStandby = pending;
      err.statusCode = 409;
      throw err;
    }
  }

  const duplicate = (await sheetsService.getAllChallans()).find(c =>
    c.Challan_ID !== challanId &&
    String(c.Challan_No || '').trim().toLowerCase() === number.toLowerCase()
  );
  if (duplicate && !acknowledgeDuplicate) {
    const err = new Error(`Challan number ${number} is already used by ${duplicate.Customer_Name_Snapshot || duplicate.Challan_ID}`);
    err.duplicateOf = { Challan_ID: duplicate.Challan_ID, Challan_Date: duplicate.Challan_Date, Customer: duplicate.Customer_Name_Snapshot };
    err.statusCode = 409;
    throw err;
  }

  const issued = await sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', challanId, {
    Challan_No: number,
    Challan_Date: challanDate || challan.Challan_Date || istToday(),
    Status: STATUS.ISSUED,
    Issued_By: actor?.staffId || 'SYSTEM',
    Issued_At: new Date().toISOString(),
    Duplicate_Warning_Ack: Boolean(duplicate),
    Updated_At: new Date().toISOString()
  });

  await sheetsService.updateRow('Job_Card_Master', 'Job_Card_ID', challan.Job_Card_ID, {
    Status: jobCardService.STATUS.CHALLAN_ISSUED,
    Updated_At: new Date().toISOString()
  });
  if (challan.Task_ID) {
    await sheetsService.updateRow('Task_Master', 'Task_ID', challan.Task_ID, { Challan_ID: challanId });
    await quotationEngine.safeAdvanceTask(challan.Task_ID, 'Invoice', actor, `Delivery challan ${number} issued`);
  }

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.CHALLAN_ISSUED,
    summary: `${number} | ${challan.Total_Qty} Nos${duplicate ? ' | duplicate number acknowledged' : ''}`,
    taskId: challan.Task_ID,
    customerId: challan.Customer_ID,
    actor
  });

  return issued;
}

/** Certificate quantities are written "5 Nos." — matches formatQtyNos() on the certificate page. */
function formatQtyNos(value) {
  const str = String(value ?? '').trim();
  if (!str) return '1 Nos.';
  return /nos\.?$/i.test(str) ? str : `${str} Nos.`;
}

function addYears(dateStr, years) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setFullYear(d.getFullYear() + years);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** Credit days for a payment term id; 0 (due immediately) when unset or unknown. */
function resolveTermDays(paymentTermsId, settings) {
  const term = (settings.payment_terms || []).find(t => t.id === paymentTermsId);
  return Number(term?.days) || 0;
}

/**
 * Builds the certificate draft for one challan and one certificate type.
 *
 * Only the matching service lines are carried across — accessories and manual additions are
 * excluded, because a safety pin is not something anyone certifies.
 *
 * HP Testing splits one row per cylinder while Refilling does not. That asymmetry is deliberate: an
 * HP test certificate is a per-cylinder legal record and the UID is what makes it verifiable, so
 * five bodies crammed into one row with five numbers in a cell is a worse document than five rows.
 * A refill has no equivalent per-cylinder identity requirement.
 *
 * The certificate NUMBER is deliberately absent from this payload. The certificate page owns its
 * own sequence, and supplying one here would fight that logic.
 */
async function buildCertificatePrefill(challanId, formatType) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);

  const type = String(formatType || SERVICE.REFILLING).trim();
  const isHpTesting = /hp\s*test/i.test(type);
  const wanted = isHpTesting ? SERVICE.HP_TESTING : SERVICE.REFILLING;

  const lines = (challan.Line_Items || []).filter(
    l => l.Line_Type === LINE_TYPE.SERVICE && l.Service_Type === wanted
  );

  const validityYears = isHpTesting ? 3 : 1;
  const serviceDate = challan.Challan_Date || istToday();

  const itemsList = [];
  for (const line of lines) {
    const nextDate = addYears(serviceDate, validityYears);
    const common = {
      itemName: line.Item_Name || line.Description,
      capacity: line.Capacity || '',
      refillingDate: serviceDate,
      nextDate,
      customValues: {}
    };

    if (isHpTesting && line.UID_Numbers?.length > 0) {
      line.UID_Numbers.forEach(uid => {
        itemsList.push({ ...common, id: `item-${itemsList.length}`, srNo: itemsList.length + 1, qty: '1 Nos.', identificationNo: uid });
      });
    } else {
      itemsList.push({ ...common, id: `item-${itemsList.length}`, srNo: itemsList.length + 1, qty: formatQtyNos(line.Qty), identificationNo: '' });
    }
  }

  const settings = await sheetsService.getDocumentSettings('DEFAULT');
  // Per-type toggle: the challan reference is the customer's cross-reference back to the delivery,
  // so it defaults on for the two challan-derived types and off for everything else.
  const configured = settings?.certificate_types?.[type]?.showChallanRef;
  const showChallanRef = configured !== undefined
    ? Boolean(configured)
    : [SERVICE.REFILLING, SERVICE.HP_TESTING].includes(wanted);

  return {
    formatType: type,
    customerId: challan.Customer_ID,
    customerName: challan.Customer_Name_Snapshot || '',
    address: challan.Customer_Address_Snapshot || '',
    gstin: challan.Customer_GSTIN_Snapshot || '',
    contact: challan.Customer_Contact_Snapshot || '',
    challanDate: serviceDate,
    issueDate: serviceDate,
    validUntil: itemsList.reduce((max, i) => (i.nextDate > max ? i.nextDate : max), ''),
    itemsList,
    Source_Challan_ID: challan.Challan_ID,
    Source_Challan_No: challan.Challan_No || '',
    Show_Challan_Ref: showChallanRef,
    lineCount: lines.length
  };
}

/**
 * Challan -> Sales Invoice. This is where money becomes real.
 *
 * Unlike the quotation pipeline's conversions — which copy already-agreed figures forward verbatim
 * — this one PRICES for the first time: the challan carries rates but no tax, because none had been
 * agreed when the goods went out. So the GST engine runs here, fresh, against the customer's
 * current GSTIN.
 *
 * Stock is the subtle part. Accessories were already consumed off the shelf when the technician
 * fitted them, and service lines are labour with nothing to deduct — so this deliberately does NOT
 * call inventoryService.deductForInvoice(), which would take every accessory out of stock a second
 * time. Only lines a human typed onto the challan afterwards are deducted here.
 */
async function convertChallanToInvoice(challanId, { lineOverrides, documentDiscountPct, paymentTermsId } = {}, actor) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);
  if (challan.Status !== STATUS.ISSUED) {
    throw new Error('Only an issued challan can be invoiced');
  }
  if (challan.Linked_Invoice_ID) {
    throw new Error(`Challan ${challan.Challan_No} has already been invoiced (${challan.Linked_Invoice_ID})`);
  }

  const overrides = new Map((lineOverrides || []).map(o => [o.lineId, o]));
  const priced = (challan.Line_Items || []).map(l => {
    const o = overrides.get(l.lineId) || {};
    return { ...l, Rate: o.Rate !== undefined ? Number(o.Rate) || 0 : Number(l.Rate) || 0 };
  });

  const unpriced = priced.filter(l => !(Number(l.Rate) > 0));
  if (unpriced.length > 0) {
    const err = new Error(`${unpriced.length} line(s) still have no rate — an invoice cannot be raised until every line is priced`);
    err.unpricedLines = unpriced.map(l => ({ lineId: l.lineId, Item_Name: l.Item_Name }));
    err.statusCode = 409;
    throw err;
  }

  const settings = await quotationEngine.getSettings();
  const gstUtils = require('../utils/gstUtils');
  const customers = await sheetsService.getAllCustomers();
  const customer = customers.find(c => String(c.Customer_ID || '').trim().toLowerCase()
    === String(challan.Customer_ID || '').trim().toLowerCase()) || {};

  const sellerState = settings.seller_profile?.state_code || '';
  const buyerGstin = customer.GSTIN || challan.Customer_GSTIN_Snapshot || '';
  const buyerState = gstUtils.extractStateCode(buyerGstin) || sellerState;
  const { gstType } = gstUtils.determineGstType(sellerState, buyerState, customer.Customer_Type);

  const defaultGst = Number(settings.defaults?.default_gst_rate) || 18;
  const itemMaster = await sheetsService.getAllItems();
  const gstByItem = {};
  itemMaster.forEach(i => { gstByItem[i.Item_ID] = Number(i.Default_GST_Rate); });

  const totals = gstUtils.computeDocumentTotals({
    lineItems: priced.map(l => ({
      ...l,
      GST_Rate: Number(l.GST_Rate) || gstByItem[l.Item_ID] || defaultGst,
      Discount_Pct: 0,
      Discount_Amt: 0
    })),
    gstType,
    documentDiscountPct: Number(documentDiscountPct) || 0
  });

  const nowMs = Date.now();
  const invoiceId = `SINV${nowMs.toString().slice(-6)}${rand2()}`;
  const invoiceNo = await quotationEngine.nextDocumentNumber(
    settings.defaults.invoice_no_prefix,
    settings.defaults.number_reset,
    { existing: await sheetsService.getAllSalesInvoices(), field: 'Invoice_No' }
  );
  const todayStr = istToday();

  // Kept so the invoice editor can still show which rates were auto-filled after a reload.
  const rateSources = {};
  priced.forEach(l => {
    if (!l.Item_ID) return;
    rateSources[l.Item_ID] = {
      source: overrides.has(l.lineId) ? 'MANUAL' : (l.Rate_Source || 'NONE'),
      label: overrides.has(l.lineId) ? 'Entered by staff' : (l.Rate_Source_Label || ''),
      rate: l.Rate
    };
  });

  const invoice = {
    Invoice_ID: invoiceId,
    Invoice_No: invoiceNo,
    Customer_ID: challan.Customer_ID,
    Customer_Name_Snapshot: challan.Customer_Name_Snapshot,
    Customer_Address_Snapshot: challan.Customer_Address_Snapshot,
    Customer_Contact_Snapshot: challan.Customer_Contact_Snapshot,
    Customer_GSTIN_Snapshot: buyerGstin,
    Customer_Auth_Person_Snapshot: customer.Auth_Person || '',
    Customer_Email_Snapshot: customer.Email || '',
    Customer_State_Code_Snapshot: buyerState,
    Customer_Type_Snapshot: customer.Customer_Type || 'B2B',

    Seller_State_Code: sellerState,
    GST_Type: gstType,
    Destination_State_Code: buyerState,

    Line_Items: totals.lineItems,
    Gross_Total: totals.Gross_Total,
    Line_Discount_Total: totals.Line_Discount_Total,
    Document_Level_Discount_Pct: totals.Document_Level_Discount_Pct,
    Document_Level_Discount_Amt: totals.Document_Level_Discount_Amt,
    Subtotal: totals.Subtotal,
    Total_CGST: totals.Total_CGST,
    Total_SGST: totals.Total_SGST,
    Total_IGST: totals.Total_IGST,
    Total_GST: totals.Total_GST,
    Grand_Total: totals.Grand_Total,

    Source_Challan_ID: challan.Challan_ID,
    Source_Challan_No: challan.Challan_No,
    Rate_Sources: rateSources,
    // Records WHY deductForInvoice was not called, so a later reader does not "fix" the omission.
    Inventory_Deducted_At_JobCard: true,

    Task_ID: challan.Task_ID || '',
    Status: 'Issued',
    Payment_Status: 'Unpaid',
    Amount_Paid: 0,
    Invoice_Date: todayStr,
    // A challan carries no payment term of its own, so the caller passes one. Without this the
    // invoice was born with Due_Date === Invoice_Date, which makes the "-3 days before due" and
    // "on due date" payment reminders unfireable for every workshop invoice.
    Payment_Terms_ID: paymentTermsId || '',
    Due_Date: addDays(todayStr, resolveTermDays(paymentTermsId, settings)),
    Reminder_Offsets_Sent: [],
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: todayStr,
    Created_At_Ms: nowMs
  };

  await sheetsService.insertRow('Sales_Invoice_Master', invoice);
  await sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', challanId, {
    Linked_Invoice_ID: invoiceId,
    Invoiced_At: new Date().toISOString()
  });

  // Only staff-added lines consume stock here — see the note at the top of this function.
  const manualLines = totals.lineItems.filter(l => l.Line_Type === LINE_TYPE.MANUAL && l.Item_ID);
  let inventoryResult = null;
  if (manualLines.length > 0) {
    try {
      inventoryResult = await inventoryService.deductForInvoice(
        { ...invoice, Line_Items: manualLines }, actor
      );
      if (inventoryResult.shortfalls.length > 0) {
        await sheetsService.updateRow('Sales_Invoice_Master', 'Invoice_ID', invoiceId, {
          Inventory_Shortfall: inventoryResult.shortfalls
        });
      }
    } catch (e) {
      console.error(`Inventory deduction failed for invoice ${invoiceId}:`, e.message);
      inventoryResult = { error: e.message };
    }
  }

  try {
    await priceListService.recordFromInvoice(invoice, actor);
  } catch (e) {
    console.error(`Price list update from invoice ${invoiceId} failed:`, e.message);
  }

  if (challan.Task_ID) {
    await quotationEngine.safeAdvanceTask(challan.Task_ID, 'Sales Invoice', actor, `Invoice ${invoiceNo} raised from challan ${challan.Challan_No}`);
  }

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.INVOICE_GENERATED,
    summary: `${invoiceNo} | ${interactionLogger.formatAmount(totals.Grand_Total)} | from challan ${challan.Challan_No}`,
    taskId: challan.Task_ID,
    customerId: challan.Customer_ID,
    actor
  });

  return { invoice, inventoryResult };
}

/**
 * Records proof of delivery: who signed, when, where, and the photographs.
 *
 * HARD BLOCKS while any standby unit is still out. This is enforced here rather than only in the UI
 * because the loaner loop is the one thing that genuinely goes wrong — the goods are handed over,
 * everyone relaxes, and the company's own extinguisher stays on the customer's wall for a year. A
 * client can be bypassed; this cannot.
 *
 * Photos arrive already GPS-watermarked and compressed by the device — the coordinates are burned
 * into the pixels rather than kept as metadata, which does not survive being forwarded or shared.
 */
async function recordPOD(challanId, { signature, photos, receivedByName, deliveredAt, lat, lng }, actor) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);
  if (challan.Status !== STATUS.ISSUED) throw new Error('Proof of delivery can only be recorded against an issued challan');

  if (challan.Job_Card_ID) {
    const pending = await jobCardService.getPendingStandby(challan.Job_Card_ID);
    if (pending.length > 0) {
      const err = new Error(`${pending.length} standby unit(s) are still with the customer and must be collected before this delivery can be closed`);
      err.pendingStandby = pending;
      err.statusCode = 409;
      throw err;
    }
  }

  const storedPhotos = [];
  for (const photo of (Array.isArray(photos) ? photos : [])) {
    if (!photo?.dataUrl) continue;
    const mediaId = `MED${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    await sheetsService.insertMedia({
      Media_ID: mediaId,
      Data_URL: photo.dataUrl,
      File_Name: photo.fileName || `pod-${mediaId}.jpg`,
      Mime_Type: photo.mimeType || 'image/jpeg',
      Created_At: new Date().toISOString()
    });
    storedPhotos.push({
      mediaId,
      url: `/api/media/${mediaId}`,
      lat: photo.lat ?? null,
      lng: photo.lng ?? null,
      capturedAt: photo.capturedAt || new Date().toISOString()
    });
  }

  let signatureMediaId = '';
  if (signature) {
    signatureMediaId = `MED${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    await sheetsService.insertMedia({
      Media_ID: signatureMediaId,
      Data_URL: signature,
      File_Name: `signature-${challanId}.png`,
      Mime_Type: 'image/png',
      Created_At: new Date().toISOString()
    });
  }

  const podSaved = await sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', challanId, {
    POD: {
      signatureMediaId,
      signatureUrl: signatureMediaId ? `/api/media/${signatureMediaId}` : '',
      photos: storedPhotos,
      receivedByName: String(receivedByName || '').trim(),
      deliveredAt: deliveredAt || new Date().toISOString(),
      lat: lat ?? null,
      lng: lng ?? null,
      recordedBy: actor?.staffId || 'SYSTEM'
    },
    Delivered_At: deliveredAt || new Date().toISOString(),
    Updated_At: new Date().toISOString()
  });

  await interactionLogger.logEvent({
    tag: interactionLogger.EVENT_TAG.DELIVERED,
    summary: `Challan ${challan.Challan_No} received by ${String(receivedByName || '').trim() || 'customer'}`
      + `${storedPhotos.length ? ` | ${storedPhotos.length} photo(s)` : ''}`,
    taskId: challan.Task_ID,
    customerId: challan.Customer_ID,
    actor
  });

  return podSaved;
}

async function cancelChallan(challanId, reason, actor) {
  const challan = await sheetsService.getChallanById(challanId);
  if (!challan) throw new Error(`Challan ${challanId} not found`);
  if (challan.Linked_Invoice_ID) {
    throw new Error(`Challan ${challan.Challan_No} has been invoiced and cannot be cancelled`);
  }
  return sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', challanId, {
    Status: STATUS.CANCELLED,
    Cancel_Reason: String(reason || '').trim(),
    Cancelled_By: actor?.staffId || 'SYSTEM',
    Cancelled_At: new Date().toISOString()
  });
}

module.exports = {
  STATUS,
  LINE_TYPE,
  CONFIDENCE,
  SERVICE,
  buildChallanLines,
  priceChallanLines,
  resolveItemForGroup,
  resolveItemByName,
  generateChallanDraft,
  updateChallanDraft,
  issueChallan,
  buildCertificatePrefill,
  convertChallanToInvoice,
  recordPOD,
  cancelChallan,
  suggestNextChallanNo,
  wasDone
};
