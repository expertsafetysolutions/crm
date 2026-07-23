const xlsx = require('xlsx');
const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');

const workbook = xlsx.readFile('Address Book.xlsx');
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

// Read everything as json but skip the first row (the title "Address Book")
const data = xlsx.utils.sheet_to_json(sheet, { range: 1 });

const mappedData = data.map(row => {
  const company = row['Party Name'] || '';
  const authPerson = row['Contact Person'] || '';
  
  let contact = row['Mobile No'] || row['Phone No'] || '';
  if (contact && typeof contact === 'string' && !contact.startsWith('+')) {
    contact = '+91 ' + contact;
  } else if (contact) {
    contact = '+91 ' + contact;
  }
  
  const email = row['Email'] || '';
  
  let address = row['Address'] || '';
  if (row['State Name']) address += ', ' + row['State Name'];
  if (row['Pincode']) address += ' - ' + row['Pincode'];
  
  return {
    Customer_ID: '', // Leave blank for generation
    Company_Name: company,
    Auth_Person: authPerson,
    Contact: contact,
    Email: email,
    Location_Link: '',
    Address: address,
    Coordinators: ''
  };
});

// Filter out empty rows just in case
const validData = mappedData.filter(d => d.Company_Name && d.Company_Name.trim() !== '');

const csv = Papa.unparse(validData);

// Write to desktop
const desktopPath = path.join(require('os').homedir(), 'Desktop', 'ready_to_upload.csv');
fs.writeFileSync(desktopPath, csv, 'utf-8');

console.log(`Successfully mapped ${validData.length} records and saved to: ${desktopPath}`);
