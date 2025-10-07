import { Link, NavLink } from "react-router-dom";
import { SignedIn, SignedOut, UserButton } from "@clerk/clerk-react";

function NavA({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "px-3 py-2 text-sm transition-colors",
          isActive ? "text-slate-900" : "text-slate-600 hover:text-slate-900",
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
    <header className="sticky top-0 z-40 w-full border-b bg-white/80 backdrop-blur">
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
            <Link
              to="/signup"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
            >
              Get started
            </Link>
          </SignedOut>

          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
        </div>
      </div>
    </header>
  );
}
