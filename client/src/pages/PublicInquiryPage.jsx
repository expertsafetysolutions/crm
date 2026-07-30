import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Phone, MessageCircle, Building2, FileText, User,
  CheckCircle2, AlertCircle, Loader2, Send, ShieldCheck
} from 'lucide-react';

/**
 * PublicInquiryPage — expertsafety.in/inquiry
 *
 * The only screen in this app rendered for someone with no login, so it deliberately shares no
 * chrome with the CRM: no Navbar, no AuthContext, no offline queue. It is reached before the auth
 * gate in App.jsx (see the public-route block there).
 *
 * Built to the UI standard in CLAUDE.md — laid out for 320–480px first, primary action in a sticky
 * bottom bar padded clear of the home indicator, 44px inputs and a 48px submit. The audience is a
 * facility manager on a phone, often outdoors, so the form asks for the minimum that lets the
 * office call back and nothing more.
 *
 * Client-side validation here is a CONVENIENCE, never the control: every rule is enforced again in
 * inquiryValidator.js on the server, which is what actually protects the database. Duplicating the
 * checks just spares the customer a round trip.
 */

// Mirrors REQUIREMENT_OPTIONS in server/src/utils/inquiryValidator.js. Fetched from
// /api/inquiry/config at mount so the two cannot drift; this constant is the offline fallback for
// a first paint or a failed config call, and the server's allow-list is what finally decides.
const FALLBACK_REQUIREMENTS = [
  { key: 'EXTINGUISHER', label: 'Fire Extinguisher Refilling / New Supply' },
  { key: 'HYDRANT', label: 'Fire Hydrant System Maintenance' },
  { key: 'NOC', label: 'Fire NOC Consultancy & Renewal' },
  { key: 'AUDIT', label: 'Safety Audit & Training' },
  { key: 'OTHER', label: 'Other Requirement' }
];

const OFFICE_PHONE_DISPLAY = '+91 84606 99569';
const OFFICE_PHONE_E164 = '918460699569';

/*
 * Brand palette, sampled from the EXPERT wordmark in /logo.jpg and matching the constants
 * QuotationPdfTemplate already prints on every quotation and invoice. The customer who fills this
 * form receives those documents next, so the colours must be the same red — a different accent
 * here would read as a different company.
 *
 * BRAND_RED is used for actions and accents only, never as a large background: at full strength
 * behind white text it vibrates on a phone screen in daylight, which is exactly where this form is
 * used. The header therefore stays white with the real logo on it, the way letterhead does.
 */
const BRAND_RED = '#E01B24';
const BRAND_RED_DARK = '#A3111A';
const BRAND_INK = '#111827';

const EMPTY_FORM = {
  name: '',
  mobile: '',
  companyName: '',
  email: '',
  gstin: '',
  address: '',
  requirements: [],
  otherRequirement: '',
  website: '' // honeypot — see the hidden field near the bottom of the form
};

export default function PublicInquiryPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [requirements, setRequirements] = useState(FALLBACK_REQUIREMENTS);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [serverError, setServerError] = useState('');
  const [captcha, setCaptcha] = useState({ provider: null, siteKey: '' });
  // What was actually sent, frozen at submit time — the confirmation reads back from this rather
  // than from `form`, which is cleared when the customer starts another enquiry.
  const [submittedSnapshot, setSubmittedSnapshot] = useState(null);

  // Stamped once at mount and posted back. The server rejects anything returned faster than a
  // human could type it — see MIN_FILL_SECONDS in inquiryRoutes.js.
  const renderedAtRef = useRef(Date.now());
  const captchaTokenRef = useRef('');
  const turnstileRef = useRef(null);
  const formTopRef = useRef(null);

  // This page is public and must be indexable, unlike the rest of the app.
  useEffect(() => {
    document.title = 'Enquiry — Expert Safety Solutions';
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/inquiry/config')
      .then(r => (r.ok ? r.json() : null))
      .then(cfg => {
        if (cancelled || !cfg) return;
        if (Array.isArray(cfg.requirements) && cfg.requirements.length) setRequirements(cfg.requirements);
        if (cfg.captcha?.provider && cfg.captcha?.siteKey) setCaptcha(cfg.captcha);
      })
      .catch(() => { /* fallbacks already rendered — the form stays usable */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * Loads the CAPTCHA widget only when the server says one is configured.
   *
   * Both providers are injected at runtime rather than bundled, so a deployment with no keys ships
   * no third-party script at all and the form keeps working. Turnstile renders an explicit widget;
   * reCAPTCHA v3 is invisible and mints its token at submit time instead.
   */
  useEffect(() => {
    if (!captcha.provider || !captcha.siteKey) return;

    const src = captcha.provider === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      : `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(captcha.siteKey)}`;

    if (document.querySelector(`script[src="${src}"]`)) return;

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (captcha.provider === 'turnstile' && window.turnstile && turnstileRef.current) {
        window.turnstile.render(turnstileRef.current, {
          sitekey: captcha.siteKey,
          callback: (token) => { captchaTokenRef.current = token; },
          // A stale token is worse than none: it would be rejected server-side and read to the
          // customer as "we could not verify you". Clearing forces a fresh one at submit.
          'expired-callback': () => { captchaTokenRef.current = ''; },
          'error-callback': () => { captchaTokenRef.current = ''; }
        });
      }
    };
    document.head.appendChild(script);
  }, [captcha]);

  const setField = useCallback((field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
    // Clear the field's error as soon as the customer starts fixing it — leaving it red while they
    // type reads as "still wrong" when it may already be right.
    setErrors(prev => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }, []);

  const toggleRequirement = useCallback((key) => {
    setForm(prev => ({
      ...prev,
      requirements: prev.requirements.includes(key)
        ? prev.requirements.filter(k => k !== key)
        : [...prev.requirements, key]
    }));
    setErrors(prev => (prev.requirements ? { ...prev, requirements: undefined } : prev));
  }, []);

  /**
   * Mirrors the server's rules so problems surface without a round trip. The server re-checks
   * everything; this only decides whether to bother sending.
   */
  const validate = () => {
    const next = {};
    if (!form.name.trim() || form.name.trim().length < 2) next.name = 'Please enter your full name';

    const digits = form.mobile.replace(/\D/g, '').slice(-10);
    if (!form.mobile.trim()) next.mobile = 'Please enter your mobile number';
    else if (!/^[6-9]\d{9}$/.test(digits)) next.mobile = 'Please enter a valid 10-digit mobile number';

    if (!form.companyName.trim()) next.companyName = 'Please enter your company name';

    if (!form.email.trim()) next.email = 'Please enter your email address';
    else if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(form.email.trim())) next.email = 'Please enter a valid email address';

    if (!form.address.trim()) next.address = 'Please enter your site address';

    // Optional, but a supplied GSTIN must at least be the right shape. The checksum is verified
    // server-side, where the validated implementation already lives.
    if (form.gstin.trim() && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(form.gstin.trim().toUpperCase())) {
      next.gstin = 'This GST number does not look right. Check it, or leave it blank.';
    }

    if (form.requirements.length === 0) next.requirements = 'Please select at least one requirement';
    if (form.requirements.includes('OTHER') && !form.otherRequirement.trim()) {
      next.otherRequirement = 'Please describe what you need';
    }
    return next;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const found = validate();
    if (Object.keys(found).length) {
      setErrors(found);
      // Scroll to the top of the form so the first error is visible — on a phone the offending
      // field is usually above the fold the customer is looking at.
      formTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    setSubmitting(true);
    setServerError('');

    try {
      // reCAPTCHA v3 is invisible and scores the interaction, so its token must be minted at the
      // moment of submission rather than at render.
      let token = captchaTokenRef.current;
      if (captcha.provider === 'recaptcha' && window.grecaptcha) {
        token = await new Promise(resolve => {
          window.grecaptcha.ready(() => {
            window.grecaptcha.execute(captcha.siteKey, { action: 'inquiry' })
              .then(resolve)
              .catch(() => resolve(''));
          });
        });
      }

      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          mobile: form.mobile.replace(/\D/g, '').slice(-10),
          gstin: form.gstin.trim().toUpperCase(),
          renderedAt: renderedAtRef.current,
          captchaToken: token || ''
        })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.errors) {
          setErrors(data.errors);
          formTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        setServerError(data.error || 'Something went wrong. Please try again.');
        // A used Turnstile token cannot be replayed, so the widget must be reset before a retry.
        if (window.turnstile && turnstileRef.current) {
          window.turnstile.reset(turnstileRef.current);
          captchaTokenRef.current = '';
        }
        return;
      }

      // Snapshot what was actually sent, so the confirmation keeps reading back the real values
      // even though the form is cleared behind it.
      setSubmittedSnapshot({
        ...form,
        mobile: form.mobile.replace(/\D/g, '').slice(-10),
        gstin: form.gstin.trim().toUpperCase(),
        requirementLabels: form.requirements.map(
          k => requirements.find(o => o.key === k)?.label || k
        )
      });
      setResult(data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setServerError(
        `We could not reach our server. Please check your connection, or call us on ${OFFICE_PHONE_DISPLAY}.`
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (result) return (
    <SuccessPanel
      result={result}
      submitted={submittedSnapshot}
      requirementLabels={submittedSnapshot?.requirementLabels}
      onReset={() => {
        setForm(EMPTY_FORM);
        setResult(null);
        setSubmittedSnapshot(null);
        setErrors({});
        // A fresh render timestamp, or the server's timing trap would judge the new submission
        // against the moment the FIRST form mounted and let a too-fast entry through.
        renderedAtRef.current = Date.now();
        captchaTokenRef.current = '';
      }}
    />
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* White letterhead bar carrying the real logo, with the brand red as a keyline underneath —
          the same treatment as the printed documents this customer will receive next. */}
      <header
        className="sticky top-0 z-30 bg-white shadow-sm"
        style={{ borderBottom: `3px solid ${BRAND_RED}` }}
      >
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <img
            src="/logo.jpg"
            alt="Expert Safety Solutions"
            className="h-9 sm:h-11 w-auto object-contain"
            // The wordmark carries the company name, so if it fails to load the text below must
            // appear in its place rather than leaving an unbranded bar.
            onError={e => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'block'; }}
          />
          <span className="hidden text-base font-extrabold" style={{ color: BRAND_INK }}>
            EXPERT SAFETY SOLUTIONS
          </span>
          <a
            href={`tel:+${OFFICE_PHONE_E164}`}
            className="flex items-center gap-1.5 text-[11px] sm:text-xs font-extrabold shrink-0 active:scale-95 transition"
            style={{ color: BRAND_RED_DARK }}
          >
            <Phone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{OFFICE_PHONE_DISPLAY}</span>
          </a>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 pb-32">
        <div ref={formTopRef} className="mb-5">
          <h2 className="text-xl sm:text-2xl font-extrabold" style={{ color: BRAND_INK }}>
            We are waiting for your valuable inquiry....
          </h2>
          <p className="text-[13px] text-slate-500 font-medium mt-1 leading-relaxed">
            Fill this form and our team will get back to you shortly. Thank you.
          </p>
        </div>

        {serverError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex gap-2.5 animate-fadeIn">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-[13px] font-semibold text-red-800 leading-relaxed">{serverError}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <Section title="Your details" icon={User}>
            <Field id="inq-name" label="Your Name" required error={errors.name}>
              <input
                type="text" className="jc-input" value={form.name} autoComplete="name"
                onChange={e => setField('name', e.target.value)}
                placeholder="e.g. Ramesh Patel" maxLength={100}
              />
            </Field>

            <Field id="inq-mobile" label="Mobile Number" required error={errors.mobile} hint="We will call or WhatsApp you on this number">
              <div className="flex items-stretch gap-2">
                <span className="inline-flex items-center px-3 rounded-xl bg-slate-100 border border-slate-200 text-[13px] font-bold text-slate-500 shrink-0">
                  +91
                </span>
                {/* inputMode numeric brings up the digit keypad on a phone without rejecting a
                    pasted "+91 98765 43210" the way type=number would. */}
                <input
                  type="tel" inputMode="numeric" autoComplete="tel" className="jc-input"
                  value={form.mobile}
                  onChange={e => setField('mobile', e.target.value.replace(/[^\d\s+-]/g, ''))}
                  placeholder="98765 43210" maxLength={17}
                />
              </div>
            </Field>

            <Field id="inq-email" label="Email ID" required error={errors.email} hint="Your confirmation and quotation go here">
              <input
                type="email" className="jc-input" value={form.email} autoComplete="email"
                onChange={e => setField('email', e.target.value)}
                placeholder="you@company.com" maxLength={254}
              />
            </Field>
          </Section>

          <Section title="Company details" icon={Building2}>
            <Field id="inq-company" label="Company Name" required error={errors.companyName}>
              <input
                type="text" className="jc-input" value={form.companyName} autoComplete="organization"
                onChange={e => setField('companyName', e.target.value)}
                placeholder="e.g. Shakti Industries Pvt Ltd" maxLength={150}
              />
            </Field>

            <Field id="inq-gstin" label="GST Number" error={errors.gstin} hint="Optional — only if you need a GST invoice">
              <input
                type="text" className="jc-input uppercase" value={form.gstin}
                onChange={e => setField('gstin', e.target.value.toUpperCase())}
                placeholder="24AAAAA0000A1Z5" maxLength={15}
              />
            </Field>

            <Field id="inq-address" label="Site Address" required error={errors.address} hint="Where the equipment or service is needed">
              <textarea
                className="jc-input py-2.5 resize-none" rows={3} value={form.address}
                onChange={e => setField('address', e.target.value)}
                placeholder="Building / street, area, city, pin code"
                maxLength={500} style={{ minHeight: '76px' }}
              />
            </Field>
          </Section>

          <Section title="What do you need?" icon={FileText} error={errors.requirements}>
            <div className="space-y-2">
              {requirements.map(opt => {
                const checked = form.requirements.includes(opt.key);
                return (
                  /* The whole row is the target, so it gets the full 48px from the UI standard —
                     width is free here and a checkbox alone would be a cruel target in gloves. */
                  <label
                    key={opt.key}
                    className="flex items-center gap-3 px-3.5 rounded-xl border-2 cursor-pointer transition-all select-none bg-white active:bg-slate-50"
                    style={{
                      minHeight: '48px',
                      // Tinted with the brand red at 6% rather than a Tailwind palette colour, so a
                      // ticked row reads as "ours" without competing with the submit button.
                      borderColor: checked ? BRAND_RED : '#e2e8f0',
                      backgroundColor: checked ? 'rgba(224,27,36,0.06)' : '#fff'
                    }}
                  >
                    <input
                      type="checkbox" checked={checked}
                      onChange={() => toggleRequirement(opt.key)}
                      className="w-5 h-5 rounded shrink-0"
                      style={{ accentColor: BRAND_RED }}
                    />
                    <span
                      className="text-[13px] font-bold leading-snug"
                      style={{ color: checked ? BRAND_INK : '#334155' }}
                    >
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Progressive disclosure: the free-text box only exists once "Other" is ticked. */}
            {form.requirements.includes('OTHER') && (
              <div className="mt-3 animate-fadeIn">
                <Field id="inq-other" label="Tell us what you need" required error={errors.otherRequirement}>
                  <textarea
                    className="jc-input py-2.5 resize-none" rows={4} value={form.otherRequirement}
                    onChange={e => setField('otherRequirement', e.target.value)}
                    placeholder="Describe your requirement — quantity, type of equipment, timeline, anything useful."
                    maxLength={1000} style={{ minHeight: '96px' }}
                  />
                </Field>
                <p className="text-[11px] text-slate-400 font-semibold text-right mt-1">
                  {form.otherRequirement.length}/1000
                </p>
              </div>
            )}
          </Section>

          {/*
            Honeypot. Positioned off-screen rather than display:none — some bots skip hidden inputs
            but fill absolutely-positioned ones. aria-hidden and tabIndex keep it away from screen
            readers and the keyboard, so no real person can reach it, while autoComplete="off"
            stops a password manager filling it and locking a genuine customer out.
          */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0, overflow: 'hidden' }}>
            <label htmlFor="website">Website (leave this empty)</label>
            <input
              id="website" name="website" type="text" tabIndex={-1} autoComplete="off"
              value={form.website} onChange={e => setField('website', e.target.value)}
            />
          </div>

          {captcha.provider === 'turnstile' && (
            <div className="mb-4 flex justify-center">
              <div ref={turnstileRef} />
            </div>
          )}

          <p className="text-[11px] text-slate-400 font-medium text-center leading-relaxed mb-4 flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            Your details are used only to respond to this enquiry.
          </p>
        </form>
      </main>

      {/* Primary action in a sticky bottom bar, padded clear of the home indicator — the pattern
          JobCardPage and ChallanBuilderPage set. */}
      <div
        className="fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-slate-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Submit alone. The phone number stays reachable in the sticky header, so nothing is lost
            by giving the one action the customer came here for the full width. */}
        <div className="max-w-2xl mx-auto px-4 py-3">
          <button
            type="button" onClick={handleSubmit} disabled={submitting}
            className="w-full flex items-center justify-center gap-2 rounded-xl text-white font-extrabold text-sm shadow-lg active:scale-[0.98] transition disabled:opacity-60"
            style={{ minHeight: '52px', backgroundColor: BRAND_RED }}
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
              : <><Send className="w-4 h-4" /> Submit Enquiry</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A titled card. Sections are short enough here that the collapsing behaviour would only add taps. */
function Section({ title, icon: Icon, error, children }) {
  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 shrink-0" style={{ color: BRAND_RED }} />}
        <h3 className="text-[13px] font-extrabold text-slate-700">{title}</h3>
      </div>
      <div className="p-4 space-y-3.5">
        {children}
        {error && (
          <p className="text-[12px] font-bold text-red-600 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * One labelled input.
 *
 * `htmlFor`/`id` are wired through so tapping the label focuses the field — on a phone that
 * roughly doubles the usable target for every row at no visual cost, and it is what screen
 * readers use to announce the field at all.
 *
 * The error is bound with aria-describedby + aria-invalid and announced via role="alert", so
 * someone using a screen reader hears WHY the form refused rather than just landing on a red
 * box they cannot see. The child input is cloned to receive these — cheaper than threading the
 * same four props through every call site by hand.
 */
function Field({ id, label, required, error, hint, children }) {
  const describedBy = error ? `${id}-error` : (hint ? `${id}-hint` : undefined);

  const control = React.isValidElement(children)
    ? React.cloneElement(children, {
        id,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': describedBy,
        'aria-required': required ? 'true' : undefined,
        // A red ring on the field itself, not only on the message below it: on a long form the
        // message can sit off-screen while the offending input is in view.
        className: `${children.props.className || ''}${error ? ' !border-red-400 ring-2 ring-red-100' : ''}`
      })
    : children;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wide mb-1.5"
      >
        {label}{required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
      {control}
      {error
        ? (
          <p id={`${id}-error`} role="alert" className="text-[12px] font-bold text-red-600 mt-1.5 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
          </p>
        )
        : hint
          ? <p id={`${id}-hint`} className="text-[11px] text-slate-400 font-medium mt-1.5">{hint}</p>
          : null}
    </div>
  );
}

/**
 * Post-submission confirmation.
 *
 * Shows the reference number, a read-back of everything the customer submitted, and the two ways
 * to reach us.
 *
 * The read-back matters more than it looks: a customer who mistyped their own mobile number has no
 * other way to discover it — our follow-up call would simply never arrive and they would assume we
 * ignored them. Seeing their details on screen is the only chance to catch that, which is why the
 * WhatsApp message below is pre-filled with the reference number: correcting a typo becomes one tap
 * rather than a phone call they have to explain from scratch.
 *
 * `submitted` is the form snapshot taken at send time, not re-read from state, so the panel keeps
 * showing what was actually sent even after the form is reset behind it.
 */
function SuccessPanel({ result, submitted, requirementLabels, onReset }) {
  const waText = encodeURIComponent(
    `Hello Expert Safety Solutions, I have submitted an enquiry${result.inquiryNo ? ` (${result.inquiryNo})` : ''}. My name is ${submitted?.name || ''}.`
  );

  const rows = [
    ['Name', submitted?.name],
    ['Mobile', submitted?.mobile ? `+91 ${submitted.mobile}` : ''],
    ['Email', submitted?.email],
    ['Company', submitted?.companyName],
    ['GST No', submitted?.gstin],
    ['Site Address', submitted?.address]
  ].filter(([, v]) => v);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white shadow-sm" style={{ borderBottom: `3px solid ${BRAND_RED}` }}>
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-center">
          <img
            src="/logo.jpg" alt="Expert Safety Solutions"
            className="h-10 sm:h-12 w-auto object-contain"
            onError={e => { e.target.style.display = 'none'; }}
          />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 pb-10">
        <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden animate-fadeIn">
          <div className="px-5 py-7 text-center border-b border-slate-100">
            <div className="w-16 h-16 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-xl font-extrabold mb-2" style={{ color: BRAND_INK }}>
              Thank you{submitted?.name ? `, ${submitted.name.split(' ')[0]}` : ''}!
            </h2>
            <p className="text-[13px] text-slate-500 font-medium leading-relaxed">
              {result.message || 'We have received your enquiry and our team will contact you shortly.'}
            </p>

            {result.inquiryNo && (
              <div
                className="mt-5 rounded-xl px-4 py-3.5"
                style={{ backgroundColor: 'rgba(224,27,36,0.06)', border: `1.5px solid ${BRAND_RED}` }}
              >
                <div className="text-[10px] font-extrabold uppercase tracking-wider mb-1" style={{ color: BRAND_RED_DARK }}>
                  Your reference number
                </div>
                <div className="text-xl font-extrabold tracking-wide" style={{ color: BRAND_INK }}>
                  {result.inquiryNo}
                </div>
                <p className="text-[11px] font-semibold mt-1.5" style={{ color: BRAND_RED_DARK }}>
                  Please quote this when you contact us.
                </p>
              </div>
            )}
          </div>

          {rows.length > 0 && (
            <div className="px-5 py-5 border-b border-slate-100">
              <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-slate-400 mb-3">
                Details you submitted
              </h3>
              <dl className="space-y-2.5">
                {rows.map(([label, value]) => (
                  <div key={label} className="flex gap-3">
                    <dt className="text-[11px] font-bold text-slate-400 uppercase tracking-wide w-24 shrink-0 pt-0.5">
                      {label}
                    </dt>
                    <dd className="text-[13px] font-bold flex-1 break-words" style={{ color: BRAND_INK }}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {requirementLabels?.length > 0 && (
                <div className="mt-4">
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wide mb-2">
                    Requirements
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {requirementLabels.map(label => (
                      <span
                        key={label}
                        className="text-[11.5px] font-bold px-2.5 py-1 rounded-full"
                        style={{
                          backgroundColor: 'rgba(224,27,36,0.06)',
                          border: `1px solid ${BRAND_RED}`,
                          color: BRAND_RED_DARK
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {submitted?.otherRequirement && (
                <p className="mt-3 text-[12.5px] text-slate-600 font-medium leading-relaxed whitespace-pre-wrap border-l-2 pl-3" style={{ borderColor: BRAND_RED }}>
                  {submitted.otherRequirement}
                </p>
              )}

              <p className="mt-4 text-[11px] text-slate-400 font-medium leading-relaxed">
                A copy of these details has been emailed to you. If anything above is wrong, message
                us on WhatsApp and we will correct it.
              </p>
            </div>
          )}

          <div className="px-5 py-5">
            <h3 className="text-[11px] font-extrabold uppercase tracking-wide text-slate-400 mb-3 text-center">
              Need to reach us now?
            </h3>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <a
                href={`tel:+${OFFICE_PHONE_E164}`}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl text-white font-extrabold text-sm active:scale-[0.98] transition"
                style={{ minHeight: '52px', backgroundColor: BRAND_RED }}
              >
                <Phone className="w-4 h-4" /> Call Us
              </a>
              <a
                href={`https://wa.me/${OFFICE_PHONE_E164}?text=${waText}`}
                target="_blank" rel="noopener noreferrer"
                className="flex-1 flex items-center justify-center gap-2 rounded-xl text-white font-extrabold text-sm active:scale-[0.98] transition"
                style={{ minHeight: '52px', backgroundColor: '#25D366' }}
              >
                <MessageCircle className="w-4 h-4" /> WhatsApp
              </a>
            </div>
            <p className="text-center text-[11.5px] font-bold text-slate-400 mt-3">
              {OFFICE_PHONE_DISPLAY}
            </p>
          </div>
        </div>

        <div className="text-center mt-5">
          <button
            type="button" onClick={onReset}
            className="text-[12px] font-bold text-slate-400 hover:text-slate-600 transition py-2 px-4"
          >
            Submit another enquiry
          </button>
        </div>
      </main>
    </div>
  );
}
