/**
 * Per-staff module permissions for the quotation, inventory and job card modules.
 *
 * The existing codebase gates routes with ad-hoc `req.user.role !== 'Admin'` checks, which is
 * all-or-nothing. These modules need finer control — e.g. a store-keeper who may add and edit
 * stock but never see quotations, and several such staff working the same store.
 *
 * Permissions live on the Staff_Master document under `Module_Permissions`:
 *
 *   Module_Permissions: {
 *     quotation: { view: true, add: true,  edit: true,  delete: false },
 *     inventory: { view: true, add: true,  edit: true,  delete: false },
 *     jobcard:   { view: true, add: true,  edit: true,  delete: false },
 *     taskstage: { view: true, add: true,  edit: true,  delete: false },
 *     finance:   { view: true, add: false, edit: false, delete: false }
 *   }
 *
 * `taskstage` gates choosing a task's workflow stage directly (jumping straight to
 * "Service & Maintenance" for a walk-in customer) rather than stepping one stage at a time. Only
 * its `edit` action is consulted; the ordinary one-step advance stays open to everyone.
 *
 * `finance` gates seeing MONEY — rates, amounts, discounts, taxes and totals — on documents whose
 * other contents the user is legitimately allowed to work with. A technician needs the job card and
 * a delivery boy needs the challan, but neither should see what the customer is paying. Only its
 * `view` action is consulted; the write actions are forced off (see sanitizePermissions) because
 * "editing finance" is not a thing this flag describes.
 *
 * Unlike the other modules, `finance` is NOT a route gate. Adding requirePermission('finance',...)
 * to the existing pricing routes would 403 people who work today. Instead the response sanitiser
 * (utils/moneyMask.js) strips money from the payload, so the route still answers and only the
 * figures go missing.
 *
 * Admin always has everything and ignores the stored map entirely. Staff with no map fall back to
 * ROLE_DEFAULTS, so existing users keep working without a migration.
 *
 * `jobcard` is its own module rather than reusing one of the other two: the technicians who fill
 * job cards are Production staff, who default to `quotation: NONE` — gating on quotation would lock
 * out the intended users — while gating on inventory would hand every technician the stock ledger.
 */

const MODULES = ['quotation', 'inventory', 'jobcard', 'taskstage', 'finance'];
const ACTIONS = ['view', 'add', 'edit', 'delete'];

// Modules where only visibility is meaningful — the write actions are forced off so they can never
// trip the "any write grant implies view" rule below and silently hand someone price access.
const VIEW_ONLY_MODULES = new Set(['finance']);

const NONE = { view: false, add: false, edit: false, delete: false };
const VIEW_ONLY = { view: true, add: false, edit: false, delete: false };
const ADD_EDIT = { view: true, add: true, edit: true, delete: false };
const FULL = { view: true, add: true, edit: true, delete: true };

/**
 * Full access to every module. Derived from MODULES so adding one can't leave Admin behind.
 *
 * View-only modules still resolve to VIEW_ONLY here rather than FULL — Admin sees everything either
 * way, but a `finance: {delete: true}` in the payload would suggest a write action exists. Keeping
 * the shape honest means a consumer can trust the map without special-casing Admin.
 */
function allModulesFull() {
  return MODULES.reduce((acc, mod) => {
    acc[mod] = VIEW_ONLY_MODULES.has(mod) ? VIEW_ONLY : FULL;
    return acc;
  }, {});
}

/**
 * Sensible starting point per existing role, used only when a staff member has no explicit map.
 *
 * Every role carries an explicit entry for EVERY module. A missing key would fall through to
 * `undefined` and read as denied, so adding a module without updating this table would quietly
 * revoke access for everyone who relies on the defaults.
 *
 * On `finance`: sales and supervisor get VIEW_ONLY because they can see prices TODAY — defaulting
 * them to NONE would be a silent access change dressed up as a new feature. production,
 * certification, staff, technician and delivery get NONE, which IS a deliberate change and is the
 * entire point of the module.
 */
const ROLE_DEFAULTS = {
  admin: { quotation: FULL, inventory: FULL, jobcard: FULL, taskstage: FULL, finance: VIEW_ONLY },
  sales: { quotation: ADD_EDIT, inventory: VIEW_ONLY, jobcard: VIEW_ONLY, taskstage: VIEW_ONLY, finance: VIEW_ONLY },
  supervisor: { quotation: VIEW_ONLY, inventory: ADD_EDIT, jobcard: FULL, taskstage: ADD_EDIT, finance: VIEW_ONLY },
  production: { quotation: NONE, inventory: ADD_EDIT, jobcard: ADD_EDIT, taskstage: ADD_EDIT, finance: NONE },
  certification: { quotation: VIEW_ONLY, inventory: NONE, jobcard: VIEW_ONLY, taskstage: VIEW_ONLY, finance: NONE },
  staff: { quotation: NONE, inventory: NONE, jobcard: NONE, taskstage: NONE, finance: NONE },

  // Roles added alongside the finance module. `technician` and `delivery` are the two field roles
  // the price masking exists for; `accounts` is the office role that must keep seeing everything.
  technician: { quotation: NONE, inventory: VIEW_ONLY, jobcard: ADD_EDIT, taskstage: ADD_EDIT, finance: NONE },
  accounts: { quotation: VIEW_ONLY, inventory: VIEW_ONLY, jobcard: VIEW_ONLY, taskstage: NONE, finance: VIEW_ONLY },
  delivery: { quotation: NONE, inventory: NONE, jobcard: VIEW_ONLY, taskstage: NONE, finance: NONE }
};

function isAdmin(user) {
  return String(user?.role || user?.Role || '').trim().toLowerCase() === 'admin';
}

/** Resolves the effective permission map for a staff record. */
function resolvePermissions(staff, roleFromToken) {
  const role = String(staff?.Role || roleFromToken || '').trim().toLowerCase();
  if (role === 'admin') return allModulesFull();

  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.staff;
  const stored = staff?.Module_Permissions;

  const out = {};
  for (const mod of MODULES) {
    const base = defaults[mod] || NONE;
    const override = stored?.[mod];
    out[mod] = {};
    for (const action of ACTIONS) {
      // An explicitly stored boolean always wins; anything else inherits the role default.
      out[mod][action] = typeof override?.[action] === 'boolean' ? override[action] : base[action];
    }
    // View-only modules have their write actions cleared BEFORE the implies-view rule runs below.
    // Without this, a stray `finance: {add: true}` written by an older build or edited straight into
    // the DB would flip view on and hand that person every price in the system.
    if (VIEW_ONLY_MODULES.has(mod)) {
      out[mod].add = false;
      out[mod].edit = false;
      out[mod].delete = false;
    }
    // Any write grant implies view. Enforced here as well as in sanitizePermissions() so a map
    // stored by an older build (or edited directly in the DB) can't leave someone able to add
    // stock while the module itself stays hidden from them.
    if (out[mod].add || out[mod].edit || out[mod].delete) out[mod].view = true;
  }
  return out;
}

/**
 * Whether this caller may see money — rates, amounts, discounts, taxes, totals.
 *
 * Accepts either a resolved permission map or a user/token object, because the callers differ:
 * middleware has the map, route handlers usually only have `req.user`.
 */
function canSeeMoney(permissionsOrUser) {
  if (!permissionsOrUser) return false;
  if (isAdmin(permissionsOrUser)) return true;
  return can(permissionsOrUser, 'finance', 'view');
}

function can(permissions, moduleName, action) {
  return Boolean(permissions?.[moduleName]?.[action]);
}

/** Normalises an admin-submitted permission map, dropping unknown modules/actions. */
function sanitizePermissions(input) {
  const out = {};
  for (const mod of MODULES) {
    if (!input?.[mod]) continue;
    out[mod] = {};
    for (const action of ACTIONS) {
      out[mod][action] = Boolean(input[mod][action]);
    }
    // Same write-lock as resolvePermissions: strip writes on view-only modules before the
    // implies-view rule can promote them into a view grant.
    if (VIEW_ONLY_MODULES.has(mod)) {
      out[mod].add = false;
      out[mod].edit = false;
      out[mod].delete = false;
    }
    // Any grant implies view — an "add" permission the user can't see the module for is useless.
    if (out[mod].add || out[mod].edit || out[mod].delete) out[mod].view = true;
  }
  return out;
}

/**
 * Express middleware factory. Loads the caller's staff record, resolves permissions, attaches them
 * as `req.permissions`, and rejects when the required action isn't granted.
 *
 * Admin short-circuits without a DB read, matching the existing role-check behaviour.
 */
function requirePermission(moduleName, action) {
  return async (req, res, next) => {
    try {
      if (isAdmin(req.user)) {
        req.permissions = allModulesFull();
        return next();
      }

      const sheetsService = require('../services/sheetsService');
      const staff = await sheetsService.getStaffById(req.user?.staffId);
      const permissions = resolvePermissions(staff, req.user?.role);
      req.permissions = permissions;

      if (!can(permissions, moduleName, action)) {
        return res.status(403).json({
          error: `You do not have permission to ${action} in the ${moduleName} module. Ask an Admin to grant access.`
        });
      }
      return next();
    } catch (err) {
      console.error('Permission check failed:', err);
      return res.status(500).json({ error: 'Could not verify permissions' });
    }
  };
}

module.exports = {
  MODULES,
  ACTIONS,
  VIEW_ONLY_MODULES,
  ROLE_DEFAULTS,
  PRESETS: { NONE, VIEW_ONLY, ADD_EDIT, FULL },
  isAdmin,
  resolvePermissions,
  can,
  canSeeMoney,
  sanitizePermissions,
  requirePermission
};
