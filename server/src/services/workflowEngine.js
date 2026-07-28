const sheetsService = require('./sheetsService');
const pushService = require('./pushService');

const SALES_STAGES = [
  'New Inquiry',
  'Quotation',
  'Quotation Follow-up',
  'Order Confirmation',
  'Invoice',
  'Certificate',
  'Certification',
  'Payment Follow-up',
  'Completed',
  // Quotation-engine milestones. These are only ever reached by passing an explicit `targetStage`
  // (from quotationEngine / conversionService), never by the switch below — so the legacy linear
  // Sales/Production hand-off path is unaffected. They must be listed here regardless, because
  // department attribution is decided by membership in this array (see below).
  'Draft-Quotation',
  'Quotation FLP',
  'PI',
  'Sales Invoice',
  'Order Closed'
];

const PRODUCTION_STAGES = [
  'Material Arrangement / Internal Work',
  'Pickup/Delivery',
  'Service & Maintenance'
];

/**
 * Handles Stage Progression & Department Hand-offs
 */
async function advanceTaskStage(taskId, actionPayload) {
  const task = await sheetsService.getTaskById(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const currentStage = task.Stage;
  let nextStage = currentStage;
  let nextDepartment = task.Department;
  let nextAssignedStaff = task.Assigned_Staff;
  let nextStatus = 'In Progress';

  // An unrecognised targetStage would otherwise be written to Task_Master verbatim, leaving a task
  // that looks fine but has silently lost the stage-gated UI (e.g. the job card button, which
  // matches on exact stage strings). Reject it rather than storing it.
  if (actionPayload.targetStage
      && ![...SALES_STAGES, ...PRODUCTION_STAGES].includes(actionPayload.targetStage)) {
    throw new Error(`Unknown target stage "${actionPayload.targetStage}"`);
  }

  // Allow explicit target stage or automatic next stage
  if (actionPayload.targetStage) {
    nextStage = actionPayload.targetStage;
  } else {
    // Automatic stage routing logic based on current stage
    switch (currentStage) {
      // Sales initial steps
      case 'New Inquiry':
        nextStage = 'Quotation';
        break;
      case 'Quotation':
        nextStage = 'Quotation Follow-up';
        break;
      case 'Quotation Follow-up':
        nextStage = 'Order Confirmation';
        break;
      case 'Order Confirmation':
        // Automatic Hand-off to Production
        nextStage = 'Material Arrangement / Internal Work';
        nextDepartment = 'Production';
        nextAssignedStaff = actionPayload.assignedStaff || await getAvailableStaff('Production', task.Assigned_Staff);
        break;

      // Production steps
      case 'Material Arrangement / Internal Work':
        nextStage = 'Pickup/Delivery';
        break;
      case 'Pickup/Delivery':
        nextStage = 'Service & Maintenance';
        break;
      case 'Service & Maintenance':
        // Automatic Hand-off back to Sales
        nextStage = 'Invoice';
        nextDepartment = 'Sales';
        nextAssignedStaff = actionPayload.assignedStaff || await getAvailableStaff('Sales', task.Assigned_Staff);
        break;

      // Sales post-production steps
      case 'Invoice':
        nextStage = 'Certification';
        nextDepartment = 'Certification';
        nextAssignedStaff = actionPayload.assignedStaff || await getAvailableStaff('Certification', task.Assigned_Staff);
        break;
      case 'Certificate':
      case 'Certification':
        nextStage = 'Payment Follow-up';
        nextDepartment = 'Sales';
        break;
      case 'Payment Follow-up':
        nextStage = 'Completed';
        nextStatus = 'Completed';
        break;
      default:
        nextStage = 'Completed';
        nextStatus = 'Completed';
        break;
    }
  }

  // Adjust department if targetStage belongs explicitly to Production or Sales
  if (PRODUCTION_STAGES.includes(nextStage)) {
    nextDepartment = 'Production';
  } else if (SALES_STAGES.includes(nextStage)) {
    nextDepartment = 'Sales';
  }

  // 'Order Closed' is the quotation pipeline's terminal stage and must settle the task the same
  // way 'Completed' does, otherwise a closed order would sit at Status 'In Progress' forever.
  if (nextStage === 'Completed' || nextStage === 'Order Closed') {
    nextStatus = actionPayload.status || 'Completed';
  }

  // A manual targetStage skips the switch above, so the department hand-off that normally picks a
  // new owner never runs. Without this a task jumped into Production stays assigned to the Sales
  // person who created it, and the hand-off push below never fires because the assignee is
  // unchanged — the workshop is never told the job exists.
  if (actionPayload.targetStage && !actionPayload.assignedStaff && nextDepartment !== task.Department) {
    nextAssignedStaff = await getAvailableStaff(nextDepartment, task.Assigned_Staff);
  }

  // Update task in Google Sheets
  const updatedTask = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
    Stage: nextStage,
    Department: nextDepartment,
    Assigned_Staff: actionPayload.assignedStaff || nextAssignedStaff,
    Status: nextStatus
  });

  // Log activity
  const logEntry = {
    Log_ID: `LOG${Date.now()}`,
    Task_ID: taskId,
    Staff_ID: actionPayload.staffId || task.Assigned_Staff,
    Action_Taken: `Stage advanced from "${currentStage}" to "${nextStage}" (${nextDepartment})`,
    Lat_Long_Location: actionPayload.latLong || '0.0000, 0.0000',
    Remarks: actionPayload.remarks || `Workflow transition to ${nextStage}`,
    Timestamp: new Date().toISOString(),
    Image_URL: actionPayload.imageUrl || ''
  };
  await sheetsService.insertRow('Activity_Logs', logEntry);

  // AUTOMATION: If task completed AND is a Fire Extinguisher Service or Recurring task,
  // generate a new task for "Recurring Inquiry" scheduled exactly 11 months from completion date.
  let generatedRecurringTask = null;
  // A lost order must not spawn an 11-month recurring inquiry — Module F's annual-prospect job
  // handles unconverted leads instead, off the quotation record rather than the task.
  const isLostClose = String(nextStatus).toLowerCase().includes('lost');
  if (nextStatus === 'Completed' && !isLostClose) {
    const description = String(task.Description || '').toLowerCase();
    const isExtinguisher = description.includes('extinguisher') ||
                           description.includes('refill') ||
                           task.Type === 'Recurring';
    if (isExtinguisher) {
      const completionDate = new Date();
      completionDate.setMonth(completionDate.getMonth() + 11);
      const scheduledDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(completionDate);

      const salesStaff = await getAvailableStaff('Sales', 'STAFF002');
      const newTaskId = `TASK${Date.now().toString().slice(-6)}`;

      generatedRecurringTask = {
        Task_ID: newTaskId,
        Customer_ID: task.Customer_ID,
        Description: `Recurring Inquiry - Fire Extinguisher Annual Service (Follow-up for ${task.Description})`,
        Assigned_Staff: salesStaff,
        Department: 'Sales',
        Stage: 'New Inquiry',
        Type: 'Recurring',
        Scheduled_Date: scheduledDateStr,
        Status: 'Pending',
        Created_By: 'SYSTEM',
        Created_At: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
      };

      await sheetsService.insertRow('Task_Master', generatedRecurringTask);
    }
  }

  const finalTaskObject = (updatedTask && typeof updatedTask === 'object') ? updatedTask : {
    ...task,
    Stage: nextStage,
    Department: nextDepartment,
    Assigned_Staff: actionPayload.assignedStaff || nextAssignedStaff,
    Status: nextStatus
  };

  // Notify the newly-assigned staff member when a department hand-off changes who owns the task
  // (e.g. Order Confirmation -> Production, Service & Maintenance -> Sales/Certification).
  if (finalTaskObject.Assigned_Staff && String(finalTaskObject.Assigned_Staff).trim().toUpperCase() !== String(task.Assigned_Staff).trim().toUpperCase()) {
    try {
      pushService.notifyStaff(finalTaskObject.Assigned_Staff, {
        type: pushService.NOTIFICATION_TYPES.TASK_STAGE_HANDOFF,
        title: 'Task Handed Off to You',
        body: `"${task.Description || taskId}" moved to ${nextStage} (${nextDepartment}) and is now assigned to you.`,
        url: `/?targetType=TASK&targetId=${taskId}`,
        tag: `task-${taskId}`
      });
    } catch (e) {
      console.error('Error triggering stage hand-off push notification:', e);
    }
  }

  return {
    updatedTask: finalTaskObject,
    logEntry,
    generatedRecurringTask
  };
}

async function getAvailableStaff(department, defaultStaffId) {
  const allStaff = await sheetsService.getAllStaff();
  const deptStaff = allStaff.filter(s => (s.Role === department || s.Department === department) && s.Status !== 'Inactive');
  if (deptStaff.length > 0) {
    return deptStaff[0].Staff_ID;
  }
  if (department === 'Certification') {
    const adminStaff = allStaff.filter(s => (s.Role === 'Admin' || s.Role === 'ADMIN' || String(s.Staff_ID).toUpperCase() === 'ADMIN') && s.Status !== 'Inactive');
    if (adminStaff.length > 0) return adminStaff[0].Staff_ID;
  }
  return defaultStaffId;
}

const REFILLING_DUE_FORMAT_TYPES = ['Refilling', 'HP Testing', 'Training Certificate'];

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function formatDDMMYY(dateStr) {
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// Builds "ABC 6 Kg - 5 Nos, Co2 - 2 Nos" from a certificate's itemsList.
function summarizeItems(itemsList) {
  return (itemsList || []).map(item => {
    const qtyNumber = String(item.qty || '').match(/\d+/)?.[0] || '1';
    const namePart = [item.itemName, item.capacity].filter(Boolean).join(' ');
    return `${namePart} - ${qtyNumber} Nos`;
  }).join(', ');
}

async function getOrCreateRefillingDueTag() {
  const tags = await sheetsService.getAllTags();
  const existing = tags.find(t => String(t.name || '').trim().toLowerCase() === 'refilling due');
  if (existing) return existing.Tag_ID;
  const newTag = { Tag_ID: `TAG${Date.now().toString().slice(-6)}`, name: 'Refilling Due', color: '#ea580c' };
  await sheetsService.insertRow('Tag_Master', newTag);
  return newTag.Tag_ID;
}

// Daily check (invoked by the /api/cron/refilling-due-check route): finds certificates whose
// Valid_Until is exactly 30 days from today and, for the first time, generates a follow-up
// Sales task so the equipment listed on the certificate can be proactively re-serviced before
// it lapses. Idempotent — each processed certificate is flagged so a repeat run (or a run that
// finds the same date again) can't create duplicate tasks.
async function generateRefillingDueTasks() {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const targetDate = addDaysToDateStr(todayStr, 30);

  const [certificates, customTypes] = await Promise.all([
    sheetsService.getAllCertificates(),
    sheetsService.getAllCertificateTypes()
  ]);
  // Built-in types opt in via the static allowlist above; admin-added custom types opt in via the
  // "Generate refilling-due follow-up task" checkbox set when the type was created.
  const customRefillingDueNames = customTypes.filter(t => t.generateRefillingDue).map(t => t.name);
  const dueFormatTypes = new Set([...REFILLING_DUE_FORMAT_TYPES, ...customRefillingDueNames]);
  const dueCerts = certificates.filter(c => {
    const formatType = c.formatType || c.Format_Type;
    const validUntil = c.Valid_Until || c.validUntil;
    return dueFormatTypes.has(formatType) && validUntil === targetDate && !c.refillingTaskGenerated;
  });

  if (dueCerts.length === 0) return { createdCount: 0, skippedCount: 0, targetDate };

  const tagId = await getOrCreateRefillingDueTag();
  let createdCount = 0;

  for (const cert of dueCerts) {
    const validUntil = cert.Valid_Until || cert.validUntil;
    const description = `RDD - ${formatDDMMYY(validUntil)} - ${summarizeItems(cert.itemsList)}`;
    const newTask = {
      Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
      Customer_ID: cert.Customer_ID || cert.customerId,
      Description: description,
      Assigned_Staff: '',
      Department: 'Sales',
      Stage: 'New Inquiry',
      Type: 'One-time',
      Scheduled_Date: todayStr,
      Status: 'Pending',
      Tags: [tagId],
      Created_By: 'SYSTEM',
      Created_At: todayStr
    };
    await sheetsService.insertRow('Task_Master', newTask);
    await sheetsService.updateRow('Document_Registry', 'verificationGuid', cert.verificationGuid || cert.Verification_GUID, { refillingTaskGenerated: true });
    createdCount++;
  }

  return { createdCount, skippedCount: dueCerts.length - createdCount, targetDate };
}

module.exports = {
  SALES_STAGES,
  PRODUCTION_STAGES,
  advanceTaskStage,
  generateRefillingDueTasks
};
