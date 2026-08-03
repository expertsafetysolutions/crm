const sheetsService = require('./sheetsService');
const geoFence = require('../utils/geoFence');

const APPROVAL_STATUS = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired'
};

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

/** Hand-rolled id, matching the per-collection prefix convention used across the app. */
function newApprovalId() {
  return `ATA${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
}

/**
 * The geofence columns for one side of a punch ('In' or 'Out').
 *
 * Returns {} when no fence was in play, so a deployment with no office configured writes exactly the
 * same document shape it always has — the backward-compatibility guarantee.
 */
function buildGeofenceFields(side, geofence, gpsAccuracy, approvalId) {
  if (!geofence || !geofence.enabled) return {};
  const accuracy = Number(gpsAccuracy);
  return {
    [`${side}_Distance_M`]: geofence.distanceM ?? null,
    [`${side}_GPS_Accuracy_M`]: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    [`${side}_Punch_Source`]: geofence.source || 'UNVERIFIED',
    ...(approvalId ? { [`${side}_Approval_ID`]: approvalId } : {})
  };
}

/**
 * Closes any still-Pending request for the same staff/date/type.
 *
 * Called after a punch actually lands. Without it, a person who is refused, walks into the office
 * and punches normally would leave a live request behind — and an Admin approving it an hour later
 * would create a second attendance row for one arrival.
 *
 * Best-effort by design: a failure here must never turn a successful punch into an error, so it
 * swallows. approvePunchApproval re-checks for an existing record as the real guard.
 */
async function supersedePendingApprovals(staffId, dateStr, punchType, reason) {
  try {
    // Filtered server-side instead of loading every approval ever requested (getAttendanceApprovals)
    // just to find this one staff member's pending rows for today.
    const stale = await sheetsService.queryTab('Attendance_Approvals', {
      Staff_ID: staffId,
      Requested_Date: dateStr,
      Punch_Type: punchType,
      Status: APPROVAL_STATUS.PENDING
    });
    for (const row of stale) {
      await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', row.Approval_ID, {
        Status: APPROVAL_STATUS.CANCELLED,
        Review_Reason: reason,
        Reviewed_At: new Date().toISOString()
      });
    }
  } catch (e) {
    console.error('[attendance] Could not supersede pending approvals:', e.message);
  }
}

class AttendanceService {
  /**
   * Record Staff Punch In
   */
  async punchIn({ staffId, latLong, ipAddress, overrideDate, overrideTime,
                  gpsAccuracy, geofence, approvalId }) {
    const ist = getISTDateTime(new Date());
    const dateStr = overrideDate || ist.dateStr;
    const timeStr = overrideTime || ist.timeStr;

    // Filtered server-side to this staff member's own records for today, instead of loading every
    // attendance row ever recorded (getAllAttendance) just to check for one open session.
    const todaysRecords = await sheetsService.queryTab('Attendance_Log', { Staff_ID: staffId, Date: dateStr });
    const openRecord = todaysRecords.find(r => !r.Punch_Out_Time || r.Punch_Out_Time === '');

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
      Calculated_Daily_Salary: 0,
      // Geofence audit trail. Written on every punch once an office is configured, whether the
      // person was inside, exempt, or approved — the distance is the record that makes the whole
      // feature useful even when nothing was blocked.
      ...buildGeofenceFields('In', geofence, gpsAccuracy, approvalId)
    };

    await sheetsService.insertRow('Attendance_Log', newRecord);
    // A punch that actually landed settles any request still waiting for the same slot — the person
    // is demonstrably here, so an Admin approving later must not create a second row.
    await supersedePendingApprovals(staffId, dateStr, 'IN', 'Superseded by a punch that went through');
    return newRecord;
  }

  /**
   * Record Staff Punch Out & Compute Pro-Rata Salary
   */
  async punchOut({ staffId, latLong, ipAddress, overrideDate, overrideTime,
                   gpsAccuracy, geofence, approvalId }) {
    const ist = getISTDateTime(new Date());
    const dateStr = overrideDate || ist.dateStr;
    const timeStr = overrideTime || ist.timeStr;

    // Filtered server-side to this staff member's own records for today — punchOut needs every
    // session today (to sum cumulative hours), not just the open one, so the filter stays at
    // {Staff_ID, Date} rather than narrowing further, but this is still one staff/one day instead
    // of the entire Attendance_Log collection.
    const todaysRecords = await sheetsService.queryTab('Attendance_Log', { Staff_ID: staffId, Date: dateStr });
    const openRecord = todaysRecords.find(r => !r.Punch_Out_Time || r.Punch_Out_Time === '');

    if (!openRecord) {
      throw new Error('No open punch-in record found for today.');
    }

    const sessionHours = calculateWorkedHours(openRecord.Punch_In_Time, timeStr);

    // Sum all previous sessions for today + this session
    const dayRecords = todaysRecords.filter(r => r.Record_ID !== openRecord.Record_ID);
    const priorHours = dayRecords.reduce((sum, r) => sum + Number(r.Total_Worked_Hours || 0), 0);
    const cumulativeHours = Number((priorHours + sessionHours).toFixed(2));

    // Compute pro-rata salary — filtered to the one staff record instead of loading all of Staff_Master.
    const [staff] = await sheetsService.queryTab('Staff_Master', { Staff_ID: staffId });
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
      Calculated_Daily_Salary: sessionSalary,
      ...buildGeofenceFields('Out', geofence, gpsAccuracy, approvalId)
    });

    await supersedePendingApprovals(staffId, dateStr, 'OUT', 'Superseded by a punch that went through');

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

  // ─── OUT-OF-OFFICE APPROVAL FLOW ─────────────────────────────────────────────────────────────

  /**
   * Resolves whether this punch is allowed, and why.
   *
   * Order matters and is easy to get wrong. In particular the INSIDE check must come BEFORE the
   * exemption check: an exempt salesperson standing at their desk should be recorded as 'OFFICE',
   * not 'EXEMPT'. Reversed, every sales punch looks like a field punch and the Admin loses the very
   * signal they wanted.
   */
  async resolvePunchFence({ staffId, latLong, gpsAccuracy }) {
    const settings = await sheetsService.getAttendanceSettings();

    // Fail-open: no office configured, or the switch is off → behave exactly as before.
    if (!geoFence.isFenceConfigured(settings)) {
      return { enabled: false, allowed: true, source: 'UNVERIFIED', settings };
    }

    const verdict = geoFence.evaluateFence({ latLong, accuracyM: gpsAccuracy, settings });

    if (verdict.reason === 'NO_FIX') {
      return { enabled: true, allowed: false, noFix: true, source: 'UNVERIFIED', settings };
    }
    if (verdict.inside) {
      return { ...verdict, allowed: true, source: 'OFFICE', settings };
    }

    const staff = await sheetsService.getStaffById(staffId);
    if (staff?.Geofence_Exempt === true) {
      return { ...verdict, allowed: true, source: 'EXEMPT', settings };
    }

    return { ...verdict, allowed: false, source: 'BLOCKED', settings };
  }

  /**
   * Records an out-of-office punch attempt for an Admin to decide on.
   *
   * Reuses an existing Pending row for the same staff/date/type rather than inserting a second:
   * one impatient person tapping five times must not fill the Admin's queue with five identical
   * cards. The coordinates and time are refreshed so the Admin always sees the latest attempt.
   */
  async requestPunchApproval({ staffId, punchType, latLong, gpsAccuracy, ipAddress, verdict }) {
    const ist = getISTDateTime(new Date());
    const staff = await sheetsService.getStaffById(staffId);
    const nowIso = new Date().toISOString();

    const existing = (await sheetsService.getAttendanceApprovals()).find(r =>
      r.Staff_ID === staffId &&
      r.Requested_Date === ist.dateStr &&
      r.Punch_Type === punchType &&
      r.Status === APPROVAL_STATUS.PENDING
    );

    const payload = {
      Staff_ID: staffId,
      Staff_Name: staff?.Name || staffId,
      Punch_Type: punchType,
      // Server-set, not client-supplied: this is the time the punch will carry if approved, so it
      // must not be back-datable the way the client's overrideTime is.
      Requested_Date: ist.dateStr,
      Requested_Time: ist.timeStr,
      Requested_At_ISO: nowIso,
      Lat_Long: latLong || '',
      GPS_Accuracy_M: Number.isFinite(Number(gpsAccuracy)) ? Math.round(Number(gpsAccuracy)) : null,
      Distance_M: verdict?.distanceM ?? null,
      Office_Radius_M: verdict?.radiusM ?? null,
      IP_Address: ipAddress || 'Unknown IP',
      Status: APPROVAL_STATUS.PENDING
    };

    let row;
    if (existing) {
      row = await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', existing.Approval_ID, payload);
    } else {
      row = { Approval_ID: newApprovalId(), ...payload, Address_Text: '', Created_At: nowIso };
      await sheetsService.insertRow('Attendance_Approvals', row);
    }

    // Address is a convenience for the Admin, never a dependency — resolved after the row exists
    // and deliberately not awaited, so a slow or dead geocoder cannot delay the staff member's
    // 409 response by a single millisecond.
    const approvalId = row.Approval_ID;
    require('./geocodeService').lookupFromLatLong(latLong)
      .then(({ addressText, source }) => {
        if (!addressText) return;
        return sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', approvalId, {
          Address_Text: addressText, Address_Source: source
        });
      })
      .catch(() => { /* an address is optional; nothing to recover */ });

    return row;
  }

  async getApprovalById(approvalId) {
    const rows = await sheetsService.getAttendanceApprovals();
    return rows.find(r => r.Approval_ID === approvalId) || null;
  }

  /**
   * Lists approvals, expiring anything that has sat unanswered too long.
   *
   * Expiry is lazy rather than a cron: /api/cron/* routes in this app fan out across the whole
   * database, and this needs no such reach.
   */
  async listApprovals({ status, staffId } = {}) {
    const settings = await sheetsService.getAttendanceSettings();
    const expiryMin = Number(settings?.Approval_Expiry_Min) || 240;
    const cutoff = Date.now() - expiryMin * 60 * 1000;

    let rows = await sheetsService.getAttendanceApprovals();

    const stale = rows.filter(r =>
      r.Status === APPROVAL_STATUS.PENDING &&
      r.Requested_At_ISO && new Date(r.Requested_At_ISO).getTime() < cutoff
    );
    for (const row of stale) {
      await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', row.Approval_ID, {
        Status: APPROVAL_STATUS.EXPIRED,
        Review_Reason: `No decision within ${expiryMin} minutes`
      });
    }
    if (stale.length) rows = await sheetsService.getAttendanceApprovals();

    return rows
      .filter(r => (!status || r.Status === status) && (!staffId || r.Staff_ID === staffId))
      .sort((a, b) => String(b.Requested_At_ISO || '').localeCompare(String(a.Requested_At_ISO || '')))
      .slice(0, 100);
  }

  /**
   * Approves a request and writes the actual punch.
   *
   * The punch carries the ORIGINAL request time, not the approval time. Someone who stood there at
   * 09:04 must not be marked 45 minutes late because an Admin answered at 09:49 — that would turn
   * approval latency into a pay cut.
   */
  async approvePunchApproval(approvalId, adminUser) {
    // Conditional claim: Status is part of the FILTER, so two Admins tapping Approve together
    // cannot both win. updateRow matches on the key alone and would let both through.
    const claimed = await sheetsService.updateRowIf(
      'Attendance_Approvals', 'Approval_ID', approvalId,
      { Status: APPROVAL_STATUS.PENDING },
      {
        Status: APPROVAL_STATUS.APPROVED,
        Reviewed_By: adminUser?.staffId || 'SYSTEM',
        Reviewed_At: new Date().toISOString()
      }
    );

    if (!claimed) {
      const current = await this.getApprovalById(approvalId);
      if (!current) throw new Error('That approval request no longer exists.');
      const err = new Error(`This request was already ${String(current.Status).toLowerCase()}.`);
      err.statusCode = 409;
      err.approval = current;
      throw err;
    }

    // Second guard: the person may have walked in and punched normally while this sat waiting.
    //
    // Only an OPEN session blocks a punch-in — the same rule punchIn itself applies. Matching any
    // row for the day would refuse a legitimate second shift, since staff routinely punch out for
    // lunch or a site visit and back in afterwards.
    const records = await sheetsService.getAllAttendance();
    const openSession = records.find(r =>
      r.Staff_ID === claimed.Staff_ID && r.Date === claimed.Requested_Date &&
      (!r.Punch_Out_Time || r.Punch_Out_Time === '')
    );

    if (claimed.Punch_Type === 'IN' && openSession) {
      await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', approvalId, {
        Status: APPROVAL_STATUS.CANCELLED,
        Review_Reason: `Already punched in at ${openSession.Punch_In_Time}`
      });
      const err = new Error(`${claimed.Staff_Name} already punched in at ${openSession.Punch_In_Time}. Nothing to record.`);
      err.statusCode = 409;
      throw err;
    }

    // The mirror case: approving a punch-OUT when there is nothing open to close.
    if (claimed.Punch_Type === 'OUT' && !openSession) {
      await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', approvalId, {
        Status: APPROVAL_STATUS.CANCELLED,
        Review_Reason: 'No open session left to punch out of'
      });
      const err = new Error(`${claimed.Staff_Name} has no open shift to punch out of. Nothing to record.`);
      err.statusCode = 409;
      throw err;
    }

    const fence = { enabled: true, distanceM: claimed.Distance_M, source: 'APPROVED' };
    const common = {
      staffId: claimed.Staff_ID,
      latLong: claimed.Lat_Long,
      ipAddress: claimed.IP_Address,
      overrideDate: claimed.Requested_Date,
      overrideTime: claimed.Requested_Time,
      gpsAccuracy: claimed.GPS_Accuracy_M,
      geofence: fence,
      approvalId
    };

    const result = claimed.Punch_Type === 'IN'
      ? await this.punchIn(common)
      : await this.punchOut(common);

    const recordId = claimed.Punch_Type === 'IN' ? result.Record_ID : result.record?.Record_ID;
    // Written in the same breath as the claim so a completed approval always names its punch.
    await sheetsService.updateRow('Attendance_Approvals', 'Approval_ID', approvalId, {
      Resulting_Record_ID: recordId || ''
    });

    return { approval: { ...claimed, Resulting_Record_ID: recordId }, record: result };
  }

  async rejectPunchApproval(approvalId, adminUser, reason) {
    const claimed = await sheetsService.updateRowIf(
      'Attendance_Approvals', 'Approval_ID', approvalId,
      { Status: APPROVAL_STATUS.PENDING },
      {
        Status: APPROVAL_STATUS.REJECTED,
        Reviewed_By: adminUser?.staffId || 'SYSTEM',
        Reviewed_At: new Date().toISOString(),
        Review_Reason: String(reason || '').trim()
      }
    );
    if (!claimed) {
      const current = await this.getApprovalById(approvalId);
      if (!current) throw new Error('That approval request no longer exists.');
      const err = new Error(`This request was already ${String(current.Status).toLowerCase()}.`);
      err.statusCode = 409;
      throw err;
    }
    return claimed;
  }

  /** Staff cancelling their own pending request (they gave up waiting, or reached the office). */
  async cancelPunchApproval(approvalId, staffId) {
    const row = await this.getApprovalById(approvalId);
    if (!row) throw new Error('That approval request no longer exists.');
    if (row.Staff_ID !== staffId) {
      const err = new Error('You can only cancel your own request.');
      err.statusCode = 403;
      throw err;
    }
    return sheetsService.updateRowIf(
      'Attendance_Approvals', 'Approval_ID', approvalId,
      { Status: APPROVAL_STATUS.PENDING },
      { Status: APPROVAL_STATUS.CANCELLED, Review_Reason: 'Cancelled by staff' }
    );
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

const service = new AttendanceService();
// Status strings live on the instance so routes and tests share one source of truth rather than
// re-typing 'Pending' in four places.
service.APPROVAL_STATUS = APPROVAL_STATUS;

module.exports = service;
