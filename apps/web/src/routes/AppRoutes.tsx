import { Routes, Route } from "react-router-dom";
import LandingPage from "../pages/LandingPage";
import PricingPage from "../pages/PricingPage";
import DashboardPage from "../pages/DashboardPage";
import ContactPage from "../pages/ContactPage";
import ResetPage from "../pages/ResetPage";
import SignInPage from "../pages/SignInPage";
import SignUpPage from "../pages/SignUpPage";
import ProjectPage from "../pages/ProjectPage";
import RunPage from "../pages/RunPage";
import AgentScanPage from "../pages/AgentScanPage";
import AgentPageDetailPage from "../pages/AgentPageDetailPage";
import IntegrationsPage from "../pages/IntegrationsPage";
import RecorderPage from "../pages/RecorderPage";
import TestBuilderPage from "../pages/TestBuilderPage";
import ReportsPage from "../pages/ReportsPage";
import DocumentsPage from "../pages/DocumentsPage";
import AgentSessionsPage from "../pages/AgentSessionsPage";
import AgentSessionDetailPage from "../pages/AgentSessionDetailPage";
import ProtectedRoute from "../components/ProtectedRoute";
import AppLayout from "../components/layout/AppLayout";
import BareLayout from "../components/layout/BareLayout";
import ProjectSuite from "../pages/ProjectSuite";
import QaAgentPage from "../pages/QaAgentPage";
import SecurityScanPage from "../pages/SecurityScanPage";
import ProjectsPage from "../pages/ProjectsPage";
import LocatorLibraryPage from "../pages/LocatorLibraryPage";

function NotFound() {
  return (
    <div className="min-h-[60vh] grid place-items-center text-slate-600">
      404 - Not found
    </div>
  );
}

export default function AppRoutes() {
  return (
    <Routes>
      {/* App pages (top nav + sidebar) */}
      <Route element={<AppLayout />}>
        <Route index element={<LandingPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/contact" element={<ContactPage />} />

        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/agent"
          element={
            <ProtectedRoute>
              <AgentScanPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agent/sessions"
          element={
            <ProtectedRoute>
              <AgentSessionsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agent/sessions/:id"
          element={
            <ProtectedRoute>
              <AgentSessionDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agent/pages/:id"
          element={
            <ProtectedRoute>
              <AgentPageDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/qa-agent"
          element={
            <ProtectedRoute>
              <QaAgentPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/security-scan"
          element={
            <ProtectedRoute>
              <SecurityScanPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/projects"
          element={
            <ProtectedRoute>
              <ProjectsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/projects-ui"
          element={
            <ProtectedRoute>
              <ProjectsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/locators"
          element={
            <ProtectedRoute>
              <LocatorLibraryPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/integrations"
          element={
            <ProtectedRoute>
              <IntegrationsPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/recorder"
          element={
            <ProtectedRoute>
              <RecorderPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/test-builder"
          element={
            <ProtectedRoute>
              <TestBuilderPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <ReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/documents"
          element={
            <ProtectedRoute>
              <DocumentsPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/projects/:id"
          element={
            <ProtectedRoute>
              <ProjectPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/test-runs/:runId"
          element={
            <ProtectedRoute>
              <RunPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route
        path="/suite/:projectId"
        element={
          <ProtectedRoute>
            <ProjectSuite />
          </ProtectedRoute>
        }
      />

      {/* Auth-only pages (no sidebar) */}
      <Route element={<BareLayout />}>
        <Route path="/signin" element={<SignInPage />} />
        {/* Allow Clerk subroutes like /signin/verify-email-address */}
        <Route path="/signin/*" element={<SignInPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        {/* Allow Clerk subroutes like /signup/verify-email-address */}
        <Route path="/signup/*" element={<SignUpPage />} />
        <Route path="/reset" element={<ResetPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
