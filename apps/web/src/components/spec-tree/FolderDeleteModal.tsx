import { useEffect } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

type FolderDeleteModalProps = {
  open: boolean;
  folderName: string;
  hasSubfolders: boolean;
  deleteSubfolders: boolean;
  onDeleteSubfoldersChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function FolderDeleteModal({
  open,
  folderName,
  hasSubfolders,
  deleteSubfolders,
  onDeleteSubfoldersChange,
  onCancel,
  onConfirm,
}: FolderDeleteModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-semibold text-slate-900">Delete folder "{folderName}"?</div>
        </div>
        <div className="space-y-4 px-4 py-4">
          <p className="text-sm text-slate-600">
            This removes the folder from the Suites sidebar. The test files won't be deleted.
          </p>
          {hasSubfolders && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <Checkbox
                checked={deleteSubfolders}
                onCheckedChange={(value) => onDeleteSubfoldersChange(Boolean(value))}
              />
              Also delete subfolders (still UI-only)
            </label>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            Delete & move suites to parent
          </Button>
        </div>
      </div>
    </div>
  );
}
