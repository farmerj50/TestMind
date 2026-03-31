import { Link, NavLink } from "react-router-dom";
import { SignedIn, SignedOut, UserButton, SignUpButton } from "@clerk/clerk-react";
import { Moon, Sun } from "lucide-react";
import { useDarkMode } from "../../lib/useDarkMode";

type TopNavMode = "marketing" | "app" | "auth";

function NavA({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        ["px-3 py-2 text-sm transition-colors", isActive ? "tm-nav-link tm-active" : "tm-nav-link"].join(" ")
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
  const { dark, toggle } = useDarkMode();
  return (
    <header className="sticky top-0 z-40 w-full border-b border-[color:var(--tm-border)] bg-[color:var(--tm-shell)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="tracking-tight tm-nav-logo">
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
          <button
            onClick={toggle}
            aria-label="Toggle dark mode"
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-white/10 transition-colors"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          {mode !== "app" && (
            <SignedOut>
              <Link
                to="/signin"
                className="rounded-md border px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:border-slate-600 dark:hover:bg-white/10"
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
            <UserButton />
          </SignedIn>
        </div>
      </div>
    </header>
  );
}
