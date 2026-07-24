/**
 * Utility functions for standardized formatting across Expert CRM:
 * - Date format: DD/MM/YYYY
 * - Full day name in attendance & interaction sections
 * - Time format: 24-hour format (HH:MM)
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Parses various date inputs (YYYY-MM-DD, ISO strings, etc.) into a JS Date object safely.
 */
export function parseSafeDate(input) {
  if (!input) return new Date();
  if (input instanceof Date && !isNaN(input)) return input;

  if (typeof input === 'number' || (typeof input === 'string' && /^\d{11,15}$/.test(input.trim()))) {
    const d = new Date(Number(input));
    if (!isNaN(d)) return d;
  }

  // Handle YYYY-MM-DD cleanly without timezone offset shift
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    const parts = input.split('T')[0].split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  // Handle DD/MM/YYYY or DD-MM-YYYY
  if (typeof input === 'string' && /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(input.trim())) {
    const parts = input.trim().split(/[\/\-\s,•]/);
    const day = Number(parts[0]);
    const month = Number(parts[1]) - 1;
    const year = Number(parts[2]);
    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      return new Date(year, month, day);
    }
  }

  const parsed = new Date(input);
  return isNaN(parsed) ? new Date() : parsed;
}

/**
 * Returns date in YYYY-MM-DD format aligned with real local time.
 * Avoids toISOString() UTC shifts.
 */
export function getLocalDateStr(d = new Date()) {
  const date = parseSafeDate(d);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns time in HH:MM (24-hour) format aligned with real local time.
 */
export function getLocalTimeStr(d = new Date()) {
  const date = parseSafeDate(d);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Returns date formatted as DD/MM/YYYY
 * e.g. "2026-07-11" -> "11/07/2026"
 */
export function formatDateDDMMYYYY(input) {
  if (!input) return '-';
  const d = parseSafeDate(input);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Returns date with full day name
 * e.g. "2026-07-11" -> "11/07/2026 (Saturday)"
 */
export function formatDateWithDayName(input) {
  if (!input) return '-';
  const d = parseSafeDate(input);
  const dayName = DAYS[d.getDay()];
  return `${formatDateDDMMYYYY(d)} (${dayName})`;
}

/**
 * Returns time in 24-hour HH:MM format
 * e.g. "02:30 PM" -> "14:30", "08:55" -> "08:55"
 */
export function formatTime24H(input) {
  if (!input) return '-';
  const str = String(input).trim();
  
  // Handle AM/PM parsing
  const amPmMatch = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)$/i);
  if (amPmMatch) {
    let hours = Number(amPmMatch[1]);
    const mins = amPmMatch[2];
    const isPM = amPmMatch[3].toUpperCase() === 'PM';
    if (isPM && hours < 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${mins}`;
  }

  // Already HH:MM or HH:MM:SS
  const hhMmMatch = str.match(/^(\d{1,2}):(\d{2})/);
  if (hhMmMatch) {
    return `${String(Number(hhMmMatch[1])).padStart(2, '0')}:${hhMmMatch[2]}`;
  }

  return str;
}

/**
 * Returns date + full day name + 24-hour time
 * e.g. "11/07/2026 (Saturday) • 14:30"
 */
export function formatDateTimeWithDayName24H(inputDate, inputTime) {
  if (!inputDate) return '-';
  const dateStr = formatDateWithDayName(inputDate);
  if (!inputTime) return dateStr;
  const timeStr = formatTime24H(inputTime);
  return `${dateStr} • ${timeStr}`;
}

/**
 * Formats combined timestamp strings or interaction/log objects into DD/MM/YYYY (DayName) • HH:MM (24h)
 * Accurately handles epoch ms, Created_At, IDs, ISO strings, and localized date strings.
 */
export function formatInteractionTimestamp(tsStr, itemObj = null) {
  let target = tsStr;
  let item = itemObj;
  if (typeof tsStr === 'object' && tsStr !== null) {
    item = tsStr;
    target = tsStr.Created_At || tsStr.Timestamp || tsStr.Date_Timestamp;
  } else if (item && typeof item === 'object') {
    if (item.Created_At) {
      target = item.Created_At;
    } else if (item.Interaction_ID && typeof item.Interaction_ID === 'string' && item.Interaction_ID.startsWith('INT_')) {
      const ts = Number(item.Interaction_ID.split('_')[1]);
      if (!isNaN(ts) && ts > 1000000000000) target = ts;
    } else if (item.Log_ID && typeof item.Log_ID === 'string' && item.Log_ID.startsWith('LOG')) {
      const ts = Number(item.Log_ID.replace('LOG', ''));
      if (!isNaN(ts) && ts > 1000000000000) target = ts;
    }
  }

  if (item && typeof item === 'object') {
    if (item.Created_At && !isNaN(Number(item.Created_At)) && Number(item.Created_At) > 1000000000000) {
      target = Number(item.Created_At);
    } else if (item.Interaction_ID && typeof item.Interaction_ID === 'string' && item.Interaction_ID.startsWith('INT_')) {
      const ts = Number(item.Interaction_ID.split('_')[1]);
      if (!isNaN(ts) && ts > 1000000000000) target = ts;
    } else if (item.Log_ID && typeof item.Log_ID === 'string' && item.Log_ID.startsWith('LOG')) {
      const ts = Number(item.Log_ID.replace('LOG', ''));
      if (!isNaN(ts) && ts > 1000000000000) target = ts;
    }
  }

  if (!target && !tsStr) return '-';

  let d = null;
  if (typeof target === 'number' || (typeof target === 'string' && /^\d{11,15}$/.test(target.trim()))) {
    d = new Date(Number(target));
  } else if (target instanceof Date) {
    d = target;
  } else if (typeof target === 'string') {
    const str = target.trim();
    const parsed = new Date(str);
    if (!isNaN(parsed) && (str.includes('T') || str.includes('Z') || /^\d{4}-\d{2}-\d{2}/.test(str))) {
      d = parsed;
    } else {
      const ddMmMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[,•\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?)?/i);
      if (ddMmMatch) {
        const day = Number(ddMmMatch[1]);
        const month = Number(ddMmMatch[2]) - 1;
        const year = Number(ddMmMatch[3]);
        let hh = ddMmMatch[4] !== undefined ? Number(ddMmMatch[4]) : 0;
        const min = ddMmMatch[5] !== undefined ? Number(ddMmMatch[5]) : 0;
        const ampm = ddMmMatch[7] ? ddMmMatch[7].toUpperCase() : '';
        if (ampm === 'PM' && hh < 12) hh += 12;
        if (ampm === 'AM' && hh === 12) hh = 0;
        d = new Date(year, month, day, hh, min);
      } else {
        const ddMmmMatch = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:[,•\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?)?/i);
        if (ddMmmMatch) {
          const day = Number(ddMmmMatch[1]);
          const monthMap = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
          const month = monthMap[ddMmmMatch[2].slice(0, 3).toLowerCase()] || 0;
          const year = Number(ddMmmMatch[3]);
          let hh = ddMmmMatch[4] !== undefined ? Number(ddMmmMatch[4]) : 0;
          const min = ddMmmMatch[5] !== undefined ? Number(ddMmmMatch[5]) : 0;
          const ampm = ddMmmMatch[7] ? ddMmmMatch[7].toUpperCase() : '';
          if (ampm === 'PM' && hh < 12) hh += 12;
          if (ampm === 'AM' && hh === 12) hh = 0;
          d = new Date(year, month, day, hh, min);
        } else if (!isNaN(parsed)) {
          d = parsed;
        }
      }
    }
  }

  if (!d || isNaN(d)) return typeof tsStr === 'string' ? tsStr : '-';

  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    const getPart = (type) => parts.find(p => p.type === type)?.value || '';
    const day = getPart('day');
    const month = getPart('month');
    const year = getPart('year');
    const weekday = getPart('weekday');
    const hour = getPart('hour');
    const minute = getPart('minute');
    return `${day}/${month}/${year} (${weekday}) • ${hour}:${minute}`;
  } catch (err) {
    const dayName = DAYS[d.getDay()];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} (${dayName}) • ${hh}:${min}`;
  }
}

/**
 * Recovers the moment a record was actually created. Prefers an explicit Created_At/Timestamp when
 * one exists; otherwise falls back to the Mongo ObjectId in `id` — its first 8 hex characters are
 * the creation time in unix seconds, so rows saved before any timestamp field existed still resolve
 * to a real (second-precision) creation time. Returns null when nothing usable is present.
 */
export function getRecordCreatedAt(record) {
  if (!record || typeof record !== 'object') return null;

  const explicit = record.Created_At || record.createdAt || record.Timestamp;
  if (explicit) {
    const d = typeof explicit === 'number' || /^\d{11,15}$/.test(String(explicit).trim())
      ? new Date(Number(explicit))
      : new Date(explicit);
    if (!isNaN(d)) return d;
  }

  const oid = String(record.id || record._id || '').trim();
  if (/^[0-9a-f]{24}$/i.test(oid)) {
    const d = new Date(parseInt(oid.substring(0, 8), 16) * 1000);
    if (!isNaN(d)) return d;
  }

  return null;
}

/**
 * Returns an IST timestamp as DD/MM/YYYY; HH:MM:SS (24-hour)
 * e.g. "24/07/2026; 06:54:17"
 */
export function formatDateTimeDDMMYYYYHHMMSS(input) {
  if (!input) return '-';
  const d = input instanceof Date ? input : parseSafeDate(input);
  if (isNaN(d)) return '-';

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value || '';
    // Intl renders midnight as "24" in some en-GB/hourCycle combinations; normalize to 00.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('day')}/${get('month')}/${get('year')}; ${hour}:${get('minute')}:${get('second')}`;
  } catch (err) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}; ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

/**
 * Returns true when a task's set/scheduled date is 2+ days old (configurable via `days`) and no
 * interaction/remark has been logged for it since that date. Rescheduling the task (which updates
 * Scheduled_Date) resets the window — the 2-day clock restarts from the new date. Completed/Closed
 * tasks and tasks without a Scheduled_Date are never flagged.
 */
export function isTaskOverdueNoInteraction(task, interactions, days = 2) {
  if (!task || !task.Scheduled_Date) return false;
  if (task.Status === 'Completed' || task.Status === 'Closed') return false;

  const setDate = parseSafeDate(task.Scheduled_Date);
  if (isNaN(setDate)) return false;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceSet = (Date.now() - setDate.getTime()) / msPerDay;
  if (daysSinceSet < days) return false;

  const hasInteractionSinceSet = (interactions || []).some(i => {
    const matchesTask = (task.Task_ID && i.Task_ID === task.Task_ID) ||
      (!i.Task_ID && task.Customer_ID && i.Customer_ID === task.Customer_ID);
    if (!matchesTask) return false;
    const ts = parseSafeDate(i.Timestamp || i.Created_At);
    return !isNaN(ts) && ts >= setDate;
  });

  return !hasInteractionSinceSet;
}

/**
 * Constructs a Google Maps Directions URL (turn-by-turn navigation from user's current location)
 * for mobile app or desktop browser.
 * Uses official Google Maps URL scheme: https://www.google.com/maps/dir/?api=1&destination=...
 */
export function getGoogleDirectionsUrl(locationLink, address, name) {
  let dest = '';

  if (locationLink && typeof locationLink === 'string' && locationLink.trim()) {
    const link = locationLink.trim();
    if (link.includes('/dir/') || link.includes('destination=')) {
      return link;
    }
    if (link.startsWith('http://') || link.startsWith('https://')) {
      try {
        const urlObj = new URL(link);
        const q = urlObj.searchParams.get('q') || urlObj.searchParams.get('query') || urlObj.searchParams.get('daddr');
        if (q) {
          dest = q;
        } else {
          return link;
        }
      } catch (e) {
        return link;
      }
    } else {
      dest = link;
    }
  }

  if (!dest && address && typeof address === 'string' && address.trim()) {
    dest = address.trim();
  }

  if (!dest && name && typeof name === 'string' && name.trim()) {
    dest = name.trim();
  }

  if (!dest) {
    dest = 'Expert Safety';
  }

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}
/**
 * Formats a clean phone number with the + prefix for dialing (especially for 10-digit Indian numbers
 * and 12-digit numbers starting with 91, to avoid carrier errors).
 */
export function formatDialerNumber(cleanPhone) {
  if (!cleanPhone) return '';
  const num = cleanPhone.toString().replace(/\D/g, '');
  if (num.length === 10) {
    return `+91${num}`;
  }
  if (num.startsWith('91') && num.length === 12) {
    return `+${num}`;
  }
  return num.startsWith('+') ? num : `+${num}`;
}

/**
 * Extracts and returns an array of all distinct contact numbers available for a customer or task.
 * Used for direct calling when 1 number is available, or listing choice modal when >1 available.
 */
export function getAvailableContacts(customer = {}, task = {}) {
  const contactsList = [];
  const seenNumbers = new Set();

  const addContact = (name, designation, phone, isPrimary) => {
    if (!phone) return;
    const cleanPhone = phone.toString().replace(/\D/g, '');
    if (!cleanPhone) return;
    if (seenNumbers.has(cleanPhone)) return;
    seenNumbers.add(cleanPhone);

    contactsList.push({
      name: name || (isPrimary ? 'Primary Contact' : 'Contact Person'),
      designation: designation || (isPrimary ? 'Primary Contact' : ''),
      phone: phone.toString().trim(),
      cleanPhone,
      isPrimary
    });
  };

  // 1. Primary Contact
  const primaryPhone = customer?.Contact || task?.Customer_Contact || '';
  const primaryName = customer?.Auth_Person || task?.Customer_Auth_Person || customer?.Company_Name || task?.Customer_Name || 'Primary Contact';
  if (primaryPhone) {
    addContact(primaryName, 'Primary Contact', primaryPhone, true);
  }

  // 2. contacts array (if any)
  if (customer?.contacts && Array.isArray(customer.contacts)) {
    customer.contacts.forEach(c => {
      const phone = c.contactNumber || c.phone || c.Contact || c.mobile;
      addContact(c.name || c.Auth_Person, c.designation || c.role, phone, false);
    });
  }

  // 3. Coordinators / Customer_Coordinators
  const rawCoords = customer?.Coordinators || customer?.coordinators || task?.Customer_Coordinators;
  if (rawCoords) {
    let parsed = rawCoords;
    if (typeof rawCoords === 'string' && rawCoords.trim().startsWith('[')) {
      try {
        parsed = JSON.parse(rawCoords);
      } catch (e) {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      parsed.forEach(c => {
        const phone = c.phone || c.contactNumber || c.Contact || c.mobile;
        addContact(c.name || c.Auth_Person, c.designation || c.role || c.Designation, phone, false);
      });
    }
  }

  return contactsList;
}
