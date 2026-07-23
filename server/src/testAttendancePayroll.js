const attendanceService = require('./services/attendanceService');
const sheetsService = require('./services/sheetsService');

async function runAttendancePayrollTests() {
  console.log('=== Running Attendance & Payroll Automation Tests ===\n');

  await sheetsService.connect();
  const testDate = '2026-08-15';
  const testDate2 = '2026-08-16';

  // Clean up any existing test records for testDate and testDate2
  const allAtt = await sheetsService.getAllAttendance();
  for (const r of allAtt) {
    if (r.Date === testDate || r.Date === testDate2) {
      await sheetsService.deleteRow('Attendance_Log', 'Record_ID', r.Record_ID);
    }
  }

  // Test 1: Punch In late at 09:25 AM
  console.log('[Test 1] Testing Late Punch In at 09:25 AM for STAFF002...');
  const punchInRecord = await attendanceService.punchIn({
    staffId: 'STAFF002',
    latLong: '19.0760, 72.8777',
    overrideDate: testDate,
    overrideTime: '09:25'
  });
  console.log('Punch In Record Created:', {
    Record_ID: punchInRecord.Record_ID,
    Late_By_Minutes: punchInRecord.Late_By_Minutes
  });
  if (punchInRecord.Late_By_Minutes !== 25) {
    throw new Error(`Expected Late_By_Minutes=25, got ${punchInRecord.Late_By_Minutes}`);
  }
  console.log('PASS: Correctly flagged 25 minutes late arrival!\n');

  // Test 2: Punch Out at 17:25 (8 hours worked)
  console.log('[Test 2] Testing Punch Out at 17:25 (8 hours worked against 10 hour shift)...');
  const punchOutResult = await attendanceService.punchOut({
    staffId: 'STAFF002',
    latLong: '19.0760, 72.8777',
    overrideDate: testDate,
    overrideTime: '17:25'
  });
  console.log('Punch Out Result:', {
    Total_Worked_Hours: punchOutResult.record.Total_Worked_Hours,
    Calculated_Daily_Salary: punchOutResult.record.Calculated_Daily_Salary
  });
  // STAFF002 Daily Rate = 1000. 8 hours out of 10 = (8/10)*1000 = 800.
  if (punchOutResult.record.Calculated_Daily_Salary !== 800) {
    throw new Error(`Expected Calculated_Daily_Salary=800, got ${punchOutResult.record.Calculated_Daily_Salary}`);
  }
  console.log('PASS: Pro-rata daily salary calculated accurately as Rs. 800!\n');

  // Test 3: Multiple/Accidental punch - punch in again same day at 18:00 and out at 20:00 (+2 hours = 10 total)
  console.log('[Test 3] Testing Multiple/Accidental Punch In/Out on same day summing total hours...');
  await attendanceService.punchIn({
    staffId: 'STAFF002',
    latLong: '19.0760, 72.8777',
    overrideDate: testDate,
    overrideTime: '18:00'
  });
  const secondOutResult = await attendanceService.punchOut({
    staffId: 'STAFF002',
    latLong: '19.0760, 72.8777',
    overrideDate: testDate,
    overrideTime: '20:00'
  });
  console.log('Second Punch Out Cumulative Summary:', secondOutResult.dailySummary);
  if (secondOutResult.dailySummary.cumulativeHours < 10 || secondOutResult.dailySummary.totalDailySalary !== 1000) {
    throw new Error(`Expected full salary 1000 after cumulative 10 hours, got ${secondOutResult.dailySummary.totalDailySalary}`);
  }
  console.log('PASS: Cumulative hours and salary correctly summed across multiple punches!\n');

  // Test 4: Auto Check-Out Job
  console.log('[Test 4] Testing Auto Check-Out Cron Job for forgotten punch-out...');
  await attendanceService.punchIn({
    staffId: 'STAFF003',
    latLong: '18.5204, 73.8567',
    overrideDate: '2026-08-16',
    overrideTime: '09:00'
  });
  const autoCloseRes = await attendanceService.runAutoCloseJob();
  console.log('Auto Close Job Closed:', autoCloseRes.closedCount, 'records');
  if (autoCloseRes.closedCount === 0) {
    throw new Error('Auto close job did not close open records');
  }
  console.log('PASS: Auto check-out marked open record as 23:59 (Auto-Closed)!\n');

  console.log('=== ALL ATTENDANCE & PAYROLL TESTS PASSED SUCCESSFULLY! ===');
  process.exit(0);
}

runAttendancePayrollTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
