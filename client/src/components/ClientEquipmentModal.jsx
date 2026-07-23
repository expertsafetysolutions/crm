import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  Save,
  Search,
  Building2,
  FileSpreadsheet,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Layers,
  Calendar,
  MapPin
} from 'lucide-react';

export default function ClientEquipmentModal({
  isOpen,
  onClose,
  customer,
  token,
  onSaveSuccess
}) {
  const [equipmentList, setEquipmentList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Default Template Row
  const createDefaultRow = (srNo) => ({
    id: 'eq-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    srNo: srNo,
    location: 'Ground Floor Lobby',
    clientIdNo: `CYL-${new Date().getFullYear()}-${String(srNo).padStart(3, '0')}`,
    itemName: 'DCP ABC Type Fire Extinguisher (6 Kg)',
    mfgYear: String(new Date().getFullYear()),
    refillingDate: new Date().toISOString().split('T')[0],
    nextRefillingDate: new Date(new Date().setFullYear(new Date().getFullYear() + 1)).toISOString().split('T')[0],
    hptDate: new Date().toISOString().split('T')[0],
    hptDueDate: new Date(new Date().setFullYear(new Date().getFullYear() + 3)).toISOString().split('T')[0],
    bodyValve: 'OK',
    valve: 'OK',
    safetyPin: 'OK',
    pressureWeight: 'OK',
    hoseHorn: 'OK',
    seal: 'OK',
    remarks: 'Satisfactory'
  });

  // Fetch client equipment master from backend
  useEffect(() => {
    if (isOpen && customer?.Customer_ID) {
      setLoading(true);
      fetch(`/api/client-equipment/${customer.Customer_ID}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data) && data.length > 0 && data[data.length - 1]?.items) {
            setEquipmentList(data[data.length - 1].items);
          } else {
            // Default 3 sample items for brand new clients
            setEquipmentList([
              createDefaultRow(1),
              {
                ...createDefaultRow(2),
                location: 'First Floor Server Room',
                itemName: 'CO2 Type Fire Extinguisher (4.5 Kg)'
              },
              {
                ...createDefaultRow(3),
                location: 'Kitchen Pantry',
                itemName: 'Mechanical Foam Fire Extinguisher (9 Ltr)'
              }
            ]);
          }
        })
        .catch(err => {
          console.error('Fetch client equipment error:', err);
          setEquipmentList([createDefaultRow(1)]);
        })
        .finally(() => setLoading(false));
    }
  }, [isOpen, customer, token]);

  if (!isOpen || !customer) return null;

  // Add Single Equipment Row
  const handleAddRow = () => {
    const nextSr = equipmentList.length + 1;
    setEquipmentList(prev => [...prev, createDefaultRow(nextSr)]);
  };

  // Bulk Add 5 Items Template
  const handleBulkAdd5 = () => {
    const startSr = equipmentList.length;
    const newItems = Array.from({ length: 5 }, (_, i) => createDefaultRow(startSr + i + 1));
    setEquipmentList(prev => [...prev, ...newItems]);
  };

  // Save Equipment Master to Database
  const handleSaveEquipmentMaster = async () => {
    try {
      setSaving(true);
      const res = await fetch(`/api/client-equipment/${customer.Customer_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ items: equipmentList })
      });

      if (!res.ok) throw new Error('Failed to save client equipment master');
      alert(`✅ Saved ${equipmentList.length} equipment items for ${customer.Company_Name || customer.Customer_Name}!`);
      if (onSaveSuccess) onSaveSuccess();
      onClose();
    } catch (err) {
      alert('Error saving client equipment: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/65 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-6xl w-full p-4 sm:p-5 shadow-2xl space-y-4 max-h-[92vh] flex flex-col animate-fadeIn">

        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="p-2.5 bg-amber-100 text-amber-900 rounded-xl font-bold">🧯</span>
            <div>
              <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
                <span>Client Equipment Master Inventory</span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-amber-100 text-amber-900 border border-amber-300">
                  {equipmentList.length} Extinguishers Registered
                </span>
              </h3>
              <p className="text-xs text-slate-500 font-medium flex items-center gap-1.5 mt-0.5">
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
                <strong className="text-slate-800">{customer.Company_Name || customer.Customer_Name}</strong>
                <span className="text-slate-400">({customer.Customer_ID})</span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Toolbar & Search Bar */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 bg-slate-50 p-3 rounded-xl border border-slate-200">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search equipment by ID (e.g. CYL-001), Location, or Type..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-bold text-slate-900 focus:ring-2 focus:ring-amber-500 focus:outline-none shadow-2xs"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
            <button
              type="button"
              onClick={handleAddRow}
              className="px-3.5 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              <span>+ Add 1 Item</span>
            </button>

            <button
              type="button"
              onClick={handleBulkAdd5}
              className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-sm transition"
            >
              <Plus className="w-4 h-4" />
              <span>+ Bulk Add 5 Items</span>
            </button>
          </div>
        </div>

        {/* Equipment Master Table */}
        <div className="flex-1 overflow-y-auto border border-slate-300 rounded-xl bg-white shadow-2xs">
          {loading ? (
            <div className="p-12 text-center text-slate-400 font-medium flex flex-col items-center justify-center gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-amber-600" />
              <span>Loading client equipment inventory...</span>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[55vh]">
              <table className="w-full text-left text-[11px] border-collapse">
                <thead>
                  <tr className="bg-amber-100 text-amber-950 font-black border-b border-slate-300 text-center sticky top-0 z-10 shadow-2xs">
                    <th className="p-2.5 w-8">Sr.</th>
                    <th className="p-2.5 text-left min-w-[140px]">Location</th>
                    <th className="p-2.5 min-w-[110px]">Client ID No</th>
                    <th className="p-2.5 text-left min-w-[190px]">Fire Ext. Description</th>
                    <th className="p-2.5 w-16">MFG</th>
                    <th className="p-2.5 min-w-[110px]">Refilling Dt</th>
                    <th className="p-2.5 min-w-[110px]">Next Refill Dt</th>
                    <th className="p-2.5 min-w-[110px]">HPT Dt</th>
                    <th className="p-2.5 min-w-[110px]">HPT Due Dt</th>
                    <th className="p-2.5 text-left min-w-[130px]">Default Remarks</th>
                    <th className="p-2.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {equipmentList
                    .filter(it => {
                      if (!searchQuery.trim()) return true;
                      const q = searchQuery.toLowerCase();
                      return (
                        (it.clientIdNo || '').toLowerCase().includes(q) ||
                        (it.itemName || '').toLowerCase().includes(q) ||
                        (it.location || '').toLowerCase().includes(q)
                      );
                    })
                    .map((it, idx) => (
                      <tr key={it.id || idx} className="hover:bg-amber-50/70 transition text-center font-medium">
                        <td className="p-2 font-bold text-slate-800">{idx + 1}</td>

                        {/* Location */}
                        <td className="p-2 text-left">
                          <input
                            type="text"
                            value={it.location}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, location: val } : row));
                            }}
                            className="w-full bg-transparent border-b border-slate-200 hover:border-amber-400 focus:border-amber-600 focus:outline-none font-semibold text-slate-800 px-1 py-0.5"
                          />
                        </td>

                        {/* Client ID No */}
                        <td className="p-2 bg-slate-50/50">
                          <input
                            type="text"
                            value={it.clientIdNo}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, clientIdNo: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 hover:border-amber-400 focus:border-amber-600 focus:outline-none font-extrabold text-indigo-950 px-1 py-0.5"
                          />
                        </td>

                        {/* Description */}
                        <td className="p-2 text-left">
                          <input
                            type="text"
                            value={it.itemName}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, itemName: val } : row));
                            }}
                            className="w-full bg-transparent border-b border-slate-200 hover:border-amber-400 focus:border-amber-600 focus:outline-none font-bold text-slate-900 px-1 py-0.5"
                          />
                        </td>

                        {/* MFG */}
                        <td className="p-2">
                          <input
                            type="text"
                            value={it.mfgYear}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, mfgYear: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 focus:outline-none text-[10px]"
                          />
                        </td>

                        {/* Refilling Dt */}
                        <td className="p-2">
                          <input
                            type="date"
                            value={it.refillingDate}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, refillingDate: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 focus:outline-none text-[10px]"
                          />
                        </td>

                        {/* Next Refill Dt */}
                        <td className="p-2 font-bold text-rose-700">
                          <input
                            type="date"
                            value={it.nextRefillingDate}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, nextRefillingDate: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 focus:outline-none font-bold text-rose-700 text-[10px]"
                          />
                        </td>

                        {/* HPT Dt */}
                        <td className="p-2">
                          <input
                            type="date"
                            value={it.hptDate}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, hptDate: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 focus:outline-none text-[10px]"
                          />
                        </td>

                        {/* HPT Due Dt */}
                        <td className="p-2 font-bold text-indigo-900">
                          <input
                            type="date"
                            value={it.hptDueDate}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, hptDueDate: val } : row));
                            }}
                            className="w-full text-center bg-transparent border-b border-slate-200 focus:outline-none font-bold text-indigo-900 text-[10px]"
                          />
                        </td>

                        {/* Remarks */}
                        <td className="p-2 text-left">
                          <input
                            type="text"
                            value={it.remarks || 'Satisfactory'}
                            onChange={e => {
                              const val = e.target.value;
                              setEquipmentList(prev => prev.map((row, i) => i === idx ? { ...row, remarks: val } : row));
                            }}
                            className="w-full bg-transparent border-b border-slate-200 focus:outline-none text-slate-700 italic"
                          />
                        </td>

                        {/* Delete Row Action */}
                        <td className="p-2">
                          <button
                            type="button"
                            onClick={() => {
                              setEquipmentList(prev => prev.filter((_, i) => i !== idx).map((r, i) => ({ ...r, srNo: i + 1 })));
                            }}
                            className="p-1 text-slate-300 hover:text-rose-600 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="border-t border-slate-200 pt-3 flex items-center justify-between text-xs">
          <div className="text-slate-500 font-semibold">
            <span>Total Equipment Records: <strong className="text-slate-900">{equipmentList.length}</strong></span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl font-bold transition"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={saving}
              onClick={handleSaveEquipmentMaster}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black text-xs flex items-center gap-1.5 shadow-md transition"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving...' : 'Save Equipment Inventory'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
