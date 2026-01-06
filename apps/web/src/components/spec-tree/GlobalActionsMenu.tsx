import { Copy, FolderDown, FolderPlus, FolderUp, PlusSquare, Tags } from "lucide-react";
import ActionMenu, { ActionItem } from "./ActionMenu";

type GlobalActionsMenuProps = {
  onAction: (id: string) => void;
  canCopySpec: boolean;
};

export default function GlobalActionsMenu({ onAction, canCopySpec }: GlobalActionsMenuProps) {
  const actions: ActionItem[] = [
    { id: "new_suite", label: "New suite", section: "Suite", icon: <PlusSquare className="h-4 w-4" /> },
    {
      id: "copy_spec",
      label: "Copy spec",
      section: "Spec",
      icon: <Copy className="h-4 w-4" />,
      modal: true,
      disabled: !canCopySpec,
      tooltip: "Select a spec to copy first",
    },
    { id: "new_folder", label: "New folder", section: "Folders", icon: <FolderPlus className="h-4 w-4" /> },
    {
      id: "add_regression_folder",
      label: "Add Regression folder",
      section: "Folders",
      icon: <FolderDown className="h-4 w-4" />,
    },
    {
      id: "add_shared_steps_folder",
      label: "Add Shared Steps folder",
      section: "Folders",
      icon: <FolderUp className="h-4 w-4" />,
    },
    {
      id: "manage_tags",
      label: "Manage tags",
      section: "Folders",
      icon: <Tags className="h-4 w-4" />,
      disabled: true,
      tooltip: "Coming soon",
    },
  ];

  return <ActionMenu triggerLabel="Add" actions={actions} onAction={onAction} />;
}
