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
  pages/FieldVisitPage.jsx / Login.jsx

  components/CollapsibleSection.jsx   Auto-hide primitive: a completed section folds to a summary row
  components/jobcard/                 Inward tab, Service tab, checklist cells, parts editor, recheck modal
  components/DeliveryPODModal.jsx     Signature + geo-stamped photos; blocks on unreturned standby units
  components/EuidScanner.jsx          OCR with an always-visible text input (typing is the fast path)
  components/QuotationPdfTemplate.jsx One A4 template for QUOTATION / PI / INVOICE / CHALLAN
  components/ClientEquipmentModal.jsx, Navbar.jsx, OfflineBanner.jsx, ErrorBoundary.jsx

  context/AuthContext.jsx     Auth state, localStorage persistence, offline sync, staff impersonation
  utils/offlineQueue.js       IndexedDB queue + flushOfflineQueue → POST /api/sync/batch
  utils/jobCardSchema.js      Checkpoint→part map, capacity normalisation, summary helpers
  utils/reportTypeSchemas.js  Column/checkpoint engine for every report module
  utils/pdfGenerator.js       Shared html2canvas + jsPDF pipeline
  utils/geoWatermark.js       Burns GPS + timestamp into photo pixels (survives sharing)
  utils/imageCompression.js, gpsHelper.js, dateUtils.js, quotationUtils.js

server/src/
  server.js                   Bootstrap, public /api/verify-certificate/:guid, cron routes,
                              auto-attendance-close job
  routes/authRoutes.js        POST /api/auth/login, GET /api/auth/me, authenticateToken middleware
  routes/apiRoutes.js         ~3900 lines — everything else, all behind authenticateToken
  utils/permissions.js        Module permissions: quotation | inventory | jobcard
  utils/gstUtils.js           GSTIN validation, tax split, document totals
  services/sheetsService.js   THE data layer (Mongoose, despite the name). 31 collections,
                              3s cache, generic getTab/insertRow/updateRow/deleteRow
  services/workflowEngine.js  Task stage machine + department hand-offs + 11-month recurring
  services/quotationEngine.js Quotation state machine + document numbering
  services/conversionService.js  Quotation → PI → Invoice (copies frozen figures, never re-prices)
  services/jobCardService.js  Workshop intake, parts fitting, recheck guard, standby units
  services/challanService.js  Grouping, challan issue, certificate prefill, challan → invoice
  services/priceListService.js   Self-building per-customer rate memory
  services/equipmentCategoryService.js  Admin-editable categories + inward checkpoints
  services/inventoryService.js, dispatchService.js, emailService.js, whatsappService.js,
  services/quotationCronService.js, attendanceService.js, pushService.js

  services/mongoService.js    DEAD CODE — near-duplicate of sheetsService.js, nothing requires it.
                              Safe to delete, but ask before removing.
```

## Data Model (Mongoose, all `{strict: false}`)

Registered in one map at `sheetsService.js:10-42`.

**Core**: `Staff_Master`, `Customer_Master`, `Task_Master`, `Activity_Logs`, `Attendance_Log`, `Leave_Requests`, `Customer_Interactions`, `Salary_Advances`
**Documents**: `Document_Registry` (certificates), `Service_Reports`, `Certificate_Type_Master`, `Document_Settings`
**Equipment**: `Equipment_Master`, `Client_Equipment_Master`, `Equipment_Category_Master`
**Sales**: `Quotation_Settings`, `Item_Master`, `Quotation_Master`, `PI_Master`, `Sales_Invoice_Master`, `Customer_Price_List`
**Workshop**: `Job_Card_Master`, `Job_Card_Item`, `Delivery_Challan_Master`
**Infra**: `Inventory_Master`, `Stock_Transactions`, `Counter_Master`, `Media_Store`, `Tag_Master`, `Field_Visits`, `Notification_Settings`

Field naming is inconsistent by design: PascalCase/Snake_Case Sheet-style keys (`Staff_ID`, `Task_ID`) survive from the original Google Sheets wrapper; some newer endpoints accept camelCase and translate. Certificates are stored with **both** casings of every field, which is why readers do `c.formatType || c.Format_Type`. Check `sheetsService.js` and the specific route before assuming.

## Core Workflows

**Sales**: `New Inquiry → Quotation → Quotation Follow-up → Order Confirmation` → auto hand-off to Production.
**Production**: `Material Arrangement / Internal Work → Pickup/Delivery → Service & Maintenance` → auto hand-off back to Sales.
**Sales (post-production)**: `Invoice → Certification → Payment Follow-up → Completed`.
On completion of any extinguisher/refill/Recurring task, a `Recurring Inquiry` auto-generates 11 months out.

**Workshop** (`jobCardService` → `challanService`): job card opens from a task on a Production stage → per-cylinder inward entry with an accessory checklist → multi-day parts fitting → recheck guard → grouped delivery challan → certificate prefill and/or invoice.

## Things That Will Bite You

- **`Job_Card_Item` is its own collection, not an array.** `updateRow()` only supports `$set` — no array push. Two technicians editing one job card as an array would silently clobber each other. Keep per-cylinder writes on their own documents.
- **Offline actions need a server branch.** A client `enqueueOfflineAction` type with no matching branch in `/api/sync/batch` used to sit in IndexedDB forever. There is now a terminal `else` that reports it as `terminal:true` so the client can drain it — do not remove it, and add a branch for every new type.
- **Capacity is free text.** `6kg`, `6 KG`, `6.0 Kg` all occur. Always run values through `normalizeCapacity()` (server: `jobCardService`, client: `jobCardSchema`) or grouped documents fragment into duplicate lines.
- **Stock is deducted once, at part-fitting time.** `challanService.convertChallanToInvoice` deliberately does NOT call `inventoryService.deductForInvoice` for accessory lines — they left the shelf on the job card. Only `Line_Type === 'MANUAL'` lines deduct at invoice. The invoice carries `Inventory_Deducted_At_JobCard: true` to record why.
- **`QuotationPdfTemplate` renders four document types.** `docType="CHALLAN"` gates every money column off. Editing this file affects every real quotation, PI and tax invoice — regression-check all four before shipping.
- **Route order matters.** Express matches in registration order: literal paths (`/challans/suggest-no`, `/job-cards/lookup-hpt`, `/items/recycle-bin`) MUST be registered before their `/:id` siblings.
- **`getTab` returns the cached array by reference** (3s TTL). Treat results as read-only.
- **Adding a collection to `/sync/all` needs both branches.** The Admin and Staff response objects are separate literals — that is how `logs` ended up Admin-only. Job cards, challans, quotations and inventory are deliberately NOT in `/sync/all`; they use lazy endpoints.

## Auth & Permissions

- Login: `POST /api/auth/login` with `{staffId, password}`. JWT signed with `JWT_SECRET` (required — no fallback), 7-day expiry. `authenticateToken` gates all of `apiRoutes.js`.
- **Module permissions** (`utils/permissions.js`): `quotation`, `inventory`, `jobcard` × `view/add/edit/delete`, stored on `Staff_Master.Module_Permissions`, with `ROLE_DEFAULTS` when unset. Use `requirePermission(module, action)` on new routes. Admin short-circuits everything.
- Older routes still use ad-hoc `if (req.user.role !== 'Admin')`. Prefer `requirePermission` for anything new.
- Admin can impersonate a staff member client-side (`AuthContext.startImpersonating`). This swaps the active `user` but does NOT re-issue the token — backend calls still authenticate as the real Admin.

## Document Numbering

- **Customer-facing numbers** (quotation/PI/invoice) come from `quotationEngine.nextDocumentNumber()`, backed by the atomic `Counter_Master` sequence. It de-duplicates the period when the configured prefix already contains it, and seeds a brand-new counter from the highest number already issued — so changing a prefix cannot restart numbering and re-issue a number a customer already has.
- **Challan numbers are typed by hand.** The office writes them in a paper book and the app must match it exactly. Never auto-assign; `suggestNextChallanNo()` is a placeholder hint only, and a duplicate raises a warning the user can override.
- **Certificate numbers are minted client-side** so one appears instantly and offline. `POST /api/certificates` enforces uniqueness at save time and reports any reassignment back in `reassigned` — the page adopts what the server actually stored.
- **Internal IDs** are hand-rolled strings: `` `PREFIX${Date.now().toString().slice(-6)}${rand2}` `` (`JC`, `JCI`, `DC`, `CPL`, `PI`, `SINV`, `ITEM`, `STK`, `INV`). Keep the per-collection prefix.

## Conventions

- CommonJS on the server (`require`/`module.exports`), ESM on the client.
- **Comment the *why*, not the *what*.** The existing comments explain non-obvious decisions and past bugs — match that. Do not narrate code that speaks for itself.
- Errors: every route wraps in try/catch and returns `res.status(xxx).json({error})`. `409` carries actionable payloads (`pendingRechecks`, `pendingStandby`, `duplicateOf`, `unpricedLines`).
- **Calendar dates go through IST**, never `toISOString()`: `new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'}).format(new Date())` — the deployment clock may not be IST.
- Mobile controls are **minimum 44–48px tall** (`.jc-input`, `.jc-btn-ghost` in `index.css`). These forms are filled one-handed at a workbench.
- Client dashboards are large single-file tab-switched components; new tabs follow the existing `activeTab === 'X'` pattern. New *modules* get their own lazy-loaded route instead.

## Commands

```bash
npm run dev:server        # server/src/server.js on :5000
npm run dev:client        # client on :5174, proxies /api and /assets to :5000
npm run build             # installs + builds client only, for Vercel
npm run test:workflow     # manual smoke test, needs seed data (TASK1001)
```

## Environment

`server/.env` holds `MONGO_URI` and `JWT_SECRET`. Both are **required** — the server throws on startup if either is missing, rather than falling back to a baked-in value. `.gitignore` excludes `.env`, `.env.*`, `node_modules`, `dist` and `client/dist`; no `.env` is tracked.
