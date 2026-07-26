/**
 * whatsappService — WhatsApp Business Cloud API (Meta) sender.
 *
 * IMPORTANT CONSTRAINT: Meta only permits *business-initiated* messages via pre-approved message
 * templates. Quotation dispatch, follow-up reminders and payment reminders are all
 * business-initiated, so each needs a template that has cleared Meta review; freeform text is only
 * allowed inside a 24-hour window after the customer messages first.
 *
 * Consequently sendTemplate() is the real path, and sendFreeformText() exists only for the
 * in-window case. When a template name is missing or unapproved, this service fails with a clear,
 * actionable error instead of silently attempting a send Meta will reject.
 *
 * Credentials come from Quotation_Settings.whatsapp_config; the access token is read from the env
 * var NAMED by access_token_ref (default WHATSAPP_ACCESS_TOKEN) and never stored in Mongo.
 */

function resolveToken(config) {
  const name = (config && config.access_token_ref) || 'WHATSAPP_ACCESS_TOKEN';
  return process.env[name] || '';
}

function isConfigured(config) {
  if (!config || !config.enabled) return false;
  return Boolean(config.phone_number_id && resolveToken(config));
}

/** Meta expects digits only, country code included and no '+' or separators. */
function normalizePhone(phone, defaultCountryCode = '91') {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  // A bare 10-digit Indian mobile needs the country code prefixed.
  if (digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  // Numbers stored as 0XXXXXXXXXX carry a domestic trunk prefix that must be dropped.
  if (digits.length === 11 && digits.startsWith('0')) digits = `${defaultCountryCode}${digits.slice(1)}`;
  return digits;
}

function apiUrl(config) {
  const version = config.api_version || 'v21.0';
  return `https://graph.facebook.com/${version}/${config.phone_number_id}/messages`;
}

async function postToMeta(config, payload) {
  // Node 18+ (Vercel's runtime) has global fetch; no HTTP client dependency needed.
  const res = await fetch(apiUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resolveToken(config)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* non-JSON error body */ }

  if (!res.ok) {
    const metaMessage = parsed?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(metaMessage);
  }
  return parsed || {};
}

/**
 * Sends an approved template message.
 *
 * `bodyParams` are positional {{1}}, {{2}}… substitutions in the approved template body — Meta
 * does not accept our named {customer_name} placeholders, so callers must map named variables to
 * ordered params when the template was created.
 */
async function sendTemplate(config, { to, templateName, languageCode = 'en', bodyParams = [], headerParams = [] }) {
  const recipient = normalizePhone(to);
  if (!isConfigured(config)) {
    return { ok: false, channel: 'WhatsApp', recipient, error: 'WhatsApp Cloud API is not configured or is disabled in settings' };
  }
  if (!recipient) {
    return { ok: false, channel: 'WhatsApp', recipient: '', error: 'No usable phone number on record' };
  }
  if (!templateName) {
    return {
      ok: false,
      channel: 'WhatsApp',
      recipient,
      error: 'No approved WhatsApp template configured for this message type — business-initiated WhatsApp messages require a Meta-approved template'
    };
  }

  const components = [];
  if (headerParams.length) {
    components.push({ type: 'header', parameters: headerParams.map(t => ({ type: 'text', text: String(t ?? '') })) });
  }
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t ?? '') })) });
  }

  try {
    const result = await postToMeta(config, {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {})
      }
    });
    return { ok: true, channel: 'WhatsApp', recipient, messageId: result?.messages?.[0]?.id || '' };
  } catch (e) {
    return { ok: false, channel: 'WhatsApp', recipient, error: e.message };
  }
}

/**
 * Freeform text — only valid inside an open 24-hour customer service window. Used for replies to
 * customer-initiated conversations, never for quotation dispatch.
 */
async function sendFreeformText(config, { to, body }) {
  const recipient = normalizePhone(to);
  if (!isConfigured(config)) {
    return { ok: false, channel: 'WhatsApp', recipient, error: 'WhatsApp Cloud API is not configured or is disabled in settings' };
  }
  if (!recipient) {
    return { ok: false, channel: 'WhatsApp', recipient: '', error: 'No usable phone number on record' };
  }

  try {
    const result = await postToMeta(config, {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { preview_url: true, body: String(body || '') }
    });
    return { ok: true, channel: 'WhatsApp', recipient, messageId: result?.messages?.[0]?.id || '' };
  } catch (e) {
    return { ok: false, channel: 'WhatsApp', recipient, error: e.message };
  }
}

/** Lists templates and their review status so the settings UI can show what's actually sendable. */
async function listTemplates(config) {
  if (!isConfigured(config) || !config.waba_id) {
    return { ok: false, error: 'WhatsApp Business Account ID (waba_id) and credentials are required to list templates' };
  }
  try {
    const version = config.api_version || 'v21.0';
    const res = await fetch(
      `https://graph.facebook.com/${version}/${config.waba_id}/message_templates?limit=100`,
      { headers: { Authorization: `Bearer ${resolveToken(config)}` } }
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    return {
      ok: true,
      templates: (json.data || []).map(t => ({
        name: t.name,
        status: t.status,
        language: t.language,
        category: t.category
      }))
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendTemplate, sendFreeformText, listTemplates, isConfigured, normalizePhone };
