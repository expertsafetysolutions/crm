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
  Salary_Advances: createModel('Salary_Advances')
};

class MongoService {
  constructor() {
    this.isConnected = false;
  }

  async connect(uri) {
    if (this.isConnected) return;
    try {
      await mongoose.connect(uri);
      this.isConnected = true;
      console.log('✅ Connected to MongoDB Atlas');
    } catch (err) {
      console.error('❌ MongoDB Connection Error:', err);
    }
  }

  async getTab(sheetName) {
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    const data = await Model.find({}).lean();
    // Remove _id and __v for backward compatibility with existing JSON code
    return data.map(doc => {
      delete doc._id;
      delete doc.__v;
      return doc;
    });
  }

  async insertRow(sheetName, data) {
    const Model = models[sheetName];
    if (!Model) throw new Error(`Collection ${sheetName} not found`);
    const doc = new Model(data);
    await doc.save();
    return true;
  }

  async updateRow(sheetName, idColumn, idValue, updateData) {
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
    const updated = await Model.findOneAndUpdate(query, { $set: updateData }, { new: true, returnDocument: 'after' }).lean();
    if (updated) {
      delete updated._id;
      delete updated.__v;
      return updated;
    }
    const allDocs = await this.getTab(sheetName);
    const existing = allDocs.find(d => String(d[idColumn]).trim().toLowerCase() === String(idValue).trim().toLowerCase());
    if (existing) {
      await Model.updateOne({ [idColumn]: existing[idColumn] }, { $set: updateData });
      return { ...existing, ...updateData };
    }
    return true;
  }

  async deleteRow(sheetName, idColumn, idValue) {
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
}

module.exports = new MongoService();
