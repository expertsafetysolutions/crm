const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyFxoL-mCgV7mVg_Hpj9inc52JKmdvZ4pZ_myIZPk1NnjQq4PiMjmevUDF9p7t5SrWg/exec';

/**
 * Sends a generated jsPDF document (as base64) to the Google Apps Script Web App.
 * `documentType` ('Certificate' | 'Service Report') tells the script which Drive folder
 * to file the PDF into. Content-Type is deliberately text/plain — Apps Script Web Apps
 * don't handle CORS preflight (OPTIONS) requests, and application/json would trigger one
 * from the browser. Upload failures are logged, not thrown — they must never block the
 * user's local download/print/share of the PDF they already generated.
 */
/**
 * Uploads a product image to Drive via the same Apps Script Web App and returns its URL.
 *
 * Unlike the PDF helper, this one MUST surface the resulting URL — the caller stores it on the
 * item record, so a silent failure would leave an item with no photo and no error shown. Because
 * Apps Script's /exec redirects to googleusercontent.com and some browsers block reading that
 * response, an unreadable body is reported as an error rather than assumed successful.
 *
 * `redirect: 'follow'` is explicit so the 302 is chased; the script must return
 * { success, fileUrl, fileId } as JSON.
 */
export async function uploadImageToAppsScript({ base64, fileName, mimeType = 'image/jpeg', documentType = 'Product Photo', ...metadata }) {
  try {
    // Strip any data-URI prefix — the script expects raw base64.
    const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!clean) return { success: false, error: 'No image data supplied' };

    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        fileName,
        mimeType,
        documentType,
        // Sent under both keys so an older script revision expecting pdfBase64 still works.
        imageBase64: clean,
        pdfBase64: clean,
        ...metadata
      })
    });

    let result = null;
    try {
      result = await res.json();
    } catch (parseErr) {
      return {
        success: false,
        error: 'Upload was sent but Drive did not return a file URL. Check the Apps Script deployment is set to "Anyone" access.'
      };
    }

    if (!result?.success || !result?.fileUrl) {
      return { success: false, error: result?.error || 'Apps Script did not return a file URL' };
    }

    return {
      success: true,
      fileUrl: normalizeDriveImageUrl(result.fileUrl, result.fileId),
      fileId: result.fileId || '',
      rawUrl: result.fileUrl
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Converts a Drive share link into a direct-image URL.
 *
 * A normal Drive "view" link returns an HTML page, not image bytes, so it can't be used in an
 * <img> tag or captured by html2canvas. The thumbnail endpoint serves actual image data and works
 * for anyone with link access.
 */
export function normalizeDriveImageUrl(url, fileId) {
  const id = fileId || String(url || '').match(/[-\w]{25,}/)?.[0];
  if (!id) return url || '';
  return `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
}

export async function uploadPdfToAppsScript({ pdf, fileName, documentType, ...metadata }) {
  try {
    // 'datauristring' — NOT 'base64'. jsPDF's output() has no "base64" case; an unrecognised type
    // falls through its switch and returns null, so this used to POST a null body to Drive.
    const pdfBase64 = String(pdf.output('datauristring') || '').split('base64,').pop() || '';
    if (!pdfBase64) {
      console.warn(`[appsScriptUpload] "${fileName}" produced no PDF data; skipping upload.`);
      return;
    }
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        fileName,
        mimeType: 'application/pdf',
        documentType,
        pdfBase64,
        ...metadata
      })
    });

    // Reading the body is best-effort: Apps Script's /exec URL 302s to googleusercontent.com,
    // and some browsers restrict reading that redirected response even when the POST itself
    // ran fine server-side. Log whatever we can get for visibility without letting a parse
    // failure here look like the upload itself failed.
    try {
      const result = await res.json();
      if (result.success) {
        console.log(`[appsScriptUpload] Saved "${fileName}" to Drive folder "${result.folder}": ${result.fileUrl}`);
      } else {
        console.warn(`[appsScriptUpload] Apps Script rejected "${fileName}":`, result.error);
      }
    } catch (parseErr) {
      console.warn('[appsScriptUpload] Upload request sent, but could not read the response body:', parseErr.message);
    }
  } catch (err) {
    console.error('[appsScriptUpload] PDF upload failed (non-fatal):', err);
  }
}
