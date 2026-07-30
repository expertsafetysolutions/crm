#!/usr/bin/env node
/**
 * Builds the new-staff application guide — writes both an HTML file and a PDF.
 *
 *   npm run guide:staff
 *
 * Output is dated (Application_Guide_HI_GU_YYYY-MM-DD.*), so re-running keeps the older copies and
 * anyone holding a printout can tell at a glance which version it is.
 *
 * ── WHY HEADLESS CHROME AND NOT A PDF LIBRARY ────────────────────────────────────────────────
 * A PDF must embed a font carrying Devanagari AND Gujarati glyphs. jsPDF's bundled faces are
 * Latin-only, so every Hindi and Gujarati character renders as an empty box — worse than useless
 * for the people this is written for. Chrome embeds the system's Nirmala UI, which covers both
 * scripts; the generated file was checked and does contain NirmalaUI subsets. No new dependency,
 * no font licensing.
 *
 * ── WHAT IS DELIBERATELY LEFT OUT ────────────────────────────────────────────────────────────
 * The owner asked that location capture and other background recording not be described. Nothing
 * here explains what is logged, when, or where it goes.
 *
 * One thing could not simply be omitted, and pretending otherwise would have made the guide wrong:
 * with location services switched off the app BLOCKS Punch In, Punch Out, Advance, Reschedule and
 * Log with a visible "High-Accuracy GPS Required" alert. A new employee whose punch-in silently
 * fails on day one will conclude the app is broken and stop using it. So the guide states the
 * device requirement — "keep location switched on or these buttons will not work" — and says
 * nothing about what is recorded. That is a setup instruction, not a disclosure.
 *
 * Also omitted as not-for-staff: the audit trail, money masking, device/session limits, backup
 * tooling, and every Admin-only screen.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '../docs/training');
const LOGO = path.join(__dirname, '../client/public/expert_logo.jpg');

/**
 * IST date, matching the rest of this codebase — the deployment clock may not be local time, and a
 * guide stamped with yesterday's date because the machine was on UTC would undermine the whole
 * point of putting the date in the name.
 */
const BUILD_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// Dated filename so it is obvious at a glance which copy someone is holding — a staff member with
// an old printout on their phone is otherwise indistinguishable from one with the current version.
const OUT_FILE = path.join(OUT_DIR, `Application_Guide_HI_GU_${BUILD_DATE}.html`);

/** Inlined so the file can be emailed or copied to a phone and still render. */
function logoDataUri() {
  try {
    return `data:image/jpeg;base64,${fs.readFileSync(LOGO).toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * Each lesson carries its Hindi and Gujarati text side by side, plus an optional ASCII sketch of
 * the screen. Sketches rather than screenshots on purpose: a screenshot of live data would put real
 * customer names and phone numbers into a document that gets forwarded around, and it goes stale
 * the moment a button moves.
 */
const LESSONS = [
  {
    n: 1,
    icon: '🔑',
    hi: { t: 'लॉगिन कैसे करें', b: [
      'ऐप खोलें। <b>Staff ID</b> और <b>Password</b> डालें।',
      'पहली बार किसी नए मोबाइल या कंप्यूटर से लॉगिन करने पर <b>6 अंकों का कोड</b> मांगा जाएगा।',
      'यह कोड <b>ऑफिस को ईमेल</b> होता है — एडमिन से पूछकर डालें। यह सिर्फ़ एक बार होता है।',
      'पासवर्ड भूल गए? <b>Forgot password?</b> दबाएँ — नया कोड ऑफिस को जाएगा।'
    ]},
    gu: { t: 'લોગિન કઈ રીતે કરવું', b: [
      'એપ ખોલો. <b>Staff ID</b> અને <b>Password</b> નાખો.',
      'નવા મોબાઈલ કે કમ્પ્યુટર પરથી પહેલી વાર લોગિન કરો ત્યારે <b>૬ અંકનો કોડ</b> માંગશે.',
      'આ કોડ <b>ઓફિસના ઈમેલ</b> પર જાય છે — એડમિનને પૂછીને નાખો. આ એક જ વાર થાય છે.',
      'પાસવર્ડ ભૂલી ગયા? <b>Forgot password?</b> દબાવો — નવો કોડ ઓફિસ પર જશે.'
    ]},
    sketch: `┌─────────────────────────┐
│   Staff ID  [ STAFF00_ ]│
│   Password  [ •••••••• ]│
│   ☐ Remember Staff ID   │
│         [  Sign In  ]   │
│      Forgot password?   │
└─────────────────────────┘`
  },
  {
    n: 2,
    icon: '⏱️',
    hi: { t: 'हाज़िरी — Punch In / Punch Out', b: [
      'ऊपर दाईं तरफ़ <b>अपनी फ़ोटो/नाम</b> पर टैप करें — मेन्यू खुलेगा।',
      '<b>Daily Attendance</b> बॉक्स में <b>Punch In — Start Shift</b> दबाएँ। काम शुरू।',
      'शाम को <b>Punch Out — End Shift</b> दबाएँ। एक कन्फर्मेशन आएगा — <b>Yes, Confirm Punch Out</b> दबाएँ।',
      '⚠️ <b>मोबाइल की Location सेटिंग चालू रखें</b>, वरना Punch In नहीं होगा।',
      'Punch In के लिए इंटरनेट ज़रूरी है — ऑफ़लाइन में यह काम नहीं करेगा।'
    ]},
    gu: { t: 'હાજરી — Punch In / Punch Out', b: [
      'ઉપર જમણી બાજુ <b>તમારા ફોટા/નામ</b> પર ટૅપ કરો — મેનુ ખૂલશે.',
      '<b>Daily Attendance</b> બોક્સમાં <b>Punch In — Start Shift</b> દબાવો. કામ શરૂ.',
      'સાંજે <b>Punch Out — End Shift</b> દબાવો. કન્ફર્મેશન આવશે — <b>Yes, Confirm Punch Out</b> દબાવો.',
      '⚠️ <b>મોબાઈલની Location સેટિંગ ચાલુ રાખો</b>, નહીંતર Punch In નહીં થાય.',
      'Punch In માટે ઈન્ટરનેટ જરૂરી છે — ઓફલાઈનમાં નહીં ચાલે.'
    ]},
    sketch: `┌─── Daily Attendance ────┐
│ Shift: 09:00 AM–07:00PM │
│  In: 09:12   Out: Active│
│ [ Punch Out — End Shift]│
└─────────────────────────┘`
  },
  {
    n: 3,
    icon: '📋',
    hi: { t: 'काम की लिस्ट (Tasks)', b: [
      'लॉगिन के बाद यही स्क्रीन खुलती है। काम तीन हिस्सों में बँटा है:',
      '<b>Today Task</b> — आज का और बाकी रह गया काम · <b>Tomorrow Task</b> — कल का · <b>Upcoming Task</b> — आगे का',
      '<b>बटन देखने के लिए कंपनी के नाम या काम की लाइन पर टैप करें।</b> बटन छुपे रहते हैं — यह सबसे ज़रूरी बात है।',
      'ऊपर सर्च बॉक्स में कंपनी का नाम, मोबाइल नंबर या व्यक्ति का नाम डालकर ढूँढ सकते हैं।',
      'लाल रंग का कार्ड = यह काम देर हो चुका है, ध्यान दें।'
    ]},
    gu: { t: 'કામની યાદી (Tasks)', b: [
      'લોગિન પછી આ જ સ્ક્રીન ખૂલે છે. કામ ત્રણ ભાગમાં વહેંચાયેલું છે:',
      '<b>Today Task</b> — આજનું અને બાકી રહેલું · <b>Tomorrow Task</b> — કાલનું · <b>Upcoming Task</b> — આગળનું',
      '<b>બટન જોવા માટે કંપનીના નામ કે કામની લાઈન પર ટૅપ કરો.</b> બટન છુપાયેલા હોય છે — આ સૌથી અગત્યની વાત છે.',
      'ઉપરના સર્ચ બોક્સમાં કંપનીનું નામ, મોબાઈલ નંબર કે વ્યક્તિનું નામ નાખીને શોધી શકાય.',
      'લાલ કાર્ડ = આ કામ મોડું થઈ ગયું છે, ધ્યાન આપો.'
    ]},
    sketch: `┌── Today Task (4) ───────┐
│ Apex Pharma   [Pending] │
│ Fire Ext. Refilling     │
│ 💬 No remarks logged yet│
│  ↑ tap here for buttons │
└─────────────────────────┘`
  },
  {
    n: 4,
    icon: '🔘',
    hi: { t: 'काम के बटन क्या करते हैं', b: [
      '<b>💬 Conversation</b> — ग्राहक से जो बात हुई वह लिखें (सबसे ज़्यादा इस्तेमाल होगा)',
      '<b>📞 Call</b> — ग्राहक को फ़ोन लगाएँ · <b>WhatsApp</b> — व्हाट्सएप खोलें',
      '<b>🧭 Directions</b> — गूगल मैप में रास्ता खोलें',
      '<b>&gt; Advance</b> — काम अगले स्टेज पर भेजें · <b>Status</b> — Started / In Progress / Completed',
      '<b>📅 Reschedule</b> — तारीख़ बदलें (कारण लिखना ज़रूरी) · <b>Remove</b> — एडमिन से हटाने की अनुमति मांगें'
    ]},
    gu: { t: 'કામના બટન શું કરે છે', b: [
      '<b>💬 Conversation</b> — ગ્રાહક સાથે જે વાત થઈ એ લખો (સૌથી વધુ વપરાશે)',
      '<b>📞 Call</b> — ગ્રાહકને ફોન કરો · <b>WhatsApp</b> — વોટ્સએપ ખોલો',
      '<b>🧭 Directions</b> — ગૂગલ મેપમાં રસ્તો ખોલો',
      '<b>&gt; Advance</b> — કામ આગળના સ્ટેજ પર મોકલો · <b>Status</b> — Started / In Progress / Completed',
      '<b>📅 Reschedule</b> — તારીખ બદલો (કારણ લખવું જરૂરી) · <b>Remove</b> — એડમિન પાસે કાઢવાની મંજૂરી માંગો'
    ]},
    sketch: `💬  📞  WA  🧭  ✏️  📅  ⚡  🏷️  >  🗑️
│   │   │   │   │   │   │   │   │   └ Remove
│   │   │   │   │   │   │   │   └── Advance
│   │   │   │   │   │   │   └───── Tags
│   │   │   │   │   │   └──────── Status
│   │   │   │   │   └─────────── Reschedule
└── Conversation / Call / WA / Map / Edit`
  },
  {
    n: 5,
    icon: '💬',
    hi: { t: 'बात-चीत लिखना (सबसे ज़रूरी आदत)', b: [
      '<b>💬</b> बटन दबाएँ — Discussion Log खुलेगा।',
      '<b>पहले टैग चुनें</b> (Call, WhatsApp, Meeting, Pickup…)। टैग चुने बिना लिखने का बॉक्स नहीं आएगा।',
      'फिर <b>पूरी बात लिखें</b> — क्या तय हुआ, ग्राहक ने क्या कहा, अगला कदम क्या।',
      '<b>Save</b> दबाएँ। (Ctrl+Enter से भी सेव होता है)',
      '⚠️ लिखने के बाद <b>सिर्फ़ 5 मिनट</b> तक सुधार सकते हैं। ध्यान से लिखें।',
      'इंटरनेट ज़रूरी है — ऑफ़लाइन में रिमार्क सेव नहीं होगा।'
    ]},
    gu: { t: 'વાતચીત લખવી (સૌથી જરૂરી આદત)', b: [
      '<b>💬</b> બટન દબાવો — Discussion Log ખૂલશે.',
      '<b>પહેલા ટૅગ પસંદ કરો</b> (Call, WhatsApp, Meeting, Pickup…). ટૅગ વગર લખવાનું બોક્સ નહીં આવે.',
      'પછી <b>પૂરી વાત લખો</b> — શું નક્કી થયું, ગ્રાહકે શું કહ્યું, આગળ શું કરવાનું.',
      '<b>Save</b> દબાવો. (Ctrl+Enter થી પણ સેવ થાય)',
      '⚠️ લખ્યા પછી <b>ફક્ત ૫ મિનિટ</b> સુધારી શકાય. ધ્યાનથી લખો.',
      'ઈન્ટરનેટ જરૂરી છે — ઓફલાઈનમાં રિમાર્ક સેવ નહીં થાય.'
    ]},
    sketch: `┌─── Discussion Log ──────┐
│ 1. Select Tag *         │
│    [ Call ▾ ]           │
│ 2. Discussion Details * │
│    [                  ] │
│         [  Save  ]      │
└─────────────────────────┘`
  },
  {
    n: 6,
    icon: '⚡',
    hi: { t: 'काम आगे बढ़ाना — Advance vs Status', b: [
      '<b>ये दो अलग चीज़ें हैं।</b> नए लोग यहीं गलती करते हैं:',
      '<b>Advance</b> = काम किस पड़ाव पर है (Quotation → Order → Service → Invoice …)',
      '<b>Status</b> = आपका काम कहाँ तक हुआ (Started / In Progress / <b>Completed</b>)',
      'काम <b>पूरा हुआ</b> यह बताने के लिए <b>Status → Completed</b> दबाएँ, Advance नहीं।',
      'Advance में फ़ोटो भी लगा सकते हैं — <b>Take/Select Photo</b> दबाएँ, कैमरा खुलेगा।'
    ]},
    gu: { t: 'કામ આગળ વધારવું — Advance vs Status', b: [
      '<b>આ બે અલગ વસ્તુ છે.</b> નવા લોકો આમાં જ ભૂલ કરે છે:',
      '<b>Advance</b> = કામ કયા પડાવ પર છે (Quotation → Order → Service → Invoice …)',
      '<b>Status</b> = તમારું કામ ક્યાં સુધી થયું (Started / In Progress / <b>Completed</b>)',
      'કામ <b>પૂરું થયું</b> એ બતાવવા <b>Status → Completed</b> દબાવો, Advance નહીં.',
      'Advance માં ફોટો પણ મૂકી શકાય — <b>Take/Select Photo</b> દબાવો, કેમેરા ખૂલશે.'
    ]},
    sketch: `Advance (પડાવ / पड़ाव)
  New Inquiry → Quotation → Order
  → Material → Pickup/Delivery
  → Service → Invoice → Certification

Status (સ્થિતિ / स्थिति)
  Started · In Progress · Completed ✔`
  },
  {
    n: 7,
    icon: '🌴',
    hi: { t: 'छुट्टी की अर्जी', b: [
      'मेन्यू → <b>Apply for Leave</b>',
      '<b>Leave Date</b>, <b>Leave Duration</b> (Full / Half / Short) और <b>Reason</b> भरें।',
      'छुट्टी <b>7 दिन पहले</b> डालनी होती है। अचानक ज़रूरत हो तो <b>Urgent Emergency Leave</b> पर टिक करें।',
      '<b>Submit Leave Request</b> दबाएँ। कोई "हो गया" संदेश नहीं आता — फ़ॉर्म खाली हो जाता है।',
      'देखने के लिए मेन्यू → <b>My Leave Applications</b> (Pending / Approved / Rejected)'
    ]},
    gu: { t: 'રજાની અરજી', b: [
      'મેનુ → <b>Apply for Leave</b>',
      '<b>Leave Date</b>, <b>Leave Duration</b> (Full / Half / Short) અને <b>Reason</b> ભરો.',
      'રજા <b>૭ દિવસ પહેલા</b> નાખવી પડે. અચાનક જરૂર પડે તો <b>Urgent Emergency Leave</b> પર ટિક કરો.',
      '<b>Submit Leave Request</b> દબાવો. કોઈ "થઈ ગયું" મેસેજ નથી આવતો — ફોર્મ ખાલી થઈ જાય છે.',
      'જોવા માટે મેનુ → <b>My Leave Applications</b> (Pending / Approved / Rejected)'
    ]},
    sketch: `┌── Apply for Leave ──────┐
│ Leave Date *  [ __ ]    │
│ Duration *  [ Full ▾ ]  │
│ ☐ Urgent Emergency Leave│
│ Reason * [            ] │
│ [ Submit Leave Request ]│
└─────────────────────────┘`
  },
  {
    n: 8,
    icon: '💰',
    hi: { t: 'हाज़िरी और कमाई देखना', b: [
      'मेन्यू → <b>Attendance History</b> — महीने के हिसाब से हाज़िरी, घंटे और <b>On Time / Late</b> दिखता है।',
      'मेन्यू → <b>My Earnings & Pro-Rata Salary</b> — इस महीने की कमाई, आज की कमाई, रोज़ का रेट।',
      'अगर एडवांस लिया है तो <b>Total Earned − Advance = Net Payable</b> अलग से दिखेगा।',
      '<b>आपको सिर्फ़ अपना ही हिसाब दिखता है</b>, किसी और का नहीं।'
    ]},
    gu: { t: 'હાજરી અને કમાણી જોવી', b: [
      'મેનુ → <b>Attendance History</b> — મહિના પ્રમાણે હાજરી, કલાક અને <b>On Time / Late</b> દેખાય.',
      'મેનુ → <b>My Earnings & Pro-Rata Salary</b> — આ મહિનાની કમાણી, આજની કમાણી, રોજનો દર.',
      'એડવાન્સ લીધું હોય તો <b>Total Earned − Advance = Net Payable</b> અલગ દેખાશે.',
      '<b>તમને ફક્ત તમારો જ હિસાબ દેખાય</b>, બીજા કોઈનો નહીં.'
    ]},
    sketch: `┌─────────────────────────┐
│ THIS MONTH   ₹ 18,400   │
│ TODAY         ₹    800  │
│ DAILY RATE    ₹    800  │
└─────────────────────────┘`
  },
  {
    n: 9,
    icon: '📶',
    hi: { t: 'इंटरनेट न हो तो', b: [
      'ऊपर <b>लाल पट्टी</b> दिखेगी — "You are offline"। ऊपर <b>Offline Mode</b> भी लिखा आएगा।',
      '<b>ऑफ़लाइन में चलेगा:</b> Advance Stage, Reschedule — ये फ़ोन में सेव हो जाते हैं।',
      '<b>ऑफ़लाइन में नहीं चलेगा:</b> Punch In/Out, रिमार्क लिखना, Status बदलना, छुट्टी की अर्जी।',
      'इंटरनेट आने पर <b>Sync Now</b> दबाएँ — रुका हुआ काम अपने आप भेज दिया जाएगा।'
    ]},
    gu: { t: 'ઈન્ટરનેટ ન હોય તો', b: [
      'ઉપર <b>લાલ પટ્ટી</b> દેખાશે — "You are offline". ઉપર <b>Offline Mode</b> પણ લખેલું આવશે.',
      '<b>ઓફલાઈનમાં ચાલશે:</b> Advance Stage, Reschedule — એ ફોનમાં સેવ થઈ જાય છે.',
      '<b>ઓફલાઈનમાં નહીં ચાલે:</b> Punch In/Out, રિમાર્ક લખવું, Status બદલવું, રજાની અરજી.',
      'ઈન્ટરનેટ આવે ત્યારે <b>Sync Now</b> દબાવો — અટકેલું કામ આપોઆપ મોકલાઈ જશે.'
    ]},
    sketch: `┌─────────────────────────┐
│ ⚠ You are offline.      │
│   (3 queued)  [Sync Now]│
└─────────────────────────┘`
  },
  {
    n: 10,
    icon: '📷',
    hi: { t: 'अपनी फ़ोटो और पासवर्ड', b: [
      'मेन्यू में ऊपर <b>📷 Upload Profile Photo</b> — फ़ोटो चुनें, खींचकर सेट करें, सेव करें।',
      'फ़ोटो <b>एडमिन की मंज़ूरी</b> के बाद लगेगी।',
      '<b>View ID Card</b> — अपना पहचान पत्र देखें।',
      'मेन्यू → <b>Change My Password</b>। नियम: कम से कम 8 अक्षर, एक अक्षर, एक अंक और एक चिह्न (जैसे @ या #)।'
    ]},
    gu: { t: 'તમારો ફોટો અને પાસવર્ડ', b: [
      'મેનુમાં ઉપર <b>📷 Upload Profile Photo</b> — ફોટો પસંદ કરો, ખેંચીને સેટ કરો, સેવ કરો.',
      'ફોટો <b>એડમિનની મંજૂરી</b> પછી લાગશે.',
      '<b>View ID Card</b> — તમારું ઓળખપત્ર જુઓ.',
      'મેનુ → <b>Change My Password</b>. નિયમ: ઓછામાં ઓછા ૮ અક્ષર, એક અક્ષર, એક આંકડો અને એક ચિહ્ન (જેમ કે @ કે #).'
    ]},
    sketch: `┌─────────────────────────┐
│  [ફોટો]  Nilesh Padaya  │
│  ID: STAFF005 • Staff   │
│  📷 Upload Profile Photo│
│  [ View ID Card ]       │
└─────────────────────────┘`
  }
];

/** The mistakes a new employee reliably makes in week one. */
const GOTCHAS = [
  { hi: 'कार्ड पर टैप किए बिना बटन नहीं दिखते।', gu: 'કાર્ડ પર ટૅપ કર્યા વગર બટન દેખાતા નથી.' },
  { hi: 'रिमार्क लिखने से पहले टैग चुनना पड़ता है।', gu: 'રિમાર્ક લખતાં પહેલાં ટૅગ પસંદ કરવો પડે.' },
  { hi: 'रिमार्क सिर्फ़ 5 मिनट तक सुधर सकता है।', gu: 'રિમાર્ક ફક્ત ૫ મિનિટ સુધી સુધારી શકાય.' },
  { hi: '"काम पूरा" के लिए Status → Completed, Advance नहीं।', gu: '"કામ પૂરું" માટે Status → Completed, Advance નહીં.' },
  { hi: 'Remove से काम हटता नहीं — एडमिन को अर्जी जाती है।', gu: 'Remove થી કામ હટતું નથી — એડમિનને અરજી જાય છે.' },
  { hi: 'छुट्टी भेजने पर कोई पक्का संदेश नहीं आता — My Leave Applications में देखें।', gu: 'રજા મોકલ્યા પછી કોઈ ખાતરીનો મેસેજ નથી આવતો — My Leave Applications માં જુઓ.' },
  { hi: 'नीचे स्क्रॉल करने पर फ़िल्टर छुप जाते हैं — ऊपर आएँ।', gu: 'નીચે સ્ક્રોલ કરો તો ફિલ્ટર છુપાઈ જાય — ઉપર આવો.' },
  { hi: 'Location सेटिंग बंद हो तो Punch In और Advance नहीं चलेंगे।', gu: 'Location સેટિંગ બંધ હોય તો Punch In અને Advance નહીં ચાલે.' }
];

function lessonHtml(L) {
  const li = (arr) => arr.map(x => `<li>${x}</li>`).join('');
  return `
  <section class="lesson">
    <h2><span class="num">${L.n}</span> <span class="ico">${L.icon}</span>
      <span class="titles"><span class="gu">${L.gu.t}</span><span class="sep">·</span><span class="hi">${L.hi.t}</span></span>
    </h2>
    <div class="cols">
      <div class="col">
        <div class="lang">ગુજરાતી</div>
        <ul>${li(L.gu.b)}</ul>
      </div>
      <div class="col">
        <div class="lang">हिन्दी</div>
        <ul>${li(L.hi.b)}</ul>
      </div>
      ${L.sketch ? `<div class="shot"><div class="lang">સ્ક્રીન / स्क्रीन</div><pre>${L.sketch}</pre></div>` : ''}
    </div>
  </section>`;
}

const html = `<!doctype html>
<html lang="hi">
<head>
<meta charset="utf-8">
<title>Expert Safety Solutions — Application Guide (हिन्दी / ગુજરાતી)</title>
<style>
  @page { size: A4; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Nirmala UI", "Noto Sans", "Segoe UI", Arial, sans-serif;
    color: #17212f; margin: 0; font-size: 10.5pt; line-height: 1.5;
  }
  .cover { text-align: center; padding: 28mm 0 10mm; page-break-after: always; }
  .cover img { width: 80px; border-radius: 12px; margin-bottom: 10px; }
  .cover h1 { font-size: 22pt; margin: 6px 0 2px; color: #0f172a; }
  .cover .sub { font-size: 12pt; color: #64748b; font-weight: 600; }
  .cover .badge {
    display: inline-block; margin-top: 16px; padding: 7px 18px; border-radius: 999px;
    background: #fff1f2; color: #9f1239; font-weight: 700; font-size: 10.5pt;
    border: 1.5px solid #fecdd3;
  }
  .cover .rev { margin-top: 10px; font-size: 9.5pt; color: #64748b; font-weight: 600; }
  .cover .who { margin-top: 18px; font-size: 11pt; color: #334155; }
  .cover .toc { margin: 20px auto 0; max-width: 340px; text-align: left; font-size: 10pt; color: #475569; }
  .cover .toc div { padding: 2px 0; }

  .lesson { page-break-inside: avoid; margin-bottom: 7mm; border: 1.5px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  h2 { margin: 0; padding: 7px 10px; background: #f8fafc; border-bottom: 1.5px solid #e2e8f0;
       font-size: 12pt; display: flex; align-items: center; gap: 8px; }
  .num { background: #9f1239; color: #fff; width: 22px; height: 22px; border-radius: 50%;
         display: inline-flex; align-items: center; justify-content: center; font-size: 10pt; flex: none; }
  .ico { font-size: 13pt; }
  .titles { font-size: 11.5pt; }
  .sep { color: #cbd5e1; margin: 0 5px; }
  .gu { color: #0f766e; }
  .hi { color: #0f172a; }

  .cols { display: flex; gap: 0; }
  .col { flex: 1; padding: 8px 10px; }
  .col + .col { border-left: 1px dashed #cbd5e1; }
  .shot { width: 210px; flex: none; border-left: 1px dashed #cbd5e1; padding: 8px 8px; background: #fbfdff; }
  .lang { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .6px;
          color: #94a3b8; margin-bottom: 4px; }
  ul { margin: 0; padding-left: 15px; }
  li { margin-bottom: 3.5px; }
  pre { margin: 0; font-family: Consolas, "Courier New", monospace; font-size: 7.2pt;
        line-height: 1.35; color: #334155; white-space: pre; }

  .gotchas { page-break-inside: avoid; border: 2px solid #fbbf24; border-radius: 10px;
             background: #fffbeb; padding: 10px 12px; margin-top: 6mm; }
  .gotchas h3 { margin: 0 0 6px; font-size: 12pt; color: #92400e; }
  .gotchas table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  .gotchas td { padding: 4px 6px; border-bottom: 1px solid #fde68a; vertical-align: top; }
  .gotchas td:first-child { width: 50%; }

  .help { margin-top: 6mm; padding: 10px 12px; border-radius: 10px; background: #f0fdf4;
          border: 1.5px solid #bbf7d0; font-size: 10pt; }
  .help b { color: #166534; }
  .foot { margin-top: 5mm; text-align: center; font-size: 8.5pt; color: #94a3b8; }
</style>
</head>
<body>

<div class="cover">
  ${logoDataUri() ? `<img src="${logoDataUri()}" alt="Expert Safety Solutions">` : ''}
  <h1>Expert Safety Solutions</h1>
  <div class="sub">Application Guide</div>
  <div class="badge">हिन्दी + ગુજરાતી · नए स्टाफ़ के लिए / નવા સ્ટાફ માટે</div>
  <div class="rev">આવૃત્તિ / संस्करण: <b>${BUILD_DATE}</b></div>
  <div class="who">
    <b>આ ગાઈડ કોના માટે:</b> નવા ફિલ્ડ સ્ટાફ માટે — રોજનું કામ એપમાં કઈ રીતે કરવું.<br>
    <b>यह गाइड किसके लिए:</b> नए फ़ील्ड स्टाफ़ के लिए — रोज़ का काम ऐप में कैसे करें।
  </div>
  <div class="toc">
    ${LESSONS.map(l => `<div>${l.n}. ${l.icon} ${l.gu.t} / ${l.hi.t}</div>`).join('')}
  </div>
</div>

${LESSONS.map(lessonHtml).join('')}

<div class="gotchas">
  <h3>⚠️ આ ૮ વાત યાદ રાખો / ये 8 बातें याद रखें</h3>
  <table>
    ${GOTCHAS.map(g => `<tr><td>${g.gu}</td><td>${g.hi}</td></tr>`).join('')}
  </table>
</div>

<div class="help">
  <b>મદદ જોઈએ? / मदद चाहिए?</b><br>
  એપમાં ઉપર <b>Help</b> બટન દબાવો, અથવા ફોન કરો / ऐप में ऊपर <b>Help</b> बटन दबाएँ, या फ़ोन करें:<br>
  <b>Director:</b> 8460 699 569 &nbsp;·&nbsp; <b>Office:</b> 9429 980 244
</div>

<div class="foot">
  Expert Safety Solutions · Application Guide · ${BUILD_DATE} · આ ગાઈડ તમારા મોબાઈલમાં રાખો / इस गाइड को अपने मोबाइल में रखें
</div>

</body>
</html>`;

/**
 * Renders the HTML to a real PDF with headless Chrome.
 *
 * Chrome is used rather than a PDF library for the reason in the header: it embeds the system's
 * Nirmala UI face, which carries both Devanagari and Gujarati glyphs. A PDF built with jsPDF's
 * bundled fonts shows empty boxes for every Hindi and Gujarati character — verified, not assumed.
 *
 * Best-effort: if no Chrome/Edge is installed the HTML is still written and the operator can print
 * it by hand, so a missing browser degrades the output rather than failing the build.
 */
function renderPdf(htmlPath, pdfPath) {
  const { execFileSync } = require('child_process');
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ];
  const browser = candidates.find(p => fs.existsSync(p));
  if (!browser) return { ok: false, reason: 'no Chrome or Edge found' };

  try {
    execFileSync(browser, [
      '--headless',
      '--disable-gpu',
      // Chrome's own header/footer would stamp the file:// path and a page number over the
      // layout; the document carries its own footer already.
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { stdio: 'pipe', timeout: 120000 });
    return fs.existsSync(pdfPath)
      ? { ok: true, bytes: fs.statSync(pdfPath).size }
      : { ok: false, reason: 'browser produced no file' };
  } catch (err) {
    return { ok: false, reason: String(err.stderr || err.message).trim().split('\n')[0] };
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, html, 'utf8');

const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(0);
console.log(`\n  HTML: docs/training/${path.basename(OUT_FILE)}  (${kb} KB)`);

const PDF_FILE = OUT_FILE.replace(/\.html$/, '.pdf');
const pdf = renderPdf(OUT_FILE, PDF_FILE);

if (pdf.ok) {
  console.log(`  PDF : docs/training/${path.basename(PDF_FILE)}  (${(pdf.bytes / 1024).toFixed(0)} KB)`);
} else {
  console.log(`  PDF : not generated (${pdf.reason})`);
  console.log('        Open the HTML in Chrome and use Ctrl+P → Save as PDF instead.');
}

console.log(`\n  Lessons: ${LESSONS.length}   Reminders: ${GOTCHAS.length}   Languages: Gujarati + Hindi`);
console.log(`  Version: ${BUILD_DATE} (shown on the cover, in the filename and in the footer)\n`);
console.log('  Screens are drawn as sketches, not screenshots — a screenshot would carry real');
console.log('  customer names and numbers into a document that gets forwarded around.\n');
