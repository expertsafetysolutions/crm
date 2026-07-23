const mongoose = require('mongoose');
const sheetsService = require('./src/services/sheetsService');

async function run() {
  try {
    await sheetsService.connect();
    const tasks = await sheetsService.getAllTasks();
    console.log('Total tasks in DB:', tasks.length);
    
    const matching = tasks.filter(t => t.Description && t.Description.includes('Cheque'));
    console.log('Matching tasks:', JSON.stringify(matching, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

run();
