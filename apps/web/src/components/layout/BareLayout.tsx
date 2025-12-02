import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";

export default function BareLayout() {
  return (
    <div className="min-h-screen bg-[var(--tm-bg)]">
      <TopNav />
      <main className="mx-auto max-w-3xl px-4 pt-6">
        <Outlet />
      </main>
    </div>
  );
}
