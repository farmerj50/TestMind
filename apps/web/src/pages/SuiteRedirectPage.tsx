import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export default function SuiteRedirectPage() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const lastSuiteId =
      typeof window !== "undefined" ? localStorage.getItem("tm:lastSuiteId") : null;
    const targetBase = lastSuiteId ? `/suite/${encodeURIComponent(lastSuiteId)}` : "/suite/playwright-ts";
    const target = `${targetBase}${location.search || ""}`;
    navigate(target, { replace: true });
  }, [navigate, location.search]);

  return null;
}
