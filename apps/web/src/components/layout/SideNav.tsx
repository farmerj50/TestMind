import { NavLink } from "react-router-dom";
import { LayoutDashboard, BadgeDollarSign, Mail, FolderKanban as FolderTree, Bot, Link2, Clapperboard, PencilRuler, BarChart3, ListTree, Wand2, Shield, FolderOpen, BookOpen, Crosshair } from "lucide-react";

function Item({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        [
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
          isActive
            ? "bg-[color:var(--tm-accent-soft)] text-slate-950"
            : "text-slate-900 hover:bg-white/70 hover:text-slate-950",
        ].join(" ")
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      {label}
    </div>
  );
}

export default function SideNav() {
  return (
    // fixed so it floats on top, doesn't constrain page width
    <aside className="fixed left-0 top-14 hidden h-[calc(100vh-56px)] w-56 border-r border-[color:var(--tm-border)] bg-[color:var(--tm-surface-2)] md:block">
      <div className="flex h-full flex-col gap-1 overflow-y-auto p-2">
        <Section label="Build" />
        <Item to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
        <Item to="/suite" icon={FolderTree} label="Suites" />
        <Item to="/projects" icon={FolderOpen} label="Projects" />
        <Item to="/recorder" icon={Clapperboard} label="Recorder" />
        <Item to="/test-builder" icon={PencilRuler} label="Test builder" />
        <Item to="/reports" icon={BarChart3} label="Reports" />

        <Section label="Improve" />
        <Item to="/locators" icon={Crosshair} label="Locator library" />
        <Item to="/qa-agent" icon={Wand2} label="QA agent" />
        <Item to="/documents" icon={BookOpen} label="Documents" />

        <Section label="Explore" />
        <Item to="/agent" icon={Bot} label="Scan pages" />
        <Item to="/agent/sessions" icon={ListTree} label="Agent sessions" />
        <Item to="/security-scan" icon={Shield} label="Security scan" />

        <Section label="Settings" />
        <Item to="/integrations" icon={Link2} label="Integrations" />
        <Item to="/pricing" icon={BadgeDollarSign} label="Pricing" />
        <Item to="/contact" icon={Mail} label="Contact" />
      </div>
    </aside>
  );
}
