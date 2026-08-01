/**
 * HTTP hardening: security headers and rate limiting.
 *
 * Two things shape everything in this file:
 *
 * 1. The API is served from a Vercel serverless function (api/index.js re-exports this app), so
 *    the process is short-lived and there may be several of them. Rate-limit state is therefore
 *    per-instance and best-effort — it raises the cost of a brute-force attempt, it does not
 *    promise a global ceiling. A hard guarantee needs a shared store (Redis/Upstash); the
 *    in-memory limiter is what works without adding infrastructure.
 *
 * 2. Field staff share connections. A whole workshop behind one 4G router or NAT presents ONE
 *    IP, so limits that look generous for a single user are not generous for twelve people
 *    syncing at shift start. Every number below is deliberately loose for that reason — the
 *    login limiter is the only tight one, because a shared IP is no excuse for 300 password
 *    attempts a minute.
 */

const crypto = require('crypto');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Content-Security-Policy tuned to what this app genuinely loads. Anything stricter breaks a
 * working feature:
 *
 *   'unsafe-inline' in styleSrc  — the server-rendered verification pages carry a <style> block,
 *                                  and Tailwind/React set inline style attributes.
 *   fonts.googleapis / gstatic   — those same public pages <link> the Outfit font.
 *   'wasm-unsafe-eval' + blob:   — tesseract.js compiles WebAssembly and spawns worker blobs for
 *                                  the on-device OCR in EuidScanner. Without these the scanner
 *                                  fails at runtime, and only on the phones that use it.
 *   data: / blob: in imgSrc      — base64 photos, html2canvas canvases and generated QR codes.
 *   connectSrc api.ipify.org     — attendance geo-checks read the public IP.
 *   challenges.cloudflare.com    — the Turnstile widget on the public /inquiry form: it loads a
 *   + google.com/recaptcha         script, renders inside an iframe and posts the result back, so
 *                                  it needs script/frame/connect all three. Listed unconditionally
 *                                  rather than only when keys are configured, because a CSP built
 *                                  from environment state would differ between deployments and
 *                                  fail exactly where it is hardest to debug — in the browser of
 *                                  a customer nobody is watching. Naming two well-known CAPTCHA
 *                                  hosts costs nothing when the feature is off: no page requests
 *                                  them, and an allow-list entry is not a request.
 *
 * frameAncestors 'none' is the clickjacking control that actually matters here: it stops the
 * login screen and the admin dashboard being framed by a lookalike site. Note frameSrc below is
 * the opposite direction — what THIS page may embed — so allowing the CAPTCHA iframe does not
 * weaken it.
 */
const CAPTCHA_HOSTS = [
  'https://challenges.cloudflare.com',
  'https://www.google.com',
  'https://www.gstatic.com'
];

const contentSecurityPolicy = {
  useDefaults: true,
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
    scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'blob:', ...CAPTCHA_HOSTS],
    workerSrc: ["'self'", 'blob:'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    connectSrc: ["'self'", 'https://api.ipify.org', ...CAPTCHA_HOSTS],
    // The CAPTCHA challenge renders in an iframe; without this the widget is invisible and the
    // customer simply cannot submit the form.
    frameSrc: ["'self'", ...CAPTCHA_HOSTS],
    upgradeInsecureRequests: []
  }
};

/**
 * Skips rate limiting for Vercel's own cron caller.
 *
 * The cron routes are already gated by CRON_SECRET, and a scheduled job that trips a limiter
 * fails silently at 4am with nobody watching. Only trusted when the secret is actually
 * configured — otherwise this would be a free bypass header.
 */
function isTrustedCron(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

const limiterDefaults = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTrustedCron
};

/**
 * Login limiter — the one that is deliberately tight.
 *
 * Counts only FAILED attempts (skipSuccessfulRequests), so a busy shared office signing in at
 * 9am never trips it; ten wrong passwords from one IP in fifteen minutes is what does. Keyed by
 * IP + submitted staffId so one person fat-fingering their password cannot lock out the whole
 * workshop behind the same router.
 */
const loginLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const id = String(req.body?.staffId || '').trim().toUpperCase();
    // ipKeyGenerator collapses an IPv6 address to its /56 prefix. A raw req.ip would let an
    // attacker rotate through the addresses of a single subnet and never trip the limit; the
    // library rejects a keyGenerator that touches req.ip without it.
    return `${ipKeyGenerator(req.ip)}:${id}`;
  },
  message: { error: 'Too many failed login attempts. Please wait 15 minutes and try again.' }
});

/**
 * Password-change limiter. Lower volume than login and always authenticated, so it is keyed by
 * staff ID: the control is against guessing someone's CURRENT password, which is per-account.
 */
const passwordChangeLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user?.staffId ? String(req.user.staffId) : ipKeyGenerator(req.ip)),
  message: { error: 'Too many password change attempts. Please try again later.' }
});

/**
 * General API limiter. Sized for the offline queue: when a technician regains signal,
 * flushOfflineQueue drains a whole shift's actions at once, and a day of job-card work plus a
 * /sync/all can be hundreds of calls in a minute. 600/min per IP absorbs that and still stops a
 * scraper walking the customer register.
 */
const apiLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  max: 600,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
});

/**
 * Public verification limiter. This route is unauthenticated and reads the certificate registry,
 * so it is the one an outsider can hit without credentials — the limit is what stops it being
 * used to enumerate certificate numbers.
 */
const publicVerifyLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many verification requests. Please try again shortly.' }
});

/**
 * Applies the header stack.
 *
 * crossOriginResourcePolicy is relaxed to cross-origin because /api/media/:id serves images
 * consumed by <img> tags and html2canvas from other origins; the default would block them.
 * HSTS is left to Vercel, which already sends it on the apex domain.
 */
function applySecurityHeaders(app) {
  /*
   * Per-request nonce for server-rendered public pages that carry an inline <script> — today just
   * the customer quote portal. script-src 'self' blocks such a script outright: the buttons render,
   * the customer taps Accept, and nothing at all happens, with the failure visible only in a
   * browser console no customer will ever open.
   *
   * A nonce rather than 'unsafe-inline': the latter would re-enable EVERY inline script across the
   * whole app, including the authenticated dashboards, to fix two pages. The nonce authorises
   * exactly the script we emitted on this one response and nothing else.
   */
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      ...contentSecurityPolicy,
      directives: {
        ...contentSecurityPolicy.directives,
        scriptSrc: [
          ...contentSecurityPolicy.directives.scriptSrc,
          (req, res) => `'nonce-${res.locals.cspNonce}'`
        ]
      }
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Two years, subdomains included, and preload-eligible. `preload` is what lets browsers refuse
    // plaintext HTTP to this domain on the FIRST visit, before any header has been seen — without
    // it the initial request is still sniffable. Only meaningful because every environment here is
    // HTTPS (Vercel terminates TLS); it would strand a plain-HTTP host permanently.
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }
  }));

  // Defence in depth behind the proxy. Vercel already redirects HTTP→HTTPS at the edge, so this
  // should never fire in production; it matters if the app is ever run behind a misconfigured
  // proxy or a self-hosted reverse proxy that forwards plaintext. GET/HEAD are redirected;
  // anything else is refused outright, because a POST body has already crossed the wire in the
  // clear by the time we see it and redirecting would invite the client to send it twice.
  app.use((req, res, next) => {
    if (process.env.NODE_ENV !== 'production') return next();
    const proto = req.headers['x-forwarded-proto'];
    if (!proto || proto === 'https') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    return res.status(403).json({ error: 'HTTPS is required for this request.' });
  });
}

module.exports = {
  applySecurityHeaders,
  contentSecurityPolicy,
  loginLimiter,
  passwordChangeLimiter,
  apiLimiter,
  publicVerifyLimiter
};
