const sheetsService = require('./sheetsService');

const STANDARD_START_HOUR = 9; // 9:00 AM
const STANDARD_START_MINUTE = 0;
const STANDARD_SHIFT_HOURS = 10; // 9 AM to 7 PM

function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const clean = timeStr.split(' ')[0]; // Handle '23:59 (Auto-Closed)'
  const [h, m] = clean.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function calculateLateMinutes(punchInTimeStr) {
  const punchInMins = timeToMinutes(punchInTimeStr);
  const stdStartMins = STANDARD_START_HOUR * 60 + STANDARD_START_MINUTE; // 540 mins
  if (punchInMins > stdStartMins) {
    return punchInMins - stdStartMins;
  }
  return 0;
}

function calculateWorkedHours(punchInTimeStr, punchOutTimeStr) {
  const inMins = timeToMinutes(punchInTimeStr);
  const outMins = timeToMinutes(punchOutTimeStr);
  if (outMins <= inMins) return 0;
  const diffHours = (outMins - inMins) / 60;
  return Number(diffHours.toFixed(2));
}

function getISTDateTime(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
    
    let year = getPart('year');
    let month = getPart('month');
    let day = getPart('day');
    let hour = getPart('hour');
    if (hour === '24') hour = '00';
    let minute = getPart('minute');
    
    return {
      dateStr: `${year}-${month}-${day}`,
      timeStr: `${hour}:${minute}`
    };
  } catch (err) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return {
      dateStr: `${year}-${month}-${day}`,
      timeStr: `${hours}:${minutes}`
    };
  }
}

class AttendanceService {
  /**
   * Record Staff Punch In
   */
  async punchIn({ staffId, latLong, ipAddress, overrideDate, overrideTime }) {
    const ist = getISTDateTime(new Date());
    const dateStr = overrideDate || ist.dateStr;
    const timeStr = overrideTime || ist.timeStr;

    const allRecords = await sheetsService.getAllAttendance();
    const openRecord = allRecords.find(
      r => r.Staff_ID === staffId && r.Date === dateStr && (!r.Punch_Out_Time || r.Punch_Out_Time === '')
    );

    if (openRecord) {
      throw new Error('You already have an active punch-in session for today. Please punch out first.');
    }

    const lateMinutes = calculateLateMinutes(timeStr);

    const newRecord = {
      Record_ID: `ATT${Date.now()}`,
      Staff_ID: staffId,
      Date: dateStr,
      Punch_In_Time: timeStr,
      Punch_Out_Time: '',
      In_Location_LatLong: latLong || '0.0000, 0.0000',
      Out_Location_LatLong: '',
      IP_Address: ipAddress || 'Unknown IP',
      Late_By_Minutes: lateMinutes,
      Total_Worked_Hours: 0,
      Calculated_Daily_Salary: 0
    };

    await sheetsService.insertRow('Attendance_Log', newRecord);
    return newRecord;
  }

  /**
   * Record Staff Punch Out & Compute Pro-Rata Salary
   */
  async punchOut({ staffId, latLong, ipAddress, overrideDate, overrideTime }) {
    const ist = getISTDateTime(new Date());
    const dateStr = overrideDate || ist.dateStr;
    const timeStr = overrideTime || ist.timeStr;

    const allRecords = await sheetsService.getAllAttendance();
    const openRecord = allRecords.find(
      r => r.Staff_ID === staffId && r.Date === dateStr && (!r.Punch_Out_Time || r.Punch_Out_Time === '')
    );

    if (!openRecord) {
      throw new Error('No open punch-in record found for today.');
    }

    const sessionHours = calculateWorkedHours(openRecord.Punch_In_Time, timeStr);

    // Sum all previous sessions for today + this session
    const dayRecords = allRecords.filter(
      r => r.Staff_ID === staffId && r.Date === dateStr && r.Record_ID !== openRecord.Record_ID
    );
    const priorHours = dayRecords.reduce((sum, r) => sum + Number(r.Total_Worked_Hours || 0), 0);
    const cumulativeHours = Number((priorHours + sessionHours).toFixed(2));

    // Compute pro-rata salary
    const staff = await sheetsService.getStaffById(staffId);
    const dailyRate = Number(staff?.Daily_Salary_Rate) || 1000;

    // Check if Sunday (automatic Weekly Off full pay) or worked >= 10 hours
    const dayOfWeek = new Date(dateStr).getDay(); // 0 = Sunday
    let calculatedSalary = dailyRate;

    if (dayOfWeek !== 0 && cumulativeHours < STANDARD_SHIFT_HOURS) {
      calculatedSalary = Math.round((cumulativeHours / STANDARD_SHIFT_HOURS) * dailyRate);
    }

    // Pro-rata session salary portion for this specific record
    let sessionSalary = calculatedSalary;
    if (dayRecords.length > 0 && cumulativeHours > 0) {
      sessionSalary = Math.round((sessionHours / cumulativeHours) * calculatedSalary);
    }

    const updatedRecord = await sheetsService.updateRow('Attendance_Log', 'Record_ID', openRecord.Record_ID, {
      Punch_Out_Time: timeStr,
      Out_Location_LatLong: latLong || openRecord.In_Location_LatLong || '0.0000, 0.0000',
      IP_Address: ipAddress || openRecord.IP_Address || 'Unknown IP',
      Total_Worked_Hours: sessionHours,
      Calculated_Daily_Salary: sessionSalary
    });

    return {
      record: updatedRecord,
      dailySummary: {
        date: dateStr,
        staffId,
        cumulativeHours,
        totalDailySalary: calculatedSalary
      }
    };
  }

  /**
   * Enrich attendance records dynamically with salary up to 7 PM (19:00) if not punched out
   */
  enrichRecordsWithSalary(records, allStaff = []) {
    if (!Array.isArray(records)) return records;
    const todayStr = getISTDateTime(new Date()).dateStr;
    return records.map(r => {
      if (!r.Punch_Out_Time || r.Punch_Out_Time === '') {
        const staff = allStaff.find(s => s.Staff_ID === r.Staff_ID) || {};
        const dailyRate = Number(staff.Daily_Salary_Rate) || Number(r.Daily_Salary_Rate) || 1000;
        const inMins = timeToMinutes(r.Punch_In_Time);
        const capMins = timeToMinutes('19:00');
        let workedHrs = 0;
        if (capMins > inMins && inMins > 0) {
          workedHrs = Number(((capMins - inMins) / 60).toFixed(2));
        } else if (r.Punch_In_Time) {
          workedHrs = calculateWorkedHours(r.Punch_In_Time, '19:00');
        }
        const dayOfWeek = new Date(r.Date || todayStr).getDay();
        let calculatedSalary = dailyRate;
        if (dayOfWeek !== 0 && workedHrs < STANDARD_SHIFT_HOURS) {
          calculatedSalary = Math.round((workedHrs / STANDARD_SHIFT_HOURS) * dailyRate);
        }
        return {
          ...r,
          Total_Worked_Hours: Number(r.Total_Worked_Hours) > 0 ? r.Total_Worked_Hours : workedHrs,
          Calculated_Daily_Salary: Number(r.Calculated_Daily_Salary) > 0 ? r.Calculated_Daily_Salary : calculatedSalary,
          Punch_Out_Status_Note: 'In Progress (Salary calculated till 7 PM)'
        };
      } else if (r.Punch_Out_Time.includes('Auto-Closed') && r.Punch_Out_Time.includes('23:59')) {
        // Fix old 23:59 auto closed representation to 19:00 capping right in display
        const workedHrs = calculateWorkedHours(r.Punch_In_Time, '19:00');
        const staff = allStaff.find(s => s.Staff_ID === r.Staff_ID) || {};
        const dailyRate = Number(staff.Daily_Salary_Rate) || Number(r.Daily_Salary_Rate) || 1000;
        const dayOfWeek = new Date(r.Date || todayStr).getDay();
        let calculatedSalary = dailyRate;
        if (dayOfWeek !== 0 && workedHrs < STANDARD_SHIFT_HOURS) {
          calculatedSalary = Math.round((workedHrs / STANDARD_SHIFT_HOURS) * dailyRate);
        }
        return {
          ...r,
          Punch_Out_Time: '19:00 (Auto-Closed)',
          Total_Worked_Hours: workedHrs,
          Calculated_Daily_Salary: calculatedSalary
        };
      }
      return r;
    });
  }

  /**
   * Admin Manual Salary Override
   */
  async overrideSalary(recordId, newSalary) {
    const updated = await sheetsService.updateRow('Attendance_Log', 'Record_ID', recordId, {
      Calculated_Daily_Salary: Number(newSalary)
    });
    if (!updated) {
      throw new Error('Attendance record not found');
    }
    return updated;
  }

  /**
   * Automated Check-Out Job (Cron / End of Day)
   * Closes any unclosed punches as '19:00 (Auto-Closed)' and calculates salary up to 7 PM (19:00)
   */
  async runAutoCloseJob() {
    const allRecords = await sheetsService.getAllAttendance();
    const openRecords = allRecords.filter(r => !r.Punch_Out_Time || r.Punch_Out_Time === '');

    const closedList = [];
    for (const rec of openRecords) {
      const inMins = timeToMinutes(rec.Punch_In_Time);
      const capMins = timeToMinutes('19:00');
      const outTimeStr = inMins < capMins ? '19:00 (Auto-Closed)' : '19:00 (Auto-Closed)';
      const sessionHours = calculateWorkedHours(rec.Punch_In_Time, '19:00');
      const staff = await sheetsService.getStaffById(rec.Staff_ID);
      const dailyRate = Number(staff?.Daily_Salary_Rate) || 1000;

      const calculatedSalary =
        sessionHours >= STANDARD_SHIFT_HOURS
          ? dailyRate
          : Math.round((sessionHours / STANDARD_SHIFT_HOURS) * dailyRate);

      const updated = await sheetsService.updateRow('Attendance_Log', 'Record_ID', rec.Record_ID, {
        Punch_Out_Time: outTimeStr,
        Out_Location_LatLong: rec.In_Location_LatLong || '0.0000, 0.0000',
        Total_Worked_Hours: sessionHours,
        Calculated_Daily_Salary: calculatedSalary
      });
      closedList.push(updated);
    }

    return {
      closedCount: closedList.length,
      records: closedList
    };
  }
}

module.exports = new AttendanceService();
