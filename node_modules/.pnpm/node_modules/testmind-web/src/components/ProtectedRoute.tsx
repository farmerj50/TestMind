import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { ReactNode } from "react";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  const { pathname, search } = useLocation();

  if (!isSignedIn) {
    const redirect = encodeURIComponent(pathname + search);
    return <Navigate to={`/signin?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}
