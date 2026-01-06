import { Copy, MoreVertical, Pencil, Tags, Trash2, ArrowRightLeft, Lock, Unlock } from "lucide-react";
import ActionMenu, { ActionItem } from "./ActionMenu";

type SpecActionsMenuProps = {
  onAction: (id: string) => void;
  canEdit: boolean;
  canDelete: boolean;
  isLocked: boolean;
  busyLock: boolean;
  busyDelete: boolean;
  onOpenChange?: (open: boolean) => void;
};

export default function SpecActionsMenu({
  onAction,
  canEdit,
  canDelete,
  isLocked,
  busyLock,
  busyDelete,
  onOpenChange,
}: SpecActionsMenuProps) {
  const actions: ActionItem[] = [
    {
      id: "edit_spec",
      label: "Edit spec",
      section: "Edit",
      icon: <Pencil className="h-4 w-4" />,
      disabled: !canEdit,
      tooltip: "Curated suites only",
    },
    {
      id: isLocked ? "unlock_spec" : "lock_spec",
      label: busyLock ? (isLocked ? "Unlocking..." : "Locking...") : isLocked ? "Unlock spec" : "Lock spec",
      section: "Edit",
      icon: isLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />,
      disabled: !canEdit || busyLock,
      tooltip: !canEdit ? "Curated suites only" : undefined,
    },
    {
      id: "copy_spec",
      label: "Copy spec",
      section: "Edit",
      icon: <Copy className="h-4 w-4" />,
      modal: true,
      disabled: false,
    },
    {
      id: "move_spec",
      label: "Move spec",
      section: "Edit",
      icon: <ArrowRightLeft className="h-4 w-4" />,
      modal: true,
      disabled: !canEdit,
      tooltip: "Curated suites only",
    },
    {
      id: "tag_spec",
      label: "Tag spec",
      section: "Edit",
      icon: <Tags className="h-4 w-4" />,
      modal: true,
      disabled: true,
      tooltip: "Coming soon",
    },
    {
      id: "delete_spec",
      label: busyDelete ? "Deleting..." : "Delete spec",
      section: "Edit",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      disabled: !canDelete || busyDelete,
      tooltip: !canDelete ? "Select a suite to delete" : undefined,
    },
  ];

  return (
    <ActionMenu
      triggerContent={<MoreVertical className="h-4 w-4" />}
      triggerAriaLabel="Spec actions"
      actions={actions}
      onAction={onAction}
      onOpenChange={onOpenChange}
    />
  );
}
