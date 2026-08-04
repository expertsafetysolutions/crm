// Guided-tour scripts. Two independent lists — Staff and Admin see genuinely different apps
// (see CLAUDE.md directory map), so the steps are not derived from one shared list.
//
// Step shape:
//   id             matches a data-tour="<id>" attribute on the real element
//   requiresTab    dashboard tab to switch to first (TOUR_NAVIGATE_TAB event) — null if already visible
//   requiresPopup  'PROFILE_POPUP' to open the profile popup first (reuses OPEN_STAFF_PROFILE_POPUP)
//   requiresExpand id of a TOUR_EXPAND_TARGET the dashboard should act on first (e.g. expand the
//                  first task card so its icon row exists in the DOM) — null if nothing to expand
//   permission     key into AuthContext's `permissions` map; step is dropped if permissions[key]?.view is falsy
//   placement      preferred tooltip side; TourOverlay flips it if it doesn't fit
//   title/body     { en, gu }
//
// A step whose target never appears (e.g. this task has no phone number, so Call isn't rendered)
// is never silently skipped — TourOverlay shows a waiting card with an active Skip button and
// lets the user decide. See TourOverlay.jsx's FIND_TIMEOUT_MS comment for why.

export const staffTourSteps = [
  {
    id: 'welcome',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'center',
    title: { en: 'Welcome to Expert Safety Solutions', gu: 'Expert Safety Solutions માં આપનું સ્વાગત છે' },
    body: {
      en: "Let's take a quick tour of the app so you know what every button does. You can replay this anytime from the Help menu.",
      gu: 'ચાલો એપ્લિકેશનની ટૂંકી ટૂર લઈએ જેથી તમને દરેક બટન શું કરે છે તે ખબર પડે. તમે આ ટૂર ગમે ત્યારે Help મેનુમાંથી ફરી જોઈ શકો છો.',
    },
  },
  {
    id: 'staff-tasks-header',
    requiresTab: 'TASKS',
    requiresPopup: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Your Task List', gu: 'તમારું ટાસ્ક લિસ્ટ' },
    body: {
      en: 'This is your home screen — every job assigned to you shows up here. Search by customer name or filter by status using this bar.',
      gu: 'આ તમારી હોમ સ્ક્રીન છે — તમને સોંપાયેલ દરેક કામ અહીં દેખાય છે. આ બાર વડે ગ્રાહકના નામથી શોધો અથવા સ્ટેટસ પ્રમાણે ફિલ્ટર કરો.',
    },
  },
  {
    id: 'staff-icon-conversation',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Conversation / Remark', gu: 'Conversation / રિમાર્ક' },
    body: {
      en: 'Tap this to log a call, visit, or any conversation with the customer as a timestamped remark on this task.',
      gu: 'ગ્રાહક સાથે થયેલ ફોન, વિઝિટ અથવા કોઈપણ વાતચીતને આ ટાસ્ક પર સમય સાથે રિમાર્ક તરીકે નોંધવા માટે આના પર ટેપ કરો.',
    },
  },
  {
    id: 'staff-icon-call',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Call Customer', gu: 'ગ્રાહકને ફોન કરો' },
    body: {
      en: 'Directly dials the customer\'s saved number. Only shows up when a phone number exists for this task.',
      gu: 'ગ્રાહકનો સેવ કરેલો નંબર સીધો ડાયલ કરે છે. આ ટાસ્ક માટે ફોન નંબર હોય ત્યારે જ દેખાય છે.',
    },
  },
  {
    id: 'staff-icon-whatsapp',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'WhatsApp Chat', gu: 'WhatsApp ચેટ' },
    body: {
      en: 'Opens WhatsApp with the customer so you can send messages, photos, or documents.',
      gu: 'ગ્રાહક સાથે WhatsApp ખોલે છે જેથી તમે મેસેજ, ફોટો અથવા ડોક્યુમેન્ટ મોકલી શકો.',
    },
  },
  {
    id: 'staff-icon-directions',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Directions', gu: 'દિશા (Directions)' },
    body: {
      en: 'Opens Google Maps directions straight to the customer\'s site.',
      gu: 'ગ્રાહકના સ્થળ સુધીની Google Maps દિશા સીધી ખોલે છે.',
    },
  },
  {
    id: 'staff-icon-edit',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Edit Task', gu: 'ટાસ્ક એડિટ કરો' },
    body: {
      en: 'Change task details like description, assigned staff, or scheduled date.',
      gu: 'ટાસ્કની વિગતો જેમ કે વર્ણન, સોંપાયેલ સ્ટાફ અથવા નિર્ધારિત તારીખ બદલો.',
    },
  },
  {
    id: 'staff-icon-reschedule',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Reschedule', gu: 'ફરીથી શેડ્યૂલ કરો' },
    body: {
      en: 'Move this task to a different date if today isn\'t possible.',
      gu: 'જો આજે શક્ય ન હોય તો આ ટાસ્કને બીજી તારીખ પર ખસેડો.',
    },
  },
  {
    id: 'staff-icon-status',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Change Status', gu: 'સ્ટેટસ બદલો' },
    body: {
      en: 'Update the task\'s status — Pending, Started, In Progress, or Completed — as work progresses.',
      gu: 'કામ આગળ વધે તેમ ટાસ્કનું સ્ટેટસ અપડેટ કરો — Pending, Started, In Progress અથવા Completed.',
    },
  },
  {
    id: 'staff-icon-tags',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Tags', gu: 'ટેગ (Tags)' },
    body: {
      en: 'Add or view labels on this task for quick filtering later, e.g. "Urgent" or "AMC".',
      gu: 'પછીથી ઝડપી ફિલ્ટર માટે આ ટાસ્ક પર લેબલ ઉમેરો અથવા જુઓ, જેમ કે "Urgent" અથવા "AMC".',
    },
  },
  {
    id: 'staff-icon-jobcard',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Job Card', gu: 'જોબ કાર્ડ' },
    body: {
      en: 'Opens or creates the workshop job card for this task — only appears once the job reaches a production stage.',
      gu: 'આ ટાસ્ક માટે વર્કશોપ જોબ કાર્ડ ખોલે અથવા બનાવે છે — કામ production stage પર પહોંચે ત્યારે જ દેખાય છે.',
    },
  },
  {
    id: 'staff-icon-advance',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Advance Stage', gu: 'સ્ટેજ આગળ વધારો' },
    body: {
      en: 'Pushes this task to its next workflow stage, e.g. from Material Arrangement to Delivery.',
      gu: 'આ ટાસ્કને તેના આગલા workflow સ્ટેજ પર લઈ જાય છે, જેમ કે Material Arrangement થી Delivery.',
    },
  },
  {
    id: 'staff-icon-remove',
    requiresTab: 'TASKS',
    requiresPopup: null,
    requiresExpand: 'staff-task-row-actions',
    permission: null,
    placement: 'bottom',
    title: { en: 'Remove Task', gu: 'ટાસ્ક દૂર કરો' },
    body: {
      en: 'Deletes this task. Use carefully — this cannot be undone from here.',
      gu: 'આ ટાસ્ક ડિલીટ કરે છે. કાળજીપૂર્વક વાપરો — આ અહીંથી પાછું લાવી શકાતું નથી.',
    },
  },
  {
    id: 'navbar-profile-btn',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Your Profile Menu', gu: 'તમારું પ્રોફાઇલ મેનુ' },
    body: {
      en: 'Tap your photo/initial here to open your profile menu — Attendance, Leave, and Earnings all live inside it.',
      gu: 'તમારો પ્રોફાઇલ મેનુ ખોલવા માટે અહીં તમારો ફોટો/નામનો પહેલો અક્ષર ટેપ કરો — Attendance, Leave અને Earnings બધું આમાં જ છે.',
    },
  },
  {
    id: 'staff-profile-menu-attendance',
    requiresTab: null,
    requiresPopup: 'PROFILE_POPUP',
    permission: null,
    placement: 'left',
    title: { en: 'Attendance History', gu: 'હાજરીનો ઇતિહાસ' },
    body: {
      en: 'See your daily punch-in/punch-out history and working hours here.',
      gu: 'તમારો દરરોજનો પંચ-ઇન/પંચ-આઉટ ઇતિહાસ અને કામના કલાકો અહીં જુઓ.',
    },
  },
  {
    id: 'staff-profile-menu-apply-leave',
    requiresTab: null,
    requiresPopup: 'PROFILE_POPUP',
    permission: null,
    placement: 'left',
    title: { en: 'Apply for Leave', gu: 'રજા માટે અરજી કરો' },
    body: {
      en: 'Need a day off? Submit a leave request here — your admin will approve or reject it.',
      gu: 'રજા જોઈએ છે? અહીંથી રજા માટે અરજી કરો — તમારા એડમિન તેને મંજૂર અથવા નામંજૂર કરશે.',
    },
  },
  {
    id: 'staff-profile-menu-leave-apps',
    requiresTab: null,
    requiresPopup: 'PROFILE_POPUP',
    permission: null,
    placement: 'left',
    title: { en: 'My Leave Applications', gu: 'મારી રજા અરજીઓ' },
    body: {
      en: 'Track the status of every leave request you\'ve submitted — pending, approved, or rejected.',
      gu: 'તમે કરેલી દરેક રજા અરજીનું સ્ટેટસ ટ્રેક કરો — પેન્ડિંગ, મંજૂર અથવા નામંજૂર.',
    },
  },
  {
    id: 'staff-profile-menu-earnings',
    requiresTab: null,
    requiresPopup: 'PROFILE_POPUP',
    permission: null,
    placement: 'left',
    title: { en: 'My Earnings', gu: 'મારી કમાણી' },
    body: {
      en: 'Check your pro-rata salary calculation based on days worked this month.',
      gu: 'આ મહિને કામ કરેલા દિવસોના આધારે તમારો પગાર (pro-rata) અહીં જુઓ.',
    },
  },
  {
    id: 'navbar-help-btn',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Need Help Later?', gu: 'પછી મદદ જોઈએ છે?' },
    body: {
      en: 'You can call the office directly from here, and restart this tour anytime.',
      gu: 'તમે અહીંથી સીધો ઓફિસને ફોન કરી શકો છો, અને આ ટૂર ગમે ત્યારે ફરી શરૂ કરી શકો છો.',
    },
  },
];

export const adminTourSteps = [
  {
    id: 'welcome',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'center',
    title: { en: 'Welcome, Admin', gu: 'આપનું સ્વાગત છે, એડમિન' },
    body: {
      en: "Here's a quick walkthrough of every management module. You can replay this anytime from the Help menu.",
      gu: 'દરેક મેનેજમેન્ટ મોડ્યુલની ટૂંકી ટૂર અહીં છે. તમે આ ટૂર ગમે ત્યારે Help મેનુમાંથી ફરી જોઈ શકો છો.',
    },
  },
  {
    id: 'admin-overview-tab',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Overview & Menu', gu: 'ઓવરવ્યૂ અને મેનુ' },
    body: {
      en: 'Tap Menu anytime to see every module and jump straight to it.',
      gu: 'કોઈ પણ સમયે Menu પર ટેપ કરો — બધા મોડ્યુલ જુઓ અને સીધા ત્યાં જાવ.',
    },
  },
  {
    id: 'admin-card-pipeline',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Task Pipeline & Work Orders', gu: 'ટાસ્ક પાઇપલાઇન અને વર્ક ઓર્ડર' },
    body: {
      en: 'Assign tasks, track work order progress, handle remarks, and manage client visits.',
      gu: 'ટાસ્ક સોંપો, વર્ક ઓર્ડરની પ્રગતિ ટ્રેક કરો, રિમાર્ક હેન્ડલ કરો અને ક્લાયન્ટ વિઝિટ મેનેજ કરો.',
    },
  },
  {
    id: 'admin-card-staff',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Staff Roster, Salary & Scope', gu: 'સ્ટાફ રોસ્ટર, પગાર અને પરવાનગીઓ' },
    body: {
      en: 'Manage staff accounts, set daily salary rates, and control what each person can see or do.',
      gu: 'સ્ટાફ એકાઉન્ટ મેનેજ કરો, દૈનિક પગાર દર સેટ કરો, અને દરેક વ્યક્તિ શું જોઈ કે કરી શકે તે નક્કી કરો.',
    },
  },
  {
    id: 'admin-card-customers',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Client Database & CRM', gu: 'ક્લાયન્ટ ડેટાબેઝ અને CRM' },
    body: {
      en: 'The full customer directory — contacts, equipment on site, and interaction history.',
      gu: 'સંપૂર્ણ ગ્રાહક યાદી — સંપર્કો, સાઇટ પરના સાધનો અને વાતચીતનો ઇતિહાસ.',
    },
  },
  {
    id: 'admin-card-attendance',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Attendance & Payroll', gu: 'હાજરી અને પગાર' },
    body: {
      en: 'Review punch-in/out records, approve leave requests, and manage payroll for every staff member.',
      gu: 'પંચ-ઇન/આઉટ રેકોર્ડ જુઓ, રજા અરજીઓ મંજૂર કરો, અને દરેક સ્ટાફના પગારનું સંચાલન કરો.',
    },
  },
  {
    id: 'admin-card-logs',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Field GPS Activity Logs', gu: 'ફિલ્ડ GPS એક્ટિવિટી લોગ' },
    body: {
      en: 'Live location and activity trail for field staff — see where and when work happened.',
      gu: 'ફિલ્ડ સ્ટાફ માટે લાઇવ લોકેશન અને એક્ટિવિટીનો ટ્રેલ — કામ ક્યાં અને ક્યારે થયું તે જુઓ.',
    },
  },
  {
    id: 'admin-card-certificates',
    requiresTab: null,
    requiresPopup: null,
    requiresExpand: 'admin-header',
    permission: null,
    placement: 'bottom',
    title: { en: 'Certificate Generator & Compliance', gu: 'સર્ટિફિકેટ જનરેટર અને કમ્પ્લાયન્સ' },
    body: {
      en: 'Generate and manage compliance certificates and service reports from here.',
      gu: 'અહીંથી કમ્પ્લાયન્સ સર્ટિફિકેટ અને સર્વિસ રિપોર્ટ બનાવો અને મેનેજ કરો.',
    },
  },
  {
    id: 'navbar-view-switcher',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Switch to Staff View', gu: 'સ્ટાફ વ્યૂ પર જાઓ' },
    body: {
      en: 'As Admin you can switch to the Staff dashboard anytime to see the app the way field staff do.',
      gu: 'એડમિન તરીકે તમે ગમે ત્યારે Staff dashboard પર જઈ શકો છો, જેથી ફિલ્ડ સ્ટાફ એપ કેવી રીતે જુએ છે તે તપાસી શકાય.',
    },
  },
  {
    id: 'navbar-help-btn',
    requiresTab: null,
    requiresPopup: null,
    permission: null,
    placement: 'bottom',
    title: { en: 'Need Help Later?', gu: 'પછી મદદ જોઈએ છે?' },
    body: {
      en: 'Direct support numbers are always here, and you can restart this tour anytime.',
      gu: 'ડાયરેક્ટ સપોર્ટ નંબર હંમેશા અહીં છે, અને તમે આ ટૂર ગમે ત્યારે ફરી શરૂ કરી શકો છો.',
    },
  },
];

// Drops steps whose declared permission the viewer doesn't have `view` access to. Role-specific
// script selection happens by the caller picking staffTourSteps vs adminTourSteps.
export function getStepsForRole(role, permissions) {
  const steps = role === 'Admin' ? adminTourSteps : staffTourSteps;
  return steps.filter(step => {
    if (!step.permission) return true;
    return !!permissions?.[step.permission]?.view;
  });
}
