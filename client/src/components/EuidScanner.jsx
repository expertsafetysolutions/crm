import React, { useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';

/**
 * EuidScanner — reads a cylinder's stamped or punched number from a photo, with typing as the
 * primary path rather than the fallback.
 *
 * The text box is ALWAYS visible and always focused-ready. Cylinder numbers are punched into curved,
 * often rusted metal in poor workshop light, which is close to the worst case for OCR; hiding the
 * keyboard behind a failed scan would make the common case slower than no scanner at all. The camera
 * is offered as a shortcut that sometimes saves typing, never as a gate.
 *
 * Tesseract is imported lazily (~2MB) so the job card page does not pay for it unless someone
 * actually taps Scan, and it runs entirely on-device — which matters because the workshop is exactly
 * where the connection is worst.
 */
export default function EuidScanner({ value, onChange, label = 'EUID No', placeholder = 'Type or scan', disabled = false }) {
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState('');

  const scan = async (file) => {
    if (!file) return;
    setScanning(true);
    setNote('');
    try {
      const { default: Tesseract } = await import('tesseract.js');
      const { data } = await Tesseract.recognize(file, 'eng', {
        // Stamped identifiers are alphanumeric with dashes; restricting the alphabet cuts the
        // usual confusions (O/0, I/1) considerably.
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/'
      });

      const text = String(data?.text || '').toUpperCase();
      // Take the longest run that looks like an identifier rather than the whole block of noise.
      const candidates = text.match(/[A-Z0-9][A-Z0-9\-/]{3,}/g) || [];
      const best = candidates.sort((a, b) => b.length - a.length)[0];

      if (best) {
        onChange(best);
        setNote('Scanned — check it against the cylinder before saving.');
      } else {
        setNote('Nothing readable in that photo. Type the number instead.');
      }
    } catch {
      setNote('Scanning is unavailable. Type the number instead.');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <span className="block text-[10px] font-extrabold uppercase tracking-wide text-slate-400 mb-0.5">{label}</span>
      <div className="flex gap-1.5">
        <input
          value={value || ''}
          onChange={e => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          placeholder={placeholder}
          inputMode="text"
          autoCapitalize="characters"
          className="jc-input flex-1"
        />
        <label
          className={`jc-btn-ghost w-12 shrink-0 ${disabled || scanning ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
          title="Scan the number from the cylinder"
        >
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={disabled || scanning}
            onChange={e => { scan(e.target.files?.[0]); e.target.value = ''; }}
          />
        </label>
      </div>
      {note && <p className="text-[10px] text-slate-500 mt-0.5">{note}</p>}
    </div>
  );
}
