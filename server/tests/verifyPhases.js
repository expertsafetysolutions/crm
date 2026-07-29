/**
 * verifyPhases — checks the price-masking, standby, offline-POD and costing work against the REAL
 * database, without writing a single row to it.
 *
 * Read-only on purpose. testWorkflow.js advances real tasks and generates real recurring inquiries,
 * which is fine for a seeded mock and not fine for a live company database. Everything here either
 * reads, or runs the pure logic (masking, apportionment, averaging) over data held in memory.
 *
 *   npm run verify            all checks
 *   npm run verify -- --staff STAFF007    also report what that person can and cannot see
 *
 * A FAIL is a real defect. A WARN usually means "no data of this kind yet", which is expected on a
 * database where the feature has not been used.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sheetsService = require('../src/services/sheetsService');
const permissions = require('../src/utils/permissions');
const moneyMask = require('../src/utils/moneyMask');
const landedCost = require('../src/services/landedCostService');

let pass = 0, fail = 0, warn = 0;
const failures = [];

const ok = (msg, detail = '') => { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${msg}${detail ? ` — ${detail}` : ''}`); };
const bad = (msg, detail = '') => { fail++; failures.push(`${msg}${detail ? ` — ${detail}` : ''}`); console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}${detail ? ` — ${detail}` : ''}`); };
const meh = (msg, detail = '') => { warn++; console.log(`  \x1b[33mWARN\x1b[0m  ${msg}${detail ? ` — ${detail}` : ''}`); };
const head = t => console.log(`\n\x1b[1m${t}\x1b[0m`);

const argOf = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

async function verifyPermissions() {
  head('1. Roles and price visibility');

  const staff = await sheetsService.getAllStaff();
  ok(`${staff.length} staff records loaded`);

  // Every role in use must resolve to a real entry, not the silent staff fallback.
  const rolesInUse = [...new Set(staff.map(s => String(s.Role || '').trim()).filter(Boolean))];
  const known = Object.keys(permissions.ROLE_DEFAULTS);
  const unknown = rolesInUse.filter(r => !known.includes(r.toLowerCase()));
  if (unknown.length === 0) {
    ok('every role in the database is defined', rolesInUse.join(', '));
  } else {
    meh(`roles falling back to "staff" defaults: ${unknown.join(', ')}`,
      'they get no access until an Admin grants it per person');
  }

  // Who can see money, and who cannot.
  const seers = [], blind = [];
  for (const s of staff) {
    if (String(s.Status || '') !== 'Active') continue;
    const p = permissions.resolvePermissions(s, s.Role);
    (permissions.canSeeMoney(p) ? seers : blind).push(`${s.Staff_ID}/${s.Name || '?'} (${s.Role})`);
  }
  console.log(`        can see prices : ${seers.length ? seers.join(', ') : 'nobody'}`);
  console.log(`        prices hidden  : ${blind.length ? blind.join(', ') : 'nobody'}`);

  if (seers.length === 0) bad('nobody can see prices — the office cannot work');
  else ok(`${seers.length} can see prices, ${blind.length} cannot`);

  // The write-lock that stops a stray toggle granting price access.
  const leaky = staff.filter(s => {
    const m = s.Module_Permissions?.finance;
    return m && !m.view && (m.add || m.edit || m.delete);
  });
  if (leaky.length === 0) ok('no stored finance permission can leak view access');
  else bad(`${leaky.length} staff have finance write flags set`, leaky.map(s => s.Staff_ID).join(', '));

  for (const s of leaky) {
    const r = permissions.resolvePermissions(s, s.Role);
    if (r.finance.view) bad(`CRITICAL: ${s.Staff_ID} gained price access through a write flag`);
  }

  // Admin must always resolve to full access regardless of what is stored.
  const admins = staff.filter(s => String(s.Role || '').toLowerCase() === 'admin');
  const brokenAdmin = admins.find(a => !permissions.canSeeMoney(permissions.resolvePermissions(a, a.Role)));
  if (admins.length === 0) meh('no Admin found');
  else if (brokenAdmin) bad(`Admin ${brokenAdmin.Staff_ID} cannot see prices`);
  else ok(`all ${admins.length} Admin(s) retain full access`);
}

async function verifyMasking() {
  head('2. Price masking over real documents');

  const probes = [
    ['Quotation_Master', await sheetsService.getTab('Quotation_Master')],
    ['Sales_Invoice_Master', await sheetsService.getTab('Sales_Invoice_Master')],
    ['Delivery_Challan_Master', await sheetsService.getTab('Delivery_Challan_Master')],
    ['Item_Master', await sheetsService.getTab('Item_Master')]
  ];

  for (const [name, rows] of probes) {
    if (!rows || rows.length === 0) { meh(`${name} is empty — nothing to check`); continue; }

    const sample = rows[rows.length - 1];        // newest row is the most representative
    const before = JSON.stringify(sample);
    const masked = moneyMask.maskPayload(sample);

    // The single most important property: masking must not touch the cached source row.
    if (JSON.stringify(sample) === before) ok(`${name}: source row untouched by masking`);
    else bad(`${name}: CACHE POISONED — masking mutated the cached row`);

    // Money gone.
    const leaked = [...moneyMask.MONEY_FIELDS].filter(f => f in masked);
    if (leaked.length === 0) ok(`${name}: no money fields survive masking`);
    else bad(`${name}: money leaked through the mask`, leaked.join(', '));

    // Operational data intact — a masked document must still be usable.
    const keptKeys = Object.keys(masked).filter(k => k !== '_Money_Masked');
    if (keptKeys.length > 0) ok(`${name}: ${keptKeys.length} operational fields preserved`);
    else bad(`${name}: masking emptied the document`);

    // Nested line items are where a shallow mask fails.
    const lines = masked.Line_Items || masked.lineItems;
    if (Array.isArray(lines) && lines.length > 0) {
      const lineLeak = [...moneyMask.MONEY_FIELDS].filter(f => f in lines[0]);
      if (lineLeak.length === 0) ok(`${name}: nested line items masked too`);
      else bad(`${name}: money leaked inside Line_Items`, lineLeak.join(', '));
    }
  }

  // The look-alike fields that must SURVIVE, or authorised screens break.
  const survivors = { GST_Rate: 18, Total_Qty: 12, Qty: 5, Balance_After: 40, Current_Qty: 7,
    Reorder_Level: 3, HSN_Code: '84241000', Daily_Salary_Rate: 800, Unit: 'Nos' };
  const m = moneyMask.maskPayload({ ...survivors });
  const lost = Object.keys(survivors).filter(k => !(k in m));
  if (lost.length === 0) ok('non-money look-alike fields all survive', Object.keys(survivors).join(', '));
  else bad('masking removed fields that authorised screens need', lost.join(', '));
}

async function verifyStandby() {
  head('3. Standby loaner loop');

  const cards = await sheetsService.getTab('Job_Card_Master');
  const withStandby = (cards || []).filter(c => Array.isArray(c.Standby_Issued) && c.Standby_Issued.length > 0);

  if (withStandby.length === 0) {
    meh('no standby units issued yet', 'issue one from a job card to exercise this');
    return;
  }
  ok(`${withStandby.length} job card(s) have standby history`);

  let out = 0, back = 0, kept = 0, noGatePass = 0, contradictory = 0;
  for (const card of withStandby) {
    for (const u of card.Standby_Issued) {
      if (u.returned) back++;
      else if (u.retained) kept++;
      else out++;
      if (!u.gatePassNo) noGatePass++;
      // A unit cannot be both recovered and kept — that would mean the ledger is wrong either way.
      if (u.returned && u.retained) contradictory++;
    }
  }
  console.log(`        out: ${out}   returned: ${back}   kept by customer: ${kept}`);

  if (contradictory === 0) ok('no unit is marked both returned and retained');
  else bad(`${contradictory} unit(s) marked both returned AND retained`);

  if (noGatePass === 0) ok('every standby unit carries a gate pass number');
  else meh(`${noGatePass} unit(s) issued before gate passes were minted`, 'pre-existing records');

  // Every retention must carry its written reason — that is the whole safeguard.
  const unreasoned = withStandby.flatMap(c =>
    c.Standby_Issued.filter(u => u.retained && !String(u.retentionReason || '').trim())
      .map(u => `${c.Job_Card_ID}/${u.EUID_No}`));
  if (kept === 0) ok('no retentions recorded yet');
  else if (unreasoned.length === 0) ok(`all ${kept} retention(s) carry a written reason`);
  else bad('retention recorded with no reason', unreasoned.join(', '));

  if (out > 0) console.log(`        \x1b[33mnote\x1b[0m  ${out} loaner(s) still on customer sites`);
}

async function verifyCosting() {
  head('4. Stock valuation and landed cost');

  const inventory = await sheetsService.getTab('Inventory_Master');
  if (!inventory || inventory.length === 0) { meh('no inventory rows yet'); return; }

  const costed = inventory.filter(r => Number(r.Moving_Avg_Cost) > 0);
  if (costed.length === 0) {
    meh(`${inventory.length} item(s) tracked, none costed yet`, 'post a goods receipt to build cost');
  } else {
    ok(`${costed.length} of ${inventory.length} item(s) carry a cost`);

    // The invariant that must always hold: value === qty x average.
    const drifted = costed.filter(r => {
      const expect = Math.round((Number(r.Current_Qty) || 0) * Number(r.Moving_Avg_Cost) * 100) / 100;
      return Math.abs((Number(r.Stock_Value) || 0) - expect) > 0.01;
    });
    if (drifted.length === 0) ok('Stock_Value === Current_Qty x Moving_Avg_Cost on every costed item');
    else bad(`${drifted.length} item(s) have a stock value that disagrees with qty x cost`,
      drifted.slice(0, 3).map(r => r.Item_ID).join(', '));

    const negativeCost = costed.filter(r => Number(r.Moving_Avg_Cost) < 0);
    if (negativeCost.length === 0) ok('no negative average costs');
    else bad(`${negativeCost.length} item(s) have a negative cost`);

    const total = costed.reduce((s, r) => s + (Number(r.Stock_Value) || 0), 0);
    console.log(`        stock on hand is valued at ₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
  }

  const negativeStock = inventory.filter(r => Number(r.Current_Qty) < 0);
  if (negativeStock.length > 0) {
    meh(`${negativeStock.length} item(s) show negative stock`,
      'allowed by design after an invoice, but worth correcting: ' + negativeStock.slice(0, 3).map(r => r.Item_Name || r.Item_ID).join(', '));
  } else ok('no item is showing negative stock');

  // The arithmetic itself, proved on a worked example rather than on live data.
  const demo = landedCost.computeLandedCosts(
    [{ itemId: 'A', receivedQty: 50, unitPrice: 20 }, { itemId: 'B', receivedQty: 2, unitPrice: 4000 }],
    1000
  );
  const allocated = Math.round(demo.reduce((s, l) => s + l.Allocated_Charges, 0) * 100) / 100;
  if (allocated === 1000) ok('freight apportionment sums exactly to the amount invoiced');
  else bad('freight apportionment loses money', `allocated ₹${allocated} of ₹1000`);

  if (demo[1].Allocated_Charges > demo[0].Allocated_Charges) ok('freight follows value, not quantity');
  else bad('freight is being spread by count rather than value');
}

async function verifyPurchase() {
  head('5. Procurement records');

  const [vendors, rfqs, pos, grns] = await Promise.all([
    sheetsService.getTab('Vendor_Master'),
    sheetsService.getTab('Purchase_RFQ'),
    sheetsService.getTab('Purchase_Order'),
    sheetsService.getTab('Goods_Receipt')
  ]);

  console.log(`        vendors: ${vendors?.length || 0}   enquiries: ${rfqs?.length || 0}   orders: ${pos?.length || 0}   receipts: ${grns?.length || 0}`);

  if (!pos || pos.length === 0) { meh('no purchase orders yet', 'the module is installed but unused'); return; }

  // A repeated PO number lets one delivery be claimed for payment twice.
  const numbers = pos.map(p => p.PO_No).filter(Boolean);
  const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  if (dupes.length === 0) ok(`all ${numbers.length} PO number(s) unique`);
  else bad('duplicate PO numbers issued', [...new Set(dupes)].join(', '));

  if (grns && grns.length > 0) {
    const mismatched = grns.filter(g => {
      const lineSum = (g.Lines || []).reduce((s, l) => s + (Number(l.Landed_Total) || 0), 0);
      return Math.abs(lineSum - (Number(g.Landed_Total) || 0)) > 0.05;
    });
    if (mismatched.length === 0) ok('every receipt total matches the sum of its lines');
    else bad(`${mismatched.length} receipt(s) do not reconcile to their lines`);

    const short = grns.filter(g => g.Has_Discrepancy);
    if (short.length > 0) meh(`${short.length} receipt(s) had a short or excess delivery`, 'expected if vendors under-delivered');
    else ok('no delivery discrepancies recorded');
  }

  // 3-way match over whatever real orders exist.
  const purchaseService = require('../src/services/purchaseService');
  const matched = [], problems = [], paidWithoutNote = [];
  for (const po of pos) {
    if (po.Status === purchaseService.PO_STATUS.CANCELLED) continue;
    try {
      const m = await purchaseService.getThreeWayMatch(po.PO_ID);
      if (m.summary.Is_Matched) matched.push(po.PO_No);
      else if (!/Awaiting/.test(m.summary.Match_Status)) problems.push(`${po.PO_No}: ${m.summary.Match_Status}`);
      // Paying an order that does not match without recording why is the thing this guards against.
      if (po.Payment_Released && !m.summary.Is_Matched && !String(po.Payment_Release_Note || '').trim()) {
        paidWithoutNote.push(po.PO_No);
      }
    } catch (e) { bad(`3-way match failed for ${po.PO_No}`, e.message); }
  }
  if (matched.length > 0) ok(`${matched.length} order(s) reconcile cleanly`);
  if (problems.length > 0) meh(`${problems.length} order(s) do not match`, problems.slice(0, 3).join(' · '));
  if (paidWithoutNote.length === 0) ok('no mismatched order was paid without a written reason');
  else bad('paid despite a mismatch with no reason recorded', paidWithoutNote.join(', '));
}

async function verifyOfflineContract() {
  head('6. Offline queue contract');

  // Every queued type needs a server branch or it strands in IndexedDB forever.
  const fs = require('fs');
  const path = require('path');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apiRoutes.js'), 'utf8');

  const types = ['ADVANCE_STAGE', 'RESCHEDULE', 'ACTIVITY_LOG', 'JOB_CARD_ITEM_UPSERT',
    'JOB_CARD_PARTS_ADD', 'JOB_CARD_RECHECK', 'CHALLAN_POD'];
  const missing = types.filter(t => !routes.includes(`item.type === '${t}'`));
  if (missing.length === 0) ok(`all ${types.length} offline action types have a server branch`);
  else bad('offline types with no server branch would retry forever', missing.join(', '));

  if (routes.includes('Unsupported offline action type')) ok('terminal-else guard present');
  else bad('CRITICAL: terminal-else guard missing — unknown types would re-POST forever');

  if (routes.includes('statusCode === 409')) ok('409 conflicts are reported terminal, not retried');
  else bad('a 409 during sync would retry forever');
}

async function reportForStaff(staffId) {
  head(`7. What ${staffId} actually sees`);

  const s = await sheetsService.getStaffById(staffId);
  if (!s) { bad(`staff ${staffId} not found`); return; }

  const p = permissions.resolvePermissions(s, s.Role);
  const money = permissions.canSeeMoney(p);
  console.log(`        ${s.Name || staffId} · role ${s.Role} · ${s.Status}`);
  for (const mod of permissions.MODULES) {
    const granted = permissions.ACTIONS.filter(a => p[mod][a]);
    console.log(`        ${mod.padEnd(10)} ${granted.length ? granted.join(', ') : '\x1b[90mno access\x1b[0m'}`);
  }
  console.log(`        prices: ${money ? '\x1b[32mVISIBLE\x1b[0m' : '\x1b[33mHIDDEN\x1b[0m'}`);

  const challans = await sheetsService.getTab('Delivery_Challan_Master');
  if (challans?.length > 0) {
    const doc = challans[challans.length - 1];
    const seen = money ? doc : moneyMask.maskPayload(doc);
    const hasRate = JSON.stringify(seen).includes('"Rate"');
    if (money && hasRate) ok('this person would see rates on a challan');
    else if (!money && !hasRate) ok('this person would NOT see rates on a challan');
    else if (!money && hasRate) bad('CRITICAL: rates would still reach this person');
    else meh('no rates on the sampled challan to compare');
  }
}

(async () => {
  console.log('\x1b[1m=== Verifying shipped work against the live database (read-only) ===\x1b[0m');
  console.log('No rows are written by this script.\n');

  try {
    await verifyPermissions();
    await verifyMasking();
    await verifyStandby();
    await verifyCosting();
    await verifyPurchase();
    await verifyOfflineContract();

    const staffId = argOf('staff');
    if (staffId) await reportForStaff(staffId.toUpperCase());

    console.log(`\n\x1b[1m=== ${pass} passed, ${fail} failed, ${warn} warnings ===\x1b[0m`);
    if (failures.length > 0) {
      console.log('\n\x1b[31mNeeds attention:\x1b[0m');
      failures.forEach(f => console.log(`  · ${f}`));
    }
    if (!argOf('staff')) {
      console.log('\n\x1b[90mTip: npm run verify -- --staff STAFF001  shows exactly what one person can see.\x1b[0m');
    }
    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n\x1b[31mVerification could not run:\x1b[0m', err.message);
    console.error('Check that server/.env has MONGO_URI and the database is reachable.');
    process.exit(2);
  }
})();
