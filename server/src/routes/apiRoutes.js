const express = require('express');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const { computeServiceReportStats } = require('../services/serviceReportStats');
const workflowEngine = require('../services/workflowEngine');
const attendanceService = require('../services/attendanceService');
const pushService = require('../services/pushService');
const { authenticateToken } = require('./authRoutes');
const { verifyStaffPassword, validatePasswordPolicy } = require('../utils/passwordUtils');
const gstUtils = require('../utils/gstUtils');
const { requirePermission, resolvePermissions, sanitizePermissions, can, MODULES, ACTIONS } = require('../utils/permissions');
const quotationEngine = require('../services/quotationEngine');
const conversionService = require('../services/conversionService');
const inventoryService = require('../services/inventoryService');
const jobCardService = require('../services/jobCardService');
const equipmentCategoryService = require('../services/equipmentCategoryService');
const challanService = require('../services/challanService');
const priceListService = require('../services/priceListService');
const interactionLogger = require('../services/interactionLogger');
const moneyMask = require('../utils/moneyMask');
const piiMask = require('../utils/piiMask');

const router = express.Router();

router.use(authenticateToken);

// Strips rates and amounts out of responses for staff without `finance:view`. Mounted here, ahead of
// every route, so it applies at send time whatever handler answers — including the 409 payloads that
// carry pricing. It only touches the outbound JSON: service-to-service data (invoice conversion,
// stock deduction, challan pricing) never passes through it and is unaffected.
router.use(moneyMask.middleware());

// Partially masks customer email/address for `staff` and `delivery` (phone is exempted for both
// roles — task-card Call/WhatsApp buttons need the real number; see PHONE_EXEMPT_ROLES in
// piiMask.js). Mounted AFTER moneyMask so it wraps res.json second and therefore runs FIRST at
// send time; the two touch disjoint field sets, so the order affects nothing but is fixed here
// rather than left to chance. Deliberately not route-scoped — contact details surface on tasks,
// challans, job cards and /sync/all alike, and an allow-list would leak through whichever route
// was forgotten.
router.use(piiMask.middleware());

// Auto-injects a system-generated entry into the company's remark timeline (Customer_Interactions)
// on task lifecycle events (created / status changed / completed). Delegates to interactionLogger,
// which is the one place that writes these rows — the module-level events (material received,
// challan issued, payment received…) go through the same service, so every automatic entry in the
// timeline has an identical shape.
async function logSystemTaskRemark({ customerId, taskId, remarkText, tag, staffId, staffName }) {
  await interactionLogger.logEvent({
    tag,
    summary: remarkText,
    taskId,
    customerId,
    actor: staffId ? { staffId, name: staffName } : null
  });
}

// --- UNIFIED HIGH-SPEED SYNC ENDPOINT (INSTANT DASHBOARD LOAD) ---
router.get('/sync/all', async (req, res) => {
  try {
    const [
      allTasks,
      allCustomers,
      allStaff,
      allLogs,
      allAttendance,
      allLeaves,
      allInteractions,
      allAdvances,
      allCertificates,
      equipmentMaster,
      allServiceReports,
      allTags
    ] = await Promise.all([
      sheetsService.getAllTasks(),
      sheetsService.getAllCustomers(),
      sheetsService.getAllStaff(),
      sheetsService.getAllLogs(),
      sheetsService.getAllAttendance(),
      sheetsService.getAllLeaves(),
      sheetsService.getCustomerInteractions(),
      sheetsService.getAdvances(),
      sheetsService.getAllCertificates(),
      sheetsService.getEquipmentMaster(),
      sheetsService.getAllServiceReports(),
      sheetsService.getAllTags()
    ]);

    // Effective_Permissions is attached here, on the single shared list, so BOTH the Admin and Staff
    // response literals below carry it — those are separate objects and that split is how `logs`
    // once ended up Admin-only. It powers Admin impersonation: previewing a staff member has to show
    // that person's masked UI, which needs their resolved map rather than their sparse stored one.
    const cleanStaff = allStaff.map(({ Password, ...rest }) => ({
      ...rest,
      Effective_Permissions: resolvePermissions(rest, rest.Role)
    }));

    // Enrich tasks with customer details robustly (case-insensitive & trimmed matching)
    const enrichedTasks = allTasks.map(t => {
      const custId = String(t.Customer_ID || '').trim().toLowerCase();
      const customer = allCustomers.find(c => String(c.Customer_ID || '').trim().toLowerCase() === custId) || {};
      return {
        ...t,
        Customer_Name: customer.Company_Name || t.Customer_Name || (t.Customer_ID ? `Customer (${t.Customer_ID})` : 'General Client'),
        Customer_Contact: customer.Contact || t.Customer_Contact || '',
        Customer_Auth_Person: customer.Auth_Person || t.Customer_Auth_Person || '',
        Customer_Location_Link: customer.Location_Link || t.Customer_Location_Link || '',
        Customer_Address: customer.Address || t.Customer_Address || '',
        Customer_Coordinators: customer.Coordinators || t.Customer_Coordinators || ''
      };
    });

    const enrichedAttendance = attendanceService.enrichRecordsWithSalary(allAttendance, allStaff);

    if (req.user.role === 'Admin') {
      const totalTasks = enrichedTasks.length;
      const completedTasks = enrichedTasks.filter(t => t.Status === 'Completed').length;
      const pendingTasks = enrichedTasks.filter(t => t.Status === 'Pending' || t.Status === 'In Progress').length;
      const activeStaff = cleanStaff.filter(s => s.Status === 'Active').length;
      const analytics = {
        totalTasks,
        completedTasks,
        pendingTasks,
        activeStaff,
        completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0
      };

      return res.json({
        role: 'Admin',
        tasks: enrichedTasks,
        customers: allCustomers,
        staff: cleanStaff,
        logs: allLogs,
        attendance: enrichedAttendance,
        leaves: allLeaves,
        customerInteractions: allInteractions,
        advances: allAdvances,
        certificates: allCertificates,
        equipmentMaster: equipmentMaster,
        serviceReports: allServiceReports,
        tags: allTags,
        analytics,
        timestamp: Date.now()
      });
    } else {
      const staffIdStr = String(req.user.staffId).trim().toLowerCase();
      const staffTasks = enrichedTasks.filter(t => String(t.Assigned_Staff).trim().toLowerCase() === staffIdStr);
      const staffAttendance = enrichedAttendance.filter(r => String(r.Staff_ID).trim().toLowerCase() === staffIdStr);
      const staffLeaves = allLeaves.filter(l => String(l.Staff_ID).trim().toLowerCase() === staffIdStr);
      const staffAdvances = allAdvances.filter(a => String(a.Staff_ID).trim().toLowerCase() === staffIdStr);

      return res.json({
        role: 'Staff',
        tasks: staffTasks,
        customers: allCustomers,
        attendance: staffAttendance,
        leaves: staffLeaves,
        advances: staffAdvances,
        customerInteractions: allInteractions,
        certificates: allCertificates,
        equipmentMaster: equipmentMaster,
        serviceReports: allServiceReports,
        tags: allTags,
        staff: cleanStaff,
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('Unified sync failed:', err);
    res.status(500).json({ error: 'Failed to sync data' });
  }
});

// --- DOCUMENT REGISTRY / CERTIFICATES & EQUIPMENT MASTER ---
// By default returns only non-deleted certificates (matches every existing caller). Pass
// ?deletedOnly=true for the Admin "Recently Deleted" recovery view.
router.get('/certificates', async (req, res) => {
  try {
    const certs = await sheetsService.getAllCertificates();
    const wantDeleted = req.query.deletedOnly === 'true';
    res.json(certs.filter(c => Boolean(c.Is_Deleted) === wantDeleted));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
});

// Allocates the next certificate number for a prefix from the atomic Counter_Master sequence.
// Registered before /certificates/:guid siblings — Express matches in registration order and a
// literal path must win over the parameterised one.
router.get('/certificates/next-number', async (req, res) => {
  try {
    const stem = String(req.query.stem || '').trim();
    const letters = String(req.query.letters || '').trim().toUpperCase();
    if (!stem || !letters) {
      return res.status(400).json({ error: 'stem and letters are required' });
    }
    res.json(await sheetsService.getNextCertificateNumber(stem, letters));
  } catch (err) {
    console.error('GET /certificates/next-number error:', err);
    res.status(500).json({ error: 'Failed to allocate a certificate number' });
  }
});

// Splits "Expert/26-27/R310" into { stem:'Expert/26-27', letters:'R', num:310 }.
const parseCertificateNo = (value) => {
  const raw = String(value || '').trim();
  const cut = raw.lastIndexOf('/');
  const stem = cut > 0 ? raw.slice(0, cut) : '';
  const tail = cut > 0 ? raw.slice(cut + 1) : raw;
  const m = tail.match(/^([A-Za-z]*)(\d+)$/);
  return m ? { stem, letters: m[1], num: parseInt(m[2], 10) } : null;
};

/**
 * Makes a certificate's number and verification GUID unique at the moment of saving.
 *
 * Both are minted in the browser — the number from a max+1 scan of whatever certificates that tab
 * happened to load, the GUID from ~2.2 billion random values with no check at all. Two people
 * generating certificates at the same time therefore get the same number, and a GUID collision is
 * worse still: the public /verify-certificate page would show one customer's certificate under
 * another's QR code.
 *
 * The client keeps its optimistic number so the user still sees one immediately and offline; the
 * server just refuses to let two documents share one, and reports back what it actually used.
 */
const ensureUniqueCertificateIdentity = (payload, existing) => {
  const out = { ...payload };
  const reassigned = {};

  const wantedNo = String(payload.Certificate_No || payload.certificateNo || '').trim();
  const takenNo = existing.some(c =>
    String(c.Certificate_No || c.certificateNo || '').trim().toLowerCase() === wantedNo.toLowerCase()
  );

  if (wantedNo && takenNo) {
    const parsed = parseCertificateNo(wantedNo);
    if (parsed) {
      let max = parsed.num;
      for (const c of existing) {
        const p = parseCertificateNo(c.Certificate_No || c.certificateNo);
        if (p && p.stem === parsed.stem && p.letters === parsed.letters && p.num > max) max = p.num;
      }
      const width = String(parsed.num).length;
      const nextNo = `${parsed.stem}/${parsed.letters}${String(max + 1).padStart(width, '0')}`;
      out.Certificate_No = nextNo;
      out.certificateNo = nextNo;
      out.certSequence = `${parsed.letters}${String(max + 1).padStart(width, '0')}`;
      reassigned.certificateNo = { requested: wantedNo, assigned: nextNo };
    }
  }

  const wantedGuid = String(payload.Verification_GUID || payload.verificationGuid || '').trim();
  const takenGuid = existing.some(c =>
    String(c.verificationGuid || c.Verification_GUID || '').trim().toLowerCase() === wantedGuid.toLowerCase()
  );
  if (!wantedGuid || takenGuid) {
    const fresh = `ESS-VER-${require('crypto').randomBytes(6).toString('hex').toUpperCase()}`;
    out.Verification_GUID = fresh;
    out.verificationGuid = fresh;
    reassigned.verificationGuid = { requested: wantedGuid, assigned: fresh };
  }

  return { payload: out, reassigned };
};

router.post('/certificates', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Certificates) {
        return res.status(403).json({ error: 'You do not have permission to generate certificates. Contact Admin.' });
      }
    }

    const existing = await sheetsService.getAllCertificates();
    const { payload, reassigned } = ensureUniqueCertificateIdentity(req.body, existing);
    if (Object.keys(reassigned).length > 0) {
      console.warn('Certificate identity reassigned on save:', JSON.stringify(reassigned));
    }

    const newCert = await sheetsService.insertRow('Document_Registry', {
      ...payload,
      // Brings this row under the partial unique index on Certificate_No (sheetsService.ensureIndexes).
      // Set only here, so the 34 legacy rows that share a number stay outside the index and keep
      // their numbers, while nothing issued from now on can duplicate one.
      Number_Locked: true,
      Created_By: payload.Created_By || req.user.name || req.user.staffId || 'Unknown',
      Created_By_Role: payload.Created_By_Role || req.user.role || 'Staff',
      Created_At: payload.Created_At || new Date().toISOString()
    });

    // Close the loop back to the source challan. Delivery_Challan_Master.Linked_Certificate_Guids
    // was initialised but never written, so the challan register could not tell whether the
    // certificates it was raised for actually exist. Best-effort: a failed back-link must never
    // lose the certificate itself, which is already saved above.
    const sourceChallanId = payload.Source_Challan_ID || payload.sourceChallanId;
    const savedGuid = newCert?.verificationGuid || newCert?.Verification_GUID || payload.verificationGuid;
    if (sourceChallanId && savedGuid) {
      try {
        const challan = await sheetsService.getChallanById(sourceChallanId);
        const linked = Array.isArray(challan?.Linked_Certificate_Guids) ? challan.Linked_Certificate_Guids : [];
        if (challan && !linked.includes(savedGuid)) {
          await sheetsService.updateRow('Delivery_Challan_Master', 'Challan_ID', sourceChallanId, {
            Linked_Certificate_Guids: [...linked, savedGuid]
          });
        }
      } catch (linkErr) {
        console.error('Certificate saved but challan back-link failed:', linkErr.message);
      }
    }

    await interactionLogger.logEvent({
      tag: interactionLogger.EVENT_TAG.CERTIFICATE_GENERATED,
      summary: `${payload.Certificate_No || payload.certificateNo || '(no number)'}`
        + ` | ${payload.formatType || payload.Format_Type || 'Certificate'}`
        + `${payload.validUntil || payload.Valid_Until ? ` | valid until ${payload.validUntil || payload.Valid_Until}` : ''}`,
      taskId: payload.Task_ID || payload.taskId,
      customerId: payload.Customer_ID || payload.customerId,
      actor: req.user
    });

    // `reassigned` lets the page correct what it is showing when the server had to step in.
    res.json({ success: true, certificate: newCert, reassigned });
  } catch (err) {
    console.error('Save certificate failed:', err);
    res.status(500).json({ error: 'Failed to save certificate record' });
  }
});

router.put('/certificates/:guid', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Certificates) {
        return res.status(403).json({ error: 'You do not have permission to update certificates. Contact Admin.' });
      }
    }
    // A certificate's identity is fixed once issued: an edit revises content, it never renumbers a
    // document a customer may already hold. This path had no uniqueness check at all and the client
    // routes every edit-and-resave through it, which is how numbers came to be shared. Strip the
    // identity fields rather than validating them — there is no legitimate reason to change either.
    const { Certificate_No, certificateNo, Verification_GUID, verificationGuid, Number_Locked, ...safeBody } = req.body;
    const attemptedRenumber = Certificate_No !== undefined || certificateNo !== undefined;

    // Deliberately no Certificate_No fallback here. 34 legacy rows share a number, so updating by
    // number would write to whichever duplicate Mongo returned first — silently overwriting a
    // different customer's certificate.
    const updated = await sheetsService.updateRow('Document_Registry', 'verificationGuid', req.params.guid, safeBody);
    if (!updated) return res.status(404).json({ error: 'Certificate not found' });

    res.json({
      success: true,
      certificate: updated,
      // Surfaced so the page can tell the user why the number it posted did not stick.
      ...(attemptedRenumber ? { numberLocked: true } : {})
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update certificate' });
  }
});

// Soft delete: certificates are never hard-removed from Document_Registry. A deleted
// certificate's QR verification link (already printed on physical documents) must keep
// resolving — see the /api/verify-certificate/:guid "revoked" branch in server.js — instead
// of falsely reading as fraudulent/nonexistent to whoever scans it.
router.delete('/certificates/:guid', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Certificates) {
        return res.status(403).json({ error: 'You do not have permission to delete certificates. Contact Admin.' });
      }
    }
    const certs = await sheetsService.getAllCertificates();
    const target = certs.find(c =>
      c.verificationGuid === req.params.guid || c.Verification_GUID === req.params.guid ||
      c.Certificate_No === req.params.guid || c.certificateNo === req.params.guid
    );
    if (!target) return res.status(404).json({ error: 'Certificate not found' });
    const idColumn = target.verificationGuid ? 'verificationGuid'
      : target.Verification_GUID ? 'Verification_GUID'
      : target.Certificate_No ? 'Certificate_No'
      : 'certificateNo';
    const updated = await sheetsService.updateRow('Document_Registry', idColumn, target[idColumn], {
      Is_Deleted: true,
      Deleted_At: new Date().toISOString(),
      Deleted_By: req.user.name || req.user.staffId || 'Unknown'
    });
    res.json({ success: true, certificate: updated });
  } catch (err) {
    console.error('Delete certificate failed:', err);
    res.status(500).json({ error: 'Failed to delete certificate: ' + err.message });
  }
});

// Admin-only recovery of a soft-deleted certificate.
router.post('/certificates/:guid/restore', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to restore certificates' });
    }
    const certs = await sheetsService.getAllCertificates();
    const target = certs.find(c =>
      c.verificationGuid === req.params.guid || c.Verification_GUID === req.params.guid ||
      c.Certificate_No === req.params.guid || c.certificateNo === req.params.guid
    );
    if (!target) return res.status(404).json({ error: 'Certificate not found' });
    const idColumn = target.verificationGuid ? 'verificationGuid'
      : target.Verification_GUID ? 'Verification_GUID'
      : target.Certificate_No ? 'Certificate_No'
      : 'certificateNo';
    const updated = await sheetsService.updateRow('Document_Registry', idColumn, target[idColumn], {
      Is_Deleted: false,
      Deleted_At: null,
      Deleted_By: null,
      Restored_At: new Date().toISOString(),
      Restored_By: req.user.name || req.user.staffId || 'Unknown'
    });
    res.json({ success: true, certificate: updated });
  } catch (err) {
    console.error('Restore certificate failed:', err);
    res.status(500).json({ error: 'Failed to restore certificate' });
  }
});

// --- SERVICE REPORTS ENDPOINTS ---
// By default returns only non-deleted reports (matches every existing caller). Pass
// ?deletedOnly=true for the Admin "Recycle Bin" recovery view.
router.get('/service-reports', async (req, res) => {
  try {
    const reports = await sheetsService.getAllServiceReports();
    const wantDeleted = req.query.deletedOnly === 'true';
    res.json(reports.filter(r => Boolean(r.Is_Deleted) === wantDeleted));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch service reports' });
  }
});

// Due-date / sub-type-capacity counts / Not-OK punch list — the Statistics/Summary feature.
// Registered before the /:id route below so "stats" is never swallowed as a Report_ID lookup.
router.get('/service-reports/stats', async (req, res) => {
  try {
    const { reportType, subType, customerId, from, to, notOkOnly } = req.query;
    const stats = await computeServiceReportStats({
      reportType,
      subType,
      customerId,
      from,
      to,
      notOkOnly: notOkOnly === 'true' || notOkOnly === '1'
    });
    res.json(stats);
  } catch (err) {
    console.error('Service report stats failed:', err);
    res.status(500).json({ error: 'Failed to compute service report statistics' });
  }
});

router.get('/service-reports/:id', async (req, res) => {
  try {
    const reports = await sheetsService.getAllServiceReports();
    const report = reports.find(r => String(r.Report_ID) === String(req.params.id) || String(r._id) === String(req.params.id));
    if (!report) return res.status(404).json({ error: 'Service report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch service report' });
  }
});

router.post('/service-reports', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Service_Reports) {
        return res.status(403).json({ error: 'You do not have permission to create service reports. Contact Admin.' });
      }
    }
    const reportData = {
      ...req.body,
      Report_ID: req.body.Report_ID || `SR-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
      Status: req.body.Status || 'Pending Approval',
      Created_At: new Date().toISOString(),
      Created_By: req.user.name || req.user.staffId || 'Technician'
    };
    const newReport = await sheetsService.insertRow('Service_Reports', reportData);
    res.json({ success: true, report: newReport });
  } catch (err) {
    console.error('Create service report failed:', err);
    res.status(500).json({ error: 'Failed to save service report' });
  }
});

router.put('/service-reports/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Service_Reports) {
        return res.status(403).json({ error: 'You do not have permission to update service reports. Contact Admin.' });
      }
    }
    const updated = await sheetsService.updateRow('Service_Reports', 'Report_ID', req.params.id, {
      ...req.body,
      Updated_At: new Date().toISOString(),
      Last_Edited_By: req.user.name || req.user.role || 'User'
    });
    if (!updated) return res.status(404).json({ error: 'Service report not found' });
    res.json({ success: true, report: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update service report' });
  }
});

router.put('/service-reports/:id/status', async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const updatePayload = {
      Status: status,
      Approval_Remarks: remarks || '',
      Reviewed_By: req.user.name || req.user.role || 'Admin',
      Reviewed_At: new Date().toISOString()
    };
    const updated = await sheetsService.updateRow('Service_Reports', 'Report_ID', req.params.id, updatePayload);
    if (!updated) return res.status(404).json({ error: 'Service report not found' });
    res.json({ success: true, report: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update report status' });
  }
});

// Soft delete: service reports are never hard-removed, same convention as certificates
// (see DELETE /certificates/:guid above) — sets Is_Deleted/Deleted_At/Deleted_By and the
// record just drops out of the default GET /api/service-reports list.
router.delete('/service-reports/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Service_Reports) {
        return res.status(403).json({ error: 'You do not have permission to delete service reports. Contact Admin.' });
      }
    }
    const updated = await sheetsService.updateRow('Service_Reports', 'Report_ID', req.params.id, {
      Is_Deleted: true,
      Deleted_At: new Date().toISOString(),
      Deleted_By: req.user.name || req.user.staffId || 'Unknown'
    });
    if (!updated) return res.status(404).json({ error: 'Service report not found' });
    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Delete service report failed:', err);
    res.status(500).json({ error: 'Failed to delete service report: ' + err.message });
  }
});

// Admin-only recovery of a soft-deleted service report.
router.post('/service-reports/:id/restore', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to restore service reports' });
    }
    const updated = await sheetsService.updateRow('Service_Reports', 'Report_ID', req.params.id, {
      Is_Deleted: false,
      Deleted_At: null,
      Deleted_By: null,
      Restored_At: new Date().toISOString(),
      Restored_By: req.user.name || req.user.staffId || 'Unknown'
    });
    if (!updated) return res.status(404).json({ error: 'Service report not found' });
    res.json({ success: true, report: updated });
  } catch (err) {
    console.error('Restore service report failed:', err);
    res.status(500).json({ error: 'Failed to restore service report' });
  }
});

// --- CLIENT EQUIPMENT MASTER INVENTORY ENDPOINTS ---
// Records written before report types existed carry no Report_Type and are all extinguisher data.
const DEFAULT_CLIENT_EQUIPMENT_TYPE = 'FIRE_EXTINGUISHER';

const matchesClientEquipment = (row, customerId, reportType) => {
  const rowCustomer = String(row.Customer_ID || row.customerId || '').toLowerCase();
  const rowType = String(row.Report_Type || DEFAULT_CLIENT_EQUIPMENT_TYPE).toUpperCase();
  return rowCustomer === String(customerId).toLowerCase() && rowType === String(reportType).toUpperCase();
};

router.get('/client-equipment/:customerId', async (req, res) => {
  try {
    const reportType = req.query.reportType || DEFAULT_CLIENT_EQUIPMENT_TYPE;
    const rows = await sheetsService.getTab('Client_Equipment_Master');
    res.json(rows.filter(x => matchesClientEquipment(x, req.params.customerId, reportType)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch client equipment master' });
  }
});

// Upsert: one equipment list per customer per report type. This previously inserted a new row on
// every save, so the collection accumulated a duplicate per save and readers had to take the last
// match to find current data.
router.post('/client-equipment/:customerId', async (req, res) => {
  try {
    const { items, reportType } = req.body;
    const customerId = req.params.customerId;
    const type = String(reportType || DEFAULT_CLIENT_EQUIPMENT_TYPE).toUpperCase();

    const rows = await sheetsService.getTab('Client_Equipment_Master');
    const existing = rows.filter(x => matchesClientEquipment(x, customerId, type)).pop();

    const payload = {
      Customer_ID: customerId,
      Report_Type: type,
      items: items || [],
      Updated_At: new Date().toISOString()
    };

    if (existing && existing.id) {
      const updated = await sheetsService.updateRow('Client_Equipment_Master', 'id', existing.id, payload);
      return res.json({ success: true, record: updated, created: false });
    }

    const inserted = await sheetsService.insertRow('Client_Equipment_Master', {
      id: `CEQ_${Date.now()}`,
      ...payload
    });
    res.json({ success: true, record: inserted, created: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save client equipment master' });
  }
});

// One call for every equipment family a client has on file, keyed by Report_Type — used by the
// Field Visit flow to decide which family tabs to show and to build the merged cross-type search
// index, instead of one request per family via ?reportType=.
router.get('/client-equipment/:customerId/all', async (req, res) => {
  try {
    const rows = await sheetsService.getTab('Client_Equipment_Master');
    const customerId = req.params.customerId;
    const byType = {};
    rows
      .filter(x => String(x.Customer_ID || x.customerId || '').toLowerCase() === String(customerId).toLowerCase())
      .forEach(row => {
        const type = String(row.Report_Type || DEFAULT_CLIENT_EQUIPMENT_TYPE).toUpperCase();
        // Keep the latest record per type, matching the single-type endpoint's "take the last match".
        byType[type] = row.items || [];
      });
    res.json(byType);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch client equipment for all report types' });
  }
});

// --- FIELD VISITS: groups the sibling per-family Service_Reports one field visit produces ---
router.post('/field-visits', async (req, res) => {
  try {
    const { Customer_ID } = req.body;
    if (!Customer_ID) return res.status(400).json({ error: 'Customer_ID is required' });
    const visit = {
      Visit_ID: `VISIT_${Date.now()}`,
      Customer_ID,
      Staff_ID: req.user.staffId || req.user.name || 'Technician',
      Status: 'IN_PROGRESS',
      Started_At: new Date().toISOString(),
      reportIds: []
    };
    const inserted = await sheetsService.insertRow('Field_Visits', visit);
    res.json({ success: true, visit: inserted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start field visit' });
  }
});

router.get('/field-visits/:id', async (req, res) => {
  try {
    const rows = await sheetsService.getTab('Field_Visits');
    const visit = rows.find(v => String(v.Visit_ID) === String(req.params.id));
    if (!visit) return res.status(404).json({ error: 'Field visit not found' });
    res.json(visit);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch field visit' });
  }
});

router.put('/field-visits/:id', async (req, res) => {
  try {
    const patch = { ...req.body };
    if (patch.Status === 'COMPLETED' && !patch.Completed_At) patch.Completed_At = new Date().toISOString();
    const updated = await sheetsService.updateRow('Field_Visits', 'Visit_ID', req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Field visit not found' });
    res.json({ success: true, visit: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update field visit' });
  }
});

router.get('/equipment-master', async (req, res) => {
  try {
    const items = await sheetsService.getEquipmentMaster();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch equipment master' });
  }
});

router.post('/equipment-master', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    const { name, variants } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Item name is required' });
    const newItem = {
      id: 'eq-' + Date.now(),
      type: name.trim(),
      capacities: Array.isArray(variants) ? variants : (variants || '').split(',').map(v => v.trim()).filter(Boolean)
    };
    await sheetsService.insertRow('Equipment_Master', newItem);
    res.json({ success: true, item: newItem });
  } catch (err) {
    console.error('Create equipment master item failed:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

router.put('/equipment-master/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    const { name, variants } = req.body;
    const updateData = {
      type: name ? name.trim() : undefined,
      capacities: Array.isArray(variants) ? variants : (variants || '').split(',').map(v => v.trim()).filter(Boolean)
    };
    if (updateData.type === undefined) delete updateData.type;
    const updated = await sheetsService.updateRow('Equipment_Master', 'id', req.params.id, updateData);
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

router.delete('/equipment-master/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    await sheetsService.deleteRow('Equipment_Master', 'id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// --- TASK TAGS (dynamic, admin-editable, multi-select labels e.g. "New Inquiry", "Site Visit") ---
router.get('/tags', async (req, res) => {
  try {
    const tags = await sheetsService.getAllTags();
    res.json(tags);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

router.post('/tags', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tag name is required' });
    const newTag = {
      Tag_ID: 'tag-' + Date.now(),
      name: name.trim(),
      color: color || '#6366f1'
    };
    await sheetsService.insertRow('Tag_Master', newTag);
    res.json({ success: true, tag: newTag });
  } catch (err) {
    console.error('Create tag failed:', err);
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

router.put('/tags/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    const { name, color } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (color !== undefined) updateData.color = color;
    const updated = await sheetsService.updateRow('Tag_Master', 'Tag_ID', req.params.id, updateData);
    if (!updated) return res.status(404).json({ error: 'Tag not found' });
    res.json({ success: true, tag: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tag' });
  }
});

router.delete('/tags/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    await sheetsService.deleteRow('Tag_Master', 'Tag_ID', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// --- CERTIFICATE TYPES (admin-defined custom certificate categories, in addition to the 7 built-in ones) ---
// The 7 built-in types (Refilling, HP Testing, New Fire Extinguisher, System Installation,
// AMC Certificate, Visit Report, Training Certificate) are hardcoded client-side and never stored
// here — this collection only holds admin-added custom types. A type's `name` IS its identifier
// (same convention as the built-in types: no separate id-to-name indirection anywhere else in the
// certificate flow), so names must be unique against both the built-ins and each other.
const BUILT_IN_CERTIFICATE_TYPES = ['Refilling', 'HP Testing', 'New Fire Extinguisher', 'System Installation', 'AMC Certificate', 'Visit Report', 'Training Certificate'];

router.get('/certificate-types', async (req, res) => {
  try {
    const types = await sheetsService.getAllCertificateTypes();
    res.json(types);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch certificate types' });
  }
});

router.post('/certificate-types', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    const { name, icon, generateRefillingDue } = req.body;
    const trimmedName = (name || '').trim();
    if (!trimmedName) return res.status(400).json({ error: 'Certificate type name is required' });
    const existingTypes = await sheetsService.getAllCertificateTypes();
    const nameTaken = BUILT_IN_CERTIFICATE_TYPES.some(t => t.toLowerCase() === trimmedName.toLowerCase())
      || existingTypes.some(t => (t.name || '').toLowerCase() === trimmedName.toLowerCase());
    if (nameTaken) return res.status(400).json({ error: 'A certificate type with this name already exists' });
    const newType = {
      Type_ID: 'ct-' + Date.now(),
      name: trimmedName,
      icon: (icon || '📄').trim(),
      generateRefillingDue: !!generateRefillingDue,
      createdAt: new Date().toISOString()
    };
    await sheetsService.insertRow('Certificate_Type_Master', newType);
    res.json({ success: true, type: newType });
  } catch (err) {
    console.error('Create certificate type failed:', err);
    res.status(500).json({ error: 'Failed to create certificate type' });
  }
});

router.delete('/certificate-types/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    await sheetsService.deleteRow('Certificate_Type_Master', 'Type_ID', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete certificate type' });
  }
});


// --- STAFF MASTER ---
router.get('/staff', async (req, res) => {
  try {
    const staff = await sheetsService.getAllStaff();
    const cleanStaff = staff.map(({ Password, ...rest }) => rest);
    res.json(cleanStaff);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch staff list' });
  }
});

router.post('/staff', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to create staff' });
    }
    const { name, email, mobile, role, department, dailySalaryRate, permissions, password } = req.body;
    if (!name) return res.status(400).json({ error: 'Staff name is required' });

    // New accounts used to default to 'staff123' when no password was supplied. Combined with the
    // login bypass that has since been removed, that made every new hire's account guessable from
    // their staff ID alone. An explicit password meeting the standard policy is now required.
    if (!password) {
      return res.status(400).json({ error: 'An initial password is required when creating staff.' });
    }
    const policyError = validatePasswordPolicy(password);
    if (policyError) return res.status(400).json({ error: policyError });

    const allStaff = await sheetsService.getAllStaff();
    const nextIdNum = allStaff.length + 1;
    const newStaff = {
      Staff_ID: `STAFF00${nextIdNum}`,
      Name: name,
      Mobile: mobile ? (mobile.startsWith('+') ? mobile : `+91 ${mobile}`) : '+91 90000 00000',
      Email: email || `${name.toLowerCase().replace(/\s+/g, '.')}@expertsafety.in`,
      Password: bcrypt.hashSync(password, 8),
      Role: role || 'Staff',
      Department: department || 'Field Operations',
      Status: 'Active',
      Daily_Salary_Rate: Number(dailySalaryRate || 1000),
      Permissions: permissions || 'ASSIGNED_ONLY'
    };
    await sheetsService.insertRow('Staff_Master', newStaff);
    const { Password, ...clean } = newStaff;
    res.json({ success: true, staff: clean });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create new staff member' });
  }
});

router.patch('/staff/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Staff member not found' });
    const { Password, ...clean } = updated;
    res.json({ success: true, staff: clean });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update staff profile' });
  }
});

router.delete('/staff/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const deleted = await sheetsService.deleteRow('Staff_Master', 'Staff_ID', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Staff member not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

router.put('/staff/:id/task-order', async (req, res) => {
  try {
    if (req.user.role !== 'Admin' && req.user.staffId !== req.params.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { taskOrder } = req.body;
    if (!Array.isArray(taskOrder)) {
      return res.status(400).json({ error: 'taskOrder must be an array of Task_IDs' });
    }
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.id, { Task_Order: taskOrder });
    if (!updated) return res.status(404).json({ error: 'Staff member not found' });
    const { Password, ...clean } = updated;
    res.json({ success: true, staff: clean });
  } catch (err) {
    console.error('Update task order error:', err);
    res.status(500).json({ error: 'Failed to update task order' });
  }
});

// ADMIN OVERRIDE: set a NEW password directly for any staff/admin account.
// Requires the acting Admin's own password as confirmation (does not need the target's old password).
router.put('/staff/:id/set-password', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { adminPassword, newPassword, confirmPassword } = req.body;
    if (!adminPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Your admin password, new password, and confirmation are all required' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }
    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) return res.status(400).json({ error: policyError });

    const adminStaff = await sheetsService.getStaffById(req.user.staffId);
    if (!adminStaff || !verifyStaffPassword(adminStaff, adminPassword)) {
      return res.status(401).json({ error: 'Your admin password is incorrect' });
    }

    const targetStaff = await sheetsService.getStaffById(req.params.id);
    if (!targetStaff) return res.status(404).json({ error: 'Staff member not found' });

    const hashed = bcrypt.hashSync(newPassword, 8);
    await sheetsService.updateRow('Staff_Master', 'Staff_ID', targetStaff.Staff_ID, { Password: hashed });
    res.json({ success: true });
  } catch (err) {
    console.error('Admin set-password error:', err);
    res.status(500).json({ error: 'Failed to set password' });
  }
});

// STAFF PROFILE PHOTO UPLOAD REQUEST (Requires Admin Approval)
router.post('/staff/profile-photo-request', async (req, res) => {
  try {
    const { photoDataUrl } = req.body;
    if (!photoDataUrl) return res.status(400).json({ error: 'Photo data required' });
    const staffId = req.user.staffId || req.user.Staff_ID || req.user.id;
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', staffId, {
      Pending_Photo_Request: photoDataUrl,
      Photo_Status: 'Pending Approval'
    });
    if (!updated) return res.status(404).json({ error: 'Staff member not found: ' + staffId });
    const { Password, ...clean } = updated;
    res.json({ success: true, message: 'Profile photo request submitted for Admin approval!', staff: clean });
  } catch (err) {
    console.error('Profile photo request error:', err);
    res.status(500).json({ error: 'Failed to submit profile photo request: ' + err.message });
  }
});

// ADMIN APPROVE OR REJECT STAFF PHOTO REQUEST
router.put('/staff/:id/photo-approve', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { action, directPhotoUrl } = req.body; // 'APPROVE' or 'REJECT'
    const staffList = await sheetsService.getAllStaff();
    const target = staffList.find(s => s.Staff_ID === req.params.id);
    if (!target) return res.status(404).json({ error: 'Staff member not found' });

    let updateData = {};
    if (action === 'APPROVE') {
      const photoToApprove = directPhotoUrl || target.Pending_Photo_Request || target.Profile_Photo || '';
      if (!photoToApprove) {
        return res.status(400).json({ error: 'No pending photo found to approve' });
      }
      updateData = {
        Profile_Photo: photoToApprove,
        Pending_Photo_Request: '',
        Photo_Status: 'Approved'
      };
    } else {
      updateData = {
        Pending_Photo_Request: '',
        Photo_Status: 'Rejected'
      };
    }
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.id, updateData);
    const { Password, ...clean } = (updated || target);

    pushService.notifyStaff(req.params.id, {
      type: pushService.NOTIFICATION_TYPES.PHOTO_ICARD_APPROVAL,
      title: `Profile Photo ${updateData.Photo_Status}`,
      body: `Your profile photo request was ${updateData.Photo_Status.toLowerCase()}.`,
      url: '/',
      tag: `photo-${req.params.id}`
    });

    res.json({ success: true, staff: clean });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process photo approval' });
  }
});

// ADMIN DIRECT SET PROFILE PHOTO
router.put('/staff/:id/photo-direct', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { photoDataUrl } = req.body;
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.id, {
      Profile_Photo: photoDataUrl,
      Pending_Photo_Request: '',
      Photo_Status: 'Approved'
    });
    const { Password, ...clean } = updated;
    res.json({ success: true, staff: clean });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set profile photo' });
  }
});

// STAFF ID-CARD REPROGRAM/EDIT REQUEST (Requires Admin Approval unless requester is Admin)
router.post('/staff/icard-request', async (req, res) => {
  try {
    const { dob, bloodGroup, emergencyContact, aadharNo } = req.body;
    const staffId = req.user.staffId || req.user.Staff_ID || req.user.id;
    
    let updateData = {};
    if (req.user.role === 'Admin') {
      // Admin gets direct modification rights
      updateData = {
        DOB: dob,
        Blood_Group: bloodGroup,
        Emergency_Contact: emergencyContact,
        Aadhar_No: aadharNo || '',
        Pending_ICard_DOB: '',
        Pending_ICard_Blood_Group: '',
        Pending_ICard_Emergency_Contact: '',
        Pending_ICard_Aadhar_No: '',
        ICard_Status: 'Approved'
      };
    } else {
      // Staff gets pending validation request
      updateData = {
        Pending_ICard_DOB: dob,
        Pending_ICard_Blood_Group: bloodGroup,
        Pending_ICard_Emergency_Contact: emergencyContact,
        Pending_ICard_Aadhar_No: aadharNo || '',
        ICard_Status: 'Pending Approval'
      };
    }
    
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', staffId, updateData);
    if (!updated) return res.status(404).json({ error: 'Staff member not found: ' + staffId });
    const { Password, ...clean } = updated;
    res.json({ success: true, message: req.user.role === 'Admin' ? 'ID Card updated!' : 'ID Card request submitted for Admin approval!', staff: clean });
  } catch (err) {
    console.error('I-Card request error:', err);
    res.status(500).json({ error: 'Failed to submit ID Card request: ' + err.message });
  }
});

// ADMIN APPROVE OR REJECT STAFF I-CARD REQUEST OR DIRECTLY MODIFY IT
router.put('/staff/:id/icard-approve', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { action, dob, bloodGroup, emergencyContact, aadharNo } = req.body; // action: 'APPROVE', 'REJECT', or 'DIRECT_EDIT'
    const staffList = await sheetsService.getAllStaff();
    const target = staffList.find(s => s.Staff_ID === req.params.id);
    if (!target) return res.status(404).json({ error: 'Staff member not found' });

    let updateData = {};
    if (action === 'APPROVE') {
      updateData = {
        DOB: target.Pending_ICard_DOB || target.DOB || '',
        Blood_Group: target.Pending_ICard_Blood_Group || target.Blood_Group || '',
        Emergency_Contact: target.Pending_ICard_Emergency_Contact || target.Emergency_Contact || '',
        Aadhar_No: target.Pending_ICard_Aadhar_No || target.Aadhar_No || '',
        Pending_ICard_DOB: '',
        Pending_ICard_Blood_Group: '',
        Pending_ICard_Emergency_Contact: '',
        Pending_ICard_Aadhar_No: '',
        ICard_Status: 'Approved'
      };
    } else if (action === 'REJECT') {
      updateData = {
        Pending_ICard_DOB: '',
        Pending_ICard_Blood_Group: '',
        Pending_ICard_Emergency_Contact: '',
        Pending_ICard_Aadhar_No: '',
        ICard_Status: 'Rejected'
      };
    } else if (action === 'DIRECT_EDIT') {
      updateData = {
        DOB: dob,
        Blood_Group: bloodGroup,
        Emergency_Contact: emergencyContact,
        Aadhar_No: aadharNo || '',
        Pending_ICard_DOB: '',
        Pending_ICard_Blood_Group: '',
        Pending_ICard_Emergency_Contact: '',
        Pending_ICard_Aadhar_No: '',
        ICard_Status: 'Approved'
      };
    } else {
      return res.status(400).json({ error: 'Invalid action type' });
    }

    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.id, updateData);
    const { Password, ...clean } = (updated || target);

    if (action === 'APPROVE' || action === 'REJECT') {
      pushService.notifyStaff(req.params.id, {
        type: pushService.NOTIFICATION_TYPES.PHOTO_ICARD_APPROVAL,
        title: `I-Card Request ${updateData.ICard_Status}`,
        body: `Your I-Card update request was ${updateData.ICard_Status.toLowerCase()}.`,
        url: '/',
        tag: `icard-${req.params.id}`
      });
    }

    res.json({ success: true, staff: clean });
  } catch (err) {
    console.error('I-Card approve error:', err);
    res.status(500).json({ error: 'Failed to process ID Card update' });
  }
});

router.patch('/staff/salary-rate', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { staffId, dailySalaryRate } = req.body;
    if (!staffId || dailySalaryRate === undefined) {
      return res.status(400).json({ error: 'staffId and dailySalaryRate required' });
    }
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', staffId, {
      Daily_Salary_Rate: Number(dailySalaryRate)
    });
    if (!updated) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json({ success: true, staff: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update daily salary rate' });
  }
});

router.put('/staff/salary-rate', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { staffId, dailySalaryRate } = req.body;
    if (!staffId || dailySalaryRate === undefined) {
      return res.status(400).json({ error: 'staffId and dailySalaryRate required' });
    }
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', staffId, {
      Daily_Salary_Rate: Number(dailySalaryRate)
    });
    if (!updated) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json({ success: true, staff: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update daily salary rate' });
  }
});

// --- NOTIFICATIONS SUMMARY ---
router.get('/notifications/my', async (req, res) => {
  try {
    const staffId = req.user.staffId || req.user.Staff_ID || req.user.id;
    const role = req.user.role || req.user.Role;
    const [tasks, leaves, staffList, advances, serviceReports, certificates] = await Promise.all([
      sheetsService.getAllTasks(),
      sheetsService.getAllLeaves(),
      sheetsService.getAllStaff(),
      sheetsService.getAdvances(),
      role === 'Admin' ? sheetsService.getAllServiceReports() : Promise.resolve([]),
      role === 'Admin' ? sheetsService.getAllCertificates() : Promise.resolve([])
    ]);

    const notifications = [];

    if (role === 'Admin') {
      const pendingLeaves = leaves.filter(l => l.Status === 'Pending');
      pendingLeaves.forEach(l => {
        notifications.push({
          id: `leave-${l.Request_ID}`,
          title: 'Leave Request Pending',
          message: `${l.Staff_Name || l.Staff_ID} applied for leave (${l.Start_Date || l.Leave_Date} to ${l.End_Date || l.Leave_Date})`,
          time: l.Applied_At || 'Recently',
          type: 'APPROVAL_NEEDED',
          targetId: l.Request_ID,
          targetType: 'LEAVE',
          action: 'REVIEW_LEAVE'
        });
      });

      // Leave reminders: show in notification 3 days before (and within 3 days leading up to) the leave date to admin for reminder purpose
      leaves.forEach(l => {
        if (l.Status !== 'Rejected') {
          const leaveDateStr = l.Start_Date || l.Leave_Date || '';
          if (leaveDateStr) {
            let leaveDate;
            if (/^\d{4}-\d{2}-\d{2}/.test(leaveDateStr)) {
              const p = leaveDateStr.split('T')[0].split('-');
              leaveDate = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
            } else if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(leaveDateStr.trim())) {
              const p = leaveDateStr.trim().split(/[\/\-\s]/);
              leaveDate = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
            } else {
              leaveDate = new Date(leaveDateStr);
            }

            if (!isNaN(leaveDate)) {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              leaveDate.setHours(0, 0, 0, 0);
              const diffDays = Math.round((leaveDate - today) / (1000 * 60 * 60 * 24));

              if (diffDays >= 0 && diffDays <= 3) {
                const dayLabel = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : `in ${diffDays} days`;
                notifications.push({
                  id: `leavereminder-${l.Request_ID}`,
                  title: 'Upcoming Leave Reminder',
                  message: `Reminder: Staff ${l.Staff_Name || l.Staff_ID} has scheduled leave starting ${dayLabel} (${leaveDateStr}) [Status: ${l.Status}]`,
                  time: `${diffDays === 0 ? 'Today' : `${diffDays}d away`}`,
                  type: 'ALERT',
                  targetId: l.Request_ID,
                  targetType: 'LEAVE',
                  action: 'LEAVE_REMINDER'
                });
              }
            }
          }
        }
      });

      const pendingPhotos = staffList.filter(s => s.Photo_Status === 'Pending Approval' || (s.Pending_Photo_Request && s.Pending_Photo_Request !== ''));
      pendingPhotos.forEach(s => {
        notifications.push({
          id: `photo-${s.Staff_ID}`,
          title: 'Profile Photo Approval Required',
          message: `${s.Name} uploaded a new profile photo waiting for review.`,
          time: 'Pending',
          type: 'APPROVAL_NEEDED',
          targetId: s.Staff_ID,
          targetType: 'STAFF',
          action: 'REVIEW_PHOTO'
        });
      });

      const removalTasks = tasks.filter(t => t.Status === 'Removal Requested');
      removalTasks.forEach(t => {
        notifications.push({
          id: `removal-${t.Task_ID}`,
          title: 'Task Removal Requested',
          message: `${t.Customer_Name || 'Client'}: Staff requested removal of task ${t.Task_ID}`,
          time: 'Action Required',
          type: 'ALERT',
          targetId: t.Task_ID,
          targetType: 'TASK',
          action: 'REMOVAL_REQUEST'
        });
      });

      const pendingAdvances = (advances || []).filter(a => a.Status === 'Pending');
      pendingAdvances.forEach(a => {
        notifications.push({
          id: `adv-${a.Advance_ID}`,
          title: 'Salary Advance Request',
          message: `${a.Staff_Name || a.Staff_ID} requested ₹${a.Amount}`,
          time: a.Requested_At || 'Recently',
          type: 'APPROVAL_NEEDED',
          targetId: a.Advance_ID,
          targetType: 'ADVANCE',
          action: 'REVIEW_ADVANCE'
        });
      });

      // Service reports staff have submitted and are still awaiting Admin review — every report
      // defaults to 'Pending Approval' on creation (POST /service-reports), so this naturally
      // covers every new submission until Admin approves/requests revision.
      const pendingReports = (serviceReports || []).filter(r => !r.Is_Deleted && r.Status === 'Pending Approval');
      pendingReports.forEach(r => {
        notifications.push({
          id: `srpending-${r.Report_ID}`,
          title: 'Service Report Submitted',
          message: `${r.Created_By || 'A technician'} submitted a report for ${r.Customer_Name || r.customerName || 'a client'} — awaiting your approval.`,
          time: r.Created_At || 'Recently',
          type: 'APPROVAL_NEEDED',
          targetId: r.Report_ID,
          targetType: 'SERVICE_REPORT',
          action: 'REVIEW_SERVICE_REPORT'
        });
      });

      // Certificates a non-Admin staff member generated in the last 48 hours — an FYI (there's no
      // approval gate on certificate generation itself, unlike service reports), so Admin still
      // sees what staff have been issuing without needing to act on it.
      const recentStaffCerts = (certificates || []).filter(c => {
        if (c.Is_Deleted) return false;
        if ((c.Created_By_Role || 'Staff') === 'Admin') return false;
        const createdAt = c.Created_At ? new Date(c.Created_At) : null;
        if (!createdAt || isNaN(createdAt.getTime())) return false;
        return (Date.now() - createdAt.getTime()) <= 48 * 60 * 60 * 1000;
      });
      recentStaffCerts.forEach(c => {
        notifications.push({
          id: `cert-${c.verificationGuid || c.Verification_GUID || c.Certificate_No}`,
          title: 'Certificate Generated by Staff',
          message: `${c.Created_By || 'A staff member'} generated certificate ${c.Certificate_No || c.certificateNo} for ${c.Customer_Name || c.customerName || 'a client'}.`,
          time: c.Created_At || 'Recently',
          type: 'INFO',
          targetId: c.verificationGuid || c.Verification_GUID || c.Certificate_No,
          targetType: 'CERTIFICATE',
          action: 'VIEW_CERTIFICATE'
        });
      });
    } else {
      const cleanStaffId = String(staffId || '').trim().toLowerCase();
      const myTasks = tasks.filter(t => String(t.Assigned_Staff || '').trim().toLowerCase() === cleanStaffId);
      myTasks.slice(-5).reverse().forEach(t => {
        notifications.push({
          id: `task-${t.Task_ID}_${t.Status || 'Pending'}`,
          title: 'Scheduled Work Update',
          message: `Assigned: ${t.Customer_Name || 'Client'} — ${t.Description || 'Scheduled Work'} (${t.Status})`,
          time: t.Assigned_Date || 'Recently',
          type: 'TASK',
          targetId: t.Task_ID,
          targetType: 'TASK',
          action: 'VIEW_TASK'
        });
      });

      const myLeaves = leaves.filter(l => String(l.Staff_ID || '').trim().toLowerCase() === cleanStaffId && l.Status !== 'Pending');
      myLeaves.slice(-5).reverse().forEach(l => {
        notifications.push({
          id: `myleave-${l.Request_ID}_${l.Status}`,
          title: `Leave Application ${l.Status}`,
          message: `Your leave application for ${l.Start_Date || l.Leave_Date} has been ${l.Status.toLowerCase()} by Admin.`,
          time: l.Reviewed_At || 'Recently',
          type: l.Status === 'Approved' ? 'SUCCESS' : 'ALERT',
          targetId: l.Request_ID,
          targetType: 'LEAVE',
          action: 'VIEW_LEAVE'
        });
      });

      const me = staffList.find(s => String(s.Staff_ID || '').trim().toLowerCase() === cleanStaffId);
      if (me && me.Photo_Status === 'Approved' && me.Profile_Photo) {
        notifications.push({
          id: `myphoto-${staffId}`,
          title: 'Profile Photo Approved',
          message: 'Your profile picture upload has been approved by Admin and is now active.',
          time: 'Active',
          type: 'SUCCESS',
          targetId: staffId,
          targetType: 'STAFF',
          action: 'VIEW_PROFILE'
        });
      } else if (me && me.Photo_Status === 'Pending Approval') {
        notifications.push({
          id: `myphoto-pending-${staffId}`,
          title: 'Profile Photo Under Review',
          message: 'Your profile picture upload is currently waiting for Admin approval.',
          time: 'In Progress',
          type: 'INFO',
          targetId: staffId,
          targetType: 'STAFF',
          action: 'VIEW_PROFILE'
        });
      }
    }

    res.json({ success: true, notifications });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// --- CUSTOMER MASTER ---
router.get('/customers', async (req, res) => {
  try {
    const customers = await sheetsService.getAllCustomers();
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

router.post('/customers', async (req, res) => {
  try {
    let formattedContact = req.body.contact || '';
    if (formattedContact && !formattedContact.startsWith('+')) {
      formattedContact = `+91 ${formattedContact}`;
    }

    let coords = req.body.coordinators;
    if (!coords) {
      coords = [{ name: req.body.authPerson || 'Primary Contact', phone: formattedContact, email: req.body.email || '', role: 'Company Coordinator' }];
    } else if (Array.isArray(coords)) {
      coords = coords.map(c => {
        let cp = c.phone || '';
        if (cp && !cp.startsWith('+')) cp = `+91 ${cp}`;
        return { ...c, phone: cp };
      });
    }

    const gstin = gstUtils.normalizeGstin(req.body.gstin);
    const newCustomer = {
      Customer_ID: `CUST${Date.now().toString().slice(-4)}`,
      Company_Name: req.body.companyName || 'New Customer',
      Auth_Person: req.body.authPerson || '',
      Contact: formattedContact,
      Email: req.body.email || '',
      Location_Link: req.body.locationLink || '',
      Address: req.body.address || '',
      GSTIN: gstin,
      // Derived from the GSTIN when present, else the explicitly-picked state (B2C/unregistered
      // buyers have no GSTIN but still need a place of supply for the tax split).
      State_Code: gstin ? gstUtils.extractStateCode(gstin) : String(req.body.stateCode || ''),
      Customer_Type: req.body.customerType || (gstin ? 'B2B' : 'B2C'),
      Billing_Address: req.body.billingAddress || req.body.address || '',
      Shipping_Address: req.body.shippingAddress || '',
      Coordinators: typeof coords === 'string' ? coords : JSON.stringify(coords)
    };
    await sheetsService.insertRow('Customer_Master', newCustomer);
    res.json(newCustomer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

router.post('/customers/bulk', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required for bulk upload' });
    }
    const { customers } = req.body;
    if (!customers || !Array.isArray(customers)) {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    const allCustomers = await sheetsService.getAllCustomers();
    let upsertedCount = 0;

    for (const row of customers) {
      if (!row.Company_Name) continue; // Skip empty rows

      const existingCust = row.Customer_ID 
        ? allCustomers.find(c => c.Customer_ID === row.Customer_ID) 
        : null;

      const rowGstin = gstUtils.normalizeGstin(row.GSTIN || row.Gst_No);
      const rowStateCode = rowGstin ? gstUtils.extractStateCode(rowGstin) : String(row.State_Code || '');

      if (existingCust) {
        await sheetsService.updateRow('Customer_Master', 'Customer_ID', row.Customer_ID, {
          Company_Name: row.Company_Name || existingCust.Company_Name,
          Auth_Person: row.Auth_Person || existingCust.Auth_Person,
          Contact: row.Contact || existingCust.Contact,
          Secondary_Contact: row.Secondary_Contact || existingCust.Secondary_Contact || '',
          Email: row.Email || existingCust.Email,
          Location_Link: row.Location_Link || existingCust.Location_Link,
          Address: row.Address || existingCust.Address,
          GSTIN: rowGstin || existingCust.GSTIN || '',
          State_Code: rowStateCode || existingCust.State_Code || '',
          Customer_Type: row.Customer_Type || existingCust.Customer_Type || (rowGstin ? 'B2B' : 'B2C'),
          Coordinators: row.Coordinators || existingCust.Coordinators
        });
      } else {
        const newCustomer = {
          Customer_ID: row.Customer_ID || `CUST${Date.now().toString().slice(-4)}${upsertedCount}`,
          Company_Name: row.Company_Name,
          Auth_Person: row.Auth_Person || '',
          Contact: row.Contact || '',
          Secondary_Contact: row.Secondary_Contact || '',
          Email: row.Email || '',
          Location_Link: row.Location_Link || '',
          Address: row.Address || '',
          GSTIN: rowGstin,
          State_Code: rowStateCode,
          Customer_Type: row.Customer_Type || (rowGstin ? 'B2B' : 'B2C'),
          Coordinators: row.Coordinators || ''
        };
        await sheetsService.insertRow('Customer_Master', newCustomer);
      }
      upsertedCount++;
    }

    res.json({ success: true, upsertedCount });
  } catch (err) {
    console.error('Bulk upload error:', err);
    res.status(500).json({ error: 'Failed to bulk upload customers' });
  }
});

router.put('/customers/:id', async (req, res) => {
  try {
    let formattedContact = req.body.contact;
    if (formattedContact && !formattedContact.startsWith('+')) {
      formattedContact = `+91 ${formattedContact}`;
    }

    let coords = req.body.coordinators;
    if (coords && Array.isArray(coords)) {
      coords = coords.map(c => {
        let cp = c.phone || '';
        if (cp && !cp.startsWith('+')) cp = `+91 ${cp}`;
        return { ...c, phone: cp };
      });
    }

    const updateData = {
      Company_Name: req.body.companyName,
      Auth_Person: req.body.authPerson,
      Contact: formattedContact,
      Email: req.body.email,
      Location_Link: req.body.locationLink,
      Address: req.body.address,
      Special_Notes: req.body.specialNotes
    };
    if (req.body.gstin !== undefined) {
      const gstin = gstUtils.normalizeGstin(req.body.gstin);
      updateData.GSTIN = gstin;
      if (gstin) updateData.State_Code = gstUtils.extractStateCode(gstin);
    }
    if (req.body.stateCode !== undefined && !updateData.State_Code) {
      updateData.State_Code = String(req.body.stateCode || '');
    }
    if (req.body.customerType !== undefined) updateData.Customer_Type = req.body.customerType;
    if (req.body.billingAddress !== undefined) updateData.Billing_Address = req.body.billingAddress;
    if (req.body.shippingAddress !== undefined) updateData.Shipping_Address = req.body.shippingAddress;
    if (coords) {
      updateData.Coordinators = typeof coords === 'string' ? coords : JSON.stringify(coords);
    }
    const updated = await sheetsService.updateRow('Customer_Master', 'Customer_ID', req.params.id, updateData);
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

router.patch('/customers/:id', async (req, res) => {
  try {
    const updateData = {};
    if (req.body.locationLink !== undefined) updateData.Location_Link = req.body.locationLink;
    if (req.body.Location_Link !== undefined) updateData.Location_Link = req.body.Location_Link;
    if (req.body.companyName !== undefined) updateData.Company_Name = req.body.companyName;
    if (req.body.authPerson !== undefined) updateData.Auth_Person = req.body.authPerson;
    if (req.body.contact !== undefined) updateData.Contact = req.body.contact;
    if (req.body.address !== undefined) updateData.Address = req.body.address;
    if (req.body.gstin !== undefined) {
      const gstin = gstUtils.normalizeGstin(req.body.gstin);
      updateData.GSTIN = gstin;
      if (gstin) updateData.State_Code = gstUtils.extractStateCode(gstin);
    }
    if (req.body.stateCode !== undefined && !updateData.State_Code) {
      updateData.State_Code = String(req.body.stateCode || '');
    }
    if (req.body.customerType !== undefined) updateData.Customer_Type = req.body.customerType;
    if (req.body.billingAddress !== undefined) updateData.Billing_Address = req.body.billingAddress;
    if (req.body.shippingAddress !== undefined) updateData.Shipping_Address = req.body.shippingAddress;

    const updated = await sheetsService.updateRow('Customer_Master', 'Customer_ID', req.params.id, updateData);
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    res.json(updated);
  } catch (err) {
    console.error('Patch customer error:', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// --- CUSTOMER INTERACTIONS LOG ---
router.get('/customer-interactions', async (req, res) => {
  try {
    const interactions = await sheetsService.getTab('Customer_Interactions');
    res.json(interactions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customer interactions' });
  }
});

router.post('/customer-interactions', async (req, res) => {
  try {
    const allStaff = await sheetsService.getAllStaff();
    const staffObj = allStaff.find(s => s.Staff_ID === req.user.staffId) || {};
    const nowMs = Date.now();
    const newInteraction = {
      Interaction_ID: `INT_${nowMs}`,
      Created_At: nowMs,
      Customer_ID: req.body.customerId || '',
      Task_ID: req.body.taskId || '',
      Timestamp: new Date().toISOString(),
      Type: req.body.type || 'Call Logged',
      Staff_ID: req.user.staffId,
      Staff_Name: staffObj.Name || req.body.staffName || req.user.staffId,
      Coordinator_Name: req.body.coordinatorName || '',
      Remarks: req.body.remarks || 'Client contacted'
    };
    await sheetsService.insertRow('Customer_Interactions', newInteraction);
    res.json(newInteraction);
  } catch (err) {
    console.error('Failed to record customer interaction:', err);
    const dbUnavailable = err.name === 'MongooseServerSelectionError' || err.name === 'MongoServerSelectionError';
    res.status(500).json({
      error: dbUnavailable
        ? 'Database temporarily unavailable — please try again in a moment.'
        : 'Failed to record customer interaction'
    });
  }
});

// A remark is a contemporaneous record of a customer conversation, so it stays editable only
// briefly — long enough to fix a typo, not long enough to rewrite history after the fact.
const REMARK_EDIT_WINDOW_MS = 5 * 60 * 1000;

router.put('/customer-interactions/:id', async (req, res) => {
  try {
    const all = await sheetsService.getTab('Customer_Interactions');
    const existing = all.find(i => i.Interaction_ID === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Interaction not found' });

    // System-generated timeline entries mirror task events and must stay faithful to them.
    if (existing.System_Generated) {
      return res.status(403).json({ error: 'System-generated entries cannot be edited.' });
    }

    // Only the author may edit — an Admin editing someone else's logged call would misattribute it.
    if (String(existing.Staff_ID || '') !== String(req.user.staffId || '')) {
      return res.status(403).json({ error: 'You can only edit remarks you posted yourself.' });
    }

    // Created_At is epoch ms; fall back to Timestamp for older rows written before that field.
    const createdMs = Number(existing.Created_At) || Date.parse(existing.Timestamp || '') || 0;
    const ageMs = Date.now() - createdMs;
    if (!createdMs || ageMs > REMARK_EDIT_WINDOW_MS) {
      return res.status(403).json({
        error: 'The 5-minute edit window for this remark has passed. Add a new remark instead.',
        expired: true
      });
    }

    const newText = String(req.body.remarks ?? '').trim();
    if (!newText) return res.status(400).json({ error: 'Remark text cannot be empty' });

    // Keep the original wording so the timeline stays auditable even after a correction.
    const history = Array.isArray(existing.Edit_History) ? existing.Edit_History : [];
    const updated = await sheetsService.updateRow('Customer_Interactions', 'Interaction_ID', req.params.id, {
      Remarks: newText,
      Type: req.body.type !== undefined ? req.body.type : existing.Type,
      Edited_At: new Date().toISOString(),
      Edited_By: req.user.staffId,
      Is_Edited: true,
      Edit_History: [...history, { previousText: existing.Remarks, editedAt: new Date().toISOString(), editedBy: req.user.staffId }]
    });

    res.json({ ...updated, editWindowMs: REMARK_EDIT_WINDOW_MS, remainingMs: Math.max(0, REMARK_EDIT_WINDOW_MS - ageMs) });
  } catch (err) {
    console.error('PUT /customer-interactions error:', err);
    res.status(500).json({ error: 'Failed to update customer interaction' });
  }
});

// --- TASK MASTER ---
router.get('/tasks', async (req, res) => {
  try {
    const allTasks = await sheetsService.getAllTasks();
    const allCustomers = await sheetsService.getAllCustomers();

    // Enrich tasks with customer details
    const enrichedTasks = allTasks.map(t => {
      const custId = String(t.Customer_ID || '').trim().toLowerCase();
      const customer = allCustomers.find(c => String(c.Customer_ID || '').trim().toLowerCase() === custId) || {};
      return {
        ...t,
        Customer_Name: customer.Company_Name || t.Customer_Name || (t.Customer_ID ? `Customer (${t.Customer_ID})` : 'General Client'),
        Customer_Contact: customer.Contact || t.Customer_Contact || '',
        Customer_Auth_Person: customer.Auth_Person || t.Customer_Auth_Person || '',
        Customer_Location_Link: customer.Location_Link || t.Customer_Location_Link || '',
        Customer_Address: customer.Address || t.Customer_Address || '',
        Customer_Coordinators: customer.Coordinators || t.Customer_Coordinators || ''
      };
    });

    // If Admin or viewAll query param is passed, show all tasks
    if (req.user.role === 'Admin' || req.query.all === 'true') {
      return res.json(enrichedTasks);
    }

    // Otherwise, filter to logged-in staff member
    const myTasks = enrichedTasks.filter(t => t.Assigned_Staff === req.user.staffId);
    res.json(myTasks);
  } catch (err) {
    console.error('Fetch tasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const newTask = {
      Task_ID: `TASK${Date.now().toString().slice(-6)}`,
      Customer_ID: req.body.customerId,
      Description: req.body.description,
      Assigned_Staff: req.body.assignedStaff || req.user.staffId,
      Department: req.body.department || 'Sales',
      Stage: req.body.stage || 'New Inquiry',
      Type: req.body.type || 'One-time',
      Recurring_Interval: req.body.recurringInterval || 'Monthly',
      Recurring_Period: req.body.recurringPeriod,
      Scheduled_Date: req.body.scheduledDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
      Status: 'Pending',
      Created_By: req.user.staffId,
      Created_At: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    };
    await sheetsService.insertRow('Task_Master', newTask);

    try {
      const actingStaff = await sheetsService.getStaffById(req.user.staffId);
      const staffName = actingStaff?.Name || req.user.staffId;
      
      const assignedStaffDoc = await sheetsService.getStaffById(newTask.Assigned_Staff);
      const assignedName = assignedStaffDoc?.Name || newTask.Assigned_Staff;
      
      await logSystemTaskRemark({
        customerId: newTask.Customer_ID,
        taskId: newTask.Task_ID,
        tag: 'NEW TASK CREATED',
        remarkText: `[NEW TASK CREATED] Description: "${newTask.Description || ''}" | Assigned to: ${assignedName} | Created & Assigned by: ${staffName}`,
        staffId: req.user.staffId,
        staffName
      });

      pushService.notifyStaff(newTask.Assigned_Staff, {
        type: pushService.NOTIFICATION_TYPES.TASK_ASSIGNED,
        title: 'New Task Assigned',
        body: `${staffName} assigned you a new task: ${newTask.Description || ''}`,
        url: `/?targetType=TASK&targetId=${newTask.Task_ID}`,
        tag: `task-${newTask.Task_ID}`
      });
    } catch (logErr) {
      console.error('Error logging task remark:', logErr);
    }

    res.json(newTask);
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update General Task Details (PATCH / PUT /api/tasks/:id)
const updateTaskHandler = async (req, res) => {
  try {
    const taskId = req.params.id;
    const {
      description, Description,
      scheduledDate, Scheduled_Date,
      type, Type,
      recurringInterval, Recurring_Interval,
      recurringPeriod, Recurring_Period,
      stage, Stage,
      assignedStaff, Assigned_Staff,
      assignedStaffName, Assigned_Staff_Name,
      department, Department,
      remarks, Remarks,
      status, Status
    } = req.body;

    const targetAssignedStaff = assignedStaff ?? Assigned_Staff;
    const oldTask = await sheetsService.getTaskById(taskId);

    const updates = {};
    if (description !== undefined || Description !== undefined) updates.Description = description ?? Description;
    if (scheduledDate !== undefined || Scheduled_Date !== undefined) updates.Scheduled_Date = scheduledDate ?? Scheduled_Date;
    if (type !== undefined || Type !== undefined) updates.Type = type ?? Type;
    if (recurringInterval !== undefined || Recurring_Interval !== undefined) updates.Recurring_Interval = recurringInterval ?? Recurring_Interval;
    if (recurringPeriod !== undefined || Recurring_Period !== undefined) updates.Recurring_Period = recurringPeriod ?? Recurring_Period;
    if (stage !== undefined || Stage !== undefined) updates.Stage = stage ?? Stage;
    if (targetAssignedStaff !== undefined) updates.Assigned_Staff = targetAssignedStaff;
    if (assignedStaffName !== undefined || Assigned_Staff_Name !== undefined) updates.Assigned_Staff_Name = assignedStaffName ?? Assigned_Staff_Name;
    if (department !== undefined || Department !== undefined) updates.Department = department ?? Department;
    if (remarks !== undefined || Remarks !== undefined) updates.Remarks = remarks ?? Remarks;
    if (status !== undefined || Status !== undefined) updates.Status = status ?? Status;

    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, updates);
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    // Log reassignment if assignee changed
    if (oldTask && targetAssignedStaff !== undefined && String(oldTask.Assigned_Staff).trim().toUpperCase() !== String(targetAssignedStaff).trim().toUpperCase()) {
      try {
        const actingStaff = await sheetsService.getStaffById(req.user.staffId);
        const staffName = actingStaff?.Name || req.user.staffId;
        
        const oldStaffDoc = await sheetsService.getStaffById(oldTask.Assigned_Staff);
        const oldStaffName = oldStaffDoc?.Name || oldTask.Assigned_Staff || 'Unassigned';
        
        const newStaffDoc = await sheetsService.getStaffById(targetAssignedStaff);
        const newStaffName = newStaffDoc?.Name || targetAssignedStaff || 'Unassigned';
        
        await logSystemTaskRemark({
          customerId: oldTask.Customer_ID,
          taskId: oldTask.Task_ID,
          tag: 'TASK REASSIGNED',
          remarkText: `[TASK REASSIGNED] Assigned from: ${oldStaffName} to: ${newStaffName} | Reassigned by: ${staffName}`,
          staffId: req.user.staffId,
          staffName
        });

        pushService.notifyStaff(targetAssignedStaff, {
          type: pushService.NOTIFICATION_TYPES.TASK_ASSIGNED,
          title: 'Task Reassigned to You',
          body: `${staffName} assigned you: ${oldTask.Description || ''}`,
          url: `/?targetType=TASK&targetId=${oldTask.Task_ID}`,
          tag: `task-${oldTask.Task_ID}`
        });
      } catch (logErr) {
        console.error('Error logging task reassignment remark:', logErr);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'Failed to update task' });
  }
};

router.patch('/tasks/:id', updateTaskHandler);
router.put('/tasks/:id', updateTaskHandler);

// Advance Task Workflow Stage
//
// Stepping one stage forward stays open to any authenticated staff member, as it always has.
// Choosing an arbitrary target stage is the privileged action — it can move work past the stages
// that create quotations, or hand it to another department — so that form is gated on taskstage:edit.
router.put('/tasks/:id/stage', (req, res, next) => {
  if (!req.body.targetStage) return next();
  return requirePermission('taskstage', 'edit')(req, res, next);
}, async (req, res) => {
  try {
    const taskId = req.params.id;
    const result = await workflowEngine.advanceTaskStage(taskId, {
      staffId: req.user.staffId,
      targetStage: req.body.targetStage,
      assignedStaff: req.body.assignedStaff,
      latLong: req.body.latLong,
      remarks: req.body.remarks,
      imageUrl: req.body.imageUrl
    });
    res.json(result);
  } catch (err) {
    console.error('Advance stage error:', err);
    res.status(500).json({ error: err.message || 'Failed to advance task stage' });
  }
});

// Update Task Status
router.put('/tasks/:id/status', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { status } = req.body;
    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
      Status: status
    });
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    if (status === 'Started' || status === 'In Progress' || status === 'Completed' || status === 'Closed') {
      try {
        const actingStaff = await sheetsService.getStaffById(req.user.staffId);
        const staffName = actingStaff?.Name || req.user.staffId;
        const taskLabel = updated.Description || updated.Task_ID;
        const isCompletion = status === 'Completed' || status === 'Closed';
        await logSystemTaskRemark({
          customerId: updated.Customer_ID,
          taskId: updated.Task_ID,
          tag: isCompletion ? 'TASK COMPLETED' : 'TASK STATUS UPDATED',
          remarkText: isCompletion
            ? `[TASK COMPLETED] Task: "${taskLabel}" - Details: "${updated.Description || ''}" completed by ${staffName}`
            : `[TASK STATUS UPDATED] Task: "${taskLabel}" changed to status "${status}" by ${staffName}`,
          staffId: req.user.staffId,
          staffName
        });
      } catch (logErr) {
        console.error('Failed to log system remark for status update:', logErr);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('Failed to update task status:', err);
    res.status(500).json({ error: 'Failed to update task status', details: err.message });
  }
});

// Set/replace the full set of dynamic tags assigned to a task (multi-select labels)
router.put('/tasks/:id/tags', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, { Tags: tags });
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task tags' });
  }
});

// Reschedule Task with Mandatory Remarks
router.put('/tasks/:id/reschedule', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { newScheduledDate, remarks, latLong } = req.body;

    if (!remarks || remarks.trim() === '') {
      return res.status(400).json({ error: 'Mandatory manual remarks are required when rescheduling.' });
    }

    const updatedTask = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
      Scheduled_Date: newScheduledDate
    });

    const logEntry = {
      Log_ID: `LOG${Date.now()}`,
      Task_ID: taskId,
      Staff_ID: req.user.staffId,
      Action_Taken: `Rescheduled to ${newScheduledDate}`,
      Lat_Long_Location: latLong || '0.0000, 0.0000',
      Remarks: `Reschedule reason: ${remarks}`,
      Timestamp: new Date().toISOString(),
      Image_URL: ''
    };
    await sheetsService.insertRow('Activity_Logs', logEntry);

    res.json({ updatedTask, logEntry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reschedule task' });
  }
});

// Request Task Removal (Staff requires Admin permission)
router.patch('/tasks/:id/request-removal', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { reason } = req.body || {};
    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
      Status: 'Removal Requested'
    });
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    await sheetsService.insertRow('Activity_Logs', {
      Log_ID: `LOG${Date.now()}`,
      Task_ID: taskId,
      Staff_ID: req.user?.staffId || 'STAFF',
      Action_Taken: 'Requested Task Removal',
      Lat_Long_Location: '0.0000, 0.0000',
      Remarks: reason || 'Removal requested by staff (Pending Admin confirmation)',
      Timestamp: new Date().toISOString(),
      Image_URL: ''
    });

    res.json({ success: true, taskId, status: 'Removal Requested' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to request task removal' });
  }
});

// Reject Task Removal (Admin restores task)
router.patch('/tasks/:id/reject-removal', async (req, res) => {
  try {
    const taskId = req.params.id;
    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
      Status: 'In Progress'
    });
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, taskId, status: 'In Progress' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject task removal' });
  }
});

// Delete / Remove Task (Admin confirmation)
// Admin-only, matching every other destructive route and the UI, which offers permanent deletion
// only through the Admin actions (direct delete and approve-removal). Staff are expected to go via
// PATCH /tasks/:id/request-removal instead.
router.delete('/tasks/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to delete a task' });
    }
    const taskId = req.params.id;
    const deleted = await sheetsService.deleteRow('Task_Master', 'Task_ID', taskId);
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Reactivate closed task when new task/work comes
router.put('/tasks/:id/reactivate', async (req, res) => {
  try {
    const taskId = req.params.id;
    const { newScheduledDate, remarks, stage } = req.body;
    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', taskId, {
      Status: 'In Progress',
      Stage: stage || 'New Inquiry',
      Scheduled_Date: newScheduledDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    });
    if (!updated) return res.status(404).json({ error: 'Task not found' });

    // Log the reactivation
    const logEntry = {
      Log_ID: `LOG${Date.now()}`,
      Task_ID: taskId,
      Staff_ID: req.user.staffId,
      Action_Taken: 'Reactivated Closed Task for New Work',
      Lat_Long_Location: req.body.latLong || '0.0000, 0.0000',
      Remarks: remarks || 'Reactivated task for follow-up work',
      Timestamp: new Date().toISOString(),
      Image_URL: ''
    };
    await sheetsService.insertRow('Activity_Logs', logEntry);

    res.json({ success: true, task: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reactivate task' });
  }
});

// --- ACTIVITY LOGS ---
router.get('/logs', async (req, res) => {
  try {
    let logs = await sheetsService.getAllLogs();
    if (req.query.taskId) {
      logs = logs.filter(l => l.Task_ID === req.query.taskId);
    }
    if (req.query.staffId) {
      logs = logs.filter(l => l.Staff_ID === req.query.staffId);
    }
    // Sort descending by Timestamp
    logs.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

router.post('/logs', async (req, res) => {
  try {
    const logEntry = {
      Log_ID: `LOG${Date.now()}`,
      Task_ID: req.body.taskId || 'GENERAL',
      Staff_ID: req.user.staffId,
      Action_Taken: req.body.actionTaken || 'Field Service Check-in',
      Lat_Long_Location: req.body.latLong || '0.0000, 0.0000',
      Remarks: req.body.remarks || '',
      Timestamp: new Date().toISOString(),
      Image_URL: req.body.imageUrl || ''
    };
    await sheetsService.insertRow('Activity_Logs', logEntry);
    res.json(logEntry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add activity log' });
  }
});

// --- PWA OFFLINE BATCH SYNC ---
router.post('/sync/batch', async (req, res) => {
  try {
    const { actions } = req.body;
    if (!Array.isArray(actions)) {
      return res.status(400).json({ error: 'Actions must be an array' });
    }

    // Resolved once per batch rather than per action: a queue can hold many ADVANCE_STAGE items and
    // the permission cannot change mid-flush.
    let mayPickStage = null;
    const canPickStage = async () => {
      if (mayPickStage === null) {
        const staff = await sheetsService.getStaffById(req.user?.staffId);
        mayPickStage = can(resolvePermissions(staff, req.user?.role), 'taskstage', 'edit');
      }
      return mayPickStage;
    };

    const syncResults = [];
    for (const item of actions) {
      try {
        if (item.type === 'ADVANCE_STAGE') {
          // Drop an ungranted targetStage rather than rejecting the item — the queued work still
          // advances one stage, which is what an ungranted user could have done online anyway.
          // Failing here would strand the action in IndexedDB forever.
          const targetStage = (item.payload.targetStage && await canPickStage())
            ? item.payload.targetStage
            : undefined;
          const resStage = await workflowEngine.advanceTaskStage(item.payload.taskId, {
            staffId: req.user.staffId,
            targetStage,
            latLong: item.payload.latLong,
            remarks: item.payload.remarks,
            imageUrl: item.payload.imageUrl
          });
          syncResults.push({ id: item.id, status: 'SUCCESS', result: resStage });
        } else if (item.type === 'RESCHEDULE') {
          const updatedTask = await sheetsService.updateRow('Task_Master', 'Task_ID', item.payload.taskId, {
            Scheduled_Date: item.payload.newScheduledDate
          });
          const logEntry = {
            Log_ID: `LOG${Date.now()}`,
            Task_ID: item.payload.taskId,
            Staff_ID: req.user.staffId,
            Action_Taken: `Rescheduled to ${item.payload.newScheduledDate} (Offline Sync)`,
            Lat_Long_Location: item.payload.latLong || '0.0000, 0.0000',
            Remarks: `Reschedule reason: ${item.payload.remarks}`,
            Timestamp: new Date().toISOString(),
            Image_URL: ''
          };
          await sheetsService.insertRow('Activity_Logs', logEntry);
          syncResults.push({ id: item.id, status: 'SUCCESS', result: updatedTask });
        } else if (item.type === 'ACTIVITY_LOG') {
          const logEntry = {
            Log_ID: `LOG${Date.now()}`,
            Task_ID: item.payload.taskId,
            Staff_ID: req.user.staffId,
            Action_Taken: item.payload.actionTaken,
            Lat_Long_Location: item.payload.latLong || '0.0000, 0.0000',
            Remarks: item.payload.remarks || '',
            Timestamp: new Date().toISOString(),
            Image_URL: item.payload.imageUrl || ''
          };
          await sheetsService.insertRow('Activity_Logs', logEntry);
          syncResults.push({ id: item.id, status: 'SUCCESS', result: logEntry });
        } else if (item.type === 'JOB_CARD_ITEM_UPSERT') {
          // Insert-or-$set keyed on Job_Card_Item_ID, so the same queued entry replayed after a
          // partial flush converges on one row instead of duplicating the cylinder.
          const saved = await jobCardService.upsertJobCardItemOffline(item.payload, req.user);
          syncResults.push({ id: item.id, status: 'SUCCESS', result: saved });
        } else if (item.type === 'JOB_CARD_PARTS_ADD') {
          // Deduped on parts[].lineId inside addPartsToItem, so a replay is a no-op rather than
          // fitting the same safety pin twice.
          const saved = await jobCardService.addPartsToItem(
            item.payload.jobCardItemId,
            item.payload.parts,
            req.user,
            { consumeStock: item.payload.consumeStock !== false, date: item.payload.date }
          );
          syncResults.push({ id: item.id, status: 'SUCCESS', result: saved });
        } else if (item.type === 'JOB_CARD_RECHECK') {
          const saved = await jobCardService.applyRecheck(
            item.payload.jobCardId,
            item.payload.resolutions,
            req.user
          );
          syncResults.push({ id: item.id, status: 'SUCCESS', result: saved });
        } else if (item.type === 'CHALLAN_POD') {
          // Proof of delivery captured at a customer gate with no signal.
          const existing = await sheetsService.getChallanById(item.payload.challanId);
          if (existing?.POD?.deliveredAt) {
            // Already recorded — a replay after a partial flush must not insert a second copy of
            // the signature and photos into Media_Store. Reported as SUCCESS so the client drains it.
            syncResults.push({ id: item.id, status: 'SUCCESS', result: existing });
          } else {
            const saved = await challanService.recordPOD(item.payload.challanId, item.payload, req.user);
            syncResults.push({ id: item.id, status: 'SUCCESS', result: saved });
          }
        } else {
          // Terminal else — REQUIRED. Without it an unrecognised type falls through the whole
          // chain, never enters syncResults, and the client therefore never removes it from
          // IndexedDB (flushOfflineQueue only deletes on SUCCESS or terminal). The entry would
          // then re-POST on every flush forever. Reported as terminal so the client can drain it.
          syncResults.push({
            id: item.id,
            status: 'ERROR',
            terminal: true,
            error: `Unsupported offline action type: ${item.type}`
          });
        }
      } catch (innerErr) {
        console.error('Batch sync item error:', innerErr);
        // A 409 is a business conflict, not a transient fault: standby units still out, a recheck
        // unresolved. Retrying cannot change the answer, so it is reported terminal and the client
        // drains it — otherwise it re-POSTs on every flush forever. Everything else stays queued.
        syncResults.push({
          id: item.id,
          status: 'ERROR',
          terminal: innerErr.statusCode === 409 || undefined,
          error: innerErr.message
        });
      }
    }

    res.json({ success: true, processedCount: actions.length, results: syncResults });
  } catch (err) {
    res.status(500).json({ error: 'Batch sync failed' });
  }
});

// --- EXECUTIVE ANALYTICS FOR ADMIN DASHBOARD ---
router.get('/analytics', async (req, res) => {
  try {
    const tasks = await sheetsService.getAllTasks();
    const staff = await sheetsService.getAllStaff();
    const customers = await sheetsService.getAllCustomers();
    const logs = await sheetsService.getAllLogs();

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.Status === 'Completed').length;
    const activeTasks = totalTasks - completedTasks;

    const departmentCounts = {
      Sales: tasks.filter(t => t.Department === 'Sales').length,
      Production: tasks.filter(t => t.Department === 'Production').length
    };

    const stageBreakdown = {};
    tasks.forEach(t => {
      stageBreakdown[t.Stage] = (stageBreakdown[t.Stage] || 0) + 1;
    });

    const staffPerformance = staff.map(s => {
      const assigned = tasks.filter(t => t.Assigned_Staff === s.Staff_ID);
      const done = assigned.filter(t => t.Status === 'Completed').length;
      return {
        Staff_ID: s.Staff_ID,
        Name: s.Name,
        Role: s.Role,
        Active_Tasks: assigned.length - done,
        Completed_Tasks: done
      };
    });

    res.json({
      summary: {
        totalTasks,
        activeTasks,
        completedTasks,
        totalCustomers: customers.length,
        totalStaff: staff.length,
        totalLogs: logs.length
      },
      departmentCounts,
      stageBreakdown,
      staffPerformance,
      recentLogs: logs.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// --- STAFF SALARY RATE MANAGEMENT ---
router.put('/staff/:staffId/salary-rate', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to change salary rates' });
    }
    const { dailyRate } = req.body;
    const updated = await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.staffId, {
      Daily_Salary_Rate: Number(dailyRate)
    });
    if (!updated) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const { Password, ...clean } = updated;
    res.json(clean);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update daily salary rate' });
  }
});

// --- SALARY ADVANCES MANAGEMENT ---
router.get('/advances', async (req, res) => {
  try {
    const allAdvances = await sheetsService.getTab('Salary_Advances');
    if (req.user.role === 'Admin' || req.query.all === 'true') {
      return res.json(allAdvances);
    }
    const myAdvances = allAdvances.filter(a => a.Staff_ID === req.user.staffId);
    res.json(myAdvances);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch salary advances' });
  }
});

router.post('/advances', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to record salary advances' });
    }
    const { staffId, amount, paymentMode, remarks } = req.body;
    if (!staffId || !amount) {
      return res.status(400).json({ error: 'Staff ID and Amount are required' });
    }
    const allStaff = await sheetsService.getAllStaff();
    const staffObj = allStaff.find(s => s.Staff_ID === staffId) || {};

    const nowMs = Date.now();
    const newAdvance = {
      Advance_ID: `ADV_${nowMs}`,
      Created_At: nowMs,
      Staff_ID: staffId,
      Staff_Name: staffObj.Name || staffId,
      Amount: Number(amount),
      Date_Timestamp: new Date().toISOString(),
      Payment_Mode: paymentMode || 'Cash',
      Remarks: remarks || 'Advance payment issued'
    };
    await sheetsService.insertRow('Salary_Advances', newAdvance);
    res.json(newAdvance);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record salary advance' });
  }
});

router.delete('/advances/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const deleted = await sheetsService.deleteRow('Salary_Advances', 'Advance_ID', req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Advance record not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete salary advance' });
  }
});

// --- ATTENDANCE & PAYROLL ENDPOINTS ---
router.get('/attendance', async (req, res) => {
  try {
    const allRecords = await sheetsService.getAllAttendance();
    const allStaff = await sheetsService.getAllStaff();

    const enriched = allRecords.map(r => {
      const s = allStaff.find(st => st.Staff_ID === r.Staff_ID) || {};
      return {
        ...r,
        Staff_Name: s.Name || 'Unknown Staff',
        Staff_Role: s.Role || '',
        Daily_Salary_Rate: s.Daily_Salary_Rate || 1000
      };
    });

    const salaryEnriched = attendanceService.enrichRecordsWithSalary(enriched, allStaff);

    if (req.user.role === 'Admin' || req.query.all === 'true') {
      return res.json(salaryEnriched);
    }
    const myAttendance = salaryEnriched.filter(r => r.Staff_ID === req.user.staffId);
    res.json(myAttendance);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance logs' });
  }
});

router.post('/attendance/punch-in', async (req, res) => {
  try {
    const clientIp = req.body.ipAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || 'Unknown IP';
    const record = await attendanceService.punchIn({
      staffId: req.user.staffId,
      latLong: req.body.latLong,
      ipAddress: clientIp,
      overrideDate: req.body.overrideDate,
      overrideTime: req.body.overrideTime
    });
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to punch in' });
  }
});

router.post('/attendance/punch-out', async (req, res) => {
  try {
    const clientIp = req.body.ipAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip || 'Unknown IP';
    const result = await attendanceService.punchOut({
      staffId: req.user.staffId,
      latLong: req.body.latLong,
      ipAddress: clientIp,
      overrideDate: req.body.overrideDate,
      overrideTime: req.body.overrideTime
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to punch out' });
  }
});

router.put('/attendance/:recordId/override-salary', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to override salary' });
    }
    const updated = await attendanceService.overrideSalary(req.params.recordId, req.body.calculatedDailySalary);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to override salary' });
  }
});

router.patch('/attendance/salary', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to override salary' });
    }
    const { recordId, overrideSalary } = req.body;
    const updated = await attendanceService.overrideSalary(recordId, overrideSalary);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to override salary' });
  }
});

router.put('/attendance/salary', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to override salary' });
    }
    const { recordId, overrideSalary } = req.body;
    const updated = await attendanceService.overrideSalary(recordId, overrideSalary);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to override salary' });
  }
});

router.post('/attendance/run-auto-close', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await attendanceService.runAutoCloseJob();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Auto close job execution failed' });
  }
});

// --- LEAVE ROUTING ENDPOINTS ---
router.get('/leaves', async (req, res) => {
  try {
    const allLeaves = await sheetsService.getAllLeaves();
    const allStaff = await sheetsService.getAllStaff();

    const enriched = allLeaves.map(l => {
      const s = allStaff.find(st => st.Staff_ID === l.Staff_ID) || {};
      return {
        ...l,
        Staff_Name: s.Name || 'Unknown Staff',
        Staff_Role: s.Role || ''
      };
    });

    if (req.user.role === 'Admin' || req.query.all === 'true') {
      return res.json(enriched);
    }
    const myLeaves = enriched.filter(l => l.Staff_ID === req.user.staffId);
    res.json(myLeaves);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

router.post('/leaves', async (req, res) => {
  try {
    const { leaveDate, leaveType, isUrgent, reason, staffId, status } = req.body;
    const isAdmin = req.user.role === 'Admin';

    if (!leaveDate) {
      return res.status(400).json({ error: 'Leave date is required' });
    }

    const targetStaffId = (isAdmin && staffId) ? staffId : req.user.staffId;

    // Advance Notice 7-Day Rule validation (Bypass if Admin assigns leave directly)
    if (!isAdmin && !isUrgent) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const reqDate = new Date(leaveDate);
      reqDate.setHours(0, 0, 0, 0);

      const diffTime = reqDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays < 7) {
        return res.status(400).json({
          error: 'Standard leave requests require at least 7 days advance notice. Check "Urgent Leave" if immediate leave is required.'
        });
      }
    }

    const newLeave = {
      Request_ID: `LEV${Date.now()}`,
      Staff_ID: targetStaffId,
      Leave_Date: leaveDate,
      Leave_Type: leaveType || 'Full Day',
      Is_Urgent: Boolean(isUrgent),
      Reason: reason || (isAdmin ? 'Leave granted by Admin' : ''),
      Status: isAdmin ? (status || 'Approved') : 'Pending'
    };

    await sheetsService.insertRow('Leave_Requests', newLeave);
    res.json(newLeave);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create leave request' });
  }
});

const updateLeaveStatusHandler = async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required to approve/reject leaves' });
    }
    const requestId = req.params.requestId || req.body.requestId;
    const { status } = req.body;
    if (!requestId) {
      return res.status(400).json({ error: 'Leave request ID is required' });
    }
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be Approved or Rejected' });
    }
    const updated = await sheetsService.updateRow('Leave_Requests', 'Request_ID', requestId, {
      Status: status
    });
    if (!updated) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    pushService.notifyStaff(updated.Staff_ID, {
      type: pushService.NOTIFICATION_TYPES.LEAVE_STATUS,
      title: `Leave ${status}`,
      body: `Your leave request for ${updated.Leave_Date || 'the requested date'} was ${status.toLowerCase()}.`,
      url: `/?targetType=LEAVE&targetId=${updated.Request_ID}`,
      tag: `leave-${updated.Request_ID}`
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update leave request status' });
  }
};

router.put('/leaves/status', updateLeaveStatusHandler);
router.patch('/leaves/status', updateLeaveStatusHandler);
router.put('/leaves/:requestId/status', updateLeaveStatusHandler);
router.patch('/leaves/:requestId/status', updateLeaveStatusHandler);

// --- WEB PUSH NOTIFICATIONS ---
router.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

router.post('/staff/push-subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Valid push subscription is required' });
    }
    await sheetsService.addPushSubscription(req.user.staffId, subscription);
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/staff/push-unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    await sheetsService.removePushSubscription(req.user.staffId, endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

const DEFAULT_NOTIFICATION_SETTINGS = {
  TASK_ASSIGNED: true,
  TASK_STAGE_HANDOFF: true,
  LEAVE_STATUS: true,
  PHOTO_ICARD_APPROVAL: true
};

router.get('/settings/notifications', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const settings = await sheetsService.getNotificationSettings();
    res.json({ ...DEFAULT_NOTIFICATION_SETTINGS, ...(settings || {}) });
  } catch (err) {
    console.error('Fetch notification settings error:', err);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

router.put('/settings/notifications', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { TASK_ASSIGNED, TASK_STAGE_HANDOFF, LEAVE_STATUS, PHOTO_ICARD_APPROVAL } = req.body;
    const updated = await sheetsService.saveNotificationSettings('DEFAULT', {
      TASK_ASSIGNED: Boolean(TASK_ASSIGNED),
      TASK_STAGE_HANDOFF: Boolean(TASK_STAGE_HANDOFF),
      LEAVE_STATUS: Boolean(LEAVE_STATUS),
      PHOTO_ICARD_APPROVAL: Boolean(PHOTO_ICARD_APPROVAL)
    });
    res.json(updated);
  } catch (err) {
    console.error('Save notification settings error:', err);
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

// --- DOCUMENT & TEMPLATE SETTINGS (read: any authenticated user, write: Admin only) ---
// Staff need read access so admin-configured report templates, checkpoint libraries and
// observation/recommendation defaults reach the field technicians filling in reports.
router.get('/document-settings', async (req, res) => {
  try {
    const settings = await sheetsService.getDocumentSettings('DEFAULT');
    res.json(settings || {});
  } catch (err) {
    console.error('GET /document-settings error:', err);
    res.status(500).json({ error: 'Failed to load document settings' });
  }
});

router.put('/document-settings', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const saved = await sheetsService.saveDocumentSettings('DEFAULT', req.body);
    res.json(saved);
  } catch (err) {
    console.error('PUT /document-settings error:', err);
    res.status(500).json({ error: 'Failed to save document settings' });
  }
});

// --- QUOTATION SETTINGS (Module A) ---
// Staff may read (the quotation builder needs payment terms / T&C / defaults); Admin only writes.
router.get('/quotation-settings', async (req, res) => {
  try {
    const settings = await quotationEngine.getSettings();
    // Never expose resolved secrets — only whether each channel is actually usable.
    const emailService = require('../services/emailService');
    const whatsappService = require('../services/whatsappService');
    res.json({
      ...settings,
      _channel_status: {
        email_configured: emailService.isConfigured(settings.smtp_config),
        whatsapp_configured: whatsappService.isConfigured(settings.whatsapp_config)
      }
    });
  } catch (err) {
    console.error('GET /quotation-settings error:', err);
    res.status(500).json({ error: 'Failed to load quotation settings' });
  }
});

router.put('/quotation-settings', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const payload = { ...req.body };
    delete payload._channel_status;
    const saved = await sheetsService.saveQuotationSettings('DEFAULT', payload);
    res.json(saved);
  } catch (err) {
    console.error('PUT /quotation-settings error:', err);
    res.status(500).json({ error: 'Failed to save quotation settings' });
  }
});

// --- MODULE PERMISSIONS (Quotation / Inventory) ---
// The caller's own effective permissions, so the client can show or hide UI accordingly.
router.get('/my-permissions', async (req, res) => {
  try {
    const staff = await sheetsService.getStaffById(req.user.staffId);
    res.json({
      staffId: req.user.staffId,
      role: staff?.Role || req.user.role,
      permissions: resolvePermissions(staff, req.user.role)
    });
  } catch (err) {
    console.error('GET /my-permissions error:', err);
    res.status(500).json({ error: 'Could not load permissions' });
  }
});

router.get('/staff-permissions', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const allStaff = await sheetsService.getAllStaff();
    res.json({
      modules: MODULES,
      actions: ACTIONS,
      staff: allStaff
        .filter(s => s.Status !== 'Inactive')
        .map(s => ({
          Staff_ID: s.Staff_ID,
          Name: s.Name,
          Role: s.Role,
          permissions: resolvePermissions(s, s.Role),
          // Distinguishes an explicit admin-set map from an inherited role default.
          hasExplicitPermissions: Boolean(s.Module_Permissions)
        }))
    });
  } catch (err) {
    console.error('GET /staff-permissions error:', err);
    res.status(500).json({ error: 'Could not load staff permissions' });
  }
});

router.put('/staff-permissions/:staffId', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const staff = await sheetsService.getStaffById(req.params.staffId);
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    if (String(staff.Role || '').toLowerCase() === 'admin') {
      return res.status(400).json({ error: 'Admin users always have full access — their permissions cannot be restricted here.' });
    }

    const clean = sanitizePermissions(req.body.permissions);
    await sheetsService.updateRow('Staff_Master', 'Staff_ID', req.params.staffId, {
      Module_Permissions: clean,
      Permissions_Updated_By: req.user.staffId,
      Permissions_Updated_At: new Date().toISOString()
    });

    const updated = await sheetsService.getStaffById(req.params.staffId);
    res.json({ staffId: req.params.staffId, permissions: resolvePermissions(updated, updated.Role) });
  } catch (err) {
    console.error('PUT /staff-permissions error:', err);
    res.status(500).json({ error: 'Could not save permissions' });
  }
});

// Offline GSTIN validation — checksum + state + entity type, no external API call and no cost.
// Catches mistyped GSTINs before they can reach an invoice.
router.get('/gstin/validate/:gstin', async (req, res) => {
  try {
    res.json(gstUtils.parseGstin(req.params.gstin));
  } catch (err) {
    res.status(500).json({ error: 'Could not validate GSTIN' });
  }
});

router.get('/quotation-settings/gst-states', async (req, res) => {
  try {
    res.json(Object.entries(gstUtils.GST_STATE_CODES).map(([code, name]) => ({ code, name })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load state codes' });
  }
});

router.post('/quotation-settings/test-email', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const emailService = require('../services/emailService');
    const settings = await quotationEngine.getSettings();
    const verified = await emailService.verifyConnection(settings.smtp_config);
    if (!verified.ok) return res.status(400).json({ error: verified.error });
    if (req.body.to) {
      const sent = await emailService.sendEmail(settings.smtp_config, {
        to: req.body.to,
        subject: 'Expert Safety Solutions — SMTP test',
        body: 'This is a test message confirming your SMTP configuration works.'
      });
      return res.json(sent);
    }
    res.json({ ok: true, message: 'SMTP connection verified' });
  } catch (err) {
    console.error('POST /quotation-settings/test-email error:', err);
    res.status(500).json({ error: 'Email test failed' });
  }
});

router.get('/quotation-settings/whatsapp-templates', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const whatsappService = require('../services/whatsappService');
    const settings = await quotationEngine.getSettings();
    const result = await whatsappService.listTemplates(settings.whatsapp_config);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result.templates);
  } catch (err) {
    console.error('GET /quotation-settings/whatsapp-templates error:', err);
    res.status(500).json({ error: 'Failed to list WhatsApp templates' });
  }
});

// --- ITEM MASTER (Module B) ---
router.get('/items', requirePermission('inventory','view'), async (req, res) => {
  try {
    const all = await sheetsService.getAllItems();
    const { search, category, includeDeleted } = req.query;

    // Deleted items and those awaiting delete approval are hidden by default so they can't be
    // picked into a new quotation; the recycle bin passes includeDeleted to see them.
    let rows = includeDeleted === 'true'
      ? all
      : all.filter(i => !i.Is_Deleted && i.Delete_Status !== 'Deleted' && i.Delete_Status !== 'PendingApproval');

    if (category) {
      rows = rows.filter(i => String(i.Category || '').toLowerCase() === String(category).toLowerCase());
    }

    if (search) {
      // Searches name, aliases (Tally-style alternate names), HSN and category.
      const q = String(search).trim().toLowerCase();
      rows = rows.filter(i => {
        const aliases = Array.isArray(i.Aliases) ? i.Aliases.join(' ') : '';
        return `${i.Item_Name || ''} ${aliases} ${i.HSN_Code || ''} ${i.Category || ''}`
          .toLowerCase().includes(q);
      });
    }

    res.json(rows);
  } catch (err) {
    console.error('GET /items error:', err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// Accepts a base64 image (already compressed client-side to <180KB) and stores it in Mongo,
// returning a URL served by the public GET /api/media/:id. This replaces the Google Apps Script /
// Drive round-trip for product photos: no external deployment to keep in sync, and it works on
// Vercel where the filesystem is read-only so uploads can't be written to /assets.
//
// PDFs are accepted too (quotation email catalogues) — same storage, same public URL. Drive was
// ruled out for these: the dispatch server has no Google credentials, so it could never fetch the
// bytes back to attach them to an outgoing email.
router.post('/media/upload', requirePermission('inventory','add'), async (req, res) => {
  try {
    const { base64, fileName, mimeType, purpose } = req.body;
    const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!clean) return res.status(400).json({ error: 'No image data supplied' });

    const mime = String(mimeType || 'image/jpeg');
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
      return res.status(400).json({ error: 'Only image and PDF uploads are supported' });
    }

    // base64 inflates by ~4/3; 8MB decoded stays clear of the 16MB BSON document ceiling and of
    // the 10mb express.json limit that would have rejected the request before reaching here.
    const approxBytes = Math.floor(clean.length * 3 / 4);
    if (approxBytes > 8 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image is too large. Please use a smaller photo.' });
    }

    const mediaId = `MED_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await sheetsService.insertMedia({
      Media_ID: mediaId,
      File_Name: String(fileName || 'upload.jpg'),
      Mime_Type: mime,
      Purpose: String(purpose || 'Product Photo'),
      Size_Bytes: approxBytes,
      Data: clean,
      Uploaded_By: req.user.staffId || 'SYSTEM',
      Uploaded_At: Date.now()
    });

    res.json({ success: true, mediaId, url: `/api/media/${mediaId}` });
  } catch (err) {
    console.error('POST /media/upload error:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

router.post('/items', requirePermission('inventory','add'), async (req, res) => {
  try {
    const settings = await quotationEngine.getSettings();
    const newItem = {
      Item_ID: `ITEM${Date.now().toString().slice(-6)}`,
      Item_Name: req.body.itemName || req.body.Item_Name || '',
      Category: req.body.category || '',
      HSN_Code: req.body.hsnCode || '',
      Unit: req.body.unit || 'Nos',
      Default_GST_Rate: Number(req.body.defaultGstRate ?? settings.defaults.default_gst_rate),
      Standard_Rate: Number(req.body.standardRate) || 0,
      Reorder_Level: Number(req.body.reorderLevel) || 0,
      Description: req.body.description || '',
      Linked_Equipment_Type_ID: req.body.linkedEquipmentTypeId || '',
      // Photo URLs (from POST /media/upload) plus richer copy for the quotation PDF.
      Aliases: Array.isArray(req.body.aliases) ? req.body.aliases.map(a => String(a).trim()).filter(Boolean) : [],
      Photo_URL: req.body.photoUrl || '',
      Photo_File_ID: req.body.photoFileId || '',
      Photos: Array.isArray(req.body.photos) ? req.body.photos : [],
      Long_Description: req.body.longDescription || '',
      Specifications: req.body.specifications || '',
      Active: req.body.active !== false,
      Created_By: req.user.staffId || 'SYSTEM',
      Created_At: quotationEngine.istToday()
    };
    if (!newItem.Item_Name) return res.status(400).json({ error: 'Item name is required' });
    await sheetsService.insertRow('Item_Master', newItem);
    res.json(newItem);
  } catch (err) {
    console.error('POST /items error:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// Bulk CSV import. Upserts on Item_ID when supplied, else matches on Item_Name so re-importing an
// edited export updates rows instead of duplicating them.
router.post('/items/bulk', requirePermission('inventory','add'), async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an "items" array' });

    const settings = await quotationEngine.getSettings();
    const existing = await sheetsService.getAllItems();
    const byId = new Map(existing.map(i => [String(i.Item_ID || '').trim(), i]));
    const byName = new Map(existing.map(i => [String(i.Item_Name || '').trim().toLowerCase(), i]));

    let created = 0;
    let updated = 0;
    const skipped = [];

    for (let idx = 0; idx < items.length; idx++) {
      const row = items[idx] || {};
      // Accept both the Sheet-style headers our export produces and plain camelCase.
      const name = String(row.Item_Name || row.itemName || '').trim();
      if (!name) { skipped.push({ row: idx + 2, reason: 'Missing item name' }); continue; }

      const rate = Number(row.Standard_Rate ?? row.standardRate ?? 0) || 0;
      const gst = Number(row.Default_GST_Rate ?? row.defaultGstRate ?? settings.defaults.default_gst_rate);
      const payload = {
        Item_Name: name,
        Category: String(row.Category || row.category || '').trim(),
        HSN_Code: String(row.HSN_Code || row.hsnCode || '').trim(),
        Unit: String(row.Unit || row.unit || 'Nos').trim() || 'Nos',
        Default_GST_Rate: Number.isFinite(gst) ? gst : 18,
        Standard_Rate: rate,
        Reorder_Level: Number(row.Reorder_Level ?? row.reorderLevel ?? 0) || 0,
        Description: String(row.Description || row.description || '').trim(),
        Active: String(row.Active ?? row.active ?? 'true').toLowerCase() !== 'false'
      };

      const suppliedId = String(row.Item_ID || row.itemId || '').trim();
      const match = suppliedId ? byId.get(suppliedId) : byName.get(name.toLowerCase());

      if (match) {
        await sheetsService.updateRow('Item_Master', 'Item_ID', match.Item_ID, payload);
        updated++;
      } else {
        const newItem = {
          Item_ID: suppliedId || `ITEM${Date.now().toString().slice(-6)}${idx.toString().padStart(2, '0')}`,
          ...payload,
          Created_By: req.user.staffId || 'SYSTEM',
          Created_At: quotationEngine.istToday()
        };
        await sheetsService.insertRow('Item_Master', newItem);
        // Keep the maps current so duplicate rows inside one file collapse onto the same item.
        byId.set(newItem.Item_ID, newItem);
        byName.set(name.toLowerCase(), newItem);
        created++;
      }
    }

    res.json({ created, updated, skippedCount: skipped.length, skipped: skipped.slice(0, 25) });
  } catch (err) {
    console.error('POST /items/bulk error:', err);
    res.status(500).json({ error: 'Failed to import items' });
  }
});

// Admin recycle bin: items awaiting deletion approval, plus already-deleted ones.
router.get('/items/recycle-bin', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const all = await sheetsService.getAllItems();
    res.json({
      pending: all.filter(i => i.Delete_Status === 'PendingApproval'),
      deleted: all.filter(i => i.Delete_Status === 'Deleted' || i.Is_Deleted)
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load recycle bin' });
  }
});

router.put('/items/:id', requirePermission('inventory','edit'), async (req, res) => {
  try {
    const updateData = {};
    if (req.body.itemName !== undefined) updateData.Item_Name = req.body.itemName;
    if (req.body.category !== undefined) updateData.Category = req.body.category;
    if (req.body.hsnCode !== undefined) updateData.HSN_Code = req.body.hsnCode;
    if (req.body.unit !== undefined) updateData.Unit = req.body.unit;
    if (req.body.defaultGstRate !== undefined) updateData.Default_GST_Rate = Number(req.body.defaultGstRate);
    if (req.body.standardRate !== undefined) updateData.Standard_Rate = Number(req.body.standardRate);
    if (req.body.reorderLevel !== undefined) updateData.Reorder_Level = Number(req.body.reorderLevel);
    if (req.body.description !== undefined) updateData.Description = req.body.description;
    if (req.body.linkedEquipmentTypeId !== undefined) updateData.Linked_Equipment_Type_ID = req.body.linkedEquipmentTypeId;
    if (req.body.aliases !== undefined) updateData.Aliases = Array.isArray(req.body.aliases) ? req.body.aliases.map(a => String(a).trim()).filter(Boolean) : [];
    if (req.body.photoUrl !== undefined) updateData.Photo_URL = req.body.photoUrl;
    if (req.body.photoFileId !== undefined) updateData.Photo_File_ID = req.body.photoFileId;
    if (req.body.photos !== undefined) updateData.Photos = Array.isArray(req.body.photos) ? req.body.photos : [];
    if (req.body.longDescription !== undefined) updateData.Long_Description = req.body.longDescription;
    if (req.body.specifications !== undefined) updateData.Specifications = req.body.specifications;
    if (req.body.active !== undefined) updateData.Active = req.body.active;

    const updated = await sheetsService.updateRow('Item_Master', 'Item_ID', req.params.id, updateData);
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json(updated);
  } catch (err) {
    console.error('PUT /items error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

/**
 * Deletion is a two-step approval flow, not an immediate removal:
 *  - non-Admin staff raise a request; the item is hidden from pickers but keeps its data
 *  - an Admin then approves (soft-deletes for good) or rejects (restores it)
 *
 * Items are never hard-deleted, because historical quotations and invoices reference them and must
 * keep resolving the item's name and rate.
 */
router.delete('/items/:id', requirePermission('inventory','delete'), async (req, res) => {
  try {
    const item = await sheetsService.getItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const isAdminUser = req.user.role === 'Admin';
    const nowIso = new Date().toISOString();

    if (isAdminUser && req.query.immediate === 'true') {
      await sheetsService.updateRow('Item_Master', 'Item_ID', req.params.id, {
        Active: false, Is_Deleted: true,
        Deleted_By: req.user.staffId, Deleted_At: nowIso,
        Delete_Status: 'Deleted'
      });
      return res.json({ success: true, status: 'Deleted' });
    }

    await sheetsService.updateRow('Item_Master', 'Item_ID', req.params.id, {
      Active: false,
      Delete_Status: 'PendingApproval',
      Delete_Requested_By: req.user.staffId,
      Delete_Requested_At: nowIso,
      Delete_Reason: req.body?.reason || ''
    });
    res.json({
      success: true,
      status: 'PendingApproval',
      message: 'Delete request sent to Admin for approval. The item is hidden from new quotations until then.'
    });
  } catch (err) {
    console.error('DELETE /items error:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

router.post('/items/:id/delete-decision', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const { decision } = req.body;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    }

    const nowIso = new Date().toISOString();
    const update = decision === 'approve'
      ? { Active: false, Is_Deleted: true, Delete_Status: 'Deleted', Deleted_By: req.user.staffId, Deleted_At: nowIso }
      // Rejecting restores the item to normal use and clears the request trail.
      : { Active: true, Is_Deleted: false, Delete_Status: '', Delete_Requested_By: '', Delete_Requested_At: '', Delete_Reason: '', Restored_By: req.user.staffId, Restored_At: nowIso };

    const updated = await sheetsService.updateRow('Item_Master', 'Item_ID', req.params.id, update);
    if (!updated) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, status: decision === 'approve' ? 'Deleted' : 'Restored' });
  } catch (err) {
    console.error('POST /items/delete-decision error:', err);
    res.status(500).json({ error: 'Could not apply decision' });
  }
});

// --- ITEM CATEGORY MASTER ---
// Categories are derived from existing items and merged with an admin-managed list, so the
// dropdown always reflects what's actually in use without needing a separate seed step.
router.get('/item-categories', requirePermission('inventory', 'view'), async (req, res) => {
  try {
    const [items, settings] = await Promise.all([
      sheetsService.getAllItems(),
      quotationEngine.getSettings()
    ]);
    const fromItems = items.map(i => String(i.Category || '').trim()).filter(Boolean);
    const configured = (settings.item_categories || []).map(c => String(c).trim()).filter(Boolean);
    const merged = [...new Set([...configured, ...fromItems])].sort((a, b) => a.localeCompare(b));
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: 'Could not load categories' });
  }
});

router.post('/item-categories', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });

    const settings = await quotationEngine.getSettings();
    const existing = settings.item_categories || [];
    if (existing.some(c => c.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'That category already exists' });
    }
    settings.item_categories = [...existing, name];
    await sheetsService.saveQuotationSettings('DEFAULT', settings);
    res.json({ success: true, categories: settings.item_categories });
  } catch (err) {
    res.status(500).json({ error: 'Could not add category' });
  }
});

// --- QUOTATIONS (Module B) ---
router.get('/quotations', requirePermission('quotation','view'), async (req, res) => {
  try {
    const all = await sheetsService.getAllQuotations();
    const { customerId, status, latestOnly } = req.query;
    let filtered = all;
    if (customerId) filtered = filtered.filter(q => q.Customer_ID === customerId);
    if (status) filtered = filtered.filter(q => q.Status === status);
    // Hides superseded revisions so a list view shows one row per quotation thread.
    if (latestOnly === 'true') filtered = filtered.filter(q => q.Status !== quotationEngine.STATUS.REVISED);
    res.json(filtered.sort((a, b) => (Number(b.Created_At_Ms) || 0) - (Number(a.Created_At_Ms) || 0)));
  } catch (err) {
    console.error('GET /quotations error:', err);
    res.status(500).json({ error: 'Failed to fetch quotations' });
  }
});

// Literal sub-paths must be declared before '/quotations/:id', otherwise Express matches the
// parameterized route first and treats "last-rates" as a quotation ID.
router.get('/quotations/last-rates/:customerId', async (req, res) => {
  try {
    res.json(await quotationEngine.getLastQuotedRates(req.params.customerId));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch historical rates' });
  }
});

router.get('/quotations/:id', async (req, res) => {
  try {
    const quotation = await sheetsService.getQuotationById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    res.json(quotation);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quotation' });
  }
});

router.get('/quotations/:rootId/history', async (req, res) => {
  try {
    res.json(await sheetsService.getQuotationRevisions(req.params.rootId));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quotation history' });
  }
});

// Prices a set of line items without persisting — powers live totals in the builder UI.
router.post('/quotations/preview', async (req, res) => {
  try {
    const customer = (await sheetsService.getAllCustomers()).find(c => c.Customer_ID === req.body.customerId);
    const priced = await quotationEngine.priceQuotation({
      customer: customer || {},
      lineItems: req.body.lineItems,
      documentDiscountPct: req.body.documentDiscountPct,
      documentDiscountAmt: req.body.documentDiscountAmt,
      destinationStateCode: req.body.destinationStateCode
    });
    res.json({
      gstType: priced.gstType,
      isInterState: priced.isInterState,
      stateResolved: priced.stateResolved,
      sellerStateCode: priced.sellerStateCode,
      buyerStateCode: priced.buyerStateCode,
      approvalRequired: priced.approvalRequired,
      effectiveDiscountPct: priced.effectiveDiscountPct,
      ...priced.totals
    });
  } catch (err) {
    console.error('POST /quotations/preview error:', err);
    res.status(500).json({ error: err.message || 'Failed to price quotation' });
  }
});

router.post('/quotations', requirePermission('quotation','add'), async (req, res) => {
  try {
    const quotation = await quotationEngine.createQuotation(req.body, req.user);
    res.json(quotation);
  } catch (err) {
    console.error('POST /quotations error:', err);
    res.status(400).json({ error: err.message || 'Failed to create quotation' });
  }
});

router.put('/quotations/:id', requirePermission('quotation','edit'), async (req, res) => {
  try {
    const updated = await quotationEngine.updateQuotation(req.params.id, req.body, req.user);
    res.json(updated);
  } catch (err) {
    console.error('PUT /quotations error:', err);
    res.status(400).json({ error: err.message || 'Failed to update quotation' });
  }
});

router.post('/quotations/:id/approve', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin approval required' });
    res.json(await quotationEngine.approveQuotation(req.params.id, req.user));
  } catch (err) {
    console.error('POST /quotations/approve error:', err);
    res.status(400).json({ error: err.message || 'Failed to approve quotation' });
  }
});

router.post('/quotations/:id/reject', async (req, res) => {
  try {
    res.json(await quotationEngine.rejectQuotation(req.params.id, req.body.reason, req.user));
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to reject quotation' });
  }
});

router.post('/quotations/:id/revise', requirePermission('quotation','add'), async (req, res) => {
  try {
    res.json(await quotationEngine.createRevision(req.params.id, req.body, req.user));
  } catch (err) {
    console.error('POST /quotations/revise error:', err);
    res.status(400).json({ error: err.message || 'Failed to create revision' });
  }
});

// Dispatches via Email/WhatsApp per settings, records the attempt, advances the task to
// Quotation FLP and creates the follow-up task (Module D).
router.post('/quotations/:id/dispatch', requirePermission('quotation','edit'), async (req, res) => {
  try {
    const quotation = await sheetsService.getQuotationById(req.params.id);
    if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
    if (quotation.Status === quotationEngine.STATUS.PENDING_APPROVAL) {
      return res.status(400).json({ error: 'Quotation is awaiting Admin approval and cannot be dispatched yet' });
    }

    // An optional channel sends over Email or WhatsApp alone, for the per-channel buttons in the
    // builder; omitting it falls back to the configured dispatch_mode.
    const channel = req.body.channel;
    if (channel && !['Email', 'WhatsApp', 'Both'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be Email, WhatsApp or Both' });
    }
    // Resolve the channels this send will actually target the same way dispatchService does, then
    // refuse up front if none of them has a recipient. The combined Send button passes no channel,
    // so the old `channel === 'Email'` checks never fired for it and a missing address surfaced far
    // later as a cryptic per-channel failure from nodemailer.
    const dispatchSettings = await quotationEngine.getSettings();
    const mode = channel || dispatchSettings.dispatch_mode || 'Email';
    const wantEmail = mode === 'Email' || mode === 'Both';
    const wantWhatsapp = mode === 'WhatsApp' || mode === 'Both';

    const missing = [];
    if (wantEmail && !quotation.Customer_Email_Snapshot) missing.push('email address');
    if (wantWhatsapp && !quotation.Customer_Contact_Snapshot) missing.push('mobile number');

    // Only block when EVERY targeted channel is unreachable — on 'Both' with just a phone number,
    // WhatsApp must still go out and email is reported as a per-channel failure.
    if (missing.length && missing.length === [wantEmail, wantWhatsapp].filter(Boolean).length) {
      return res.status(400).json({
        error: `This customer has no ${missing.join(' or ')} on file. Tap the customer card to add one.`
      });
    }

    // Either a legacy ready-made nodemailer array, or the builder's picker payload
    // ({ catalogIds, inline }) which dispatchService resolves against Media_Store.
    const dispatchService = require('../services/dispatchService');
    let attachments;
    if (Array.isArray(req.body.attachments)) {
      attachments = req.body.attachments;
    } else if (req.body.catalogIds || req.body.inlineAttachments) {
      attachments = {
        catalogIds: req.body.catalogIds,
        inline: req.body.inlineAttachments
      };
    }
    const results = await dispatchService.sendQuotation(quotation, attachments, channel, req.user);
    const updated = await quotationEngine.markDispatched(req.params.id, results, req.user);

    let followUpTask = null;
    if (results.some(r => r.ok) && !quotation.Follow_Up_Task_ID) {
      followUpTask = await createQuotationFollowUpTask(updated || quotation, req.user);
    }

    res.json({ quotation: updated, dispatchResults: results, followUpTask });
  } catch (err) {
    console.error('POST /quotations/dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch quotation' });
  }
});

/**
 * Module D: creates the "Quotation Follow-up" task that Admin + assigned Sales staff work from.
 * Kept here (rather than in quotationEngine) because it is a task-pipeline concern that needs the
 * same Tag_Master lookup the other task generators use.
 */
async function createQuotationFollowUpTask(quotation, actor) {
  const itemSummary = (quotation.Line_Items || [])
    .map(l => `${l.Item_Name || ''} - ${Number(l.Qty) || 0} ${l.Unit || 'Nos'}`)
    .join(', ');

  const tags = await sheetsService.getAllTags();
  let tagId = tags.find(t => String(t.name || '').trim().toLowerCase() === 'quotation follow-up')?.Tag_ID;
  if (!tagId) {
    tagId = `TAG${Date.now().toString().slice(-6)}`;
    await sheetsService.insertRow('Tag_Master', { Tag_ID: tagId, name: 'Quotation Follow-up', color: '#0284c7' });
  }

  const todayStr = quotationEngine.istToday();
  const task = {
    Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
    Customer_ID: quotation.Customer_ID,
    Description: `Quotation Follow-up - ${quotation.Quote_No_Display} - ${itemSummary}`,
    Assigned_Staff: quotation.Assigned_Staff || actor?.staffId || '',
    Department: 'Sales',
    Stage: quotationEngine.TASK_STAGE.QUOTATION_FLP,
    Type: 'One-time',
    Scheduled_Date: todayStr,
    Status: 'Pending',
    Tags: [tagId],
    Quotation_ID: quotation.Quotation_ID,
    Quote_No: quotation.Quote_No_Display,
    Quote_Amount: quotation.Grand_Total,
    Created_By: actor?.staffId || 'SYSTEM',
    Created_At: todayStr
  };

  await sheetsService.insertRow('Task_Master', task);
  await sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotation.Quotation_ID, {
    Follow_Up_Task_ID: task.Task_ID,
    Task_ID: quotation.Task_ID || task.Task_ID
  });
  return task;
}

// Module D: closing a quotation-pipeline task. Admin/Sales only, and an unsuccessful close must
// carry a Reason for Order Lost for analytics.
const ORDER_LOST_REASONS = ['Price High', 'Competitor', 'Delay', 'Requirement Cancelled', 'Other'];

router.post('/tasks/:id/close-quotation-task', async (req, res) => {
  try {
    const role = String(req.user.role || '');
    if (role !== 'Admin' && role !== 'Sales') {
      return res.status(403).json({ error: 'Only Admin or Sales staff can close a quotation follow-up task' });
    }

    const task = await sheetsService.getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const { outcome, reasonForOrderLost, remarks } = req.body;
    if (outcome !== 'Won' && outcome !== 'Lost') {
      return res.status(400).json({ error: 'outcome must be either "Won" or "Lost"' });
    }
    if (outcome === 'Lost' && !reasonForOrderLost) {
      return res.status(400).json({ error: `A Reason for Order Lost is required. One of: ${ORDER_LOST_REASONS.join(', ')}` });
    }

    const updateData = {
      Status: outcome === 'Lost' ? 'Closed - Lost' : 'Completed',
      Stage: quotationEngine.TASK_STAGE.ORDER_CLOSED,
      Closed_Outcome: outcome,
      Closed_By: req.user.staffId,
      Closed_At: new Date().toISOString(),
      Close_Remarks: remarks || ''
    };
    if (outcome === 'Lost') updateData.Reason_For_Order_Lost = reasonForOrderLost;

    const updated = await sheetsService.updateRow('Task_Master', 'Task_ID', req.params.id, updateData);

    if (task.Quotation_ID && outcome === 'Lost') {
      await quotationEngine.rejectQuotation(task.Quotation_ID, reasonForOrderLost, req.user);
    }

    res.json(updated);
  } catch (err) {
    console.error('POST /tasks/close-quotation-task error:', err);
    res.status(500).json({ error: 'Failed to close task' });
  }
});

router.get('/analytics/order-lost', async (req, res) => {
  try {
    const tasks = await sheetsService.getAllTasks();
    const lost = tasks.filter(t => t.Reason_For_Order_Lost);
    const byReason = {};
    ORDER_LOST_REASONS.forEach(r => { byReason[r] = { reason: r, count: 0, value: 0 }; });
    for (const t of lost) {
      const key = ORDER_LOST_REASONS.includes(t.Reason_For_Order_Lost) ? t.Reason_For_Order_Lost : 'Other';
      byReason[key].count++;
      byReason[key].value += Number(t.Quote_Amount) || 0;
    }
    res.json({
      totalLost: lost.length,
      totalLostValue: lost.reduce((s, t) => s + (Number(t.Quote_Amount) || 0), 0),
      byReason: Object.values(byReason).sort((a, b) => b.count - a.count)
    });
  } catch (err) {
    console.error('GET /analytics/order-lost error:', err);
    res.status(500).json({ error: 'Failed to build order-lost analytics' });
  }
});

// --- CONVERSION PIPELINE (Module G) ---
router.post('/quotations/:id/convert-to-pi', requirePermission('quotation','add'), async (req, res) => {
  try {
    res.json(await conversionService.convertQuotationToPI(req.params.id, req.user));
  } catch (err) {
    console.error('POST /convert-to-pi error:', err);
    res.status(400).json({ error: err.message || 'Conversion failed' });
  }
});

router.post('/quotations/:id/convert-to-invoice', requirePermission('quotation','add'), async (req, res) => {
  try {
    res.json(await conversionService.convertQuotationToInvoice(req.params.id, req.user));
  } catch (err) {
    console.error('POST /convert-to-invoice error:', err);
    res.status(400).json({ error: err.message || 'Conversion failed' });
  }
});

router.get('/proforma-invoices', async (req, res) => {
  try {
    const all = await sheetsService.getAllPIs();
    res.json(all.sort((a, b) => (Number(b.Created_At_Ms) || 0) - (Number(a.Created_At_Ms) || 0)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch proforma invoices' });
  }
});

router.get('/proforma-invoices/:id', async (req, res) => {
  try {
    const pi = await sheetsService.getPIById(req.params.id);
    if (!pi) return res.status(404).json({ error: 'PI not found' });
    res.json(pi);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch PI' });
  }
});

router.post('/proforma-invoices/:id/convert-to-invoice', requirePermission('quotation','add'), async (req, res) => {
  try {
    res.json(await conversionService.convertPIToInvoice(req.params.id, req.user));
  } catch (err) {
    console.error('POST /pi/convert-to-invoice error:', err);
    res.status(400).json({ error: err.message || 'Conversion failed' });
  }
});

/**
 * Shared dispatch handler for PI and Sales Invoice.
 *
 * Mirrors POST /quotations/:id/dispatch: same channel resolution, the same up-front refusal when
 * every targeted channel is unreachable, and the same per-channel result array. Kept generic
 * because the two documents differ only in collection, id field and template.
 *
 * Send-on-demand only — nothing here fires automatically at issue time. An invoice that went out
 * with a wrong rate cannot be un-sent, so a human presses the button.
 */
function makeSalesDocDispatchHandler({ collection, idField, load, sender, label }) {
  return async (req, res) => {
    try {
      const doc = await load(req.params.id);
      if (!doc) return res.status(404).json({ error: `${label} not found` });

      const channel = req.body.channel;
      if (channel && !['Email', 'WhatsApp', 'Both'].includes(channel)) {
        return res.status(400).json({ error: 'channel must be Email, WhatsApp or Both' });
      }

      const settings = await quotationEngine.getSettings();
      const mode = channel || settings.dispatch_mode || 'Email';
      const wantEmail = mode === 'Email' || mode === 'Both';
      const wantWhatsapp = mode === 'WhatsApp' || mode === 'Both';

      const missing = [];
      if (wantEmail && !doc.Customer_Email_Snapshot) missing.push('email address');
      if (wantWhatsapp && !doc.Customer_Contact_Snapshot) missing.push('mobile number');
      if (missing.length && missing.length === [wantEmail, wantWhatsapp].filter(Boolean).length) {
        return res.status(400).json({
          error: `This customer has no ${missing.join(' or ')} on file. Add one on the customer record and try again.`
        });
      }

      let attachments;
      if (Array.isArray(req.body.attachments)) {
        attachments = req.body.attachments;
      } else if (req.body.catalogIds || req.body.inlineAttachments) {
        attachments = { catalogIds: req.body.catalogIds, inline: req.body.inlineAttachments };
      }

      const dispatchService = require('../services/dispatchService');
      const results = await dispatchService[sender](doc, attachments, channel, req.user);

      const log = Array.isArray(doc.Dispatch_Log) ? doc.Dispatch_Log : [];
      const entries = results.map(r => ({
        channel: r.channel,
        status: r.ok ? 'sent' : 'failed',
        error: r.ok ? '' : String(r.error || ''),
        recipient: r.recipient || '',
        timestamp: new Date().toISOString()
      }));
      const update = { Dispatch_Log: [...log, ...entries], Last_Dispatched_At: new Date().toISOString() };
      if (entries.some(e => e.status === 'sent')) update.Sent_At = new Date().toISOString();

      const updated = await sheetsService.updateRow(collection, idField, req.params.id, update);
      res.json({ document: updated, dispatchResults: results });
    } catch (err) {
      console.error(`POST /${label} dispatch error:`, err);
      res.status(500).json({ error: err.message || `Failed to dispatch ${label}` });
    }
  };
}

router.post('/proforma-invoices/:id/dispatch', requirePermission('quotation', 'edit'),
  makeSalesDocDispatchHandler({
    collection: 'PI_Master',
    idField: 'PI_ID',
    load: id => sheetsService.getPIById(id),
    sender: 'sendProformaInvoice',
    label: 'Proforma Invoice'
  }));

router.post('/sales-invoices/:id/dispatch', requirePermission('quotation', 'edit'),
  makeSalesDocDispatchHandler({
    collection: 'Sales_Invoice_Master',
    idField: 'Invoice_ID',
    load: id => sheetsService.getSalesInvoiceById(id),
    sender: 'sendSalesInvoice',
    label: 'Sales Invoice'
  }));

router.get('/sales-invoices', async (req, res) => {
  try {
    const all = await sheetsService.getAllSalesInvoices();
    res.json(all.sort((a, b) => (Number(b.Created_At_Ms) || 0) - (Number(a.Created_At_Ms) || 0)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sales invoices' });
  }
});

router.get('/sales-invoices/:id', async (req, res) => {
  try {
    const invoice = await sheetsService.getSalesInvoiceById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

router.post('/sales-invoices/:id/record-payment', requirePermission('quotation','edit'), async (req, res) => {
  try {
    res.json(await conversionService.recordPayment(req.params.id, req.body, req.user));
  } catch (err) {
    console.error('POST /record-payment error:', err);
    res.status(400).json({ error: err.message || 'Failed to record payment' });
  }
});

// --- WORKSHOP JOB CARD ---
// Route order matters: Express matches in registration order, so every literal path below must be
// declared before the '/job-cards/:id' pattern or the param route swallows it. Same precedent as
// '/items/recycle-bin' sitting above '/items/:id'.

router.get('/equipment-categories', requirePermission('jobcard','view'), async (req, res) => {
  try {
    res.json(await equipmentCategoryService.getCategories({ includeInactive: req.query.includeInactive === 'true' }));
  } catch (err) {
    console.error('GET /equipment-categories error:', err);
    res.status(500).json({ error: 'Failed to fetch equipment categories' });
  }
});

router.post('/equipment-categories', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    res.json(await equipmentCategoryService.createCategory(req.body, req.user));
  } catch (err) {
    console.error('POST /equipment-categories error:', err);
    res.status(400).json({ error: err.message || 'Failed to create equipment category' });
  }
});

router.put('/equipment-categories/:id', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    res.json(await equipmentCategoryService.updateCategory(req.params.id, req.body, req.user));
  } catch (err) {
    console.error('PUT /equipment-categories error:', err);
    res.status(400).json({ error: err.message || 'Failed to update equipment category' });
  }
});

router.get('/job-cards', requirePermission('jobcard','view'), async (req, res) => {
  try {
    let cards = await sheetsService.getAllJobCards();
    const { taskId, customerId, status } = req.query;
    if (taskId) cards = cards.filter(c => c.Task_ID === taskId);
    if (customerId) cards = cards.filter(c => c.Customer_ID === customerId);
    if (status) cards = cards.filter(c => c.Status === status);
    res.json(cards.sort((a, b) => (b.Created_At_Ms || 0) - (a.Created_At_Ms || 0)));
  } catch (err) {
    console.error('GET /job-cards error:', err);
    res.status(500).json({ error: 'Failed to fetch job cards' });
  }
});

router.get('/job-cards/lookup-hpt', requirePermission('jobcard','view'), async (req, res) => {
  try {
    const { customerId, euidNo, cylinderNo, serialNo, clientIdNo } = req.query;
    res.json(await jobCardService.resolveLastHpTestDate(customerId, { euidNo, cylinderNo, serialNo, clientIdNo }));
  } catch (err) {
    console.error('GET /job-cards/lookup-hpt error:', err);
    res.status(500).json({ error: 'Failed to look up hydro-test history' });
  }
});

router.get('/job-cards/by-task/:taskId', requirePermission('jobcard','view'), async (req, res) => {
  try {
    const found = await jobCardService.getJobCardByTask(req.params.taskId);
    // 404 is the signal the client uses to decide Create vs Open, so it is expected, not an error.
    if (!found) return res.status(404).json({ error: 'No job card for this task' });
    res.json(found);
  } catch (err) {
    console.error('GET /job-cards/by-task error:', err);
    res.status(500).json({ error: 'Failed to fetch job card' });
  }
});

router.post('/job-cards', requirePermission('jobcard','add'), async (req, res) => {
  try {
    res.json(await jobCardService.createJobCard(req.body, req.user));
  } catch (err) {
    console.error('POST /job-cards error:', err);
    res.status(400).json({ error: err.message || 'Failed to create job card' });
  }
});

router.put('/job-cards/items/:itemId', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await jobCardService.updateJobCardItem(req.params.itemId, req.body, req.user));
  } catch (err) {
    console.error('PUT /job-cards/items error:', err);
    res.status(400).json({ error: err.message || 'Failed to update item' });
  }
});

router.delete('/job-cards/items/:itemId', requirePermission('jobcard','delete'), async (req, res) => {
  try {
    res.json({ success: await jobCardService.deleteJobCardItem(req.params.itemId) });
  } catch (err) {
    console.error('DELETE /job-cards/items error:', err);
    res.status(400).json({ error: err.message || 'Failed to delete item' });
  }
});

router.post('/job-cards/items/:itemId/parts', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    const { parts, consumeStock, date } = req.body;
    res.json(await jobCardService.addPartsToItem(req.params.itemId, parts, req.user, {
      consumeStock: consumeStock !== false,
      date
    }));
  } catch (err) {
    console.error('POST /job-cards/items/parts error:', err);
    res.status(400).json({ error: err.message || 'Failed to add parts' });
  }
});

router.delete('/job-cards/items/:itemId/parts/:lineId', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await jobCardService.removePartFromItem(req.params.itemId, req.params.lineId, req.user));
  } catch (err) {
    console.error('DELETE /job-cards/items/parts error:', err);
    res.status(400).json({ error: err.message || 'Failed to remove part' });
  }
});

router.get('/job-cards/:id', requirePermission('jobcard','view'), async (req, res) => {
  try {
    const found = await jobCardService.getJobCardFull(req.params.id);
    if (!found) return res.status(404).json({ error: 'Job card not found' });
    res.json(found);
  } catch (err) {
    console.error('GET /job-cards/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch job card' });
  }
});

router.post('/job-cards/:id/items', requirePermission('jobcard','add'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body.items;
    res.json(await jobCardService.addJobCardItems(req.params.id, rows, req.user));
  } catch (err) {
    console.error('POST /job-cards/items error:', err);
    res.status(400).json({ error: err.message || 'Failed to add items' });
  }
});

router.get('/job-cards/:id/pending-rechecks', requirePermission('jobcard','view'), async (req, res) => {
  try {
    res.json(await jobCardService.getPendingRechecks(req.params.id));
  } catch (err) {
    console.error('GET /job-cards/pending-rechecks error:', err);
    res.status(500).json({ error: 'Failed to fetch pending rechecks' });
  }
});

router.post('/job-cards/:id/recheck', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    const resolutions = Array.isArray(req.body) ? req.body : req.body.resolutions;
    res.json(await jobCardService.applyRecheck(req.params.id, resolutions, req.user));
  } catch (err) {
    console.error('POST /job-cards/recheck error:', err);
    res.status(400).json({ error: err.message || 'Failed to record recheck' });
  }
});

router.post('/job-cards/:id/complete', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await jobCardService.completeService(req.params.id, req.user));
  } catch (err) {
    console.error('POST /job-cards/complete error:', err);
    // 409 carries the unresolved inward issues so the client can reopen the recheck modal on them.
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, pendingRechecks: err.pendingRechecks });
    }
    res.status(400).json({ error: err.message || 'Failed to complete job card' });
  }
});

router.get('/job-cards/:id/standby', requirePermission('jobcard','view'), async (req, res) => {
  try {
    res.json(await jobCardService.getPendingStandby(req.params.id));
  } catch (err) {
    console.error('GET /job-cards/standby error:', err);
    res.status(400).json({ error: err.message || 'Failed to fetch standby units' });
  }
});

router.post('/job-cards/:id/standby', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    const units = Array.isArray(req.body) ? req.body : req.body.units;
    res.json(await jobCardService.issueStandby(req.params.id, units, req.user));
  } catch (err) {
    console.error('POST /job-cards/standby error:', err);
    res.status(400).json({ error: err.message || 'Failed to issue standby units' });
  }
});

router.post('/job-cards/:id/standby/return', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    const euids = Array.isArray(req.body) ? req.body : req.body.euids;
    res.json(await jobCardService.returnStandby(req.params.id, euids, req.user));
  } catch (err) {
    console.error('POST /job-cards/standby/return error:', err);
    res.status(400).json({ error: err.message || 'Failed to record standby return' });
  }
});

// Records that the customer is keeping a loaner. The only way past the proof-of-delivery standby
// block, so the service demands a written reason and logs it three ways.
router.post('/job-cards/:id/standby/retain', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    const { euids, reason } = req.body || {};
    res.json(await jobCardService.retainStandby(req.params.id, euids, { reason }, req.user));
  } catch (err) {
    console.error('POST /job-cards/standby/retain error:', err);
    res.status(400).json({ error: err.message || 'Failed to record standby retention' });
  }
});

router.post('/job-cards/:id/generate-challan', requirePermission('jobcard','add'), async (req, res) => {
  try {
    const { itemIds, challanDate } = req.body || {};
    res.json(await challanService.generateChallanDraft(req.params.id, { itemIds, challanDate }, req.user));
  } catch (err) {
    console.error('POST /job-cards/generate-challan error:', err);
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, pendingRechecks: err.pendingRechecks });
    }
    res.status(400).json({ error: err.message || 'Failed to generate challan draft' });
  }
});

// --- DELIVERY CHALLAN ---
// '/challans/suggest-no' is registered before '/challans/:id' so the param route cannot swallow it.

router.get('/challans', requirePermission('jobcard','view'), async (req, res) => {
  try {
    let rows = await sheetsService.getAllChallans();
    const { status, customerId, jobCardId } = req.query;
    if (status) rows = rows.filter(c => c.Status === status);
    if (customerId) rows = rows.filter(c => c.Customer_ID === customerId);
    if (jobCardId) rows = rows.filter(c => c.Job_Card_ID === jobCardId);
    res.json(rows.sort((a, b) => (b.Created_At_Ms || 0) - (a.Created_At_Ms || 0)));
  } catch (err) {
    console.error('GET /challans error:', err);
    res.status(500).json({ error: 'Failed to fetch challans' });
  }
});

router.get('/challans/suggest-no', requirePermission('jobcard','view'), async (req, res) => {
  try {
    res.json({ suggestion: await challanService.suggestNextChallanNo() });
  } catch (err) {
    console.error('GET /challans/suggest-no error:', err);
    res.status(500).json({ error: 'Failed to suggest a challan number' });
  }
});

router.get('/challans/:id', requirePermission('jobcard','view'), async (req, res) => {
  try {
    const challan = await sheetsService.getChallanById(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found' });
    res.json(challan);
  } catch (err) {
    console.error('GET /challans/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch challan' });
  }
});

router.put('/challans/:id', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await challanService.updateChallanDraft(req.params.id, req.body, req.user));
  } catch (err) {
    console.error('PUT /challans/:id error:', err);
    res.status(400).json({ error: err.message || 'Failed to update challan' });
  }
});

router.post('/challans/:id/issue', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await challanService.issueChallan(req.params.id, req.body, req.user));
  } catch (err) {
    console.error('POST /challans/:id/issue error:', err);
    // A duplicate number and an outstanding loaner are both warnings the user can override, not
    // hard failures — the 409 carries whichever applies so the UI can show what it clashed with.
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, duplicateOf: err.duplicateOf, pendingStandby: err.pendingStandby });
    }
    res.status(400).json({ error: err.message || 'Failed to issue challan' });
  }
});

// Gated on the quotation module, not jobcard: this is the point money is created, and a workshop
// technician who may raise a challan should not thereby be able to raise a tax invoice.
router.post('/challans/:id/convert-to-invoice', requirePermission('quotation','add'), async (req, res) => {
  try {
    res.json(await challanService.convertChallanToInvoice(req.params.id, req.body || {}, req.user));
  } catch (err) {
    console.error('POST /challans/convert-to-invoice error:', err);
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, unpricedLines: err.unpricedLines });
    }
    res.status(400).json({ error: err.message || 'Failed to create invoice' });
  }
});

/**
 * Email address for a document that does not snapshot one. Prefers the snapshot (frozen at issue
 * time, which is the value the rest of the pipeline treats as authoritative) and only falls back to
 * the live Customer_Master row when it is blank — which is every challan and every certificate
 * raised before those snapshots existed.
 */
async function resolveCustomerEmail(snapshotEmail, customerId) {
  if (snapshotEmail) return snapshotEmail;
  if (!customerId) return '';
  const customers = await sheetsService.getAllCustomers();
  const match = customers.find(c => String(c.Customer_ID || '').trim().toLowerCase()
    === String(customerId).trim().toLowerCase());
  return match?.Email || '';
}

/** Appends a dispatch attempt to any document's Dispatch_Log. Shared by challan + certificate. */
async function recordDispatchAttempt(collection, idField, idValue, existingLog, results) {
  const entries = results.map(r => ({
    channel: r.channel,
    status: r.ok ? 'sent' : 'failed',
    error: r.ok ? '' : String(r.error || ''),
    recipient: r.recipient || '',
    timestamp: new Date().toISOString()
  }));
  const update = {
    Dispatch_Log: [...(Array.isArray(existingLog) ? existingLog : []), ...entries],
    Last_Dispatched_At: new Date().toISOString()
  };
  return sheetsService.updateRow(collection, idField, idValue, update);
}

// Emails an ISSUED challan to the customer. A draft is refused: the number is typed by hand at
// issue time, so a draft has no number on it and would reach the customer as a blank reference.
// Confirms the delivery to the customer once they have signed. Registered alongside /pod rather
// than under it — distinct literal segments, so no route-order conflict with /challans/:id.
router.post('/challans/:id/pod-notify', requirePermission('jobcard', 'edit'), async (req, res) => {
  try {
    const challan = await sheetsService.getChallanById(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found' });
    if (!challan.POD?.deliveredAt) {
      return res.status(400).json({ error: 'Record the proof of delivery before sending a confirmation' });
    }

    const recipientEmail = await resolveCustomerEmail(challan.Customer_Email_Snapshot, challan.Customer_ID);
    const dispatchService = require('../services/dispatchService');
    const results = await dispatchService.sendPodConfirmation(challan, {
      recipientEmail,
      // The delivery boy picks the channel at the gate — WhatsApp usually reaches the person who
      // just signed faster than email does.
      channel: req.body.channel,
      actor: req.user
    });

    const updated = await recordDispatchAttempt('Delivery_Challan_Master', 'Challan_ID', req.params.id, challan.Dispatch_Log, results);
    res.json({ document: updated, dispatchResults: results });
  } catch (err) {
    console.error('POST /challans/:id/pod-notify error:', err);
    res.status(500).json({ error: err.message || 'Failed to send the delivery confirmation' });
  }
});

router.post('/challans/:id/dispatch', requirePermission('jobcard', 'edit'), async (req, res) => {
  try {
    const challan = await sheetsService.getChallanById(req.params.id);
    if (!challan) return res.status(404).json({ error: 'Challan not found' });
    if (challan.Status !== 'Issued') {
      return res.status(400).json({ error: 'Only an issued challan can be emailed — issue it with its challan-book number first' });
    }

    const recipientEmail = await resolveCustomerEmail(challan.Customer_Email_Snapshot, challan.Customer_ID);
    if (!recipientEmail) {
      return res.status(400).json({ error: 'This customer has no email address on file. Add one on the customer record and try again.' });
    }

    const dispatchService = require('../services/dispatchService');
    const results = await dispatchService.sendChallan(challan, {
      recipientEmail,
      attachments: req.body.inlineAttachments ? { inline: req.body.inlineAttachments } : undefined,
      channel: 'Email',
      actor: req.user
    });

    const updated = await recordDispatchAttempt('Delivery_Challan_Master', 'Challan_ID', req.params.id, challan.Dispatch_Log, results);
    res.json({ document: updated, dispatchResults: results });
  } catch (err) {
    console.error('POST /challans/:id/dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to email challan' });
  }
});

// Emails a certificate. Keyed on the verification GUID, the same identifier the public QR page and
// PUT/DELETE /certificates/:guid use.
router.post('/certificates/:guid/dispatch', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') {
      const staff = await sheetsService.getStaffById(req.user.staffId);
      if (!staff || !staff.Can_Access_Certificates) {
        return res.status(403).json({ error: 'You do not have permission to send certificates. Contact Admin.' });
      }
    }

    const cert = await sheetsService.getCertificateByGuid(req.params.guid);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    const raw = cert.toObject ? cert.toObject() : cert;
    if (raw.Is_Deleted) return res.status(410).json({ error: 'This certificate has been revoked and cannot be sent' });

    const recipientEmail = await resolveCustomerEmail(
      raw.Customer_Email || raw.customerEmail,
      raw.Customer_ID || raw.customerId
    );
    if (!recipientEmail) {
      return res.status(400).json({ error: 'This customer has no email address on file. Add one on the customer record and try again.' });
    }

    const dispatchService = require('../services/dispatchService');
    const results = await dispatchService.sendCertificate(raw, {
      recipientEmail,
      // The certificate PDF is rendered in the browser by html2canvas, exactly like the quotation
      // PDF, so the page posts the bytes with the send rather than the server re-rendering it.
      attachments: req.body.inlineAttachments ? { inline: req.body.inlineAttachments } : undefined,
      channel: 'Email',
      actor: req.user
    });

    // Same key fallback as PUT /certificates/:guid — older rows were written under the PascalCase
    // spelling. A failed log write must never lose a mail that has already gone out, so the
    // results are returned either way.
    let updated = await recordDispatchAttempt('Document_Registry', 'verificationGuid', req.params.guid, raw.Dispatch_Log, results);
    if (!updated) {
      updated = await recordDispatchAttempt('Document_Registry', 'Verification_GUID', req.params.guid, raw.Dispatch_Log, results);
    }
    res.json({ document: updated || raw, dispatchResults: results });
  } catch (err) {
    console.error('POST /certificates/:guid/dispatch error:', err);
    res.status(500).json({ error: err.message || 'Failed to email certificate' });
  }
});

router.get('/challans/:id/certificate-prefill', requirePermission('jobcard','view'), async (req, res) => {
  try {
    res.json(await challanService.buildCertificatePrefill(req.params.id, req.query.formatType));
  } catch (err) {
    console.error('GET /challans/certificate-prefill error:', err);
    res.status(400).json({ error: err.message || 'Failed to build certificate prefill' });
  }
});

router.post('/challans/:id/pod', requirePermission('jobcard','edit'), async (req, res) => {
  try {
    res.json(await challanService.recordPOD(req.params.id, req.body || {}, req.user));
  } catch (err) {
    console.error('POST /challans/pod error:', err);
    // 409 carries the un-returned loaner units so the app can list exactly what is still out.
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message, pendingStandby: err.pendingStandby });
    }
    res.status(400).json({ error: err.message || 'Failed to record proof of delivery' });
  }
});

router.post('/challans/:id/cancel', requirePermission('jobcard','delete'), async (req, res) => {
  try {
    res.json(await challanService.cancelChallan(req.params.id, req.body?.reason, req.user));
  } catch (err) {
    console.error('POST /challans/:id/cancel error:', err);
    res.status(400).json({ error: err.message || 'Failed to cancel challan' });
  }
});

// --- CUSTOMER PRICE LIST ---
// Builds itself from dispatched quotations and raised invoices; the routes below are for viewing
// and for the manual corrections that override them.

router.get('/price-list/resolve', requirePermission('quotation','view'), async (req, res) => {
  try {
    const itemIds = String(req.query.itemIds || '').split(',').map(s => s.trim()).filter(Boolean);
    res.json(await priceListService.resolveRates(req.query.customerId, itemIds));
  } catch (err) {
    console.error('GET /price-list/resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve rates' });
  }
});

router.get('/price-list/:customerId', requirePermission('quotation','view'), async (req, res) => {
  try {
    res.json(await priceListService.getPriceList(req.params.customerId));
  } catch (err) {
    console.error('GET /price-list error:', err);
    res.status(500).json({ error: 'Failed to fetch price list' });
  }
});

router.put('/price-list/:customerId/:itemId', requirePermission('quotation','edit'), async (req, res) => {
  try {
    const { rate, locked, itemName } = req.body || {};
    res.json(await priceListService.setManualPrice(req.params.customerId, req.params.itemId, { rate, locked, itemName }, req.user));
  } catch (err) {
    console.error('PUT /price-list error:', err);
    res.status(400).json({ error: err.message || 'Failed to save price' });
  }
});

router.delete('/price-list/:priceId', requirePermission('quotation','delete'), async (req, res) => {
  try {
    res.json({ success: await priceListService.deletePrice(req.params.priceId) });
  } catch (err) {
    console.error('DELETE /price-list error:', err);
    res.status(400).json({ error: err.message || 'Failed to delete price' });
  }
});

// --- INVENTORY (Module E) ---
router.get('/inventory/balance', requirePermission('inventory','view'), async (req, res) => {
  try {
    res.json(await inventoryService.getBalances());
  } catch (err) {
    console.error('GET /inventory/balance error:', err);
    res.status(500).json({ error: 'Failed to fetch stock balances' });
  }
});

router.get('/inventory/low-stock', requirePermission('inventory','view'), async (req, res) => {
  try {
    res.json(await inventoryService.getLowStock());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch low stock items' });
  }
});

router.get('/inventory/transactions', requirePermission('inventory','view'), async (req, res) => {
  try {
    const all = await sheetsService.getStockTransactions();
    const { itemId, type, fromDate, toDate } = req.query;
    let filtered = all;
    if (itemId) filtered = filtered.filter(t => t.Item_ID === itemId);
    if (type) filtered = filtered.filter(t => t.Type === type);
    if (fromDate) filtered = filtered.filter(t => String(t.Date) >= fromDate);
    if (toDate) filtered = filtered.filter(t => String(t.Date) <= toDate);
    res.json(filtered.sort((a, b) => String(b.Created_At).localeCompare(String(a.Created_At))));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stock transactions' });
  }
});

router.post('/inventory/inward', requirePermission('inventory','add'), async (req, res) => {
  try {
    const result = await inventoryService.recordInward({
      itemId: req.body.itemId,
      qty: req.body.qty,
      unit: req.body.unit,
      supplierName: req.body.supplierName,
      supplierInvoiceNo: req.body.supplierInvoiceNo,
      notes: req.body.notes,
      date: req.body.date,
      recordedBy: req.user.staffId
    });
    res.json(result);
  } catch (err) {
    console.error('POST /inventory/inward error:', err);
    res.status(400).json({ error: err.message || 'Failed to record stock inward' });
  }
});

router.post('/inventory/usage', requirePermission('inventory','add'), async (req, res) => {
  try {
    const result = await inventoryService.recordUsage({
      itemId: req.body.itemId,
      qty: req.body.qty,
      unit: req.body.unit,
      clientId: req.body.clientId,
      site: req.body.site,
      notes: req.body.notes,
      date: req.body.date,
      recordedBy: req.user.staffId
    });
    res.json(result);
  } catch (err) {
    console.error('POST /inventory/usage error:', err);
    res.status(400).json({ error: err.message || 'Failed to record stock usage' });
  }
});

router.post('/inventory/adjustment', requirePermission('inventory','edit'), async (req, res) => {
  try {
    const result = await inventoryService.recordAdjustment({
      itemId: req.body.itemId,
      qty: req.body.qty,
      unit: req.body.unit,
      notes: req.body.notes || 'Manual stock adjustment',
      date: req.body.date,
      recordedBy: req.user.staffId
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to record adjustment' });
  }
});

router.put('/inventory/:itemId/reorder-level', requirePermission('inventory','edit'), async (req, res) => {
  try {
    await inventoryService.ensureInventoryRow(req.params.itemId);
    const updated = await sheetsService.updateRow('Inventory_Master', 'Item_ID', req.params.itemId, {
      Reorder_Level: Number(req.body.reorderLevel) || 0,
      Last_Updated_At: new Date().toISOString()
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update reorder level' });
  }
});

router.get('/inventory/consumption-report', requirePermission('inventory','view'), async (req, res) => {
  try {
    res.json(await inventoryService.getConsumptionReport({
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      itemId: req.query.itemId,
      clientId: req.query.clientId
    }));
  } catch (err) {
    console.error('GET /inventory/consumption-report error:', err);
    res.status(500).json({ error: 'Failed to build consumption report' });
  }
});

module.exports = router;
