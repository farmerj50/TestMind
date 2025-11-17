import { Routes, Route } from "react-router-dom";
import LandingPage from "../pages/LandingPage";
import PricingPage from "../pages/PricingPage";
import DashboardPage from "../pages/DashboardPage";
import ContactPage from "../pages/ContactPage";
import ResetPage from "../pages/ResetPage";
import SignInPage from "../pages/SignInPage";
import SignUpPage from "../pages/SignUpPage";
import ProjectPage from "../pages/ProjectPage";
import RunPage from "../pages/RunPage";            // ⬅️ import this

import ProtectedRoute from "../components/ProtectedRoute";
import AppLayout from "../components/layout/AppLayout";
import BareLayout from "../components/layout/BareLayout";
import ProjectSuite from "../pages/ProjectSuite";

function NotFound() {
  return (
    <div className="min-h-[60vh] grid place-items-center text-slate-600">
      404 – Not found
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
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/reset" element={<ResetPage />} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
