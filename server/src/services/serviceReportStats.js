const sheetsService = require('./sheetsService');

/**
 * Aggregates Service_Reports for the statistics/summary feature: due-date filtering, counts by
 * sub-type + capacity (e.g. "ABC 6kg: 10, CO2 5kg: 3"), and a Not-OK punch list technicians can
 * carry to the next visit or hand to the client.
 *
 * The dataset (one fire-safety business) is small enough to aggregate in plain Node over the
 * already 3s-cached Service_Reports read, rather than a Mongo aggregation pipeline.
 *
 * Checkpoint ids / due-date fields below mirror client/src/utils/reportTypeSchemas.js by hand —
 * the client (ESM) and server (CommonJS) are separate module systems with no shared package in
 * this codebase, so this duplication is intentional. Keep the two in sync when checkpoints change.
 */

const CHECKPOINTS_BY_TYPE = {
  FIRE_EXTINGUISHER: {
    __default: 'ABC',
    ABC: ['bodyValve', 'valve', 'safetyPin', 'pressureWeight', 'hoseHorn', 'seal'],
    CO2: ['bodyValve', 'valve', 'safetyPin', 'weightCheck', 'dischargeHorn', 'seal']
  },
  SYSTEM: {
    HOSE_COMMON: ['valveCondition', 'hoseCondition', 'branchPipeNozzle', 'couplingGasket', 'cabinetSignage', 'flowTestOk'],
    PUMP_HOUSE: ['jockeyPumpAutoStart', 'mainPumpStatus', 'dieselPumpAutoStart', 'headerPressureOk', 'pressureSwitchSetting', 'glandLeakage', 'panelIndicationLamps', 'batteryFuelLevel', 'isolationValvesPosition']
  }
};

// The row-level date field each family's due-date filter reads. Families with no sub-types
// (Alarm/General/Visit) have no per-row due date defined yet, so they're simply not filterable.
const DUE_DATE_FIELD_BY_TYPE = {
  FIRE_EXTINGUISHER: 'nextRefillingDate',
  SYSTEM: 'nextServiceDueDate'
};

function rowSubType(reportType, row) {
  const cfg = CHECKPOINTS_BY_TYPE[reportType];
  if (!cfg) return row.subType;
  return row.subType || cfg.__default;
}

function checkpointIdsFor(reportType, subType) {
  const cfg = CHECKPOINTS_BY_TYPE[reportType];
  if (!cfg || !subType) return [];
  return cfg[subType] || [];
}

function rowIsNotOk(row, checkpointIds) {
  return checkpointIds.some(id => (row[id] || 'OK') === 'NOT OK');
}

/**
 * @param {Object} params
 * @param {string} [params.reportType] e.g. 'FIRE_EXTINGUISHER'
 * @param {string} [params.subType] e.g. 'ABC', 'CO2', 'HOSE_COMMON', 'PUMP_HOUSE'
 * @param {string} [params.customerId]
 * @param {string} [params.from] yyyy-mm-dd
 * @param {string} [params.to] yyyy-mm-dd
 * @param {boolean} [params.notOkOnly] when true, counts and the due list are scoped to rows that
 *   currently have at least one Not OK checkpoint (the punch list itself is always full).
 */
async function computeServiceReportStats({ reportType, subType, customerId, from, to, notOkOnly } = {}) {
  const reports = await sheetsService.getAllServiceReports();

  const matchingReports = reports.filter(r => {
    if (reportType && (r.reportType || 'FIRE_EXTINGUISHER') !== reportType) return false;
    if (customerId && String(r.customerId || '') !== String(customerId)) return false;
    return true;
  });

  const rows = [];
  matchingReports.forEach(report => {
    const rType = report.reportType || 'FIRE_EXTINGUISHER';
    (report.itemsList || []).forEach(item => {
      const st = rowSubType(rType, item);
      if (subType && st !== subType) return;
      rows.push({
        ...item,
        __reportId: report.Report_ID,
        __customerName: report.customerName,
        __customerId: report.customerId,
        __serviceDate: report.serviceDate,
        __reportType: rType,
        __subType: st
      });
    });
  });

  // Always the full punch list, regardless of notOkOnly — that flag scopes the counts/due list.
  const notOkList = [];
  rows.forEach(row => {
    const checkpointIds = checkpointIdsFor(row.__reportType, row.__subType);
    checkpointIds.forEach(cpId => {
      if ((row[cpId] || 'OK') === 'NOT OK') {
        notOkList.push({
          reportId: row.__reportId,
          customerName: row.__customerName,
          customerId: row.__customerId,
          clientIdNo: row.clientIdNo || '',
          location: row.location || '',
          itemName: row.itemName || '',
          subType: row.__subType || '',
          checkpointId: cpId,
          recommendation: row.recommendations?.[cpId] || ''
        });
      }
    });
  });

  const effectiveRows = notOkOnly
    ? rows.filter(row => rowIsNotOk(row, checkpointIdsFor(row.__reportType, row.__subType)))
    : rows;

  const bucketMap = new Map();
  effectiveRows.forEach(row => {
    const key = `${row.__subType || 'Unspecified'}::${row.capacity || 'Unspecified'}`;
    if (!bucketMap.has(key)) bucketMap.set(key, { subType: row.__subType || 'Unspecified', capacity: row.capacity || 'Unspecified', count: 0 });
    bucketMap.get(key).count += 1;
  });
  const bySubTypeAndCapacity = Array.from(bucketMap.values())
    .sort((a, b) => a.subType.localeCompare(b.subType) || a.capacity.localeCompare(b.capacity));

  const dueField = DUE_DATE_FIELD_BY_TYPE[reportType];
  let dueList = [];
  if (dueField) {
    dueList = effectiveRows
      .filter(row => {
        const d = row[dueField];
        if (!d) return false;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      })
      .map(row => ({
        reportId: row.__reportId,
        customerName: row.__customerName,
        customerId: row.__customerId,
        clientIdNo: row.clientIdNo || '',
        location: row.location || '',
        itemName: row.itemName || '',
        subType: row.__subType || '',
        capacity: row.capacity || '',
        dueDate: row[dueField]
      }));
  }

  return {
    totalCount: effectiveRows.length,
    bySubTypeAndCapacity,
    dueList,
    notOkList
  };
}

module.exports = { computeServiceReportStats };
