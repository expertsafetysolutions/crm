# Expert Safety Solutions — Field Service & CRM PWA

Full-stack Field Service & CRM platform for a fire-safety-equipment business, orchestrating a Sales → Production → Sales (Invoice/Certification) task pipeline, plus staff attendance/payroll, leave, and equipment/certificate registries. Offline-first PWA for field staff.

## Tech Stack

- **Frontend** (`/client`): React 18 + Vite 5 + Tailwind CSS 3. PWA with a hand-written service worker (`public/sw.js`, stale-while-revalidate + network-first `/api` GET caching) and `idb` for an IndexedDB offline action queue. `html2canvas` + `jspdf` for PDF certificate generation, `qrcode.react` for QR verification codes, `papaparse` for CSV import/export.
- **Backend** (`/server`): Node.js + Express 4. JWT auth (`jsonwebtoken`), `bcryptjs` for password hashing, Mongoose 9 → MongoDB Atlas as the datastore.
- **Deployment**: Vercel. `api/index.js` re-exports the Express `app` as a serverless function; `vercel.json` rewrites `/api/*` there and everything else to the SPA `index.html`. `vercel-build` = `npm run build` → builds `/client` only (client/dist is the output dir).
- No TypeScript, no test framework (one manual Node script, no CI), no linter config present.

## Directory Map

```
client/src/
  pages/AdminDashboard.jsx      6935 lines — tabbed Admin SPA (OVERVIEW/PIPELINE/STAFF/CUSTOMERS/LOGS/ATTENDANCE/...), the bulk of the frontend logic
  pages/StaffDashboard.jsx      3765 lines — field-staff SPA (TASKS/ATTENDANCE/LEAVE/EARNINGS/REPORTS tabs)
  pages/Login.jsx               Staff ID + password login w/ quick-fill demo creds
  components/ServiceReportModal.jsx  1322 lines — service report + certificate generation flow
  components/ClientEquipmentModal.jsx, Navbar.jsx, OfflineBanner.jsx, ErrorBoundary.jsx
  context/AuthContext.jsx       Auth state, localStorage persistence (photo stored separately from user blob to dodge 5MB quota), offline sync orchestration, staff "impersonation" (Admin can act as a staff member)
  utils/offlineQueue.js         IndexedDB queue (idb) + flushOfflineQueue → POST /api/sync/batch
  utils/imageCompression.js     Canvas-based JPEG compression, targets <180KB before upload
  utils/gpsHelper.js            High-accuracy geolocation wrapper with accuracy-threshold rejection
  utils/dateUtils.js

server/src/
  server.js                     Express bootstrap, static /assets, /api/verify-certificate/:guid (public), /api/health, periodic auto-attendance-close job (every 5 min, fires 19:05+)
  routes/authRoutes.js           POST /api/auth/login, GET /api/auth/me, exports authenticateToken middleware
  routes/apiRoutes.js            1531 lines — everything else, all behind authenticateToken: sync/all (bulk dashboard payload), tasks, customers, staff, attendance, leaves, advances, logs, certificates, service-reports, equipment-master, notifications/my
  services/sheetsService.js      THE live data-access layer (despite the name — historically wrapped Google Sheets, now Mongoose). Flexible {strict:false} schemas per collection, 3s in-memory cache in getTab(), generic getTab/insertRow/updateRow/deleteRow plus named convenience methods
  services/workflowEngine.js     advanceTaskStage(): sales/production stage machine + auto department hand-offs + 11-month recurring-inquiry generation for extinguisher/refill tasks on completion
  services/attendanceService.js  Punch in/out, IST-aware time math, pro-rata salary calc (10h standard shift, full pay Sundays), auto-close job for unclosed punches at 19:00

server/tests/testWorkflow.js     Manual smoke test (run via `npm run test:workflow`), NOT an automated test suite
server/testAttendancePayroll.js  Similar manual script
server/migrate_db.js             One-off script that pushed data/mock_sheets.json into MongoDB (superseded — services now hit Mongo directly)
server/data/mock_sheets.json     Legacy artifact from before the Mongo migration; no longer read by running code (grep confirms no references outside migrate_db.js)

server/src/services/mongoService.js   DEAD CODE — near-duplicate of sheetsService.js without the cache; nothing requires it. Safe to delete, but ask before removing.

api/index.js                    Vercel serverless entry — requires server/src/server.js
```

## Data Model (Mongoose collections, all `{strict: false}`)

`Staff_Master`, `Customer_Master`, `Task_Master`, `Activity_Logs`, `Attendance_Log`, `Leave_Requests`, `Customer_Interactions`, `Salary_Advances`, `Document_Registry` (certificates), `Equipment_Master`, `Client_Equipment_Master`, `Service_Reports`.

Field naming is inconsistent by design across the codebase: PascalCase/Snake_Case Sheet-style keys (`Staff_ID`, `Task_ID`, `Customer_ID`) survive from the original Google Sheets wrapper; some newer endpoints accept camelCase request bodies (`companyName`, `staffId`) and translate them. When touching an endpoint, check `sheetsService.js` and the specific route to see which convention is live there — don't assume.

## Core Workflow (workflowEngine.js)

Sales: `New Inquiry → Quotation → Quotation Follow-up → Order Confirmation` → **auto hand-off to Production**.
Production: `Material Arrangement / Internal Work → Pickup/Delivery → Service & Maintenance` → **auto hand-off back to Sales**.
Sales (post-production): `Invoice → Certification → Payment Follow-up → Completed`.
On completion of any extinguisher/refill/Recurring-type task, a new `Recurring Inquiry` task auto-generates dated exactly 11 months out.

## Auth Model

- Login: `POST /api/auth/login` with `{staffId, password}`. JWT signed with `JWT_SECRET` (7-day expiry), `authenticateToken` middleware gates all of `apiRoutes.js`.
- Role check is ad-hoc per-route (`if (req.user.role !== 'Admin') return 403`), not a shared middleware — apply the same pattern when adding admin-only routes.
- Demo/legacy password bypass hardcoded in `authRoutes.js` (`admin123`/`staff123` match specific Staff_IDs regardless of stored hash) — intentional per README demo credentials table, but means those passwords work for those IDs in any environment including production unless removed.
- Admin can "impersonate" a staff member client-side (`AuthContext.startImpersonating`) — this swaps the active `user` in context but does NOT re-issue a token, so backend calls still authenticate as the real Admin.

## Known Issues Worth Knowing Before Touching Related Code

- **Hardcoded MongoDB Atlas credentials** (with real username/password) appear as fallback literals in `server/src/server.js`, `server/src/services/sheetsService.js`, and `server/migrate_db.js`, in addition to being in `server/.env`. If this repo is ever pushed to a remote/public host, treat the credential as compromised and rotate it first — `.gitignore` currently only excludes `.vercel` (not `.env` or `node_modules`), and this directory is not yet a git repo, so nothing has leaked externally *yet*.
- `JWT_SECRET` also has a hardcoded fallback (`expert_safety_secret_key_2026`) in `authRoutes.js` if the env var is absent.
- No automated test suite — `test:workflow` is a manual script requiring seed data (`TASK1001`) to exist in the DB.

## Conventions Observed

- CommonJS on the server (`require`/`module.exports`), ESM on the client (`import`/`export`, Vite).
- No comments except sparse JSDoc-style blocks on utility functions; mirror that sparsity.
- Error handling: every route wraps in try/catch and returns `res.status(xxx).json({error: '...'})`; no centralized error handler or error classes.
- Dates: server routinely formats "today" in IST via `new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kolkata'})` — follow this instead of `new Date().toISOString()` when a calendar date (not timestamp) is needed, since the deployment's server clock may not be IST.
- IDs are hand-rolled strings (`TASK${Date.now()...}`, `LOG${Date.now()}`, `ADV_${nowMs}`) rather than Mongo ObjectIds — keep consistent with existing prefix/format per collection.
- Client dashboards are large single-file tab-switched components rather than split into per-tab files/routes — new tabs are typically added in-place following the existing `activeTab === 'X'` conditional-render pattern rather than introducing a router.

## Commands

```bash
npm run dev:server        # server/src/server.js on :5000 (root package.json script)
npm run dev:client        # client on :5173, proxies /api and /assets to :5000
npm run build              # installs + builds client only, for Vercel
npm run test:workflow      # server/tests/testWorkflow.js manual smoke test
```
