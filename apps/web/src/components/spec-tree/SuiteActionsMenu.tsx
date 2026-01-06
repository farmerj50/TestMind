import {
  Copy,
  FilePlus,
  FolderDown,
  FolderPlus,
  FolderUp,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import ActionMenu, { ActionItem } from "./ActionMenu";

type SuiteActionsMenuProps = {
  onAction: (id: string) => void;
  disabled?: boolean;
  busyAction?: string | false;
  onOpenChange?: (open: boolean) => void;
};

export default function SuiteActionsMenu({
  onAction,
  disabled,
  busyAction,
  onOpenChange,
}: SuiteActionsMenuProps) {
  const actions: ActionItem[] = [
    {
      id: "rename_suite",
      label: "Rename suite",
      section: "Edit",
      icon: <Pencil className="h-4 w-4" />,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "delete_suite",
      label: "Delete suite",
      section: "Edit",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "replace_suite_from_generated",
      label: busyAction === "replaceSuite" ? "Replacing..." : "Sync from generated",
      section: "Sync",
      icon: <RefreshCw className="h-4 w-4" />,
      disabled: disabled || !!busyAction,
    },
    {
      id: "overwrite_matches_only",
      label: busyAction === "overwriteMatches" ? "Overwriting..." : "Overwrite matches only",
      section: "Sync",
      icon: <RefreshCw className="h-4 w-4" />,
      disabled: disabled || !!busyAction,
    },
    {
      id: "add_missing_only",
      label: busyAction === "addMissing" ? "Adding..." : "Add missing only",
      section: "Sync",
      icon: <RefreshCw className="h-4 w-4" />,
      disabled: disabled || !!busyAction,
    },
    {
      id: "copy_spec_into_suite",
      label: "Copy spec into suite",
      section: "Content",
      icon: <Copy className="h-4 w-4" />,
      modal: true,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "new_folder",
      label: "New folder",
      section: "Content",
      icon: <FolderPlus className="h-4 w-4" />,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "add_regression_folder",
      label: "Add Regression folder",
      section: "Content",
      icon: <FolderDown className="h-4 w-4" />,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "add_shared_steps_folder",
      label: "Add Shared Steps folder",
      section: "Content",
      icon: <FolderUp className="h-4 w-4" />,
      disabled,
      tooltip: "Curated suites only",
    },
    {
      id: "new_spec",
      label: "New spec",
      section: "Content",
      icon: <FilePlus className="h-4 w-4" />,
      disabled: true,
      tooltip: "Coming soon",
    },
  ];

  return (
    <ActionMenu
      triggerContent={<MoreVertical className="h-4 w-4" />}
      triggerAriaLabel="Suite actions"
      actions={actions}
      onAction={onAction}
      onOpenChange={onOpenChange}
    />
  );
}
