import { ClipboardPaste } from 'lucide-react';
import { readPhoneNumberFromClipboard } from '../utils/clipboardUtils';

/**
 * Icon button that reads the clipboard, extracts a clean 10-digit phone number (stripping
 * spaces/country code from formats like "+91 84606 99569"), and hands it to onPaste. Position
 * absolutely inside a `relative` wrapper around a phone <input>, right-aligned, with enough
 * right padding on the input (e.g. pr-7) to clear it.
 */
export default function PhonePasteButton({ onPaste, iconClassName = 'w-3.5 h-3.5' }) {
  const handleClick = async () => {
    try {
      const digits = await readPhoneNumberFromClipboard();
      if (!digits) { alert('No phone number found on the clipboard.'); return; }
      onPaste(digits);
    } catch (err) {
      alert(err.message || 'Could not read the clipboard. Please paste manually.');
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      title="Paste phone number from clipboard"
      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition"
    >
      <ClipboardPaste className={iconClassName} />
    </button>
  );
}
