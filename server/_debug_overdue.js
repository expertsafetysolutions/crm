require('dotenv').config();
const sheetsService = require('./src/services/sheetsService');

(async () => {
  const tasks = await sheetsService.getAllTasks();
  const interactions = await sheetsService.getTab('Customer_Interactions');
  console.log('Total tasks:', tasks.length);
  console.log('Total interactions:', interactions.length);

  const sample = tasks.slice(0, 5);
  sample.forEach(t => {
    console.log('---');
    console.log('Task_ID:', t.Task_ID, '| Status:', t.Status, '| Scheduled_Date:', t.Scheduled_Date, typeof t.Scheduled_Date);
  });

  const msPerDay = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let overdueCount = 0;
  tasks.forEach(t => {
    if (!t.Scheduled_Date) return;
    if (t.Status === 'Completed' || t.Status === 'Closed') return;
    const d = new Date(t.Scheduled_Date);
    if (isNaN(d)) return;
    const daysSince = (now - d.getTime()) / msPerDay;
    if (daysSince < 2) return;
    const hasInteraction = interactions.some(i => {
      const matches = (t.Task_ID && i.Task_ID === t.Task_ID) || (!i.Task_ID && t.Customer_ID && i.Customer_ID === t.Customer_ID);
      if (!matches) return false;
      const ts = new Date(i.Timestamp || i.Created_At);
      return !isNaN(ts) && ts >= d;
    });
    if (!hasInteraction) {
      overdueCount++;
      console.log('OVERDUE CANDIDATE:', t.Task_ID, t.Customer_Name, 'Scheduled:', t.Scheduled_Date, 'daysSince:', daysSince.toFixed(1));
    }
  });
  console.log('Total overdue candidates:', overdueCount);
  process.exit(0);
})();
