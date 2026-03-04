import { Link, NavLink } from "react-router-dom";
import { SignedIn, SignedOut, UserButton, SignUpButton } from "@clerk/clerk-react";

type TopNavMode = "marketing" | "app" | "auth";

function NavA({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "px-3 py-2 text-sm transition-colors",
          isActive ? "text-slate-950" : "text-slate-900 hover:text-slate-950",
        ].join(" ")
      }
      end
    >
      {children}
    </NavLink>
  );
}

function MarketingLinks() {
  return (
    <nav className="hidden md:flex items-center gap-1">
      <Link to="/#features" className="px-3 py-2 text-sm text-slate-900 hover:text-slate-950">
        Features
      </Link>
      <Link to="/pricing" className="px-3 py-2 text-sm text-slate-900 hover:text-slate-950">
        Pricing
      </Link>
      <Link to="/#how" className="px-3 py-2 text-sm text-slate-900 hover:text-slate-950">
        Docs
      </Link>
    </nav>
  );
}

export default function TopNav({ mode = "app" }: { mode?: TopNavMode }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-[color:var(--tm-border)] bg-[color:var(--tm-shell)]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-semibold tracking-tight">
            TestMind AI
          </Link>
          {mode === "marketing" && <MarketingLinks />}
          {mode === "app" && (
            <nav className="hidden md:flex items-center gap-1">
              <NavA to="/dashboard">Dashboard</NavA>
              <NavA to="/suite">Suites</NavA>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3">
          {mode !== "app" && (
            <SignedOut>
              <Link
                to="/signin"
                className="rounded-md border px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Sign in
              </Link>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
                >
                  Get started
                </button>
              </SignUpButton>
            </SignedOut>
          )}

          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </div>
    </header>
  );
}
