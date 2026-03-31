import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { ReactNode, useEffect, useState } from "react";
import { useApi } from "../lib/api";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { pathname, search } = useLocation();
  const { apiFetch } = useApi();
  const [planChecked, setPlanChecked] = useState(false);
  const [hasPlan, setHasPlan] = useState(true);

  useEffect(() => {
    if (!isSignedIn) {
      setPlanChecked(true);
      setHasPlan(true);
      return;
    }

    let active = true;
    setPlanChecked(false);
    apiFetch<{ plan: string | null }>("/billing/me")
      .then((data) => {
        if (!active) return;
        setHasPlan(!!data.plan);
        setPlanChecked(true);
      })
      .catch(() => {
        if (!active) return;
        setHasPlan(true);
        setPlanChecked(true);
      });
    return () => {
      active = false;
    };
  }, [isSignedIn, apiFetch]);

  if (!isLoaded) return null;
  if (!isSignedIn) {
    const redirect = encodeURIComponent(pathname + search);
    return <Navigate to={`/signin?redirect=${redirect}`} replace />;
  }
  if (!planChecked) return null;
  if (!hasPlan) {
    return <Navigate to="/pricing?select=1" replace />;
  }
  return <>{children}</>;
}
