import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, User, AlertCircle, Eye, EyeOff } from 'lucide-react';

export default function Login() {
  const { login } = useAuth();
  const [staffId, setStaffId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const savedId = localStorage.getItem('expert_safety_remembered_id');
    const savedPass = localStorage.getItem('expert_safety_remembered_pass');
    if (savedId && savedPass) {
      setStaffId(savedId);
      setPassword(savedPass);
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
        localStorage.setItem('expert_safety_remembered_pass', password);
      } else {
        localStorage.removeItem('expert_safety_remembered_id');
        localStorage.removeItem('expert_safety_remembered_pass');
      }
      await login(staffId, password);
    } catch (err) {
      setError(err.message || 'Login failed. Check your credentials.');
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
                <span>Remember Password</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white font-bold text-sm shadow-md shadow-rose-600/20 flex items-center justify-center transition transform active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
