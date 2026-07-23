const sheetsService = require('./sheetsService');

const SALES_STAGES = [
  'New Inquiry',
  'Quotation',
  'Quotation Follow-up',
  'Order Confirmation',
  'Invoice',
  'Certificate',
  'Certification',
  'Payment Follow-up',
  'Completed'
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

  if (nextStage === 'Completed') {
    nextStatus = 'Completed';
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
  if (nextStatus === 'Completed') {
    const isExtinguisher = task.Description.toLowerCase().includes('extinguisher') ||
                           task.Description.toLowerCase().includes('refill') ||
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

module.exports = {
  SALES_STAGES,
  PRODUCTION_STAGES,
  advanceTaskStage
};
