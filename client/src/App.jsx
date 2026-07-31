import React, { useState, Suspense, lazy } from 'react';
import { Routes, Route, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from './context/AuthContext';
import { DocSettingsProvider } from './context/DocSettingsContext';
import Navbar from './components/Navbar';
import OfflineBanner from './components/OfflineBanner';
import Login from './pages/Login';

// Route-level code splitting: each dashboard/generator page (and its heavy deps like
// html2canvas/jspdf/papaparse) only downloads when the user actually navigates there,
// instead of everyone paying for all six pages on first load.
const StaffDashboard = lazy(() => import('./pages/StaffDashboard'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const CertificateGeneratorPage = lazy(() => import('./pages/CertificateGeneratorPage'));
const CertificateComplianceGeneratorPage = lazy(() => import('./pages/CertificateComplianceGeneratorPage'));
const DocSettingsPage = lazy(() => import('./pages/DocSettingsPage'));
const FieldVisitPage = lazy(() => import('./pages/FieldVisitPage'));
const QuotationListPage = lazy(() => import('./pages/QuotationListPage'));
const QuotationBuilderPage = lazy(() => import('./pages/QuotationBuilderPage'));
const QuotationSettingsPage = lazy(() => import('./pages/QuotationSettingsPage'));
const SalesDocumentsPage = lazy(() => import('./pages/SalesDocumentsPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const StaffPermissionsPage = lazy(() => import('./pages/StaffPermissionsPage'));
const JobCardPage = lazy(() => import('./pages/JobCardPage'));
const ChallanBuilderPage = lazy(() => import('./pages/ChallanBuilderPage'));
const ChallanListPage = lazy(() => import('./pages/ChallanListPage'));
const ManualChallanPage = lazy(() => import('./pages/ManualChallanPage'));
const CustomerPriceListPage = lazy(() => import('./pages/CustomerPriceListPage'));
const EquipmentCategoriesPage = lazy(() => import('./pages/EquipmentCategoriesPage'));
const PurchasePage = lazy(() => import('./pages/PurchasePage'));
const PurchaseOrderBuilderPage = lazy(() => import('./pages/PurchaseOrderBuilderPage'));
// The one page in the app a logged-OUT stranger is meant to see. Rendered before the auth gate
// below, so it must not import anything that assumes a session.
const PublicInquiryPage = lazy(() => import('./pages/PublicInquiryPage'));

// Keyed so switching report type (or new-vs-edit) remounts the page with fresh state, since
// React Router otherwise reuses the same instance when only the URL params change.
function ServiceReportRoute() {
  const { typeRoute, reportId } = useParams();
  return <CertificateGeneratorPage key={`${typeRoute || 'certificate'}:${reportId || 'new'}`} />;
}

// Keyed for the same reason as ServiceReportRoute: navigating between quotations (or new-vs-edit)
// only changes the URL param, so without a key React Router would reuse the instance and keep the
// previous quotation's form state.
function QuotationRoute() {
  const { quotationId } = useParams();
  return <QuotationBuilderPage key={quotationId || 'new'} />;
}

// Keyed for the same reason as QuotationRoute: moving between purchase orders only changes the URL
// param, so without a key React Router would reuse the instance and keep the previous order's lines.
function PurchaseOrderRoute() {
  const { poId } = useParams();
  return <PurchaseOrderBuilderPage key={poId || 'new'} />;
}

// Keyed for the same reason as the routes above: a technician moving from one job card to another
// only changes the URL param, and without a key the previous card's item rows would persist.
function JobCardRoute() {
  const { taskId, jobCardId } = useParams();
  return <JobCardPage key={jobCardId || taskId || 'new'} />;
}

function ChallanRoute() {
  const { challanId, jobCardId } = useParams();
  return <ChallanBuilderPage key={challanId || jobCardId || 'new'} />;
}

function RouteLoadingFallback() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50">
      <div className="text-slate-500 font-bold text-sm animate-pulse">Loading…</div>
    </div>
  );
}

export default function App() {
  const { user, realUser, impersonatedStaff, stopImpersonating } = useAuth();
  const [currentView, setCurrentView] = useState(() => {
    return localStorage.getItem('expert_safety_current_view') || 'default';
  });

  const handleSetCurrentView = (view) => {
    setCurrentView(view);
    localStorage.setItem('expert_safety_current_view', view);
  };

  const location = useLocation();

  /*
   * Public routes are matched BEFORE the auth gate below.
   *
   * That gate returns <Login /> for anyone without a session, which is right for every CRM screen
   * and exactly wrong for /inquiry — a customer following a link from the website would be shown a
   * staff login form and simply leave. Checking the path first is what makes the page genuinely
   * public.
   *
   * It also renders WITHOUT the DocSettingsProvider/Navbar/OfflineBanner shell: that chrome reads
   * auth state and fetches authenticated settings, none of which exist for a stranger. The page is
   * deliberately self-contained for this reason.
   *
   * Kept as a prefix list so adding a second public page is a one-line change.
   */
  const PUBLIC_PATHS = ['/inquiry'];
  if (PUBLIC_PATHS.some(p => location.pathname === p || location.pathname.startsWith(`${p}/`))) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/inquiry" element={<PublicInquiryPage />} />
        </Routes>
      </Suspense>
    );
  }

  if (!user && !realUser) {
    return <Login />;
  }

  // Determine active role & view based on whether impersonating or switcher
  const activeRole = realUser?.Role || user?.Role;
  const isViewingAdmin = !impersonatedStaff && activeRole === 'Admin' && (currentView === 'admin' || currentView === 'default');
  const isCertificatePage = location.pathname.startsWith('/certificate/') || location.pathname.startsWith('/certificate-compliance/') || location.pathname.startsWith('/service-report/') || location.pathname.startsWith('/field-visit/');
  const isSettingsPage = location.pathname.startsWith('/settings/');
  // The quotation/inventory pages render their own sticky header and action bar, so they hide the
  // app navbar the same way the certificate and settings pages do.
  const isQuotationPage = location.pathname.startsWith('/quotations') || location.pathname.startsWith('/inventory')
    || location.pathname.startsWith('/sales-documents') || location.pathname.startsWith('/challans')
    || location.pathname.startsWith('/price-list') || location.pathname.startsWith('/purchase');
  // The job card renders its own header and action bar so it hides the navbar too — but unlike the
  // pages above it KEEPS the offline banner, because it is the one screen designed to be filled in
  // a workshop with no signal and the pending-sync count is the technician's only proof their work
  // is safe.
  const isJobCardPage = location.pathname.startsWith('/job-card');
  const hidesChrome = isCertificatePage || isSettingsPage || isQuotationPage || isJobCardPage;

  return (
    <DocSettingsProvider>
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col selection:bg-rose-500 selection:text-white">
        {(!hidesChrome || isJobCardPage) && <OfflineBanner />}
        {!hidesChrome && impersonatedStaff && (
          <div className="bg-gradient-to-r from-rose-600 via-indigo-600 to-emerald-600 text-white px-3 sm:px-4 py-1.5 shadow-md flex items-center justify-between gap-2 z-50 sticky top-0 animate-fadeIn border-b border-white/20">
            <div className="flex items-center gap-2 min-w-0">
              <span className="px-1.5 py-0.5 rounded-md bg-white/20 text-white font-extrabold text-[9px] tracking-wider uppercase shrink-0">
                Staff Access
              </span>
              <span className="text-xs font-bold truncate">
                {impersonatedStaff.Name}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                stopImpersonating();
                handleSetCurrentView('admin');
              }}
              className="w-6 h-6 rounded-md bg-white/20 hover:bg-white/30 active:scale-95 flex items-center justify-center transition shrink-0"
              title="Exit & Return to Admin Panel"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {!hidesChrome && (
          <Navbar
            currentView={isViewingAdmin ? 'admin' : 'staff'}
            setCurrentView={handleSetCurrentView}
          />
        )}

        <main className={hidesChrome ? 'flex-1' : 'flex-1 pb-16'}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              {/* Typed service-report routes, one URL per report module */}
              <Route path="/service-report/:typeRoute/new" element={<ServiceReportRoute />} />
              <Route path="/service-report/:typeRoute/:reportId" element={<ServiceReportRoute />} />
              {/* Legacy fire-extinguisher aliases, kept so existing links keep working */}
              <Route path="/certificate/new" element={<CertificateGeneratorPage />} />
              <Route path="/certificate/:reportId" element={<CertificateGeneratorPage />} />
              <Route path="/certificate-compliance/new" element={<CertificateComplianceGeneratorPage />} />
              <Route path="/certificate-compliance/task/:taskId" element={<CertificateComplianceGeneratorPage />} />
              {/* One field visit = one client, every equipment family searchable together */}
              <Route path="/field-visit/new" element={<FieldVisitPage />} />
              <Route path="/field-visit/:visitId" element={<FieldVisitPage />} />
              <Route path="/settings/documents" element={<DocSettingsPage />} />
              <Route path="/settings/quotations" element={<QuotationSettingsPage />} />
              {/* Quotation pipeline: register, builder, and the item/stock master */}
              <Route path="/quotations" element={<QuotationListPage />} />
              <Route path="/quotations/new" element={<QuotationRoute />} />
              <Route path="/quotations/:quotationId" element={<QuotationRoute />} />
              <Route path="/inventory" element={<InventoryPage />} />
              {/* PI / Sales Invoice register — the read side of the conversion pipeline */}
              <Route path="/sales-documents" element={<SalesDocumentsPage />} />
              <Route path="/settings/permissions" element={<StaffPermissionsPage />} />
              <Route path="/settings/equipment-categories" element={<EquipmentCategoriesPage />} />
              <Route path="/purchase" element={<PurchasePage />} />
              {/* LITERAL before the :poId sibling, so "new" is not read as an id. */}
              <Route path="/purchase-orders/new" element={<PurchaseOrderRoute />} />
              <Route path="/purchase-orders/:poId" element={<PurchaseOrderRoute />} />
              {/* Workshop job card. Keyed so moving between cards remounts with fresh state. */}
              <Route path="/job-card/task/:taskId" element={<JobCardRoute />} />
              <Route path="/job-card/:jobCardId" element={<JobCardRoute />} />
              {/* Delivery challan: register, and the builder that issues one from a job card. */}
              <Route path="/challans" element={<ChallanListPage />} />
              {/* Literal, so it must not be shadowed by /challans/:challanId. React Router ranks a
                  static segment above a dynamic one regardless of order, but keeping it above
                  matches the convention the server routes follow. */}
              <Route path="/challans/manual" element={<ManualChallanPage />} />
              <Route path="/challans/new/:jobCardId" element={<ChallanRoute />} />
              <Route path="/challans/:challanId" element={<ChallanRoute />} />
              <Route path="/price-list" element={<CustomerPriceListPage />} />
              <Route path="/*" element={isViewingAdmin ? <AdminDashboard /> : <StaffDashboard />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </DocSettingsProvider>
  );
}
