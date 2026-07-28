/**
 * Workflow stage names, mirroring SALES_STAGES + PRODUCTION_STAGES in
 * server/src/services/workflowEngine.js. Kept in sync by hand: the server is CommonJS and cannot
 * be imported from the ESM client.
 *
 * Order here is pipeline order, which is what the stage dropdowns present.
 */

// 'Completed' and 'Order Closed' are deliberately absent. Landing on either makes
// workflowEngine.advanceTaskStage spawn an 11-month recurring inquiry, and that has no idempotency
// guard — picking it twice creates two follow-ups. Completion stays on the Advance/Status paths.
export const WORKFLOW_STAGES = [
  'New Inquiry',
  'Quotation',
  'Quotation Follow-up',
  'Order Confirmation',
  'Material Arrangement / Internal Work',
  'Pickup/Delivery',
  'Service & Maintenance',
  'Invoice',
  'Certification',
  'Payment Follow-up'
];

// The production stages during which a customer's equipment is physically in the workshop, and so
// the only stages where a job card makes sense. Must match PRODUCTION_STAGES in workflowEngine.js.
export const PRODUCTION_STAGES_WITH_JOB_CARD = [
  'Material Arrangement / Internal Work',
  'Pickup/Delivery',
  'Service & Maintenance'
];

/** Mirrors the department re-derivation in workflowEngine.js:106-110. */
export function departmentForStage(stage, fallback) {
  return PRODUCTION_STAGES_WITH_JOB_CARD.includes(stage) ? 'Production' : (fallback || 'Sales');
}
