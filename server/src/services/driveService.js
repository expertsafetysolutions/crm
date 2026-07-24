const { google } = require('googleapis');
const stream = require('stream');

// Initialize auth client
const getDriveAuth = () => {
  const credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Replace \n with actual newlines if passed in via env string
    private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  };

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('Google Drive credentials (GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY) are missing in environment variables.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  return auth;
};

const uploadPdfToDrive = async (base64Data, filename) => {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is missing in environment variables.');
  }

  const auth = getDriveAuth();
  const drive = google.drive({ version: 'v3', auth });

  // If base64Data comes with Data URI prefix, split it out
  const base64String = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
  const buffer = Buffer.from(base64String, 'base64');
  
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  const fileMetadata = {
    name: filename || 'Certificate.pdf',
    parents: [folderId]
  };

  const media = {
    mimeType: 'application/pdf',
    body: bufferStream
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, webViewLink, webContentLink'
  });

  return file.data;
};

module.exports = {
  uploadPdfToDrive
};
