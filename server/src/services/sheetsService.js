const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Flexible Schemas mapping to the old "Tabs"
const createModel = (name) => {
  const schema = new mongoose.Schema({}, { strict: false, collection: name });
  return mongoose.models[name] || mongoose.model(name, schema);
};

const models = {
  Staff_Master: createModel('Staff_Master'),
  Customer_Master: createModel('Customer_Master'),
  Task_Master: createModel('Task_Master'),
  Activity_Logs: createModel('Activity_Logs'),
  Attendance_Log: createModel('Attendance_Log'),
  Leave_Requests: createModel('Leave_Requests'),
  Customer_Interactions: createModel('Customer_Interactions'),
  Salary_Advances: createModel('Salary_Advances'),
  Document_Registry: createModel('Document_Registry'),
  Equipment_Master: createModel('Equipment_Master'),
  Service_Reports: createModel('Service_Reports'),
  Client_Equipment_Master: createModel('Client_Equipment_Master'),
  Document_Settings: createModel('Document_Settings'),
  Tag_Master: createModel('Tag_Master')
};

class MongoService {
  constructor() {
    this.isConnected = false;
    this.cache = {};
    this.cacheTTL = 3000; // 3 seconds TTL for ultra-fast queries without DB thrashing
  }

  async connect(uri) {
    const targetUri = uri || process.env.MONGO_URI || 'mongodb+srv://vortexxx421_db_user:xGPUPuzdzXilB3Ix@expertcrm.wpxo9jh.mongodb.net/?appName=ExpertCRM';
    if (mongoose.connection.readyState === 1) {
      this.isConnected = true;
      return;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.connectionPromise = mongoose.connect(targetUri).then(() => {
      this.isConnected = true;
      console.log('✅ Connected to MongoDB Atlas');
    }).catch(err => {
      this.connectionPromise = null;
      console.error('❌ MongoDB Connection Error:', err);
      throw err;
    });
    return this.connectionPromise;
  }

  async getTab(sheetName) {
    const now = Date.now();
    if (this.cache[sheetName] && (now - this.cache[sheetName].timestamp < this.cacheTTL)) {
      return this.cache[sheetName].data;
    }
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    const data = await Model.find({}).lean();
    // Remove _id and __v for backward compatibility with existing JSON code
    const cleanData = data.map(doc => {
      delete doc._id;
      delete doc.__v;
      return doc;
    });
    this.cache[sheetName] = { timestamp: now, data: cleanData };
    return cleanData;
  }

  async insertRow(sheetName, data) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    const doc = new Model(data);
    await doc.save();
    return data;
  }

  async updateRow(sheetName, idColumn, idValue, updateData) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    let query = { [idColumn]: idValue };
    if (typeof idValue === 'string') {
      query = {
        $or: [
          { [idColumn]: idValue },
          { [idColumn]: idValue.trim() },
          { [idColumn]: new RegExp(`^${idValue.trim()}$`, 'i') }
        ]
      };
    }

    let oldDoc = null;
    if (sheetName === 'Task_Master') {
      try {
        oldDoc = await Model.findOne(query).lean();
      } catch (e) {
        console.error('Error fetching oldDoc inside updateRow:', e);
      }
    }

    const updated = await Model.findOneAndUpdate(query, { $set: updateData }, { new: true, returnDocument: 'after' }).lean();
    if (updated) {
      delete updated._id;
      delete updated.__v;

      // Automatically handle recurring task re-opening/creation
      if (sheetName === 'Task_Master' && oldDoc) {
        const wasCompleted = oldDoc.Status === 'Completed' || oldDoc.Status === 'Closed';
        const isCompleted = updated.Status === 'Completed' || updated.Status === 'Closed';
        const isRecurring = String(updated.Type || oldDoc.Type).toLowerCase() === 'recurring';
        
        if (isRecurring && isCompleted && !wasCompleted) {
          try {
            const interval = updated.Recurring_Interval || oldDoc.Recurring_Interval || 'Monthly';
            const period = updated.Recurring_Period || oldDoc.Recurring_Period;
            const currentSchedDate = updated.Scheduled_Date || oldDoc.Scheduled_Date;
            
            const calculateNextDate = (dateStr, rInterval, rPeriod) => {
              let d = new Date();
              if (dateStr) {
                const parts = dateStr.split('-');
                if (parts.length === 3) {
                  if (parts[0].length === 4) {
                    d = new Date(parts[0], parts[1] - 1, parts[2]);
                  } else {
                    d = new Date(parts[2], parts[1] - 1, parts[0]);
                  }
                }
              }
              
              let val = 1;
              let norm = String(rInterval).trim().toLowerCase();
              if (rPeriod) {
                try {
                  const p = typeof rPeriod === 'string' ? JSON.parse(rPeriod) : rPeriod;
                  if (p.value && !isNaN(p.value)) val = Number(p.value);
                  if (p.type) norm = String(p.type).trim().toLowerCase();
                } catch (e) {}
              }
              
              if (norm === 'daily') d.setDate(d.getDate() + 1 * val);
              else if (norm === 'weekly') d.setDate(d.getDate() + 7 * val);
              else if (norm === 'quarterly') d.setMonth(d.getMonth() + 3 * val);
              else if (norm === 'half-yearly' || norm === 'half-year') d.setMonth(d.getMonth() + 6 * val);
              else if (norm === 'yearly') d.setFullYear(d.getFullYear() + 1 * val);
              else d.setMonth(d.getMonth() + 1 * val); // default to monthly
              
              const y = d.getFullYear();
              const m = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              return `${y}-${m}-${day}`;
            };
            
            const nextDate = calculateNextDate(currentSchedDate, interval, period);
            const newTask = {
              Task_ID: `TASK${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`,
              Customer_ID: updated.Customer_ID || oldDoc.Customer_ID,
              Description: updated.Description || oldDoc.Description,
              Assigned_Staff: updated.Assigned_Staff || oldDoc.Assigned_Staff,
              Department: 'Sales',
              Stage: 'New Inquiry',
              Type: 'Recurring',
              Recurring_Interval: interval,
              Recurring_Period: period,
              Scheduled_Date: nextDate,
              Status: 'Pending'
            };
            
            const newDoc = new Model(newTask);
            await newDoc.save();
            console.log(`[Recurring Schedule] Auto-created task ${newTask.Task_ID} scheduled for ${nextDate} (Interval: ${interval})`);
          } catch (e) {
            console.error('Error auto-scheduling recurring task:', e);
          }
        }
      }

      return updated;
    }
    const allDocs = await this.getTab(sheetName);
    const existing = allDocs.find(d => String(d[idColumn]).trim().toLowerCase() === String(idValue).trim().toLowerCase());
    if (existing) {
      delete this.cache[sheetName];
      await Model.updateOne({ [idColumn]: existing[idColumn] }, { $set: updateData });
      return { ...existing, ...updateData };
    }
    return null;
  }

  async deleteRow(sheetName, idColumn, idValue) {
    delete this.cache[sheetName];
    await this.connect();
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    await Model.deleteOne({ [idColumn]: idValue });
    return true;
  }

  // Backwards compatible specific methods
  async getAllStaff() { return this.getTab('Staff_Master'); }
  async getStaffByEmail(email) {
    const staff = await this.getAllStaff();
    return staff.find(s => s.Email === email) || null;
  }
  async getStaffById(staffId) {
    if (!staffId) return null;
    const staff = await this.getAllStaff();
    const target = staffId.toString().trim().toUpperCase();
    return staff.find(s => s.Staff_ID && s.Staff_ID.toString().trim().toUpperCase() === target) || null;
  }
  async getAllCustomers() { return this.getTab('Customer_Master'); }
  async getAllTasks() { return this.getTab('Task_Master'); }
  async getTasksByStaff(staffId) {
    const tasks = await this.getAllTasks();
    return tasks.filter(t => t.Assigned_Staff === staffId);
  }
  async getTaskById(taskId) {
    const tasks = await this.getAllTasks();
    return tasks.find(t => t.Task_ID === taskId) || null;
  }
  async getAllLogs() { return this.getTab('Activity_Logs'); }
  async getAllAttendance() { return this.getTab('Attendance_Log'); }
  async getAttendanceByStaff(staffId) {
    const records = await this.getAllAttendance();
    return records.filter(r => r.Staff_ID === staffId);
  }
  async getAllLeaves() { return this.getTab('Leave_Requests'); }
  async getLeavesByStaff(staffId) {
    const leaves = await this.getAllLeaves();
    return leaves.filter(l => l.Staff_ID === staffId);
  }
  async getCustomerInteractions() { return this.getTab('Customer_Interactions'); }
  async getAdvances() { return this.getTab('Salary_Advances'); }
  async getAllCertificates() { return this.getTab('Document_Registry'); }
  async getCertificateByGuid(guid) {
    const certs = await this.getAllCertificates();
    return certs.find(c => c.verificationGuid === guid || c.Certificate_No === guid || String(c.verificationGuid || '').toLowerCase() === String(guid || '').toLowerCase()) || null;
  }
  async getEquipmentMaster() {
    const items = await this.getTab('Equipment_Master');
    if (items && items.length > 0) return items;
    return [
      { id: 'eq-1', type: 'Dry Chemical Powder (ABC Type IS:15683)', capacities: ['1 Kg', '2 Kg', '4 Kg', '4.5 Kg', '6 Kg', '9 Kg'] },
      { id: 'eq-2', type: 'CO2 Fire Extinguisher (IS:15683 / IS:2878)', capacities: ['2 Kg', '3 Kg', '4.5 Kg', '6.5 Kg', '9 Kg', '22.5 Kg'] },
      { id: 'eq-3', type: 'Clean Agent / HFC-236fa Extinguisher', capacities: ['1 Kg', '2 Kg', '4 Kg', '6 Kg'] },
      { id: 'eq-4', type: 'Foam Type Fire Extinguisher (Mechanical Foam)', capacities: ['9 Ltr', '50 Ltr (Trolley)', '150 Ltr'] },
      { id: 'eq-5', type: 'Water CO2 Type Fire Extinguisher', capacities: ['9 Ltr', '50 Ltr (Trolley)'] },
      { id: 'eq-6', type: 'Automatic Modular Extinguisher (Clean Agent / ABC)', capacities: ['2 Kg', '5 Kg', '10 Kg', '15 Kg'] },
      { id: 'eq-7', type: 'Wet Chemical Fire Extinguisher (Kitchen Safety)', capacities: ['2 Ltr', '4 Ltr', '6 Ltr', '9 Ltr'] },
      { id: 'eq-8', type: 'Fire Hydrant Hose Reel & Branch Pipe Unit', capacities: ['30 Meter (3/4")', '30 Meter (1")', 'Standard Branch Pipe'] },
      { id: 'eq-9', type: 'Sprinkler Head & Alarm Valve Unit', capacities: ['68°C Pendent Type', '68°C Upright Type', 'Sprinkler Alarm Valve'] },
      { id: 'eq-10', type: 'Conventional / Addressable Fire Alarm Panel', capacities: ['2 Zone Panel', '4 Zone Panel', '8 Zone Panel', 'Loop Addressable'] }
    ];
  }
  async getAllServiceReports() { return this.getTab('Service_Reports'); }
  async getAllTags() { return this.getTab('Tag_Master'); }

  async getDocumentSettings(companyId = 'DEFAULT') {
    await this.connect();
    const Model = models['Document_Settings'];
    const doc = await Model.findOne({ company_id: companyId }).lean();
    if (doc) { delete doc._id; delete doc.__v; }
    return doc || null;
  }

  async saveDocumentSettings(companyId = 'DEFAULT', settingsData) {
    await this.connect();
    const Model = models['Document_Settings'];
    const payload = { ...settingsData, company_id: companyId };
    const result = await Model.findOneAndUpdate(
      { company_id: companyId },
      { $set: payload },
      { new: true, upsert: true, returnDocument: 'after' }
    ).lean();
    if (result) { delete result._id; delete result.__v; }
    return result;
  }
}

module.exports = new MongoService();
