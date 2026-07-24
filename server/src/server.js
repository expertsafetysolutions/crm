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

// Public Certificate Verification API (No Auth Required for QR Code Verification)
app.get('/api/verify-certificate/:guid', async (req, res) => {
  try {
    const guid = req.params.guid;
    
    // 1. Get certificate
    let cert = await sheetsService.getCertificateByGuid(guid);
    let details = null;
    let items = [];
    
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
