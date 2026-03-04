import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";

export default function MarketingLayout() {
  return (
    <div className="min-h-screen bg-[var(--tm-bg)]">
      <TopNav mode="marketing" />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
