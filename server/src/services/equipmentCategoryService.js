const sheetsService = require('./sheetsService');

/**
 * equipmentCategoryService — the admin-editable catalogue of extinguisher categories and the
 * inward-inspection checkpoints each one carries.
 *
 * The service-report module already has an admin-configurable checkpoint engine, but its category
 * list (ABC / CO2) is hardcoded in the client schema. The workshop needs to add Foam, Clean Agent
 * and so on without a deploy, so the categories themselves live here as data.
 *
 * ABC and CO2 are seeded on first read rather than migrated in, matching how getEquipmentMaster()
 * falls back to built-in types when its collection is empty (sheetsService.js:281-296).
 */

const CATEGORY_PREFIX = 'ECAT';

// Seeds. Checkpoint ids are camelCase and become keys on Job_Card_Item.Inward_Checkpoints, so they
// must never be renamed once rows exist — change the label instead.
const DEFAULT_CATEGORIES = [
  {
    Category_ID: 'ECAT_ABC',
    Code: 'ABC',
    Label: 'ABC / DCP Type',
    Description: 'Dry Chemical Powder (ABC Type IS:15683)',
    Capacities: ['1 Kg', '2 Kg', '4 Kg', '4.5 Kg', '6 Kg', '9 Kg', '10 Kg', '25 Kg', '50 Kg'],
    Checkpoints: [
      { id: 'controlValve', label: 'Control Valve', order: 1 },
      { id: 'safetyPin', label: 'Safety Pin', order: 2 },
      { id: 'pressureGauge', label: 'Pressure Gauge', order: 3 },
      { id: 'valveHook', label: 'Valve Hook', order: 4 },
      { id: 'body', label: 'Body', order: 5 },
      { id: 'mainLabel', label: 'Main Label', order: 6 },
      { id: 'hoseBelt', label: 'Hose Belt', order: 7 }
    ],
    Requires_Weight: false,
    Active: true,
    Sort_Order: 1
  },
  {
    // CO2 has no pressure gauge — charge is verified by weighing against the nameplate, which is
    // why Requires_Weight drives the empty/full weight capture on the job card.
    Category_ID: 'ECAT_CO2',
    Code: 'CO2',
    Label: 'CO2 Type',
    Description: 'Carbon Dioxide (IS:15683 / IS:2878)',
    Capacities: ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'],
    Checkpoints: [
      { id: 'controlWheel', label: 'Control Wheel', order: 1 },
      { id: 'lockRing', label: 'Lock Ring', order: 2 },
      { id: 'safetyPin', label: 'Safety Pin', order: 3 },
      { id: 'handle', label: 'Handle', order: 4 },
      { id: 'handleGrip', label: 'Handle Grip', order: 5 },
      { id: 'mainLabel', label: 'Main Label', order: 6 },
      { id: 'emptyWeight', label: 'Empty Weight', order: 7 }
    ],
    Requires_Weight: true,
    Active: true,
    Sort_Order: 2
  }
];

function newCategoryId() {
  return `${CATEGORY_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
}

function sortCategories(rows) {
  return [...rows].sort((a, b) => (Number(a.Sort_Order) || 0) - (Number(b.Sort_Order) || 0));
}

/** Normalises an admin-submitted checkpoint list; drops entries with no id. */
function sanitizeCheckpoints(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((c, idx) => ({
      id: String(c?.id || '').trim(),
      label: String(c?.label || '').trim() || String(c?.id || '').trim(),
      order: Number(c?.order) || idx + 1
    }))
    .filter(c => c.id)
    .sort((a, b) => a.order - b.order);
}

/**
 * All categories, seeding ABC and CO2 the first time the collection is read empty so a fresh
 * install has a working job card without a migration step.
 */
async function getCategories({ includeInactive = false } = {}) {
  let rows = await sheetsService.getEquipmentCategories();

  if (!rows || rows.length === 0) {
    for (const seed of DEFAULT_CATEGORIES) {
      await sheetsService.insertRow('Equipment_Category_Master', { ...seed, Created_At: new Date().toISOString() });
    }
    rows = await sheetsService.getEquipmentCategories();
  }

  const sorted = sortCategories(rows);
  return includeInactive ? sorted : sorted.filter(r => r.Active !== false);
}

async function getCategoryByCode(code) {
  if (!code) return null;
  const target = String(code).trim().toUpperCase();
  const rows = await getCategories({ includeInactive: true });
  return rows.find(r => String(r.Code || '').trim().toUpperCase() === target) || null;
}

/** The checkpoint list for a category code, empty when the code is unknown. */
async function getCheckpointsForCode(code) {
  const category = await getCategoryByCode(code);
  return Array.isArray(category?.Checkpoints) ? category.Checkpoints : [];
}

async function createCategory(payload, actor) {
  const code = String(payload?.Code || payload?.code || '').trim().toUpperCase();
  if (!code) throw new Error('Category code is required');

  const existing = await getCategoryByCode(code);
  if (existing) throw new Error(`A category with code ${code} already exists`);

  const all = await getCategories({ includeInactive: true });
  const row = {
    Category_ID: newCategoryId(),
    Code: code,
    Label: String(payload?.Label || payload?.label || code).trim(),
    Description: String(payload?.Description || '').trim(),
    Capacities: Array.isArray(payload?.Capacities) ? payload.Capacities : [],
    Checkpoints: sanitizeCheckpoints(payload?.Checkpoints),
    Requires_Weight: Boolean(payload?.Requires_Weight),
    Active: payload?.Active !== false,
    Sort_Order: Number(payload?.Sort_Order) || all.length + 1,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: new Date().toISOString()
  };

  await sheetsService.insertRow('Equipment_Category_Master', row);
  return row;
}

async function updateCategory(categoryId, patch, actor) {
  const update = { Updated_By: actor?.staffId || 'SYSTEM', Updated_At: new Date().toISOString() };

  if (patch?.Label !== undefined) update.Label = String(patch.Label).trim();
  if (patch?.Description !== undefined) update.Description = String(patch.Description).trim();
  if (patch?.Capacities !== undefined) update.Capacities = Array.isArray(patch.Capacities) ? patch.Capacities : [];
  if (patch?.Checkpoints !== undefined) update.Checkpoints = sanitizeCheckpoints(patch.Checkpoints);
  if (patch?.Requires_Weight !== undefined) update.Requires_Weight = Boolean(patch.Requires_Weight);
  if (patch?.Active !== undefined) update.Active = Boolean(patch.Active);
  if (patch?.Sort_Order !== undefined) update.Sort_Order = Number(patch.Sort_Order) || 0;

  // Code is deliberately immutable: Job_Card_Item.Equipment_Type stores it, and renaming would
  // orphan every existing row's checkpoint resolution.
  return sheetsService.updateRow('Equipment_Category_Master', 'Category_ID', categoryId, update);
}

module.exports = {
  DEFAULT_CATEGORIES,
  getCategories,
  getCategoryByCode,
  getCheckpointsForCode,
  createCategory,
  updateCategory,
  sanitizeCheckpoints
};
