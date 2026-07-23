const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const uri = 'mongodb+srv://vortexxx421_db_user:xGPUPuzdzXilB3Ix@expertcrm.wpxo9jh.mongodb.net/?appName=ExpertCRM';
const dataFile = path.join(__dirname, 'data', 'mock_sheets.json');

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
  Advances_Log: createModel('Advances_Log')
};

async function migrate() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('Connected!');

    const rawData = fs.readFileSync(dataFile, 'utf8');
    const data = JSON.parse(rawData);

    for (const [collectionName, documents] of Object.entries(data)) {
      if (models[collectionName]) {
        console.log(`Migrating ${documents.length} records to ${collectionName}...`);
        const Model = models[collectionName];
        await Model.deleteMany({}); // clear existing
        if (documents.length > 0) {
          await Model.insertMany(documents);
        }
      } else {
        console.warn(`Warning: Collection ${collectionName} not found in models list.`);
      }
    }
    
    console.log('✅ Migration Complete!');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
