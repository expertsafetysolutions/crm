import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Plus, Trash2, AlertTriangle, CheckCircle2, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Admin screen for extinguisher categories and the inward checkpoints each one carries.
 *
 * The API for this has existed since the workshop module shipped, with no screen behind it — the
 * only way to add Foam or Clean Agent was to call it by hand. Adding a category is a business
 * change, not a deployment, so it belongs here.
 *
 * Two things are immutable once a category is in use, and both are enforced visually as well as by
 * the server:
 *
 *   Code           stored on every Job_Card_Item as Equipment_Type. Renaming it orphans the history.
 *   Checkpoint id  becomes a key on Job_Card_Item.Inward_Checkpoints. Renaming it strands every
 *                  recorded OK / NOT OK under a key nothing reads any more.
 *
 * Labels are free to change — that is the point of separating them from ids.
 */
export default function EquipmentCategoriesPage() {
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState('');
  const [msg, setMsg] = useState(null);
  const [dirty, setDirty] = useState({});

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const flash = (text, kind = 'ok') => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 6000); };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/equipment-categories?includeInactive=true', { headers });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not load categories');
        setCategories(await res.json());
      } catch (e) {
        flash(e.message, 'err');
      } finally { setLoading(false); }
    })();
  }, [token]);

  const patch = (id, changes) => {
    setCategories(list => list.map(c => (c.Category_ID === id ? { ...c, ...changes } : c)));
    setDirty(d => ({ ...d, [id]: true }));
  };

  const patchCheckpoint = (id, index, changes) => {
    setCategories(list => list.map(c => {
      if (c.Category_ID !== id) return c;
      const next = [...(c.Checkpoints || [])];
      next[index] = { ...next[index], ...changes };
      return { ...c, Checkpoints: next };
    }));
    setDirty(d => ({ ...d, [id]: true }));
  };

  const addCheckpoint = (id) => {
    setCategories(list => list.map(c => {
      if (c.Category_ID !== id) return c;
      const next = [...(c.Checkpoints || [])];
      next.push({ id: '', label: '', order: next.length + 1, isNew: true });
      return { ...c, Checkpoints: next };
    }));
    setDirty(d => ({ ...d, [id]: true }));
  };

  const removeCheckpoint = (id, index) => {
    const cat = categories.find(c => c.Category_ID === id);
    const cp = cat?.Checkpoints?.[index];
    if (!cp?.isNew && !window.confirm(
      `Remove "${cp?.label || cp?.id}"?\n\nJob cards already inspected keep their recorded result for this checkpoint — it simply stops being shown on new ones.`
    )) return;
    setCategories(list => list.map(c => (
      c.Category_ID === id ? { ...c, Checkpoints: c.Checkpoints.filter((_, n) => n !== index) } : c
    )));
    setDirty(d => ({ ...d, [id]: true }));
  };

  const save = async (cat) => {
    const blank = (cat.Checkpoints || []).find(c => !String(c.id || '').trim() || !String(c.label || '').trim());
    if (blank) return flash('Every checkpoint needs both an id and a label.', 'err');

    const ids = (cat.Checkpoints || []).map(c => c.id.trim());
    if (new Set(ids).size !== ids.length) return flash('Two checkpoints share the same id.', 'err');

    setSavingId(cat.Category_ID);
    try {
      const isNew = !!cat.isNew;
      const res = await fetch(isNew ? '/api/equipment-categories' : `/api/equipment-categories/${cat.Category_ID}`, {
        method: isNew ? 'POST' : 'PUT',
        headers,
        body: JSON.stringify({
          code: cat.Code, label: cat.Label, description: cat.Description,
          capacities: String(cat.Capacities_Text ?? (cat.Capacities || []).join(', '))
            .split(',').map(s => s.trim()).filter(Boolean),
          checkpoints: (cat.Checkpoints || []).map(({ isNew: _drop, ...c }) => ({
            ...c, id: c.id.trim(), order: Number(c.order) || 0
          })),
          requiresWeight: Boolean(cat.Requires_Weight),
          active: cat.Active !== false,
          sortOrder: Number(cat.Sort_Order) || 0
        })
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Save failed');
      setCategories(list => list.map(c => (c.Category_ID === cat.Category_ID ? { ...out, Capacities_Text: undefined } : c)));
      setDirty(d => ({ ...d, [cat.Category_ID]: false }));
      flash(`${cat.Label || cat.Code} saved.`);
    } catch (e) {
      flash(e.message, 'err');
    } finally { setSavingId(''); }
  };

  const addCategory = () => {
    const draft = {
      Category_ID: `draft-${Date.now()}`,
      Code: '', Label: '', Description: '', Capacities: [], Checkpoints: [],
      Requires_Weight: false, Active: true, Sort_Order: categories.length + 1, isNew: true
    };
    setCategories(list => [...list, draft]);
    setDirty(d => ({ ...d, [draft.Category_ID]: true }));
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-50 px-6 text-center">
        <Lock className="w-8 h-8 text-slate-300" />
        <p className="text-sm font-bold text-slate-600">Only an Admin can change equipment categories.</p>
        <button onClick={() => navigate('/')} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold">Go back</button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500 font-bold text-sm animate-pulse">Loading categories…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 active:bg-slate-100 rounded-lg" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold truncate">Equipment Categories</h1>
            <div className="text-[11px] text-slate-500">Types and their inward inspection checkpoints</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-start gap-2 ${msg.kind === 'err' ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
            {msg.kind === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}

        <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2.5 rounded-xl text-xs">
          Checkpoints appear on the job card inward tab for this type. A checkpoint's <b>id</b> and a
          category's <b>code</b> are fixed once saved, because existing job cards are stored against
          them — rename the <b>label</b> instead, which is what technicians actually read.
        </div>

        {categories.map(cat => (
          <div key={cat.Category_ID} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-sm truncate">{cat.Label || cat.Code || 'New category'}</div>
                <div className="text-[11px] text-slate-500">
                  {(cat.Checkpoints || []).length} checkpoints
                  {cat.Active === false && <span className="text-amber-600 font-bold"> · inactive</span>}
                </div>
              </div>
              {dirty[cat.Category_ID] && (
                <button onClick={() => save(cat)} disabled={savingId === cat.Category_ID}
                  className="px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 disabled:opacity-50 shrink-0">
                  {savingId === cat.Category_ID ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save
                </button>
              )}
            </div>

            <div className="px-4 py-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
                    Code {!cat.isNew && <span className="text-slate-300">· fixed</span>}
                  </span>
                  <input className="jc-input" value={cat.Code || ''} disabled={!cat.isNew}
                    onChange={e => patch(cat.Category_ID, { Code: e.target.value.toUpperCase() })}
                    placeholder="FOAM" />
                </label>
                <label className="block">
                  <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Label</span>
                  <input className="jc-input" value={cat.Label || ''}
                    onChange={e => patch(cat.Category_ID, { Label: e.target.value })}
                    placeholder="Foam Type" />
                </label>
              </div>

              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">Capacities</span>
                <input className="jc-input" placeholder="6 Kg, 9 Kg, 50 Kg"
                  value={cat.Capacities_Text ?? (cat.Capacities || []).join(', ')}
                  onChange={e => patch(cat.Category_ID, { Capacities_Text: e.target.value })} />
              </label>

              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
                  <input type="checkbox" className="w-4 h-4" checked={Boolean(cat.Requires_Weight)}
                    onChange={e => patch(cat.Category_ID, { Requires_Weight: e.target.checked })} />
                  Capture weight (no pressure gauge)
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-600">
                  <input type="checkbox" className="w-4 h-4" checked={cat.Active !== false}
                    onChange={e => patch(cat.Category_ID, { Active: e.target.checked })} />
                  Active
                </label>
              </div>

              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-1">Inward checkpoints</div>
                <div className="space-y-1.5">
                  {(cat.Checkpoints || []).map((cp, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input className="jc-input flex-1" value={cp.label || ''} placeholder="Pressure Gauge"
                        onChange={e => patchCheckpoint(cat.Category_ID, i, { label: e.target.value })} />
                      <input
                        className={`jc-input w-32 ${cp.isNew ? '' : 'bg-slate-50 text-slate-400'}`}
                        value={cp.id || ''} disabled={!cp.isNew} placeholder="pressureGauge"
                        title={cp.isNew ? 'Used as the storage key — pick carefully, it cannot change later' : 'Fixed: job cards are stored against this id'}
                        onChange={e => patchCheckpoint(cat.Category_ID, i, { id: e.target.value.replace(/\s/g, '') })} />
                      <button onClick={() => removeCheckpoint(cat.Category_ID, i)} aria-label="Remove checkpoint"
                        className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-slate-400 active:bg-rose-50 active:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={() => addCheckpoint(cat.Category_ID)}
                  className="jc-btn-ghost w-full mt-1.5 border border-dashed border-slate-300 rounded-xl">
                  <Plus className="w-3.5 h-3.5" /> Add checkpoint
                </button>
              </div>
            </div>
          </div>
        ))}

        <button onClick={addCategory}
          className="w-full min-h-[48px] rounded-xl border-2 border-dashed border-slate-300 text-sm font-bold text-slate-500 active:bg-slate-100 flex items-center justify-center gap-2">
          <Plus className="w-4 h-4" /> Add category
        </button>
      </div>
    </div>
  );
}
