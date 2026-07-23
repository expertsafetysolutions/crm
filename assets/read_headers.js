const xlsx = require('xlsx');

const workbook = xlsx.readFile('Address Book.xlsx');
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

console.log("Headers:");
console.log(data[0]);

// Also print the first data row to understand the data
console.log("Row 1:");
console.log(data[1]);
