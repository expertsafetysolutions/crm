/**
 * captchaService — verifies a Cloudflare Turnstile or Google reCAPTCHA v3 token server-side.
 *
 * The browser widget is NOT the control. It produces a token; this file asks the provider whether
 * that token is real, unused and issued for this site. Skipping the server check is the classic
 * way a CAPTCHA becomes decoration — a bot simply posts straight to the API and never loads the
 * widget at all.
 *
 * PROVIDER IS CHOSEN BY WHICH SECRET IS PRESENT, and when neither is set verification is skipped.
 * That is a deliberate deployment decision, not an oversight: this feature ships before the
 * Cloudflare account exists, and a form that hard-fails until someone pastes a key in would mean
 * the public /inquiry page silently rejects every real customer from the moment it goes live.
 * The layers that do NOT need an account — per-IP rate limiting, the honeypot field and the
 * submit-timing trap — are always on, so an unconfigured deployment is defended, just less well.
 * `isConfigured()` is surfaced to the admin dashboard so "off" is visible rather than assumed.
 *
 * Fail-open vs fail-closed on a provider OUTAGE: this fails OPEN (see verifyToken). If Cloudflare
 * is unreachable, a genuine customer's enquiry still reaches the office. For a login form the
 * opposite would be right; for a sales lead, silently dropping business to spare a little spam is
 * the worse trade. The outcome is logged and reported so it can be spotted.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

// reCAPTCHA v3 returns a 0.0–1.0 score instead of a pass/fail. 0.5 is Google's own suggested
// threshold; overridable because the right cut-off depends on real traffic, and on a low-volume
// enquiry form a false rejection costs an actual sale.
const DEFAULT_RECAPTCHA_MIN_SCORE = 0.5;

function turnstileSecret() {
  return String(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

function recaptchaSecret() {
  return String(process.env.RECAPTCHA_SECRET_KEY || '').trim();
}

/** Turnstile wins when both are configured — it needs no score tuning and is privacy-preserving. */
function activeProvider() {
  if (turnstileSecret()) return 'turnstile';
  if (recaptchaSecret()) return 'recaptcha';
  return null;
}

function isConfigured() {
  return activeProvider() !== null;
}

function minScore() {
  const raw = Number(process.env.RECAPTCHA_MIN_SCORE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_RECAPTCHA_MIN_SCORE;
}

/**
 * POSTs the token to the provider.
 *
 * Both APIs take form-encoded bodies and answer with `{success, ...}`. An AbortController caps the
 * wait at 8s so a hanging provider cannot pin a serverless invocation open until the platform
 * timeout kills it mid-write.
 */
async function postVerify(url, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Verification endpoint returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies one token.
 *
 * `remoteIp` is passed through when known — both providers use it to spot a token minted for one
 * client and replayed from another.
 *
 * Returns `{ ok, skipped, provider, score, reason }`. Never throws: the caller decides what a
 * failure means, and an exception escaping here would turn a CAPTCHA hiccup into a 500 on a
 * customer's enquiry.
 */
async function verifyToken(token, remoteIp) {
  const provider = activeProvider();

  if (!provider) {
    return { ok: true, skipped: true, provider: null, reason: 'No CAPTCHA provider configured' };
  }

  // A configured provider with no token is a real failure: the widget should always produce one,
  // so its absence means the form was bypassed.
  if (!token || typeof token !== 'string') {
    return { ok: false, skipped: false, provider, reason: 'Verification token missing' };
  }

  try {
    if (provider === 'turnstile') {
      const data = await postVerify(TURNSTILE_VERIFY_URL, {
        secret: turnstileSecret(),
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {})
      });
      return data.success
        ? { ok: true, skipped: false, provider }
        : {
            ok: false,
            skipped: false,
            provider,
            reason: (data['error-codes'] || []).join(', ') || 'Turnstile rejected the token'
          };
    }

    const data = await postVerify(RECAPTCHA_VERIFY_URL, {
      secret: recaptchaSecret(),
      response: token,
      ...(remoteIp ? { remoteip: remoteIp } : {})
    });

    if (!data.success) {
      return {
        ok: false,
        skipped: false,
        provider,
        reason: (data['error-codes'] || []).join(', ') || 'reCAPTCHA rejected the token'
      };
    }

    // v3 is scored, not pass/fail: `success` only means the token was well-formed and unexpired.
    const score = typeof data.score === 'number' ? data.score : null;
    if (score !== null && score < minScore()) {
      return { ok: false, skipped: false, provider, score, reason: `Score ${score} below threshold ${minScore()}` };
    }
    return { ok: true, skipped: false, provider, score };
  } catch (err) {
    // Fail-open on transport/timeout only — a rejection above is still a rejection. See the file
    // header for why a lost lead is judged worse than an occasional bot.
    console.error(`[captchaService] ${provider} verification unreachable — allowing submission:`, err.message);
    return { ok: true, skipped: true, provider, reason: `Verification unavailable (${err.message})` };
  }
}

module.exports = {
  verifyToken,
  isConfigured,
  activeProvider,
  minScore
};
