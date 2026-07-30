import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, User, AlertCircle, Eye, EyeOff, ShieldCheck } from 'lucide-react';

export default function Login() {
  const { login, verifyOtp } = useAuth();
  const [staffId, setStaffId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // One screen, four states: the password form, the new-device code prompt, and the two steps of
  // the forgot-password flow. Kept as a single `view` rather than separate booleans so two panels
  // can never be shown at once.
  const [view, setView] = useState('LOGIN');   // LOGIN | OTP | FORGOT | RESET
  const [otpCode, setOtpCode] = useState('');
  const [otpMessage, setOtpMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [resetForm, setResetForm] = useState({ code: '', newPassword: '', confirmPassword: '' });
  const [showResetPassword, setShowResetPassword] = useState(false);

  // Resend is rate-limited in the UI as well as on the server. A visible countdown is the honest
  // way to do it: a button that silently does nothing reads as broken, and repeated clicks would
  // invalidate the code the user is already holding (each new code supersedes the last).
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const resetToLogin = () => {
    setView('LOGIN');
    setError(''); setNotice(''); setOtpCode(''); setOtpMessage('');
    setResetForm({ code: '', newPassword: '', confirmPassword: '' });
  };

  // Only the staff ID is remembered — never the password. This used to persist the password in
  // cleartext, which any XSS, shared handset or browser-profile copy would have handed over.
  // The removeItem is not redundant: without it every device where the box was ever ticked would
  // keep its old plaintext password forever, since nothing else ever clears that key.
  useEffect(() => {
    localStorage.removeItem('expert_safety_remembered_pass');
    const savedId = localStorage.getItem('expert_safety_remembered_id');
    if (savedId) {
      setStaffId(savedId);
      setRememberPassword(true);
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (rememberPassword) {
        localStorage.setItem('expert_safety_remembered_id', staffId);
      } else {
        localStorage.removeItem('expert_safety_remembered_id');
      }
      const result = await login(staffId, password);
      // An unrecognised browser: the password was right, but the server wants the emailed code.
      if (result && result.otpRequired) {
        setOtpMessage(result.message || '');
        setView('OTP');
      }
    } catch (err) {
      setError(err.message || 'Login failed. Check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Resends the code for whichever flow is active.
   *
   * New-device codes are re-issued by simply attempting the login again — the server answers 202
   * and sends a fresh code, so there is no separate endpoint to maintain. Reset codes go back
   * through /forgot-password. Either way the previous code stops working, which is why the
   * cooldown matters.
   */
  const handleResend = async () => {
    if (resendIn > 0 || loading) return;
    setError(''); setNotice('');
    setLoading(true);
    try {
      if (view === 'OTP') {
        await login(staffId, password);
        setOtpCode('');
        setNotice('A new code has been emailed to the administrator. The previous code no longer works.');
      } else {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ staffId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not resend the code');
        setResetForm({ ...resetForm, code: '' });
        setNotice('A new code has been emailed to the administrator. The previous code no longer works.');
      }
      setResendIn(30);
    } catch (err) {
      setError(err.message || 'Could not resend the code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // The password is sent again alongside the code — the server requires both, so a code alone
      // is never enough to open a session.
      await verifyOtp(staffId, password, otpCode.trim());
    } catch (err) {
      setError(err.message || 'That code is not correct.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotRequest = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send the reset code');
      setNotice(data.message || 'If that Staff ID exists, a code has been emailed to the administrator.');
      setView('RESET');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId, ...resetForm })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not reset the password');
      resetToLogin();
      setNotice('Password updated. You can sign in with your new password.');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-slate-200 flex flex-col justify-center py-12 sm:px-6 lg:px-8 px-4 relative overflow-hidden">
      {/* Fire Safety Warrior Transparent Background Watermark across screen */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-10 z-0">
        <img src="/fire-safety-warrior.png" alt="Fire Safety Warrior Background" className="w-[750px] h-[750px] object-contain select-none mix-blend-multiply" />
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center relative z-10">
        <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-white shadow-lg shadow-slate-200 mb-4 border border-slate-200">
          <img src="/logo.jpg" alt="Expert Safety Solutions Logo" className="h-16 w-auto object-contain" />
        </div>
        <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
          Expert Safety Solutions
        </h2>
        <p className="mt-2 text-sm text-slate-600 font-medium">
          CRM System
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md relative z-10">
        <div className="bg-white/95 backdrop-blur-md border border-slate-200/80 py-8 px-6 shadow-xl shadow-slate-200/60 rounded-2xl sm:px-10 relative overflow-hidden">
          {/* Card subtle warrior watermark */}
          <div className="absolute -right-16 -bottom-16 w-64 h-64 opacity-[0.06] pointer-events-none select-none">
            <img src="/fire-safety-warrior.png" alt="Warrior Watermark" className="w-full h-full object-contain" />
          </div>

          {/* Rendered outside the view switch so a success message survives returning to LOGIN. */}
          {notice && (
            <div className="mb-4 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium relative z-10">
              {notice}
            </div>
          )}

          {view === 'LOGIN' && (
          <form className="space-y-5 relative z-10" onSubmit={handleSubmit}>
            {error && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2.5 text-rose-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1.5">
                Staff ID
              </label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  placeholder="e.g. STAFF001"
                  className="block w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent text-sm font-medium transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1.5">
                Password
              </label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full pl-10 pr-11 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent text-sm font-medium transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 focus:outline-none transition cursor-pointer"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4 text-slate-600" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(e) => setRememberPassword(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500 transition cursor-pointer"
                />
                <span>Remember Staff ID</span>
              </label>

              <button
                type="button"
                onClick={() => { setError(''); setNotice(''); setView('FORGOT'); }}
                className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline transition"
              >
                Forgot password?
              </button>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-sm shadow-md shadow-rose-600/20 flex items-center justify-center transition transform active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
          )}

          {/* NEW-DEVICE CODE ------------------------------------------------------------- */}
          {view === 'OTP' && (
          <form className="space-y-5 relative z-10" onSubmit={handleVerifyOtp}>
            <div className="text-center">
              <ShieldCheck className="w-9 h-9 text-rose-600 mx-auto mb-2" />
              <h3 className="text-base font-extrabold text-slate-900">New device detected</h3>
              <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                {otpMessage || 'A verification code has been emailed to the administrator. Ask them for it.'}
              </p>
            </div>

            {error && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2.5 text-rose-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1.5">
                6-digit code
              </label>
              <input
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-300 text-center text-2xl font-bold tracking-[0.4em] focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent transition"
              />
              <p className="mt-1.5 text-[11px] text-slate-500 font-medium">Expires in 10 minutes.</p>
            </div>

            <button
              type="submit"
              disabled={loading || otpCode.length !== 6}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-sm shadow-md shadow-rose-600/20 transition active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify & Sign In'}
            </button>

            <div className="flex items-center justify-between">
              <button type="button" onClick={resetToLogin} className="text-xs font-semibold text-slate-500 hover:text-slate-700 transition">
                Back to sign in
              </button>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendIn > 0 || loading}
                className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline transition disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
          )}

          {/* FORGOT PASSWORD — request a code -------------------------------------------- */}
          {view === 'FORGOT' && (
          <form className="space-y-5 relative z-10" onSubmit={handleForgotRequest}>
            <div className="text-center">
              <Lock className="w-9 h-9 text-rose-600 mx-auto mb-2" />
              <h3 className="text-base font-extrabold text-slate-900">Reset your password</h3>
              <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
                A code will be emailed to the administrator. Ask them for it, then set a new password here.
              </p>
            </div>

            {error && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2.5 text-rose-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1.5">Staff ID</label>
              <div className="relative rounded-xl shadow-sm">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  value={staffId}
                  onChange={(e) => setStaffId(e.target.value)}
                  placeholder="e.g. STAFF001"
                  className="block w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-transparent text-sm font-medium transition"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-sm shadow-md shadow-rose-600/20 transition active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send Reset Code'}
            </button>

            <button type="button" onClick={resetToLogin} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-700 transition">
              Back to sign in
            </button>
          </form>
          )}

          {/* FORGOT PASSWORD — enter code + new password --------------------------------- */}
          {view === 'RESET' && (
          <form className="space-y-4 relative z-10" onSubmit={handleResetPassword}>
            <div className="text-center">
              <ShieldCheck className="w-9 h-9 text-rose-600 mx-auto mb-2" />
              <h3 className="text-base font-extrabold text-slate-900">Enter the code</h3>
              <p className="mt-1.5 text-xs text-slate-600">Then choose a new password for <b>{staffId}</b>.</p>
            </div>

            {error && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2.5 text-rose-700 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>{error}</span>
              </div>
            )}

            <input
              type="text"
              required
              inputMode="numeric"
              maxLength={6}
              value={resetForm.code}
              onChange={(e) => setResetForm({ ...resetForm, code: e.target.value.replace(/\D/g, '') })}
              placeholder="000000"
              className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-300 text-center text-xl font-bold tracking-[0.35em] focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 transition"
            />

            {/* One toggle drives both fields: revealing only one of a password/confirm pair makes
                a mismatch harder to spot, not easier. */}
            <div className="relative rounded-xl">
              <input
                type={showResetPassword ? 'text' : 'password'}
                required
                autoComplete="new-password"
                value={resetForm.newPassword}
                onChange={(e) => setResetForm({ ...resetForm, newPassword: e.target.value })}
                placeholder="New password"
                className="block w-full pl-4 pr-11 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 text-sm font-medium transition"
              />
              <button
                type="button"
                onClick={() => setShowResetPassword(!showResetPassword)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-600 transition"
                title={showResetPassword ? 'Hide password' : 'Show password'}
              >
                {showResetPassword ? <EyeOff className="w-4 h-4 text-slate-600" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <input
              type={showResetPassword ? 'text' : 'password'}
              required
              autoComplete="new-password"
              value={resetForm.confirmPassword}
              onChange={(e) => setResetForm({ ...resetForm, confirmPassword: e.target.value })}
              placeholder="Confirm new password"
              className="block w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 text-sm font-medium transition"
            />

            {/* Immediate mismatch feedback — better than discovering it after a round trip. */}
            {resetForm.confirmPassword && resetForm.newPassword !== resetForm.confirmPassword && (
              <p className="text-[11px] font-semibold text-rose-600">Passwords do not match.</p>
            )}

            <p className="text-[11px] text-slate-500 font-medium">
              Min 8 characters, with at least one letter, one number &amp; one special character.
            </p>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-sm shadow-md shadow-rose-600/20 transition active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Updating...' : 'Set New Password'}
            </button>

            <div className="flex items-center justify-between">
              <button type="button" onClick={resetToLogin} className="text-xs font-semibold text-slate-500 hover:text-slate-700 transition">
                Back to sign in
              </button>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendIn > 0 || loading}
                className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline transition disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
              >
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </button>
            </div>
          </form>
          )}
        </div>
      </div>
    </div>
  );
}
