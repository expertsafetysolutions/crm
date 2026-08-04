import React, { useRef, useState } from 'react';
import { X, Camera, Eraser, MapPin, AlertTriangle } from 'lucide-react';
import { getAccurateGpsPosition } from '../utils/gpsHelper';
import { compressImageToDataURL } from '../utils/imageCompression';
import { watermarkWithLocation } from '../utils/geoWatermark';
import useModalBackButton from '../utils/useModalBackButton';

/**
 * DeliveryPODModal — signature, geo-stamped photos and the receiver's name, captured at the gate.
 *
 * Standby units are checked off FIRST. Until every loaner is back the signature pad stays locked:
 * once the customer has signed, everyone considers the job closed and an uncollected company
 * cylinder quietly becomes theirs. The server enforces the same rule, so this is a courtesy, not
 * the control.
 */
export default function DeliveryPODModal({ challan, pendingStandby = [], onSubmit, onReturnStandby, onRetainStandby, onClose, busy = false }) {
  // Only mounted while open, so `true` is always correct: the phone back button closes this modal
  // instead of exiting the app. See useModalBackButton.
  useModalBackButton(true, onClose);

  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [receivedBy, setReceivedBy] = useState('');
  const [photos, setPhotos] = useState([]);
  const [returned, setReturned] = useState(() => new Set());
  const [picked, setPicked] = useState(() => new Set());
  const [retaining, setRetaining] = useState(false);
  const [retainReason, setRetainReason] = useState('');
  const [gps, setGps] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');

  const outstanding = pendingStandby.filter(u => !returned.has(u.EUID_No));
  const locked = outstanding.length > 0;

  const pos = (e) => {
    const c = canvasRef.current;
    const r = c.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (c.width / r.width), y: (p.clientY - r.top) * (c.height / r.height) };
  };

  const start = (e) => {
    if (locked) return;
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.stroke();
    setHasSignature(true);
  };

  const end = () => { drawing.current = false; };

  const clearSignature = () => {
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    setHasSignature(false);
  };

  /** Captures a photo, stamps the GPS fix into the pixels, then compresses it for upload. */
  const addPhoto = async (file) => {
    if (!file) return;
    setCapturing(true);
    setError('');
    try {
      let fix = gps;
      if (!fix) {
        try {
          fix = await getAccurateGpsPosition();
          setGps(fix);
        } catch {
          // A photo with no fix still proves delivery happened; refusing it would be worse.
          fix = null;
        }
      }
      const raw = await compressImageToDataURL(file);
      const stamped = await watermarkWithLocation(raw, {
        lat: fix?.latitude ?? fix?.coords?.latitude,
        lng: fix?.longitude ?? fix?.coords?.longitude,
        accuracy: fix?.accuracy ?? fix?.coords?.accuracy,
        label: challan?.Customer_Name_Snapshot
      });
      setPhotos(prev => [...prev, {
        dataUrl: stamped,
        lat: fix?.latitude ?? fix?.coords?.latitude ?? null,
        lng: fix?.longitude ?? fix?.coords?.longitude ?? null,
        capturedAt: new Date().toISOString()
      }]);
    } catch (e) {
      setError(e.message || 'Could not add the photo');
    } finally {
      setCapturing(false);
    }
  };

  /**
   * Collects the ticked units only. A driver often gets some loaners back and not others, and
   * telling them "all or nothing" just teaches them to tick everything.
   */
  const confirmReturns = async () => {
    const euids = outstanding.filter(u => picked.has(u.EUID_No)).map(u => u.EUID_No);
    if (euids.length === 0) return;
    setError('');
    try {
      await onReturnStandby(euids);
      // Only mark them collected once the server has actually said so — otherwise a failed write
      // would unlock the signature pad and the loaner would be lost.
      setReturned(prev => new Set([...prev, ...euids]));
      setPicked(new Set());
    } catch (e) {
      setError(e.message || 'Could not record the return');
    }
  };

  /**
   * The customer is keeping a unit. This is the only way past the block, so a reason is required —
   * the server refuses without one and records the retention three separate ways.
   */
  const confirmRetention = async () => {
    const euids = outstanding.filter(u => picked.has(u.EUID_No)).map(u => u.EUID_No);
    if (euids.length === 0 || !retainReason.trim()) return;
    setError('');
    try {
      await onRetainStandby(euids, retainReason.trim());
      setReturned(prev => new Set([...prev, ...euids]));
      setPicked(new Set());
      setRetainReason('');
      setRetaining(false);
    } catch (e) {
      setError(e.message || 'Could not record the retention');
    }
  };

  const togglePick = (euid) => setPicked(prev => {
    const next = new Set(prev);
    next.has(euid) ? next.delete(euid) : next.add(euid);
    return next;
  });

  const submit = () => {
    if (locked) return;
    onSubmit({
      signature: hasSignature ? canvasRef.current.toDataURL('image/png') : '',
      photos,
      receivedByName: receivedBy.trim(),
      lat: gps?.latitude ?? gps?.coords?.latitude ?? null,
      lng: gps?.longitude ?? gps?.coords?.longitude ?? null
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-extrabold text-slate-900">Proof of Delivery</p>
            <p className="text-[11px] text-slate-500 truncate">
              {challan?.Challan_No} · {challan?.Customer_Name_Snapshot}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center active:bg-slate-100" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {locked && (
            <div className="rounded-xl bg-rose-50 border border-rose-300 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-rose-900">
                    {outstanding.length} standby unit{outstanding.length > 1 ? 's are' : ' is'} still with the customer
                  </p>
                  <p className="text-[11px] text-rose-800 mt-0.5">
                    Collect them before closing this delivery, or they stay on site indefinitely.
                  </p>
                </div>
              </div>

              {/* Tick what actually came back. Some loaners return and some do not, and forcing
                  all-or-nothing only teaches drivers to tick everything. */}
              <ul className="mt-2 space-y-1">
                {outstanding.map(u => (
                  <li key={u.standbyId}>
                    <label className="flex items-center gap-2 min-h-[44px] px-2 rounded-lg bg-white/70 border border-rose-200 active:bg-white">
                      <input
                        type="checkbox"
                        checked={picked.has(u.EUID_No)}
                        onChange={() => togglePick(u.EUID_No)}
                        className="w-4 h-4 shrink-0"
                      />
                      <span className="text-[11px] font-bold text-rose-900 min-w-0 truncate">
                        {u.EUID_No} {u.Equipment_Type} {u.Capacity}
                        {u.gatePassNo && <span className="font-medium text-rose-700"> · GP {u.gatePassNo}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>

              {retaining ? (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={retainReason}
                    onChange={e => setRetainReason(e.target.value)}
                    rows={2}
                    placeholder="Why is the customer keeping it? (required)"
                    className="w-full rounded-xl border border-rose-300 px-2.5 py-2 text-xs"
                  />
                  <p className="text-[10px] text-rose-700">
                    This is recorded against the customer and the unit stops counting as available stock.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => { setRetaining(false); setRetainReason(''); }} disabled={busy}
                      className="flex-1 min-h-[44px] rounded-xl border border-slate-300 text-xs font-extrabold text-slate-600 active:bg-slate-50">
                      Cancel
                    </button>
                    <button onClick={confirmRetention} disabled={busy || !retainReason.trim() || picked.size === 0}
                      className="flex-1 min-h-[44px] rounded-xl bg-amber-600 text-white text-xs font-extrabold active:bg-amber-700 disabled:opacity-40">
                      Confirm {picked.size || ''} kept
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <button onClick={confirmReturns} disabled={busy || picked.size === 0}
                    className="w-full min-h-[44px] rounded-xl bg-rose-600 text-white text-xs font-extrabold active:bg-rose-700 disabled:opacity-40">
                    {picked.size === 0 ? 'Tick the units you collected' : `Confirm ${picked.size} received back`}
                  </button>
                  <button onClick={() => setRetaining(true)} disabled={busy || picked.size === 0}
                    className="w-full min-h-[44px] rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-xs font-extrabold active:bg-amber-100 disabled:opacity-40">
                    Customer is keeping {picked.size > 1 ? 'these' : 'this'}
                  </button>
                </div>
              )}
            </div>
          )}

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">
              Received by
            </span>
            <input
              value={receivedBy}
              onChange={e => setReceivedBy(e.target.value)}
              disabled={locked}
              placeholder="Name of the person accepting delivery"
              className="jc-input"
            />
          </label>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-400">Signature</span>
              {hasSignature && (
                <button onClick={clearSignature} className="text-[10px] font-bold text-slate-500 flex items-center gap-1">
                  <Eraser className="w-3 h-3" /> Clear
                </button>
              )}
            </div>
            <canvas
              ref={canvasRef}
              width={560}
              height={180}
              onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
              onTouchStart={start} onTouchMove={move} onTouchEnd={end}
              className={`w-full rounded-xl border-2 border-dashed touch-none ${
                locked ? 'border-slate-200 bg-slate-50 opacity-50' : 'border-slate-300 bg-white'
              }`}
              style={{ height: '140px' }}
            />
            {!hasSignature && !locked && (
              <p className="text-[10px] text-slate-400 text-center mt-1">Sign above with a finger or stylus</p>
            )}
          </div>

          <div>
            <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-1">
              Delivery photos
            </span>
            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-1.5 mb-1.5">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p.dataUrl} alt="" className="w-full h-20 object-cover rounded-lg border border-slate-200" />
                    {p.lat && (
                      <span className="absolute bottom-0.5 left-0.5 px-1 rounded bg-emerald-600 text-white text-[8px] font-extrabold flex items-center gap-0.5">
                        <MapPin className="w-2 h-2" /> GPS
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <label className={`jc-btn-ghost w-full min-h-[44px] ${locked ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
              <Camera className="w-4 h-4" />
              {capturing ? 'Adding…' : 'Add photo'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={locked || capturing}
                onChange={e => { addPhoto(e.target.files?.[0]); e.target.value = ''; }}
              />
            </label>
            <p className="text-[10px] text-slate-400 mt-1">
              GPS coordinates and the time are printed onto each photo, so they survive being shared.
            </p>
          </div>

          {error && <p className="text-[11px] font-bold text-rose-600">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-slate-200"
          style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
          <button
            onClick={submit}
            disabled={locked || busy || !hasSignature || !receivedBy.trim()}
            className="w-full min-h-[48px] rounded-xl bg-emerald-600 text-white text-sm font-extrabold active:bg-emerald-700 disabled:opacity-40"
          >
            {locked ? 'Collect standby units first'
              : !receivedBy.trim() ? 'Enter who received it'
                : !hasSignature ? 'Signature required'
                  : 'Save proof of delivery'}
          </button>
        </div>
      </div>
    </div>
  );
}
