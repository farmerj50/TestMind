import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { LoadingOverlay } from "../ui/LoadingOverlay";
import TopNav from "./TopNav";
import SideNav from "./SideNav";

export default function AppLayout() {
  const location = useLocation();
  const [routeLoading, setRouteLoading] = useState(false);

  useEffect(() => {
    setRouteLoading(true);
    const t = window.setTimeout(() => setRouteLoading(false), 450);
    return () => window.clearTimeout(t);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-[var(--tm-bg)]">
      <TopNav />         {/* sticky header */}
      <SideNav />        {/* fixed sidebar on md+ */}
      {/* Give space under the header; add left padding only on md+ so content doesn't sit behind sidebar */}
      <main className="pt-6 md:pl-56">
        <Outlet />
      </main>
      <LoadingOverlay open={routeLoading} showTimer={false} />
    </div>
  );
}
