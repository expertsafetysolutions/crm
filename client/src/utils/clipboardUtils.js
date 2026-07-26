/**
 * Cleans a raw phone string (typed or pasted) into a plain 10-digit number, regardless of format
 * — "+91 84606 99569", "091-84606-99569", "8460699569" all resolve to "8460699569". Copies from
 * call history / WhatsApp / contacts usually include the country code and spacing; a plain input
 * with maxLength=10 truncates that raw text (formatting characters included) before any digit
 * cleanup can run, chopping off most of the real number. This is used both by onChange handlers
 * (so a native OS paste or manual typing self-corrects) and by readPhoneNumberFromClipboard below.
 */
export function cleanPhoneDigits(rawText) {
  let digits = (rawText || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }
  return digits.slice(-10);
}

/**
 * Reads the clipboard and extracts a clean 10-digit phone number via cleanPhoneDigits. Returns ''
 * if the clipboard has no usable digits. Throws if clipboard access is denied/unsupported, so
 * callers can show a "paste manually" message.
 */
export async function readPhoneNumberFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    throw new Error('Clipboard access is not supported in this browser. Please paste manually.');
  }
  const text = await navigator.clipboard.readText();
  return cleanPhoneDigits(text);
}
