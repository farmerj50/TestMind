import { NavLink } from "react-router-dom";
import { LayoutDashboard, BadgeDollarSign, Mail, FolderKanban as FolderTree, Bot, Link2, Clapperboard, PencilRuler, BarChart3, ListTree } from "lucide-react";

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
            ? "bg-slate-100 text-slate-900"
            : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
        ].join(" ")
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}

export default function SideNav() {
  return (
    // fixed so it floats on top, doesn't constrain page width
    <aside className="fixed left-0 top-14 hidden h-[calc(100vh-56px)] w-56 border-r bg-white md:block">
      <div className="flex h-full flex-col gap-1 p-2">
        <Item to="/dashboard" icon={LayoutDashboard} label="Dashboard" />
        <Item to="/agent" icon={Bot} label="Scan pages" />
        <Item to="/agent/sessions" icon={ListTree} label="Agent sessions" />
        <Item to="/integrations" icon={Link2} label="Integrations" />
        <Item to="/recorder" icon={Clapperboard} label="Recorder" />
        <Item to="/test-builder" icon={PencilRuler} label="Test builder" />
        <Item to="/reports" icon={BarChart3} label="Reports" />
        <Item to="/suite/playwright-ts" icon={FolderTree} label="Suites" />
        <Item to="/pricing" icon={BadgeDollarSign} label="Pricing" />
        <Item to="/contact" icon={Mail} label="Contact" />
      </div>
    </aside>
  );
}
