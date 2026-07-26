import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Save, Shield, CheckCircle2, AlertTriangle,
  FileText, Package, Users
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Admin screen for per-staff module access.
 *
 * The rest of the app gates routes on role alone, which is all-or-nothing. Quotation and Inventory
 * need finer control — e.g. a store-keeper who updates stock daily but must never see quotations,
 * and several such staff sharing the same store.
 *
 * Any write permission implies view (the server enforces the same rule), because being able to add
 * stock while the module stays hidden would be meaningless.
 */
const MODULE_META = {
  quotation: { label: 'Quotation', icon: FileText, hint: 'Create and send quotations, PIs and invoices' },
  inventory: { label: 'Inventory & Items', icon: Package, hint: 'Item master, stock inward, daily usage' }
};

const ACTIONS = [
  { key: 'view', label: 'View' },
  { key: 'add', label: 'Add' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' }
];

const PRESETS = {
  none: { view: false, add: false, edit: false, delete: false },
  view: { view: true, add: false, edit: false, delete: false },
  entry: { view: true, add: true, edit: true, delete: false },
  full: { view: true, add: true, edit: true, delete: true }
};

export default function StaffPermissionsPage() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';

  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [msg, setMsg] = useState(null);
  const [dirty, setDirty] = useState({});

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const flash = (text, kind = 'ok') => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 6000); };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/staff-permissions', { headers });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load staff');
        const data = await res.json();
        setStaff(data.staff || []);
      } catch (e) {
        flash(e.message, 'err');
      } finally { setLoading(false); }
    })();
  }, [token]);

  const setPerm = (staffId, moduleName, action, value) => {
    setStaff(list => list.map(s => {
      if (s.Staff_ID !== staffId) return s;
      const next = structuredClone(s.permissions);
      next[moduleName][action] = value;
      // Mirror the server rule so the UI never shows an impossible combination.
      if (next[moduleName].add || next[moduleName].edit || next[moduleName].delete) next[moduleName].view = true;
      return { ...s, permissions: next };
    }));
    setDirty(d => ({ ...d, [staffId]: true }));
  };

  const applyPreset = (staffId, moduleName, preset) => {
    setStaff(list => list.map(s => {
      if (s.Staff_ID !== staffId) return s;
      const next = structuredClone(s.permissions);
      next[moduleName] = { ...PRESETS[preset] };
      return { ...s, permissions: next };
    }));
    setDirty(d => ({ ...d, [staffId]: true }));
  };

  const save = async (member) => {
    setSavingId(member.Staff_ID);
    try {
      const res = await fetch(`/api/staff-permissions/${member.Staff_ID}`, {
        method: 'PUT', headers, body: JSON.stringify({ permissions: member.permissions })
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Save failed');
      setDirty(d => ({ ...d, [member.Staff_ID]: false }));
      flash(`Permissions saved for ${member.Name}.`);
    } catch (e) {
      flash(e.message, 'err');
    } finally { setSavingId(''); }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="text-center text-slate-500">
          <Shield className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <div className="font-bold">Admin access required</div>
          <button onClick={() => navigate('/')} className="mt-3 text-xs font-bold text-indigo-600">Go back</button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
    </div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 active:bg-slate-100 rounded-lg">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold truncate">Module Access</h1>
            <div className="text-[11px] text-slate-500">Quotation &amp; Inventory permissions per staff member</div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-4 space-y-3">
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-start gap-2 ${msg.kind === 'err' ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
            {msg.kind === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}

        <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2.5 rounded-xl text-xs flex items-start gap-2">
          <Users className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Admins always have full access and are not listed. Granting Add, Edit or Delete
            automatically grants View. Use <b>Stock entry</b> on Inventory for store-keepers who
            record daily stock — several staff can hold that at once.
          </span>
        </div>

        {staff.filter(s => String(s.Role || '').toLowerCase() !== 'admin').length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
            No non-Admin staff found.
          </div>
        ) : staff
          .filter(s => String(s.Role || '').toLowerCase() !== 'admin')
          .map(member => (
            <div key={member.Staff_ID} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm truncate">{member.Name}</div>
                  <div className="text-[11px] text-slate-500">
                    {member.Staff_ID} · {member.Role}
                    {!member.hasExplicitPermissions && <span className="text-slate-400"> · using role defaults</span>}
                  </div>
                </div>
                {dirty[member.Staff_ID] && (
                  <button onClick={() => save(member)} disabled={savingId === member.Staff_ID}
                    className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 disabled:opacity-50 shrink-0">
                    {savingId === member.Staff_ID ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    Save
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-100">
                {Object.entries(MODULE_META).map(([modKey, meta]) => {
                  const Icon = meta.icon;
                  const p = member.permissions?.[modKey] || PRESETS.none;
                  return (
                    <div key={modKey} className="px-4 py-3">
                      <div className="flex items-start gap-2 mb-2">
                        <Icon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-700">{meta.label}</div>
                          <div className="text-[10px] text-slate-400">{meta.hint}</div>
                        </div>
                      </div>

                      {/* Quick presets */}
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        <Preset label="No access" active={!p.view && !p.add} onClick={() => applyPreset(member.Staff_ID, modKey, 'none')} />
                        <Preset label="View only" active={p.view && !p.add && !p.edit} onClick={() => applyPreset(member.Staff_ID, modKey, 'view')} />
                        <Preset label={modKey === 'inventory' ? 'Stock entry' : 'Create & edit'} active={p.view && p.add && p.edit && !p.delete} onClick={() => applyPreset(member.Staff_ID, modKey, 'entry')} />
                        <Preset label="Full" active={p.view && p.add && p.edit && p.delete} onClick={() => applyPreset(member.Staff_ID, modKey, 'full')} />
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                        {ACTIONS.map(a => {
                          // View can't be switched off while a write permission is granted.
                          const locked = a.key === 'view' && (p.add || p.edit || p.delete);
                          return (
                            <label key={a.key}
                              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${
                                p[a.key] ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-white border-slate-200 text-slate-500'
                              } ${locked ? 'opacity-70 cursor-not-allowed' : 'active:bg-slate-50'}`}>
                              <input type="checkbox" checked={!!p[a.key]} disabled={locked}
                                onChange={e => setPerm(member.Staff_ID, modKey, a.key, e.target.checked)}
                                className="w-3.5 h-3.5" />
                              {a.label}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function Preset({ label, active, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition ${
        active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 active:bg-slate-50'
      }`}>
      {label}
    </button>
  );
}
