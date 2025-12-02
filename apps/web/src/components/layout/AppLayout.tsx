import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";
import SideNav from "./SideNav";

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-[var(--tm-bg)]">
      <TopNav />         {/* sticky header */}
      <SideNav />        {/* fixed sidebar on md+ */}
      {/* Give space under the header; add left padding only on md+ so content doesn't sit behind sidebar */}
      <main className="pt-6 md:pl-56">
        <Outlet />
      </main>
    </div>
  );
}
