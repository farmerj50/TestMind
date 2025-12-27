import { Link, NavLink } from "react-router-dom";
import { SignedIn, SignedOut, UserButton, SignUpButton } from "@clerk/clerk-react";

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

export default function TopNav() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-300 bg-[#8eb7ff]/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-semibold tracking-tight">
            TestMind AI
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            <NavA to="/pricing">Pricing</NavA>
            <NavA to="/contact">Contact</NavA>
            <SignedIn>
              <NavA to="/dashboard">Dashboard</NavA>
              <NavA to="/suite">Suites</NavA>
            </SignedIn>
          </nav>
        </div>

        <div className="flex items-center gap-3">
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

          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </div>
    </header>
  );
}
