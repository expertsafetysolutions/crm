import React, { useState, Suspense, lazy } from 'react';
import { Routes, Route, useLocation, useParams } from 'react-router-dom';
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

// Keyed so switching report type (or new-vs-edit) remounts the page with fresh state, since
// React Router otherwise reuses the same instance when only the URL params change.
function ServiceReportRoute() {
  const { typeRoute, reportId } = useParams();
  return <CertificateGeneratorPage key={`${typeRoute || 'certificate'}:${reportId || 'new'}`} />;
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
  const isCertificatePage = location.pathname.startsWith('/certificate/') || location.pathname.startsWith('/certificate-compliance/') || location.pathname.startsWith('/service-report/');
  const isSettingsPage = location.pathname.startsWith('/settings/');

  return (
    <DocSettingsProvider>
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col selection:bg-rose-500 selection:text-white">
        {!isCertificatePage && !isSettingsPage && <OfflineBanner />}
        {!isCertificatePage && !isSettingsPage && impersonatedStaff && (
          <div className="bg-gradient-to-r from-rose-600 via-indigo-600 to-emerald-600 text-white px-3 sm:px-6 py-2.5 shadow-lg flex flex-wrap items-center justify-between gap-3 z-50 sticky top-0 animate-fadeIn border-b border-white/20">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="px-2 py-0.5 rounded-lg bg-white/20 text-white font-extrabold text-[10px] tracking-wider uppercase shrink-0">
                🛡️ Staff Access Mode
              </span>
              <span className="text-xs sm:text-sm font-bold truncate">
                Using interface & account of: <span className="underline decoration-2 font-extrabold">{impersonatedStaff.Name} ({impersonatedStaff.Staff_ID || impersonatedStaff.id})</span>
              </span>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <span className="text-[11px] bg-black/25 px-2.5 py-1 rounded-lg font-semibold hidden md:inline">
                ⚡ Add / remove data synced directly as {impersonatedStaff.Name}
              </span>
              <button
                type="button"
                onClick={() => {
                  stopImpersonating();
                  handleSetCurrentView('admin');
                }}
                className="px-3.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-extrabold text-xs shadow-md transition flex items-center gap-1.5 shrink-0 active:scale-95"
              >
                <span>← Exit & Return to Admin Panel</span>
              </button>
            </div>
          </div>
        )}
        {!isCertificatePage && !isSettingsPage && (
          <Navbar
            currentView={isViewingAdmin ? 'admin' : 'staff'}
            setCurrentView={handleSetCurrentView}
          />
        )}

        <main className={(isCertificatePage || isSettingsPage) ? 'flex-1' : 'flex-1 pb-16'}>
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
              <Route path="/settings/documents" element={<DocSettingsPage />} />
              <Route path="/*" element={isViewingAdmin ? <AdminDashboard /> : <StaffDashboard />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </DocSettingsProvider>
  );
}
