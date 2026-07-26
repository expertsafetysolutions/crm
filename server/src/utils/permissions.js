/**
 * Per-staff module permissions for the quotation and inventory modules.
 *
 * The existing codebase gates routes with ad-hoc `req.user.role !== 'Admin'` checks, which is
 * all-or-nothing. These modules need finer control — e.g. a store-keeper who may add and edit
 * stock but never see quotations, and several such staff working the same store.
 *
 * Permissions live on the Staff_Master document under `Module_Permissions`:
 *
 *   Module_Permissions: {
 *     quotation: { view: true, add: true,  edit: true,  delete: false },
 *     inventory: { view: true, add: true,  edit: true,  delete: false }
 *   }
 *
 * Admin always has everything and ignores the stored map entirely. Staff with no map fall back to
 * ROLE_DEFAULTS, so existing users keep working without a migration.
 */

const MODULES = ['quotation', 'inventory'];
const ACTIONS = ['view', 'add', 'edit', 'delete'];

const NONE = { view: false, add: false, edit: false, delete: false };
const VIEW_ONLY = { view: true, add: false, edit: false, delete: false };
const ADD_EDIT = { view: true, add: true, edit: true, delete: false };
const FULL = { view: true, add: true, edit: true, delete: true };

// Sensible starting point per existing role, used only when a staff member has no explicit map.
const ROLE_DEFAULTS = {
  admin: { quotation: FULL, inventory: FULL },
  sales: { quotation: ADD_EDIT, inventory: VIEW_ONLY },
  supervisor: { quotation: VIEW_ONLY, inventory: ADD_EDIT },
  production: { quotation: NONE, inventory: ADD_EDIT },
  certification: { quotation: VIEW_ONLY, inventory: NONE },
  staff: { quotation: NONE, inventory: NONE }
};

function isAdmin(user) {
  return String(user?.role || user?.Role || '').trim().toLowerCase() === 'admin';
}

/** Resolves the effective permission map for a staff record. */
function resolvePermissions(staff, roleFromToken) {
  const role = String(staff?.Role || roleFromToken || '').trim().toLowerCase();
  if (role === 'admin') return { quotation: FULL, inventory: FULL };

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
    // Any write grant implies view. Enforced here as well as in sanitizePermissions() so a map
    // stored by an older build (or edited directly in the DB) can't leave someone able to add
    // stock while the module itself stays hidden from them.
    if (out[mod].add || out[mod].edit || out[mod].delete) out[mod].view = true;
  }
  return out;
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
        req.permissions = { quotation: FULL, inventory: FULL };
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
  ROLE_DEFAULTS,
  PRESETS: { NONE, VIEW_ONLY, ADD_EDIT, FULL },
  isAdmin,
  resolvePermissions,
  can,
  sanitizePermissions,
  requirePermission
};
