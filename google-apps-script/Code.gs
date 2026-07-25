/**
 * Expert Safety Solutions — PDF intake Web App.
 *
 * Receives a base64-encoded PDF (Certificate or Service Report) posted from the CRM and
 * saves it into the matching Google Drive folder, creating the folders on first run.
 *
 * SETUP
 * 1. Open script.google.com, open the project behind your existing Web App exec URL
 *    (the one already in client/src/utils/appsScriptUpload.js).
 * 2. Replace Code.gs's contents with this file.
 * 3. Deploy → Manage deployments → edit the existing deployment → New version → Deploy.
 *    (Re-using the same deployment keeps the exec URL unchanged, so the CRM needs no update.)
 * 4. IMPORTANT — check the deployment's config (pencil icon on the deployment):
 *      "Execute as"    → Me (<your account>)   [NOT "User accessing the web app" — the
 *                                                CRM's request is an anonymous fetch() with
 *                                                no Google session, so DriveApp would have
 *                                                no permissions under that setting]
 *      "Who has access" → Anyone
 * 5. First real POST from the app will create "Certificate" and "Service Report" folders
 *    in the Apps Script account's My Drive root — move them wherever you like afterwards,
 *    the script finds them by name on every run regardless of location.
 *
 * DEBUGGING
 * Every run writes to the Executions log (left sidebar, clock icon). Click any doPost row
 * to expand it and read the console.log lines below — they show exactly which step ran and,
 * on failure, the real error message (a "Completed" status only means the function didn't
 * crash; caught errors still return success:false in the JSON body, invisible unless you
 * either read these logs or the browser console on the CRM side).
 */

var CERTIFICATE_FOLDER_NAME = 'Certificate';
var SERVICE_REPORT_FOLDER_NAME = 'Service Report';

function doPost(e) {
  try {
    console.log('doPost invoked. Has postData: %s', !!(e && e.postData && e.postData.contents));

    if (!e || !e.postData || !e.postData.contents) {
      console.log('No POST body received.');
      return jsonResponse({ success: false, error: 'No POST body received' });
    }

    console.log('Raw body length: %s chars', e.postData.contents.length);

    var data = JSON.parse(e.postData.contents);
    var pdfBase64 = data.pdfBase64;
    var fileName = data.fileName || ('Document-' + new Date().getTime() + '.pdf');
    var documentType = data.documentType || '';

    console.log('Parsed fields — fileName: %s, documentType: %s, pdfBase64 length: %s',
      fileName, documentType, pdfBase64 ? pdfBase64.length : 0);

    if (!pdfBase64) {
      console.log('Missing pdfBase64 field — aborting.');
      return jsonResponse({ success: false, error: 'Missing pdfBase64 field' });
    }

    var folderName = (documentType === 'Certificate')
      ? CERTIFICATE_FOLDER_NAME
      : (documentType === 'Service Report' ? SERVICE_REPORT_FOLDER_NAME : null);

    if (!folderName) {
      console.log('Unrecognized documentType: "%s" — aborting.', documentType);
      return jsonResponse({ success: false, error: 'Unknown or missing documentType: ' + documentType });
    }

    console.log('Resolving folder: %s', folderName);
    var folder = getOrCreateFolder(folderName);
    console.log('Folder resolved. ID: %s, URL: %s', folder.getId(), folder.getUrl());

    var bytes = Utilities.base64Decode(pdfBase64);
    console.log('Decoded PDF bytes: %s', bytes.length);

    var blob = Utilities.newBlob(bytes, data.mimeType || 'application/pdf', fileName);
    var file = folder.createFile(blob);
    console.log('File created. ID: %s, URL: %s', file.getId(), file.getUrl());

    return jsonResponse({
      success: true,
      fileId: file.getId(),
      fileUrl: file.getUrl(),
      folder: folderName
    });
  } catch (err) {
    console.error('doPost failed: %s', err && err.stack ? err.stack : err);
    return jsonResponse({ success: false, error: err.message });
  }
}

/** Finds a top-level "My Drive" folder by name, creating it if this is the first upload of that type. */
function getOrCreateFolder(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) {
    var existing = folders.next();
    console.log('Found existing folder "%s".', name);
    return existing;
  }
  console.log('No existing folder "%s" — creating one.', name);
  return DriveApp.createFolder(name);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this manually from the Apps Script editor (select it in the function dropdown, click Run)
 * to sanity-check Drive permissions independent of the web app / CRM entirely. If this fails,
 * the problem is Drive access for the executing account, not the CRM's request.
 */
function testDriveAccess() {
  var folder = getOrCreateFolder(CERTIFICATE_FOLDER_NAME);
  var file = folder.createFile(Utilities.newBlob('test', 'text/plain', 'permission-test.txt'));
  console.log('Test file created: %s', file.getUrl());
}
