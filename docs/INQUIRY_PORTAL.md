# Public Inquiry Portal — `/inquiry`

Lead-capture form at `expertsafety.in/inquiry`, open to anyone with no login. A submission creates
a customer (or joins an existing one), a Sales lead, a draft quotation, and alerts the office.

This is the **only unauthenticated write endpoint in the system**. Everything below follows from
that.

---

## 1. What happens on submit

```
POST /api/inquiry
  ├─ body cap 32kb  →  rate limit 3/IP/min  →  honeypot  →  timing trap
  ├─ validate + sanitise (inquiryValidator)  →  CAPTCHA (if configured)
  │
  ├─ LOAD-BEARING (failure = 500, customer told to phone)
  │    ├─ Inquiry number      INQ/26-27/001   (atomic Counter_Master)
  │    ├─ Customer            matched by mobile, else created
  │    ├─ Lead task           Sales / "New Inquiry", UNASSIGNED, Priority High
  │    └─ Timeline entry      the enquiry verbatim
  │
  └─ BEST-EFFORT (each guarded; failure never loses the lead)
       ├─ Draft quotation     zero-rate placeholder lines, status Draft
       ├─ Admin alert         2 emails — ON
       └─ Customer thank-you  email + WhatsApp — OFF by default
```

### Duplicate handling
Matched on **mobile number**, normalised to bare 10 digits, so `+91 98765 43210`,
`098765 43210` and `9876543210` are one person. `Contact`, `Secondary_Contact` and every
`Coordinators[].phone` are searched.

An existing customer's stored profile is **read, never overwritten**. This is deliberate: the
endpoint is unauthenticated, so treating public input as truth for an existing row would let
anyone who knows a customer's mobile number rewrite that customer's billing address.

---

## 2. Environment variables

All optional. **The form works with none of them set** — see "Bot protection" below.

| Variable | Where | Purpose |
|---|---|---|
| `TURNSTILE_SITE_KEY` | Vercel + `client/.env` | Cloudflare Turnstile public key |
| `TURNSTILE_SECRET_KEY` | Vercel only | Turnstile secret — **never** commit |
| `RECAPTCHA_SITE_KEY` | Vercel | reCAPTCHA v3 public key (alternative) |
| `RECAPTCHA_SECRET_KEY` | Vercel only | reCAPTCHA secret |
| `RECAPTCHA_MIN_SCORE` | Vercel | v3 threshold, default `0.5` |
| `PUBLIC_BASE_URL` | Vercel | Absolute base for the CRM link in alert emails |

Turnstile wins when both providers are configured.

### Getting Turnstile keys (free)
1. `dash.cloudflare.com` → free account (the domain need not be on Cloudflare)
2. **Turnstile** → **Add Site** → domain `expertsafety.in`, widget type **Managed**
3. Copy **Site Key** and **Secret Key** into the variables above
4. Redeploy — the widget appears by itself; no code change

---

## 3. Bot protection, in the order an attacker meets it

| Layer | Needs setup? | Response when tripped |
|---|---|---|
| 32 kb body cap | no | 413 |
| 3 submissions / IP / minute | no | 429 with a "call us" message |
| Honeypot (hidden `website` field) | no | **200, looks like success**, nothing written |
| Timing trap (< 3 s to fill) | no | **200, looks like success**, nothing written |
| Turnstile / reCAPTCHA v3 | keys | 400 "could not verify you are human" |
| Field validation + sanitising | no | 400 with per-field errors |

Layers 3 and 4 answer **200** on purpose. A bot told why it failed adapts; one that believes it
succeeded does not retry and never learns the trap exists.

**Without CAPTCHA keys the form still runs** and the other five layers still apply. This is why
the feature could ship before the Cloudflare account existed — a form that hard-failed until
someone pasted a key in would have rejected every real customer from the moment it went live.

CAPTCHA **fails open on a provider outage** (not on a rejection): if Cloudflare is unreachable, a
genuine enquiry still gets through. Losing real business to spare a little spam is the worse
trade for a sales form. Outages are logged.

---

## 4. Email

### Internal alert — ON
Two emails per submission, one each so a bad address cannot suppress the other:

- `sales.expertsafety@gmail.com`
- `expertsafetysolution@gmail.com`

Subject: `🚨 New Online Inquiry Received - {Name} [{Company}]`
Body: full details, requirement chips, call/WhatsApp/email shortcuts, and a deep link into the CRM.

Editable at `Quotation_Settings.inquiry_alert_recipients`. Emptying the list falls back to the two
addresses above — an alert with no recipient is a silently lost lead.

### Customer thank-you — OFF
Ships disabled (`email_enabled.inquiry_acknowledgement = false`), exactly like `challan_email`,
`certificate_email` and `pod_confirmation`. Deploying this must not, on its own, start auto-replying
to the public.

**To turn on:** Quotation Settings → Email Templates → `inquiry_acknowledgement`.

WhatsApp needs a Meta-approved template name on the same entry; without one it reports an
actionable error rather than silently failing.

> `MAIL_SAFE_MODE` redirects **all** of the above, internal alerts included, so local testing is safe.

---

## 5. In the CRM

- **Live alert** — online leads appear in the notification tray for **Admin and Sales**, polled by
  the existing Navbar. Cleared once someone is assigned.
- **Badge + button** — `components/OnlineInquiryPanel.jsx` renders the `Online Inquiry` badge, the
  site address, the customer's own words, and **📧 Send Company Profile** on the lead.
- **Brochure source** — Quotation Settings → Email Attachments, entries flagged `company_profile`.
  With none uploaded the button still sends the covering note and says plainly that nothing was
  attached.

### Why polling and not WebSockets
The API runs as a Vercel serverless function: there is no long-lived process to hold a socket on,
and each invocation is frozen the moment it responds. Riding the notification feed the Navbar
already polls produces the same visible outcome with nothing new to operate, and keeps working
across an offline→online transition. Genuine push already exists for phones via
`pushService` + VAPID.

---

## 6. Files

```
server/src/utils/inquiryValidator.js    sanitising, validation, requirement allow-list
server/src/services/captchaService.js   Turnstile + reCAPTCHA v3
server/src/services/inquiryService.js   dedupe, customer, lead, draft quotation
server/src/services/inquiryDispatch.js  admin alert, customer ack, company profile
server/src/routes/inquiryRoutes.js      public POST + staff-only routes
client/src/pages/PublicInquiryPage.jsx  the form (own lazy chunk, ~14 kB)
client/src/components/OnlineInquiryPanel.jsx   CRM badge + 1-click button
```

### Two ordering rules that will bite you
1. **`inquiryRouter` must stay mounted before `apiRouter` in `server.js`.** `apiRouter`'s first
   middleware is `authenticateToken`, which answers 401 without calling `next()` — registered after
   it, the public form 401s for every customer.
2. **`/inquiry` must stay in `PUBLIC_PATHS` in `App.jsx`, above the `if (!user) return <Login/>`
   gate.** Below it, customers get a staff login screen and leave.

---

## 7. Testing

Never submit through the live form with real details — it creates a real customer, a real lead and
a real quotation number, and emails the office.

Safe checks:

```bash
npm run build      # the real gate
npm run verify     # read-only; 29 checks, writes nothing
```

`GET /api/inquiry/config` is safe to open in a browser: it returns the requirement list and which
CAPTCHA provider is active (public site key only — the secret is never sent).
