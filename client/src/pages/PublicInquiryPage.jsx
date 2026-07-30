import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Flame, Phone, MessageCircle, Building2, FileText, User,
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

  if (result) return <SuccessPanel result={result} onReset={() => {
    setForm(EMPTY_FORM);
    setResult(null);
    setErrors({});
    renderedAtRef.current = Date.now();
    captchaTokenRef.current = '';
  }} />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 bg-gradient-to-r from-orange-800 to-orange-600 text-white shadow-lg">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
            <Flame className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base sm:text-lg font-extrabold leading-tight truncate">
              Expert Safety Solutions
            </h1>
            <p className="text-[11px] sm:text-xs font-semibold text-orange-100">
              Fire Safety Equipment &amp; Services
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 pb-32">
        <div ref={formTopRef} className="mb-5">
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-800">Send us your enquiry</h2>
          <p className="text-[13px] text-slate-500 font-medium mt-1 leading-relaxed">
            Fill this in and our team will get back to you shortly. No OTP needed — it takes under a
            minute.
          </p>
        </div>

        {serverError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex gap-2.5 animate-fadeIn">
            <AlertCircle className="w-4.5 h-4.5 text-red-600 shrink-0 mt-0.5" />
            <p className="text-[13px] font-semibold text-red-800 leading-relaxed">{serverError}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <Section title="Your details" icon={User}>
            <Field label="Your Name" required error={errors.name}>
              <input
                type="text" className="jc-input" value={form.name} autoComplete="name"
                onChange={e => setField('name', e.target.value)}
                placeholder="e.g. Ramesh Patel" maxLength={100}
              />
            </Field>

            <Field label="Mobile Number" required error={errors.mobile} hint="We will call or WhatsApp you on this number">
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

            <Field label="Email ID" required error={errors.email} hint="Your confirmation and quotation go here">
              <input
                type="email" className="jc-input" value={form.email} autoComplete="email"
                onChange={e => setField('email', e.target.value)}
                placeholder="you@company.com" maxLength={254}
              />
            </Field>
          </Section>

          <Section title="Company details" icon={Building2}>
            <Field label="Company Name" required error={errors.companyName}>
              <input
                type="text" className="jc-input" value={form.companyName} autoComplete="organization"
                onChange={e => setField('companyName', e.target.value)}
                placeholder="e.g. Shakti Industries Pvt Ltd" maxLength={150}
              />
            </Field>

            <Field label="GST Number" error={errors.gstin} hint="Optional — only if you need a GST invoice">
              <input
                type="text" className="jc-input uppercase" value={form.gstin}
                onChange={e => setField('gstin', e.target.value.toUpperCase())}
                placeholder="24AAAAA0000A1Z5" maxLength={15}
              />
            </Field>

            <Field label="Site Address" required error={errors.address} hint="Where the equipment or service is needed">
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
                    className={`flex items-center gap-3 px-3.5 rounded-xl border-2 cursor-pointer transition-all select-none ${
                      checked
                        ? 'border-orange-500 bg-orange-50'
                        : 'border-slate-200 bg-white active:bg-slate-50'
                    }`}
                    style={{ minHeight: '48px' }}
                  >
                    <input
                      type="checkbox" checked={checked}
                      onChange={() => toggleRequirement(opt.key)}
                      className="w-5 h-5 rounded accent-orange-600 shrink-0"
                    />
                    <span className={`text-[13px] font-bold leading-snug ${checked ? 'text-orange-900' : 'text-slate-700'}`}>
                      {opt.label}
                    </span>
                  </label>
                );
              })}
            </div>

            {/* Progressive disclosure: the free-text box only exists once "Other" is ticked. */}
            {form.requirements.includes('OTHER') && (
              <div className="mt-3 animate-fadeIn">
                <Field label="Tell us what you need" required error={errors.otherRequirement}>
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
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <a
            href={`tel:+${OFFICE_PHONE_E164}`}
            className="flex items-center justify-center gap-2 px-4 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-[13px] active:scale-95 transition shrink-0"
            style={{ minHeight: '48px' }}
          >
            <Phone className="w-4 h-4" />
            <span className="hidden xs:inline">Call</span>
          </a>
          <button
            type="button" onClick={handleSubmit} disabled={submitting}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-orange-700 text-white font-extrabold text-sm shadow-lg active:scale-[0.98] transition disabled:opacity-60"
            style={{ minHeight: '48px' }}
          >
            {submitting
              ? <><Loader2 className="w-4.5 h-4.5 animate-spin" /> Sending…</>
              : <><Send className="w-4.5 h-4.5" /> Submit Enquiry</>}
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
        {Icon && <Icon className="w-4 h-4 text-orange-700 shrink-0" />}
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

function Field({ label, required, error, hint, children }) {
  return (
    <div>
      <label className="block text-[11px] font-extrabold text-slate-500 uppercase tracking-wide mb-1.5">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {error
        ? (
          <p className="text-[12px] font-bold text-red-600 mt-1.5 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
          </p>
        )
        : hint
          ? <p className="text-[11px] text-slate-400 font-medium mt-1.5">{hint}</p>
          : null}
    </div>
  );
}

/**
 * Post-submission confirmation.
 *
 * Shows the inquiry number prominently: it is what the customer quotes on the phone, and the only
 * thing they can act on if our follow-up is slow.
 */
function SuccessPanel({ result, onReset }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 text-center animate-fadeIn">
        <div className="w-16 h-16 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-8 h-8 text-emerald-600" />
        </div>

        <h2 className="text-xl font-extrabold text-slate-800 mb-2">Enquiry received</h2>
        <p className="text-[13px] text-slate-500 font-medium leading-relaxed mb-5">
          {result.message || 'Thank you. Our team will contact you shortly.'}
        </p>

        {result.inquiryNo && (
          <div className="rounded-xl bg-orange-50 border border-orange-200 px-4 py-3.5 mb-5">
            <div className="text-[10px] font-extrabold text-orange-700 uppercase tracking-wider mb-1">
              Your reference number
            </div>
            <div className="text-lg font-extrabold text-orange-900 tracking-wide">{result.inquiryNo}</div>
            <p className="text-[11px] text-orange-700/80 font-semibold mt-1.5">
              Please quote this when you call us.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          <a
            href={`tel:+${OFFICE_PHONE_E164}`}
            className="flex items-center justify-center gap-2 rounded-xl bg-orange-700 text-white font-extrabold text-sm active:scale-[0.98] transition"
            style={{ minHeight: '48px' }}
          >
            <Phone className="w-4 h-4" /> Call {OFFICE_PHONE_DISPLAY}
          </a>
          <a
            href={`https://wa.me/${OFFICE_PHONE_E164}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl border-2 border-emerald-500 text-emerald-700 font-extrabold text-sm active:scale-[0.98] transition"
            style={{ minHeight: '48px' }}
          >
            <MessageCircle className="w-4 h-4" /> WhatsApp us
          </a>
          <button
            type="button" onClick={onReset}
            className="text-[12px] font-bold text-slate-400 hover:text-slate-600 transition mt-1 py-2"
          >
            Submit another enquiry
          </button>
        </div>
      </div>
    </div>
  );
}
