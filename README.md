# Expert Safety Solutions — Field Service & CRM Progressive Web App (PWA)

A full-stack, enterprise-grade Field Service & CRM platform built for **Expert Safety Solutions** (Fire Safety Management business) to orchestrate tasks across **Sales** and **Production** departments with complete offline capabilities.

---

## Architecture Overview

- **Frontend PWA (`/client`)**:
  - **React 18 + Vite + Tailwind CSS**
  - **Mobile-First Responsive UI** with curated fire safety themes & glassmorphism
  - **Service Workers (`sw.js`)** for offline static caching & app shell
  - **IndexedDB (`idb`) Offline Queue**: Captures stage transitions, GPS check-ins, photo uploads, and rescheduling offline and batch syncs automatically via `/api/sync/batch` when online
  - **Client-Side Image Compression**: HTML5 Canvas engine scaling photo proofs down to `<200 KB` Base64 Data URL before uploading
  - **Geolocation Check-in**: Uses browser Geolocation API (`navigator.geolocation`) to record GPS Lat/Long coords
  - **Quick Field Actions**: One-tap `tel:` call buttons and Google Maps GPS navigation links

- **Backend API & Mock Sheets Wrapper (`/server`)**:
  - **Node.js + Express** server with JWT authentication (`/api/auth/login`)
  - **Google Sheets API Wrapper (`sheetsService.js`)**: Maps CRUD operations to 4 sheets (`Staff_Master`, `Customer_Master`, `Task_Master`, `Activity_Logs`) with persistent JSON storage (`data/mock_sheets.json`)
  - **Automated Workflow Engine (`workflowEngine.js`)**:
    - **Sales Pipeline**: `New Inquiry` -> `Quotation` -> `Quotation Follow-up` -> `Order Confirmation`
    - **Automatic Hand-off**: Upon `Order Confirmation`, automatically routes the task to `Production` (`Material Arrangement / Internal Work`)
    - **Production Pipeline**: `Material Arrangement / Internal Work` -> `Pickup/Delivery` -> `Service & Maintenance`
    - **Automatic Return Hand-off**: Upon `Service & Maintenance` completion, routes back to `Sales` (`Invoice` -> `Certificate` -> `Payment Follow-up` -> `Completed`)
    - **11-Month Recurring Automation**: When any Fire Extinguisher service task completes, automatically generates a new `Recurring Inquiry` task scheduled **exactly 11 months** in the future.

---

## Quick Demo Credentials

Login at `http://localhost:5173` using any of the seeded accounts (or click Quick Fill on the login screen):

| Role | Staff ID | Password | Access Capabilities |
|---|---|---|---|
| **Admin** | `STAFF001` | `admin123` | Full visibility of all staff, customers, tasks, executive analytics, and switcher to field mode |
| **Sales Officer** | `STAFF002` | `staff123` | Assigned Sales tasks, quotation follow-up, order confirmation |
| **Production Engineer** | `STAFF003` | `staff123` | Assigned Production tasks, workshop/on-site service, cylinder testing |

---

## Running Locally

### 1. Start Backend Server (Port 5000)
```bash
cd server
npm start
```

### 2. Start Frontend PWA Dev Server (Port 5173)
```bash
cd client
npm run dev
```

### 3. Run Automated Workflow & 11-Month Recurring Task Test
```bash
npm run test:workflow
```
