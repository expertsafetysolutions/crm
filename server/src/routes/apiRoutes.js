const express = require('express');
const bcrypt = require('bcryptjs');
const sheetsService = require('../services/sheetsService');
const workflowEngine = require('../services/workflowEngine');
const attendanceService = require('../services/attendanceService');
const driveService = require('../services/driveService');
const { authenticateToken } = require('./authRoutes');
const { verifyStaffPassword, validatePasswordPolicy } = require('../utils/passwordUtils');

const router = express.Router();

router.use(authenticateToken);

// Auto-injects a system-generated entry into the company's remark timeline (Customer_Interactions)
// on task lifecycle events (created / status changed / completed). Mirrors the shape of manually
// logged remarks (POST /customer-interactions) so it renders in the same timeline UI, tagged with
// System_Generated: true so it can be styled distinctly from staff-written remarks.
async function logSystemTaskRemark({ customerId, taskId, remarkText, tag, staffId, staffName }) {
  const nowMs = Date.now();
  await sheetsService.insertRow('Customer_Interactions', {
    Interaction_ID: `INT_${nowMs}`,
    Created_At: nowMs,
    Customer_ID: customerId || '',
    Task_ID: taskId || '',
    Timestamp: new Date().toISOString(),
    Type: tag,
    Staff_ID: staffId || 'SYSTEM',
    Staff_Name: staffName || 'System',
    Remarks: remarkText,
    System_Generated: true
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

    const cleanStaff = allStaff.map(({ Password, ...rest }) => rest);

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
router.get('/certificates', async (req, res) => {
  try {
    const certs = await sheetsService.getAllCertificates();
    res.json(certs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
});

router.post('/certificates', async (req, res) => {
  try {
    const newCert = await sheetsService.insertRow('Document_Registry', req.body);
    res.json({ success: true, certificate: newCert });
  } catch (err) {
    console.error('Save certificate failed:', err);
    res.status(500).json({ error: 'Failed to save certificate record' });
  }
});

router.put('/certificates/:guid', async (req, res) => {
  try {
    const updated = await sheetsService.updateRow('Document_Registry', 'verificationGuid', req.params.guid, req.body);
    if (!updated) {
      const byNo = await sheetsService.updateRow('Document_Registry', 'Certificate_No', req.params.guid, req.body);
      if (!byNo) return res.status(404).json({ error: 'Certificate not found' });
      return res.json({ success: true, certificate: byNo });
    }
    res.json({ success: true, certificate: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update certificate' });
  }
});

router.post('/certificates/upload-pdf', async (req, res) => {
  try {
    const { pdfBase64, certificateNo } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'PDF data missing' });
    
    const safeFilename = (certificateNo || 'Certificate').replace(/[^a-z0-9]/gi, '_') + '.pdf';
    const file = await driveService.uploadPdfToDrive(pdfBase64, safeFilename);
    
    res.json({ success: true, file });
  } catch (err) {
    console.error('PDF Upload failed:', err);
    res.status(500).json({ error: err.message || 'Failed to upload PDF to Google Drive' });
  }
});

// --- SERVICE REPORTS ENDPOINTS ---
router.get('/service-reports', async (req, res) => {
  try {
    const reports = await sheetsService.getAllServiceReports();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch service reports' });
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

// --- CLIENT EQUIPMENT MASTER INVENTORY ENDPOINTS ---
router.get('/client-equipment/:customerId', async (req, res) => {
  try {
    const items = await sheetsService.getTab('Client_Equipment_Master');
    const filtered = items.filter(x => String(x.Customer_ID || x.customerId || '').toLowerCase() === String(req.params.customerId).toLowerCase());
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch client equipment master' });
  }
});

router.post('/client-equipment/:customerId', async (req, res) => {
  try {
    const { items } = req.body;
    const customerId = req.params.customerId;
    const inserted = await sheetsService.insertRow('Client_Equipment_Master', {
      Customer_ID: customerId,
      items: items || [],
      Updated_At: new Date().toISOString()
    });
    res.json({ success: true, record: inserted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save client equipment master' });
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

    const allStaff = await sheetsService.getAllStaff();
    const nextIdNum = allStaff.length + 1;
    const newStaff = {
      Staff_ID: `STAFF00${nextIdNum}`,
      Name: name,
      Mobile: mobile ? (mobile.startsWith('+') ? mobile : `+91 ${mobile}`) : '+91 90000 00000',
      Email: email || `${name.toLowerCase().replace(/\s+/g, '.')}@expertsafety.in`,
      Password: bcrypt.hashSync(password || 'staff123', 8),
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
    const [tasks, leaves, staffList, advances] = await Promise.all([
      sheetsService.getAllTasks(),
      sheetsService.getAllLeaves(),
      sheetsService.getAllStaff(),
      sheetsService.getAdvances()
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

    const newCustomer = {
      Customer_ID: `CUST${Date.now().toString().slice(-4)}`,
      Company_Name: req.body.companyName || 'New Customer',
      Auth_Person: req.body.authPerson || '',
      Contact: formattedContact,
      Email: req.body.email || '',
      Location_Link: req.body.locationLink || '',
      Address: req.body.address || '',
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

      if (existingCust) {
        await sheetsService.updateRow('Customer_Master', 'Customer_ID', row.Customer_ID, {
          Company_Name: row.Company_Name || existingCust.Company_Name,
          Auth_Person: row.Auth_Person || existingCust.Auth_Person,
          Contact: row.Contact || existingCust.Contact,
          Secondary_Contact: row.Secondary_Contact || existingCust.Secondary_Contact || '',
          Email: row.Email || existingCust.Email,
          Location_Link: row.Location_Link || existingCust.Location_Link,
          Address: row.Address || existingCust.Address,
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
    res.status(500).json({ error: 'Failed to record customer interaction' });
  }
});

router.put('/customer-interactions/:id', async (req, res) => {
  try {
    const updated = await sheetsService.updateRow('Customer_Interactions', 'Interaction_ID', req.params.id, {
      Remarks: req.body.remarks
    });
    if (!updated) return res.status(404).json({ error: 'Interaction not found' });
    res.json(updated);
  } catch (err) {
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
router.put('/tasks/:id/stage', async (req, res) => {
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
router.delete('/tasks/:id', async (req, res) => {
  try {
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

    const syncResults = [];
    for (const item of actions) {
      try {
        if (item.type === 'ADVANCE_STAGE') {
          const resStage = await workflowEngine.advanceTaskStage(item.payload.taskId, {
            staffId: req.user.staffId,
            targetStage: item.payload.targetStage,
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
        }
      } catch (innerErr) {
        console.error('Batch sync item error:', innerErr);
        syncResults.push({ id: item.id, status: 'ERROR', error: innerErr.message });
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
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update leave request status' });
  }
};

router.put('/leaves/status', updateLeaveStatusHandler);
router.patch('/leaves/status', updateLeaveStatusHandler);
router.put('/leaves/:requestId/status', updateLeaveStatusHandler);
router.patch('/leaves/:requestId/status', updateLeaveStatusHandler);

// --- DOCUMENT & TEMPLATE SETTINGS (Admin Only) ---
router.get('/document-settings', async (req, res) => {
  try {
    if (req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin only' });
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

module.exports = router;
