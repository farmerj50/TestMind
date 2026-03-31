import { useEffect } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

type FolderDeleteModalProps = {
  open: boolean;
  folderName: string;
  deleteFiles: boolean;
  onDeleteFilesChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function FolderDeleteModal({
  open,
  folderName,
  deleteFiles,
  onDeleteFilesChange,
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
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(value) => onDeleteFilesChange(Boolean(value))}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium text-slate-800">Delete all spec files inside</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {deleteFiles
                  ? "All specs and subfolders will be permanently removed from disk."
                  : "Specs will be moved up to the parent folder (UI reorganize only)."}
              </div>
            </div>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {deleteFiles ? "Delete folder & all specs" : "Remove folder, keep specs"}
          </Button>
        </div>
      </div>
    </div>
  );
}
