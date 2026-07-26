require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authRouter } = require('./routes/authRoutes');
const apiRouter = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const path = require('path');
const sheetsService = require('./services/sheetsService');

// Serve static assets (Header, Footer, Stamp images) from the root assets directory
app.use('/assets', express.static(path.join(__dirname, '../../assets')));

// Serves uploaded media (product photos) stored in Mongo as base64. Deliberately unauthenticated,
// like /assets above: these URLs are consumed by plain <img> tags — including inside html2canvas
// PDF captures and the public quotation portal — which cannot send an Authorization header. The
// Media_ID is a random unguessable token, so the URL itself is the capability.
app.get('/api/media/:id', async (req, res) => {
  try {
    const media = await sheetsService.getMediaById(req.params.id);
    if (!media || !media.Data) return res.status(404).json({ error: 'Media not found' });

    const buffer = Buffer.from(media.Data, 'base64');
    res.set('Content-Type', media.Mime_Type || 'image/jpeg');
    // Immutable: a new upload always mints a new Media_ID, so a cached copy can never go stale.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (err) {
    console.error('GET /api/media error:', err);
    res.status(500).json({ error: 'Failed to load media' });
  }
});

// Public Certificate Verification API (No Auth Required for QR Code Verification)
app.get('/api/verify-certificate/:guid', async (req, res) => {
  try {
    const guid = req.params.guid;
    
    // 1. Get certificate
    let cert = await sheetsService.getCertificateByGuid(guid);
    let details = null;
    let items = [];

    // Soft-deleted certificates keep resolving here (their QR code may already be printed on a
    // physical document) but must not read as a normal valid verification — show a distinct
    // "revoked" state instead of either silently vouching for it or claiming it never existed.
    if (cert) {
      const rawCert = cert.toObject ? cert.toObject() : cert;
      if (rawCert.Is_Deleted) {
        return res.status(410).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Certificate Revoked - Expert Safety Solutions</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
            <style>
              body { font-family: 'Outfit', sans-serif; background: #fffbeb; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
              .card { background: white; padding: 40px 30px; border-radius: 24px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); max-width: 400px; width: 100%; border: 1.5px solid #fde68a; }
              .icon { font-size: 56px; margin-bottom: 20px; }
              h1 { color: #1e293b; font-size: 22px; margin: 0 0 10px; font-weight: 800; }
              p { color: #64748b; font-size: 13.5px; line-height: 1.6; margin: 0 0 24px; font-weight: 500; }
              .ref { color: #92400e; font-weight: 700; }
              .btn { display: inline-block; background: #9a3412; color: white; text-decoration: none; padding: 12px 24px; border-radius: 12px; font-weight: 700; font-size: 13px; text-transform: uppercase; transition: all 0.2s; }
              .btn:hover { background: #7c2d12; transform: translateY(-1px); }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">⚠️</div>
              <h1>Certificate Revoked</h1>
              <p>Certificate <span class="ref">${rawCert.Certificate_No || rawCert.certificateNo || guid}</span> has been withdrawn from our active registry by Expert Safety Solutions and is no longer valid. If you believe this is an error, or need a reissued copy, please contact us directly.</p>
              <a href="/" class="btn">Back to Portal</a>
            </div>
          </body>
          </html>
        `);
      }
    }

    if (cert) {
      const c = cert.toObject ? cert.toObject() : cert;
      details = {
        type: c.Format_Type || c.formatType || 'Certificate of Compliance',
        number: c.Certificate_No || c.certificateNo,
        client: c.Customer_Name || c.customerName,
        address: c.Address || c.address,
        date: c.Issue_Date || c.issueDate,
        validity: c.Valid_Until || c.validUntil,
        status: c.Status || 'VERIFIED & COMPLIANT',
        title: c.title || 'COMPLIANCE CERTIFICATE',
        equipmentDetails: c.equipmentDetails || '',
        customCertifyLines: c.customCertifyLines || [],
        customEquipmentNotes: c.customEquipmentNotes || [],
        customColumns: c.customColumns || []
      };
      items = c.itemsList || [];
    } else {
      // Try to find in service reports
      const reports = await sheetsService.getAllServiceReports() || [];
      const reportDoc = reports.find(r => String(r.verificationGuid || r.Verification_GUID) === String(guid));
      if (reportDoc) {
        const r = reportDoc.toObject ? reportDoc.toObject() : reportDoc;
        details = {
          type: 'Service Inspection Report',
          number: r.Report_ID || r.reportId,
          client: r.Customer_Name || r.customerName,
          address: r.Address || r.address,
          date: r.Service_Date || r.serviceDate || r.Scheduled_Date,
          validity: r.Valid_Until || r.validUntil || 'N/A',
          status: r.Status || 'Approved',
          title: 'OFFICIAL SERVICE INSPECTION REPORT',
          equipmentDetails: r.fieldObservations || '',
          customCertifyLines: [],
          customEquipmentNotes: []
        };
        items = r.itemsList || [];
      }
    }

    if (!details) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Verification Failed - Expert Safety Solutions</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Outfit', sans-serif; background: #f8fafc; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; text-align: center; }
            .card { background: white; padding: 40px 30px; border-radius: 24px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); max-width: 400px; width: 100%; border: 1.5px solid #fee2e2; }
            .icon { font-size: 56px; margin-bottom: 20px; }
            h1 { color: #1e293b; font-size: 22px; margin: 0 0 10px; font-weight: 800; }
            p { color: #64748b; font-size: 13.5px; line-height: 1.6; margin: 0 0 24px; font-weight: 500; }
            .btn { display: inline-block; background: #9a3412; color: white; text-decoration: none; padding: 12px 24px; border-radius: 12px; font-weight: 700; font-size: 13px; text-transform: uppercase; tracking-spacing: 0.5px; transition: all 0.2s; }
            .btn:hover { background: #7c2d12; transform: translateY(-1px); }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">❌</div>
            <h1>Verification Failed</h1>
            <p>The verification code is invalid or does not match any document in our registry records.</p>
            <a href="/" class="btn">Back to Portal</a>
          </div>
        </body>
        </html>
      `);
    }

    const formatDate = (dStr) => {
      if (!dStr) return 'N/A';
      try {
        const d = new Date(dStr);
        if (isNaN(d.getTime())) return dStr;
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch(e) { return dStr; }
    };

    const maskCustomerName = (name) => {
      if (!name) return '';
      const trimmed = name.trim();
      if (trimmed.length <= 6) return trimmed;
      return trimmed.substring(0, 3) + '...' + trimmed.substring(trimmed.length - 3);
    };

    const maskAddress = (addr) => {
      if (!addr) return '';
      const segments = addr.split(',').map(s => s.trim()).filter(Boolean);
      if (segments.length <= 1) return addr;
      const lastParts = segments.slice(-2);
      return lastParts.join(', ');
    };

    // A certificate stays valid through the end of its Valid_Until day — only expired starting
    // the day after. An expired certificate is NOT invalid/fraudulent, just due for renewal, so
    // it gets its own distinct page rather than falling through to "Verification Failed".
    const RENEWAL_PHONE_DISPLAY = '8460699569';
    const RENEWAL_PHONE_E164 = '918460699569';
    const validityDate = details.validity ? new Date(details.validity) : null;
    let isExpired = false;
    if (validityDate && !isNaN(validityDate.getTime())) {
      const endOfValidityDay = new Date(validityDate);
      endOfValidityDay.setHours(23, 59, 59, 999);
      isExpired = endOfValidityDay.getTime() < Date.now();
    }

    if (isExpired) {
      const whatsappText = encodeURIComponent(`Hi, my ${details.type} (No. ${details.number}) has expired on ${formatDate(details.validity)}. I would like to renew it.`);
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Certificate Expired - Expert Safety Solutions</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Outfit', sans-serif; background: linear-gradient(135deg, #fff7ed 0%, #fffbeb 100%); margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
            .card { background: white; border-radius: 28px; box-shadow: 0 25px 50px -12px rgba(154, 52, 18, 0.15); max-width: 480px; width: 100%; overflow: hidden; border: 1px solid #fed7aa; }
            .header { background: linear-gradient(135deg, #c2410c 0%, #ea580c 100%); padding: 28px 24px; text-align: center; color: white; }
            .logo { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; margin: 0 auto 12px; display: block; box-shadow: 0 4px 15px rgba(0,0,0,0.15); background: white; }
            .badge { background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.5); display: inline-block; padding: 5px 12px; border-radius: 50px; font-weight: 800; font-size: 10.5px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
            .header h1 { font-size: 19px; margin: 0; font-weight: 800; }
            .content { padding: 26px 24px; text-align: center; }
            .expired-icon { font-size: 44px; margin-bottom: 12px; }
            .doc-title { font-size: 14px; font-weight: 800; color: #9a3412; text-transform: uppercase; margin: 0 0 10px; }
            .msg { color: #78350f; font-size: 13.5px; line-height: 1.7; font-weight: 500; margin: 0 0 20px; }
            .msg b { color: #9a3412; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 22px; text-align: left; }
            .info-box { background: #fff7ed; border: 1px solid #fed7aa; padding: 10px 14px; border-radius: 12px; }
            .info-label { color: #9a3412; font-weight: 700; text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px; margin-bottom: 3px; opacity: 0.75; }
            .info-val { color: #431407; font-weight: 800; font-size: 12.5px; }
            .cta-label { font-size: 11px; font-weight: 800; color: #9a3412; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
            .btn-row { display: flex; gap: 10px; }
            .btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; padding: 13px 10px; border-radius: 14px; font-weight: 800; font-size: 13px; transition: all 0.2s; }
            .btn-call { background: #ea580c; color: white; }
            .btn-call:hover { background: #c2410c; transform: translateY(-1px); }
            .btn-whatsapp { background: #25D366; color: white; }
            .btn-whatsapp:hover { background: #1da851; transform: translateY(-1px); }
            .phone-note { margin-top: 14px; font-size: 11.5px; color: #9a3412; font-weight: 700; }
            .footer { background: #fff7ed; padding: 18px 24px; text-align: center; border-top: 1px solid #fed7aa; }
            .footer-logo { font-size: 10px; color: #b45309; font-weight: 700; text-transform: uppercase; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <img class="logo" src="/assets/header_logo.png" onerror="this.onerror=null;this.src='/assets/header.jpg';" alt="Expert Safety Solutions" />
              <span class="badge">⏳ Certificate Expired</span>
              <h1>EXPERT SAFETY SOLUTIONS</h1>
            </div>
            <div class="content">
              <div class="expired-icon">🔔</div>
              <h2 class="doc-title">${details.title}</h2>
              <p class="msg">Your certificate <b>expired on ${formatDate(details.validity)}</b>. This does <b>not</b> mean it is invalid or fraudulent — it simply means the validity period is over and it's time to renew. Please renew now to stay compliant and protected.</p>

              <div class="info-grid">
                <div class="info-box">
                  <div class="info-label">Document No</div>
                  <div class="info-val">${details.number}</div>
                </div>
                <div class="info-box">
                  <div class="info-label">Client Name</div>
                  <div class="info-val">${maskCustomerName(details.client)}</div>
                </div>
                <div class="info-box">
                  <div class="info-label">Document Type</div>
                  <div class="info-val">${details.type}</div>
                </div>
                <div class="info-box">
                  <div class="info-label">Expired On</div>
                  <div class="info-val" style="color: #b91c1c;">${formatDate(details.validity)}</div>
                </div>
              </div>

              <div class="cta-label">Renew Your Certificate Now</div>
              <div class="btn-row">
                <a class="btn btn-call" href="tel:+${RENEWAL_PHONE_E164}">📞 Call Now</a>
                <a class="btn btn-whatsapp" href="https://wa.me/${RENEWAL_PHONE_E164}?text=${whatsappText}" target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>
              </div>
              <div class="phone-note">Call / WhatsApp: ${RENEWAL_PHONE_DISPLAY}</div>
            </div>
            <div class="footer">
              <div class="footer-logo">Expert Safety Solutions Registry</div>
            </div>
          </div>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Document Verification - Expert Safety Solutions</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Outfit', sans-serif; background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .card { background: white; border-radius: 28px; box-shadow: 0 25px 50px -12px rgba(4, 120, 87, 0.15); max-width: 650px; width: 100%; overflow: hidden; border: 1px solid #d1fae5; }
          .header { background: linear-gradient(135deg, #047857 0%, #059669 100%); padding: 35px 24px; text-align: center; color: white; position: relative; }
          .badge-check { display: flex; align-items: center; justify-content: center; font-size: 32px; background: white; color: #047857; width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); font-weight: bold; }
          .badge { background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.5); display: inline-block; padding: 5px 12px; border-radius: 50px; font-weight: 800; font-size: 10.5px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
          .header h1 { font-size: 20px; margin: 0; font-weight: 800; }
          .content { padding: 30px 24px; }
          .title-area { text-align: center; margin-bottom: 25px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
          .doc-title { font-size: 15px; font-weight: 800; color: #9a3412; text-transform: uppercase; margin: 0 0 6px; }
          .doc-subtitle { font-size: 12px; color: #64748b; font-weight: 500; line-height: 1.5; margin: 0; }
          
          .info-grid { display: grid; grid-template-cols: 1fr; gap: 12px; margin-bottom: 25px; }
          @media (min-width: 480px) {
            .info-grid { grid-template-cols: 1fr 1fr; }
          }
          .info-box { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 16px; border-radius: 12px; }
          .info-label { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 9.5px; letter-spacing: 0.5px; margin-bottom: 4px; }
          .info-val { color: #0f172a; font-weight: 800; font-size: 13px; }
          
          .table-container { overflow-x: auto; margin-top: 20px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; }
          table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
          th { background: #f1f5f9; color: #334155; font-weight: 800; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-transform: uppercase; font-size: 9.5px; }
          td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; color: #0f172a; font-weight: 600; }
          tr:last-child td { border-bottom: none; }
          
          .custom-lines { margin-top: 20px; font-size: 12px; color: #334155; line-height: 1.6; font-weight: 500; }
          
          .footer { background: #f8fafc; padding: 25px 24px; text-align: center; border-top: 1px solid #e2e8f0; position: relative; }
          .stamp { border: 3px double #047857; color: #047857; font-weight: 900; font-size: 14px; display: inline-block; padding: 5px 15px; border-radius: 8px; transform: rotate(-2deg); margin-bottom: 10px; text-transform: uppercase; font-family: monospace; letter-spacing: 1px; }
          .footer-logo { font-size: 10px; color: #94a3b8; font-weight: 700; margin-top: 10px; text-transform: uppercase; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="badge-check">✓</div>
            <span class="badge">VERIFIED &amp; GENUINE</span>
            <h1>EXPERT SAFETY SOLUTIONS</h1>
          </div>
          <div class="content">
            <div class="title-area">
              <h2 class="doc-title">${details.title}</h2>
              <p class="doc-subtitle">${details.equipmentDetails}</p>
            </div>
            
            <div class="info-grid">
              <div class="info-box">
                <div class="info-label">Document No</div>
                <div class="info-val">${details.number}</div>
              </div>
              <div class="info-box">
                <div class="info-label">Client Name</div>
                <div class="info-val">${maskCustomerName(details.client)}</div>
              </div>
              <div class="info-box" style="grid-column: span 1;">
                <div class="info-label">Premises Address</div>
                <div class="info-val">${maskAddress(details.address)}</div>
              </div>
              <div class="info-box">
                <div class="info-label">Document Type</div>
                <div class="info-val" style="color: #047857;">${details.type}</div>
              </div>
              <div class="info-box">
                <div class="info-label">Issue Date</div>
                <div class="info-val">${formatDate(details.date)}</div>
              </div>
              <div class="info-box">
                <div class="info-label">Valid Until</div>
                <div class="info-val" style="color: #b91c1c;">${formatDate(details.validity)}</div>
              </div>
            </div>
            
            ${items.length > 0 ? `
              <h3 style="font-size: 11px; font-weight: 800; color: #334155; margin: 20px 0 8px; text-transform: uppercase; tracking-spacing: 0.5px;">📋 Equipment &amp; Service Schedule</h3>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th style="text-align: center; width: 30px;">Sr.</th>
                      <th>Item Name</th>
                      ${details.type !== 'Training Certificate' ? `
                        <th>Capacity</th>
                        <th style="text-align: center;">Qty</th>
                        <th>Next Due</th>
                      ` : ''}
                      ${(details.customColumns || []).map(c => `<th>${c.label}</th>`).join('')}
                    </tr>
                  </thead>
                  <tbody>
                    ${items.map((it, idx) => `
                      <tr>
                        <td style="text-align: center; color: #64748b;">${idx + 1}</td>
                        <td style="font-weight: 800; color: #1e293b;">${it.itemName || it.Item_Name || '—'}</td>
                        ${details.type !== 'Training Certificate' ? `
                          <td>${it.capacity || it.Capacity || '—'}</td>
                          <td style="text-align: center; font-weight: 800; color: #1e3a8a;">${it.qty || it.quantity || it.Qty || '1 Nos.'}</td>
                          <td style="font-weight: 700; color: #b91c1c;">${formatDate(it.nextDate || it.Next_Date || it.validUntil)}</td>
                        ` : ''}
                        ${(details.customColumns || []).map(c => `<td>${(it.customValues || it.Custom_Values)?.[c.id] || it[c.id] || '—'}</td>`).join('')}
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : ''}

            ${(details.customCertifyLines || []).filter(l => l && l.trim()).length > 0 ? `
              <div class="custom-lines">
                ${details.customCertifyLines.filter(l => l && l.trim()).map(line => `<p style="margin: 4px 0;">● ${line}</p>`).join('')}
              </div>
            ` : ''}

            ${(details.customEquipmentNotes || []).filter(l => l && l.trim()).length > 0 ? `
              <div class="custom-lines" style="border-top: 1px dashed #e2e8f0; margin-top: 15px; padding-top: 10px; font-style: italic; color: #64748b;">
                ${details.customEquipmentNotes.filter(l => l && l.trim()).map(line => `<p style="margin: 4px 0;">${line}</p>`).join('')}
              </div>
            ` : ''}
          </div>
          <div class="footer">
            <div class="stamp">EXPERT VERIFIED DOCUMENT</div>
            <div class="footer-logo">Expert Safety Solutions Registry</div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Verify certificate error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Public Customer Quotation Portal (Module C) — no auth by design: the link is opened cold from an
// email/WhatsApp message by a customer who has no login. The unguessable Portal_Guid in the URL is
// the credential, same model as the certificate verification link above.
app.get('/api/quote-portal/:guid', async (req, res) => {
  const quotePortalView = require('./services/quotePortalView');
  try {
    const quotation = await sheetsService.getQuotationByPortalGuid(req.params.guid);
    if (!quotation) {
      return res.status(404).send(quotePortalView.renderPortalErrorPage({
        code: 404,
        title: 'Quotation Not Found',
        message: 'This link is invalid or has been withdrawn. Please contact us for an up-to-date quotation.'
      }));
    }
    // Superseded revisions must not stay actionable, or a customer could accept stale pricing.
    if (quotation.Status === 'Revised') {
      return res.status(410).send(quotePortalView.renderPortalErrorPage({
        code: 410,
        title: 'A Newer Version Is Available',
        message: 'This quotation has been revised. Please refer to the latest version we sent you, or contact us for a fresh copy.'
      }));
    }

    const quotationEngine = require('./services/quotationEngine');
    const settings = await quotationEngine.getSettings();

    // Best-effort view tracking — a write failure must never block the customer from reading.
    sheetsService.updateRow('Quotation_Master', 'Quotation_ID', quotation.Quotation_ID, {
      Portal_Last_Viewed_At: new Date().toISOString(),
      Portal_View_Count: (Number(quotation.Portal_View_Count) || 0) + 1
    }).catch(e => console.error('Portal view tracking failed:', e.message));

    res.set('Cache-Control', 'no-store');
    res.send(quotePortalView.renderQuotePortalPage({
      quotation,
      settings,
      sellerName: settings.seller_profile?.legal_name || 'Expert Safety Solutions'
    }));
  } catch (err) {
    console.error('Quote portal render error:', err);
    res.status(500).send(quotePortalView.renderPortalErrorPage({
      code: 500,
      title: 'Something Went Wrong',
      message: 'We could not load this quotation right now. Please try again shortly.'
    }));
  }
});

app.post('/api/quote-portal/:guid/action', async (req, res) => {
  try {
    const quotePortalView = require('./services/quotePortalView');
    const quotationEngine = require('./services/quotationEngine');

    const quotation = await sheetsService.getQuotationByPortalGuid(req.params.guid);
    if (!quotation) return res.status(404).json({ error: 'This quotation link is no longer valid.' });
    if (!quotePortalView.isActionable(quotation.Status)) {
      return res.status(409).json({ error: 'This quotation is no longer open for changes. Please contact us directly.' });
    }

    const settings = await quotationEngine.getSettings();
    const requested = String(req.body.action || '');
    // Only actions the Admin has enabled in settings are honoured, regardless of what the client
    // posts — the rendered buttons are not the security boundary.
    const allowed = (settings.customer_actions || []).filter(a => a.enabled !== false).map(a => a.action_key);
    if (!allowed.includes(requested)) {
      return res.status(400).json({ error: 'That action is not available on this quotation.' });
    }

    const result = await quotationEngine.applyCustomerAction(quotation.Quotation_ID, requested, {
      note: req.body.note,
      requestedDate: req.body.requestedDate,
      autoCreateRevision: requested === 'REQUEST_REVISION'
    });

    const messages = {
      ACCEPT: 'Thank you! Your acceptance has been recorded and our team has been notified.',
      REQUEST_REVISION: 'Thank you — we have received your revision request and will send an updated quotation shortly.',
      CHANGE_REQUIREMENT: 'Thank you — your updated requirement has been shared with our team.',
      REQUEST_REMINDER_DATE: 'Noted. We will follow up with you on the date you selected.'
    };

    res.json({ success: true, status: result.quotation?.Status, message: messages[requested] || 'Your response has been recorded.' });
  } catch (err) {
    console.error('Quote portal action error:', err);
    res.status(500).json({ error: 'We could not record your response. Please try again.' });
  }
});

// Vercel Cron targets — must be registered before apiRouter (which requires a staff JWT on
// everything) since Vercel authenticates cron requests with `Authorization: Bearer $CRON_SECRET`,
// not a login token. See vercel.json's "crons" entries.
function isAuthorizedCron(req) {
  return !process.env.CRON_SECRET || req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

app.get('/api/cron/refilling-due-check', async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const workflowEngine = require('./services/workflowEngine');
    const result = await workflowEngine.generateRefillingDueTasks();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Refilling-due cron job error:', err);
    res.status(500).json({ error: 'Refilling-due check failed' });
  }
});

// Module D: fans out follow-up reminders for every quotation due today, and expires stale ones.
app.get('/api/cron/quotation-followup-check', async (req, res) => {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const quotationCronService = require('./services/quotationCronService');
    const quotationEngine = require('./services/quotationEngine');
    const expired = await quotationEngine.expireStaleQuotations();
    const reminders = await quotationCronService.runQuotationFollowUpReminders();
    res.json({ success: true, reminders, expired });
  } catch (err) {
    console.error('Quotation follow-up cron job error:', err);
    res.status(500).json({ error: 'Quotation follow-up check failed' });
  }
});

// Module G: payment-due reminders at each configured offset around the invoice due date.
app.get('/api/cron/payment-due-reminder-check', async (req, res) => {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const quotationCronService = require('./services/quotationCronService');
    const result = await quotationCronService.runPaymentDueReminders();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Payment-due cron job error:', err);
    res.status(500).json({ error: 'Payment-due check failed' });
  }
});

// Module F: generates annual renewal leads from quotations that never converted.
app.get('/api/cron/annual-prospect-check', async (req, res) => {
  if (!isAuthorizedCron(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const quotationCronService = require('./services/quotationCronService');
    const result = await quotationCronService.generateAnnualProspectTasks();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Annual-prospect cron job error:', err);
    res.status(500).json({ error: 'Annual-prospect check failed' });
  }
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

// Root endpoint check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'Expert Safety Solutions API & Google Sheets Wrapper',
    timestamp: new Date().toISOString()
  });
});

const attendanceService = require('./services/attendanceService');

// Initiate MongoDB Atlas connection immediately for serverless environments.
// Must not be left as an unhandled rejection — a connection failure here (e.g.
// Atlas IP whitelist) would otherwise crash the whole serverless process before
// Express can respond, turning a normal DB outage into a raw client-side
// "Failed to fetch" instead of a proper error response. Per-request calls in
// sheetsService.js each await connect() again and will retry cleanly.
sheetsService.connect(process.env.MONGO_URI).catch(err => {
  console.error('Initial MongoDB connection attempt failed (will retry on next request):', err.message);
});

if (require.main === module) {
  const uri = process.env.MONGO_URI;
  sheetsService.connect(uri).then(() => {
    app.listen(PORT, () => {
      console.log(`Expert Safety Solutions Server running on port ${PORT}`);

    // Periodic check every 5 minutes for automatic end-of-day attendance close (from 7:05 PM onwards)
    setInterval(async () => {
      try {
        const now = new Date();
        if ((now.getHours() >= 19 && now.getMinutes() >= 5) || (now.getHours() === 23 && now.getMinutes() >= 55)) {
          const res = await attendanceService.runAutoCloseJob();
          if (res.closedCount > 0) {
            console.log(`Auto-closed ${res.closedCount} open attendance records for the day.`);
          }
        }
      } catch (err) {
        console.error('Auto close job error:', err);
      }
    }, 60 * 1000 * 5); // Check every 5 mins
  });
}).catch(err => {
  console.error('Could not connect to MongoDB — server not started:', err.message);
});
}

module.exports = app;
