import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Loader2, Package, TrendingDown, TrendingUp,
  AlertTriangle, CheckCircle2, BarChart3, Trash2, Download, Upload,
  Search, X, ImagePlus, ChevronDown, ChevronRight
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { matchesQuery, filterByQuery } from '../utils/searchUtils';
import { formatMoney, formatDate, todayISO } from '../utils/quotationUtils';
import LazyImage from '../components/LazyImage';

/**
 * Item Master + stock ledger (Modules B catalog and E inventory).
 *
 * These live together because every stock row is keyed to an Item_Master entry — splitting them
 * across two screens would mean constant back-and-forth when setting up a new item.
 */
const TABS = [
  { id: 'items', label: 'Item Master', icon: Package },
  { id: 'stock', label: 'Stock Balance', icon: BarChart3 },
  { id: 'movements', label: 'Movements', icon: TrendingUp },
  { id: 'report', label: 'Consumption', icon: TrendingDown }
];

export default function InventoryPage() {
  const navigate = useNavigate();
  const { token, user, canSeeMoney } = useAuth();
  const isAdmin = String(user?.Role || '').toLowerCase() === 'admin';

  const [tab, setTab] = useState('items');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const [items, setItems] = useState([]);
  const [balances, setBalances] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [report, setReport] = useState(null);
  const [reportRange, setReportRange] = useState({ fromDate: '', toDate: '' });

  const [itemForm, setItemForm] = useState(null);
  const [moveForm, setMoveForm] = useState(null);
  const [importing, setImporting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileInputRef = useRef(null);
  const photoInputRef = useRef(null);

  // Search / filter for the Item Master list
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState([]);

  // Effective module permissions for the signed-in user (Admin always has everything)
  const [perms, setPerms] = useState(null);
  const [recycleBin, setRecycleBin] = useState(null);

  const canAdd = isAdmin || perms?.inventory?.add;
  const canEdit = isAdmin || perms?.inventory?.edit;
  const canDelete = isAdmin || perms?.inventory?.delete;

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const flash = (text, kind = 'ok') => { setMsg({ text, kind }); setTimeout(() => setMsg(null), 8000); };

  // Column order here doubles as the import template — an exported file can be edited and
  // re-imported, matching on Item_ID (or Item_Name when the ID column is left blank).
  const CSV_COLUMNS = ['Item_ID', 'Item_Name', 'Category', 'HSN_Code', 'Unit', 'Standard_Rate', 'Default_GST_Rate', 'Reorder_Level', 'Description', 'Active'];

  // An export must never carry what the screen hides, or price masking becomes one button click
  // away from defeat. The constant above stays whole because it also defines the IMPORT template.
  const exportColumns = canSeeMoney ? CSV_COLUMNS : CSV_COLUMNS.filter(c => c !== 'Standard_Rate');

  const downloadCsv = (rows, filename) => {
    import('papaparse').then(({ default: Papa }) => {
      const csv = Papa.unparse({ fields: exportColumns, data: rows });
      // Prepend a BOM so Excel opens ₹/UTF-8 text correctly instead of mojibake.
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const exportItems = () => {
    if (items.length === 0) return flash('No items to export yet.', 'err');
    downloadCsv(
      items.map(i => exportColumns.map(c => (i[c] !== undefined && i[c] !== null ? i[c] : ''))),
      `Item_Master_${new Date().toISOString().slice(0, 10)}.csv`
    );
  };

  const downloadTemplate = () => {
    downloadCsv(
      [['', 'ABC Dry Powder Extinguisher 6 Kg', 'Extinguisher', '84241000', 'Nos', 1200, 18, 10, 'IS:15683 certified', 'true']],
      'Item_Master_Template.csv'
    );
  };

  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);

    import('papaparse').then(({ default: Papa }) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: async ({ data }) => {
          try {
            const res = await fetch('/api/items/bulk', {
              method: 'POST', headers, body: JSON.stringify({ items: data })
            });
            const out = await res.json();
            if (!res.ok) throw new Error(out.error || 'Import failed');

            let text = `Imported: ${out.created} new, ${out.updated} updated.`;
            if (out.skippedCount > 0) {
              text += ` ${out.skippedCount} row(s) skipped (${out.skipped.map(s => `row ${s.row}: ${s.reason}`).join('; ')}).`;
            }
            flash(text, out.skippedCount > 0 ? 'err' : 'ok');
            loadAll();
          } catch (err) {
            flash(err.message, 'err');
          } finally {
            setImporting(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }
        },
        error: (err) => {
          flash(`Could not read the file: ${err.message}`, 'err');
          setImporting(false);
        }
      });
    });
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [i, b, t, c, p, cat] = await Promise.all([
        fetch('/api/items', { headers }),
        fetch('/api/inventory/balance', { headers }),
        fetch('/api/inventory/transactions', { headers }),
        fetch('/api/customers', { headers }),
        fetch('/api/my-permissions', { headers }),
        fetch('/api/item-categories', { headers })
      ]);
      if (i.ok) setItems(await i.json());
      if (b.ok) setBalances(await b.json());
      if (t.ok) setTransactions(await t.json());
      if (c.ok) setCustomers(await c.json());
      if (p.ok) setPerms((await p.json()).permissions);
      if (cat.ok) setCategories(await cat.json());
    } finally { setLoading(false); }
  }, [token]);

  const loadRecycleBin = async () => {
    const res = await fetch('/api/items/recycle-bin', { headers });
    if (res.ok) setRecycleBin(await res.json());
    else flash('Could not load the recycle bin.', 'err');
  };

  /**
   * Uploads a product photo to the CRM's own media store (POST /api/media/upload), which returns
   * a /api/media/:id URL saved on the item. Compressed first so a phone camera shot (3-8MB)
   * doesn't take forever on mobile data.
   */
  const handlePhotoFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const { compressImageToDataURL } = await import('../utils/imageCompression');

      // 900px is enough for a crisp product thumbnail in an A4 PDF without bloating the upload.
      const base64 = await compressImageToDataURL(file, 900, 180000);
      if (!base64) throw new Error('Could not process that image');

      const safeName = String(itemForm?.Item_Name || 'product').replace(/[^\w\- ]+/g, '_').trim() || 'product';
      const res = await fetch('/api/media/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base64,
          fileName: `${safeName}-${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          purpose: 'Product Photo'
        })
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.url) throw new Error(result.error || 'Upload failed');

      setItemForm(s => ({ ...s, Photo_URL: result.url, Photo_File_ID: result.mediaId }));
      flash('Photo uploaded.');
    } catch (err) {
      flash(`Photo upload failed: ${err.message}`, 'err');
    } finally {
      setUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = '';
    }
  };

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveItem = async () => {
    const isNew = !itemForm.Item_ID;
    const res = await fetch(isNew ? '/api/items' : `/api/items/${itemForm.Item_ID}`, {
      method: isNew ? 'POST' : 'PUT',
      headers,
      body: JSON.stringify({
        itemName: itemForm.Item_Name, category: itemForm.Category, hsnCode: itemForm.HSN_Code,
        unit: itemForm.Unit, defaultGstRate: itemForm.Default_GST_Rate,
        // Omitted entirely for a viewer who cannot see prices: the server stripped Standard_Rate on
        // the way out, so sending it back would overwrite a real rate with a blank.
        ...(canSeeMoney ? { standardRate: itemForm.Standard_Rate } : {}),
        reorderLevel: itemForm.Reorder_Level,
        description: itemForm.Description,
        longDescription: itemForm.Long_Description,
        specifications: itemForm.Specifications,
        photoUrl: itemForm.Photo_URL,
        photoFileId: itemForm.Photo_File_ID,
        // Tally-style alternate names — comma-separated in the form, stored as an array.
        aliases: String(itemForm.Aliases_Text ?? (itemForm.Aliases || []).join(', '))
          .split(',').map(a => a.trim()).filter(Boolean)
      })
    });
    const data = await res.json();
    if (!res.ok) return flash(data.error || 'Save failed', 'err');
    flash(isNew ? 'Item created.' : 'Item updated.');
    setItemForm(null);
    loadAll();
  };

  /**
   * Non-Admin deletes raise an approval request; Admin deletes apply immediately.
   * Either way the item is only ever soft-deleted — past quotations still reference it.
   */
  const deleteItem = async (item) => {
    const prompt = isAdmin
      ? `Delete "${item.Item_Name}"? It will move to the recycle bin. Existing quotations are unaffected.`
      : `Request deletion of "${item.Item_Name}"? An Admin must approve before it is removed.`;
    if (!window.confirm(prompt)) return;

    const reason = isAdmin ? '' : (window.prompt('Reason for deletion (optional):') || '');
    const res = await fetch(`/api/items/${item.Item_ID}${isAdmin ? '?immediate=true' : ''}`, {
      method: 'DELETE', headers, body: JSON.stringify({ reason })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return flash(out.error || 'Could not delete item.', 'err');

    flash(out.message || (isAdmin ? 'Item moved to recycle bin.' : 'Delete request sent for approval.'));
    loadAll();
  };

  const decideDelete = async (item, decision) => {
    const res = await fetch(`/api/items/${item.Item_ID}/delete-decision`, {
      method: 'POST', headers, body: JSON.stringify({ decision })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return flash(out.error || 'Could not apply decision', 'err');
    flash(decision === 'approve' ? 'Item deleted.' : 'Item restored.');
    loadRecycleBin();
    loadAll();
  };

  const addCategory = async () => {
    const name = window.prompt('New category name:');
    if (!name?.trim()) return;
    const res = await fetch('/api/item-categories', {
      method: 'POST', headers, body: JSON.stringify({ name: name.trim() })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return flash(out.error || 'Could not add category', 'err');
    setCategories(out.categories);
    setItemForm(s => (s ? { ...s, Category: name.trim() } : s));
    flash('Category added.');
  };

  // Client-side filtering keeps typing instant; the server also supports search for large catalogs.
  const visibleItems = items.filter(i => {
    if (categoryFilter && String(i.Category || '') !== categoryFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const aliases = Array.isArray(i.Aliases) ? i.Aliases.join(' ') : '';
    return matchesQuery(q, [i.Item_Name, aliases, i.HSN_Code, i.Category]);
  });

  const submitMovement = async () => {
    // Adjustment accepts a signed qty: negative writes stock down, positive writes it up.
    // Inward/Usage always take a positive magnitude; their direction is fixed by the type.
    const endpoint = moveForm.type === 'Inward' ? '/api/inventory/inward'
      : moveForm.type === 'Adjustment' ? '/api/inventory/adjustment'
      : '/api/inventory/usage';
    const res = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({
        itemId: moveForm.itemId, qty: moveForm.qty, unit: moveForm.unit,
        supplierName: moveForm.supplierName, supplierInvoiceNo: moveForm.supplierInvoiceNo,
        clientId: moveForm.clientId, site: moveForm.site, notes: moveForm.notes, date: moveForm.date
      })
    });
    const data = await res.json();
    if (!res.ok) return flash(data.error || 'Could not record movement', 'err');
    flash(`Recorded. New balance: ${data.balanceAfter}`);
    setMoveForm(null);
    loadAll();
  };

  const runReport = async () => {
    const params = new URLSearchParams();
    if (reportRange.fromDate) params.set('fromDate', reportRange.fromDate);
    if (reportRange.toDate) params.set('toDate', reportRange.toDate);
    const res = await fetch(`/api/inventory/consumption-report?${params}`, { headers });
    if (res.ok) setReport(await res.json());
  };

  const lowStock = balances.filter(b => b.Is_Low_Stock);

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="p-2 hover:bg-slate-100 rounded-lg"><ArrowLeft className="w-4 h-4" /></button>
          <h1 className="font-bold flex-1">Items & Inventory</h1>
          {tab === 'items' && (
            <>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleImportFile} className="hidden" />
              <button onClick={exportItems} title="Download all items as CSV"
                className="px-2.5 py-2 border border-slate-200 text-slate-700 text-xs font-bold rounded-lg flex items-center gap-1.5 hover:bg-slate-50">
                <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Export</span>
              </button>
              {canAdd && (
                <>
                  <button onClick={() => fileInputRef.current?.click()} disabled={importing}
                    title="Import items from a CSV file"
                    className="px-2.5 py-2 border border-slate-200 text-slate-700 text-xs font-bold rounded-lg flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50">
                    {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    <span className="hidden sm:inline">{importing ? 'Importing…' : 'Import'}</span>
                  </button>
                  <button onClick={downloadTemplate} title="Download a blank CSV template"
                    className="px-2.5 py-2 text-slate-500 text-xs font-semibold rounded-lg hover:bg-slate-50 hidden md:block">
                    Template
                  </button>
                </>
              )}
            </>
          )}
          {tab === 'items' && canAdd && (
            <button onClick={() => setItemForm({ Unit: 'Nos', Default_GST_Rate: 18, Standard_Rate: 0, Reorder_Level: 0 })}
              className="px-3 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Item
            </button>
          )}
          {(tab === 'stock' || tab === 'movements') && canAdd && (
            <button onClick={() => setMoveForm({ type: 'Inward', qty: 1, date: todayISO() })}
              className="px-3 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Movement
            </button>
          )}
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-xs font-bold whitespace-nowrap border-b-2 flex items-center gap-1.5 ${tab === t.id ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500'}`}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {msg && (
          <div className={`px-4 py-3 rounded-xl text-sm flex items-start gap-2 ${msg.kind === 'err' ? 'bg-rose-50 border border-rose-200 text-rose-700' : 'bg-emerald-50 border border-emerald-200 text-emerald-700'}`}>
            {msg.kind === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span className="flex-1">{msg.text}</span>
          </div>
        )}

        {lowStock.length > 0 && tab !== 'items' && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <div className="text-sm font-bold text-amber-800 flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4" /> {lowStock.length} item(s) at or below reorder level
            </div>
            <div className="text-xs text-amber-700">
              {lowStock.map(l => `${l.Item_Name} (${l.Current_Qty} ${l.Unit})`).join(' · ')}
            </div>
          </div>
        )}

        {tab === 'items' && (
          <>
            {/* Search + category filter */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search name, alias, HSN or category…"
                  className="w-full pl-10 pr-9 py-2.5 border border-slate-300 rounded-xl text-base"
                />
                {search && (
                  <button onClick={() => setSearch('')} aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 active:bg-slate-100 rounded">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                className="px-3 py-2.5 border border-slate-300 rounded-xl text-base bg-white sm:w-48">
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {isAdmin && (
                <button onClick={() => { loadRecycleBin(); setTab('recycle'); }}
                  className="px-3 py-2.5 border border-slate-300 rounded-xl text-xs font-bold text-slate-600 active:bg-slate-50 whitespace-nowrap">
                  Recycle Bin
                </button>
              )}
            </div>

            {(search || categoryFilter) && (
              <div className="text-xs text-slate-500">
                Showing {visibleItems.length} of {items.length} items
              </div>
            )}

            {/* MOBILE: item cards. Photos load only when scrolled into view. */}
            <div className="md:hidden space-y-2">
              {visibleItems.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl py-12 px-6 text-center text-sm text-slate-400 leading-relaxed">
                  {items.length === 0
                    ? <>No items yet. Add one with <b>+ Item</b>, or use <b>Import</b> to bring in a CSV.</>
                    : 'No items match your search.'}
                </div>
              ) : visibleItems.map(i => (
                <div key={i.Item_ID} className="bg-white border border-slate-200 rounded-xl p-3">
                  <div className="flex items-start gap-3">
                    <LazyImage
                      src={i.Photo_URL}
                      alt={i.Item_Name}
                      mode="viewport"
                      wrapperClassName="w-14 h-14 rounded-lg shrink-0 border border-slate-200"
                      className="w-full h-full object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-sm">{i.Item_Name}</div>
                      {i.Category && <div className="text-[11px] text-slate-400">{i.Category}</div>}
                      {Array.isArray(i.Aliases) && i.Aliases.length > 0 && (
                        <div className="text-[10px] text-indigo-500 truncate">alias: {i.Aliases.join(', ')}</div>
                      )}
                    </div>
                    {canSeeMoney && <div className="font-bold text-base shrink-0">{formatMoney(i.Standard_Rate)}</div>}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-slate-600">
                    <span><b className="text-slate-400 uppercase text-[9px]">HSN</b> {i.HSN_Code || '—'}</span>
                    <span><b className="text-slate-400 uppercase text-[9px]">Unit</b> {i.Unit}</span>
                    <span><b className="text-slate-400 uppercase text-[9px]">GST</b> {i.Default_GST_Rate}%</span>
                    <span><b className="text-slate-400 uppercase text-[9px]">Reorder</b> {i.Reorder_Level || '—'}</span>
                  </div>
                  {(canEdit || canDelete) && (
                    <div className="flex gap-2 mt-2.5 pt-2.5 border-t border-slate-100">
                      {canEdit && (
                        <button onClick={() => setItemForm({ ...i, Aliases_Text: (i.Aliases || []).join(', ') })}
                          className="flex-1 py-2.5 text-xs font-bold border border-slate-200 rounded-lg active:bg-slate-50">
                          Edit
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={() => deleteItem(i)} aria-label="Delete item"
                          className="px-4 py-2.5 text-slate-400 border border-slate-200 rounded-lg active:bg-rose-50 active:text-rose-600">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* DESKTOP: table */}
            <div className="hidden md:block">
              <Table
                head={['Item', 'HSN', 'Unit', ...(canSeeMoney ? ['Rate'] : []), 'GST%', 'Reorder', '']}
                rows={visibleItems.map(i => [
                  <div key="n" className="flex items-center gap-2.5">
                    <LazyImage src={i.Photo_URL} alt={i.Item_Name} mode="viewport"
                      wrapperClassName="w-10 h-10 rounded shrink-0 border border-slate-200"
                      className="w-full h-full object-cover" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{i.Item_Name}</div>
                      {i.Category && <div className="text-xs text-slate-400">{i.Category}</div>}
                      {Array.isArray(i.Aliases) && i.Aliases.length > 0 && (
                        <div className="text-[10px] text-indigo-500 truncate">alias: {i.Aliases.join(', ')}</div>
                      )}
                    </div>
                  </div>,
                  i.HSN_Code || '—', i.Unit,
                  ...(canSeeMoney ? [formatMoney(i.Standard_Rate)] : []),
                  `${i.Default_GST_Rate}%`, i.Reorder_Level || '—',
                  (canEdit || canDelete) ? (
                    <div key="a" className="flex gap-1 justify-end">
                      {canEdit && <button onClick={() => setItemForm({ ...i, Aliases_Text: (i.Aliases || []).join(', ') })}
                        className="px-2 py-1 text-xs font-bold border border-slate-200 rounded hover:bg-slate-50">Edit</button>}
                      {canDelete && <button onClick={() => deleteItem(i)}
                        className="p-1.5 text-slate-400 hover:text-rose-600 rounded"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </div>
                  ) : null
                ])}
                empty={items.length === 0 ? 'No items yet.' : 'No items match your search.'} />
            </div>
          </>
        )}

        {/* Admin recycle bin: approve or reject staff delete requests */}
        {tab === 'recycle' && (
          <>
            <button onClick={() => setTab('items')} className="text-xs font-bold text-slate-500 active:text-slate-800">
              ← Back to Item Master
            </button>
            {!recycleBin ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
            ) : (
              <>
                <div className="text-sm font-bold text-slate-700">Awaiting approval ({recycleBin.pending.length})</div>
                {recycleBin.pending.length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-xl py-8 text-center text-sm text-slate-400">
                    No pending delete requests.
                  </div>
                ) : recycleBin.pending.map(i => (
                  <div key={i.Item_ID} className="bg-white border border-amber-200 rounded-xl p-3">
                    <div className="font-bold text-sm">{i.Item_Name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Requested by {i.Delete_Requested_By} · {formatDate(String(i.Delete_Requested_At || '').slice(0, 10))}
                    </div>
                    {i.Delete_Reason && <div className="text-xs text-slate-600 mt-1 italic">"{i.Delete_Reason}"</div>}
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => decideDelete(i, 'approve')}
                        className="flex-1 py-2.5 text-xs font-bold bg-rose-600 text-white rounded-lg active:bg-rose-700">
                        Approve delete
                      </button>
                      <button onClick={() => decideDelete(i, 'reject')}
                        className="flex-1 py-2.5 text-xs font-bold border border-slate-200 rounded-lg active:bg-slate-50">
                        Restore
                      </button>
                    </div>
                  </div>
                ))}

                <div className="text-sm font-bold text-slate-700 pt-2">Deleted ({recycleBin.deleted.length})</div>
                {recycleBin.deleted.map(i => (
                  <div key={i.Item_ID} className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-slate-500 line-through truncate">{i.Item_Name}</div>
                      <div className="text-[11px] text-slate-400">Deleted by {i.Deleted_By || '—'}</div>
                    </div>
                    <button onClick={() => decideDelete(i, 'reject')}
                      className="px-3 py-2 text-xs font-bold border border-slate-200 rounded-lg active:bg-slate-50 shrink-0">
                      Restore
                    </button>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === 'stock' && (
          <Table
            head={['Item', 'On hand', 'Unit', 'Reorder level', 'Status']}
            rows={balances.map(b => [
              b.Item_Name, <span key="q" className="font-bold">{b.Current_Qty}</span>, b.Unit, b.Reorder_Level || '—',
              b.Is_Low_Stock
                ? <span key="s" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">Low</span>
                : <span key="s" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">OK</span>
            ])}
            empty="No stock recorded yet." />
        )}

        {tab === 'movements' && (
          <Table
            head={['Date', 'Item', 'Type', 'Qty', 'Balance', 'Reference']}
            rows={transactions.slice(0, 200).map(t => [
              formatDate(t.Date), t.Item_Name,
              <span key="t" className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                t.Type === 'Inward' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>{t.Type}</span>,
              <span key="q" className={Number(t.Qty) < 0 ? 'text-rose-600 font-bold' : 'text-emerald-700 font-bold'}>{t.Qty > 0 ? `+${t.Qty}` : t.Qty}</span>,
              t.Balance_After,
              <span key="r" className="text-xs text-slate-500">{t.Supplier_Name || t.Linked_Invoice_ID || t.Site || t.Notes || '—'}</span>
            ])}
            empty="No stock movements recorded." />
        )}

        {tab === 'report' && (
          <>
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap gap-3 items-end">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase">From</label>
                <input type="date" value={reportRange.fromDate} onChange={e => setReportRange(r => ({ ...r, fromDate: e.target.value }))}
                  className="block mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase">To</label>
                <input type="date" value={reportRange.toDate} onChange={e => setReportRange(r => ({ ...r, toDate: e.target.value }))}
                  className="block mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
              </div>
              <button onClick={runReport} className="px-4 py-2 bg-slate-900 text-white text-sm font-bold rounded-lg">Run report</button>
            </div>
            {report && (
              <Table
                head={['Item', 'Total consumed', 'Unit', 'Movements']}
                rows={report.summary.map(s => [s.Item_Name, <span key="c" className="font-bold">{s.Total_Consumed}</span>, s.Unit, s.Transaction_Count])}
                empty="No consumption in this period." />
            )}
          </>
        )}
      </div>

      {/* Item editor */}
      {itemForm && (
        <Modal title={itemForm.Item_ID ? 'Edit item' : 'New item'} onClose={() => setItemForm(null)} onSave={saveItem}>
          <F label="Item name" value={itemForm.Item_Name} onChange={v => setItemForm(s => ({ ...s, Item_Name: v }))} />

          {/* Photo */}
          <div>
            <label className="text-xs font-bold text-slate-600 uppercase">Product photo</label>
            <input ref={photoInputRef} type="file" accept="image/*" onChange={handlePhotoFile} className="hidden" />
            <div className="mt-1 flex items-center gap-3">
              <LazyImage
                src={itemForm.Photo_URL}
                alt={itemForm.Item_Name}
                mode="eager"
                wrapperClassName="w-20 h-20 rounded-xl border border-slate-200 shrink-0"
                className="w-full h-full object-cover"
              />
              <div className="flex-1 space-y-1.5">
                <button type="button" onClick={() => photoInputRef.current?.click()} disabled={uploadingPhoto}
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:bg-slate-50 disabled:opacity-50">
                  {uploadingPhoto ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
                  {uploadingPhoto ? 'Uploading…' : itemForm.Photo_URL ? 'Replace photo' : 'Upload photo'}
                </button>
                {itemForm.Photo_URL && (
                  <button type="button" onClick={() => setItemForm(s => ({ ...s, Photo_URL: '', Photo_File_ID: '' }))}
                    className="w-full px-3 py-2 text-xs font-bold text-rose-600 active:bg-rose-50 rounded-lg">
                    Remove photo
                  </button>
                )}
              </div>
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              Compressed and stored in Google Drive. Shown on quotations and loaded only when needed, so pages stay fast.
            </div>
          </div>

          {/* Category with inline "add new" */}
          <div>
            <label className="text-xs font-bold text-slate-600 uppercase">Category</label>
            <div className="flex gap-2 mt-1">
              <select value={itemForm.Category || ''} onChange={e => setItemForm(s => ({ ...s, Category: e.target.value }))}
                className="flex-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base bg-white">
                <option value="">— Select —</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
                {itemForm.Category && !categories.includes(itemForm.Category) && (
                  <option value={itemForm.Category}>{itemForm.Category}</option>
                )}
              </select>
              {isAdmin && (
                <button type="button" onClick={addCategory}
                  className="px-3 py-2.5 border border-slate-300 rounded-xl text-xs font-bold active:bg-slate-50 shrink-0">
                  + New
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <F label="HSN/SAC" value={itemForm.HSN_Code} onChange={v => setItemForm(s => ({ ...s, HSN_Code: v }))} />
            <F label="Unit" value={itemForm.Unit} onChange={v => setItemForm(s => ({ ...s, Unit: v }))} />
            {canSeeMoney && <F label="Standard rate" type="number" value={itemForm.Standard_Rate} onChange={v => setItemForm(s => ({ ...s, Standard_Rate: v }))} />}
            <F label="GST %" type="number" value={itemForm.Default_GST_Rate} onChange={v => setItemForm(s => ({ ...s, Default_GST_Rate: v }))} />
          </div>

          {/* Optional details, collapsed once the essentials are in so data entry stays quick */}
          <CollapsibleSection
            title="Aliases & description"
            /* Auto-expands when there's already content to show, so nothing stays hidden by accident */
            defaultOpen={Boolean(itemForm.Aliases_Text || itemForm.Long_Description || itemForm.Reorder_Level)}
            summary={[
              itemForm.Aliases_Text ? 'aliases set' : null,
              itemForm.Long_Description ? 'description set' : null
            ].filter(Boolean).join(' · ')}
          >
            <F label="Aliases (comma separated)" value={itemForm.Aliases_Text ?? (itemForm.Aliases || []).join(', ')}
              onChange={v => setItemForm(s => ({ ...s, Aliases_Text: v }))} />
            <div className="text-[10px] text-slate-400 -mt-1.5 mb-1">
              Alternate names, like in Tally — the item can then be found by any of them when searching or quoting.
            </div>
            <F label="Reorder level" type="number" value={itemForm.Reorder_Level} onChange={v => setItemForm(s => ({ ...s, Reorder_Level: v }))} />
            <div>
              <label className="text-xs font-bold text-slate-600 uppercase">Description (shown on quotation)</label>
              <textarea rows={3} value={itemForm.Long_Description || ''}
                onChange={e => setItemForm(s => ({ ...s, Long_Description: e.target.value }))}
                className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base" />
            </div>
          </CollapsibleSection>
        </Modal>
      )}

      {/* Stock movement */}
      {moveForm && (
        <Modal title="Record stock movement" onClose={() => setMoveForm(null)} onSave={submitMovement}>
          <div className="flex gap-2 mb-3">
            {['Inward', 'Usage', 'Adjustment'].map(t => (
              <button key={t} onClick={() => setMoveForm(s => ({ ...s, type: t }))}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold border ${moveForm.type === t ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200'}`}>{t}</button>
            ))}
          </div>
          <div>
            <label className="text-xs font-bold text-slate-600 uppercase">Item</label>
            <select value={moveForm.itemId || ''} onChange={e => {
              const it = items.find(i => i.Item_ID === e.target.value);
              setMoveForm(s => ({ ...s, itemId: e.target.value, unit: it?.Unit || 'Nos' }));
            }} className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm">
              <option value="">— Select item —</option>
              {items.map(i => <option key={i.Item_ID} value={i.Item_ID}>{i.Item_Name}</option>)}
            </select>
          </div>
          {moveForm.type === 'Adjustment' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[11px] text-amber-800">
              Enter the <b>difference</b>, not the counted total. Use a negative number when the physical
              count is lower than the system figure (e.g. <b>-3</b> for three missing).
              {moveForm.itemId && (() => {
                const bal = balances.find(b => b.Item_ID === moveForm.itemId);
                const diff = Number(moveForm.qty);
                if (!bal) return null;
                return (
                  <div className="mt-1 font-semibold">
                    System: {bal.Current_Qty} {bal.Unit}
                    {Number.isFinite(diff) && diff !== 0 && ` → after adjustment: ${(Number(bal.Current_Qty) || 0) + diff} ${bal.Unit}`}
                  </div>
                );
              })()}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <F label={moveForm.type === 'Adjustment' ? 'Difference (+/-)' : 'Quantity'} type="number"
              value={moveForm.qty} onChange={v => setMoveForm(s => ({ ...s, qty: v }))} />
            <F label="Date" type="date" value={moveForm.date} onChange={v => setMoveForm(s => ({ ...s, date: v }))} />
          </div>
          {moveForm.type === 'Adjustment' ? (
            <F label="Reason" value={moveForm.notes}
              onChange={v => setMoveForm(s => ({ ...s, notes: v }))} />
          ) : moveForm.type === 'Inward' ? (
            <div className="grid grid-cols-2 gap-3">
              <F label="Supplier" value={moveForm.supplierName} onChange={v => setMoveForm(s => ({ ...s, supplierName: v }))} />
              <F label="Supplier invoice no." value={moveForm.supplierInvoiceNo} onChange={v => setMoveForm(s => ({ ...s, supplierInvoiceNo: v }))} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-600 uppercase">Client</label>
                <select value={moveForm.clientId || ''} onChange={e => setMoveForm(s => ({ ...s, clientId: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm">
                  <option value="">— None —</option>
                  {customers.slice(0, 300).map(c => <option key={c.Customer_ID} value={c.Customer_ID}>{c.Company_Name}</option>)}
                </select>
              </div>
              <F label="Site" value={moveForm.site} onChange={v => setMoveForm(s => ({ ...s, site: v }))} />
            </div>
          )}
          {/* Adjustment collects its own "Reason" above, so it doesn't repeat the Notes field. */}
          {moveForm.type !== 'Adjustment' && (
            <F label="Notes" value={moveForm.notes} onChange={v => setMoveForm(s => ({ ...s, notes: v }))} />
          )}
        </Modal>
      )}
    </div>
  );
}

/**
 * Responsive data table.
 *
 * On phones each row becomes a labelled card — the first cell is the card's heading and the rest
 * render as label/value pairs, so no column is lost to horizontal scrolling. Desktop keeps the
 * conventional table.
 */
function Table({ head, rows, empty }) {
  if (!rows.length) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl py-12 px-6 text-center text-sm text-slate-400 leading-relaxed">
        {empty}
      </div>
    );
  }

  return (
    <>
      <div className="md:hidden space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="font-bold text-sm mb-1.5">{r[0]}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {r.slice(1).map((cell, j) => {
                // Skip empty trailing cells (e.g. the desktop-only actions column when not Admin).
                if (cell === null || cell === undefined || cell === '') return null;
                return (
                  <div key={j} className="flex items-baseline gap-1.5 min-w-0">
                    <span className="text-[10px] font-bold uppercase text-slate-400 shrink-0">{head[j + 1]}</span>
                    <span className="text-xs text-slate-700 truncate">{cell}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>{head.map((h, i) => <th key={i} className={`px-4 py-2.5 font-bold ${i === head.length - 1 ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {r.map((cell, j) => <td key={j} className={`px-4 py-2.5 ${j === r.length - 1 ? 'text-right' : ''}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/**
 * Bottom sheet on phones, centred dialog on desktop. A centred dialog gets squeezed against the
 * on-screen keyboard on mobile, whereas a bottom sheet stays anchored and scrolls naturally.
 */
function Modal({ title, children, onClose, onSave }) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-end md:items-center justify-center md:p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-t-2xl md:rounded-2xl p-4 md:p-5 w-full max-w-lg max-h-[92vh] md:max-h-[90vh] overflow-y-auto space-y-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto md:hidden" />
        <div className="font-bold text-slate-900">{title}</div>
        {children}
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 px-4 py-3 md:py-2 border border-slate-200 rounded-xl text-sm font-bold">Cancel</button>
          <button onClick={onSave} className="flex-1 px-4 py-3 md:py-2 bg-slate-900 text-white rounded-xl text-sm font-bold">Save</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Collapsible group of optional fields.
 *
 * Keeps data entry short: the essentials stay visible and everything optional folds away, with a
 * one-line summary so the user can see at a glance whether anything is set inside. Auto-opens when
 * it already has content, so existing data is never hidden from an editor.
 */
/**
 * Deliberately NOT components/CollapsibleSection.jsx. That one is the workshop auto-hide primitive:
 * it folds on the false->true completeness edge and has no `title`, because a job-card section is
 * identified by its summary row. This is a plain optional-fields disclosure with a heading, opened
 * by choice rather than by completion. Same name, different job — merging them would either lose the
 * title here or bolt an unused completeness prop onto the shared one.
 */
function CollapsibleSection({ title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2.5 flex items-center gap-2 text-left active:bg-slate-50">
        {open ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
        <span className="text-xs font-bold uppercase text-slate-600 flex-1">{title}</span>
        {!open && summary && <span className="text-[10px] text-emerald-600 font-semibold truncate">{summary}</span>}
        {!open && !summary && <span className="text-[10px] text-slate-400">optional</span>}
      </button>
      {open && <div className="px-3 pb-3 space-y-3">{children}</div>}
    </div>
  );
}

function F({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="text-xs font-bold text-slate-600 uppercase">{label}</label>
      {/* text-base (16px) prevents iOS Safari from zooming the viewport on focus */}
      <input
        type={type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full mt-1 px-3 py-2.5 border border-slate-300 rounded-xl text-base"
      />
    </div>
  );
}
