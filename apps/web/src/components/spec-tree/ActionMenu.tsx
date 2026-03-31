import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export type ActionItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  modal?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  section?: string;
  tooltip?: string;
};

export type ActionMenuProps = {
  triggerLabel?: string;
  triggerContent?: ReactNode;
  triggerAriaLabel?: string;
  actions: ActionItem[];
  onAction: (id: string) => void;
  onOpenChange?: (open: boolean) => void;
  align?: "left" | "right";
};

export default function ActionMenu({
  triggerLabel = "Actions",
  triggerContent,
  triggerAriaLabel,
  actions,
  onAction,
  onOpenChange,
  align = "right",
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const groups = new Map<string, ActionItem[]>();
    actions.forEach((action) => {
      const section = action.section || "";
      if (!groups.has(section)) {
        groups.set(section, []);
        order.push(section);
      }
      groups.get(section)!.push(action);
    });
    return { order, groups };
  }, [actions]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      setOpen(false);
      onOpenChange?.(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      onOpenChange?.(next);
      return next;
    });
  };

  const handleSelect = (action: ActionItem) => {
    if (action.disabled) return;
    onAction(action.id);
    setOpen(false);
    onOpenChange?.(false);
  };

  const menuAlign = align === "right" ? "right-0" : "left-0";

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 px-2"
        aria-label={triggerAriaLabel || triggerLabel}
        onClick={handleToggle}
      >
        {triggerContent || triggerLabel}
      </Button>
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-56 rounded-md border border-slate-200 bg-white shadow-lg",
            menuAlign
          )}
        >
          {grouped.order.map((section, idx) => (
            <div
              key={section || `section-${idx}`}
              className={cn("py-1", idx > 0 && "border-t border-slate-200")}
            >
              {section && (
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {section}
                </div>
              )}
              {grouped.groups.get(section)!.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => handleSelect(action)}
                  disabled={action.disabled}
                  title={action.disabled ? action.tooltip || "Coming soon" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60",
                    action.destructive && "text-rose-600 hover:bg-rose-50"
                  )}
                >
                  {action.icon && (
                    <span className={cn("shrink-0", action.destructive && "text-rose-600")}>
                      {action.icon}
                    </span>
                  )}
                  <span className="flex-1 truncate">{action.label}</span>
                  {action.modal && <ChevronRight className="h-4 w-4 text-slate-400" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
