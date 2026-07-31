import { Outlet } from "react-router-dom";
import TopNav from "./TopNav";
import SEOHead from "../SEOHead";

export default function BareLayout() {
  return (
    <>
      <SEOHead
        title="TestMind AI"
        description="Secure TestMind AI application workspace."
        noIndex
      />
      <div className="min-h-screen bg-[var(--tm-bg)]">
        <TopNav mode="auth" />
        <main className="mx-auto max-w-3xl px-4 pt-6">
          <Outlet />
        </main>
      </div>
    </>
  );
}
