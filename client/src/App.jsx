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
    || location.pathname.startsWith('/sales-documents');

  return (
    <DocSettingsProvider>
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col selection:bg-rose-500 selection:text-white">
        {!isCertificatePage && !isSettingsPage && !isQuotationPage && <OfflineBanner />}
        {!isCertificatePage && !isSettingsPage && !isQuotationPage && impersonatedStaff && (
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
        {!isCertificatePage && !isSettingsPage && !isQuotationPage && (
          <Navbar
            currentView={isViewingAdmin ? 'admin' : 'staff'}
            setCurrentView={handleSetCurrentView}
          />
        )}

        <main className={(isCertificatePage || isSettingsPage || isQuotationPage) ? 'flex-1' : 'flex-1 pb-16'}>
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
              <Route path="/*" element={isViewingAdmin ? <AdminDashboard /> : <StaffDashboard />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </DocSettingsProvider>
  );
}
