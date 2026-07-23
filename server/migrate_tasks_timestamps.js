const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sheetsService = require('./src/services/sheetsService');
const mongoose = require('mongoose');

async function migrate() {
  try {
    console.log('Connecting to database...');
    // Connect sheetsService (it connects automatically on first method call, but we can do it explicitly)
    await sheetsService.connect();
    
    console.log('Fetching tasks...');
    const allTasks = await sheetsService.getAllTasks();
    console.log(`Found ${allTasks.length} tasks in database.`);
    
    let migrateCount = 0;
    
    // Model reference
    const Model = mongoose.models['Task_Master'];
    
    for (const task of allTasks) {
      const updates = {};
      
      if (!task.Created_At) {
        // Fallback to Scheduled_Date or current date
        let dateStr = task.Scheduled_Date;
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
        }
        updates.Created_At = dateStr;
      }
      
      if (!task.Created_By) {
        updates.Created_By = task.Assigned_Staff || 'SYSTEM';
      }
      
      if (Object.keys(updates).length > 0) {
        await Model.updateOne({ Task_ID: task.Task_ID }, { $set: updates });
        migrateCount++;
      }
    }
    
    console.log(`Migration complete! Updated ${migrateCount} tasks.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
