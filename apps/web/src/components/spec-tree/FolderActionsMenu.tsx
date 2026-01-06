import { MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import ActionMenu, { ActionItem } from "./ActionMenu";

type FolderActionsMenuProps = {
  onAction: (id: string) => void;
  disabled?: boolean;
};

export default function FolderActionsMenu({ onAction, disabled }: FolderActionsMenuProps) {
  const actions: ActionItem[] = [
    {
      id: "rename_folder",
      label: "Rename",
      section: "Folder",
      icon: <Pencil className="h-4 w-4" />,
      disabled,
    },
    {
      id: "new_subfolder",
      label: "New folder",
      section: "Folder",
      icon: <Plus className="h-4 w-4" />,
      disabled,
    },
    {
      id: "delete_folder",
      label: "Delete folder...",
      section: "Folder",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      disabled,
    },
  ];

  return (
    <ActionMenu
      triggerContent={<MoreVertical className="h-4 w-4" />}
      triggerAriaLabel="Folder actions"
      actions={actions}
      onAction={onAction}
    />
  );
}
