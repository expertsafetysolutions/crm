# Expert Safety Solutions — Field Service & CRM PWA

Full-stack Field Service & CRM platform for a fire-safety-equipment business. Orchestrates the whole commercial cycle: **Inquiry → Quotation → Order → Workshop Job Card → Delivery Challan → Certificate → Invoice → Payment**, plus staff attendance/payroll, leave, and equipment/certificate registries. Offline-first PWA for field and workshop staff.

## Tech Stack

- **Frontend** (`/client`): React 18 + Vite 5 + Tailwind CSS 3. PWA with a hand-written service worker (`public/sw.js`, stale-while-revalidate + network-first `/api` GET caching) and `idb` for an IndexedDB offline action queue. `html2canvas` + `jspdf` for PDF generation, `qrcode.react` for QR verification codes, `papaparse` for CSV import/export, `tesseract.js` (lazy-loaded) for on-device OCR.
- **Backend** (`/server`): Node.js + Express 4. JWT auth (`jsonwebtoken`), `bcryptjs` for password hashing, Mongoose 9 → MongoDB Atlas.
- **Deployment**: Vercel. `api/index.js` re-exports the Express `app` as a serverless function; `vercel.json` rewrites `/api/*` there and everything else to the SPA `index.html`. `vercel-build` = `npm run build` → builds `/client` only.
- No TypeScript, no test framework, no CI, no linter config. Verification is manual scripts + `npm run build`.

## Directory Map

```
client/src/
  pages/AdminDashboard.jsx        ~9200 lines — tabbed Admin SPA, the bulk of the frontend
  pages/StaffDashboard.jsx        ~5700 lines — field-staff SPA (TASKS/ATTENDANCE tabs)
  pages/JobCardPage.jsx           Workshop job card: INWARD + SERVICE tabs, offline-tolerant
  pages/ChallanBuilderPage.jsx    Delivery challan draft → issue, manual numbering
  pages/ChallanListPage.jsx       Challan register
  pages/CustomerPriceListPage.jsx Per-customer remembered rates
  pages/CertificateComplianceGeneratorPage.jsx  ~3850 lines — writes Document_Registry
  pages/CertificateGeneratorPage.jsx            ~2230 lines — SERVICE REPORTS despite the name;
                                                writes Service_Reports, not certificates
  pages/QuotationBuilderPage.jsx / QuotationListPage.jsx / SalesDocumentsPage.jsx
  pages/InventoryPage.jsx / QuotationSettingsPage.jsx / DocSettingsPage.jsx / StaffPermissionsPage.jsx
  pages/PurchasePage.jsx          Vendors / enquiries / orders / receiving / payments, one tabbed screen
  pages/EquipmentCategoriesPage.jsx  Admin UI for Equipment_Category_Master (Code + checkpoint ids locked)
  pages/FieldVisitPage.jsx / Login.jsx

  components/CollapsibleSection.jsx   Auto-hide primitive: a completed section folds to a summary row
  components/jobcard/                 Inward tab, Service tab, checklist cells, parts editor, recheck modal,
                                      StandbyIssueModal (loaner issue, reuses EuidScanner)
  components/DeliveryPODModal.jsx     Signature + geo-stamped photos; per-unit standby return / retention
  components/EuidScanner.jsx          OCR with an always-visible text input (typing is the fast path)
  components/QuotationPdfTemplate.jsx One A4 template for QUOTATION / PI / INVOICE / CHALLAN
  components/ClientEquipmentModal.jsx, Navbar.jsx, OfflineBanner.jsx, ErrorBoundary.jsx

  context/AuthContext.jsx     Auth state, localStorage persistence, offline sync, staff impersonation,
                              `permissions` + `canSeeMoney` (ANDed across real + impersonated identity)
  utils/offlineQueue.js       IndexedDB queue + flushOfflineQueue → POST /api/sync/batch
  utils/moneyDisplay.js       useMoneyVisible() hook — client half of the price masking
  utils/jobCardSchema.js      Checkpoint→part map, capacity normalisation, summary helpers
  utils/reportTypeSchemas.js  Column/checkpoint engine for every report module
  utils/pdfGenerator.js       Shared html2canvas + jsPDF pipeline
  utils/geoWatermark.js       Burns GPS + timestamp into photo pixels (survives sharing)
  utils/imageCompression.js, gpsHelper.js, dateUtils.js, quotationUtils.js

server/src/
  server.js                   Bootstrap, public /api/verify-certificate/:guid, cron routes,
                              auto-attendance-close job
  routes/authRoutes.js        POST /api/auth/login, GET /api/auth/me, authenticateToken middleware.
                              Both return `Effective_Permissions` — the RESOLVED map, not the raw one
  routes/apiRoutes.js         ~4200 lines — everything else, all behind authenticateToken
  routes/purchaseRoutes.js    Procurement, mounted separately to keep apiRoutes from growing further.
                              Re-applies authenticateToken AND moneyMask — it inherits neither
  routes/inquiryRoutes.js     Public /inquiry engine. MUST mount before apiRouter (auth gate).
                              POST /inquiry + GET /inquiry/config are public; the rest re-applies
                              authenticateToken, which it inherits from nothing
  utils/permissions.js        Module permissions: quotation | inventory | jobcard | taskstage
                              | finance | purchase
  utils/inquiryValidator.js   Sanitises the one payload that arrives from an anonymous stranger
  utils/moneyMask.js          Strips rates/amounts from responses without `finance:view`
  utils/gstUtils.js           GSTIN validation, tax split, document totals
  services/sheetsService.js   THE data layer (Mongoose, despite the name). 36 collections,
                              3s cache, generic getTab/insertRow/updateRow/deleteRow
  services/workflowEngine.js  Task stage machine + department hand-offs + 11-month recurring
  services/quotationEngine.js Quotation state machine + document numbering
  services/conversionService.js  Quotation → PI → Invoice (copies frozen figures, never re-prices)
  services/jobCardService.js  Workshop intake, parts fitting, recheck guard, standby issue/return/retain
  services/challanService.js  Grouping, challan issue, certificate prefill, challan → invoice
  services/purchaseService.js Vendors, RFQ, quote comparison (L1/L2/L3), PO, GRN, 3-way match,
                              vendor-rate-plus-margin pricing
  services/landedCostService.js  Freight apportionment by value + moving-average costing
  services/priceListService.js   Self-building per-customer rate memory
  services/equipmentCategoryService.js  Admin-editable categories + inward checkpoints
  services/inquiryService.js  Public lead ingestion: mobile-dedupe, customer, lead task,
                              auto-draft quotation. Never overwrites an existing customer
  services/inquiryDispatch.js Dual internal alert (ON) + customer thank-you (OFF by default)
                              + the 1-click Send Company Profile action
  services/captchaService.js  Turnstile / reCAPTCHA v3. Skipped when unconfigured; fails OPEN
                              on a provider outage, never on a rejection
  services/inventoryService.js, dispatchService.js, emailService.js, whatsappService.js,
  services/quotationCronService.js, attendanceService.js, pushService.js

  services/mongoService.js    DEAD CODE — near-duplicate of sheetsService.js, nothing requires it.
                              Safe to delete, but ask before removing.

server/tests/
  verifyPhases.js             `npm run verify` — READ-ONLY checks against the real database
  testWorkflow.js             `npm run test:workflow` — WRITES real tasks; seeded data only
```

## Data Model (Mongoose, all `{strict: false}`)

Registered in one map at `sheetsService.js:10-56`.

**Core**: `Staff_Master`, `Customer_Master`, `Task_Master`, `Activity_Logs`, `Attendance_Log`, `Leave_Requests`, `Customer_Interactions`, `Salary_Advances`
**Documents**: `Document_Registry` (certificates), `Service_Reports`, `Certificate_Type_Master`, `Document_Settings`
**Equipment**: `Equipment_Master`, `Client_Equipment_Master`, `Equipment_Category_Master`
**Sales**: `Quotation_Settings`, `Item_Master`, `Quotation_Master`, `PI_Master`, `Sales_Invoice_Master`, `Customer_Price_List`
**Workshop**: `Job_Card_Master`, `Job_Card_Item`, `Delivery_Challan_Master`
**Purchase**: `Vendor_Master`, `Purchase_RFQ`, `Purchase_Quote`, `Purchase_Order`, `Goods_Receipt`
**Infra**: `Inventory_Master`, `Stock_Transactions`, `Counter_Master`, `Media_Store`, `Tag_Master`, `Field_Visits`, `Notification_Settings`

`Purchase_Quote` is its own collection rather than an array on the RFQ for the same reason
`Job_Card_Item` is separate from its header: vendors reply independently and `updateRow` only does
`$set`, so two replies arriving together would clobber each other.

Field naming is inconsistent by design: PascalCase/Snake_Case Sheet-style keys (`Staff_ID`, `Task_ID`) survive from the original Google Sheets wrapper; some newer endpoints accept camelCase and translate. Certificates are stored with **both** casings of every field, which is why readers do `c.formatType || c.Format_Type`. Check `sheetsService.js` and the specific route before assuming.

## Core Workflows

**Sales**: `New Inquiry → Quotation → Quotation Follow-up → Order Confirmation` → auto hand-off to Production.
**Production**: `Material Arrangement / Internal Work → Pickup/Delivery → Service & Maintenance` → auto hand-off back to Sales.
**Sales (post-production)**: `Invoice → Certification → Payment Follow-up → Completed`.
On completion of any extinguisher/refill/Recurring task, a `Recurring Inquiry` auto-generates 11 months out.

**Workshop** (`jobCardService` → `challanService`): job card opens from a task on a Production stage → per-cylinder inward entry with an accessory checklist → multi-day parts fitting → recheck guard → grouped delivery challan → certificate prefill and/or invoice.

**Purchase** (`purchaseService` → `landedCostService` → `inventoryService`): vendor → enquiry to
several vendors → their quotes → compare (L1/L2/L3, plus the cheapest *per line*, which is often a
different vendor) → purchase order → goods receipt. **The goods receipt is the only thing in the
module that touches stock**; everything before it is paper. Freight entered once for a delivery is
spread across lines **by value, not quantity** (freight on fifty cheap pins and two costly valves is
mostly being paid to move the valves), with the last line absorbing the rounding remainder so
allocations sum exactly to the amount invoiced. Received goods are then matched three ways — ordered
vs received vs billed — before Accounts releases payment; a mismatch does not block the release but
demands a written reason.

## Things That Will Bite You

- **NEVER mail or WhatsApp a real customer.** The dev environment shares the production Atlas cluster
  and live SMTP, so anything "test" that touches a real row reaches an actual customer's inbox. The
  only permitted recipient is `expertsafetysolution@gmail.com` (`CUST7608` "Application Demo").
  **Never call an `/api/cron/*` route** — they query the whole database and fan out; one
  `/api/cron/quotation-followup-check` call once mailed two unrelated companies. To exercise a mail
  path, call the per-document dispatch route (or `dispatchService.send*`) against a demo row only.
  Any NEW template ships with its `email_enabled` flag **`false`** so a deploy can never start
  messaging customers by itself — `challan_email`, `certificate_email` and `pod_confirmation` all
  default off for exactly this reason.
- **`npm run test:workflow` writes real rows** (it advances tasks and generates recurring inquiries).
  Fine against seeded data, not against the live database. `npm run verify` is the read-only one:
  it reads real records and runs the masking/costing logic over copies in memory.
- **`Job_Card_Item` is its own collection, not an array.** `updateRow()` only supports `$set` — no array push. Two technicians editing one job card as an array would silently clobber each other. Keep per-cylinder writes on their own documents.
- **Offline actions need a server branch.** A client `enqueueOfflineAction` type with no matching branch in `/api/sync/batch` used to sit in IndexedDB forever. There is now a terminal `else` that reports it as `terminal:true` so the client can drain it — do not remove it, and add a branch for every new type.
- **Capacity is free text.** `6kg`, `6 KG`, `6.0 Kg` all occur. Always run values through `normalizeCapacity()` (server: `jobCardService`, client: `jobCardSchema`) or grouped documents fragment into duplicate lines.
- **Stock is deducted once, at part-fitting time.** `challanService.convertChallanToInvoice` deliberately does NOT call `inventoryService.deductForInvoice` for accessory lines — they left the shelf on the job card. Only `Line_Type === 'MANUAL'` lines deduct at invoice. The invoice carries `Inventory_Deducted_At_JobCard: true` to record why.
- **`QuotationPdfTemplate` renders four document types.** `docType="CHALLAN"` gates every money column off. Editing this file affects every real quotation, PI and tax invoice — regression-check all four before shipping.
- **Route order matters.** Express matches in registration order: literal paths (`/challans/suggest-no`, `/job-cards/lookup-hpt`, `/items/recycle-bin`) MUST be registered before their `/:id` siblings.
- **The public inquiry form breaks in two silent ways.** `inquiryRouter` must stay mounted BEFORE
  `apiRouter` in `server.js` — `apiRouter`'s first middleware is `authenticateToken`, which answers
  401 without calling `next()`, so mounted after it `POST /api/inquiry` 401s every customer. And
  `/inquiry` must stay in `PUBLIC_PATHS` in `App.jsx`, ABOVE the `if (!user) return <Login/>` gate,
  or a customer following the website link is shown a staff login screen and leaves. Neither failure
  is visible to anyone already logged in. See `docs/INQUIRY_PORTAL.md`.
- **The inquiry form is the only unauthenticated WRITE in the system.** Its defence is layered
  (32kb cap → 3/IP/min → honeypot → timing trap → CAPTCHA → validation), and the honeypot and
  timing traps answer **200 with a fake success** on purpose — a bot told why it failed adapts.
  CAPTCHA is skipped when no keys are configured so the form works before the Cloudflare account
  exists, and fails OPEN on a provider outage: losing a real sales lead is worse than admitting a
  little spam. Never "tidy" either of those into a hard failure.
- **A public submission never overwrites an existing customer.** `ingestInquiry` matches on mobile
  and, for a returning customer, READS the profile only. Whoever knows a customer's mobile number
  could otherwise rewrite that customer's billing address through an endpoint with no login.
- **`getTab` returns the cached array by reference** (3s TTL). Treat results as read-only. This is why
  `moneyMask.maskValue()` builds a new object instead of deleting keys in place — masking a cached row
  would strip prices for the *next* caller, who might be an Admin.
- **Adding a collection to `/sync/all` needs both branches.** The Admin and Staff response objects are separate literals — that is how `logs` ended up Admin-only. Job cards, challans, quotations and inventory are deliberately NOT in `/sync/all`; they use lazy endpoints.
- **A new money field must be added to `moneyMask.MONEY_FIELDS` or it leaks.** The list is exact
  names, never a pattern: `GST_Rate`, `Total_Qty`, `Balance_After`, `Daily_Salary_Rate`, `Price_ID`
  and `GSTIN` all match a plausible `/Rate|Amount|Total|Price/` regex and must all survive. The
  `NEVER_MASK` set documents them and a test asserts the two sets never overlap.
- **Only a goods receipt moves `Moving_Avg_Cost`.** Issues (usage, sale, standby-out) reduce quantity
  and value but never recompute the average — standard weighted-average, and what keeps part-fitting
  behaving exactly as it did before costing existed. `Stock_Value` is written in the same `updateRow`
  as `Current_Qty` so the two cannot drift apart.
- **`finance` and `taskstage` are visibility-only modules.** Only `view` (resp. `edit`) is ever
  consulted. `finance`'s write actions are force-cleared in both `resolvePermissions` and
  `sanitizePermissions` *before* the "any write grant implies view" rule runs — otherwise a stray
  `finance: {add:true}` in the DB would silently hand that person every rate in the system.
- **Impersonation is a preview, not a privilege drop.** It swaps the displayed user but does NOT
  re-issue the token, so the server still answers as the real Admin and still sends prices.
  `canSeeMoney` ANDs both identities, so impersonation can neither grant prices nor wrongly reveal
  them. Anything needing a genuine privilege drop must re-issue a scoped token.
- **A retained standby unit is not a returned one.** `getPendingStandby` excludes both, but a
  retention means the customer kept the loaner — it requires a written reason and leaves three
  traces (Activity_Logs, timeline event, permanent `STANDBY_OUT`). It is the only way past the POD
  block, so it must never become silent.

## Auth & Permissions

- Login: `POST /api/auth/login` with `{staffId, password}`. JWT signed with `JWT_SECRET` (required — no fallback), 7-day expiry. `authenticateToken` gates all of `apiRoutes.js`.
- **Module permissions** (`utils/permissions.js`): `quotation`, `inventory`, `jobcard`, `taskstage`, `finance`, `purchase` × `view/add/edit/delete`, stored on `Staff_Master.Module_Permissions`, with `ROLE_DEFAULTS` when unset. Use `requirePermission(module, action)` on new routes. Admin short-circuits everything.
- **Roles**: `admin`, `sales`, `supervisor`, `production`, `certification`, `staff`, `technician`, `accounts`, `delivery`. Every role must carry an explicit entry for **every** module in `ROLE_DEFAULTS` — a missing key reads as denied, so adding a module without updating the table silently revokes access. `resolvePermissions` lowercases the role, so `Role: 'Technician'` resolves automatically.
- **`finance` is a strip-gate, not a route-gate.** Never put `requirePermission('finance','view')` on an existing pricing route — it would 403 people who work today. It only controls whether money survives `moneyMask`. `sales` and `supervisor` default to price-visible because they could see prices before the module existed; making them blind would be a silent regression, not a feature.
- Both `/login` and `/me` return `Effective_Permissions` — the resolved map. The raw `Module_Permissions` is sparse and says nothing about role defaults, so the client cannot evaluate it. Deliberately NOT in the JWT: a 7-day token would keep serving grants an Admin had already revoked. Note `Permissions` (a legacy `'ASSIGNED_ONLY'` string controlling task scope) is a different, unrelated field — do not conflate the two.
- Older routes still use ad-hoc `if (req.user.role !== 'Admin')`. Prefer `requirePermission` for anything new.
- Admin can impersonate a staff member client-side (`AuthContext.startImpersonating`). This swaps the active `user` but does NOT re-issue the token — backend calls still authenticate as the real Admin.

## Document Numbering

- **Customer-facing numbers** (quotation/PI/invoice) *and purchase orders* come from `quotationEngine.nextDocumentNumber()`, backed by the atomic `Counter_Master` sequence. A PO is issued to a vendor, so a repeated number lets one delivery be claimed for payment twice. It de-duplicates the period when the configured prefix already contains it, and seeds a brand-new counter from the highest number already issued — so changing a prefix cannot restart numbering and re-issue a number a customer already has.
- **Challan numbers are typed by hand.** The office writes them in a paper book and the app must match it exactly. Never auto-assign; `suggestNextChallanNo()` is a placeholder hint only, and a duplicate raises a warning the user can override.
- **Certificate numbers are minted client-side** so one appears instantly and offline. `POST /api/certificates` enforces uniqueness at save time and reports any reassignment back in `reassigned` — the page adopts what the server actually stored.
- **Internal IDs** are hand-rolled strings: `` `PREFIX${Date.now().toString().slice(-6)}${rand2}` `` (`JC`, `JCI`, `DC`, `CPL`, `PI`, `SINV`, `ITEM`, `STK`, `INV`). Keep the per-collection prefix.

## Conventions

- CommonJS on the server (`require`/`module.exports`), ESM on the client.
- **Comment the *why*, not the *what*.** The existing comments explain non-obvious decisions and past bugs — match that. Do not narrate code that speaks for itself.
- Errors: every route wraps in try/catch and returns `res.status(xxx).json({error})`. `409` carries actionable payloads (`pendingRechecks`, `pendingStandby`, `duplicateOf`, `unpricedLines`).
- **Calendar dates go through IST**, never `toISOString()`: `new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date())` — the deployment clock may not be IST.
- Client dashboards are large single-file tab-switched components; new tabs follow the existing `activeTab === 'X'` pattern. New *modules* get their own lazy-loaded route instead.

## UI Standard — read this BEFORE designing any screen

Binding for every new form, list, screen and workflow. The people using this app are standing at a
workbench or a customer's gate, one-handed, often in gloves, frequently on a bad connection. Design
for that first and the desktop takes care of itself.

**Mobile-first, not mobile-also.** Lay out for 320–480px and let it scale up. A screen that only
works once it is wide is a broken screen.

**Touch targets are sized by ROLE, not by one global number.** A blanket "48px everywhere" fills the
screen and makes things worse — eight 48px icons need 384px of width on a 360px phone.

| Control | Size | Why |
|---|---|---|
| Primary action (Save, Submit, Issue, Post) | **48px** | One per screen, thumb-reached, expensive to mis-tap |
| Form input / row you type into | **44px** (`.jc-input`) | Filled one-handed at a workbench, often in gloves |
| Full-width list row you pick from | **48px** | The whole row is the target, so width is free |
| Icon button in a toolbar row (call, WhatsApp, map, delete) | **32px** (`w-8 h-8`) | Six to eight sit side by side; enlarging them pushes the row off screen or wraps it. Spacing and separation carry the accuracy here, not size. |

The existing sizes are already right — the task card's action strip at 32px, `.jc-input` at 44px, the
sticky Save at 48px. **Do not "upgrade" them.** Match the role, and only reach for a bigger target
when a control is genuinely alone on its line.

**Primary actions live in a sticky bottom bar**, thumb-reachable, padded clear of the home indicator
with `env(safe-area-inset-bottom)`. Headers stay sticky too so context is never lost mid-scroll.
`JobCardPage` and `ChallanBuilderPage` are the reference implementations.

**Progressive disclosure is mandatory.** Never render 20+ open fields at once. Use
`components/CollapsibleSection.jsx` — do not write another accordion:

- it folds on the `false → true` edge of `isComplete` only, never on every render, so a section
  cannot slam shut while someone is still correcting a field inside it
- the collapsed row shows identity facts and a status badge ("ABC 6kg · 5 units · checked"),
  enough to know whether to reopen it
- tapping the row reopens it for editing; `tone` colours the left rail (`warning` / `danger`)
- `InventoryPage.jsx` declares a LOCAL `CollapsibleSection` near the bottom of the file that shadows
  the import and has none of this. Import the shared one; do not copy that variant.

**Search must match anywhere, in any word order.** Use `matchesQuery()` from `utils/searchUtils.js`
for every filter and typeahead: it splits the query on spaces and requires each token to appear
somewhere in the record, so "Expert Vadodara" finds "Expert Safety Solutions Vadodara" and so does
"Vadodara Expert". The older hand-rolled `field.toLowerCase().includes(q)` chains treat the whole
query as ONE token and fail both — migrate them when touching that code. For pickers use
`components/SmartSearchSelect.jsx` (filtered dropdown, highlighted matches, arrow keys + 48px touch
rows) rather than a bare `<datalist>`, which can only prefix-match and cannot show a subtitle.

Filtering stays **client-side** for these lists — they are hundreds of rows, already in memory from
`/sync/all` or a lazy fetch, and a round trip per keystroke would be slower and useless offline. If a
collection ever outgrows that, add a server-side `?q=` that applies the same token-AND rule (a
`$and` of `$regex` terms, or a text index) so both sides agree on what "matches" means. Deliberately
NOT fuzzy/edit-distance: on a cylinder number or GSTIN, "close enough" returns the wrong record, and
picking the wrong customer is worse than finding none.

**Reduce typing.** Carry the previous row's values into a new one, prefill from the customer's
register, offer typeahead over free text. `JobCardInwardTab` inheriting type/capacity from the row
above is the pattern to copy.

**Feedback is immediate.** A completed section shows its green check and folds; a failure says what
to do next. Respect `prefers-reduced-motion` — `.animate-fadeIn` already does.

## Commands

```bash
npm run dev:server        # server/src/server.js on :5000
npm run dev:client        # client on :5174, proxies /api and /assets to :5000
npm run build             # installs + builds client only, for Vercel — the only real gate
npm run verify            # READ-ONLY checks against the real DB: permissions, masking, standby,
                          #   costing, 3-way match, offline contract. Writes nothing.
npm run verify -- --staff STAFF003   # exactly what one person can and cannot see
npm run test:workflow     # WRITES real tasks + recurring inquiries — seeded data only
```

`TESTING.md` carries the manual checklist for what a script cannot see: what to tap on a phone, and
the test that actually matters — what should be **absent from the JSON**, not merely hidden on screen.

## Environment

`server/.env` holds `MONGO_URI` and `JWT_SECRET`. Both are **required** — the server throws on startup if either is missing, rather than falling back to a baked-in value. `.gitignore` excludes `.env`, `.env.*`, `node_modules`, `dist` and `client/dist`; no `.env` is tracked.
