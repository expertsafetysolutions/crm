/**
 * Server-rendered HTML for the public customer quotation portal (Module C).
 *
 * Deliberately server-rendered and fully self-contained, matching the existing
 * /api/verify-certificate/:guid page: the link is opened cold from an email or WhatsApp message by
 * someone who is not logged in and has never loaded the SPA, so there is no app shell, no auth
 * state and no bundle to rely on.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(amount) {
  const n = Number(amount) || 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const BASE_STYLES = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.55;padding:16px}
  .wrap{max-width:720px;margin:0 auto}
  .card{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(15,23,42,.1),0 8px 24px rgba(15,23,42,.06);overflow:hidden}
  .head{background:linear-gradient(135deg,#b91c1c,#7f1d1d);color:#fff;padding:22px 24px}
  .head h1{font-size:19px;font-weight:700;letter-spacing:.01em}
  .head p{font-size:13px;opacity:.85;margin-top:4px}
  .body{padding:22px 24px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:14px;border-bottom:1px solid #f1f5f9}
  .row:last-child{border-bottom:0}
  .row .k{color:#64748b}
  .row .v{font-weight:600;text-align:right}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin:22px 0 10px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;background:#f8fafc;color:#475569;font-weight:600;padding:9px 10px;border-bottom:2px solid #e2e8f0;white-space:nowrap}
  td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  td.num,th.num{text-align:right;white-space:nowrap}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
  .totals{margin-top:14px;background:#f8fafc;border-radius:10px;padding:14px 16px}
  .grand{display:flex;justify-content:space-between;font-size:17px;font-weight:800;color:#b91c1c;padding-top:10px;margin-top:8px;border-top:2px solid #e2e8f0}
  .badge{display:inline-block;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.02em}
  .b-open{background:#dbeafe;color:#1d4ed8}
  .b-done{background:#dcfce7;color:#15803d}
  .b-warn{background:#fef3c7;color:#a16107}
  .b-dead{background:#fee2e2;color:#b91c1c}
  .actions{margin-top:24px;display:grid;gap:10px}
  button{font:inherit;font-weight:700;padding:14px 18px;border-radius:10px;border:0;cursor:pointer;width:100%;transition:filter .15s}
  button:hover:not(:disabled){filter:brightness(.94)}
  button:disabled{opacity:.55;cursor:not-allowed}
  .primary{background:#15803d;color:#fff}
  .secondary{background:#fff;color:#0f172a;border:1.5px solid #cbd5e1}
  .note{margin-top:18px;font-size:12px;color:#94a3b8;text-align:center}
  .msg{padding:14px 16px;border-radius:10px;font-size:14px;margin-bottom:18px;display:none}
  .msg.ok{display:block;background:#dcfce7;color:#166534;border:1px solid #86efac}
  .msg.err{display:block;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
  .modal{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(15,23,42,.6);display:none;align-items:center;justify-content:center;padding:16px;z-index:50}
  .modal.show{display:flex}
  .modal-inner{background:#fff;border-radius:14px;padding:22px;max-width:440px;width:100%}
  .modal-inner h3{font-size:16px;margin-bottom:6px}
  .modal-inner p{font-size:13px;color:#64748b;margin-bottom:14px}
  textarea,input[type=date]{width:100%;font:inherit;padding:11px 12px;border:1.5px solid #cbd5e1;border-radius:9px;margin-bottom:14px}
  textarea{min-height:96px;resize:vertical}
  .modal-btns{display:flex;gap:10px}
  .modal-btns button{flex:1}
  @media(max-width:480px){body{padding:10px}.body,.head{padding:18px 16px}}
`;

function statusBadge(status) {
  const map = {
    Sent: ['b-open', 'Awaiting Your Response'],
    RevisionRequested: ['b-warn', 'Revision Requested'],
    RequirementChangeRequested: ['b-warn', 'Requirement Change Requested'],
    Accepted: ['b-done', 'Accepted'],
    Converted: ['b-done', 'Order Confirmed'],
    Rejected: ['b-dead', 'Closed'],
    Expired: ['b-dead', 'Expired'],
    Revised: ['b-warn', 'Superseded by a newer revision']
  };
  const [cls, label] = map[status] || ['b-open', status || 'Open'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/** A quotation only accepts customer actions while it is genuinely open. */
function isActionable(status) {
  return ['Sent', 'RevisionRequested', 'RequirementChangeRequested'].includes(status);
}

function renderLineItems(lineItems, gstType) {
  const rows = (lineItems || []).map((l, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td>${esc(l.Item_Name)}${l.HSN_Code ? `<br><span style="color:#94a3b8;font-size:11px">HSN ${esc(l.HSN_Code)}</span>` : ''}</td>
      <td class="num">${Number(l.Qty) || 0} ${esc(l.Unit || '')}</td>
      <td class="num">${money(l.Rate)}</td>
      ${Number(l.Discount_Amt) > 0 ? `<td class="num">-${money(l.Discount_Amt)}</td>` : '<td class="num">—</td>'}
      <td class="num">${money(l.Taxable_Value)}</td>
      <td class="num">${Number(l.GST_Rate) || 0}%</td>
      <td class="num">${money(l.Line_Total)}</td>
    </tr>`).join('');

  return `<div class="scroll"><table>
    <thead><tr>
      <th class="num">#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th>
      <th class="num">Disc.</th><th class="num">Taxable</th><th class="num">${gstType === 'IGST' ? 'IGST' : 'GST'}</th><th class="num">Total</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8">No items listed</td></tr>'}</tbody>
  </table></div>`;
}

function renderTotals(q) {
  const isIgst = q.GST_Type === 'IGST';
  const line = (k, v) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  return `<div class="totals">
    ${line('Taxable Value', money(q.Subtotal))}
    ${Number(q.Document_Level_Discount_Amt) > 0 ? line('Additional Discount', `-${money(q.Document_Level_Discount_Amt)}`) : ''}
    ${isIgst
      ? line('IGST', money(q.Total_IGST))
      : line('CGST', money(q.Total_CGST)) + line('SGST', money(q.Total_SGST))}
    <div class="grand"><span>Grand Total</span><span>${money(q.Grand_Total)}</span></div>
  </div>`;
}

function renderActions(actions, actionable) {
  if (!actionable) {
    return `<p class="note">This quotation is no longer open for action. Please contact us if you need anything further.</p>`;
  }
  const styleFor = key => (key === 'ACCEPT' ? 'primary' : 'secondary');
  const buttons = (actions || [])
    .filter(a => a.enabled !== false)
    .slice(0, 4)
    .map(a => `<button class="${styleFor(a.action_key)}" type="button" data-action="${esc(a.action_key)}">${esc(a.label)}</button>`)
    .join('');
  return `<div class="actions">${buttons}</div>`;
}

function renderQuotePortalPage({ quotation, settings, sellerName }) {
  const actionable = isActionable(quotation.Status);
  const paymentTerm = (settings.payment_terms || []).find(t => t.id === quotation.Payment_Terms_ID);
  const selectedTnc = (settings.tnc_checklist || [])
    .filter(t => (quotation.Selected_TNC_IDs || []).includes(t.id));

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Quotation ${esc(quotation.Quote_No_Display)}</title>
<style>${BASE_STYLES}</style>
</head><body>
<div class="wrap"><div class="card">
  <div class="head">
    <h1>${esc(sellerName)}</h1>
    <p>Quotation ${esc(quotation.Quote_No_Display)} &nbsp;·&nbsp; ${esc(quotation.Created_At)}</p>
  </div>
  <div class="body">
    <div id="msg" class="msg"></div>

    <div class="row"><span class="k">Status</span><span class="v">${statusBadge(quotation.Status)}</span></div>
    <div class="row"><span class="k">Prepared For</span><span class="v">${esc(quotation.Customer_Name_Snapshot)}</span></div>
    ${quotation.Subject ? `<div class="row"><span class="k">Subject</span><span class="v">${esc(quotation.Subject)}</span></div>` : ''}
    ${quotation.Expiry_Date ? `<div class="row"><span class="k">Valid Until</span><span class="v">${esc(quotation.Expiry_Date)}</span></div>` : ''}
    ${paymentTerm ? `<div class="row"><span class="k">Payment Terms</span><span class="v">${esc(paymentTerm.label)}</span></div>` : ''}

    <h2>Items</h2>
    ${renderLineItems(quotation.Line_Items, quotation.GST_Type)}
    ${renderTotals(quotation)}

    ${selectedTnc.length ? `<h2>Terms &amp; Conditions</h2><ul style="font-size:12.5px;color:#475569;padding-left:20px">${
      selectedTnc.map(t => `<li style="margin-bottom:5px">${esc(t.text)}</li>`).join('')
    }</ul>` : ''}

    ${renderActions(settings.customer_actions, actionable)}
    <p class="note">Questions? Reply to the email or WhatsApp message that brought you here.</p>
  </div>
</div></div>

<div class="modal" id="modal"><div class="modal-inner">
  <h3 id="m-title"></h3>
  <p id="m-desc"></p>
  <textarea id="m-note" placeholder="Tell us what you'd like changed…"></textarea>
  <input type="date" id="m-date">
  <div class="modal-btns">
    <button class="secondary" type="button" id="m-cancel">Cancel</button>
    <button class="primary" type="button" id="m-confirm">Confirm</button>
  </div>
</div></div>

<script>
(function(){
  var guid = ${JSON.stringify(quotation.Portal_Guid || quotation.Portal_Code || '')} || window.location.pathname.split('/').pop();
  var modal = document.getElementById('modal');
  var noteEl = document.getElementById('m-note');
  var dateEl = document.getElementById('m-date');
  var msgEl = document.getElementById('msg');
  var pending = null;

  var CONFIG = {
    ACCEPT: { title: 'Accept this quotation?', desc: 'We will be notified immediately and will begin processing your order.', note: false, date: false },
    REQUEST_REVISION: { title: 'Request a revision', desc: 'Tell us what should change and we will send you a revised quotation.', note: true, date: false },
    CHANGE_REQUIREMENT: { title: 'Change requirement', desc: 'Describe your updated requirement and our team will get in touch.', note: true, date: false },
    REQUEST_REMINDER_DATE: { title: 'Request a later reminder', desc: 'Pick the date you would like us to follow up on.', note: false, date: true }
  };

  function show(kind, text){
    msgEl.className = 'msg ' + kind;
    msgEl.textContent = text;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function close(){ modal.classList.remove('show'); pending = null; }

  document.querySelectorAll('button[data-action]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var key = btn.getAttribute('data-action');
      var cfg = CONFIG[key];
      if (!cfg) return;
      pending = key;
      document.getElementById('m-title').textContent = cfg.title;
      document.getElementById('m-desc').textContent = cfg.desc;
      noteEl.style.display = cfg.note ? 'block' : 'none';
      dateEl.style.display = cfg.date ? 'block' : 'none';
      noteEl.value = '';
      dateEl.value = '';
      if (cfg.date) {
        // Never allow a reminder date in the past.
        var t = new Date(); t.setDate(t.getDate() + 1);
        dateEl.min = t.toISOString().slice(0, 10);
      }
      modal.classList.add('show');
    });
  });

  document.getElementById('m-cancel').addEventListener('click', close);
  modal.addEventListener('click', function(e){ if (e.target === modal) close(); });

  document.getElementById('m-confirm').addEventListener('click', function(){
    if (!pending) return;
    var cfg = CONFIG[pending];
    if (cfg.note && !noteEl.value.trim()) { alert('Please add a short note so we know what to change.'); return; }
    if (cfg.date && !dateEl.value) { alert('Please choose a date.'); return; }

    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    var actionUrl = window.location.pathname.replace(/\/$/, '') + '/action';
    fetch(actionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: pending, note: noteEl.value.trim(), requestedDate: dateEl.value })
    })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
    .then(function(res){
      if (!res.ok) throw new Error(res.body && res.body.error ? res.body.error : 'Something went wrong');
      close();
      show('ok', res.body.message || 'Thank you — your response has been recorded.');
      document.querySelectorAll('button[data-action]').forEach(function(b){ b.disabled = true; });
      setTimeout(function(){ location.reload(); }, 2500);
    })
    .catch(function(err){
      close();
      show('err', err.message || 'Could not submit your response. Please try again.');
    })
    .finally(function(){
      btn.disabled = false;
      btn.textContent = 'Confirm';
    });
  });
})();
</script>
</body></html>`;
}

function renderPortalErrorPage({ title, message, code }) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${BASE_STYLES}
  .center{text-align:center;padding:44px 24px}
  .icon{font-size:44px;margin-bottom:14px}
  .center h1{font-size:20px;margin-bottom:10px}
  .center p{color:#64748b;font-size:14px}
</style>
</head><body>
<div class="wrap"><div class="card"><div class="center">
  <div class="icon">${code === 410 ? '⏳' : '🔍'}</div>
  <h1>${esc(title)}</h1>
  <p>${esc(message)}</p>
</div></div></div>
</body></html>`;
}

module.exports = { renderQuotePortalPage, renderPortalErrorPage, isActionable };
