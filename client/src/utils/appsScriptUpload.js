const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyFxoL-mCgV7mVg_Hpj9inc52JKmdvZ4pZ_myIZPk1NnjQq4PiMjmevUDF9p7t5SrWg/exec';

/**
 * Sends a generated jsPDF document (as base64) to the Google Apps Script Web App.
 * `documentType` ('Certificate' | 'Service Report') tells the script which Drive folder
 * to file the PDF into. Content-Type is deliberately text/plain — Apps Script Web Apps
 * don't handle CORS preflight (OPTIONS) requests, and application/json would trigger one
 * from the browser. Upload failures are logged, not thrown — they must never block the
 * user's local download/print/share of the PDF they already generated.
 */
export async function uploadPdfToAppsScript({ pdf, fileName, documentType, ...metadata }) {
  try {
    const pdfBase64 = pdf.output('base64');
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
