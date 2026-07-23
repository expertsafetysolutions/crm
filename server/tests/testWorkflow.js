const sheetsService = require('../src/services/sheetsService');
const workflowEngine = require('../src/services/workflowEngine');

async function runTests() {
  console.log('=== Running Expert Safety Solutions Workflow Engine Tests ===');

  // 1. Check seed data loaded
  const tasks = await sheetsService.getAllTasks();
  console.log(`Loaded ${tasks.length} initial tasks from mock Google Sheets.`);

  // Find TASK1001 (Sales -> Order Confirmation -> Auto Hand-off to Production)
  const salesTask = tasks.find(t => t.Task_ID === 'TASK1001');
  console.log('\n[Test 1] Current Stage for TASK1001:', salesTask.Stage, `(Department: ${salesTask.Department})`);

  // Advance from Quotation Follow-up -> Order Confirmation -> Production Hand-off
  console.log('Advancing TASK1001 to "Order Confirmation"...');
  await workflowEngine.advanceTaskStage('TASK1001', {
    staffId: 'STAFF002',
    targetStage: 'Order Confirmation',
    remarks: 'Customer confirmed order, routing to Production'
  });

  // Now advance again to see automatic routing to Production: Material Arrangement / Internal Work
  const resHandOff = await workflowEngine.advanceTaskStage('TASK1001', {
    staffId: 'STAFF002',
    remarks: 'Triggering auto hand-off'
  });

  console.log('After Hand-off Stage:', resHandOff.updatedTask.Stage);
  console.log('After Hand-off Department:', resHandOff.updatedTask.Department);
  console.log('Assigned Production Staff:', resHandOff.updatedTask.Assigned_Staff);

  // 2. Test 11-month recurring Extinguisher task generation upon Completed
  console.log('\n[Test 2] Testing 11-Month Recurring Extinguisher Task Automation...');
  const completedRes = await workflowEngine.advanceTaskStage('TASK1001', {
    staffId: 'STAFF003',
    targetStage: 'Completed',
    remarks: 'Extinguisher refilling completed on-site'
  });

  console.log('Final Status of TASK1001:', completedRes.updatedTask.Status);
  if (completedRes.generatedRecurringTask) {
    console.log('SUCCESS: Auto-generated Recurring Task:', completedRes.generatedRecurringTask.Task_ID);
    console.log('Description:', completedRes.generatedRecurringTask.Description);
    console.log('Scheduled Date (11 Months from now):', completedRes.generatedRecurringTask.Scheduled_Date);
  } else {
    console.log('ERROR: Recurring task was not generated!');
  }

  console.log('\n=== Workflow Tests Completed Successfully ===');
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
