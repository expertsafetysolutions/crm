/**
 * inquiryRoutes — the public inquiry engine's HTTP surface.
 *
 * MOUNTED BEFORE apiRouter IN server.js. apiRouter's first middleware is authenticateToken, which
 * answers 401 without calling next(), so a public route registered after it is unreachable — the
 * same trap documented on /api/health.
 *
 * Only POST /api/inquiry and GET /api/inquiry/config are public. Everything else in this file is
 * staff-only and re-applies authenticateToken explicitly, because this router is mounted outside
 * apiRouter and therefore inherits none of its protection (the same reason purchaseRoutes.js
 * re-applies it).
 *
 * DEFENCE IN DEPTH on the public POST, in the order an attacker meets it:
 *   1. express.json({limit:'32kb'}) — a body cap far below the app-wide 10mb. Nothing legitimate
 *      here is larger, and the global limit exists for base64 photos, which this route never takes.
 *   2. inquiryLimiter — 3 submissions per IP per minute, as specified.
 *   3. Honeypot field — a hidden input no human can see or fill.
 *   4. Timing trap — a form completed faster than a person can type.
 *   5. Turnstile / reCAPTCHA v3 — when configured (see captchaService).
 *   6. inquiryValidator — sanitises and validates every field.
 *
 * Layers 3 and 4 answer 200 with a normal-looking success rather than an error. A bot that is told
 * why it failed adapts; one that believes it succeeded does not retry, and never learns the trap
 * exists. Nothing is written to the database on those paths.
 */

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { authenticateToken } = require('./authRoutes');
const sheetsService = require('../services/sheetsService');
const inquiryService = require('../services/inquiryService');
const inquiryDispatch = require('../services/inquiryDispatch');
const captchaService = require('../services/captchaService');
const inquiryValidator = require('../utils/inquiryValidator');

const router = express.Router();

/**
 * 3 submissions per IP per minute, per the specification.
 *
 * Tighter than every other limiter in the app, and deliberately so: this is the only
 * unauthenticated WRITE endpoint in the system, and each submission creates a customer, a task, a
 * quotation and two emails. The shared-IP concern that keeps the other limiters loose barely
 * applies — a whole office does not submit enquiries simultaneously, and a genuine customer
 * submits once.
 *
 * Counted per IP only (not per mobile number): keying on a body field would let an attacker vary
 * one character and reset their own budget.
 */
const inquiryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // ipKeyGenerator collapses IPv6 to its /56 prefix — without it, one subnet yields effectively
  // unlimited addresses and the limit is decorative. Same reasoning as the login limiter.
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    error: 'You have submitted several enquiries in a row. Please wait a minute and try again, or call us on +91 84606 99569.'
  }
});

/** Minimum seconds between the form rendering and being submitted. A human cannot beat this. */
const MIN_FILL_SECONDS = 3;

/**
 * Public form configuration.
 *
 * Lets the page render the requirement checkboxes from the server's allow-list — the same constant
 * the validator enforces — so the two can never drift. Also tells the client which CAPTCHA
 * provider to load, if any.
 *
 * The Turnstile SITE key is public by design (it appears in the widget markup). The SECRET key is
 * never sent, and is only ever read server-side by captchaService.
 */
router.get('/inquiry/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    requirements: inquiryValidator.REQUIREMENT_OPTIONS,
    limits: inquiryValidator.LIMITS,
    captcha: {
      provider: captchaService.activeProvider(),
      siteKey: captchaService.activeProvider() === 'turnstile'
        ? String(process.env.TURNSTILE_SITE_KEY || '')
        : String(process.env.RECAPTCHA_SITE_KEY || '')
    }
  });
});

/**
 * The public submission endpoint.
 *
 * Always answers JSON. A 400 carries per-field `errors` so the form can mark the offending inputs;
 * a 500 tells the customer to phone instead, because a silent failure on a sales lead is the worst
 * outcome available here.
 */
router.post('/inquiry', inquiryLimiter, express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const body = req.body || {};

    // Layer 3 — honeypot. `website` is rendered off-screen and left empty by every real user;
    // form-filling bots populate every field they find.
    if (String(body.website || '').trim() !== '') {
      console.warn('[inquiry] Honeypot triggered from', req.ip);
      return res.json({ success: true, inquiryNo: null, message: 'Thank you. We have received your enquiry.' });
    }

    // Layer 4 — timing. renderedAt is stamped by the client when the form mounts.
    const renderedAt = Number(body.renderedAt);
    if (Number.isFinite(renderedAt) && renderedAt > 0) {
      const elapsed = (Date.now() - renderedAt) / 1000;
      // A negative elapsed means a clock skew or a forged value, not a fast human.
      if (elapsed < MIN_FILL_SECONDS) {
        console.warn(`[inquiry] Timing trap (${elapsed.toFixed(1)}s) from`, req.ip);
        return res.json({ success: true, inquiryNo: null, message: 'Thank you. We have received your enquiry.' });
      }
    }

    // Layer 6 first — validating before the CAPTCHA round-trip avoids a network call for a form
    // that was going to be rejected anyway, and returns field errors faster.
    const { valid, errors, data } = inquiryValidator.validateInquiry(body);
    if (!valid) {
      return res.status(400).json({ error: 'Please correct the highlighted fields.', errors });
    }

    // Layer 5 — CAPTCHA. Skipped when unconfigured; see captchaService for why that is deliberate.
    const captcha = await captchaService.verifyToken(body.captchaToken, req.ip);
    if (!captcha.ok) {
      console.warn('[inquiry] CAPTCHA rejected:', captcha.reason);
      return res.status(400).json({
        error: 'We could not verify that you are human. Please refresh the page and try again.',
        captchaFailed: true
      });
    }

    // Load-bearing: customer + lead + timeline. A throw here is a genuine failure.
    const ingested = await inquiryService.ingestInquiry(data, { ip: req.ip });

    // Best-effort: draft quotation, internal alerts, customer acknowledgement. Awaited so it
    // completes before the serverless instance can be frozen, but its failures never fail the
    // request — the lead is already saved and the office will see it.
    const post = await inquiryService.runPostIngestion(ingested, data);

    if (post.errors.length) {
      console.error('[inquiry] Post-ingestion issues:', post.errors.join(' | '));
    }

    res.status(201).json({
      success: true,
      inquiryNo: ingested.inquiryNo,
      isReturning: ingested.isReturning,
      message: 'Thank you. We have received your enquiry and our team will contact you shortly.'
    });
  } catch (err) {
    console.error('POST /api/inquiry error:', err);
    res.status(500).json({
      error: 'We could not record your enquiry just now. Please call us on +91 84606 99569 and we will take the details directly.'
    });
  }
});

// ---------------------------------------------------------------------------
// Staff-only. authenticateToken is re-applied per route: this router is mounted
// outside apiRouter and inherits none of its auth.
// ---------------------------------------------------------------------------

/**
 * Recent online leads, for the dashboard alert feed.
 *
 * `?since=<ms>` returns only leads created after that moment, which is what makes the live pop-up
 * possible without a WebSocket — see the note on the client poller. Capped at 50 because this
 * feeds a notification tray, not a report.
 */
router.get('/inquiry/leads', authenticateToken, async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const tasks = await sheetsService.getAllTasks();

    const leads = tasks
      .filter(t => t.Source === inquiryService.SOURCE)
      .filter(t => !since || Number(t.Created_At_Ms || 0) > since)
      .sort((a, b) => Number(b.Created_At_Ms || 0) - Number(a.Created_At_Ms || 0))
      .slice(0, 50)
      .map(t => ({
        taskId: t.Task_ID,
        inquiryNo: t.Inquiry_No || '',
        customerId: t.Customer_ID,
        contactPerson: t.Contact_Person || '',
        contactPhone: t.Contact_Phone || '',
        contactEmail: t.Contact_Email || '',
        description: t.Description || '',
        requirements: Array.isArray(t.Inquiry_Requirements) ? t.Inquiry_Requirements : [],
        otherText: t.Inquiry_Other_Text || '',
        siteAddress: t.Site_Address || '',
        stage: t.Stage || '',
        assignedStaff: t.Assigned_Staff || '',
        createdAtMs: Number(t.Created_At_Ms || 0),
        createdAt: t.Created_At || ''
      }));

    res.json({ success: true, leads, serverTimeMs: Date.now() });
  } catch (err) {
    console.error('GET /api/inquiry/leads error:', err);
    res.status(500).json({ error: 'Failed to load online leads' });
  }
});

/**
 * The 1-click "Send Company Profile" button on a lead.
 *
 * Takes a customerId (not raw addresses) so the brochure can only ever go to someone already in
 * the register — a staff-authenticated endpoint that mails an arbitrary address is an open relay
 * with extra steps. An override address is accepted for the case where the lead's contact differs
 * from the account's billing email, but the customer must still resolve.
 */
router.post('/inquiry/send-company-profile', authenticateToken, async (req, res) => {
  try {
    const { customerId, taskId, email, phone, channel, attachmentIds } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId is required' });

    const customers = await sheetsService.getAllCustomers();
    const customer = customers.find(c => c.Customer_ID === customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const task = taskId ? await sheetsService.getTaskById(taskId) : null;

    const { results, attachmentCount } = await inquiryDispatch.sendCompanyProfile({
      customer,
      task,
      // Sanitised because these are free-text overrides typed by staff and are about to be used as
      // send targets and interpolated into a template.
      recipientEmail: inquiryValidator.normalizeEmail(email) || customer.Email,
      recipientPhone: inquiryValidator.sanitizeText(phone, 20) || customer.Contact,
      attachmentIds,
      channel,
      actor: { staffId: req.user.staffId, name: req.user.name }
    });

    const delivered = results.filter(r => r.ok);
    res.json({
      success: delivered.length > 0,
      results,
      attachmentCount,
      // The button's job is to send a brochure; saying so plainly when there is no brochure to
      // send stops staff assuming the customer got one.
      warning: attachmentCount === 0
        ? 'Sent, but no company profile file is uploaded yet — add one in Quotation Settings → Email Attachments and tick "Company Profile".'
        : undefined
    });
  } catch (err) {
    console.error('POST /api/inquiry/send-company-profile error:', err);
    res.status(500).json({ error: 'Failed to send the company profile' });
  }
});

module.exports = router;
