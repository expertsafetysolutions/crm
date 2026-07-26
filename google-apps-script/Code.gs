/**
 * Expert Safety Solutions — document intake Web App.
 *
 * Receives a base64-encoded file posted from the CRM — a PDF (Certificate or Service Report)
 * or a product image (Product Photo) — and saves it into the matching Google Drive folder,
 * creating the folders on first run. Product photos are additionally shared link-readable so
 * the CRM can render them through Drive's thumbnail endpoint.
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
 * 5. Folders "Certificate", "Service Report" and "Product Photos" live under
 *    "Expert Certificate & Service Report" in the sales.expertsafety@gmail.com Drive. They are
 *    looked up by name anywhere in that Drive (created at the root only if no match exists), so
 *    they can be moved freely — but renaming one breaks the match and the script will silently
 *    create a new empty folder at the root instead. Keep the names exactly as spelled above.
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
var PRODUCT_PHOTO_FOLDER_NAME = 'Product Photos';

/** documentType (as sent by the CRM) → Drive folder name. */
var FOLDER_BY_DOCUMENT_TYPE = {
  'Certificate': CERTIFICATE_FOLDER_NAME,
  'Service Report': SERVICE_REPORT_FOLDER_NAME,
  'Product Photo': PRODUCT_PHOTO_FOLDER_NAME
};

function doPost(e) {
  try {
    console.log('doPost invoked. Has postData: %s', !!(e && e.postData && e.postData.contents));

    if (!e || !e.postData || !e.postData.contents) {
      console.log('No POST body received.');
      return jsonResponse({ success: false, error: 'No POST body received' });
    }

    console.log('Raw body length: %s chars', e.postData.contents.length);

    var data = JSON.parse(e.postData.contents);
    // Images post imageBase64, PDFs post pdfBase64 — the image helper sends both for
    // compatibility with older script revisions, so either key is accepted here.
    var fileBase64 = data.pdfBase64 || data.imageBase64;
    var mimeType = data.mimeType || 'application/pdf';
    var fileName = data.fileName || ('Document-' + new Date().getTime());
    var documentType = data.documentType || '';

    console.log('Parsed fields — fileName: %s, documentType: %s, mimeType: %s, base64 length: %s',
      fileName, documentType, mimeType, fileBase64 ? fileBase64.length : 0);

    if (!fileBase64) {
      console.log('Missing file data — aborting.');
      return jsonResponse({ success: false, error: 'Missing pdfBase64/imageBase64 field' });
    }

    var folderName = FOLDER_BY_DOCUMENT_TYPE[documentType] || null;

    if (!folderName) {
      console.log('Unrecognized documentType: "%s" — aborting.', documentType);
      return jsonResponse({ success: false, error: 'Unknown or missing documentType: ' + documentType });
    }

    console.log('Resolving folder: %s', folderName);
    var folder = getOrCreateFolder(folderName);
    console.log('Folder resolved. ID: %s, URL: %s', folder.getId(), folder.getUrl());

    var bytes = Utilities.base64Decode(fileBase64);
    console.log('Decoded bytes: %s', bytes.length);

    var blob = Utilities.newBlob(bytes, mimeType, fileName);
    var file = folder.createFile(blob);
    console.log('File created. ID: %s, URL: %s', file.getId(), file.getUrl());

    // Product photos are rendered in <img> tags via the Drive thumbnail endpoint, which only
    // serves bytes for files readable without a Google session — so grant link access.
    if (documentType === 'Product Photo') {
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        console.log('Sharing set to anyone-with-link for %s', file.getId());
      } catch (shareErr) {
        console.warn('Could not set sharing on %s: %s', file.getId(), shareErr.message);
      }
    }

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

/**
 * Finds a folder by name anywhere in the executing account's Drive (getFoldersByName is not
 * scoped to the root), creating it at the root only if no folder with that name exists.
 */
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
